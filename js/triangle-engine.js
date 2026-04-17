(() => {
  'use strict';

  const native = window.StructaNative;

  function getLLM() {
    return window.StructaLLM;
  }

  let mode = 'empty';
  let armed = null;
  let pair = null;
  let status = '';
  let lastError = '';

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

  function persistArmed() {
    if (!native?.setTriangleSlot) return;
    if (mode === 'armed' && armed) {
      native.setTriangleSlot({
        armed: true,
        item: clone(armed),
        armedAt: armed.armedAt || nowIso()
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

  function buildPrompt(a, b, transcript) {
    const project = native?.getProjectMemory?.() || {};
    const questions = (project.open_questions || []).slice(0, 3).join('; ');
    const crossProject = a.project_id && b.project_id && a.project_id !== b.project_id;
    const header = crossProject ? 'CROSS-PROJECT NOTE\n\n' : '';
    return header +
      'You are Structa, a precision tool for extracting derived insight.\n' +
      'The user has triangulated three inputs and is asking you to synthesize them into ONE sharp signal.\n\n' +
      'PROJECT CONTEXT\n' +
      'Name: ' + (project.name || 'untitled project') + '\n' +
      'Brief: ' + (project.brief || 'no brief') + '\n' +
      'Open questions: ' + (questions || 'none') + '\n\n' +
      'POINT A — ' + a.type + ' captured ' + a.time + '\n' +
      a.body + '\n\n' +
      'POINT B — ' + b.type + ' captured ' + b.time + '\n' +
      b.body + '\n\n' +
      'ANGLE — the user perspective, just spoken:\n' +
      '"' + transcript + '"\n\n' +
      'YOUR TASK\n' +
      'Produce a single derived insight that:\n' +
      '1. Treats POINT A and POINT B as related evidence.\n' +
      '2. Filters them through the user ANGLE — the angle is the lens, not optional context.\n' +
      '3. States the synthesis in ONE sentence (max 18 words).\n' +
      '4. Optionally adds ONE follow-up question if the synthesis exposes a gap (max 12 words).\n\n' +
      'DO NOT\n' +
      '- Repeat the inputs back.\n' +
      '- Hedge.\n' +
      '- Use markdown, emoji, or quotes around the output.\n' +
      '- Search the web. Use only what is given.\n\n' +
      'OUTPUT FORMAT (strict)\n' +
      'SIGNAL: <one sentence>\n' +
      'QUESTION: <one question, or omit line entirely>';
  }

  function parseSynthesis(text) {
    const clean = String(text || '').trim();
    const signalMatch = clean.match(/SIGNAL:\s*(.+)/i);
    const questionMatch = clean.match(/QUESTION:\s*(.+)/i);
    const signal = (signalMatch && signalMatch[1] ? signalMatch[1] : clean.split(/\n+/)[0] || '').trim();
    const question = (questionMatch && questionMatch[1] ? questionMatch[1] : '').trim();
    return {
      signal: signal.replace(/^["']|["']$/g, ''),
      question: question.replace(/^["']|["']$/g, '')
    };
  }

  function updateLinks(signalNodeId, a, b, questionNodeId) {
    if (!native?.touchProjectMemory || !signalNodeId) return;
    native.touchProjectMemory(function(project) {
      const nodes = Array.isArray(project.nodes) ? project.nodes : [];
      const signalNode = nodes.find(function(entry) { return entry.node_id === signalNodeId; });
      if (!signalNode) return;
      signalNode.links = Array.isArray(signalNode.links) ? signalNode.links : [];
      [a, b].forEach(function(item) {
        const nodeId = item?.nodeId || item?.id || '';
        if (!nodeId) return;
        const sourceNode = nodes.find(function(entry) { return entry.node_id === nodeId; });
        if (!sourceNode) return;
        sourceNode.links = Array.isArray(sourceNode.links) ? sourceNode.links : [];
        if (sourceNode.links.indexOf(signalNode.node_id) === -1) sourceNode.links.push(signalNode.node_id);
        if (signalNode.links.indexOf(sourceNode.node_id) === -1) signalNode.links.push(sourceNode.node_id);
      });
      if (questionNodeId) {
        const questionNode = nodes.find(function(entry) { return entry.node_id === questionNodeId; });
        if (questionNode) {
          questionNode.links = Array.isArray(questionNode.links) ? questionNode.links : [];
          if (questionNode.links.indexOf(signalNode.node_id) === -1) questionNode.links.push(signalNode.node_id);
          if (signalNode.links.indexOf(questionNode.node_id) === -1) signalNode.links.push(questionNode.node_id);
        }
      }
    });
  }

  function clearRuntimeState() {
    mode = 'empty';
    armed = null;
    pair = null;
    status = '';
    lastError = '';
    persistArmed();
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
    mode = 'armed';
    status = 'armed';
    lastError = '';
    persistArmed();
    emit('structa-triangle-copied', {
      item: clone(armed)
    });
    return getState();
  }

  function dismiss() {
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
    mode = 'synthesizing';
    status = 'waiting-angle';
    lastError = '';
    emit('structa-triangle-synthesizing', {
      pair: clone(pair)
    });
    return getState();
  }

  function cancel() {
    if (armed) {
      mode = 'armed';
      pair = null;
      status = 'armed';
      lastError = '';
      persistArmed();
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
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }
    if (mode !== 'synthesizing' || !pair?.a || !pair?.b) {
      lastError = 'triangle not ready';
      return Promise.resolve({ ok: false, error: lastError });
    }
    status = 'synthesizing';
    lastError = '';
    emit('structa-triangle-submitting', {
      pair: clone(pair),
      angle: spoken
    });

    const pointA = describeForTriangle(pair.a);
    const pointB = describeForTriangle(pair.b);
    const prompt = buildPrompt(pointA, pointB, spoken);
    const imageData = pointB.hasImage ? pointB.imageData : (pointA.hasImage ? pointA.imageData : '');
    const imageBase64 = /^data:image\/\w+;base64,/i.test(imageData)
      ? imageData.replace(/^data:image\/\w+;base64,/, '')
      : '';

    const llm = getLLM();
    if (!llm?.sendToLLM) {
      lastError = 'synthesis unavailable — try again';
      status = 'retry';
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return Promise.resolve({ ok: false, error: lastError, recoverable: true });
    }

    return llm.sendToLLM(prompt, {
      imageBase64: imageBase64 || undefined,
      journal: false,
      priority: 'high'
    }).then(function(result) {
      if (!result || !result.ok || !result.clean) {
        lastError = 'synthesis failed — try again';
        status = 'retry';
        emit('structa-triangle-failed', { message: lastError, recoverable: true });
        return { ok: false, error: lastError, recoverable: true };
      }

      const parsed = parseSynthesis(result.clean);
      if (!parsed.signal) {
        lastError = 'synthesis failed — try again';
        status = 'retry';
        emit('structa-triangle-failed', { message: lastError, recoverable: true });
        return { ok: false, error: lastError, recoverable: true };
      }

      const signalNode = native?.addNode?.({
        type: 'insight',
        status: 'open',
        title: 'triangle signal',
        body: parsed.signal,
        source: 'triangle',
        tags: ['triangle'],
        meta: {
          triangulated: true,
          triangle_inputs: {
            a: { type: pair.a.type, id: pair.a.id },
            b: { type: pair.b.type, id: pair.b.id },
            angle: spoken
          }
        }
      });

      let questionNode = null;
      if (parsed.question) {
        questionNode = native?.addNode?.({
          type: 'question',
          status: 'open',
          title: 'triangle follow up',
          body: parsed.question,
          source: 'triangle',
          tags: ['triangle'],
          meta: {
            triangulated: true,
            triangle_inputs: {
              a: { type: pair.a.type, id: pair.a.id },
              b: { type: pair.b.type, id: pair.b.id },
              angle: spoken
            }
          }
        });
      }

      updateLinks(signalNode?.node_id || '', pair.a, pair.b, questionNode?.node_id || '');
      const origin = clone(pair.origin || {});
      clearRuntimeState();
      window.StructaLLM?.speakMilestone?.('triangle');
      emit('structa-triangle-result', {
        signal: parsed.signal,
        question: parsed.question || '',
        signalNode: clone(signalNode),
        questionNode: clone(questionNode),
        origin: origin
      });
      return {
        ok: true,
        signal: parsed.signal,
        question: parsed.question || '',
        signalNode: signalNode,
        questionNode: questionNode,
        origin: origin
      };
    }).catch(function() {
      lastError = 'synthesis failed — try again';
      status = 'retry';
      emit('structa-triangle-failed', { message: lastError, recoverable: true });
      return { ok: false, error: lastError, recoverable: true };
    });
  }

  function init() {
    const slot = native?.getTriangleSlot?.();
    if (slot && slot.armed && slot.item) {
      mode = 'armed';
      armed = clone(slot.item);
      pair = null;
      status = 'armed';
      lastError = '';
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
