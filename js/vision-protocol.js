/**
 * vision-protocol.js — Pure protocol boundary for STRUCTA's silent Rabbit vision relay.
 *
 * This module deliberately owns the untrusted-model boundary. Rabbit responses do
 * not become project memory until they are valid, correlated, and reduced to the
 * allow-listed schema below.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StructaVisionProtocol = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var SCHEMA = 'structa.vision.v1';
  var MAX_MESSAGES = 24;
  var MAX_COLLECTED_CHARS = 64000;
  var sequence = 0;

  var CAPTURE_KINDS = Object.freeze([
    'sketch_diagram',
    'space',
    'material_object',
    'screen_graphic',
    'other',
    'unknown'
  ]);
  var PROJECT_ROLES = Object.freeze([
    'existing_condition',
    'working_artifact',
    'external_reference',
    'unknown'
  ]);
  var IMPLICATION_KINDS = Object.freeze([
    'structure',
    'research',
    'question',
    'decision_candidate',
    'risk',
    'reference_attribute'
  ]);
  var IMPACTS = Object.freeze(['low', 'medium', 'high']);

  function compact(value, limit) {
    var max = Number(limit || 220);
    var text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  function normalizeId(value, fallback) {
    var clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    clean = clean.replace(/^-+|-+$/g, '').slice(0, 64);
    return clean || fallback || '';
  }

  function createVisionId(captureId) {
    sequence += 1;
    var source = normalizeId(captureId, 'capture').slice(-10);
    var stamp = Date.now().toString(36).slice(-7);
    return ('vis_' + stamp + '_' + sequence.toString(36) + '_' + source).slice(0, 48);
  }

  function buildRabbitPayload(message, imageBase64) {
    return {
      message: String(message || '').trim(),
      payload: {
        imageBase64: String(imageBase64 || '')
      },
      useLLM: true,
      wantsR1Response: false,
      wantsJournalEntry: false
    };
  }

  function dataUrlParts(input) {
    var value = String(input || '');
    var match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/i);
    if (!match) {
      return {
        mimeType: 'image/jpeg',
        base64: value.replace(/\s+/g, ''),
        dataUrl: ''
      };
    }
    return {
      mimeType: String(match[1] || 'image/jpeg').toLowerCase(),
      base64: String(match[2] || '').replace(/\s+/g, ''),
      dataUrl: value
    };
  }

  function formatImageInput(input, mode) {
    var parts = dataUrlParts(input);
    if (!parts.base64) return '';
    if (String(mode || '').toLowerCase() === 'data-url') {
      return parts.dataUrl || ('data:' + parts.mimeType + ';base64,' + parts.base64);
    }
    return parts.base64;
  }

  function compactProject(project) {
    var source = project && typeof project === 'object' ? project : {};
    var constitution = source.constitution && typeof source.constitution === 'object' ? source.constitution : {};
    var imageLenses = source.imageLenses && typeof source.imageLenses === 'object' ? source.imageLenses : {};
    return {
      id: compact(source.id || source.project_id || '', 64),
      name: compact(source.name || 'untitled project', 72),
      type: compact(source.type || 'general', 32),
      brief: compact(source.brief || '', 240),
      constitution: {
        outcome: compact(source.outcome || constitution.outcome || '', 180),
        audience: compact(constitution.audience || source.audience || '', 120),
        success: compact(constitution.success || source.success || '', 140),
        constraints: (Array.isArray(constitution.constraints)
          ? constitution.constraints
          : (Array.isArray(source.constraints) ? source.constraints : [])).slice(0, 4).map(function(item) {
          return compact(item, 90);
        }).filter(Boolean)
      },
      pack_ids: (Array.isArray(source.pack_ids)
        ? source.pack_ids
        : (Array.isArray(source.packIds) ? source.packIds : [])).slice(0, 3).map(function(item) {
        return compact(item, 32);
      }).filter(Boolean),
      active_branch: {
        id: compact(source.activeBranch?.id || source.active_branch?.id || 'main', 48),
        name: compact(source.activeBranch?.name || source.active_branch?.name || 'main', 48)
      },
      recent_claims: (source.recentClaims || source.recent_claims || []).slice(0, 3).map(function(item) {
        return {
          id: compact(item?.id || '', 64),
          text: compact(item?.text || item || '', 120)
        };
      }).filter(function(item) { return !!item.text; }),
      open_questions: (source.openQuestions || source.open_questions || source.topQuestions || []).slice(0, 3).map(function(item) {
        return compact(item?.body || item?.text || item?.title || item || '', 120);
      }).filter(Boolean),
      branches: (Array.isArray(source.branches) ? source.branches : []).slice(0, 6).map(function(branch) {
        return {
          id: compact(branch?.id || '', 32),
          state: compact(branch?.state || branch?.status || '', 24),
          next: compact(branch?.next || branch?.summary || branch?.driving_question || '', 100)
        };
      }).filter(function(branch) { return !!branch.id; }),
      image_lenses: {
        working_artifact: (Array.isArray(imageLenses.working_artifact) ? imageLenses.working_artifact : []).slice(0, 4).map(function(item) { return compact(item, 48); }),
        existing_condition: (Array.isArray(imageLenses.existing_condition) ? imageLenses.existing_condition : []).slice(0, 4).map(function(item) { return compact(item, 48); }),
        external_reference: (Array.isArray(imageLenses.external_reference) ? imageLenses.external_reference : []).slice(0, 4).map(function(item) { return compact(item, 48); })
      },
      expert_only: (Array.isArray(source.expertOnly)
        ? source.expertOnly
        : (Array.isArray(source.expert_only) ? source.expert_only : [])).slice(0, 6).map(function(item) {
        return compact(item, 64);
      }).filter(Boolean)
    };
  }

  function buildVisionPrompt(input) {
    var opts = input && typeof input === 'object' ? input : {};
    var visionId = normalizeId(opts.visionId, createVisionId(opts.captureId || 'capture'));
    var context = {
      project: compactProject(opts.project || {}),
      capture_hint: compact(opts.captureHint || opts.description || '', 120),
      user_annotation: compact(opts.annotation || opts.voiceAnnotation || '', 180)
    };
    var shape = {
      schema: SCHEMA,
      vision_id: visionId,
      status: 'observed',
      capture_kind: 'sketch_diagram',
      project_role: 'working_artifact',
      project_role_confidence: 0.86,
      ocr: [{ text: 'exact readable text only', confidence: 0.94 }],
      observations: [{ id: 'obs_1', text: 'only what is visibly supported', confidence: 0.9 }],
      interpretations: [{ id: 'int_1', text: 'possible project relevance', observation_ids: ['obs_1'], confidence: 0.7 }],
      implications: [{
        id: 'imp_1',
        kind: 'question',
        text: 'one useful reversible project implication',
        interpretation_ids: ['int_1'],
        confidence: 0.65,
        requires_user_approval: true
      }],
      uncertainties: [{
        id: 'unc_1',
        question: 'one material ambiguity, only if present',
        impact: 'medium',
        related_ids: ['obs_1']
      }]
    };
    return [
      "You are STRUCTA's silent visual relay.",
      'VISION_ID: ' + visionId,
      'Inspect the attached image and return one strict JSON object only.',
      'The project context helps judge relevance but is never evidence of what is visible.',
      'The image_lenses guide relevance only; never repeat a lens as though it were observed.',
      'capture_kind describes what the image looks like: sketch_diagram, space, material_object, screen_graphic, other, or unknown.',
      'project_role describes how the user is using it: existing_condition, working_artifact, external_reference, or unknown. Never conflate the two.',
      'Intent, source, and project_role cannot be inferred from pixels. Use annotation/context only when explicit.',
      'If annotation/context does not establish project_role, use "unknown", confidence at most 0.5, and add an uncertainty.',
      'Keep four epistemic layers separate:',
      'OCR: copy exact readable text only into ocr; preserve spelling and punctuation, never repair or infer missing text.',
      '1. observations: visible pixels, layout, count, form, condition, or spatial relationship only.',
      '2. interpretations: explicitly tentative meaning grounded in observation_ids.',
      '3. implications: reversible structural, research, question, risk, reference-attribute, or decision-candidate suggestions.',
      '4. uncertainties: ambiguities that a professional may later confirm, correct, or dismiss.',
      'Never invent dimensions, materials, identity, compliance, causation, intent, or hidden conditions.',
      'A decision_candidate must always set requires_user_approval to true.',
      'If the image cannot be read, use status "insufficient", capture_kind and project_role "unknown", low project_role_confidence, empty ocr and layer arrays, and one uncertainty.',
      'Copy vision_id exactly. Use confidence numbers from 0 to 1. No markdown or prose outside JSON.',
      '',
      'PROJECT_CONTEXT (reference, not visual evidence):',
      JSON.stringify(context),
      '',
      'REQUIRED_SHAPE:',
      JSON.stringify(shape)
    ].join('\n');
  }

  function extractVisionIdFromPrompt(prompt) {
    var text = String(prompt || '');
    var label = text.match(/VISION_ID\s*:\s*([a-z0-9_-]{4,64})/i);
    if (label) return String(label[1] || '').trim();
    var json = text.match(/"vision_id"\s*:\s*"([a-z0-9_-]{4,64})"/i);
    return json ? String(json[1] || '').trim() : '';
  }

  function parseJsonObject(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    var raw = String(input || '').trim();
    if (!raw) return null;

    function tryParse(candidate) {
      try {
        var value = JSON.parse(candidate);
        if (typeof value === 'string' && value !== candidate) {
          try { value = JSON.parse(value); } catch (_) {}
        }
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      } catch (_) {
        return null;
      }
    }

    var direct = tryParse(raw);
    if (direct) return direct;
    var fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    var fenced;
    while ((fenced = fence.exec(raw))) {
      var fencedValue = tryParse(String(fenced[1] || '').trim());
      if (fencedValue) return fencedValue;
    }

    for (var start = 0; start < raw.length; start += 1) {
      if (raw[start] !== '{') continue;
      var depth = 0;
      var inString = false;
      var escaped = false;
      for (var end = start; end < raw.length; end += 1) {
        var char = raw[end];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        if (depth === 0) {
          var value = tryParse(raw.slice(start, end + 1));
          if (value) return value;
          break;
        }
      }
    }
    return null;
  }

  function asConfidence(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }

  function validateLayerRows(rows, options) {
    var opts = options || {};
    if (!Array.isArray(rows) || rows.length > Number(opts.max || 8)) {
      return { ok: false, error: opts.label + ' must be a bounded array' };
    }
    var seen = new Set();
    var output = [];
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      if (!row || typeof row !== 'object') return { ok: false, error: opts.label + ' row malformed' };
      var id = normalizeId(row.id, '');
      var text = compact(row.text, opts.textLimit || 240);
      var confidence = asConfidence(row.confidence);
      if (!id || seen.has(id) || !text || confidence == null) {
        return { ok: false, error: opts.label + ' row invalid' };
      }
      seen.add(id);
      var normalized = { id: id, text: text, confidence: confidence };
      if (opts.refsKey) {
        if (!Array.isArray(row[opts.refsKey])) return { ok: false, error: opts.label + ' references missing' };
        normalized[opts.refsKey] = row[opts.refsKey].map(function(ref) { return normalizeId(ref); }).filter(Boolean).slice(0, 8);
      }
      if (opts.kind) {
        var kind = String(row.kind || '').trim().toLowerCase();
        if (IMPLICATION_KINDS.indexOf(kind) === -1) return { ok: false, error: 'implication kind invalid' };
        if (typeof row.requires_user_approval !== 'boolean'
            || (kind === 'decision_candidate' && row.requires_user_approval !== true)) {
          return { ok: false, error: 'implication approval gate invalid' };
        }
        normalized.kind = kind;
        normalized.requires_user_approval = row.requires_user_approval;
      }
      output.push(normalized);
    }
    return { ok: true, value: output, ids: seen };
  }

  function validateVisionEnvelope(input, expectedVisionId) {
    var value = parseJsonObject(input);
    if (!value) return { ok: false, error: 'vision json missing', code: 'vision-json-missing' };
    if (String(value.schema || '') !== SCHEMA) return { ok: false, error: 'vision schema mismatch', code: 'vision-schema-mismatch' };
    var visionId = typeof value.vision_id === 'string' ? value.vision_id.trim() : '';
    var expected = String(expectedVisionId || '').trim();
    var normalizedVisionId = normalizeId(visionId);
    if (!visionId || normalizedVisionId !== visionId || !/^[a-z0-9_-]{4,64}$/.test(visionId)
        || (expected && visionId !== expected)) {
      return { ok: false, error: 'vision id mismatch', code: 'vision-id-mismatch', receivedVisionId: visionId };
    }
    var status = String(value.status || '').trim().toLowerCase();
    if (status !== 'observed' && status !== 'insufficient') {
      return { ok: false, error: 'vision status invalid', code: 'vision-status-invalid' };
    }
    var captureKind = String(value.capture_kind || '').trim().toLowerCase();
    if (CAPTURE_KINDS.indexOf(captureKind) === -1) {
      return { ok: false, error: 'capture kind invalid', code: 'vision-kind-invalid' };
    }
    var projectRole = String(value.project_role || '').trim().toLowerCase();
    var projectRoleConfidence = asConfidence(value.project_role_confidence);
    if (PROJECT_ROLES.indexOf(projectRole) === -1 || projectRoleConfidence == null
        || (projectRole === 'unknown' && projectRoleConfidence > 0.5)) {
      return { ok: false, error: 'project role invalid', code: 'vision-project-role-invalid' };
    }

    if (!Array.isArray(value.ocr) || value.ocr.length > 12) {
      return { ok: false, error: 'ocr must be a bounded array', code: 'vision-ocr-invalid' };
    }
    var ocr = [];
    for (var ocrIndex = 0; ocrIndex < value.ocr.length; ocrIndex += 1) {
      var ocrRow = value.ocr[ocrIndex];
      var ocrText = typeof ocrRow?.text === 'string' ? ocrRow.text.trim() : '';
      var ocrConfidence = asConfidence(ocrRow?.confidence);
      var ocrKeys = ocrRow && typeof ocrRow === 'object' ? Object.keys(ocrRow) : [];
      if (!ocrRow || typeof ocrRow !== 'object' || !ocrText || ocrText.length > 180
          || ocrConfidence == null || ocrKeys.length !== 2
          || ocrKeys.some(function(key) { return key !== 'text' && key !== 'confidence'; })) {
        return { ok: false, error: 'ocr row invalid', code: 'vision-ocr-invalid' };
      }
      ocr.push({ text: ocrText, confidence: ocrConfidence });
    }

    var observations = validateLayerRows(value.observations, { label: 'observations', max: 8, textLimit: 240 });
    if (!observations.ok) return { ok: false, error: observations.error, code: 'vision-observations-invalid' };
    if (status === 'observed' && observations.value.length === 0) {
      return { ok: false, error: 'observed response has no observations', code: 'vision-observations-empty' };
    }
    var interpretations = validateLayerRows(value.interpretations, {
      label: 'interpretations', max: 6, textLimit: 240, refsKey: 'observation_ids'
    });
    if (!interpretations.ok) return { ok: false, error: interpretations.error, code: 'vision-interpretations-invalid' };
    for (var i = 0; i < interpretations.value.length; i += 1) {
      if (interpretations.value[i].observation_ids.some(function(id) { return !observations.ids.has(id); })) {
        return { ok: false, error: 'interpretation has unknown observation', code: 'vision-reference-invalid' };
      }
    }
    var implications = validateLayerRows(value.implications, {
      label: 'implications', max: 6, textLimit: 240, refsKey: 'interpretation_ids', kind: true
    });
    if (!implications.ok) return { ok: false, error: implications.error, code: 'vision-implications-invalid' };
    for (var j = 0; j < implications.value.length; j += 1) {
      if (implications.value[j].interpretation_ids.some(function(id) { return !interpretations.ids.has(id); })) {
        return { ok: false, error: 'implication has unknown interpretation', code: 'vision-reference-invalid' };
      }
    }

    if (!Array.isArray(value.uncertainties) || value.uncertainties.length > 8) {
      return { ok: false, error: 'uncertainties must be a bounded array', code: 'vision-uncertainties-invalid' };
    }
    var knownIds = new Set();
    observations.value.concat(interpretations.value, implications.value).forEach(function(row) { knownIds.add(row.id); });
    var uncertaintyIds = new Set();
    var uncertainties = [];
    for (var k = 0; k < value.uncertainties.length; k += 1) {
      var uncertainty = value.uncertainties[k];
      var uncertaintyId = normalizeId(uncertainty?.id);
      var question = compact(uncertainty?.question, 220);
      var impact = String(uncertainty?.impact || '').trim().toLowerCase();
      var relatedIds = Array.isArray(uncertainty?.related_ids)
        ? uncertainty.related_ids.map(function(id) { return normalizeId(id); }).filter(Boolean).slice(0, 8)
        : [];
      if (!uncertaintyId || uncertaintyIds.has(uncertaintyId) || !question || IMPACTS.indexOf(impact) === -1) {
        return { ok: false, error: 'uncertainty row invalid', code: 'vision-uncertainties-invalid' };
      }
      if (relatedIds.some(function(id) { return !knownIds.has(id); })) {
        return { ok: false, error: 'uncertainty has unknown reference', code: 'vision-reference-invalid' };
      }
      uncertaintyIds.add(uncertaintyId);
      uncertainties.push({ id: uncertaintyId, question: question, impact: impact, related_ids: relatedIds });
    }
    if (status === 'insufficient' && uncertainties.length === 0) {
      return { ok: false, error: 'insufficient response needs uncertainty', code: 'vision-uncertainties-empty' };
    }
    if (projectRole === 'unknown' && uncertainties.length === 0) {
      return { ok: false, error: 'unknown project role needs uncertainty', code: 'vision-uncertainties-empty' };
    }

    return {
      ok: true,
      value: {
        schema: SCHEMA,
        vision_id: visionId,
        status: status,
        capture_kind: captureKind,
        project_role: projectRole,
        project_role_confidence: projectRoleConfidence,
        ocr: ocr,
        observations: observations.value,
        interpretations: interpretations.value,
        implications: implications.value,
        uncertainties: uncertainties
      }
    };
  }

  function collectTextCandidates(input) {
    var output = [];
    var seen = new Set();
    var preferredKeys = [
      'response', 'text', 'output', 'answer', 'body', 'summary', 'caption',
      'content', 'message', 'data', 'result', 'results', 'candidate',
      'candidates', 'parts', 'blocks', 'segments'
    ];
    function add(value) {
      var text = String(value || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      output.push(text);
    }
    function visit(value, depth) {
      if (value == null || depth > 6) return;
      if (typeof value === 'string') {
        add(value);
        var parsed = parseJsonObject(value);
        if (parsed && !(parsed.schema && parsed.vision_id)) visit(parsed, depth + 1);
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 20).forEach(function(item) { visit(item, depth + 1); });
        return;
      }
      if (typeof value !== 'object') return;
      if (value.schema && value.vision_id) add(JSON.stringify(value));
      preferredKeys.forEach(function(key) {
        if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key], depth + 1);
      });
    }
    visit(input, 0);
    return output;
  }

  function collectStreamFragments(input) {
    var output = [];
    var seen = new Set();
    var fragmentKeys = [
      'response', 'text', 'output', 'answer', 'body', 'content', 'message',
      'data', 'result', 'results', 'candidate', 'candidates', 'parts', 'blocks', 'segments'
    ];
    function add(value) {
      var text = String(value || '');
      if (!text || seen.has(text)) return;
      seen.add(text);
      output.push(text);
    }
    function visit(value, depth) {
      if (value == null || depth > 6) return;
      if (typeof value === 'string') {
        add(value);
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 20).forEach(function(item) { visit(item, depth + 1); });
        return;
      }
      if (typeof value !== 'object') return;
      if (value.schema && value.vision_id) add(JSON.stringify(value));
      fragmentKeys.forEach(function(key) {
        if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key], depth + 1);
      });
    }
    visit(input, 0);
    return output;
  }

  function createCollector(expectedVisionId, options) {
    var opts = options || {};
    var maxMessages = Number(opts.maxMessages || MAX_MESSAGES);
    var maxChars = Number(opts.maxCollectedChars || MAX_COLLECTED_CHARS);
    var messages = [];
    var fragments = [];
    var collectedChars = 0;
    var statusHistory = [];
    var lastFailure = null;

    function feed(data) {
      var status = String(data && typeof data === 'object' ? (data.status || '') : '').trim().toLowerCase();
      if (status && statusHistory.indexOf(status) === -1) statusHistory.push(status);
      var candidates = collectTextCandidates(data);
      var streamFragments = collectStreamFragments(data);
      var raw = '';
      try { raw = typeof data === 'string' ? data : JSON.stringify(data || {}); } catch (_) {}
      messages.push({ status: status, raw: compact(raw, 1200), candidateCount: candidates.length });
      if (messages.length > maxMessages) messages.shift();

      for (var fragmentIndex = 0; fragmentIndex < streamFragments.length; fragmentIndex += 1) {
        var fragment = streamFragments[fragmentIndex];
        if (collectedChars + fragment.length <= maxChars) {
          fragments.push(fragment);
          collectedChars += fragment.length;
        }
      }

      for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i];
        var direct = validateVisionEnvelope(candidate, expectedVisionId);
        if (direct.ok) return { done: true, matched: true, envelope: direct.value, candidate: candidate };
        lastFailure = direct;
      }

      var joinedCandidates = [];
      if (fragments.length > 1) {
        var firstSuffix = Math.max(0, fragments.length - maxMessages);
        for (var suffixStart = firstSuffix; suffixStart < fragments.length - 1; suffixStart += 1) {
          joinedCandidates.push(fragments.slice(suffixStart).join(''));
          joinedCandidates.push(fragments.slice(suffixStart).join('\n'));
        }
      }
      for (var j = 0; j < joinedCandidates.length; j += 1) {
        var joined = validateVisionEnvelope(joinedCandidates[j], expectedVisionId);
        if (joined.ok) return { done: true, matched: true, envelope: joined.value, candidate: joinedCandidates[j] };
        lastFailure = joined;
      }
      return {
        done: false,
        matched: false,
        statusOnly: !!status && candidates.length === 0,
        reason: lastFailure?.code || (status ? 'vision-status' : 'vision-pending')
      };
    }

    return Object.freeze({
      feed: feed,
      snapshot: function() {
        return {
          expectedVisionId: expectedVisionId,
          messages: messages.slice(),
          fragments: fragments.slice(),
          statusHistory: statusHistory.slice(),
          collectedChars: collectedChars,
          lastFailure: lastFailure
        };
      }
    });
  }

  function observationSummary(envelope) {
    var value = envelope && typeof envelope === 'object' ? envelope : {};
    var texts = (value.observations || []).map(function(row) { return compact(row?.text, 180); }).filter(Boolean);
    return texts.slice(0, 2).join(' ');
  }

  function toUncertaintyItems(envelope, context) {
    var value = envelope && typeof envelope === 'object' ? envelope : {};
    var meta = context && typeof context === 'object' ? context : {};
    return (value.uncertainties || []).map(function(item) {
      return {
        id: normalizeId(value.vision_id + '_' + item.id),
        kind: 'vision_uncertainty',
        status: 'open',
        question: item.question,
        impact: item.impact,
        related_ids: item.related_ids.slice(),
        source: {
          captureId: String(meta.captureId || ''),
          nodeId: String(meta.nodeId || ''),
          visionId: String(value.vision_id || '')
        },
        branchId: String(meta.branchId || 'main'),
        createdAt: meta.createdAt || new Date().toISOString(),
        resolvedAt: null,
        resolution: null
      };
    });
  }

  return {
    SCHEMA: SCHEMA,
    CAPTURE_KINDS: CAPTURE_KINDS,
    PROJECT_ROLES: PROJECT_ROLES,
    IMPLICATION_KINDS: IMPLICATION_KINDS,
    IMPACTS: IMPACTS,
    createVisionId: createVisionId,
    buildRabbitPayload: buildRabbitPayload,
    buildVisionPrompt: buildVisionPrompt,
    extractVisionIdFromPrompt: extractVisionIdFromPrompt,
    formatImageInput: formatImageInput,
    parseJsonObject: parseJsonObject,
    validateVisionEnvelope: validateVisionEnvelope,
    collectTextCandidates: collectTextCandidates,
    createCollector: createCollector,
    observationSummary: observationSummary,
    toUncertaintyItems: toUncertaintyItems
  };
});
