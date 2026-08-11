/**
 * device-lab.js -- privacy-safe physical R1 proof recorder.
 *
 * The recorder is inert in ordinary production sessions. Enable it with
 * `?lab=1`, `#lab`, or the existing `?debug=1#probe` diagnostic route.
 * Proofs contain only stable IDs, boolean flags, numeric measurements, and
 * lifecycle/input event names. Project copy, transcripts, prompts, images,
 * bridge payloads, response text, and credentials are never retained.
 */
(function() {
  'use strict';

  var SCHEMA = 'structa.device-proof.v1';
  var STORAGE_KEY = 'structa.device-proof.v1.active';
  var SESSION_TTL_MS = 2 * 60 * 60 * 1000;
  var MAX_EVENTS = 1600;
  var MAX_TRANSPORT_BODY = 2700;
  var MAX_TRANSPORT_PARTS = 48;
  var DANGEROUS_KEY = /(?:token|secret|auth|credential|cookie|key)/i;
  var SEMANTIC_ID_KEYS = Object.freeze({
    action_id: true,
    active_project_id: true,
    capture_id: true,
    check_id: true,
    comment_id: true,
    completion_id: true,
    correlation_id: true,
    entry_id: true,
    event_id: true,
    flow_id: true,
    from_id: true,
    from_step_id: true,
    image_run_id: true,
    input_id: true,
    item_id: true,
    job_id: true,
    mode_id: true,
    name_id: true,
    node_id: true,
    operation_id: true,
    outcome_id: true,
    plugin_id: true,
    previous_provider_slot_id: true,
    project_id: true,
    provider_slot_id: true,
    reason_id: true,
    request_id: true,
    source_id: true,
    state_id: true,
    status_id: true,
    to_id: true,
    to_step_id: true,
    type_id: true,
    vision_id: true
  });
  var params = new URLSearchParams(window.location.search || '');
  var hash = String(window.location.hash || '').toLowerCase();
  var routeEnabled = params.get('lab') === '1' || hash === '#lab' || (params.get('debug') === '1' && hash === '#probe');
  var enabled = routeEnabled;
  var proof = null;
  var listenersInstalled = false;
  var bridgeWrapped = false;
  var inboundWrapped = false;
  var storageAvailable = false;
  var controlInstalled = false;
  var lastMotionAt = 0;
  var resumeAbandonedDelta = 0;
  var provider = {
    active: [],
    outbound: 0,
    completed: 0,
    abandoned: 0,
    maxInFlight: 0,
    violations: 0,
    anonymousSequence: 0
  };

  function now() {
    return Date.now();
  }

  function clone(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  }

  function safeToken(value, limit) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    var max = Number(limit || 96);
    if (!text || text.length > max) return '';
    if (!/^[A-Za-z0-9._:-]+$/.test(text)) return '';
    return text;
  }

  function safeKey(value) {
    var token = String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
    return safeToken(token, 64);
  }

  function semanticIdKey(value) {
    var key = safeKey(value);
    if (!key || DANGEROUS_KEY.test(key)) return '';
    var candidate = /_id$/.test(key) ? key : key + '_id';
    return SEMANTIC_ID_KEYS[candidate] ? candidate : '';
  }

  function safeStep(value) {
    return safeToken(value, 64) || 'unassigned';
  }

  function finiteNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function randomId() {
    var date = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
    var suffix = '';
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        suffix = window.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        return 'ST-' + date + '-' + suffix;
      }
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(4);
        window.crypto.getRandomValues(bytes);
        suffix = Array.from(bytes, function(entry) {
          return entry.toString(16).padStart(2, '0');
        }).join('');
        return 'ST-' + date + '-' + suffix;
      }
    } catch (_) {}
    suffix = (now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(-8);
    return 'ST-' + date + '-' + suffix;
  }

  function availableServerBuildSha() {
    var direct = safeToken(window.StructaBuild && window.StructaBuild.serverBuildSha, 96);
    if (direct) return direct;
    try {
      var status = window.StructaDiagnostics && typeof window.StructaDiagnostics.getState === 'function'
        ? window.StructaDiagnostics.getState().buildStatus
        : null;
      return safeToken(status && status.serverBuildSha, 96);
    } catch (_) {
      return '';
    }
  }

  function hasDeployServerSha(value) {
    var token = safeToken(value, 96);
    return !!token && !/^(?:unavailable|workspace|unknown)$/i.test(token);
  }

  function buildSnapshot() {
    var build = window.StructaBuild || {};
    return {
      ui_build_id: safeToken(build.uiBuildId || 'ui-unknown', 96) || 'ui-unknown',
      diagnostics_asset_id: safeToken(build.expectedDiagnosticsAssetId || 'diag-unknown', 96) || 'diag-unknown',
      asset_epoch_id: safeToken(build.assetEpoch || 'base', 64) || 'base',
      proof_schema_id: SCHEMA,
      server_build_sha: availableServerBuildSha() || 'unavailable'
    };
  }

  function refreshBuildMetadata() {
    if (!proof || proof.status !== 'running' || !proof.build) return;
    var sha = availableServerBuildSha();
    if (sha) proof.build.server_build_sha = sha;
  }

  function buildId() {
    return buildSnapshot().ui_build_id;
  }

  function normalizeFields(input) {
    var source = input && typeof input === 'object' ? input : {};
    var ids = {};
    var flags = {};
    var metrics = {};
    Object.keys(source).slice(0, 48).forEach(function(rawKey) {
      var value = source[rawKey];
      var key = safeKey(rawKey);
      if (!key || DANGEROUS_KEY.test(key)) return;
      if (typeof value === 'boolean') {
        flags[key] = value;
        return;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        metrics[key] = value;
        return;
      }
      var idKey = semanticIdKey(key);
      if (idKey) {
        var token = safeToken(value, 96);
        if (token) ids[idKey] = token;
      }
    });
    var result = {};
    if (Object.keys(ids).length) result.ids = ids;
    if (Object.keys(flags).length) result.flags = flags;
    if (Object.keys(metrics).length) result.metrics = metrics;
    return result;
  }

  function eventCounts() {
    var counts = {};
    if (!proof || !Array.isArray(proof.events)) return counts;
    proof.events.forEach(function(entry) {
      counts[entry.type] = Number(counts[entry.type] || 0) + 1;
    });
    return counts;
  }

  function sequenceInvariant() {
    if (!proof || !Array.isArray(proof.events)) return false;
    var previousMs = -1;
    for (var index = 0; index < proof.events.length; index += 1) {
      var event = proof.events[index];
      if (event.seq !== index + 1) return false;
      if (!Number.isFinite(event.ms) || event.ms < previousMs) return false;
      if (event.session_id !== proof.session_id || event.build !== proof.build.ui_build_id) return false;
      previousMs = event.ms;
    }
    return true;
  }

  function eventId(event, key) {
    return safeToken(event && event.ids && event.ids[key], 96);
  }

  function eventFlag(event, key) {
    return !!(event && event.flags && event.flags[key] === true);
  }

  function eventMetric(event, key) {
    var value = event && event.metrics ? Number(event.metrics[key]) : 0;
    return Number.isFinite(value) ? value : 0;
  }

  function traceMatches(event, flow, from, to) {
    if (!event || event.type !== 'structa.trace') return false;
    if (flow && eventId(event, 'flow_id').toLowerCase() !== flow) return false;
    if (from && eventId(event, 'from_id').toLowerCase() !== from) return false;
    if (to && eventId(event, 'to_id').toLowerCase() !== to) return false;
    return true;
  }

  function deriveProvider(events) {
    var active = [];
    var outbound = 0;
    var completed = 0;
    var abandoned = 0;
    var maxInFlight = 0;
    var violations = 0;
    (events || []).forEach(function(event) {
      if (event.type === 'session.resume') {
        var newlyAbandoned = Math.max(0, eventMetric(event, 'abandoned_requests'));
        abandoned += newlyAbandoned;
        if (newlyAbandoned > 0) active.splice(0, Math.min(active.length, newlyAbandoned));
        return;
      }
      if (event.type === 'bridge.outbound' && eventFlag(event, 'provider_call')) {
        var slot = eventId(event, 'provider_slot_id') || ('missing-slot-' + event.seq);
        active.push(slot);
        outbound += 1;
        maxInFlight = Math.max(maxInFlight, active.length);
        if (active.length > 1) violations += 1;
        return;
      }
      if (event.type === 'provider.associate') {
        var previous = eventId(event, 'previous_provider_slot_id');
        var associated = eventId(event, 'provider_slot_id');
        var associateIndex = active.indexOf(previous);
        if (associateIndex >= 0 && associated) active[associateIndex] = associated;
        return;
      }
      if (event.type === 'provider.complete') {
        var completedSlot = eventId(event, 'provider_slot_id');
        var completeIndex = active.indexOf(completedSlot);
        if (completeIndex >= 0) {
          active.splice(completeIndex, 1);
          completed += 1;
        }
      }
    });
    return {
      outbound: outbound,
      completed: completed,
      abandoned: abandoned,
      outstanding: active.length,
      observed_max_in_flight: maxInFlight,
      overlap_violations: violations
    };
  }

  function sameIdSet(left, right) {
    var a = Array.from(new Set((left || []).filter(Boolean))).sort();
    var b = Array.from(new Set((right || []).filter(Boolean))).sort();
    return a.length === b.length && a.every(function(value, index) { return value === b[index]; });
  }

  function deriveAutomaticInvariants(current, providerSummary, errorCount) {
    var events = Array.isArray(current.events) ? current.events : [];
    var stepObserved = function(step) {
      return events.some(function(event) { return event.step_id === step; });
    };
    var requiredSteps = ['B00', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07'];
    var observedStepCount = requiredSteps.filter(stepObserved).length;
    var b02 = stepObserved('B02');
    var b04 = stepObserved('B04');
    var b06 = stepObserved('B06');
    var b04Events = events.filter(function(event) { return event.step_id === 'B04'; });
    var finishEvent = events.slice().reverse().find(function(event) { return event.type === 'session.finish'; }) || null;
    var finishSeq = finishEvent ? finishEvent.seq : Infinity;
    var transportOutbound = events.filter(function(event) {
      return event.type === 'bridge.outbound' && event.seq <= finishSeq;
    });

    var visionRequests = b04Events.filter(function(event) {
      return traceMatches(event, 'vision.analysis', 'saved', 'requested');
    });
    var visionPosted = b04Events.filter(function(event) {
      return traceMatches(event, 'vision.bridge', 'prepare', 'posted');
    });
    var visionParsed = b04Events.filter(function(event) {
      return traceMatches(event, 'plugin.message.parsed', 'in', 'vision');
    });
    var visionStored = b04Events.filter(function(event) {
      return traceMatches(event, 'vision.analysis', 'requested', 'stored');
    });
    var visionUnavailable = b04Events.filter(function(event) {
      return traceMatches(event, 'vision.analysis', 'requested', 'unavailable');
    });
    var requestIds = visionRequests.map(function(event) { return eventId(event, 'vision_id'); });
    var postedIds = visionPosted.map(function(event) { return eventId(event, 'vision_id'); });
    var parsedIds = visionParsed.map(function(event) { return eventId(event, 'vision_id'); });
    var storedIds = visionStored.map(function(event) { return eventId(event, 'vision_id'); });
    var unavailableIds = visionUnavailable.map(function(event) { return eventId(event, 'vision_id'); });

    var captureOrderPass = visionRequests.every(function(request) {
      var captureId = eventId(request, 'capture_id');
      if (!captureId) return false;
      return events.some(function(candidate) {
        if (candidate.seq >= request.seq || candidate.type !== 'camera.event') return false;
        if (eventId(candidate, 'event_id') !== 'structa-capture-stored') return false;
        return eventId(candidate, 'entry_id') === captureId || eventId(candidate, 'capture_id') === captureId;
      });
    });
    var requestCounts = {};
    var postCounts = {};
    var parseCounts = {};
    var storeCounts = {};
    var unavailableCounts = {};
    requestIds.forEach(function(id) { if (id) requestCounts[id] = Number(requestCounts[id] || 0) + 1; });
    postedIds.forEach(function(id) { if (id) postCounts[id] = Number(postCounts[id] || 0) + 1; });
    parsedIds.forEach(function(id) { if (id) parseCounts[id] = Number(parseCounts[id] || 0) + 1; });
    storedIds.forEach(function(id) { if (id) storeCounts[id] = Number(storeCounts[id] || 0) + 1; });
    unavailableIds.forEach(function(id) { if (id) unavailableCounts[id] = Number(unavailableCounts[id] || 0) + 1; });
    var parsePass = visionParsed.every(function(event) {
      var visionId = eventId(event, 'vision_id');
      if (!visionId) return false;
      return parseCounts[visionId] <= 1;
    });
    var chainIdsValid = requestIds.every(Boolean) && postedIds.every(Boolean) && parsedIds.every(Boolean) && storedIds.every(Boolean);
    var chainDuplicate = [requestCounts, postCounts, parseCounts, storeCounts].some(function(counts) {
      return Object.values(counts).some(function(count) { return count > 1; });
    });
    var chainExtraId = postedIds.concat(parsedIds, storedIds, unavailableIds).some(function(id) { return !!id && !requestCounts[id]; });
    var chainMissingStage = Object.keys(requestCounts).some(function(id) {
      return !postCounts[id] || !parseCounts[id] || !storeCounts[id];
    });
    var idChainPass = requestIds.length === 0
      ? (b04 ? null : true)
      : (!chainIdsValid || chainDuplicate || chainExtraId ? false : (chainMissingStage ? null : true));

    var requestCaptureIds = visionRequests.map(function(event) { return eventId(event, 'capture_id'); });
    var uniqueCaptureIds = Array.from(new Set(requestCaptureIds.filter(Boolean)));
    var matrixInvalid = 0;
    if (!requestIds.every(Boolean) || !requestCaptureIds.every(Boolean) || !postedIds.every(Boolean) || !parsedIds.every(Boolean) || !storedIds.every(Boolean) || !unavailableIds.every(Boolean)) matrixInvalid += 1;
    if (uniqueCaptureIds.length !== requestCaptureIds.length) matrixInvalid += 1;
    if (chainDuplicate || chainExtraId) matrixInvalid += 1;
    var matrixSuccess = 0;
    var matrixDegraded = 0;
    var matrixOpen = 0;
    Object.keys(requestCounts).forEach(function(id) {
      var requestCount = requestCounts[id] || 0;
      var postedCount = postCounts[id] || 0;
      var parsedCount = parseCounts[id] || 0;
      var storedCount = storeCounts[id] || 0;
      var unavailableCount = unavailableCounts[id] || 0;
      if (requestCount > 1 || postedCount > 1 || parsedCount > 1 || storedCount > 1 || unavailableCount > 1 || (storedCount && unavailableCount)) {
        matrixInvalid += 1;
        return;
      }
      if (requestCount === 1 && postedCount === 1 && parsedCount === 1 && storedCount === 1 && unavailableCount === 0) {
        matrixSuccess += 1;
      } else if (requestCount === 1 && postedCount === 1 && parsedCount === 0 && storedCount === 0 && unavailableCount === 1) {
        matrixDegraded += 1;
      } else {
        matrixOpen += 1;
      }
    });
    var matrixPass = !b04 && !visionRequests.length
      ? true
      : (matrixInvalid > 0
          ? false
          : (uniqueCaptureIds.length < 20 || matrixOpen > 0
              ? null
              : (uniqueCaptureIds.length === 20 && matrixSuccess >= 18 && matrixDegraded <= 2 && matrixSuccess + matrixDegraded === 20)));

    var pressEvents = events.filter(function(event) {
      if (event.step_id !== 'B02' || event.type !== 'hardware.input') return false;
      var input = eventId(event, 'input_id');
      return /^(?:pttStart|pttEnd|longPressStart|longPressEnd)$/.test(input);
    });
    var pressStack = [];
    var pressViolations = 0;
    var pressStarts = 0;
    pressEvents.forEach(function(event) {
      var input = eventId(event, 'input_id');
      if (input === 'pttStart' || input === 'longPressStart') {
        pressStack.push(input === 'pttStart' ? 'ptt' : 'longPress');
        pressStarts += 1;
      } else {
        var endType = input === 'pttEnd' ? 'ptt' : 'longPress';
        if (pressStack.length && pressStack[pressStack.length - 1] === endType) {
          pressStack.pop();
        } else {
          pressViolations += 1;
        }
      }
    });

    var queueObserved = !!(finishEvent && eventFlag(finishEvent, 'queue_observed'));
    var queueRunning = finishEvent ? eventMetric(finishEvent, 'queue_running') : 0;
    var queuePending = finishEvent ? eventMetric(finishEvent, 'queue_pending') : 0;
    var queueBlocked = finishEvent ? eventMetric(finishEvent, 'queue_blocked') : 0;
    var finished = current.status !== 'running';
    var settledPass = finished
      ? providerSummary.outstanding === 0 && providerSummary.abandoned === 0
      : null;

    return [
      { id: 'event.sequence_monotonic', pass: sequenceInvariant() },
      {
        id: 'provider.single_inflight',
        pass: providerSummary.overlap_violations === 0 && providerSummary.observed_max_in_flight <= 1,
        observed: providerSummary.observed_max_in_flight,
        violations: providerSummary.overlap_violations
      },
      {
        id: 'provider.settled_at_finish',
        pass: settledPass,
        outstanding: providerSummary.outstanding,
        abandoned: providerSummary.abandoned
      },
      { id: 'runtime.no_uncaught_errors', pass: errorCount === 0, observed: errorCount },
      { id: 'storage.session_persistent', pass: storageAvailable },
      { id: 'build.server_sha_available', pass: hasDeployServerSha(current.build.server_build_sha) },
      {
        id: 'coverage.phase_sequence',
        pass: observedStepCount === requiredSteps.length ? true : null,
        observed: observedStepCount,
        required: requiredSteps.length
      },
      {
        id: 'transport.no_speaker_request',
        pass: !transportOutbound.length ? null : !transportOutbound.some(function(event) { return eventFlag(event, 'wants_r1_response'); }),
        observed: transportOutbound.length
      },
      {
        id: 'transport.no_journal_request',
        pass: !transportOutbound.length ? null : !transportOutbound.some(function(event) { return eventFlag(event, 'wants_journal_entry'); }),
        observed: transportOutbound.length
      },
      {
        id: 'vision.capture_precedes_request',
        pass: b04 && !visionRequests.length ? null : captureOrderPass,
        observed: visionRequests.length
      },
      {
        id: 'vision.single_parse_per_id',
        pass: b04 && !visionParsed.length ? null : parsePass,
        observed: visionParsed.length
      },
      {
        id: 'vision.id_chain_matches',
        pass: idChainPass,
        observed: requestIds.length
      },
      {
        id: 'vision.b04_matrix',
        pass: matrixPass,
        captures: uniqueCaptureIds.length,
        success: matrixSuccess,
        degraded: matrixDegraded,
        invalid: matrixInvalid,
        open: matrixOpen
      },
      {
        id: 'input.b02_press_pairs',
        pass: b02 && !pressEvents.length ? null : (pressViolations === 0 && pressStack.length === 0),
        observed: pressStarts,
        violations: pressViolations + pressStack.length
      },
      {
        id: 'queue.settled_at_finish',
        pass: queueObserved ? queueRunning === 0 && queuePending === 0 && queueBlocked === 0 : (b06 || finished ? null : true),
        running: queueRunning,
        pending: queuePending,
        blocked: queueBlocked
      },
      { id: 'telemetry.content_free', pass: true }
    ];
  }

  function refreshSummary() {
    if (!proof) return;
    refreshBuildMetadata();
    var counts = eventCounts();
    var manualTotal = Number(counts['manual.check'] || 0);
    var manualPassed = proof.events.filter(function(entry) {
      return entry.type === 'manual.check' && entry.flags && entry.flags.passed === true;
    }).length;
    var errorCount = Number(counts['runtime.error'] || 0) + Number(counts['runtime.rejection'] || 0) + Number(counts['bridge.post_error'] || 0);
    var providerSummary = deriveProvider(proof.events);
    proof.summary = {
      event_count: proof.events.length,
      counts: counts,
      manual: {
        total: manualTotal,
        passed: manualPassed,
        failed: manualTotal - manualPassed
      },
      provider: providerSummary,
      invariants: deriveAutomaticInvariants(proof, providerSummary, errorCount)
    };
  }

  function persist() {
    if (!proof) return false;
    try {
      storageAvailable = true;
      refreshSummary();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(proof));
      return true;
    } catch (_) {
      storageAvailable = false;
      refreshSummary();
      return false;
    }
  }

  function restoreProof() {
    var parsed = null;
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      storageAvailable = true;
      if (!raw) return null;
      parsed = JSON.parse(raw);
    } catch (_) {
      storageAvailable = false;
      return null;
    }
    if (!parsed || parsed.schema !== SCHEMA || !['running', 'passed', 'failed', 'complete'].includes(parsed.status)) return null;
    if (!parsed.build) return null;
    var startedMs = Date.parse(parsed.started_at || '');
    var expiresMs = Date.parse(parsed.expires_at || '');
    if (!Number.isFinite(startedMs) || !Number.isFinite(expiresMs)) return null;
    if (parsed.status === 'running') {
      if (parsed.build.ui_build_id !== buildId()) return null;
      if (now() < startedMs || now() > expiresMs || now() - startedMs > SESSION_TTL_MS) return null;
    }
    if (!Array.isArray(parsed.events) || !safeToken(parsed.session_id, 96)) return null;
    parsed.step_id = safeStep(parsed.step_id);
    parsed.events = parsed.events.slice(-MAX_EVENTS);
    var previousProvider = parsed.summary && parsed.summary.provider ? parsed.summary.provider : {};
    resumeAbandonedDelta = parsed.status === 'running' ? Number(previousProvider.outstanding || 0) : 0;
    provider.outbound = Number(previousProvider.outbound || 0);
    provider.completed = Number(previousProvider.completed || 0);
    provider.abandoned = Number(previousProvider.abandoned || 0) + (parsed.status === 'running' ? Number(previousProvider.outstanding || 0) : 0);
    provider.maxInFlight = Number(previousProvider.observed_max_in_flight || 0);
    provider.violations = Number(previousProvider.overlap_violations || 0);
    provider.active = parsed.status === 'running'
      ? []
      : Array.from({ length: Number(previousProvider.outstanding || 0) }, function(_, index) {
          return { id: 'archived-outstanding-' + (index + 1) };
        });
    return parsed;
  }

  function newProof(stepId) {
    var started = now();
    provider.active = [];
    provider.outbound = 0;
    provider.completed = 0;
    provider.abandoned = 0;
    provider.maxInFlight = 0;
    provider.violations = 0;
    provider.anonymousSequence = 0;
    resumeAbandonedDelta = 0;
    return {
      schema: SCHEMA,
      session_id: randomId(),
      status: 'running',
      started_at: new Date(started).toISOString(),
      expires_at: new Date(started + SESSION_TTL_MS).toISOString(),
      finished_at: null,
      step_id: safeStep(stepId || 'B00'),
      build: buildSnapshot(),
      events: [],
      summary: {}
    };
  }

  function record(type, fields, force) {
    if (!enabled || !proof || (!force && proof.status !== 'running')) return null;
    var startedMs = Date.parse(proof.started_at || '') || now();
    var normalized = normalizeFields(fields);
    var entry = {
      session_id: proof.session_id,
      seq: proof.events.length + 1,
      ms: Math.max(0, now() - startedMs),
      at: new Date(now()).toISOString(),
      step_id: safeStep(proof.step_id),
      build: proof.build.ui_build_id,
      type: safeToken(type, 72) || 'runtime.event'
    };
    if (normalized.ids) entry.ids = normalized.ids;
    if (normalized.flags) entry.flags = normalized.flags;
    if (normalized.metrics) entry.metrics = normalized.metrics;
    proof.events.push(entry);
    if (proof.events.length > MAX_EVENTS) {
      proof.events = proof.events.slice(proof.events.length - MAX_EVENTS);
      proof.events.forEach(function(event, index) { event.seq = index + 1; });
    }
    persist();
    return clone(entry);
  }

  function findIdentifier(value, depth) {
    if (!value || depth > 3) return '';
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (trimmed.charAt(0) === '{' && trimmed.length < 20000) {
        try { return findIdentifier(JSON.parse(trimmed), depth + 1); } catch (_) {}
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    var directKeys = ['correlationId', 'requestId', 'visionId', 'imageRunId'];
    for (var index = 0; index < directKeys.length; index += 1) {
      var candidate = safeToken(value[directKeys[index]], 96);
      if (candidate) return candidate;
    }
    if (value.data && typeof value.data === 'object') {
      var dataIdentifier = findIdentifier(value.data, depth + 1);
      if (dataIdentifier) return dataIdentifier;
    }
    if (value.payload && typeof value.payload === 'object') return findIdentifier(value.payload, depth + 1);
    return '';
  }

  function outboundValue(payload, key) {
    if (payload && payload[key] !== undefined) return payload[key];
    if (payload && payload.payload && typeof payload.payload === 'object') return payload.payload[key];
    return undefined;
  }

  function responseFlags(value, depth) {
    var result = { stt: false, response: false, error: false, terminal: false };
    if (!value || depth > 3) return result;
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (!trimmed) return result;
      if (trimmed.charAt(0) === '{' && trimmed.length < 20000) {
        try { return responseFlags(JSON.parse(trimmed), depth + 1); } catch (_) {}
      }
      result.response = true;
      result.terminal = true;
      return result;
    }
    if (typeof value !== 'object') return result;
    var type = safeToken(value.type, 48).toLowerCase();
    result.stt = type === 'sttended' || type === 'stt-ended';
    result.error = !!value.error;
    var responseKeys = ['response', 'text', 'output', 'answer', 'body', 'summary', 'caption', 'value', 'note_text', 'details', 'note', 'content'];
    result.response = responseKeys.some(function(key) {
      var candidate = value[key];
      return typeof candidate === 'string' && candidate.trim().length > 0;
    });
    var status = safeToken(value.status, 32).toLowerCase();
    var terminalStatus = /^(?:complete|completed|done|success|succeeded|failed|error|cancelled|canceled)$/.test(status);
    result.terminal = result.error || result.response || terminalStatus;
    if (!result.terminal && value.data && typeof value.data === 'object') {
      var nested = responseFlags(value.data, depth + 1);
      result.response = nested.response;
      result.error = nested.error;
      result.terminal = nested.terminal;
    }
    return result;
  }

  function parseOutbound(raw) {
    var payload = raw;
    if (typeof raw === 'string') {
      try { payload = JSON.parse(raw); } catch (_) { payload = {}; }
    }
    if (!payload || typeof payload !== 'object') payload = {};
    var identifier = findIdentifier(payload, 0);
    var useLLM = outboundValue(payload, 'useLLM') === true;
    var useSerpAPI = outboundValue(payload, 'useSerpAPI') === true;
    var nestedImage = outboundValue(payload, 'imageBase64');
    return {
      identifier: identifier,
      providerCall: useLLM || useSerpAPI,
      fields: {
        correlationId: safeToken(outboundValue(payload, 'correlationId'), 96),
        requestId: safeToken(outboundValue(payload, 'requestId'), 96),
        visionId: safeToken(outboundValue(payload, 'visionId'), 96),
        imageRunId: safeToken(outboundValue(payload, 'imageRunId'), 96),
        pluginId: safeToken(outboundValue(payload, 'pluginId'), 96),
        useLlm: useLLM,
        useSerpApi: useSerpAPI,
        wantsR1Response: outboundValue(payload, 'wantsR1Response') === true,
        wantsJournalEntry: outboundValue(payload, 'wantsJournalEntry') === true,
        hasImage: typeof nestedImage === 'string' && nestedImage.length > 0,
        providerCall: useLLM || useSerpAPI
      }
    };
  }

  function providerStart(identifier) {
    provider.anonymousSequence += 1;
    var slotId = safeToken(identifier, 96) || ('outbound-' + provider.anonymousSequence);
    provider.active.push({ id: slotId });
    provider.outbound += 1;
    provider.maxInFlight = Math.max(provider.maxInFlight, provider.active.length);
    if (provider.active.length > 1) provider.violations += 1;
    return slotId;
  }

  function providerComplete(identifier) {
    if (!provider.active.length) return false;
    var token = safeToken(identifier, 96);
    var index = token ? provider.active.findIndex(function(slot) { return slot.id === token; }) : -1;
    if (token && index < 0) {
      record('provider.mismatch', { completionId: token, matched: false });
      return false;
    }
    if (!token) {
      if (provider.active.length !== 1) {
        record('provider.mismatch', { ambiguous: true, matched: false });
        return false;
      }
      index = 0;
    }
    var completed = provider.active.splice(index, 1)[0];
    provider.completed += 1;
    record('provider.complete', {
      providerSlotId: completed && completed.id,
      completionId: token || (completed && completed.id),
      matched: true
    });
    return true;
  }

  function associateProvider(identifier) {
    var token = safeToken(identifier, 96);
    if (!token || !provider.active.length) return;
    if (provider.active.some(function(slot) { return slot.id === token; })) return;
    var unbound = provider.active.find(function(slot) { return /^outbound-/.test(slot.id); });
    if (unbound) {
      var previous = unbound.id;
      unbound.id = token;
      record('provider.associate', {
        previousProviderSlotId: previous,
        providerSlotId: token
      });
    }
  }

  function wrapBridge() {
    if (!enabled) return false;
    var bridge = window.PluginMessageHandler;
    if (!bridge || typeof bridge.postMessage !== 'function') return false;
    if (bridge.postMessage.__structaDeviceLabWrapped) {
      bridgeWrapped = true;
      return true;
    }
    var originalPost = bridge.postMessage;
    var wrappedPost = function(raw) {
      var outbound = parseOutbound(raw);
      if (outbound.providerCall) {
        outbound.fields.providerSlotId = providerStart(outbound.identifier);
      }
      record('bridge.outbound', outbound.fields);
      try {
        return originalPost.apply(this, arguments);
      } catch (error) {
        if (outbound.providerCall) providerComplete(outbound.identifier);
        record('bridge.post_error', {
          name: safeToken(error && error.name, 48) || 'Error',
          providerCall: outbound.providerCall
        });
        throw error;
      }
    };
    try {
      Object.defineProperty(wrappedPost, '__structaDeviceLabWrapped', { value: true });
      bridge.postMessage = wrappedPost;
      bridgeWrapped = bridge.postMessage === wrappedPost;
    } catch (_) {
      bridgeWrapped = false;
    }
    record('lab.bridge_wrapper', { installed: bridgeWrapped });
    return bridgeWrapped;
  }

  function wrapInbound() {
    if (!enabled) return false;
    var current = window.onPluginMessage;
    if (typeof current === 'function' && current.__structaDeviceLabWrapped) {
      inboundWrapped = true;
      return true;
    }
    var previous = typeof current === 'function' ? current : null;
    var wrapped = function(data) {
      var flags = responseFlags(data, 0);
      var identifier = findIdentifier(data, 0);
      record('bridge.inbound', {
        correlationId: identifier,
        stt: flags.stt,
        hasResponse: flags.response,
        hasError: flags.error,
        terminal: flags.terminal
      });
      if (!flags.stt && flags.terminal) providerComplete(identifier);
      if (previous) return previous.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrapped, '__structaDeviceLabWrapped', { value: true });
      window.onPluginMessage = wrapped;
      inboundWrapped = window.onPluginMessage === wrapped;
    } catch (_) {
      inboundWrapped = false;
    }
    record('lab.inbound_wrapper', { installed: inboundWrapped });
    return inboundWrapped;
  }

  function installBridgeWrappers() {
    wrapBridge();
    wrapInbound();
  }

  function traceFields(detail) {
    var source = detail && typeof detail === 'object' ? detail : {};
    var ctx = source.ctx && typeof source.ctx === 'object' ? source.ctx : {};
    var fields = {
      flow: safeToken(source.flow, 72),
      from: safeToken(source.from, 96),
      to: safeToken(source.to, 96)
    };
    Object.keys(ctx).slice(0, 32).forEach(function(key) {
      var normalized = safeKey(key);
      var value = ctx[key];
      if (!normalized) return;
      if (/_id$/.test(normalized) || /(?:^|_)(?:correlation|request|vision|entry|item|node|capture|project|operation|image_run)_id$/.test(normalized)) {
        fields[normalized] = safeToken(value, 96);
      } else if (typeof value === 'boolean') {
        fields[normalized] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        fields[normalized] = value;
      }
    });
    return fields;
  }

  function handleTrace(event) {
    var detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
    var fields = traceFields(detail);
    record('structa.trace', fields);
    var flow = safeToken(detail.flow, 72).toLowerCase();
    var to = safeToken(detail.to, 72).toLowerCase();
    var identifier = findIdentifier(detail.ctx || {}, 0);
    var tracedServerSha = safeToken(detail.ctx && detail.ctx.serverBuildSha, 96);
    if (tracedServerSha && proof && proof.status === 'running' && proof.build) {
      proof.build.server_build_sha = tracedServerSha;
      persist();
    }
    if (flow === 'vision.bridge' && to === 'posted') associateProvider(identifier);
    if (
      flow === 'plugin.message.parsed' ||
      ((flow === 'bridge' || flow === 'vision.bridge') && /^(?:timeout|failed|error|cancelled|canceled)$/.test(to))
    ) {
      providerComplete(identifier);
    }
  }

  function installControl() {
    if (controlInstalled || !enabled || !document.body) return;
    controlInstalled = true;
    var host = document.getElementById('app') || document.body;
    var trigger = document.createElement('button');
    var panel = document.createElement('section');
    var title = document.createElement('div');
    var status = document.createElement('div');
    var actions = document.createElement('div');
    var step = document.createElement('button');
    var buildCheck = document.createElement('button');
    var send = document.createElement('button');
    var journal = document.createElement('button');
    var reset = document.createElement('button');
    var close = document.createElement('button');

    trigger.id = 'structa-device-proof-control';
    trigger.type = 'button';
    trigger.textContent = 'proof';
    trigger.setAttribute('aria-label', 'open device proof controls');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.style.cssText = 'position:absolute;right:0;top:0;width:44px;height:44px;border:0;background:rgba(5,5,5,.72);color:rgba(244,239,228,.46);font:10px PowerGrotesk-Regular,sans-serif;letter-spacing:.04em;z-index:119;padding:0;pointer-events:auto;';

    panel.id = 'structa-device-proof-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'device proof controls');
    panel.setAttribute('aria-hidden', 'true');
    panel.style.cssText = 'position:absolute;inset:8px;z-index:120;display:none;box-sizing:border-box;overflow:hidden;flex-direction:column;gap:5px;padding:8px;background:#0b0b0b;border:1px solid rgba(244,239,228,.22);color:#f4efe4;font:12px PowerGrotesk-Regular,sans-serif;pointer-events:auto;';

    title.textContent = 'device proof';
    title.style.cssText = 'font-size:15px;letter-spacing:.02em;color:#f4efe4;';
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'height:24px;flex:0 0 24px;color:rgba(244,239,228,.64);font-size:10px;line-height:1.2;overflow:hidden;overflow-wrap:anywhere;';
    actions.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:5px;';

    [step, buildCheck, send, journal, reset, close].forEach(function(button) {
      button.type = 'button';
      button.style.cssText = 'min-height:44px;border:1px solid rgba(244,239,228,.16);background:rgba(244,239,228,.06);color:#f4efe4;font:11px PowerGrotesk-Regular,sans-serif;padding:0 8px;text-align:left;';
    });
    step.id = 'structa-device-proof-step';
    step.style.gridColumn = '1 / -1';
    buildCheck.id = 'structa-device-proof-build-check';
    buildCheck.textContent = 'check build';
    buildCheck.style.gridColumn = '1 / -1';
    send.id = 'structa-device-proof-send';
    send.textContent = 'finish + send';
    send.style.borderColor = 'rgba(255,138,101,.58)';
    journal.id = 'structa-device-proof-journal';
    journal.textContent = 'journal backup';
    reset.id = 'structa-device-proof-reset';
    reset.textContent = 'new session';
    close.id = 'structa-device-proof-close';
    close.textContent = 'close';

    function updateStatus(label) {
      var current = getProof();
      var eventCount = current && current.summary ? current.summary.event_count : 0;
      var currentStep = current ? safeStep(current.step_id) : 'B00';
      step.textContent = 'step · ' + currentStep;
      status.textContent = label || ((current ? current.session_id : 'no session') + ' · ' + currentStep + ' · ' + eventCount + ' events');
    }

    function stop(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    function setOpen(open) {
      panel.style.display = open ? 'flex' : 'none';
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) updateStatus();
    }

    trigger.addEventListener('click', function(event) {
      stop(event);
      var opening = panel.style.display === 'none';
      setOpen(opening);
      record('proof.control', { actionId: opening ? 'open' : 'close' });
    });
    close.addEventListener('click', function(event) {
      stop(event);
      setOpen(false);
      record('proof.control', { actionId: 'close' });
    });
    step.addEventListener('click', function(event) {
      stop(event);
      var current = getProof();
      var match = /^B0([0-7])$/.exec(current && current.step_id ? current.step_id : 'B00');
      var index = match ? Number(match[1]) : 0;
      var next = 'B0' + ((index + 1) % 8);
      setStep(next);
      updateStatus('proof step set to ' + next);
    });
    buildCheck.addEventListener('click', async function(event) {
      stop(event);
      buildCheck.disabled = true;
      updateStatus('checking build…');
      var diagnostics = window.StructaDiagnostics;
      if (!diagnostics || typeof diagnostics.handleAction !== 'function') {
        record('proof.control', { actionId: 'build-check', available: false });
        updateStatus('build check unavailable');
        buildCheck.disabled = false;
        return;
      }
      var response;
      try {
        response = await diagnostics.handleAction('diagnostics-build-check');
      } catch (_) {
        response = { ok: false };
      }
      var result = response && response.result ? response.result : {};
      var uiBuild = safeToken(result.uiBuildId || (window.StructaBuild && window.StructaBuild.uiBuildId), 96) || 'ui-unknown';
      var serverSha = safeToken(result.serverBuildSha, 96) || 'unavailable';
      var buildStatus = safeToken(result.status, 32) || (response && response.ok ? 'checked' : 'failed');
      var deployShaAvailable = hasDeployServerSha(serverSha);
      if (!deployShaAvailable) buildStatus = 'mismatch';
      if (proof && proof.status === 'running' && proof.build && deployShaAvailable) {
        proof.build.server_build_sha = serverSha;
        persist();
      }
      record('proof.control', {
        actionId: 'build-check',
        available: true,
        ok: !!(response && response.ok && deployShaAvailable),
        current: buildStatus === 'current' && deployShaAvailable
      });
      updateStatus('ui ' + uiBuild + ' · server ' + serverSha + ' · ' + buildStatus);
      buildCheck.disabled = false;
    });
    send.addEventListener('click', async function(event) {
      stop(event);
      send.disabled = true;
      updateStatus('finishing proof…');
      if (proof && proof.status === 'running') finish();
      var result = await exportProof();
      updateStatus(result.email && result.email.ok ? 'proof emailed' : (result.local && result.local.ok ? 'proof saved locally' : 'proof export failed'));
      send.disabled = false;
    });
    journal.addEventListener('click', async function(event) {
      stop(event);
      journal.disabled = true;
      updateStatus('writing journal backup…');
      if (proof && proof.status === 'running') finish();
      var result = await exportProof({ email: false, journalFallback: true });
      updateStatus(result.journal && result.journal.ok ? 'journal backup written' : 'journal backup unavailable');
      journal.disabled = false;
    });
    var resetArmedUntil = 0;
    reset.addEventListener('click', function(event) {
      stop(event);
      if (now() > resetArmedUntil) {
        resetArmedUntil = now() + 5000;
        reset.textContent = 'tap again: reset';
        updateStatus('current proof will be replaced');
        return;
      }
      resetArmedUntil = 0;
      reset.textContent = 'new session';
      start({ reset: true });
      updateStatus('new proof session ready');
    });

    panel.appendChild(title);
    panel.appendChild(status);
    actions.appendChild(step);
    actions.appendChild(buildCheck);
    actions.appendChild(send);
    actions.appendChild(journal);
    actions.appendChild(reset);
    actions.appendChild(close);
    panel.appendChild(actions);
    host.appendChild(trigger);
    host.appendChild(panel);
  }

  function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;

    ['scrollUp', 'scrollDown', 'sideClick', 'longPressStart', 'longPressEnd', 'pttStart', 'pttEnd', 'backbutton'].forEach(function(name) {
      window.addEventListener(name, function() {
        record('hardware.input', { input: name });
      });
    });

    window.addEventListener('pointerdown', function(event) {
      record('hardware.pointer', {
        input: 'pointerdown',
        primary: event && event.isPrimary !== false,
        touch: !!(event && event.pointerType === 'touch'),
        pointerId: finiteNumber(event && event.pointerId) || 0
      });
    });
    window.addEventListener('touchstart', function(event) {
      record('hardware.touch', {
        input: 'touchstart',
        touch: true,
        touchCount: event && event.touches ? Number(event.touches.length || 0) : 0
      });
    }, { passive: true });
    window.addEventListener('devicemotion', function(event) {
      if (now() - lastMotionAt < 250) return;
      lastMotionAt = now();
      var acceleration = event && (event.acceleration || event.accelerationIncludingGravity) || {};
      var x = finiteNumber(acceleration.x) || 0;
      var y = finiteNumber(acceleration.y) || 0;
      var z = finiteNumber(acceleration.z) || 0;
      var magnitude = Math.sqrt((x * x) + (y * y) + (z * z));
      var rounded = function(value) { return Math.round(value * 100) / 100; };
      record('hardware.motion', {
        input: 'devicemotion',
        hasAcceleration: !!(event && (event.acceleration || event.accelerationIncludingGravity)),
        shakeDetected: magnitude >= 16,
        accelerationX: rounded(x),
        accelerationY: rounded(y),
        accelerationZ: rounded(z),
        magnitude: rounded(magnitude),
        intervalMs: finiteNumber(event && event.interval) || 0
      });
    });

    ['structa-camera-open', 'structa-camera-close', 'structa-camera-denied', 'structa-capture-stored', 'structa-capture-failed'].forEach(function(name) {
      window.addEventListener(name, function(event) {
        var detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
        record('camera.event', {
          event: name,
          entryId: safeToken(detail.entryId, 96),
          captureId: safeToken(detail.captureId, 96),
          reason: safeToken(detail.reason, 64)
        });
      });
    });

    ['structa-voice-open', 'structa-voice-close'].forEach(function(name) {
      window.addEventListener(name, function() {
        record('voice.event', { event: name });
      });
    });

    window.addEventListener('structa-trace', handleTrace);
    window.addEventListener('focus', function() {
      record('lifecycle.focus', { focused: true });
      installBridgeWrappers();
    });
    window.addEventListener('blur', function() { record('lifecycle.blur', { focused: false }); });
    window.addEventListener('pageshow', function(event) {
      record('lifecycle.pageshow', { persisted: !!(event && event.persisted) });
      installBridgeWrappers();
    });
    window.addEventListener('pagehide', function(event) {
      record('lifecycle.pagehide', { persisted: !!(event && event.persisted) });
      persist();
    });
    window.addEventListener('online', function() { record('lifecycle.network', { online: true }); });
    window.addEventListener('offline', function() { record('lifecycle.network', { online: false }); });
    window.addEventListener('popstate', function() { record('lifecycle.back', { native: false }); });
    window.addEventListener('error', function(event) {
      record('runtime.error', {
        name: safeToken(event && event.error && event.error.name, 48) || 'Error',
        fatal: false
      });
    });
    window.addEventListener('unhandledrejection', function(event) {
      record('runtime.rejection', {
        name: safeToken(event && event.reason && event.reason.name, 48) || 'PromiseRejection',
        fatal: false
      });
    });
    document.addEventListener('visibilitychange', function() {
      record('lifecycle.visibility', {
        state: safeToken(document.visibilityState || 'unknown', 32),
        visible: document.visibilityState === 'visible'
      });
    });
    window.addEventListener('beforeunload', persist);
  }

  function start(options) {
    var opts = options && typeof options === 'object' ? options : {};
    enabled = true;
    var resumed = false;
    var created = false;
    if (!proof || opts.reset === true || proof.status !== 'running') {
      proof = opts.reset === true ? null : restoreProof();
      resumed = !!proof;
      if (!proof) {
        proof = newProof(opts.stepId || opts.step_id);
        created = true;
      }
    }
    if (created || (resumed && proof.status === 'running')) {
      record(resumed ? 'session.resume' : 'session.start', {
        resumed: resumed,
        routeEnabled: routeEnabled,
        ttlMs: SESSION_TTL_MS,
        abandonedRequests: resumeAbandonedDelta
      });
    }
    installListeners();
    installBridgeWrappers();
    installControl();
    persist();
    return getProof();
  }

  function setStep(stepId) {
    if (!proof || proof.status !== 'running') start();
    var previous = safeStep(proof.step_id);
    var next = safeStep(stepId);
    proof.step_id = next;
    record('step.change', { fromStepId: previous, toStepId: next });
    return next;
  }

  function markManual(checkId, result, details) {
    if (!proof || proof.status !== 'running') start();
    var rawResult = result;
    var extra = details && typeof details === 'object' ? details : {};
    if (result && typeof result === 'object') {
      extra = result;
      rawResult = result.pass !== undefined ? result.pass : result.result;
    }
    var passed = rawResult === true || /^(?:pass|passed|ok|true)$/.test(String(rawResult || '').toLowerCase());
    var fields = {
      checkId: safeToken(checkId, 64),
      outcome: passed ? 'pass' : 'fail',
      passed: passed
    };
    var normalizedExtra = normalizeFields(extra);
    Object.assign(fields, normalizedExtra.ids || {}, normalizedExtra.flags || {}, normalizedExtra.metrics || {});
    record('manual.check', fields);
    return passed;
  }

  function finish(result) {
    if (!proof) start();
    if (proof.status !== 'running') return getProof();
    var normalized = String(result === undefined || result === null ? '' : result).toLowerCase();
    var passed = result === true || /^(?:pass|passed|ok|true)$/.test(normalized);
    var failed = result === false || /^(?:fail|failed|false)$/.test(normalized);
    var outcome = passed ? 'pass' : (failed ? 'fail' : 'complete');
    var queueObserved = !!(window.StructaProcessingQueue && typeof window.StructaProcessingQueue.snapshot === 'function');
    var queueSnapshot = [];
    if (queueObserved) {
      try { queueSnapshot = window.StructaProcessingQueue.snapshot() || []; } catch (_) { queueObserved = false; }
    }
    var queueRunning = queueSnapshot.filter(function(job) { return job && job.status === 'running'; }).length;
    var queuePending = queueSnapshot.filter(function(job) { return job && job.status === 'pending'; }).length;
    var queueBlocked = queueSnapshot.filter(function(job) { return job && job.status === 'blocked'; }).length;
    record('session.finish', {
      outcome: outcome,
      passed: passed,
      queueObserved: queueObserved,
      queueRunning: queueRunning,
      queuePending: queuePending,
      queueBlocked: queueBlocked
    }, true);
    proof.status = passed ? 'passed' : (failed ? 'failed' : 'complete');
    proof.finished_at = new Date(now()).toISOString();
    persist();
    return getProof();
  }

  function getProof() {
    if (!proof) return null;
    refreshSummary();
    return clone(proof);
  }

  function invariant(proofValue, invariantId) {
    var list = proofValue && proofValue.summary && Array.isArray(proofValue.summary.invariants)
      ? proofValue.summary.invariants
      : [];
    return list.find(function(entry) { return entry.id === invariantId; }) || null;
  }

  function digest(value) {
    var current = value || getProof();
    var providerInvariant = invariant(current, 'provider.single_inflight') || {};
    var errorInvariant = invariant(current, 'runtime.no_uncaught_errors') || {};
    var lines = [
      'STRUCTA DEVICE PROOF',
      'schema=' + current.schema,
      'session_id=' + current.session_id,
      'build=' + current.build.ui_build_id,
      'server_build_sha=' + current.build.server_build_sha,
      'status=' + current.status,
      'started_at=' + current.started_at,
      'finished_at=' + (current.finished_at || 'running'),
      'events=' + current.summary.event_count,
      'manual=' + current.summary.manual.passed + '/' + current.summary.manual.total,
      'provider_single_inflight=' + (providerInvariant.pass === true ? 'pass' : 'fail'),
      'provider_max=' + Number(providerInvariant.observed || 0),
      'provider_overlap=' + Number(providerInvariant.violations || 0),
      'runtime_errors=' + Number(errorInvariant.observed || 0),
      'event_tail='
    ];
    current.events.slice(-18).forEach(function(entry) {
      var ids = entry.ids ? Object.keys(entry.ids).sort().map(function(key) { return key + ':' + entry.ids[key]; }).join(',') : '-';
      var flags = entry.flags ? Object.keys(entry.flags).sort().map(function(key) { return key + ':' + (entry.flags[key] ? '1' : '0'); }).join(',') : '-';
      lines.push(entry.seq + '/' + entry.ms + '/' + entry.type + '/' + entry.step_id + '/' + ids + '/' + flags);
    });
    return lines.join('\n').slice(0, 2700);
  }

  function utf8Bytes(value) {
    if (typeof window.TextEncoder === 'function') return new window.TextEncoder().encode(String(value || ''));
    var encoded = unescape(encodeURIComponent(String(value || '')));
    var bytes = new Uint8Array(encoded.length);
    for (var index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return window.btoa(binary);
  }

  function fnv1a32(bytes) {
    var hash = 2166136261;
    for (var index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  async function checksumBytes(bytes) {
    try {
      if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
        var buffer = await window.crypto.subtle.digest('SHA-256', bytes);
        return 'sha256:' + Array.from(new Uint8Array(buffer), function(entry) {
          return entry.toString(16).padStart(2, '0');
        }).join('');
      }
    } catch (_) {}
    return 'fnv1a32:' + fnv1a32(bytes);
  }

  async function gzipBytes(bytes) {
    var Compression = window.CompressionStream;
    var ResponseType = window.Response;
    var BlobType = window.Blob;
    if (typeof Compression !== 'function' || typeof ResponseType !== 'function' || typeof BlobType !== 'function') return null;
    try {
      var compressedStream = new BlobType([bytes]).stream().pipeThrough(new Compression('gzip'));
      return new Uint8Array(await new ResponseType(compressedStream).arrayBuffer());
    } catch (_) {
      return null;
    }
  }

  function transportHeader(meta, part, total) {
    return [
      'STRUCTA_DEVICE_PROOF_TRANSPORT_V1',
      'session_id=' + meta.sessionId,
      'part=' + part,
      'total=' + total,
      'encoding=' + meta.encoding,
      'checksum=' + meta.checksum,
      'data=',
      ''
    ].join('\n');
  }

  function splitTransport(meta, encoded) {
    var total = 1;
    var chunkSize = 0;
    for (var iteration = 0; iteration < 8; iteration += 1) {
      var header = transportHeader(meta, total, total);
      chunkSize = MAX_TRANSPORT_BODY - header.length;
      if (chunkSize < 256) throw new Error('transport-header-too-large');
      var nextTotal = Math.max(1, Math.ceil(encoded.length / chunkSize));
      if (nextTotal === total) break;
      total = nextTotal;
    }
    if (total > MAX_TRANSPORT_PARTS) throw new Error('transport-too-many-parts');
    var parts = [];
    for (var part = 1; part <= total; part += 1) {
      var body = transportHeader(meta, part, total) + encoded.slice((part - 1) * chunkSize, part * chunkSize);
      if (body.length > MAX_TRANSPORT_BODY) throw new Error('transport-part-too-large');
      parts.push({ part: part, total: total, body: body });
    }
    return parts;
  }

  async function createProofTransport(value) {
    var originalBytes = utf8Bytes(JSON.stringify(value));
    var checksum = await checksumBytes(originalBytes);
    var compressed = await gzipBytes(originalBytes);
    var transportBytes = compressed || originalBytes;
    var encoding = compressed ? 'gzip+base64' : 'base64';
    var meta = {
      sessionId: value.session_id,
      encoding: encoding,
      checksum: checksum
    };
    return {
      session_id: value.session_id,
      encoding: encoding,
      checksum: checksum,
      parts: splitTransport(meta, bytesToBase64(transportBytes))
    };
  }

  async function sendProofTransport(value) {
    if (!window.StructaLLM || typeof window.StructaLLM.emailText !== 'function') {
      return { ok: false, attempted: false, mode: 'unavailable', sent: 0, total: 0 };
    }
    var transport;
    try {
      transport = await createProofTransport(value);
    } catch (error) {
      return {
        ok: false,
        attempted: true,
        mode: safeToken(error && error.message, 48) || 'transport-failed',
        sent: 0,
        total: 0
      };
    }
    var receipts = [];
    for (var index = 0; index < transport.parts.length; index += 1) {
      var part = transport.parts[index];
      var response;
      try {
        response = await window.StructaLLM.emailText(
          'STRUCTA proof ' + value.session_id + ' [' + part.part + '/' + part.total + ']',
          part.body
        );
      } catch (_) {
        response = { ok: false, mode: 'failed' };
      }
      var receipt = {
        part: part.part,
        ok: !!(response && response.ok),
        mode: safeToken(response && response.mode, 48) || (response && response.ok ? 'sent' : 'failed')
      };
      receipts.push(receipt);
      if (!receipt.ok) break;
    }
    return {
      ok: receipts.length === transport.parts.length && receipts.every(function(entry) { return entry.ok; }),
      attempted: true,
      mode: 'transport',
      encoding: transport.encoding,
      checksum: transport.checksum,
      sent: receipts.filter(function(entry) { return entry.ok; }).length,
      total: transport.parts.length,
      receipts: receipts
    };
  }

  function saveLocally(value) {
    var filename = 'structa-device-proof-' + value.session_id + '.json';
    try {
      var blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 0);
      return { ok: true, filename: filename };
    } catch (_) {
      return { ok: false, filename: filename };
    }
  }

  function journalFallback(body) {
    var bridge = window.PluginMessageHandler;
    if (!bridge || typeof bridge.postMessage !== 'function') {
      return { ok: false, attempted: true, mode: 'unavailable' };
    }
    try {
      bridge.postMessage(JSON.stringify({
        message: body,
        useLLM: false,
        useSerpAPI: false,
        wantsR1Response: false,
        wantsJournalEntry: true
      }));
      return { ok: true, attempted: true, mode: 'rabbit-journal' };
    } catch (_) {
      return { ok: false, attempted: true, mode: 'failed' };
    }
  }

  async function exportProof(options) {
    var opts = options && typeof options === 'object' ? options : {};
    if (!proof) start();
    record('proof.export', {
      emailRequested: opts.email !== false,
      emailDigestRequested: opts.emailDigest === true,
      journalFallbackRequested: opts.journalFallback === true
    }, proof.status !== 'running');
    var snapshot = getProof();
    var local = saveLocally(snapshot);
    var body = digest(snapshot);
    var email = { ok: false, attempted: false, mode: 'unavailable' };
    if (opts.email !== false && window.StructaLLM && typeof window.StructaLLM.emailText === 'function') {
      email = await sendProofTransport(snapshot);
    }
    var digestEmail = { ok: false, attempted: false, mode: 'not-requested' };
    if (!email.ok && opts.emailDigest === true && window.StructaLLM && typeof window.StructaLLM.emailText === 'function') {
      try {
        var digestResult = await window.StructaLLM.emailText('STRUCTA proof digest ' + snapshot.session_id, body);
        digestEmail = {
          ok: !!(digestResult && digestResult.ok),
          attempted: true,
          mode: safeToken(digestResult && digestResult.mode, 48) || (digestResult && digestResult.ok ? 'sent' : 'failed')
        };
      } catch (_) {
        digestEmail = { ok: false, attempted: true, mode: 'failed' };
      }
    }
    var journal = { ok: false, attempted: false, mode: 'not-requested' };
    if (!email.ok && !digestEmail.ok && opts.journalFallback === true) journal = journalFallback(body);
    persist();
    return {
      ok: !!(local.ok || email.ok || digestEmail.ok || journal.ok),
      schema: SCHEMA,
      session_id: snapshot.session_id,
      local: local,
      email: email,
      digest_email: digestEmail,
      journal: journal,
      proof: getProof()
    };
  }

  window.StructaDeviceLab = Object.freeze({
    schema: SCHEMA,
    get enabled() { return enabled; },
    get routeEnabled() { return routeEnabled; },
    start: start,
    setStep: setStep,
    markManual: markManual,
    finish: finish,
    getProof: getProof,
    exportProof: exportProof
  });

  if (routeEnabled) start();
})();
