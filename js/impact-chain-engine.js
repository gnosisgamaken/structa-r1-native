/**
 * impact-chain-engine.js — Structa Autonomous Impact Chain
 *
 * Structa quietly reviews the project in the background.
 * Each "impact" is a self-contained LLM call that:
 * 1. Reads current project context
 * 2. Decides: clarify further, or create a decision for the user
 * 3. Stores the result tagged for the next chain step
 * 4. Updates the NOW card with the latest impact
 *
 * Phases: observe → clarify → clarify → decision
 * After decision: 60s cooldown, then restart
 * Auto-pauses after 5 min of no user interaction
 * Resumes on any hardware event
 */
(function() {
  'use strict';

  var native = window.StructaNative;
  var llm = window.StructaLLM;
  var panel = window.StructaPanel;

  // === Chain state ===
  var chain = {
    active: false,
    bpm: 2,                    // beats per minute (2 = every 30s)
    beatCount: 0,
    impacts: [],
    currentPhase: 'idle',       // idle | blocked | observe | clarify | evaluate | decision | cooldown
    lastDecisionAt: 0,
    lastUserActivity: Date.now(),
    maxImpactsPerChain: 3,      // observe + clarify × N before decision
    cooldownMs: 30000,          // 30s cooldown after decision
    idleTimeoutMs: 300000,      // 5 min auto-pause
    timerId: null,
    chainId: 0,
    totalImpacts: 0,
    totalDecisions: 0,
    awaitingFastTrack: false,
    manuallyStopped: false
  };
  var cooldownTickTimer = null;
  var PAUSE_KEY = 'structa.chain.paused';

  function emitPhase() {
    window.dispatchEvent(new CustomEvent('structa-impact-phase', {
      detail: {
        phase: chain.currentPhase,
        cooldownMs: chain.currentPhase === 'cooldown'
          ? Math.max(0, chain.cooldownMs - (Date.now() - chain.lastDecisionAt))
          : 0,
        paused: !!chain.manuallyStopped
      }
    }));
  }

  function setPhase(phase) {
    chain.currentPhase = phase;
    emitPhase();
  }

  function persistPauseState(paused) {
    try {
      if (!window.creationStorage?.plain) return;
      if (paused) window.creationStorage.plain.setItem(PAUSE_KEY, '1');
      else window.creationStorage.plain.removeItem(PAUSE_KEY);
    } catch (_) {}
  }

  function startCooldownTicker() {
    stopCooldownTicker();
    cooldownTickTimer = setInterval(function() {
      if (chain.currentPhase !== 'cooldown') {
        stopCooldownTicker();
        return;
      }
      emitPhase();
    }, 1000);
  }

  function stopCooldownTicker() {
    if (cooldownTickTimer) {
      clearInterval(cooldownTickTimer);
      cooldownTickTimer = null;
    }
  }

  // === Impact ID ===
  function makeImpactId(type) {
    chain.chainId++;
    var d = new Date();
    var ts = d.getFullYear() + '' +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '-' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0');
    return ts + '-' + type.slice(0, 3) + '-' + String(chain.chainId).padStart(3, '0');
  }

  // === Tag extraction ===
  var STOP_WORDS = new Set([
    'the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could',
    'should','may','might','can','this','that','these','those',
    'it','its','we','you','they','our','your','their','i','me',
    'my','he','she','him','her','his','of','in','to','for','with',
    'on','at','by','from','or','and','but','not','no','so','if',
    'than','too','very','just','about','up','out','into','over',
    'after','before','between','under','again','then','once',
    'here','there','when','where','why','how','all','each',
    'what','which','who','whom','more','most','other','some',
    'such','only','same','also','still','even','need','needs'
  ]);

  function extractTags(text) {
    if (!text) return [];
    var words = String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/);
    var counts = {};
    words.forEach(function(w) {
      if (w.length > 2 && !STOP_WORDS.has(w)) {
        counts[w] = (counts[w] || 0) + 1;
      }
    });
    return Object.keys(counts)
      .sort(function(a, b) { return counts[b] - counts[a]; })
      .slice(0, 3);
  }

  // === Context builder for impact prompts ===
  function buildImpactContext() {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var memory = native && native.getMemory ? native.getMemory() : {};
    var captures = memory.captures || [];
    var insights = project.insights || [];
    var openQuestions = project.open_questions || [];
    var pending = project.pending_decisions || [];
    var backlog = project.backlog || [];

    var parts = [];
    parts.push('Project: ' + (project.name || 'untitled'));
    parts.push('Captures: ' + captures.length + ' | Insights: ' + insights.length + ' | Asks: ' + openQuestions.length);
    if (backlog.length) {
      parts.push('Backlog: ' + backlog.slice(0, 3).map(function(b) { return b.title; }).join(', '));
    }
    if (openQuestions.length) {
      parts.push('Open: ' + openQuestions.slice(0, 2).map(function(q) {
        return String(q).slice(0, 40);
      }).join('; '));
    }
    if (pending.length) {
      var pd = typeof pending[0] === 'string' ? pending[0] : (pending[0].text || '');
      parts.push('Pending decision: ' + pd.slice(0, 50));
    }
    if (pending.length || openQuestions.length) {
      parts.push('Blockers: ' + (pending.length + openQuestions.length));
    }

    // Last impact summary
    var lastImpact = chain.impacts[chain.impacts.length - 1];
    if (lastImpact) {
      parts.push('Last impact: ' + String(lastImpact.output).slice(0, 60));
    }

    return parts.join('\n');
  }

  function buildChainProjectEnvelope() {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    return {
      id: project.project_id || project.id || '',
      name: project.name || 'untitled project',
      type: project.type || 'general',
      brief: project.brief || '',
      topQuestions: (project.open_questions || []).slice(0, 3),
      selectedSurface: 'now',
      summary: buildImpactContext()
    };
  }

  function buildChainPayload(phase, extra) {
    return {
      project: buildChainProjectEnvelope(),
      selection: null,
      input: {},
      policy: {
        priority: 'low',
        allowSearch: false,
        allowSpeech: false
      },
      phase: phase,
      discoveryMode: !!(extra && extra.discoveryMode),
      contextSummary: buildImpactContext(),
      recentArtifacts: chain.impacts.slice(-4).map(function(impact) {
        return {
          type: impact.type,
          body: impact.output,
          output: impact.output,
          createdAt: impact.created_at
        };
      }),
      blockers: getBlockers()
    };
  }

  // === Store impact ===
  function storeImpact(type, verb, input, output) {
    var impact = {
      impact_id: makeImpactId(type),
      chain_index: chain.impacts.length + 1,
      parent_id: chain.impacts.length ? chain.impacts[chain.impacts.length - 1].impact_id : null,
      type: type,
      verb: verb,
      input: String(input).slice(0, 200),
      output: String(output).slice(0, 200),
      tags: extractTags(output),
      created_at: new Date().toISOString()
    };

    chain.impacts.push(impact);
    chain.totalImpacts++;

    // Persist to project memory
    if (native && native.touchProjectMemory) {
      native.touchProjectMemory(function(project) {
        project.impact_chain = Array.isArray(project.impact_chain) ? project.impact_chain : [];
        project.impact_chain.unshift(impact);
        // Keep last 24 impacts
        project.impact_chain = project.impact_chain.slice(0, 24);
      });
    }

    // Keep chain activity mostly silent; only major outcomes surface elsewhere.

    // Dispatch event for cascade to re-render
    window.dispatchEvent(new CustomEvent('structa-impact', { detail: impact }));

    return impact;
  }

  // === Store decision ===
  function storeDecision(decisionText, options) {
    if (!native || !native.touchProjectMemory) return;

    native.touchProjectMemory(function(project) {
      project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
      var exists = project.pending_decisions.some(function(d) {
        return (d.text || d) === decisionText;
      });
      if (!exists) {
        project.pending_decisions.unshift({
          text: decisionText,
          options: options || [],
          source: 'impact-chain',
          created_at: new Date().toISOString()
        });
        project.pending_decisions = project.pending_decisions.slice(0, 8);
        chain.totalDecisions++;
      }
    });

    chain.lastDecisionAt = Date.now();
    setPhase('cooldown');
    startCooldownTicker();

    if (panel && panel.pushLog) {
      panel.pushLog('decision ready', 'decision');
    }
    llm?.speakMilestone?.('decision_created');

    // Notify cascade to show decision on NOW card
    window.dispatchEvent(new CustomEvent('structa-decision-created', {
      detail: { text: decisionText, options: options }
    }));

    // No automatic spoken announcement here — keep heartbeat and chain calm.
  }

  // === Parse JSON from LLM ===
  function tryParseDecision(text) {
    if (!text) return null;
    // Try direct JSON parse
    try {
      var obj = JSON.parse(text);
      if (obj.decision && Array.isArray(obj.options) && obj.options.length >= 2) {
        return { decision: obj.decision, options: obj.options.slice(0, 3) };
      }
    } catch (e) {}

    // Try extracting JSON from surrounding text
    var jsonMatch = text.match(/\{[\s\S]*"decision"[\s\S]*"options"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        var obj2 = JSON.parse(jsonMatch[0]);
        if (obj2.decision && Array.isArray(obj2.options)) {
          return { decision: obj2.decision, options: obj2.options.slice(0, 3) };
        }
      } catch (e2) {}
    }
    return null;
  }

  // === Discovery mode ===
  // When project has <5 nodes, ask concrete questions to shape the project
  function isDiscoveryMode() {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var nodeCount = (project.nodes || []).length;
    // Also check legacy arrays for compat
    var legacyCount = (project.insights || []).length + (project.captures || []).length +
      (project.decisions || []).length + (project.backlog || []).length;
    return Math.max(nodeCount, legacyCount) < 5;
  }

  function runChainStep(payload) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.runChainStep || !llm || !llm.executePreparedLLM) {
      return Promise.resolve({ ok: false, error: 'orchestrator unavailable' });
    }
    return orchestrator.runChainStep(payload, llm.executePreparedLLM);
  }

  function getBlockers() {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var pending = project.pending_decisions || [];
    var openQuestions = project.open_questions || [];
    return {
      pendingCount: pending.length,
      questionCount: openQuestions.length,
      total: pending.length + openQuestions.length,
      topDecision: pending.length ? (typeof pending[0] === 'string' ? pending[0] : (pending[0].text || 'decision waiting')) : '',
      topQuestion: openQuestions.length ? String(openQuestions[0] || '') : ''
    };
  }

  function onboardingBlocked() {
    var ui = native && native.getUIState ? native.getUIState() : {};
    if (ui && ui.onboarded) return false;
    if (ui && ui.onboarding_step === 'complete') return false;
    if (ui && typeof ui.onboarding_step === 'number') return true;
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var isUntitled = String(project?.name || '').toLowerCase() === 'untitled project';
    var nodeCount = (project.nodes || []).length;
    var legacyCount = (project.insights || []).length + (project.captures || []).length +
      (project.decisions || []).length + (project.backlog || []).length +
      (project.open_questions || []).length + (project.pending_decisions || []).length;
    return isUntitled && nodeCount + legacyCount === 0;
  }

  // === Beat logic ===
  function beat() {
    if (!chain.active) return;
    if (onboardingBlocked()) {
      pause('onboarding');
      return;
    }

    // Check idle timeout
    var idleMs = Date.now() - chain.lastUserActivity;
    if (idleMs > chain.idleTimeoutMs) {
      pause('idle timeout');
      return;
    }

    // Play audio heartbeat
    if (window.StructaAudio && window.StructaAudio.initialized && !window.StructaAudio.muted) {
      window.StructaAudio.heartbeat(chain.currentPhase);
    }

    // Dispatch visual heartbeat event for cascade
    window.dispatchEvent(new CustomEvent('structa-heartbeat', {
      detail: { phase: chain.currentPhase, beat: chain.beatCount }
    }));

    // Check cooldown
    if (chain.currentPhase === 'cooldown') {
      var cooldownMs = Date.now() - chain.lastDecisionAt;
      if (cooldownMs < chain.cooldownMs) {
        return; // still cooling
      }
      // Cooldown over — restart chain
      stopCooldownTicker();
      setPhase('observe');
      chain.impacts = [];
      chain.beatCount = 0;
    }

    var context = buildImpactContext();

    if (!llm || !llm.sendToLLM) {
      pause('no LLM bridge');
      return;
    }

    chain.beatCount++;

    var blockers = getBlockers();
    if (blockers.total > 0 && chain.currentPhase !== 'cooldown') {
      setPhase('blocked');
      window.dispatchEvent(new CustomEvent('structa-blocked', { detail: blockers }));
      return;
    }

    // === Discovery mode: ask shaping questions when project is new ===
    if (isDiscoveryMode() && chain.currentPhase === 'observe') {
      runChainStep(buildChainPayload('observe', { discoveryMode: true }))
        .then(function(result) {
          if (!chain.active) return;
          if (result && result.ok && result.artifacts && result.artifacts.length) {
            var questionText = result.artifacts[0].body || result.ui?.summary || '';
            storeImpact('observe', 'inspect', context, 'discovery: ' + questionText);

            // Store as open question
            if (native && native.addNode) {
              native.addNode({
                type: 'question', status: 'open',
                title: 'structa asks', body: questionText,
                source: 'impact-chain'
              });
            } else if (native && native.touchProjectMemory) {
              native.touchProjectMemory(function(project) {
                project.open_questions = Array.isArray(project.open_questions) ? project.open_questions : [];
                if (!project.open_questions.includes(questionText)) {
                  project.open_questions.unshift(questionText);
                  project.open_questions = project.open_questions.slice(0, 12);
                }
              });
            }

            setPhase('cooldown');
            chain.lastDecisionAt = Date.now();
            chain.cooldownMs = 35000;
            startCooldownTicker();

            // Notify
            window.dispatchEvent(new CustomEvent('structa-discovery-question', {
              detail: { question: questionText }
            }));

            if (panel && panel.render) panel.render();
          }
        });
      return; // Skip normal flow
    }

    switch (chain.currentPhase) {
      case 'idle':
      case 'blocked':
      case 'observe':
        setPhase('observe');
        runChainStep(buildChainPayload('observe'))
          .then(function(result) {
            if (!chain.active) return;
            if (result && result.ok && result.ui && result.ui.summary) {
              var impact = storeImpact('observe', 'inspect', context, result.ui.summary);
              setPhase('clarify');
              panel && panel.render && panel.render();
            }
          });
        break;

      case 'clarify':
        var lastObserve = chain.impacts.filter(function(i) { return i.type === 'observe'; });
        var observation = lastObserve.length ? lastObserve[0].output : 'project status';

        // Decide: continue clarifying or evaluate?
        if (chain.impacts.length >= chain.maxImpactsPerChain) {
          setPhase('evaluate');
          // Fall through to evaluate
        } else {
          runChainStep(buildChainPayload('clarify'))
            .then(function(result) {
              if (!chain.active) return;
              if (result && result.ok && result.ui && result.ui.summary) {
                storeImpact('clarify', 'clarify', observation, result.ui.summary);

                // After enough clarification, move to evaluate
                if (chain.impacts.length >= chain.maxImpactsPerChain) {
                  setPhase('evaluate');
                }
                panel && panel.render && panel.render();
              }
            });
          break;
        }
        // Intentional fall-through to evaluate when max impacts reached

      case 'evaluate':
        if (!chain.impacts.some(function(impact) { return impact.type === 'clarify'; })) {
          setPhase('clarify');
          break;
        }
        runChainStep(buildChainPayload('evaluate'))
          .then(function(result) {
            if (!chain.active) return;
            if (result && result.ok) {
              var mainArtifact = result.artifacts && result.artifacts[0] ? result.artifacts[0] : null;

              if (mainArtifact && mainArtifact.type === 'decision') {
                storeImpact('decision', 'decide', chain.impacts.map(function(i) { return i.output; }).join('; '), mainArtifact.body || mainArtifact.title || 'decision ready');
                storeDecision(mainArtifact.body || mainArtifact.title || 'decision ready', mainArtifact.options || []);
                panel && panel.render && panel.render();
              } else if (result.ui && result.ui.summary) {
                // LLM wants more clarification
                storeImpact('evaluate', 'evaluate', chain.impacts.length + ' impacts', result.ui.summary);

                // If we've been going too long, force a decision anyway
                if (chain.impacts.length >= chain.maxImpactsPerChain + 2) {
                  var fallback = result.ui.summary.slice(0, 60);
                  storeDecision(fallback, ['approve', 'skip', 'revise']);
                }

                setPhase('clarify');
                panel && panel.render && panel.render();
              }
            }
          });
        break;

      default:
        break;
    }
  }

  // === Start / Stop ===
  function start(bpm) {
    if (onboardingBlocked()) return;
    if (chain.active) return;
    chain.manuallyStopped = false;
    persistPauseState(false);
    chain.active = true;
    chain.bpm = bpm || 4;
    setPhase('observe');
    chain.impacts = [];
    chain.beatCount = 0;

    var intervalMs = Math.max(5000, Math.round(60000 / chain.bpm));
    chain.timerId = setInterval(beat, intervalMs);

    // Fire first beat immediately
    beat();
  }

  function pause(reason) {
    if (!chain.active) return;
    chain.active = false;
    stopCooldownTicker();
    if (reason === 'manual stop') {
      chain.manuallyStopped = true;
      persistPauseState(true);
      setPhase('paused');
    } else {
      setPhase('idle');
    }
    if (chain.timerId) {
      clearInterval(chain.timerId);
      chain.timerId = null;
    }
  }

  function stop() {
    chain.manuallyStopped = true;
    persistPauseState(true);
    pause('manual stop');
    chain.impacts = [];
    chain.awaitingFastTrack = false;
    setPhase('idle');
  }

  function resume() {
    chain.lastUserActivity = Date.now();
    if (onboardingBlocked()) return;
    if (chain.manuallyStopped) return;
    if (!chain.active && chain.currentPhase !== 'cooldown') {
      start(chain.bpm);
    } else if (!chain.active) {
      // In cooldown — just mark active, beat will check cooldown timer
      chain.active = true;
      var intervalMs = Math.max(5000, Math.round(60000 / chain.bpm));
      chain.timerId = setInterval(beat, intervalMs);
    }
  }

  function resumeManual() {
    chain.manuallyStopped = false;
    persistPauseState(false);
    resume();
  }

  function kill() {
    stop();
  }

  function isPaused() {
    return !!chain.manuallyStopped;
  }

  function touchActivity() {
    chain.lastUserActivity = Date.now();
  }

  var immediateBeatTimer = null;
  function requestImmediateBeat() {
    if (onboardingBlocked()) return;
    if (!chain.active) return;
    chain.awaitingFastTrack = true;
    clearTimeout(immediateBeatTimer);
    immediateBeatTimer = setTimeout(function() {
      immediateBeatTimer = null;
      if (window.StructaLLM && window.StructaLLM.pendingHighPriorityCount > 0) {
        requestImmediateBeat();
        return;
      }
      chain.awaitingFastTrack = false;
      beat();
    }, 120);
  }

  // === Public API ===
  window.StructaImpactChain = Object.freeze({
    start: start,
    pause: pause,
    stop: stop,
    kill: kill,
    resume: resume,
    resumeManual: resumeManual,
    isPaused: isPaused,
    touchActivity: touchActivity,
    requestImmediateBeat: requestImmediateBeat,
    get active() { return chain.active; },
    get phase() { return chain.currentPhase; },
    get bpm() { return chain.bpm; },
    set bpm(val) { chain.bpm = Math.max(1, Math.min(20, val || 4)); },
    get impacts() { return chain.impacts.slice(); },
    get beatCount() { return chain.beatCount; },
    get totalImpacts() { return chain.totalImpacts; },
    get totalDecisions() { return chain.totalDecisions; },
    get lastImpact() { return chain.impacts[chain.impacts.length - 1] || null; },
    get manuallyStopped() { return !!chain.manuallyStopped; },
    get cooldownRemaining() {
      if (chain.currentPhase !== 'cooldown') return 0;
      return Math.max(0, chain.cooldownMs - (Date.now() - chain.lastDecisionAt));
    }
  });

  (function restorePauseState() {
    try {
      if (!window.creationStorage?.plain?.getItem) {
        emitPhase();
        return;
      }
      Promise.resolve(window.creationStorage.plain.getItem(PAUSE_KEY)).then(function(value) {
        if (value) {
          chain.manuallyStopped = true;
          setPhase('paused');
        } else {
          emitPhase();
        }
      }).catch(function() {
        emitPhase();
      });
    } catch (_) {
      emitPhase();
    }
  })();

  // === Auto-start on user activity ===
  // Wire to hardware events so chain resumes on device wake
  ['sideClick', 'scrollUp', 'scrollDown', 'longPressStart'].forEach(function(evt) {
    window.addEventListener(evt, function() {
      if (onboardingBlocked()) return;
      touchActivity();
      if (!chain.active) resume();
    });
  });

  // Also resume on visibility change (device wake)
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      if (onboardingBlocked()) return;
      touchActivity();
      if (!chain.active) resume();
    }
  });

  window.addEventListener('structa-fast-feedback', function() {
    if (onboardingBlocked()) return;
    touchActivity();
    if (!chain.active) resume();
    requestImmediateBeat();
  });

})();
