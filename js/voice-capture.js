/**
 * voice-capture.js — Voice capture for Structa on R1.
 *
 * Two paths:
 * 1. R1 native STT: PTT starts capture via CreationVoiceHandler.postMessage("start"),
 *    R1 OS processes audio, sends back sttEnded via onPluginMessage.
 *    This is the PRIMARY path on R1 hardware.
 *
 * 2. Browser fallback: SpeechRecognition or MediaRecorder.
 *    Only used if on desktop/browser (not on R1).
 *
 * Changes (2026-04-13):
 * - handleTranscript() now checks for answeringQuestion context
 * - Question answers route through StructaLLM.processVoice() with questionText
 * - Resolved questions are stored via native.resolveQuestion()
 * - Removed noisy debug logs (thinking..., r1 stt: start)
 * - Voice status text shown on overlay for question-answering context
 */
(() => {
  const native = window.StructaNative;
  const queue = window.StructaProcessingQueue;
  const overlay = document.getElementById('voice-overlay');
  const transcriptEl = document.getElementById('voice-transcript');
  const status = document.getElementById('voice-status');
  const wave = document.getElementById('voice-wave');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let listening = false;
  let audioRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let pendingAudioAsset = null;
  let voiceTarget = null; // 'tell' | 'question-answer' | null
  let activeQuestion = null; // { index, text } when answering a question
  let activeBuildContext = null; // { kind, nodeId, text, surface }
  let activeTriangleContext = null; // { label }
  let onboardingStartTimer = null;
  const COMMAND_PRIORITY = {
    'delete-project': 0,
    'archive-project': 1,
    'switch-project': 2,
    'new-project': 3,
    'set-type': 4,
    'set-role': 5,
    'export-snapshot': 6,
    'export': 7,
    'research': 8
  };

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function clearOnboardingStartTimer() {
    if (!onboardingStartTimer) return;
    clearTimeout(onboardingStartTimer);
    onboardingStartTimer = null;
  }

  function reportOnboardingSTTFailure(reason, question) {
    var context = question || activeQuestion;
    if (!context?.onboarding) return;
    window.dispatchEvent(new CustomEvent('structa-onboarding-stt-failed', {
      detail: { reason: reason || 'empty' }
    }));
  }

  function inlineMode() {
    return !!window.__STRUCTA_INLINE_PTT__;
  }

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function setContextLabel(text) {
    const label = document.getElementById('voice-context-label');
    if (!label) return;
    if (text) {
      label.textContent = String(text);
      label.style.display = 'block';
      return;
    }
    label.textContent = '';
    label.style.display = 'none';
  }

  function showOverlay() {
    if (inlineMode()) {
      window.dispatchEvent(new CustomEvent('structa-voice-open'));
      return;
    }
    document.getElementById('app')?.classList.add('overlay-active');
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
    window.dispatchEvent(new CustomEvent('structa-voice-open'));
  }

  function hideOverlay() {
    if (inlineMode()) {
      window.dispatchEvent(new CustomEvent('structa-voice-close'));
      return;
    }
    overlay?.classList.remove('open', 'listening');
    overlay?.setAttribute('aria-hidden', 'true');
    document.getElementById('app')?.classList.remove('overlay-active');
    if (wave) wave.hidden = true;
    window.dispatchEvent(new CustomEvent('structa-voice-close'));
  }

  function stopAudioStream() {
    if (audioStream) {
      try { audioStream.getTracks().forEach(track => track.stop()); } catch (_) {}
      audioStream = null;
    }
  }

  // === Voice command patterns ===
  var VOICE_COMMANDS = [
    { pattern: /^export snapshot$/i, type: 'export-snapshot' },
    { pattern: /^(?:research|look up|search for|find out about)\s+(.+)/i, type: 'research' },
    { pattern: /^export\s+(brief|decisions|research|summary)/i, type: 'export' },
    { pattern: /^(?:new project|create project|start project)\s+(.+)/i, type: 'new-project' },
    { pattern: /^(?:switch to|open project|go to project)\s+(.+)/i, type: 'switch-project' },
    { pattern: /^(?:archive project|park project)\s*(.*)/i, type: 'archive-project' },
    { pattern: /^(?:delete project|remove project)\s*(.*)/i, type: 'delete-project' },
    { pattern: /^(?:set type|project type)\s+(architecture|software|design|film|music|writing|research|general)/i, type: 'set-type' },
    { pattern: /^(?:i am a|my role is|i'm a)\s+(.+)/i, type: 'set-role' }
  ];

  function tryVoiceCommand(text) {
    var spoken = text.toLowerCase().trim();
    var matched = VOICE_COMMANDS.map(function(cmd) {
      return { cmd: cmd, match: spoken.match(cmd.pattern) };
    }).filter(function(entry) { return !!entry.match; })
      .sort(function(a, b) {
        return (COMMAND_PRIORITY[a.cmd.type] ?? 99) - (COMMAND_PRIORITY[b.cmd.type] ?? 99);
      })[0];
    if (!matched) return false;
    var cmd = matched.cmd;
    var match = matched.match;
    var arg = (match[1] || '').trim();

    switch (cmd.type) {
      case 'research':
          native?.appendLogEntry?.({ kind: 'diagnostic', message: 'branch working in background: ' + arg.slice(0, 40) });
          if (window.StructaLLM && window.StructaLLM.research) {
            window.StructaLLM.withOperationPolicy({
              allowSpeech: false,
              silent: true,
              source: 'research-command',
              reason: 'branch work stays quiet'
            }, function() {
              return window.StructaLLM.research(arg);
            }).then(function(result) {
              if (result && result.ok) {
                native?.appendLogEntry?.({ kind: 'diagnostic', message: 'branch ready: ' + result.findings.slice(0, 2).join('; ').slice(0, 50) });
                native?.updateUIState?.({ last_insight_summary: 'branch working · ' + arg.slice(0, 30) });
              }
              window.dispatchEvent(new CustomEvent('structa-memory-updated'));
            });
          }
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'research-command' }
          }));
          return true;

      case 'export':
          native?.appendLogEntry?.({ kind: 'diagnostic', message: 'export working in background: ' + arg });
          if (window.StructaLLM && window.StructaLLM.generateExport) {
            window.StructaLLM.withOperationPolicy({
              allowSpeech: false,
              silent: true,
              source: 'export-command',
              reason: 'exports stay quiet'
            }, function() {
              return window.StructaLLM.generateExport(arg);
            }).then(function(result) {
              if (result && result.ok) {
                native?.appendLogEntry?.({ kind: 'diagnostic', message: arg + ' export ready' });
              }
              window.dispatchEvent(new CustomEvent('structa-memory-updated'));
            });
          }
          return true;

      case 'export-snapshot':
          native?.appendLogEntry?.({ kind: 'voice', message: 'export snapshot' });
          native?.dumpDebugSnapshot?.({ export: true });
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'export-snapshot-command' }
          }));
          return true;

      case 'new-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'new project: ' + arg.slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'new-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'new-project-command' }
          }));
          return true;

      case 'switch-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'switch to: ' + arg.slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'switch-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'switch-project-command' }
          }));
          return true;

      case 'archive-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'archive project: ' + (arg || 'active').slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'archive-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'archive-project-command' }
          }));
          return true;

      case 'delete-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'delete project: ' + (arg || 'active').slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'delete-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'delete-project-command' }
          }));
          return true;

      case 'set-type':
          if (native?.setProjectType) native.setProjectType(arg);
          native?.appendLogEntry?.({ kind: 'voice', message: 'project type: ' + arg });
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
          return true;

      case 'set-role':
          if (native?.setUserRole) native.setUserRole(arg);
          native?.appendLogEntry?.({ kind: 'voice', message: 'role set: ' + arg.slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
          return true;
    }
    return false;
  }

  function inferProjectName(rawText) {
    var value = String(rawText || '').trim();
    if (!value) return '';
    value = value
      .replace(/^(?:this project is about|this project is|project about|project is|we are building|we're building|we are making|we're making|i am building|i'm building|i want to build|i want to make|this is about|this is|about)\s+/i, '')
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(/[.?!]+$/g, '')
      .trim();
    if (!value) return '';
    var phrase = value.split(/[,:;\n]/)[0].trim();
    if (!phrase) return '';
    var stopWords = {
      'a': true, 'an': true, 'the': true, 'to': true, 'for': true, 'and': true, 'with': true,
      'this': true, 'project': true, 'is': true, 'about': true, 'our': true, 'my': true,
      'we': true, 'i': true, 'of': true
    };
    var words = phrase
      .split(/\s+/)
      .map(function(word) { return word.replace(/[^a-z0-9-]/gi, '').toLowerCase(); })
      .filter(function(word) { return word && !stopWords[word]; })
      .slice(0, 3);
    if (!words.length) return '';
    var title = words.join(' ').slice(0, 22).trim().toLowerCase();
    return title.length >= 3 ? title : '';
  }

  function resolveProjectTitle(rawText, project) {
    var heuristic = inferProjectName(rawText);
    if (lower(project?.name || '') !== 'untitled project') {
      return Promise.resolve(heuristic);
    }
    if (!window.StructaLLM?.titleProject || !project) {
      return Promise.resolve(heuristic);
    }
    return window.StructaLLM.titleProject(rawText, project).then(function(result) {
      return (result && result.title) || heuristic;
    }).catch(function() {
      return heuristic;
    });
  }

  function enqueueProjectTitle(rawText, project) {
    if (!queue || !project || lower(project?.name || '') !== 'untitled project') return;
    const heuristic = inferProjectName(rawText);
    queue.enqueue({
      kind: 'project-title',
      priority: 'P2',
      payload: {
        transcript: rawText,
        projectId: project.project_id || project.id || '',
        heuristic: heuristic
      },
      origin: {
        screen: 'project-title',
        itemId: project.project_id || project.id || ''
      },
      timeoutMs: 3000
    });
  }

  function enqueueProjectBrief(rawText, project, options) {
    if (!queue || !project) return;
    const opts = options && typeof options === 'object' ? options : {};
    queue.enqueue({
      kind: 'project-brief',
      priority: 'P1',
      payload: {
        transcript: rawText,
        projectId: project.project_id || project.id || '',
        voiceEntryId: opts.voiceEntryId || '',
        operationId: opts.operationId || ''
      },
      origin: {
        screen: 'onboarding',
        itemId: project.project_id || project.id || ''
      },
      timeoutMs: 28000
    });
  }

  function enqueueThreadRefine(payload) {
    if (!queue || !payload?.nodeId || !payload?.commentId) return;
    queue.enqueue({
      kind: 'thread-refine',
      priority: 'P2',
      payload: payload,
      origin: {
        screen: payload.surface || 'know',
        itemId: payload.nodeId
      },
      timeoutMs: 12000
    });
  }

  function enqueueClaimsBackfill(payload) {
    if (!queue || !payload?.nodeId || !payload?.body) return;
    queue.enqueue({
      kind: 'claims-backfill',
      priority: 'P3',
      payload: payload,
      origin: {
        screen: payload.surface || 'backfill',
        itemId: payload.nodeId
      },
      timeoutMs: 18000
    });
  }

  function scheduleClaimBackfillSweep(delayMs) {
    if (!queue || !window.StructaLLM?.backfillClaimsForItem || window.__STRUCTA_CLAIM_BACKFILL_SWEEP__) return;
    window.__STRUCTA_CLAIM_BACKFILL_SWEEP__ = true;
    setTimeout(function() {
      try {
        var project = native?.getProjectMemory?.();
        var nodes = Array.isArray(project?.nodes) ? project.nodes : [];
        nodes.slice(0, 24).forEach(function(node) {
          if (!node || node.status === 'archived') return;
          var hasClaims = Array.isArray(project?.claimIndex?.byItem?.[node.node_id]) && project.claimIndex.byItem[node.node_id].length;
          var alreadyBackfilled = !!node.meta?.claims_backfilled;
          var body = String(node.body || node.title || '').trim();
          if (!body || hasClaims || alreadyBackfilled) return;
          enqueueClaimsBackfill({
            nodeId: node.node_id,
            body: body,
            surface: node.type || 'backfill',
            selection: {
              kind: node.type || 'item',
              id: node.node_id,
              title: node.title || '',
              body: body,
              status: node.status || 'open'
            },
            project: {
              id: project?.project_id || '',
              name: project?.name || 'untitled project',
              type: project?.type || 'general',
              topQuestions: (project?.open_questions || []).slice(0, 3),
              summary: project?.summary || '',
              selectedSurface: node.type || 'backfill'
            },
            source: node.source || node.type || 'backfill',
            sourceRef: { itemId: node.node_id }
          });
        });
      } finally {
        window.__STRUCTA_CLAIM_BACKFILL_SWEEP__ = false;
      }
    }, Math.max(0, delayMs || 0));
  }

  function linkInsightToContext(buildContext, createdInsight) {
    if (!createdInsight?.node_id || !buildContext?.nodeId || !native?.touchProjectMemory) return;
    native.touchProjectMemory(function(project) {
      var nodes = project.nodes || [];
      var sourceNode = nodes.find(function(entry) { return entry.node_id === buildContext.nodeId; });
      var insightNode = nodes.find(function(entry) { return entry.node_id === createdInsight.node_id; });
      if (sourceNode && insightNode) {
        sourceNode.links = Array.isArray(sourceNode.links) ? sourceNode.links : [];
        insightNode.links = Array.isArray(insightNode.links) ? insightNode.links : [];
        if (sourceNode.links.indexOf(insightNode.node_id) === -1) sourceNode.links.push(insightNode.node_id);
        if (insightNode.links.indexOf(sourceNode.node_id) === -1) insightNode.links.push(sourceNode.node_id);
      }
    });
  }

  function emptyCandidateBuckets() {
    return { decisions: [], asks: [], blockers: [], themes: [] };
  }

  function mergeCandidateText(list, text, kind, sourceRef) {
    var value = String(text || '').trim();
    if (!value) return;
    var exists = list.some(function(entry) {
      return lower(entry?.text || '') === lower(value);
    });
    if (exists) return;
    list.push({
      kind: kind,
      text: value,
      confidence: 'med',
      source: 'voice-note',
      sourceRef: sourceRef || {},
      created_at: new Date().toISOString()
    });
  }

  function deriveVoiceCandidates(result, transcript, sourceRef) {
    var buckets = emptyCandidateBuckets();
    var clean = String(result?.clean || '').trim();
    var structured = result?.structured || {};
    var decision = String(structured?.decision || '').trim();
    var next = String(structured?.next || '').trim();
    var kind = lower(structured?.type || structured?.kind || '');
    var body = String(transcript || '').trim();
    if (decision) mergeCandidateText(buckets.decisions, decision, 'decision', sourceRef);
    if (kind === 'question' || /\?$/.test(body)) {
      mergeCandidateText(buckets.asks, body || clean, 'ask', sourceRef);
    }
    if (/(blocked|stuck|waiting|can.t|cannot|risk|issue|problem|missing|delayed)/i.test(clean) || /(blocked|stuck|waiting|risk|issue|problem)/i.test(body)) {
      mergeCandidateText(buckets.blockers, clean || body, 'blocker', sourceRef);
    }
    if (next && /\?/.test(next)) {
      mergeCandidateText(buckets.asks, next, 'ask', sourceRef);
    }
    mergeCandidateText(buckets.themes, clean || body, 'theme', sourceRef);
    return buckets;
  }

  function storeVoiceInterpretation(payload, result) {
    var voiceEntryId = payload.voiceEntryId || payload.buildContext?.nodeId || '';
    var transcript = payload.transcript || '';
    var sourceRef = voiceEntryId ? { itemId: voiceEntryId } : {};
    var candidates = deriveVoiceCandidates(result, transcript, sourceRef);
    if (voiceEntryId && native?.touchProjectMemory) {
      native.touchProjectMemory(function(project) {
        var node = (project.nodes || []).find(function(entry) {
          return entry.node_id === voiceEntryId && entry.type === 'voice-entry';
        });
        if (!node) return;
        node.meta = {
          ...(node.meta || {}),
          transformed_text: result?.clean || '',
          transformed_structured: result?.structured || null,
          transformed_at: new Date().toISOString(),
          operation_id: payload.operationId || node.meta?.operation_id || ''
        };
      });
    }
    var writeVerdict = native?.recordOperationWrite?.(payload.operationId || '', 'derived_candidate', {
      source: 'voice-note',
      nodeId: voiceEntryId || ''
    });
    if (native?.saveDerivedCandidates && (!writeVerdict || writeVerdict.ok !== false)) {
      native.saveDerivedCandidates(candidates, {
        source: 'voice-note',
        sourceRef: sourceRef,
        operation_id: payload.operationId || ''
      });
    }
    native?.appendLogEntry?.({ kind: 'llm', message: 'note clarified' });
    native?.updateUIState?.({ last_insight_summary: String(result?.clean || '').slice(0, 60) });
    return candidates;
  }

  function applyProjectBriefResult(payload, result) {
    var title = String(result?.title || '').trim();
    var brief = String(result?.brief || '').trim();
    if (title && lower(title) !== 'untitled project') {
      native?.setProjectName?.(title);
    }
    var briefWrite = native?.recordOperationWrite?.(payload.operationId || '', 'project_brief', {
      voiceEntryId: payload.voiceEntryId || ''
    });
    if (brief && native?.setProjectBrief && (!briefWrite || briefWrite.ok !== false)) {
      native.setProjectBrief(brief, {
        source: 'onboarding',
        operation_id: payload.operationId || '',
        voice_entry_id: payload.voiceEntryId || ''
      });
    }
    var candidateWrite = native?.recordOperationWrite?.(payload.operationId || '', 'derived_candidate', {
      voiceEntryId: payload.voiceEntryId || ''
    });
    if (result?.candidates && native?.saveDerivedCandidates && (!candidateWrite || candidateWrite.ok !== false)) {
      native.saveDerivedCandidates(result.candidates, {
        source: 'project-brief',
        sourceRef: payload.voiceEntryId ? { itemId: payload.voiceEntryId } : {},
        replace: true,
        operation_id: payload.operationId || ''
      });
    }
    if (payload.voiceEntryId && native?.touchProjectMemory) {
      native.touchProjectMemory(function(project) {
        var node = (project.nodes || []).find(function(entry) {
          return entry.node_id === payload.voiceEntryId && entry.type === 'voice-entry';
        });
        if (!node) return;
        node.meta = {
          ...(node.meta || {}),
          onboarding_brief: brief || '',
          onboarding_title: title || '',
          onboarding_candidates: result?.candidates || emptyCandidateBuckets(),
          transformed_at: new Date().toISOString(),
          operation_id: payload.operationId || node.meta?.operation_id || ''
        };
      });
    }
    native?.appendLogEntry?.({ kind: 'llm', message: 'project brief ready' });
    native?.updateUIState?.({
      last_insight_summary: (brief || title || '').slice(0, 60),
      user_status: title ? ('project: ' + title) : 'project brief ready'
    });
  }

  function queueVoiceInterpret(payload) {
    if (!queue) return;
    queue.enqueue({
      kind: 'voice-interpret',
      priority: 'P1',
      payload: payload,
      origin: {
        screen: payload.mode === 'question' ? 'now' : (payload.buildContext?.surface || 'tell'),
        itemId: payload.buildContext?.nodeId || payload.questionText || ''
      }
    });
  }

  if (queue && !window.__STRUCTA_VOICE_QUEUE_REGISTERED__) {
    window.__STRUCTA_VOICE_QUEUE_REGISTERED__ = true;
    queue.registerHandler('project-title', function(job) {
      const payload = job.payload || {};
      const project = native?.getProjectMemory?.();
      if (!project || (project.project_id || project.id || '') !== (payload.projectId || '')) {
        return { ok: false, stale: true };
      }
      if (lower(project.name || '') !== 'untitled project') {
        return { ok: true, stale: true, title: project.name || '' };
      }
      return resolveProjectTitle(payload.transcript || '', project).then(function(title) {
        const finalTitle = title || payload.heuristic || '';
        if (finalTitle && lower(finalTitle) !== 'untitled project') {
          native?.setProjectName?.(finalTitle);
        }
        return { ok: !!finalTitle, title: finalTitle || payload.heuristic || '' };
      });
    });

    queue.registerHandler('voice-interpret', function(job) {
      const payload = job.payload || {};
      native?.traceEvent?.('voice', 'queued', 'interpreting', {
        jobId: job.id || '',
        mode: payload.mode || 'voice',
        nodeId: payload.questionNodeId || payload.buildContext?.nodeId || '',
        questionText: payload.questionText || ''
      });
      if (!window.StructaLLM?.processVoice) {
        return Promise.resolve({ ok: false, error: 'llm unavailable' });
      }
      const options = payload.mode === 'question'
        ? { answeringQuestion: true, questionText: payload.questionText || '' }
        : (payload.buildContext ? { buildContext: payload.buildContext } : {});
      return window.StructaLLM.processVoice(payload.transcript || '', options).then(function(result) {
        if (payload.mode === 'question') {
          if (result && result.ok && result.clean) {
            var sourceRef = {
              itemId: payload.answerNodeId || payload.questionNodeId || '',
              questionId: payload.questionNodeId || '',
              answerId: payload.answerNodeId || ''
            };
            var storedClaims = [];
            if (Array.isArray(result.claims) && native?.ingestClaims) {
              storedClaims = native.ingestClaims(result.claims, {
                source: 'answer',
                sourceRef: sourceRef,
                sttConfidence: typeof result.answerNode?.sttConfidence === 'number' ? result.answerNode.sttConfidence : null
              }).map(function(entry) { return entry.id; });
            }
            if (native?.saveDerivedCandidates) {
              native.saveDerivedCandidates(deriveVoiceCandidates(result, payload.transcript || '', sourceRef), {
                source: 'answer',
                sourceRef: sourceRef
              });
            }
            if (payload.answerNodeId && native?.enrichAnswerNode) {
              native.enrichAnswerNode(payload.answerNodeId, {
                claims: storedClaims,
                sttConfidence: typeof result.answerNode?.sttConfidence === 'number' ? result.answerNode.sttConfidence : null,
                transformed_text: result.clean || '',
                transformed_structured: result.structured || null
              });
            }
            if (payload.answerNodeId && payload.questionNodeId && native?.touchProjectMemory) {
              native.touchProjectMemory(function(project) {
                var nodes = Array.isArray(project.nodes) ? project.nodes : [];
                var questionNode = nodes.find(function(entry) { return entry.node_id === payload.questionNodeId; });
                var answerNode = nodes.find(function(entry) { return entry.node_id === payload.answerNodeId; });
                if (questionNode && answerNode) {
                  questionNode.links = Array.isArray(questionNode.links) ? questionNode.links : [];
                  answerNode.links = Array.isArray(answerNode.links) ? answerNode.links : [];
                  answerNode.meta = {
                    ...(answerNode.meta || {}),
                    question_node_id: payload.questionNodeId,
                    answer_node_id: payload.answerNodeId || '',
                    transformed_text: result.clean || '',
                    transformed_structured: result.structured || null
                  };
                  if (questionNode.links.indexOf(answerNode.node_id) === -1) questionNode.links.push(answerNode.node_id);
                  if (answerNode.links.indexOf(questionNode.node_id) === -1) answerNode.links.push(questionNode.node_id);
                }
              });
            }
            native?.updateUIState?.({ last_insight_summary: result.clean.slice(0, 60) });
            native?.emitModelChange?.({
              scope: 'now',
              itemId: payload.questionNodeId || '',
              jobId: job.id || ''
            });
            native?.traceEvent?.('blocker', 'answered', 'insight-created', {
              jobId: job.id || '',
              nodeId: payload.questionNodeId || '',
              insightId: payload.answerNodeId || '',
              clean: result.clean || ''
            });
            if (result.followUpQuestion && native?.addNode) {
              setTimeout(function() {
                var project = native?.getProjectMemory?.() || {};
                var existing = (project.open_question_nodes || []).some(function(entry) {
                  var current = lower(entry?.body || entry?.title || '');
                  var nextText = lower(result.followUpQuestion || '');
                  return current === nextText || current.indexOf(nextText) !== -1 || nextText.indexOf(current) !== -1;
                });
                if (!existing) {
                  native.addNode({
                    type: 'question',
                    status: 'open',
                    title: 'follow up',
                    body: result.followUpQuestion,
                    source: 'voice-answer',
                    meta: {
                      parent_question_id: payload.questionNodeId || '',
                      answer_node_id: payload.answerNodeId || '',
                      evidence_claims: storedClaims
                    }
                  });
                  native?.traceEvent?.('question', 'queued', 'follow-up-open', {
                    nodeId: payload.questionNodeId || '',
                    answerId: payload.answerNodeId || ''
                  });
                }
              }, 200);
            }
            window.StructaLLM?.speakMilestone?.('signal_captured');
            window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
              detail: { source: 'question-answer' }
            }));
          }
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
          return result;
        }

        if (result && result.ok) {
          storeVoiceInterpretation(payload, result);
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'voice-transform' }
          }));
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        } else {
          native?.appendLogEntry?.({ kind: 'llm', message: 'note clarification unavailable' });
        }
        return result;
      }).catch(function(err) {
        if (payload.mode !== 'question') {
          native?.appendLogEntry?.({ kind: 'llm', message: 'note clarification failed' });
        }
        window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        throw err;
      }).finally(function() {
        native?.finishOperation?.(payload.operationId || '', {
          kind: payload.mode || 'voice'
        });
      });
    });

    queue.registerHandler('project-brief', function(job) {
      const payload = job.payload || {};
      const project = native?.getProjectMemory?.();
      if (!project || (project.project_id || project.id || '') !== (payload.projectId || '')) {
        return { ok: false, stale: true };
      }
      if (!window.StructaLLM?.buildProjectBrief) {
        return { ok: false, error: 'brief unavailable' };
      }
      native?.traceEvent?.('project', 'queued', 'briefing', {
        jobId: job.id || '',
        projectId: payload.projectId || '',
        voiceEntryId: payload.voiceEntryId || ''
      });
      return window.StructaLLM.buildProjectBrief(payload.transcript || '', project).then(function(result) {
        if (result && result.ok) {
          applyProjectBriefResult(payload, result);
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'project-brief' }
          }));
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        } else {
          native?.appendLogEntry?.({ kind: 'llm', message: 'project brief unavailable' });
        }
        return result;
      }).catch(function(err) {
        native?.appendLogEntry?.({ kind: 'llm', message: 'project brief failed' });
        window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        throw err;
      }).finally(function() {
        native?.finishOperation?.(payload.operationId || '', {
          kind: 'project-brief'
        });
      });
    });

    queue.registerHandler('claims-backfill', function(job) {
      const payload = job.payload || {};
      if (!payload.nodeId || !payload.body || !window.StructaLLM?.backfillClaimsForItem) {
        return { ok: false, stale: true, claims: [] };
      }
      native?.traceEvent?.('claim', 'queued', 'backfilling', {
        jobId: job.id || '',
        nodeId: payload.nodeId || ''
      });
      return window.StructaLLM.backfillClaimsForItem({
        project: payload.project || null,
        selection: payload.selection || null,
        body: payload.body || '',
        source: payload.source || 'backfill',
        sourceRef: payload.sourceRef || { itemId: payload.nodeId }
      }).then(function(result) {
        if (result && result.ok && Array.isArray(result.claims) && result.claims.length && native?.ingestClaims) {
          native.ingestClaims(result.claims, {
            source: payload.source || 'backfill',
            sourceRef: payload.sourceRef || { itemId: payload.nodeId }
          });
        }
        native?.touchProjectMemory?.(function(project) {
          var node = (project.nodes || []).find(function(entry) { return entry.node_id === payload.nodeId; });
          if (!node) return;
          node.meta = { ...(node.meta || {}), claims_backfilled: true };
        });
        native?.traceEvent?.('claim', 'backfilling', 'backfilled', {
          jobId: job.id || '',
          nodeId: payload.nodeId || '',
          count: Array.isArray(result?.claims) ? result.claims.length : 0
        });
        return result || { ok: false, claims: [] };
      });
    });

    queue.registerHandler('thread-refine', function(job) {
      const payload = job.payload || {};
      if (!payload.nodeId || !payload.commentId || !window.StructaLLM?.refineThreadComment) {
        return { ok: false, stale: true };
      }
      return window.StructaLLM.refineThreadComment({
        project: {
          id: payload.projectId || '',
          name: payload.projectName || 'untitled project',
          type: payload.projectType || 'general',
          brief: payload.projectBrief || '',
          topQuestions: payload.topQuestions || [],
          selectedSurface: payload.surface || 'know',
          summary: payload.projectSummary || ''
        },
        selection: payload.selection || null,
        sourceRef: {
          itemId: payload.nodeId || '',
          threadEntryId: payload.commentId || ''
        },
        input: {
          transcript: payload.commentText || ''
        }
      }).then(function(result) {
        const applied = native?.applyThreadExtraction?.(payload.nodeId, payload.commentId, {
          summary: (result && result.summary) || payload.commentText || '',
          claims: Array.isArray(result?.claims) ? result.claims : [],
          clarifies: result?.clarifies || '',
          contradicts: result?.contradicts || ''
        }, {
          sttConfidence: typeof result?.sttConfidence === 'number' ? result.sttConfidence : null
        });
        return {
          ok: !!applied,
          summary: applied?.comment?.summary || (result && result.summary) || payload.commentText || '',
          claims: applied?.claims || []
        };
      });
    });
  }

  if (!window.__STRUCTA_CLAIM_BACKFILL_BOOTSTRAPPED__) {
    window.__STRUCTA_CLAIM_BACKFILL_BOOTSTRAPPED__ = true;
    scheduleClaimBackfillSweep(1200);
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) scheduleClaimBackfillSweep(600);
    });
  }

  /**
   * handleTranscript — processes a voice transcript.
   * Routes to:
   * 1. Voice commands (research, export, new project, switch, set type/role)
   * 2. Question answering (if activeQuestion is set)
   * 3. Normal voice input (project context via StructaLLM)
   */
  function handleTranscript(text, overrides) {
    if (!text || !text.trim()) return;
    text = text.trim();
    var questionContext = overrides && overrides.activeQuestion ? overrides.activeQuestion : activeQuestion;
    var buildContext = overrides && overrides.activeBuildContext ? overrides.activeBuildContext : activeBuildContext;
    var triangleContext = overrides && overrides.activeTriangleContext ? overrides.activeTriangleContext : activeTriangleContext;

    // Clean up STT artifacts — spoken punctuation → actual punctuation
    text = text.replace(/\bquestion mark\b/gi, '?');
    text = text.replace(/\bperiod\b/gi, '.');
    text = text.replace(/\bcomma\b/gi, ',');
    text = text.replace(/\bexclamation mark\b/gi, '!');
    text = text.replace(/\bexclamation point\b/gi, '!');
    text = text.replace(/\s+/g, ' ').trim();

    // === Voice commands — intercept before normal processing ===
    var commandHandled = tryVoiceCommand(text);
    if (commandHandled) return;

    if (triangleContext) {
      activeTriangleContext = null;
      voiceTarget = null;
      native?.traceEvent?.('triangle', 'angle-captured', 'submitted', {
        label: triangleContext.label || 'your angle'
      });
      native?.appendLogEntry?.({ kind: 'triangle', message: 'triangle synthesizing' });
      window.dispatchEvent(new CustomEvent('structa-triangle-submit', {
        detail: {
          transcript: text,
          label: triangleContext.label || 'your angle'
        }
      }));
      return;
    }

    // === Question answering mode ===
    if (questionContext) {
      var question = questionContext;
      voiceTarget = null;
      native?.traceEvent?.('voice', 'captured', 'question-answer', {
        nodeId: question.nodeId || '',
        onboarding: !!question.onboarding,
        text: question.text || ''
      });
      native?.appendLogEntry?.({ kind: 'voice', message: 'question answered' });
      var resolution = null;
      var onboardingVoiceEntry = null;
      var onboardingOperationId = question.onboarding
        ? (native?.beginOperation?.({
            kind: 'onboarding',
            allowed: {
              voice_note: 1,
              project_brief: 1,
              derived_candidate: 1
            }
          }) || '')
        : '';

      // Store the answer in project memory
      if (question.onboarding) {
        onboardingVoiceEntry = native?.addVoiceEntry?.({
          title: text.slice(0, 42) || 'project foundation',
          body: text,
          source: 'onboarding',
          entry_mode: 'onboarding',
          operation_id: onboardingOperationId
        });
        native?.recordOperationWrite?.(onboardingOperationId, 'voice_note', {
          nodeId: onboardingVoiceEntry?.node_id || ''
        });
        window.dispatchEvent(new CustomEvent('structa-onboarding-answer', {
          detail: {
            answer: text,
            inferredName: ''
          }
        }));
      } else {
        resolution = native?.resolveQuestion?.({
          index: question.index,
          nodeId: question.nodeId || '',
          text: question.text || '',
          source: question.source || 'question'
        }, text);
      }
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'question-answer' }
      }));
      if (question.onboarding) {
        var currentProject = native?.getProjectMemory?.();
        enqueueProjectBrief(text, currentProject, {
          voiceEntryId: onboardingVoiceEntry?.node_id || '',
          operationId: onboardingOperationId
        });
        return;
      }

      // Send to LLM for structured extraction (answer mode)
      queueVoiceInterpret({
        mode: 'question',
        transcript: text,
        questionText: question.text || '',
        questionNodeId: question.nodeId || '',
        answerNodeId: resolution?.answerNode?.id || ''
      });
      return;
    }

    if (buildContext && buildContext.kind === 'log-note') {
      voiceTarget = null;
      native?.appendLogEntry?.({
        kind: 'voice',
        message: 'log note · ' + text.slice(0, 72)
      });
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'log-note' }
      }));
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      return;
    }

    if (buildContext && buildContext.kind === 'thread-comment') {
      voiceTarget = null;
      if (text.length < 3) return;
      native?.traceEvent?.('thread', 'captured', 'append-request', {
        nodeId: buildContext.nodeId,
        surface: buildContext.surface || 'know'
      });
      const appended = native?.appendThreadComment?.(
        buildContext.nodeId,
        text,
        buildContext.commentKind || 'comment',
        'ptt'
      );
      if (!appended || !appended.comment) return;
      window.StructaFeedback?.fire?.('resolve');
      window.dispatchEvent(new CustomEvent('structa-thread-comment-appended', {
        detail: {
          nodeId: buildContext.nodeId,
          commentId: appended.comment.id,
          comment: appended.comment,
          surface: buildContext.surface || 'know'
        }
      }));
      enqueueThreadRefine({
        nodeId: buildContext.nodeId,
        commentId: appended.comment.id,
        commentText: text,
        surface: buildContext.surface || 'know',
        selection: {
          kind: buildContext.surface || 'know',
          id: buildContext.nodeId,
          title: buildContext.title || '',
          summary: buildContext.text || '',
          status: 'open',
          createdAt: buildContext.createdAt || '',
          claims: native?.getClaimsForItem?.(buildContext.nodeId) || []
        },
        projectId: native?.getProjectMemory?.()?.project_id || '',
        projectName: native?.getProjectMemory?.()?.name || 'untitled project',
        projectType: native?.getProjectMemory?.()?.type || 'general',
        projectBrief: native?.getProjectMemory?.()?.brief || '',
        topQuestions: (native?.getProjectMemory?.()?.open_questions || []).slice(0, 3),
        projectSummary: buildContext.projectSummary || ''
      });
      return;
    }

    if (buildContext && buildContext.kind === 'new-project-name') {
      voiceTarget = null;
      var seedName = inferProjectName(text) || String(text || '').trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      var created = native?.createProject?.(seedName || 'capturing');
      if (created && created.ok === false) {
        window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        return;
      }
      var currentProject = native?.getProjectMemory?.();
      enqueueProjectTitle(text, currentProject);
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'new-project' }
      }));
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      return;
    }

    // === Normal voice input ===
    native?.appendLogEntry?.({ kind: 'voice', message: 'voice saved' });
    var operationId = native?.beginOperation?.({
      kind: 'tell',
      allowed: {
        voice_note: 1,
        derived_candidate: 1
      }
    }) || '';
    var voiceEntry = null;
    if (buildContext && buildContext.kind === 'voice-entry' && buildContext.nodeId && native?.appendToVoiceEntry) {
      voiceEntry = native.appendToVoiceEntry(buildContext.nodeId, text, {
        entry_mode: 'contextual-build',
        surface: buildContext.surface || 'tell',
        operation_id: operationId
      });
    } else {
      voiceEntry = native?.addVoiceEntry?.({
        title: text.slice(0, 42) || 'voice note',
        body: text,
        source: 'voice',
        entry_mode: buildContext ? 'contextual' : 'auto',
        operation_id: operationId,
        meta: buildContext ? { build_surface: buildContext.surface || 'tell' } : {}
      });
    }
    native?.recordOperationWrite?.(operationId, 'voice_note', {
      nodeId: voiceEntry?.node_id || buildContext?.nodeId || ''
    });
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: 'voice-entry' }
    }));

    // Try to detect a task and add to backlog
    var taskMatch = text.match(/^(?:need to|must|have to|gotta|remember to|don't forget to)\b(.{5,80})/i);
    if (taskMatch) {
      native?.addBacklogItem?.(text.slice(0, 60), text);
    }

    var isQuestion = /\?$/.test(text) || /^(?:what|why|how|when|who|which|where|is|are|can|could|should|would|do|does)\b/i.test(text);
    if (isQuestion && native?.addNode) {
      native.addNode({
        type: 'question',
        status: 'open',
        title: text.slice(0, 72),
        body: text,
        source: buildContext ? (buildContext.surface || 'voice') : 'voice'
      });
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'question' }
      }));
    }

    queueVoiceInterpret({
      mode: 'voice',
      transcript: text,
      buildContext: buildContext || null,
      voiceEntryId: voiceEntry?.node_id || buildContext?.nodeId || '',
      operationId: operationId
    });
  }

  function stopListening(emit) {
    emit = emit !== false;
    var pendingQuestion = activeQuestion;
    var pendingBuildContext = activeBuildContext;
    var pendingTriangleContext = activeTriangleContext;
    native?.traceEvent?.('voice', 'listening', 'stopped', {
      emit: !!emit,
      target: voiceTarget || '',
      questionNodeId: pendingQuestion?.nodeId || '',
      buildNodeId: pendingBuildContext?.nodeId || ''
    });
    listening = false;
    voiceTarget = null;
    activeQuestion = null;
    activeBuildContext = null;
    activeTriangleContext = null;

    // Stop browser recognition
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    if (audioRecorder && audioRecorder.state !== 'inactive') {
      try { audioRecorder.stop(); } catch (_) {}
    }
    clearOnboardingStartTimer();
    stopAudioStream();
    overlay?.classList.remove('listening');
    if (wave) wave.hidden = true;

    const text = (transcriptEl && transcriptEl.textContent || '').trim();

    if (emit) {
      // Tell R1 OS we stopped talking
      if (typeof CreationVoiceHandler !== 'undefined') {
        try { CreationVoiceHandler.postMessage('stop'); } catch (_) {}
      }
      native?.stopPTT?.(text || '');
      // Process the transcript
      if (text) {
        handleTranscript(text, {
          activeQuestion: pendingQuestion,
          activeBuildContext: pendingBuildContext,
          activeTriangleContext: pendingTriangleContext
        });
      } else if (pendingQuestion?.onboarding) {
        reportOnboardingSTTFailure('empty-transcript', pendingQuestion);
      } else if (pendingAudioAsset) {
        native?.addVoiceEntry?.({
          title: 'voice note',
          body: 'audio note captured',
          source: 'voice',
          entry_mode: 'audio-fallback'
        });
      }
    }

    // Unmute heartbeat after capture
    if (window.StructaAudio) window.StructaAudio.unmute();

    setStatus('idle');
    close();
  }

  /**
   * setQuestionContext — called from cascade when user wants to answer a question.
   * Stores the question so handleTranscript knows to route it as an answer.
   */
  function setQuestionContext(index, questionText, meta) {
    if (typeof index === 'object' && index) {
      activeQuestion = {
        index: typeof index.index === 'number' ? index.index : -1,
        text: index.text || '',
        onboarding: !!index.onboarding,
        nodeId: index.nodeId || '',
        source: index.source || 'question'
      };
      native?.traceEvent?.('voice', 'idle', 'question-context', {
        nodeId: activeQuestion.nodeId || '',
        text: activeQuestion.text || '',
        onboarding: !!activeQuestion.onboarding
      });
      voiceTarget = 'question-answer';
      return;
    }
    activeQuestion = {
      index: index,
      text: questionText,
      onboarding: !!(meta && meta.onboarding),
      nodeId: meta && meta.nodeId ? meta.nodeId : '',
      source: meta && meta.source ? meta.source : 'question'
    };
    native?.traceEvent?.('voice', 'idle', 'question-context', {
      nodeId: activeQuestion.nodeId || '',
      text: activeQuestion.text || '',
      onboarding: !!activeQuestion.onboarding
    });
    voiceTarget = 'question-answer';
  }

  function setBuildContext(context) {
    activeBuildContext = context ? {
      kind: context.kind || 'context',
      nodeId: context.nodeId || '',
      text: String(context.text || '').trim(),
      surface: context.surface || 'tell',
      title: context.title || '',
      createdAt: context.createdAt || '',
      commentKind: context.commentKind || 'comment',
      projectSummary: context.projectSummary || ''
    } : null;
    if (activeBuildContext && !activeQuestion) voiceTarget = 'tell';
  }

  function setTriangleContext(context) {
    activeTriangleContext = context ? {
      label: String(context.label || 'your angle')
    } : null;
    if (activeTriangleContext) voiceTarget = 'triangle';
  }

  async function startListening() {
    if (listening) return;

    // Don't interfere with camera PTT
    if (window.__STRUCTA_PTT_TARGET__ === 'camera') {
      hideOverlay();
      setStatus('idle');
      return;
    }

    showOverlay();
    if (!inlineMode()) {
      overlay?.classList.add('listening');
      if (wave) wave.hidden = false;
    }
    if (transcriptEl) transcriptEl.textContent = '';
    audioChunks = [];
    pendingAudioAsset = null;
    listening = true;
    voiceTarget = activeQuestion ? 'question-answer' : (activeTriangleContext ? 'triangle' : 'tell');
    native?.traceEvent?.('voice', 'idle', 'listening', {
      target: voiceTarget || '',
      questionNodeId: activeQuestion?.nodeId || '',
      buildNodeId: activeBuildContext?.nodeId || ''
    });
    setStatus('listening');

    // Mute heartbeat and initialize audio without breaking the current mute policy.
    if (window.StructaAudio) {
      window.StructaAudio.mute();
      window.StructaAudio.init();
      window.StructaFeedback?.fire?.('voice-open');
    }

    // Show context-specific status
    if (activeQuestion) {
      setStatus('answer mode');
    } else if (activeTriangleContext) {
      setStatus('triangle angle');
    } else if (activeBuildContext && activeBuildContext.kind === 'thread-comment') {
      setStatus('commenting');
    } else if (activeBuildContext && activeBuildContext.text) {
      setStatus('building ' + (activeBuildContext.surface || 'context'));
    }

    // Tell R1 OS we started talking
    native?.startPTT?.();

    // === R1 path: Use CreationVoiceHandler for native STT ===
    if (typeof CreationVoiceHandler !== 'undefined') {
      try {
        CreationVoiceHandler.postMessage('start');
        if (activeQuestion?.onboarding) {
          clearOnboardingStartTimer();
          onboardingStartTimer = setTimeout(function() {
            onboardingStartTimer = null;
            if (!listening) return;
            var heard = (transcriptEl && transcriptEl.textContent || '').trim();
            if (!heard) reportOnboardingSTTFailure('start-timeout');
          }, 800);
        }
        return;
      } catch (err) {
        native?.appendLogEntry?.({ kind: 'voice', message: 'stt err: ' + (err?.message || 'failed') });
        if (activeQuestion?.onboarding) reportOnboardingSTTFailure('bridge-error');
      }
    }

    // === Browser fallback path ===
    if (!SR) {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setStatus('mic unavailable');
        listening = false;
        if (activeQuestion?.onboarding) reportOnboardingSTTFailure('mic-unavailable');
        return;
      }
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var preferredMime = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg'
        ].find(function(type) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type); });
        audioRecorder = preferredMime ? new MediaRecorder(audioStream, { mimeType: preferredMime }) : new MediaRecorder(audioStream);
        audioRecorder.ondataavailable = function(event) {
          if (event.data && event.data.size) audioChunks.push(event.data);
        };
        audioRecorder.onstop = function() {
          // Audio fallback — store raw audio as asset
          if (audioChunks.length && native?.storeAsset) {
            var blob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
            var reader = new FileReader();
            reader.onload = function() {
              native?.storeAsset({
                kind: 'audio',
                name: 'voice-' + Date.now() + '.webm',
                mime_type: audioRecorder.mimeType || 'audio/webm',
                data: reader.result
              });
            };
            reader.readAsDataURL(blob);
          }
          audioRecorder = null;
        };
        audioRecorder.start();
        return;
      } catch (_) {
        setStatus('mic unavailable');
        listening = false;
        overlay?.classList.remove('listening');
        if (wave) wave.hidden = true;
        if (activeQuestion?.onboarding) reportOnboardingSTTFailure('mic-unavailable');
        return;
      }
    }

    // === Desktop browser: SpeechRecognition ===
    if (!recognition) {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onresult = function(event) {
        var finalText = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var part = (event.results[i][0] && event.results[i][0].transcript) || '';
          if (event.results[i].isFinal) finalText += part;
          else if (transcriptEl && !transcriptEl.textContent) transcriptEl.textContent = part;
        }
        if (finalText && transcriptEl) transcriptEl.textContent = ((transcriptEl.textContent || '') + ' ' + finalText).trim();
      };
      recognition.onerror = function() { setStatus('mic error'); };
      recognition.onend = function() {
        if (listening && !(transcriptEl && transcriptEl.textContent && transcriptEl.textContent.trim())) setStatus('ready');
      };
    }

    try { recognition.start(); } catch (_) {
      setStatus('mic unavailable');
      listening = false;
      overlay?.classList.remove('listening');
      if (wave) wave.hidden = true;
      if (activeQuestion?.onboarding) reportOnboardingSTTFailure('mic-unavailable');
    }
  }

  // Listen for STT transcript from R1 native bridge.
  window.addEventListener('structa-stt-ended', function(event) {
    var data = event && event.detail;
    clearOnboardingStartTimer();
    if (data && data.transcript) {
      if (transcriptEl) transcriptEl.textContent = data.transcript;
      handleTranscript(data.transcript);
      stopListening(false);
    } else if (activeQuestion?.onboarding) {
      reportOnboardingSTTFailure('empty-transcript');
    }
  });

  function open() {
    showOverlay();
    setStatus('ready');
  }

  function close() {
    if (listening) {
      stopListening(false);
    }
    activeTriangleContext = null;
    setContextLabel('');
    hideOverlay();
  }

  overlay?.addEventListener('pointerup', function(event) {
    event.preventDefault();
    if (listening) {
      stopListening(true);
      return;
    }
    close();
  });

  overlay?.addEventListener('pointercancel', function() {
    if (listening) stopListening(false);
  });

  var cleanupOnHide = function() {
    if (document.hidden || overlay?.classList.contains('open')) close();
  };

  window.addEventListener('pagehide', cleanupOnHide);
  document.addEventListener('visibilitychange', cleanupOnHide);

  window.StructaVoice = Object.freeze({
    open: open,
    close: close,
    startListening: startListening,
    stopListening: stopListening,
    setQuestionContext: setQuestionContext,
    setBuildContext: setBuildContext,
    setTriangleContext: setTriangleContext,
    setContextLabel: setContextLabel,
    get listening() { return listening; },
    get activeQuestion() { return activeQuestion; }
  });
})();
