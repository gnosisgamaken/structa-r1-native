/**
 * impact-chain-engine.js — Focus-grounded reasoning engine
 *
 * T2 turns the chain into a single-focus reasoner:
 * - one active focus at a time
 * - typed digest input only
 * - evidence-cited output only
 * - explicit termination and idle states
 */
(function() {
  'use strict';

  var native = window.StructaNative;
  var llm = window.StructaLLM;
  var queue = window.StructaProcessingQueue;
  var orchestrator = window.StructaOrchestrator;
  var contracts = window.StructaContracts;

  var chain = {
    active: false,
    bpm: 2,
    beatCount: 0,
    impacts: [],
    currentPhase: 'idle',
    timerId: null,
    lastUserActivity: Date.now(),
    idleTimeoutMs: 300000,
    manuallyStopped: false,
    stepInFlight: false,
    totalImpacts: 0,
    totalDecisions: 0,
    lastIdleSignature: ''
  };

  var PAUSE_KEY = 'structa.chain.paused';

  function lower(value) {
    return String(value || '').trim().toLowerCase();
  }

  function compact(text, limit) {
    var value = String(text || '').trim().replace(/\s+/g, ' ');
    var max = Number(limit || 72);
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  function currentProject() {
    return native?.getProjectMemory?.() || {};
  }

  function currentFocus() {
    return native?.getActiveFocus?.() || null;
  }

  function queueHasHigherPriorityWork() {
    if (!queue?.countByPriority) return false;
    return ['P0', 'P1', 'P2'].some(function(priority) {
      return Number(queue.countByPriority(priority) || 0) > 0;
    });
  }

  function getBlockers() {
    var project = currentProject();
    var pending = project.pending_decisions || [];
    var openQuestions = project.open_question_nodes || [];
    return {
      pendingCount: pending.length,
      questionCount: openQuestions.length,
      total: pending.length + openQuestions.length,
      topDecision: pending.length ? (typeof pending[0] === 'string' ? pending[0] : (pending[0].text || 'decision waiting')) : '',
      topQuestion: openQuestions.length ? String(openQuestions[0]?.body || openQuestions[0]?.title || '') : ''
    };
  }

  function emitPhase() {
    window.dispatchEvent(new CustomEvent('structa-impact-phase', {
      detail: {
        phase: chain.currentPhase,
        cooldownMs: 0,
        paused: !!chain.manuallyStopped
      }
    }));
  }

  function setPhase(phase) {
    chain.currentPhase = phase;
    emitPhase();
  }

  function syncPhaseWithFocus() {
    var focus = currentFocus();
    if (chain.manuallyStopped) {
      setPhase('paused');
      window.dispatchEvent(new CustomEvent('structa-chain-updated', {
        detail: { phase: 'paused', focusId: '' }
      }));
      return;
    }
    setPhase(focus ? (focus.phase || 'observe') : 'idle');
    window.dispatchEvent(new CustomEvent('structa-chain-updated', {
      detail: {
        phase: focus ? (focus.phase || 'observe') : 'idle',
        focusId: focus?.id || ''
      }
    }));
  }

  function persistPauseState(paused) {
    try {
      if (!window.creationStorage?.plain) return;
      if (paused) window.creationStorage.plain.setItem(PAUSE_KEY, '1');
      else window.creationStorage.plain.removeItem(PAUSE_KEY);
    } catch (_) {}
  }

  function clearTimer() {
    if (!chain.timerId) return;
    clearTimeout(chain.timerId);
    chain.timerId = null;
  }

  function scheduleNextBeat(delayMs) {
    clearTimer();
    if (chain.manuallyStopped) return;
    var wait = Math.max(120, Number(delayMs || 0));
    chain.timerId = setTimeout(function() {
      chain.timerId = null;
      beat();
    }, wait);
  }

  function onboardingBlocked() {
    var ui = native?.getUIState?.() || {};
    if (ui && ui.onboarded) return false;
    if (ui && ui.onboarding_step === 'complete') return false;
    if (ui && typeof ui.onboarding_step === 'number') return true;
    var project = currentProject();
    var isUntitled = String(project?.name || '').toLowerCase() === 'untitled project';
    var nodeCount = (project.nodes || []).length;
    var legacyCount = (project.insights || []).length + (project.captures || []).length +
      (project.decisions || []).length + (project.backlog || []).length +
      (project.open_questions || []).length + (project.pending_decisions || []).length;
    return isUntitled && nodeCount + legacyCount === 0;
  }

  function buildPreviousSteps(focus) {
    return Array.isArray(focus?.steps)
      ? focus.steps.slice(-4).map(function(step) {
          return {
            at: step.at || '',
            phase: lower(step.phase || focus.phase || 'observe'),
            jobId: step.jobId || '',
            producedClaimIds: Array.isArray(step.producedClaimIds) ? step.producedClaimIds.slice(0, 6) : [],
            producedQuestionIds: Array.isArray(step.producedQuestionIds) ? step.producedQuestionIds.slice(0, 6) : [],
            outcome: lower(step.outcome || '')
          };
        })
      : [];
  }

  function buildChainPayload(focus) {
    var project = currentProject();
    return {
      project: project,
      focus: {
        kind: focus?.target?.kind || 'branch',
        id: focus?.target?.id || 'main',
        branchId: focus?.target?.branchId || 'main',
        phase: focus?.phase || 'observe'
      },
      history: {
        previous_steps: buildPreviousSteps(focus),
        plateau_count: Number(focus?.plateauCount || 0)
      },
      policy: {
        priority: 'low',
        allowSearch: false,
        allowSpeech: false
      }
    };
  }

  function runChainStepNow(payload) {
    if (!orchestrator?.runChainStep || !llm?.executePreparedLLM) {
      return Promise.resolve({ ok: false, error: 'orchestrator unavailable' });
    }
    return orchestrator.runChainStep(payload, llm.executePreparedLLM);
  }

  if (queue && !window.__STRUCTA_CHAIN_QUEUE_REGISTERED__) {
    window.__STRUCTA_CHAIN_QUEUE_REGISTERED__ = true;
    queue.registerHandler('chain-step', function(job) {
      return runChainStepNow(job.payload || {});
    });
  }

  function runChainStep(payload) {
    if (!queue) return runChainStepNow(payload);
    return new Promise(function(resolve, reject) {
      queue.enqueue({
        kind: 'chain-step',
        priority: 'P3',
        payload: payload,
        origin: {
          screen: 'chain',
          itemId: payload?.focus?.id || payload?.focus?.branchId || 'main'
        },
        timeoutMs: 30000,
        onResolve: resolve,
        onReject: reject
      });
    });
  }

  function writeFocusStep(focusId, patch) {
    var updated = null;
    native?.touchProjectMemory?.(function(project) {
      var focus = (project.focuses || []).find(function(entry) { return entry.id === focusId; });
      if (!focus) return;
      focus.steps = Array.isArray(focus.steps) ? focus.steps : [];
      focus.steps.push({
        at: new Date().toISOString(),
        phase: lower(patch.phase || focus.phase || 'observe'),
        jobId: patch.jobId || '',
        producedClaimIds: Array.isArray(patch.producedClaimIds) ? patch.producedClaimIds.slice() : [],
        producedQuestionIds: Array.isArray(patch.producedQuestionIds) ? patch.producedQuestionIds.slice() : [],
        outcome: lower(patch.outcome || '')
      });
      focus.steps = focus.steps.slice(-16);
      focus.lastStepAt = new Date().toISOString();
      if (patch.phaseNext) focus.phase = patch.phaseNext;
      if (typeof patch.plateauCount === 'number') focus.plateauCount = patch.plateauCount;
      if (typeof patch.rejectCount === 'number') focus.rejectCount = patch.rejectCount;
      updated = JSON.parse(JSON.stringify(focus));
    });
    return updated;
  }

  function extendClaimEvidence(project, normalizedText, kind, branchId, evidenceIds) {
    var claims = Array.isArray(project?.claims) ? project.claims : [];
    var existing = claims.find(function(entry) {
      return lower(entry?.text || '') === lower(normalizedText || '')
        && lower(entry?.kind || 'fact') === lower(kind || 'fact')
        && String(entry?.branchId || 'main') === String(branchId || 'main');
    }) || null;
    if (!existing) return null;
    existing.evidence = Array.isArray(existing.evidence) ? existing.evidence : [];
    var appended = (evidenceIds || []).filter(function(ref) { return existing.evidence.indexOf(ref) === -1; });
    if (appended.length) {
      existing.evidence = existing.evidence.concat(appended);
      native?.traceEvent?.('claim.evidence.extended', 'existing', existing.id, {
        claimId: existing.id,
        newEvidenceIds: appended
      });
    }
    return existing;
  }

  function findDuplicateQuestion(project, question) {
    var expected = lower(question.body || '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!expected) return null;
    return (project.nodes || []).find(function(node) {
      if (node?.type !== 'question' || node.status !== 'open') return false;
      var current = lower(node.body || node.title || '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (current === expected) return true;
      var semanticHash = lower(question.meta?.semantic_hash || '');
      return !!semanticHash && semanticHash === lower(node.meta?.semantic_hash || '');
    }) || null;
  }

  function mergeQuestionNode(question) {
    var merged = null;
    var created = null;
    var questionId = '';
    var project = currentProject();
    var existing = findDuplicateQuestion(project, question);
    if (existing) {
      native?.touchProjectMemory?.(function(nextProject) {
        var node = (nextProject.nodes || []).find(function(entry) { return entry.node_id === existing.node_id; });
        if (!node) return;
        node.meta = { ...(node.meta || {}) };
        node.meta.rationales = Array.isArray(node.meta.rationales) ? node.meta.rationales : [];
        var rationale = question.meta?.rationale || '';
        if (rationale && node.meta.rationales.indexOf(rationale) === -1) {
          node.meta.rationales.push(rationale);
        }
        var refs = Array.isArray(node.meta.evidence_claims) ? node.meta.evidence_claims : [];
        (question.meta?.evidence_claims || []).forEach(function(ref) {
          if (refs.indexOf(ref) === -1) refs.push(ref);
        });
        node.meta.evidence_claims = refs;
        merged = JSON.parse(JSON.stringify(node));
        questionId = node.node_id;
      });
    } else {
      created = native?.addNode?.({
        type: 'question',
        status: 'open',
        title: 'guided ask',
        body: question.body,
        source: 'chain',
        meta: {
          evidence_claims: question.meta?.evidence_claims || [],
          rationale: question.meta?.rationale || '',
          rationales: question.meta?.rationale ? [question.meta.rationale] : [],
          priority: question.meta?.priority || 'normal',
          branch_id: question.meta?.branch_id || 'main',
          reasoning_generated: true,
          semantic_hash: lower(question.body || '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
        }
      });
      questionId = created?.node_id || '';
    }
    if (merged) {
      native?.traceEvent?.('question.dedup.merged', 'incoming', merged.node_id, {
        intoId: merged.node_id,
        rationale: question.meta?.rationale || ''
      });
    }
    return questionId;
  }

  function createDecisionNode(item) {
    var node = native?.addNode?.({
      type: 'decision',
      status: 'open',
      title: item.body,
      body: item.body,
      source: 'chain',
      decision_options: item.options || [],
      meta: {
        evidence_claims: item.evidence || [],
        rationale: item.rationale || '',
        recommended: item.recommended || '',
        reasoning_generated: true
      }
    });
    if (node) chain.totalDecisions += 1;
    return node?.node_id || '';
  }

  function createTaskNode(item) {
    var node = native?.addNode?.({
      type: 'task',
      status: 'open',
      title: item.body,
      body: item.body,
      source: 'chain',
      meta: {
        evidence_claims: item.evidence || [],
        reasoning_generated: true
      }
    });
    return node?.node_id || '';
  }

  function maybeResurrectQuestions(storedClaims) {
    if (!Array.isArray(storedClaims) || !storedClaims.length) return;
    native?.touchProjectMemory?.(function(project) {
      (project.nodes || []).forEach(function(node) {
        if (node?.type !== 'question' || node.status !== 'open' || !node.meta?.skipped_until) return;
        var skippedUntil = new Date(node.meta.skipped_until).getTime();
        if (!Number.isFinite(skippedUntil) || skippedUntil <= Date.now()) return;
        var questionText = lower(node.body || node.title || '');
        var resurrected = storedClaims.find(function(claim) {
          if (Number(claim.confidence || 0) <= 0.7) return false;
          var claimText = lower(claim.text || '');
          return claimText && questionText && (claimText.indexOf(questionText.slice(0, 18)) !== -1 || questionText.indexOf(claimText.slice(0, 18)) !== -1);
        });
        if (!resurrected) return;
        delete node.meta.skipped_until;
        native?.traceEvent?.('question.resurrect', 'cooldown', node.node_id, {
          questionId: node.node_id,
          reason: resurrected.id || resurrected.text || ''
        });
      });
    });
  }

  function applyProduced(validated, focus) {
    var produced = validated?.produced || {};
    var branchId = focus?.target?.branchId || 'main';
    var storedClaims = [];
    if (Array.isArray(produced.claims) && produced.claims.length) {
      var claimsPayload = produced.claims.map(function(item) {
        return {
          text: item.text,
          kind: item.kind || 'fact',
          branchId: item.branchId || branchId,
          evidence: item.evidence || [],
          source: 'chain',
          confidence: item.confidence || validated?.step_metadata?.confidence || 0.64
        };
      });
      storedClaims = native?.ingestClaims?.(claimsPayload, {
        source: 'chain',
        branchId: branchId,
        dedupByBranchText: true
      }) || [];
      maybeResurrectQuestions(storedClaims);
    }

    var questionIds = [];
    (produced.questions || []).forEach(function(question) {
      questionIds.push(mergeQuestionNode(question));
    });
    questionIds = questionIds.filter(Boolean);

    var decisionIds = [];
    (produced.decisions || []).forEach(function(item) {
      var nodeId = createDecisionNode(item);
      if (nodeId) decisionIds.push(nodeId);
    });

    var taskIds = [];
    (produced.tasks || []).forEach(function(item) {
      var nodeId = createTaskNode(item);
      if (nodeId) taskIds.push(nodeId);
    });

    chain.totalImpacts += 1;
    chain.impacts.unshift({
      impact_id: 'focus-' + Date.now(),
      focus_id: focus?.id || '',
      type: focus?.target?.kind || 'focus',
      verb: focus?.phase || 'observe',
      output: compact(validated?.step_metadata?.rationale || (questionIds[0] ? 'question created' : storedClaims[0]?.text || decisionIds[0] || taskIds[0] || 'no change'), 120),
      created_at: new Date().toISOString()
    });
    chain.impacts = chain.impacts.slice(0, 24);

    native?.touchProjectMemory?.(function(project) {
      project.impact_chain = Array.isArray(project.impact_chain) ? project.impact_chain : [];
      project.impact_chain.unshift({
        focus_id: focus?.id || '',
        phase: focus?.phase || 'observe',
        summary: compact(validated?.step_metadata?.rationale || '', 120),
        created_at: new Date().toISOString()
      });
      project.impact_chain = project.impact_chain.slice(0, 32);
    });

    window.dispatchEvent(new CustomEvent('structa-impact', {
      detail: {
        focusId: focus?.id || '',
        summary: compact(validated?.step_metadata?.rationale || '', 120),
        produced: producedCounts
      }
    }));
    if (decisionIds.length) {
      window.dispatchEvent(new CustomEvent('structa-decision-created', {
        detail: {
          ids: decisionIds.slice(),
          count: decisionIds.length
        }
      }));
    }

    return {
      claimIds: storedClaims.map(function(entry) { return entry.id; }),
      questionIds: questionIds,
      decisionIds: decisionIds,
      taskIds: taskIds,
      count: storedClaims.length + questionIds.length + decisionIds.length + taskIds.length
    };
  }

  function rejectCodeToTrace(code, detail) {
    if (code === 'no_evidence') {
      native?.traceEvent?.('chain.reject.no_evidence', 'validator', detail?.nodeKind || '', {
        nodeKind: detail?.nodeKind || '',
        nodeId: detail?.nodeId || ''
      });
      return;
    }
    if (code === 'illegal_phase') {
      native?.traceEvent?.('chain.reject.illegal_phase', detail?.from || '', detail?.to || '', {
        from: detail?.from || '',
        to: detail?.to || ''
      });
      return;
    }
    if (code === 'orphan_evidence' || code === 'inactive_evidence') {
      native?.traceEvent?.('chain.reject.orphan_evidence', 'validator', detail?.nodeId || '', {
        nodeId: detail?.nodeId || '',
        missingRef: detail?.missingRef || detail?.ref || ''
      });
    }
  }

  function recordRejectedStep(focus, reason, errors) {
    var nextRejectCount = Number(focus?.rejectCount || 0) + 1;
    var nextPlateau = Number(focus?.plateauCount || 0) + 1;
    writeFocusStep(focus.id, {
      phase: focus.phase,
      outcome: 'rejected',
      rejectCount: nextRejectCount,
      plateauCount: nextPlateau
    });
    native?.traceEvent?.('focus.step.rejected', focus.id, lower(reason || 'validator'), {
      focusId: focus.id,
      reason: lower(reason || 'validator')
    });
    (errors || []).forEach(function(error) {
      rejectCodeToTrace(error.code, error);
    });
    if (nextRejectCount >= 3) {
      native?.completeActiveFocus?.('blocked', { producedClaimCount: 0 });
      chain.active = false;
      syncPhaseWithFocus();
      return true;
    }
    if (nextPlateau >= 3) {
      native?.completeActiveFocus?.('plateau', { producedClaimCount: 0 });
      chain.active = false;
      syncPhaseWithFocus();
      return true;
    }
    native?.updateActiveFocus?.({
      rejectCount: nextRejectCount,
      plateauCount: nextPlateau
    });
    return false;
  }

  function maybeResolveFocus(focus, validated, producedCounts) {
    if (!focus) return false;
    var decisionEvidenceStrong = (validated?.produced?.decisions || []).some(function(item) {
      return Array.isArray(item.evidence) && item.evidence.length >= 2;
    });
    if (focus.phase === 'decision' && producedCounts.decisionIds.length && decisionEvidenceStrong) {
      native?.completeActiveFocus?.('resolved', { producedClaimCount: producedCounts.claimIds.length });
      return true;
    }
    return false;
  }

  function handleStepResult(focus, jobId, result) {
    chain.stepInFlight = false;
    var project = currentProject();
    var verdict = contracts?.validateChainOutput
      ? contracts.validateChainOutput(result || {}, {
          project: project,
          currentPhase: focus?.phase || 'observe',
          currentState: focus?.state || 'active'
        })
      : { ok: true, value: result, errors: [] };

    if (!result?.ok || !verdict.ok) {
      var blocked = recordRejectedStep(focus, result?.error || 'validator', verdict.errors || []);
      if (!blocked && !chain.manuallyStopped) scheduleNextBeat(Math.max(5000, Math.round(60000 / Math.max(1, chain.bpm))));
      return;
    }

    var validated = verdict.value;
    var producedCounts = applyProduced(validated, focus);
    var nextPlateau = producedCounts.count > 0 ? 0 : Number(focus?.plateauCount || 0) + 1;
    var updatedFocus = writeFocusStep(focus.id, {
      phase: focus.phase,
      phaseNext: validated.focus.phase_next || focus.phase,
      outcome: producedCounts.count > 0 ? 'progress' : 'plateau',
      jobId: jobId || '',
      producedClaimIds: producedCounts.claimIds || [],
      producedQuestionIds: producedCounts.questionIds || [],
      plateauCount: nextPlateau,
      rejectCount: 0
    });
    native?.traceEvent?.('focus.step.produced', focus.id, validated.focus.phase_next || focus.phase, {
      focusId: focus.id,
      claims: producedCounts.claimIds.length,
      questions: producedCounts.questionIds.length,
      decisions: producedCounts.decisionIds.length,
      tasks: producedCounts.taskIds.length
    });
    native?.validateEvidenceIntegrity?.();
    window.dispatchEvent(new CustomEvent('structa-chain-updated', {
      detail: {
        phase: validated.focus.phase_next || focus.phase,
        focusId: focus.id
      }
    }));
    if (maybeResolveFocus(updatedFocus || focus, validated, producedCounts)) {
      chain.active = false;
      syncPhaseWithFocus();
      if (!native?.activateNextFocus?.()) {
        native?.traceEvent?.('chain.idle', 'resolved', 'idle', {
          resolvedCount: (currentProject()?.chainHistory || []).filter(function(entry) { return entry?.outcome === 'resolved'; }).length,
          awaitingCount: (currentProject()?.open_question_nodes || []).length
        });
      }
      return;
    }
    if (nextPlateau >= 3) {
      native?.completeActiveFocus?.('plateau', { producedClaimCount: producedCounts.claimIds.length });
      chain.active = false;
      syncPhaseWithFocus();
      return;
    }
    chain.beatCount += 1;
    syncPhaseWithFocus();
    if (!chain.manuallyStopped) scheduleNextBeat(Math.max(5000, Math.round(60000 / Math.max(1, chain.bpm))));
  }

  function beat() {
    if (chain.stepInFlight || chain.manuallyStopped) return;
    if (onboardingBlocked()) {
      pause('onboarding');
      return;
    }
    if (Date.now() - chain.lastUserActivity > chain.idleTimeoutMs) {
      pause('idle timeout');
      return;
    }
    if (queueHasHigherPriorityWork()) {
      scheduleNextBeat(1800);
      return;
    }
    var focus = native?.getActiveFocus?.() || native?.activateNextFocus?.();
    if (!focus) {
      chain.active = false;
      syncPhaseWithFocus();
      return;
    }
    chain.active = true;
    syncPhaseWithFocus();
    var payload = buildChainPayload(focus);
    native?.traceEvent?.('focus.step', focus.id, focus.phase || 'observe', {
      focusId: focus.id,
      phase: focus.phase || 'observe',
      jobId: ''
    });
    chain.stepInFlight = true;
    runChainStep(payload).then(function(result) {
      handleStepResult(focus, result?.jobId || '', result || {});
    }).catch(function(error) {
      chain.stepInFlight = false;
      recordRejectedStep(focus, error?.message || 'request failed', []);
      if (!chain.manuallyStopped) scheduleNextBeat(Math.max(5000, Math.round(60000 / Math.max(1, chain.bpm))));
    });
  }

  function start(bpm) {
    if (onboardingBlocked()) return;
    chain.manuallyStopped = false;
    persistPauseState(false);
    chain.bpm = Math.max(1, Math.min(20, bpm || chain.bpm || 2));
    chain.active = true;
    scheduleNextBeat(120);
  }

  function pause(reason) {
    clearTimer();
    chain.stepInFlight = false;
    chain.active = false;
    if (reason === 'manual stop') {
      chain.manuallyStopped = true;
      persistPauseState(true);
      setPhase('paused');
    } else {
      syncPhaseWithFocus();
    }
  }

  function stop() {
    pause('manual stop');
  }

  function resume() {
    chain.lastUserActivity = Date.now();
    if (chain.manuallyStopped || onboardingBlocked()) return;
    chain.active = true;
    scheduleNextBeat(120);
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

  function requestImmediateBeat() {
    if (chain.manuallyStopped || onboardingBlocked()) return;
    scheduleNextBeat(120);
  }

  function focusLabel() {
    var focus = currentFocus();
    if (!focus) return '';
    return compact((focus.target?.kind || 'focus') + ' · ' + (focus.target?.id || focus.target?.branchId || 'main'), 32);
  }

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
    get active() { return !!chain.active; },
    get phase() { return chain.currentPhase; },
    get bpm() { return chain.bpm; },
    set bpm(val) { chain.bpm = Math.max(1, Math.min(20, Number(val || 2))); },
    get impacts() { return chain.impacts.slice(); },
    get beatCount() { return chain.beatCount; },
    get totalImpacts() { return chain.totalImpacts; },
    get totalDecisions() { return chain.totalDecisions; },
    get lastImpact() { return chain.impacts[0] || null; },
    get manuallyStopped() { return !!chain.manuallyStopped; },
    get cooldownRemaining() { return 0; },
    get focusLabel() { return focusLabel(); },
    get focusState() { return currentFocus()?.state || 'idle'; },
    get focusStepCount() { return (currentFocus()?.steps || []).length; },
    get focusPlateauCount() { return Number(currentFocus()?.plateauCount || 0); },
    get historyCount() { return (currentProject()?.chainHistory || []).length; },
    get awaitingCount() { return (currentProject()?.open_question_nodes || []).length; }
  });

  (function restorePauseState() {
    try {
      if (!window.creationStorage?.plain?.getItem) {
        syncPhaseWithFocus();
        return;
      }
      Promise.resolve(window.creationStorage.plain.getItem(PAUSE_KEY)).then(function(value) {
        if (value) {
          chain.manuallyStopped = true;
          setPhase('paused');
        } else {
          syncPhaseWithFocus();
        }
      }).catch(function() {
        syncPhaseWithFocus();
      });
    } catch (_) {
      syncPhaseWithFocus();
    }
  })();

  ['sideClick', 'longPressStart'].forEach(function(evt) {
    window.addEventListener(evt, function() {
      if (onboardingBlocked()) return;
      touchActivity();
      if (!chain.active) resume();
    });
  });

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) return;
    if (onboardingBlocked()) return;
    touchActivity();
    if (!chain.active && !chain.manuallyStopped) resume();
  });

  window.addEventListener('structa-fast-feedback', function() {
    if (onboardingBlocked()) return;
    touchActivity();
    if (!chain.manuallyStopped) requestImmediateBeat();
  });

  window.addEventListener('structa-model-change', function() {
    if (onboardingBlocked() || chain.manuallyStopped) return;
    requestImmediateBeat();
  });
})();
