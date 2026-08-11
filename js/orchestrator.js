(function() {
  'use strict';

  function compact(value, limit) {
    var text = String(value || '').trim().replace(/\s+/g, ' ');
    var max = Number(limit || 220);
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  function lower(value) {
    return String(value || '').trim().toLowerCase();
  }

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizePolicy(policy) {
    var input = object(policy);
    return {
      priority: input.priority || 'high',
      allowSearch: input.allowSearch === true,
      allowSpeech: false
    };
  }

  function normalizeEnvelope(payload, defaultPriority) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(Object.assign({ priority: defaultPriority || 'high' }, envelope.policy || {}));
    return envelope;
  }

  function normalizeMultiline(value) {
    return String(value || '').split(/\r?\n/).map(function(line) {
      return line.trim();
    }).filter(Boolean).join('\n');
  }

  function parseLabeledLines(value) {
    var parsed = {};
    String(value || '').split(/\r?\n/).forEach(function(line) {
      var separator = line.indexOf(':');
      if (separator < 1) return;
      var key = line.slice(0, separator).trim().toUpperCase();
      var content = line.slice(separator + 1).trim();
      if (key) parsed[key] = content;
    });
    return parsed;
  }

  function extractJSONBlock(value) {
    var raw = String(value || '').trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (_) {}
    var fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch (_) {}
    }
    var start = raw.indexOf('{');
    var end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
    }
    return {};
  }

  function rawResponse(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (typeof result.clean === 'string' && result.clean.trim()) return result.clean;
    if (typeof result.text === 'string') return result.text;
    if (result.structured && typeof result.structured === 'object') {
      try { return JSON.stringify(result.structured); } catch (_) {}
    }
    return '';
  }

  function fallbackMeta(prepared, reason) {
    return Object.assign({}, object(prepared?.meta), {
      deterministicFallback: true,
      fallbackReason: compact(reason || 'llm unavailable', 120)
    });
  }

  function runLocal(payload, defaultPriority, prepare, normalize, fallback, executeLLM) {
    var envelope = normalizeEnvelope(payload, defaultPriority);
    var prepared;
    try {
      prepared = prepare(envelope);
    } catch (error) {
      return Promise.resolve(fallback(envelope, null, error?.message || 'prepare failed'));
    }
    if (!prepared || !prepared.ok) return Promise.resolve(prepared || { ok: false, error: 'prepare failed' });
    if (typeof executeLLM !== 'function') {
      return Promise.resolve(fallback(envelope, prepared, 'llm executor unavailable'));
    }
    var execution;
    try {
      execution = executeLLM(prepared);
    } catch (error) {
      return Promise.resolve(fallback(envelope, prepared, error?.message || 'llm failed'));
    }
    return Promise.resolve(execution).then(function(result) {
      if (!result || result.ok === false) {
        return fallback(envelope, prepared, result?.error || 'llm failed');
      }
      var normalizedPayload = Object.assign({}, envelope, {
        rawResponse: rawResponse(result),
        llmMeta: {
          text: result.text || '',
          clean: result.clean || '',
          structured: result.structured || null
        }
      });
      try {
        return normalize(normalizedPayload, prepared);
      } catch (error) {
        return fallback(envelope, prepared, error?.message || 'normalize failed');
      }
    }).catch(function(error) {
      return fallback(envelope, prepared, error?.message || 'llm failed');
    });
  }

  function projectLines(project) {
    var input = object(project);
    var lines = [];
    if (input.name) lines.push('project: ' + compact(input.name, 72));
    if (input.type) lines.push('type: ' + compact(input.type, 32));
    if (input.brief) lines.push('brief: ' + compact(input.brief, 180));
    var questions = list(input.topQuestions || input.openQuestions).map(function(entry) {
      return compact(typeof entry === 'string' ? entry : (entry?.body || entry?.text || entry?.title || ''), 60);
    }).filter(Boolean).slice(0, 3);
    if (questions.length) lines.push('top questions: ' + questions.join('; '));
    if (input.summary) lines.push('working memory: ' + compact(input.summary, 240));
    if (input.selectedSurface) lines.push('surface: ' + compact(input.selectedSurface, 24));
    return lines;
  }

  function selectionLines(selection) {
    var input = object(selection);
    var lines = [];
    var summary = compact(input.summary || input.body || '', 220);
    if (input.kind) lines.push('selection kind: ' + input.kind);
    if (summary) lines.push('selection: ' + summary);
    if (input.status) lines.push('selection status: ' + input.status);
    list(input.claims).slice(0, 4).forEach(function(claim) {
      if (claim?.id && claim?.text) lines.push('claim ' + claim.id + ': ' + compact(claim.text, 90));
    });
    return lines;
  }

  function inferClaimKind(value, fallback) {
    var text = lower(value);
    if (!text) return fallback || 'fact';
    if (text.endsWith('?') || /^(what|how|where|when|which)\b/.test(text)) return 'question';
    if (/\b(must|need to|cannot|can't|should|required|deadline)\b/.test(text)) return 'constraint';
    if (/\b(prefer|want|like|comfortable|love|hate)\b/.test(text)) return 'preference';
    if (/\b(will|going to|plan|decide|choose|moving toward)\b/.test(text)) return 'intent';
    return fallback || 'fact';
  }

  function estimateSTTConfidence(value) {
    var text = String(value || '');
    var words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    var score = 0.45;
    if (words.length >= 4) score += 0.16;
    if (words.length >= 8) score += 0.08;
    if (/[.?!,]/.test(text)) score += 0.06;
    if (!/(\bum\b|\buh\b|\.\.\.|\?\?\?)/i.test(text)) score += 0.08;
    return Math.min(0.96, Math.round(score * 100) / 100);
  }

  function makeClaim(value, source, sourceRef, options) {
    var opts = object(options);
    var text = compact(value, 160);
    if (!text) return null;
    var output = {
      text: text,
      kind: opts.kind || inferClaimKind(text),
      source: source || 'voice',
      confidence: typeof opts.confidence === 'number' ? opts.confidence : ((source === 'voice' || source === 'answer' || source === 'comment') ? 0.72 : 0.7),
      sourceRef: object(sourceRef),
      evidence: list(opts.evidence).slice(),
      status: 'active'
    };
    if (typeof opts.sttConfidence === 'number') output.sttConfidence = opts.sttConfidence;
    return output;
  }

  function simpleClaims(parts, source, sourceRef, sttConfidence) {
    var seen = {};
    return list(parts).map(function(value) {
      var claim = makeClaim(value, source, sourceRef, { sttConfidence: sttConfidence });
      if (!claim) return null;
      var key = lower(claim.text);
      if (seen[key]) return null;
      seen[key] = true;
      return claim;
    }).filter(Boolean);
  }

  function extractClaimLines(value) {
    var raw = String(value || '');
    var bullets = raw.split(/\r?\n/).map(function(line) {
      return compact(line.replace(/^\s*[-*•]\s*/, ''), 160);
    }).filter(function(line, index) {
      var original = raw.split(/\r?\n/)[index] || '';
      return /^\s*[-*•]\s+/.test(original) && !!line;
    });
    if (bullets.length) return bullets.slice(0, 4);
    return normalizeMultiline(raw).replace(/\n/g, ' ').split(/(?<=[.?!])\s+/).map(function(part) {
      return compact(part, 160);
    }).filter(Boolean).slice(0, 3);
  }

  function makeArtifact(kind, body, title, source, options) {
    var item = {
      type: kind,
      body: compact(body, 220),
      source: source || 'orchestrator',
      status: 'open'
    };
    if (title) item.title = compact(title, 72);
    if (Array.isArray(options)) item.options = options.slice(0, 4);
    return item;
  }

  function voicePrepare(payload) {
    var transcript = compact(payload?.input?.transcript || payload?.transcript || '', 400);
    var answering = payload.answeringQuestion === true;
    var question = compact(payload.questionText || payload?.input?.questionText || '', 200);
    var lines = [
      'You are Structa, a precision project orchestrator.',
      'Use only the provided project context and transcript.',
      '',
      'PROJECT'
    ].concat(projectLines(payload.project));
    var selected = selectionLines(payload.selection);
    if (selected.length) lines = lines.concat(['', 'SELECTION'], selected);
    if (answering) {
      lines = lines.concat([
        '', 'QUESTION', question || 'project question', '', 'USER ANSWER', transcript, '',
        'Return exactly these lines:',
        'TYPE: answer',
        'INSIGHT: <what the answer unlocks, max 12 words>',
        'NEXT: <one next move, max 8 words>',
        'DECISION: <omit unless the answer clearly commits to one>'
      ]);
    } else {
      lines = lines.concat([
        '', 'USER INPUT', transcript, '', 'Classify and condense the input.',
        'Return exactly these lines:',
        'TYPE: signal | question | decision | task | note_update',
        'INSIGHT: <one sharp working interpretation, max 14 words>',
        'NEXT: <one next move, max 8 words>',
        'DECISION: <omit unless the input clearly commits to one>'
      ]);
    }
    return {
      ok: true,
      llm: {
        prompt: lines.join('\n'),
        timeout: 22000,
        priority: payload.policy.priority,
        useSerpAPI: payload.policy.allowSearch
      },
      ui: { summary: compact(transcript, 80), logLine: 'voice interpreted' },
      meta: { kind: 'voice', answeringQuestion: answering }
    };
  }

  function voiceNormalize(payload) {
    var raw = String(payload.rawResponse || '');
    var parsed = parseLabeledLines(raw);
    var transcript = compact(payload?.input?.transcript || payload.transcript || '', 240);
    var answering = payload.answeringQuestion === true;
    var questionText = compact(payload.questionText || payload?.input?.questionText || '', 200);
    var insight = compact(parsed.INSIGHT || raw || transcript || 'Voice note captured', 120);
    var next = compact(parsed.NEXT || '', 80);
    var decision = lower(parsed.DECISION) === 'omit' ? '' : compact(parsed.DECISION || '', 120);
    var kind = lower(parsed.TYPE || (answering ? 'answer' : 'signal'));
    var primaryKind = (kind === 'decision' || kind === 'note_update' || kind === 'answer') ? 'signal' : kind;
    if (['signal', 'question', 'task'].indexOf(primaryKind) === -1) primaryKind = 'signal';
    var sttConfidence = transcript ? estimateSTTConfidence(transcript) : null;
    var claims = simpleClaims([insight].concat(decision ? [decision] : []), answering ? 'answer' : 'voice', answering && questionText ? { questionText: questionText } : {}, sttConfidence);
    var artifacts = [makeArtifact(primaryKind, insight, '', 'voice')];
    if (decision) artifacts.push(makeArtifact('decision', decision, decision, 'voice'));
    if (next) artifacts.push(makeArtifact('task', next, 'next', 'voice'));
    var response = {
      ok: true,
      clean: insight,
      structured: { raw: normalizeMultiline(raw), type: kind, insight: insight, next: next, decision: decision, conf: 'med' },
      artifacts: artifacts,
      claims: claims,
      ui: { summary: insight, logLine: 'voice interpreted' },
      meta: { kind: 'voice' }
    };
    if (answering) {
      response.answerNode = {
        body: transcript,
        claims: claims.map(function(entry) { return entry.text; }),
        sttConfidence: sttConfidence,
        questionText: questionText
      };
    }
    return response;
  }

  function voiceFallback(payload, prepared, reason) {
    var response = voiceNormalize(Object.assign({}, payload, {
      rawResponse: payload?.input?.transcript || payload.transcript || ''
    }));
    response.meta = fallbackMeta(prepared, reason);
    return response;
  }

  function imagePrompt(payload) {
    var project = object(payload.project);
    var input = object(payload.input);
    var branch = object(project.activeBranch);
    var annotation = compact(input.voiceAnnotation || input.transcript || '', 180);
    var claims = list(project.recentClaims).map(function(entry) { return compact(entry?.text || '', 80); }).filter(Boolean).slice(0, 3);
    var questions = list(project.openQuestions || project.topQuestions).map(function(entry) {
      return compact(typeof entry === 'string' ? entry : (entry?.body || entry?.text || entry?.title || ''), 80);
    }).filter(Boolean).slice(0, 2);
    return [
      'Project image analysis.',
      'Describe only visible facts relevant to the project. Do not infer hidden details.',
      'Preserve names, labels, acronyms, and intentional capitalization exactly as visible.',
      'Return labeled lines only:',
      'FACTS: <visible facts in one short sentence>',
      'SIGNAL: <project relevance in one short sentence>',
      'NEXT: <one useful inspection move, or omit>',
      'CLAIM1: <visible claim, or omit>',
      'CLAIM2: <visible claim, or omit>',
      'CLAIM3: <visible claim, or omit>',
      '',
      'project: ' + compact(project.name || 'untitled project', 72),
      'type: ' + compact(project.type || 'general', 32),
      'branch: ' + compact(branch.name || branch.id || 'main', 48),
      'recent claims: ' + (claims.join('; ') || 'early project'),
      'open questions: ' + (questions.join('; ') || 'none yet'),
      'user intent: ' + (annotation || 'no annotation'),
      'camera mode: ' + compact(payload?.meta?.facingMode || 'environment', 24),
      'image id: ' + compact(input.imageId || payload?.meta?.imageId || 'unknown', 64)
    ].join('\n');
  }

  function imagePrepare(payload) {
    return {
      ok: true,
      llm: {
        prompt: imagePrompt(payload),
        imageBase64: payload?.input?.imageBase64 || '',
        timeout: 40000,
        priority: payload.policy.priority,
        useSerpAPI: false
      },
      ui: { summary: 'analyzing image', logLine: 'image queued' },
      meta: { kind: 'image', imageId: payload?.input?.imageId || payload?.meta?.imageId || '' }
    };
  }

  function imageNormalize(payload) {
    var raw = String(payload.rawResponse || '');
    var parsed = parseLabeledLines(raw);
    var facts = compact(parsed.FACTS || '', 180);
    var signal = compact(parsed.SIGNAL || '', 180);
    if (!facts && !signal) facts = compact(normalizeMultiline(raw), 180);
    var next = lower(parsed.NEXT) === 'omit' ? '' : compact(parsed.NEXT || '', 100);
    var summary = signal || facts || compact(payload?.input?.voiceAnnotation || payload?.input?.transcript || '', 180) || 'Frame saved';
    var sourceRef = { imageId: compact(payload?.input?.imageId || payload?.meta?.imageId || '', 80) };
    var labeledClaims = [parsed.CLAIM1, parsed.CLAIM2, parsed.CLAIM3].filter(function(value) {
      return value && lower(value) !== 'omit';
    });
    var claimParts = labeledClaims.length ? labeledClaims : extractClaimLines(raw);
    if (!claimParts.length && summary !== 'Frame saved') claimParts = [summary];
    var artifacts = [makeArtifact('signal', summary, '', 'image')];
    if (next) artifacts.push(makeArtifact('task', next, 'next', 'image'));
    return {
      ok: true,
      clean: summary,
      structured: { raw: normalizeMultiline(raw), facts: facts, signal: signal, next: next, insight: summary, decision: '', conf: 'med' },
      artifacts: artifacts,
      claims: simpleClaims(claimParts.slice(0, 4), 'image', sourceRef),
      ui: { summary: summary, logLine: 'image analyzed' },
      meta: { analysisStatus: facts || signal ? 'ready' : 'saved' }
    };
  }

  function imageFallback(payload, prepared, reason) {
    var annotation = compact(payload?.input?.voiceAnnotation || payload?.input?.transcript || payload?.input?.description || payload?.description || '', 180);
    var response = imageNormalize(Object.assign({}, payload, { rawResponse: annotation }));
    response.meta = Object.assign(fallbackMeta(prepared, reason), {
      analysisStatus: annotation ? 'context-only' : 'saved'
    });
    return response;
  }

  function normalizeFocus(raw) {
    var input = object(raw);
    var target = object(input.target);
    var kind = lower(target.kind || input.kind || 'branch');
    var id = compact(target.id || input.id || target.branchId || input.branchId || 'main', 80);
    var branchId = compact(target.branchId || input.branchId || id || 'main', 80);
    var phase = lower(input.phase || 'observe');
    if (['branch', 'question', 'claim'].indexOf(kind) === -1) kind = 'branch';
    if (['observe', 'clarify', 'evaluate', 'decision'].indexOf(phase) === -1) phase = 'observe';
    return { kind: kind, id: id || branchId, branchId: branchId || 'main', phase: phase };
  }

  function chainDigest(projectInput, focus, historyInput) {
    var project = object(projectInput);
    var history = object(historyInput);
    var claims = list(project.claims);
    var nodes = list(project.nodes);
    var branchId = focus.branchId || 'main';
    return {
      focus: focus,
      digest: {
        recent_claims: claims.filter(function(claim) {
          return (claim?.status || 'active') === 'active' && String(claim?.branchId || 'main') === String(branchId);
        }).slice(0, 24),
        disputed_claims: claims.filter(function(claim) { return claim?.status === 'disputed'; }).slice(0, 8),
        open_questions: nodes.filter(function(node) {
          return node?.type === 'question' && node.status === 'open' && !node?.meta?.skipped_until;
        }).slice(0, 12).map(function(node) {
          return {
            id: node.node_id || '',
            body: compact(node.body || node.title || '', 180),
            branchId: node?.meta?.branch_id || 'main',
            priority: lower(node?.meta?.priority || 'normal'),
            evidence_claims: list(node?.meta?.evidence_claims).slice(0, 6)
          };
        }),
        recent_answers: list(project.answers).slice(0, 8),
        branch_context: { id: branchId, name: branchId }
      },
      history: {
        previous_steps: list(history.previous_steps).slice(-4),
        plateau_count: Number(history.plateau_count || 0)
      }
    };
  }

  function chainPrepare(payload) {
    if (!payload.project || !payload.focus) return { ok: false, error: 'typed focus and project are required' };
    var focus = normalizeFocus(payload.focus);
    var digest = chainDigest(payload.project, focus, payload.history);
    var prompt = [
      "You are Structa's grounded reasoning engine.",
      'Reason only from the typed digest below. Never use outside facts.',
      'Every produced node must cite evidence ids from the digest.',
      'Return strict JSON only.',
      '', JSON.stringify(digest), '',
      'Return: {"focus":{"phase_next":"clarify","state_next":"active"},"produced":{"claims":[],"questions":[],"decisions":[],"tasks":[]},"step_metadata":{"rationale":"...","confidence":0.0}}',
      'Claims, decisions, and tasks use evidence:["claim-id"]. Questions use meta.evidence_claims.',
      'If signal is insufficient, return empty produced arrays and note:"insufficient_signal".'
    ].join('\n');
    return {
      ok: true,
      llm: { prompt: prompt, timeout: 22000, priority: payload.policy.priority, useSerpAPI: payload.policy.allowSearch },
      ui: { summary: focus.phase, logLine: 'chain ' + focus.phase },
      meta: { kind: 'chain', phase: focus.phase, focus: focus, digest: digest.digest, projectId: payload.projectId || payload?.project?.project_id || '', baseRevision: payload.baseRevision || '' }
    };
  }

  function evidenceList(value) {
    if (Array.isArray(value)) return value.map(function(item) { return compact(item, 64); }).filter(Boolean);
    if (typeof value === 'string') return value.split(/[,|\n]/).map(function(item) { return compact(item, 64); }).filter(Boolean);
    return [];
  }

  function emptyChainResult(payload, prepared, reason) {
    var focus = normalizeFocus(payload.focus);
    return {
      ok: true,
      focus: { phase_next: focus.phase, state_next: 'active' },
      produced: { claims: [], questions: [], decisions: [], tasks: [] },
      step_metadata: { rationale: compact(reason || 'insufficient signal', 180), confidence: 0, model: '', latencyMs: 0 },
      note: 'insufficient_signal',
      ui: { summary: focus.phase, logLine: 'chain insufficient signal' },
      meta: Object.assign(fallbackMeta(prepared, reason), { projectId: payload.projectId || payload?.project?.project_id || '', baseRevision: payload.baseRevision || '' }),
      projectId: payload.projectId || payload?.project?.project_id || '',
      baseRevision: payload.baseRevision || ''
    };
  }

  function chainNormalize(payload, prepared) {
    var parsed = extractJSONBlock(payload.rawResponse);
    if (!Object.keys(parsed).length) return emptyChainResult(payload, prepared, 'insufficient signal');
    var focus = normalizeFocus(payload.focus);
    var produced = object(parsed.produced);
    var missingEvidence = ['claims', 'decisions', 'tasks'].some(function(key) {
      return list(produced[key]).some(function(item) { return !evidenceList(item?.evidence).length; });
    }) || list(produced.questions).some(function(item) {
      return !evidenceList(item?.meta?.evidence_claims).length;
    });
    if (missingEvidence) return emptyChainResult(payload, prepared, 'generated nodes lacked evidence');
    var phaseNext = lower(parsed?.focus?.phase_next || focus.phase);
    var stateNext = lower(parsed?.focus?.state_next || 'active');
    var output = {
      ok: true,
      focus: { phase_next: phaseNext, state_next: stateNext },
      produced: {
        claims: list(produced.claims).map(function(item) {
          return {
            id: compact(item?.id || '', 64), text: compact(item?.text || '', 160),
            kind: lower(item?.kind || 'fact'), branchId: compact(item?.branchId || focus.branchId, 48),
            evidence: evidenceList(item?.evidence), source: 'chain', confidence: Number(item?.confidence || 0.64)
          };
        }).filter(function(item) { return !!item.text; }),
        questions: list(produced.questions).map(function(item) {
          return {
            id: compact(item?.id || '', 64), body: compact(item?.body || '', 160),
            meta: {
              evidence_claims: evidenceList(item?.meta?.evidence_claims),
              rationale: compact(item?.meta?.rationale || '', 180),
              priority: lower(item?.meta?.priority || 'normal'),
              branch_id: compact(item?.meta?.branch_id || focus.branchId, 48), source: 'chain'
            }
          };
        }).filter(function(item) { return !!item.body; }),
        decisions: list(produced.decisions).map(function(item) {
          return {
            id: compact(item?.id || '', 64), body: compact(item?.body || '', 160), evidence: evidenceList(item?.evidence),
            options: list(item?.options).map(function(option) { return compact(option, 48); }).filter(Boolean).slice(0, 4),
            recommended: compact(item?.recommended || '', 48)
          };
        }).filter(function(item) { return !!item.body; }),
        tasks: list(produced.tasks).map(function(item) {
          return { id: compact(item?.id || '', 64), body: compact(item?.body || '', 160), evidence: evidenceList(item?.evidence) };
        }).filter(function(item) { return !!item.body; })
      },
      step_metadata: {
        rationale: compact(parsed?.step_metadata?.rationale || '', 220),
        confidence: Number(parsed?.step_metadata?.confidence || 0),
        model: compact(parsed?.step_metadata?.model || '', 64),
        latencyMs: Number(parsed?.step_metadata?.latencyMs || 0)
      },
      note: compact(parsed.note || '', 120),
      ui: { summary: compact(parsed?.step_metadata?.rationale || focus.phase, 72), logLine: 'chain step' },
      meta: { projectId: payload.projectId || payload?.project?.project_id || '', baseRevision: payload.baseRevision || '' },
      projectId: payload.projectId || payload?.project?.project_id || '',
      baseRevision: payload.baseRevision || ''
    };
    return output;
  }

  function parentIds(payload) {
    var ids = [];
    ['itemA', 'itemB'].forEach(function(key) {
      var item = object(payload[key]);
      list(item.claimIds).concat(list(item.claims).map(function(claim) { return claim?.id; })).forEach(function(id) {
        var value = compact(id, 64);
        if (value && ids.indexOf(value) === -1) ids.push(value);
      });
    });
    return ids;
  }

  function trianglePrepare(payload) {
    var context = {
      project: object(payload.project), itemA: object(payload.itemA), itemB: object(payload.itemB),
      angle: object(payload.angle), branchContext: object(payload.branchContext), parentIds: parentIds(payload)
    };
    return {
      ok: true,
      llm: {
        prompt: [
          "You are Structa's constrained triangle reasoner.",
          'Reason only from this typed claim graph. Each derived claim cites at least two parent ids.',
          'If the bridge is weak, return an ambiguity question. Return strict JSON only.',
          JSON.stringify(context),
          'Return {"status":"synthesized|ambiguous","title":"...","branchId":"main","derived_claims":[],"unresolved_tensions":[],"question":null,"step_metadata":{"confidence":0.0}}. Do not return a body field.'
        ].join('\n'),
        timeout: 25000,
        priority: payload.policy.priority,
        useSerpAPI: payload.policy.allowSearch
      },
      ui: { summary: 'triangle ready', logLine: 'triangle synthesizing' },
      meta: { kind: 'triangle', parent_ids: context.parentIds }
    };
  }

  function triangleFallback(payload, prepared, reason) {
    var ids = parentIds(payload).slice(0, 4);
    var body = compact(payload?.angle?.text, 120);
    return {
      ok: true,
      status: 'ambiguous',
      question: {
        body: body ? 'Which part of “' + body + '” should connect these references?' : 'Which connection between these references matters most?',
        meta: { evidence_claims: ids, rationale: 'The relationship needs human direction.', priority: 'normal', branch_id: payload?.branchContext?.id || 'main', source: 'triangle' }
      },
      step_metadata: { confidence: 0, latencyMs: 0, model: '' },
      ui: { summary: 'Triangle needs direction', logLine: 'triangle ambiguous' },
      meta: fallbackMeta(prepared, reason)
    };
  }

  function triangleNormalize(payload, prepared) {
    var parsed = extractJSONBlock(payload.rawResponse);
    var status = lower(parsed.status);
    if (status !== 'synthesized' && status !== 'ambiguous') return triangleFallback(payload, prepared, 'invalid triangle response');
    if (status === 'ambiguous') {
      var fallback = triangleFallback(payload, prepared, 'triangle remained ambiguous');
      var question = object(parsed.question);
      fallback.question.body = compact(question.body || fallback.question.body, 160);
      fallback.question.meta.evidence_claims = evidenceList(question?.meta?.evidence_claims).slice(0, 4);
      if (!fallback.question.meta.evidence_claims.length) fallback.question.meta.evidence_claims = parentIds(payload).slice(0, 4);
      fallback.question.meta.rationale = compact(question?.meta?.rationale || fallback.question.meta.rationale, 180);
      fallback.meta = { kind: 'triangle' };
      return fallback;
    }
    var claims = list(parsed.derived_claims).map(function(item) {
      return {
        text: compact(item?.text || '', 160), kind: lower(item?.kind || 'fact'),
        branchId: compact(item?.branchId || payload?.branchContext?.id || 'main', 48),
        evidence: evidenceList(item?.evidence), source: 'triangle', confidence: Number(item?.confidence || 0.72)
      };
    }).filter(function(item) { return item.text && item.evidence.length >= 2; });
    if (!claims.length) return triangleFallback(payload, prepared, 'triangle lacked grounded overlap');
    return {
      ok: true, status: 'synthesized', title: compact(parsed.title || 'Triangle signal', 72),
      branchId: compact(parsed.branchId || payload?.branchContext?.id || 'main', 48), derived_claims: claims,
      unresolved_tensions: list(parsed.unresolved_tensions).map(function(item) {
        return { between: evidenceList(item?.between).slice(0, 2), note: compact(item?.note || '', 120) };
      }).filter(function(item) { return item.between.length === 2; }),
      step_metadata: { confidence: Number(parsed?.step_metadata?.confidence || 0), latencyMs: Number(parsed?.step_metadata?.latencyMs || 0), model: compact(parsed?.step_metadata?.model || '', 64) },
      ui: { summary: compact(parsed.title || 'Triangle signal', 72), logLine: 'triangle ready' }, meta: { kind: 'triangle' }
    };
  }

  function threadPrepare(payload) {
    var transcript = compact(payload?.input?.transcript || '', 240);
    var lines = ['You are Structa, extracting knowledge from one project comment.', 'Return labeled lines only.', '', 'PROJECT']
      .concat(projectLines(payload.project));
    var selected = selectionLines(payload.selection);
    if (selected.length) lines = lines.concat(['', 'ITEM'], selected);
    lines = lines.concat(['', 'COMMENT', transcript, '', 'Return exactly:', 'SUMMARY: <max 8 words>', 'CLAIM1: <claim or omit>', 'CLAIM2: <claim or omit>', 'CLAIM3: <claim or omit>', 'CLARIFIES: <claim id or omit>', 'CONTRADICTS: <claim id or omit>']);
    return { ok: true, llm: { prompt: lines.join('\n'), timeout: 12000, priority: payload.policy.priority, useSerpAPI: payload.policy.allowSearch }, ui: { summary: 'comment refining', logLine: 'comment refining' }, meta: { kind: 'thread-refine' } };
  }

  function threadNormalize(payload) {
    var parsed = parseLabeledLines(payload.rawResponse);
    var transcript = compact(payload?.input?.transcript || '', 240);
    var summary = compact(parsed.SUMMARY || transcript || payload?.selection?.summary || payload?.selection?.body || 'Comment captured', 72);
    var values = [parsed.CLAIM1, parsed.CLAIM2, parsed.CLAIM3].filter(function(value) { return value && lower(value) !== 'omit'; });
    if (!values.length && transcript) values = extractClaimLines(transcript).slice(0, 3);
    return {
      ok: true, summary: summary,
      claims: simpleClaims(values, 'comment', payload.sourceRef || { itemId: payload?.selection?.id || '' }, estimateSTTConfidence(transcript)),
      clarifies: lower(parsed.CLARIFIES) === 'omit' ? '' : compact(parsed.CLARIFIES || '', 48),
      contradicts: lower(parsed.CONTRADICTS) === 'omit' ? '' : compact(parsed.CONTRADICTS || '', 48),
      ui: { summary: summary, logLine: 'comment refined' }, meta: { kind: 'thread-refine' }
    };
  }

  function threadFallback(payload, prepared, reason) {
    var response = threadNormalize(Object.assign({}, payload, { rawResponse: '' }));
    response.meta = fallbackMeta(prepared, reason);
    return response;
  }

  function backfillPrepare(payload) {
    var body = compact(payload.body || payload?.selection?.body || '', 320);
    var lines = ['Extract up to three concrete project claims.', 'Return labeled lines only.', '', 'PROJECT'].concat(projectLines(payload.project));
    lines = lines.concat(['', 'ITEM', body || 'unknown item', '', 'Return exactly:', 'CLAIM1: <claim or omit>', 'CLAIM2: <claim or omit>', 'CLAIM3: <claim or omit>']);
    return { ok: true, llm: { prompt: lines.join('\n'), timeout: 18000, priority: payload.policy.priority, useSerpAPI: payload.policy.allowSearch }, ui: { summary: 'claim backfill', logLine: 'claims backfill' }, meta: { kind: 'claims-backfill' } };
  }

  function backfillNormalize(payload) {
    var parsed = parseLabeledLines(payload.rawResponse);
    var values = [parsed.CLAIM1, parsed.CLAIM2, parsed.CLAIM3].filter(function(value) { return value && lower(value) !== 'omit'; });
    if (!values.length) values = extractClaimLines(payload.body || payload?.selection?.body || '').slice(0, 3);
    var claims = simpleClaims(values, payload.source || 'backfill', payload.sourceRef || {});
    return { ok: true, claims: claims, ui: { summary: claims.length + ' claims', logLine: 'claims backfilled' }, meta: { kind: 'claims-backfill' } };
  }

  function backfillFallback(payload, prepared, reason) {
    var response = backfillNormalize(Object.assign({}, payload, { rawResponse: '' }));
    response.meta = fallbackMeta(prepared, reason);
    return response;
  }

  function cleanTitle(value) {
    var raw = compact(value, 80).replace(/^\s*(?:TITLE|NAME)\s*:\s*/i, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
    raw = raw.replace(/[^\p{L}\p{N}\s&+.-]/gu, ' ').replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '').trim();
    raw = raw.replace(/^(?:project about|project|this is about|this is|about|called)\s+/i, '');
    return raw.split(/\s+/).filter(Boolean).slice(0, 3).join(' ') || 'untitled project';
  }

  function deterministicTitle(payload) {
    var transcript = compact(payload.transcript || payload?.input?.transcript || '', 240);
    var subject = transcript.replace(/^\s*(?:i\s+)?(?:want|need|plan|hope)\s+to\s+(?:build|make|create|develop|design|launch)\s+/i, '')
      .replace(/^\s*(?:build|make|create|develop|design|launch)\s+/i, '')
      .replace(/^\s*(?:a|an|the|my)\s+/i, '');
    return cleanTitle(subject);
  }

  function titlePrepare(payload) {
    var transcript = compact(payload.transcript || payload?.input?.transcript || '', 240);
    return {
      ok: true,
      llm: {
        prompt: ['Name this project from the user\'s first words.', 'Return only a 2-3 word title.', 'Preserve intentional capitalization, acronyms, and product names. No explanation or quotes.', 'If unusable, return: untitled project', '', 'TRANSCRIPT:', transcript].concat(projectLines(payload.project)).join('\n'),
        timeout: 3000, priority: payload.policy.priority, useSerpAPI: false
      },
      ui: { summary: 'project title', logLine: 'naming project' }, meta: { kind: 'project-title' }
    };
  }

  function titleNormalize(payload) {
    return { ok: true, title: cleanTitle(payload.rawResponse || deterministicTitle(payload)) };
  }

  function titleFallback(payload, prepared, reason) {
    return { ok: true, title: deterministicTitle(payload), meta: fallbackMeta(prepared, reason) };
  }

  function briefPrepare(payload) {
    var transcript = compact(payload.transcript || payload?.input?.transcript || '', 360);
    var lines = [
      'You are Structa, compiling one new project into a decision-ready map.',
      'Return labeled lines only. Preserve intentional casing and names.',
      'Do not invent facts. Use "omit" when the user did not supply enough signal.',
      '', 'TRANSCRIPT', transcript, '', 'PROJECT'
    ].concat(projectLines(payload.project));
    lines = lines.concat([
      '', 'Return exactly:',
      'TITLE: <2-3 words>',
      'BRIEF: <2 short sentences>',
      'OUTCOME: <what must exist when this succeeds>',
      'AUDIENCE: <primary user or stakeholder, or omit>',
      'SUCCESS: <observable success test, or omit>',
      'DIRECTION: <current creative or product direction, or omit>',
      'VALIDATION: <best first proof or test, or omit>',
      'DELIVERY: <best first delivery move, or omit>',
      'CONSTRAINT1: <known constraint or omit>', 'CONSTRAINT2: <known constraint or omit>', 'CONSTRAINT3: <known constraint or omit>',
      'NON_GOAL1: <scope exclusion or omit>', 'NON_GOAL2: <scope exclusion or omit>',
      'DECISION1: <decision question> || <option A> || <option B> [|| <option C> || <option D>], or omit',
      'DECISION2: <decision question> || <option A> || <option B> [|| <option C> || <option D>], or omit',
      'DECISION3: <decision question> || <option A> || <option B> [|| <option C> || <option D>], or omit',
      'ASK1: <candidate or omit>', 'ASK2: <candidate or omit>', 'ASK3: <candidate or omit>',
      'BLOCKER1: <candidate or omit>', 'BLOCKER2: <candidate or omit>', 'BLOCKER3: <candidate or omit>',
      'THEME1: <candidate or omit>', 'THEME2: <candidate or omit>', 'THEME3: <candidate or omit>',
      'NEXT: <one short next action>'
    ]);
    return { ok: true, llm: { prompt: lines.join('\n'), timeout: 22000, priority: payload.policy.priority, useSerpAPI: payload.policy.allowSearch }, ui: { summary: 'project brief', logLine: 'building brief' }, meta: { kind: 'project-brief' } };
  }

  function briefNormalize(payload) {
    var parsed = parseLabeledLines(payload.rawResponse);
    var transcript = compact(payload.transcript || payload?.input?.transcript || '', 220);
    function candidates(prefix, kind) {
      return [1, 2, 3].map(function(index) {
        var value = compact(parsed[prefix + index] || '', 140);
        if (!value || lower(value) === 'omit') return null;
        if (kind === 'decision') {
          var parts = value.split(/\s*\|\|\s*/).map(function(part) { return compact(part, 80); }).filter(Boolean);
          return {
            kind: kind,
            text: parts.shift() || value,
            options: parts.slice(0, 4),
            confidence: 'med',
            source: 'project-brief',
            requires_user_approval: true
          };
        }
        return { kind: kind, text: value, confidence: 'med', source: 'project-brief' };
      }).filter(Boolean);
    }
    function values(prefix, count) {
      var output = [];
      for (var index = 1; index <= count; index += 1) {
        var value = compact(parsed[prefix + index] || '', 160);
        if (value && lower(value) !== 'omit') output.push(value);
      }
      return output;
    }
    var brief = compact(parsed.BRIEF || transcript || 'New project', 220);
    var outcome = compact(parsed.OUTCOME || brief, 260);
    var audience = lower(parsed.AUDIENCE) === 'omit' ? '' : compact(parsed.AUDIENCE || payload?.project?.user_role || '', 180);
    var success = lower(parsed.SUCCESS) === 'omit' ? '' : compact(parsed.SUCCESS || '', 200);
    var constraints = values('CONSTRAINT', 3);
    var nonGoals = values('NON_GOAL', 2);
    var inferredPacks = window.StructaDomainPacks?.infer?.(transcript + ' ' + brief) || ['creative-core'];
    function usable(label, fallback) {
      return lower(label) === 'omit' ? '' : compact(label || fallback || '', 180);
    }
    return {
      ok: true,
      title: cleanTitle(parsed.TITLE || deterministicTitle(payload)),
      brief: brief,
      constitution: {
        outcome: outcome,
        audience: audience,
        success: success,
        constraints: constraints,
        non_goals: nonGoals
      },
      packHints: inferredPacks.filter(function(id) { return id !== 'creative-core'; }),
      branches: [
        { id: 'outcome', summary: outcome, confidence: parsed.OUTCOME ? 0.78 : 0.58 },
        { id: 'audience', summary: audience, confidence: audience ? 0.7 : 0 },
        { id: 'direction', summary: usable(parsed.DIRECTION, values('THEME', 3)[0]), confidence: parsed.DIRECTION ? 0.68 : 0.45 },
        { id: 'constraints', summary: constraints.join('; '), confidence: constraints.length ? 0.7 : 0 },
        { id: 'validation', summary: usable(parsed.VALIDATION, success), confidence: parsed.VALIDATION ? 0.68 : (success ? 0.55 : 0) },
        { id: 'delivery', summary: usable(parsed.DELIVERY, parsed.NEXT), confidence: parsed.DELIVERY || parsed.NEXT ? 0.66 : 0 }
      ].filter(function(branch) { return !!branch.summary; }),
      candidates: { decisions: candidates('DECISION', 'decision'), asks: candidates('ASK', 'ask'), blockers: candidates('BLOCKER', 'blocker'), themes: candidates('THEME', 'theme') },
      suggestedNext: lower(parsed.NEXT) === 'omit' ? '' : compact(parsed.NEXT || '', 80),
      ui: { summary: brief, logLine: 'brief ready' }, meta: { kind: 'project-brief' }
    };
  }

  function briefFallback(payload, prepared, reason) {
    var response = briefNormalize(Object.assign({}, payload, { rawResponse: '' }));
    response.meta = fallbackMeta(prepared, reason);
    return response;
  }

  function interpretVoice(payload, executeLLM) {
    return runLocal(payload, 'high', voicePrepare, voiceNormalize, voiceFallback, executeLLM);
  }

  function analyzeImage(payload, executeLLM) {
    return runLocal(payload, 'high', imagePrepare, imageNormalize, imageFallback, executeLLM);
  }

  function prepareImageContextPrompt(payload) {
    var envelope = normalizeEnvelope(payload, 'high');
    try { return Promise.resolve(imagePrepare(envelope)); }
    catch (error) { return Promise.resolve({ ok: false, error: error?.message || 'image prompt failed' }); }
  }

  function extractClaimsFromText(payload) {
    var envelope = normalizeEnvelope(payload, 'low');
    var source = compact(envelope.source || 'image', 24) || 'image';
    var claims = simpleClaims(extractClaimLines(envelope?.input?.text || envelope.text || ''), source, envelope.sourceRef || {});
    return Promise.resolve({ ok: true, claims: claims, ui: { summary: claims.length + ' claims', logLine: 'claims extracted' }, meta: { kind: 'claims-extract-from-text', deterministic: true } });
  }

  function runChainStep(payload, executeLLM) {
    return runLocal(payload, 'low', chainPrepare, chainNormalize, emptyChainResult, executeLLM);
  }

  function synthesizeTriangle(payload, executeLLM) {
    return runLocal(payload, 'high', trianglePrepare, triangleNormalize, triangleFallback, executeLLM);
  }

  function titleProject(payload, executeLLM) {
    return runLocal(payload, 'high', titlePrepare, titleNormalize, titleFallback, executeLLM);
  }

  function buildProjectBrief(payload, executeLLM) {
    return runLocal(payload, 'high', briefPrepare, briefNormalize, briefFallback, executeLLM);
  }

  function refineThread(payload, executeLLM) {
    return runLocal(payload, 'low', threadPrepare, threadNormalize, threadFallback, executeLLM);
  }

  function backfillClaims(payload, executeLLM) {
    return runLocal(payload, 'low', backfillPrepare, backfillNormalize, backfillFallback, executeLLM);
  }

  window.StructaOrchestrator = Object.freeze({
    interpretVoice: interpretVoice,
    analyzeImage: analyzeImage,
    prepareImageContextPrompt: prepareImageContextPrompt,
    extractClaimsFromText: extractClaimsFromText,
    runChainStep: runChainStep,
    synthesizeTriangle: synthesizeTriangle,
    backfillClaims: backfillClaims,
    titleProject: titleProject,
    buildProjectBrief: buildProjectBrief,
    refineThread: refineThread
  });
})();
