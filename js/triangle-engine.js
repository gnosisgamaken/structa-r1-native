(() => {
  'use strict';

  const native = window.StructaNative;
  const queue = window.StructaProcessingQueue;
  const contracts = window.StructaContracts;

  function getLLM() {
    return window.StructaLLM;
  }

  let mode = 'empty';
  let armed = null;
  let pair = null;
  let status = '';
  let lastError = '';
  let queuedJobId = '';
  const LEGAL_TRANSITIONS = Object.freeze({
    empty: ['armed'],
    armed: ['empty', 'synthesizing'],
    synthesizing: ['empty', 'armed', 'resolved', 'ambiguous'],
    ambiguous: ['empty'],
    resolved: ['empty']
  });

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (_) {}
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function traceTriangle(from, to, ctx) {
    native?.traceEvent?.('triangle', from, to, Object.assign({
      mode: mode,
      status: status,
      jobId: queuedJobId || ''
    }, ctx || {}));
  }

  function transitionState(nextMode, ctx) {
    const from = mode;
    if (from !== nextMode) {
      const legal = LEGAL_TRANSITIONS[from] || [];
      if (legal.indexOf(nextMode) === -1) {
        const detail = Object.assign({ from: from, to: nextMode }, ctx || {});
        traceTriangle(from, 'illegal-transition', detail);
        const devMode = !!(window.location.hash.includes('probe') || new URLSearchParams(window.location.search || '').get('debug') === '1');
        if (devMode) {
          throw new Error('illegal triangle transition: ' + from + ' → ' + nextMode);
        }
        return getState();
      }
    }
    mode = nextMode;
    traceTriangle(from, nextMode, ctx);
    persistArmed();
    return getState();
  }

  function persistArmed() {
    if (!native?.setTriangleSlot) return;
    if (mode === 'armed' && armed) {
      native.setTriangleSlot({
        mode: 'armed',
        armed: true,
        item: clone(armed),
        armedAt: armed.armedAt || nowIso()
      });
      return;
    }
    if (mode === 'synthesizing' && pair?.a && pair?.b) {
      native.setTriangleSlot({
        mode: 'synthesizing',
        armed: false,
        item: clone(pair.a),
        pair: clone(pair),
        jobId: queuedJobId || '',
        status: status || 'synthesizing'
      });
      return;
    }
    native.clearTriangleSlot?.();
  }

  function itemKey(item) {
    if (!item) return '';
    return [item.type || '', item.id || ''].join(':');
  }

  function itemMatches(a, b) {
    return !!(a && b && a.type === b.type && a.id === b.id);
  }

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function activeProjectId() {
    return native?.getActiveProjectId?.() || native?.getProjectMemory?.()?.project_id || '';
  }

  function getMemory() {
    return native?.getMemory?.() || {};
  }

  function getProject(projectId) {
    const memory = getMemory();
    const projects = Array.isArray(memory.projects) ? memory.projects : [];
    if (projectId) {
      const found = projects.find(function(entry) { return entry.project_id === projectId; });
      if (found) return found;
    }
    return native?.getProjectMemory?.() || memory.projectMemory || null;
  }

  function getClaimsForTriangleItem(item) {
    if (!item?.id || !native?.getClaimsForItem) return [];
    return (native.getClaimsForItem(item.id) || []).filter(function(entry) {
      var statusValue = String(entry?.status || 'active').toLowerCase();
      return statusValue === 'active' || statusValue === 'disputed';
    });
  }

  function deriveTriangleBranchContext(claimsA, claimsB) {
    var branchIds = []
      .concat((claimsA || []).map(function(entry) { return String(entry?.branchId || 'main'); }))
      .concat((claimsB || []).map(function(entry) { return String(entry?.branchId || 'main'); }))
      .filter(Boolean);
    var primary = branchIds[0] || 'main';
    var sameBranch = branchIds.every(function(branchId) { return branchId === primary; });
    return {
      id: sameBranch ? primary : 'main',
      name: sameBranch ? primary : 'spanning',
      parentBranchId: sameBranch ? '' : 'main'
    };
  }

  function buildTriangleInput(localPair, spoken) {
    var claimsA = getClaimsForTriangleItem(localPair?.a);
    var claimsB = getClaimsForTriangleItem(localPair?.b);
    var branchContext = deriveTriangleBranchContext(claimsA, claimsB);
    var payload = {
      projectId: activeProjectId(),
      itemA: {
        itemId: localPair?.a?.id || '',
        claimIds: claimsA.map(function(entry) { return entry.id; }),
        claims: claimsA.map(function(entry) {
          return {
            id: entry.id,
            text: entry.text,
            kind: entry.kind,
            status: entry.status,
            branchId: entry.branchId,
            confidence: entry.confidence
          };
        })
      },
      itemB: {
        itemId: localPair?.b?.id || '',
        claimIds: claimsB.map(function(entry) { return entry.id; }),
        claims: claimsB.map(function(entry) {
          return {
            id: entry.id,
            text: entry.text,
            kind: entry.kind,
            status: entry.status,
            branchId: entry.branchId,
            confidence: entry.confidence
          };
        })
      },
      angle: {
        text: spoken,
        sttConfidence: null
      },
      branchContext: branchContext,
      parentClaimIds: claimsA.map(function(entry) { return entry.id; }).concat(claimsB.map(function(entry) { return entry.id; }))
    };
    native?.traceEvent?.('triangle.input.built', 'pair', 'ready', {
      projectId: payload.projectId,
      claimsACount: payload.itemA.claimIds.length,
      claimsBCount: payload.itemB.claimIds.length,
      angleLength: spoken.length
    });
    return payload;
  }

  function traceTriangleValidationErrors(errors) {
    (errors || []).forEach(function(error) {
      if (error?.code === 'no_evidence' || error?.code === 'weak_evidence') {
        native?.traceEvent?.('triangle.synth.reject.no_evidence', error?.nodeKind || '', error?.nodeId || '', {
          nodeKind: error?.nodeKind || '',
          nodeId: error?.nodeId || ''
        });
        return;
      }
      if (error?.code === 'orphan_evidence' || error?.code === 'inactive_evidence' || error?.code === 'parent_evidence_mismatch') {
        native?.traceEvent?.('triangle.synth.reject.orphan_evidence', error?.nodeId || '', error?.missingRef || error?.ref || '', {
          nodeId: error?.nodeId || '',
          missingRef: error?.missingRef || error?.ref || ''
        });
      }
    });
  }

  function getCaptureItem(project, item) {
    const captures = []
      .concat(Array.isArray(project?.captures) ? project.captures : [])
      .concat(Array.isArray(getMemory().captures) ? getMemory().captures : []);
    return captures.find(function(entry) {
      const key = entry?.entry_id || entry?.id || entry?.node_id || '';
      return key === item.id;
    }) || null;
  }

  function getVoiceItem(project, item) {
    const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
    return nodes.find(function(entry) {
      return entry?.type === 'voice-entry' && (entry.node_id === item.id || entry.entry_id === item.id);
    }) || null;
  }

  function getKnowItem(project, item) {
    const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
    return nodes.find(function(entry) {
      return entry?.node_id === item.id;
    }) || null;
  }

  function getNowItem(project, item) {
    const pending = Array.isArray(project?.pending_decisions) ? project.pending_decisions : [];
    const decisions = Array.isArray(project?.decisions) ? project.decisions : [];
    const questions = Array.isArray(project?.open_questions) ? project.open_questions : [];
    if (item.nowType === 'decision') {
      return pending.find(function(entry) {
        return (entry?.node_id || '') === item.id || lower(entry?.text || entry) === lower(item.body || '');
      }) || decisions.find(function(entry) {
        return (entry?.node_id || '') === item.id || lower(entry?.text || entry?.title || entry) === lower(item.body || '');
      }) || null;
    }
    return questions.find(function(entry) { return lower(entry) === lower(item.body || ''); }) || null;
  }

  function resolveLiveItem(item) {
    if (!item) return null;
    const project = getProject(item.project_id);
    if (!project) return null;
    switch (item.type) {
      case 'show':
        return getCaptureItem(project, item);
      case 'tell':
        return getVoiceItem(project, item);
      case 'know':
        return getKnowItem(project, item);
      case 'now':
        return getNowItem(project, item);
      default:
        return null;
    }
  }

  function validateOrClear() {
    if (mode === 'armed' && armed && !resolveLiveItem(armed)) {
      armed = null;
      pair = null;
      mode = 'empty';
      status = '';
      lastError = '';
      persistArmed();
      emit('structa-triangle-cleared', {
        reason: 'source removed'
      });
    }
    return getState();
  }

  function getImageData(item) {
    if (!item) return '';
    const preview = item.previewData || item.imageHref || item.summary?.imageHref || '';
    return typeof preview === 'string' ? preview : '';
  }

  function describeForTriangle(item) {
    if (!item) {
      return {
        type: 'context',
        time: 'recent',
        body: 'no context',
        hasImage: false,
        imageData: ''
      };
    }
    switch (item.type) {
      case 'show':
        return {
          type: 'visual capture',
          time: item.timeLabel || 'recent',
          body: item.body || item.summary || 'unanalyzed frame',
          hasImage: !!getImageData(item),
          imageData: getImageData(item)
        };
      case 'tell':
        return {
          type: 'voice note',
          time: item.timeLabel || 'recent',
          body: item.body || item.summary || 'voice note',
          hasImage: false,
          imageData: ''
        };
      case 'know':
        return {
          type: item.knowType || 'signal',
          time: item.timeLabel || 'recent',
          body: item.body || item.summary || item.title || 'signal',
          hasImage: false,
          imageData: ''
        };
      case 'now':
        return {
          type: item.nowType === 'question' ? 'blocker' : 'decision',
          time: item.timeLabel || 'recent',
          body: item.body || item.summary || item.title || 'decision',
          hasImage: false,
          imageData: ''
        };
      default:
        return {
          type: 'context',
          time: item.timeLabel || 'recent',
          body: item.body || item.summary || item.title || 'context',
          hasImage: false,
          imageData: ''
        };
    }
  }

  function buildProjectEnvelope() {
    const project = native?.getProjectMemory?.() || {};
    return {
      id: project.project_id || project.id || '',
      name: project.name || 'untitled project',
      type: project.type || 'general',
      brief: project.brief || '',
      topQuestions: (project.open_questions || []).slice(0, 3),
      selectedSurface: 'triangle',
      summary: [
        project.name ? 'project: ' + project.name : '',
        project.brief ? 'brief: ' + project.brief : '',
        (project.open_questions || []).length ? 'top questions: ' + project.open_questions.slice(0, 3).join('; ') : ''
      ].filter(Boolean).join('\n')
    };
  }

  function updateLinks(signalNodeId, a, b, questionNodeId) {
    if (!native?.touchProjectMemory || (!signalNodeId && !questionNodeId)) return;
    native.touchProjectMemory(function(project) {
      const nodes = Array.isArray(project.nodes) ? project.nodes : [];
      const targetNodes = [signalNodeId, questionNodeId].map(function(nodeId) {
        return nodes.find(function(entry) { return entry.node_id === nodeId; }) || null;
      }).filter(Boolean);
      if (!targetNodes.length) return;
      [a, b].forEach(function(item) {
        const nodeId = item?.nodeId || item?.id || '';
        if (!nodeId) return;
        const sourceNode = nodes.find(function(entry) { return entry.node_id === nodeId; });
        if (!sourceNode) return;
        sourceNode.links = Array.isArray(sourceNode.links) ? sourceNode.links : [];
        targetNodes.forEach(function(targetNode) {
          targetNode.links = Array.isArray(targetNode.links) ? targetNode.links : [];
          if (sourceNode.links.indexOf(targetNode.node_id) === -1) sourceNode.links.push(targetNode.node_id);
          if (targetNode.links.indexOf(sourceNode.node_id) === -1) targetNode.links.push(sourceNode.node_id);
        });
      });
      if (signalNodeId && questionNodeId) {
        const signalNode = nodes.find(function(entry) { return entry.node_id === signalNodeId; });
        const questionNode = nodes.find(function(entry) { return entry.node_id === questionNodeId; });
        if (signalNode && questionNode) {
          questionNode.links = Array.isArray(questionNode.links) ? questionNode.links : [];
          signalNode.links = Array.isArray(signalNode.links) ? signalNode.links : [];
          if (questionNode.links.indexOf(signalNode.node_id) === -1) questionNode.links.push(signalNode.node_id);
          if (signalNode.links.indexOf(questionNode.node_id) === -1) signalNode.links.push(questionNode.node_id);
        }
      }
    });
  }

  function clearRuntimeState() {
    const from = mode;
    mode = 'empty';
    armed = null;
    pair = null;
    status = '';
    lastError = '';
    queuedJobId = '';
    persistArmed();
    traceTriangle(from, 'empty', { reason: 'clear-runtime' });
  }

  function getState() {
    return {
      mode: mode,
      item: clone(armed),
      pair: clone(pair),
      status: status,
      lastError: lastError
    };
  }

  function copy(item) {
    if (!item) return getState();
    armed = clone(item);
    armed.armedAt = nowIso();
    pair = null;
    status = 'armed';
    lastError = '';
    transitionState('armed', {
      reason: 'copy',
      itemId: item?.id || '',
      itemType: item?.type || ''
    });
    emit('structa-triangle-copied', {
      item: clone(armed)
    });
    return getState();
  }

  function dismiss() {
    if (queuedJobId && queue?.cancel) queue.cancel(queuedJobId);
    traceTriangle(mode, 'empty', { reason: 'dismiss' });
    clearRuntimeState();
    emit('structa-triangle-dismissed', {});
    return getState();
  }

  function complete(item, meta) {
    if (!item) return getState();
    if (mode !== 'armed' || !armed) return copy(item);
    if (itemMatches(armed, item)) return dismiss();
    pair = {
      a: clone(armed),
      b: clone(item),
      origin: clone(meta || {})
    };
    status = 'waiting-angle';
    lastError = '';
    transitionState('synthesizing', {
      reason: 'pair-complete',
      itemA: pair?.a?.id || '',
      itemB: pair?.b?.id || ''
    });
    emit('structa-triangle-synthesizing', {
      pair: clone(pair)
    });
    return getState();
  }

  function cancel() {
    if (queuedJobId && queue?.cancel) queue.cancel(queuedJobId);
    if (armed) {
      pair = null;
      status = 'armed';
      lastError = '';
      queuedJobId = '';
      transitionState('armed', { reason: 'cancel-to-armed', itemId: armed?.id || '' });
      emit('structa-triangle-cancelled', {
        item: clone(armed)
      });
      return getState();
    }
    return dismiss();
  }

  function submit(transcript) {
    const spoken = String(transcript || '').trim();
    if (!spoken) {
      lastError = 'no angle heard — hold ptt again';
      status = 'retry';
      traceTriangle('synthesizing', 'retry', { reason: 'empty-angle' });
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }
    if (mode !== 'synthesizing' || !pair?.a || !pair?.b) {
      lastError = 'triangle not ready';
      return Promise.resolve({ ok: false, error: lastError });
    }
    status = 'synthesizing';
    lastError = '';
    traceTriangle('synthesizing', 'submitting', {
      reason: 'angle-submitted',
      angle: spoken
    });
    emit('structa-triangle-submitting', {
      pair: clone(pair),
      angle: spoken
    });

    const triangleInput = buildTriangleInput(pair, spoken);
    if (!triangleInput.itemA.claimIds.length || !triangleInput.itemB.claimIds.length) {
      var side = !triangleInput.itemA.claimIds.length ? 'A' : 'B';
      lastError = 'not enough to triangulate — capture more first';
      status = 'retry';
      native?.traceEvent?.('triangle.input.rejected_empty', side, 'empty', {
        side: side
      });
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      window.StructaFeedback?.fire?.('blocked');
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }

    const payload = {
      pair: clone(pair),
      angle: spoken,
      triangleInput: triangleInput
    };
    if (!queue) {
      return runTriangleSynthesis(payload);
    }
    const jobId = queue.enqueue({
      kind: 'triangle-synthesize',
      priority: 'P0',
      payload: payload,
      origin: {
        screen: 'triangle',
        itemId: itemKey(pair.a) + '|' + itemKey(pair.b)
      },
      timeoutMs: 8000
    });
    queuedJobId = jobId;
    persistArmed();
    traceTriangle('submitting', 'queued', { jobId: jobId });
    return Promise.resolve({ ok: true, queued: true, jobId: jobId });
  }

  function runTriangleSynthesis(payload) {
    const localPair = payload?.pair || {};
    const spoken = String(payload?.angle || '').trim();
    if (!localPair?.a || !localPair?.b || !spoken) {
      lastError = 'synthesis failed — try again';
      status = 'retry';
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }

    const triangleInput = payload?.triangleInput || buildTriangleInput(localPair, spoken);
    if (!triangleInput.itemA.claimIds.length || !triangleInput.itemB.claimIds.length) {
      lastError = 'not enough to triangulate — capture more first';
      status = 'retry';
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }

    const llm = getLLM();
    const orchestrator = window.StructaOrchestrator;
    if (!llm?.executePreparedLLM || !orchestrator?.synthesizeTriangle) {
      lastError = 'synthesis unavailable — try again';
      status = 'retry';
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }

    return orchestrator.synthesizeTriangle({
      project: buildProjectEnvelope(),
      itemA: triangleInput.itemA,
      itemB: triangleInput.itemB,
      angle: triangleInput.angle,
      branchContext: triangleInput.branchContext,
      policy: {
        priority: 'high',
        allowSearch: false,
        allowSpeech: false
      }
    }, llm.executePreparedLLM).then(function(result) {
      if (!result || !result.ok) {
        lastError = 'synthesis failed — try again';
        status = 'retry';
        emit('structa-triangle-failed', { message: lastError, recoverable: true });
        return { ok: false, error: lastError, recoverable: true };
      }

      const triangleVerdict = contracts?.validateTriangleOutput
        ? contracts.validateTriangleOutput(result, {
            project: native?.getProjectMemory?.() || {},
            parentEvidenceIds: triangleInput.parentClaimIds || []
          })
        : { ok: true, value: result, errors: [] };
      if (!triangleVerdict.ok) {
        traceTriangleValidationErrors(triangleVerdict.errors || []);
        clearRuntimeState();
        return { ok: false, error: 'triangle rejected', recoverable: false, silent: true };
      }

      const validated = triangleVerdict.value || {};
      const origin = clone(localPair.origin || {});

      if (validated.status === 'ambiguous') {
        const questionNode = native?.addNode?.({
          type: 'question',
          status: 'open',
          title: 'triangle follow up',
          body: validated.question?.body || 'which connection matters most here?',
          source: 'triangle',
          tags: ['triangle'],
          meta: {
            triangulated: true,
            reasoning_generated: true,
            evidence_claims: validated.question?.meta?.evidence_claims || [],
            rationale: validated.question?.meta?.rationale || '',
            branch_id: validated.question?.meta?.branch_id || triangleInput.branchContext?.id || 'main',
            triangle_inputs: {
              a: { type: localPair.a.type, id: localPair.a.id },
              b: { type: localPair.b.type, id: localPair.b.id },
              angle: spoken
            }
          }
        });
        transitionState('ambiguous', {
          reason: 'server-ambiguous',
          questionId: questionNode?.node_id || ''
        });
        native?.traceEvent?.('triangle.synth.ambiguous', 'triangle', questionNode?.node_id || '', {
          questionId: questionNode?.node_id || ''
        });
        updateLinks('', localPair.a, localPair.b, questionNode?.node_id || '');
        clearRuntimeState();
        emit('structa-triangle-ambiguous', {
          question: validated.question?.body || '',
          questionNode: clone(questionNode),
          origin: origin
        });
        return {
          ok: true,
          ambiguous: true,
          questionNode: questionNode,
          origin: origin
        };
      }

      const signalNode = native?.addNode?.({
        type: 'insight',
        status: 'open',
        title: validated.title || 'triangle signal',
        body: '',
        source: 'triangle',
        tags: ['triangle'],
        meta: {
          triangulated: true,
          triangle_format: 'claims-v1',
          triangle_inputs: {
            a: { type: localPair.a.type, id: localPair.a.id },
            b: { type: localPair.b.type, id: localPair.b.id },
            angle: spoken
          },
          triangle_tensions: Array.isArray(validated.unresolved_tensions) ? clone(validated.unresolved_tensions) : []
        }
      });

      let claimEntries = [];
      if (Array.isArray(validated.derived_claims) && validated.derived_claims.length && native?.ingestClaims) {
        claimEntries = native.ingestClaims(validated.derived_claims, {
          source: 'triangle',
          branchId: validated.branchId || triangleInput.branchContext?.id || 'main',
          sourceRef: {
            itemId: signalNode?.node_id || '',
            triangleJobId: payload?.jobId || ''
          }
        });
        if (claimEntries?.length && signalNode?.node_id && native?.touchProjectMemory) {
          native.touchProjectMemory(function(project) {
            const signal = (project.nodes || []).find(function(entry) { return entry.node_id === signalNode.node_id; });
            if (!signal) return;
            signal.meta = {
              ...(signal.meta || {}),
              claim_ids: claimEntries.map(function(entry) { return entry.id; }),
              triangle_tensions: Array.isArray(validated.unresolved_tensions) ? clone(validated.unresolved_tensions) : []
            };
          });
        }
      }

      updateLinks(signalNode?.node_id || '', localPair.a, localPair.b, '');
      transitionState('resolved', {
        reason: 'server-synthesized',
        signalId: signalNode?.node_id || ''
      });
      native?.traceEvent?.('triangle.synth.resolved', 'triangle', signalNode?.node_id || '', {
        signalId: signalNode?.node_id || '',
        derivedClaimCount: claimEntries.length,
        tensionCount: Array.isArray(validated.unresolved_tensions) ? validated.unresolved_tensions.length : 0
      });
      clearRuntimeState();
      window.StructaFeedback?.fire?.('resolve');
      window.StructaLLM?.speakMilestone?.('triangle_captured');
      emit('structa-triangle-result', {
        title: validated.title || 'triangle signal',
        signalNode: clone(signalNode),
        derivedClaims: clone(claimEntries),
        tensions: clone(validated.unresolved_tensions || []),
        origin: origin
      });
      return {
        ok: true,
        title: validated.title || 'triangle signal',
        signalNode: signalNode,
        derivedClaims: claimEntries,
        tensions: validated.unresolved_tensions || [],
        origin: origin
      };
    }).catch(function() {
      lastError = 'synthesis failed — try again';
      status = 'retry';
      traceTriangle('synthesizing', 'failed', { reason: 'exception' });
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return { ok: false, error: lastError, recoverable: true };
    });
  }

  if (queue && !window.__STRUCTA_TRIANGLE_QUEUE_REGISTERED__) {
    window.__STRUCTA_TRIANGLE_QUEUE_REGISTERED__ = true;
    queue.registerHandler('triangle-synthesize', function(job) {
      return runTriangleSynthesis(Object.assign({}, job.payload || {}, { jobId: job.id || '' })).then(function(result) {
        if (!result || !result.ok) {
          clearRuntimeState();
          if (result?.recoverable) {
            return {
              ok: false,
              blocked: true,
              message: 'synthesis stalled — tap to retry, double side skips'
            };
          }
          return result || { ok: false, error: 'triangle rejected' };
        }
        return result;
      }).catch(function() {
        clearRuntimeState();
        return {
          ok: false,
          blocked: true,
          message: 'synthesis stalled — tap to retry, double side skips'
        };
      });
    });
  }

  function init() {
    const slot = native?.getTriangleSlot?.();
    if (slot?.mode === 'synthesizing' && slot?.pair?.a && slot?.pair?.b) {
      const existingJob = queue?.snapshot?.().find(function(job) { return job.id === slot.jobId; });
      if (existingJob && existingJob.status !== 'blocked') {
        mode = 'synthesizing';
        armed = clone(slot.item || slot.pair.a);
        pair = clone(slot.pair);
        status = slot.status || 'synthesizing';
        lastError = '';
        queuedJobId = slot.jobId || '';
        traceTriangle('boot', 'rehydrated-synth', { jobId: queuedJobId });
      } else if (slot.item) {
        mode = 'armed';
        armed = clone(slot.item);
        pair = null;
        status = 'armed';
        lastError = '';
        queuedJobId = '';
        traceTriangle('boot', 'rehydrated-armed', { itemId: armed?.id || '' });
      } else {
        clearRuntimeState();
      }
    } else if (slot && slot.armed && slot.item) {
      mode = 'armed';
      armed = clone(slot.item);
      pair = null;
      status = 'armed';
      lastError = '';
      queuedJobId = '';
      traceTriangle('boot', 'rehydrated-armed', { itemId: armed?.id || '' });
    } else {
      clearRuntimeState();
    }
    validateOrClear();
    return getState();
  }

  window.StructaTriangle = Object.freeze({
    init: init,
    getState: getState,
    validateOrClear: validateOrClear,
    copy: copy,
    dismiss: dismiss,
    complete: complete,
    cancel: cancel,
    submit: submit,
    clearAll: dismiss,
    itemMatches: itemMatches
  });

  init();
})();
