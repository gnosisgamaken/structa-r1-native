#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCHEMA = 'structa.device-proof.v1';
const TOKEN = /^[A-Za-z0-9._:-]+$/;
const ROOT_KEYS = new Set([
  'schema', 'session_id', 'status', 'started_at', 'expires_at', 'finished_at',
  'step_id', 'build', 'events', 'summary'
]);
const EVENT_KEYS = new Set([
  'session_id', 'seq', 'ms', 'at', 'step_id', 'build', 'type', 'ids', 'flags', 'metrics'
]);
const SENSITIVE_KEY = /^(?:message|text|body|prompt|transcript|image|image_base64|base64|password|payload|raw|dump|content|note|error)$/i;
const DANGEROUS_KEY = /(?:token|secret|auth|credential|cookie|key)/i;
const SEMANTIC_ID_KEYS = new Set([
  'action_id', 'active_project_id', 'capture_id', 'check_id', 'comment_id',
  'completion_id', 'correlation_id', 'entry_id', 'event_id', 'flow_id',
  'from_id', 'from_step_id', 'image_run_id', 'input_id', 'item_id', 'job_id',
  'mode_id', 'name_id', 'node_id', 'operation_id', 'outcome_id', 'plugin_id',
  'previous_provider_slot_id', 'project_id', 'provider_slot_id', 'reason_id',
  'request_id', 'source_id', 'state_id', 'status_id', 'to_id', 'to_step_id',
  'type_id', 'vision_id'
]);
const TRANSPORT_MARKER = 'STRUCTA_DEVICE_PROOF_TRANSPORT_V1';
const MAX_TRANSPORT_BODY = 2700;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validToken(value, max = 96) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && TOKEN.test(value);
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function inspectForSensitiveContent(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectForSensitiveContent(entry, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) {
    if (typeof value === 'string') {
      if (/data:image|(?:^|\s)bearer\s+[A-Za-z0-9._~-]+|api[_-]?key\s*[:=]/i.test(value)) {
        errors.push(`${path} contains forbidden content`);
      }
      if (value.length > 2700) errors.push(`${path} exceeds the maximum proof string length`);
    }
    return;
  }
  Object.entries(value).forEach(([key, entry]) => {
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY.test(key) || DANGEROUS_KEY.test(key)) errors.push(`${childPath} is a forbidden field`);
    inspectForSensitiveContent(entry, childPath, errors);
  });
}

function validateScalarBag(value, kind, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      errors.push(`${path}.${key} has an invalid key`);
      continue;
    }
    if (kind === 'ids') {
      if (!SEMANTIC_ID_KEYS.has(key)) errors.push(`${path}.${key} is not an allowed semantic identifier`);
      if (!validToken(entry)) errors.push(`${path}.${key} must be a safe identifier`);
    } else if (kind === 'flags' && typeof entry !== 'boolean') {
      errors.push(`${path}.${key} must be boolean`);
    } else if (kind === 'metrics' && (typeof entry !== 'number' || !Number.isFinite(entry))) {
      errors.push(`${path}.${key} must be a finite number`);
    }
  }
}

function invariantById(proof, id) {
  return proof?.summary?.invariants?.find(entry => entry?.id === id) || null;
}

function eventId(event, key) {
  const value = event?.ids?.[key];
  return validToken(value) ? value : '';
}

function eventFlag(event, key) {
  return event?.flags?.[key] === true;
}

function eventMetric(event, key) {
  const value = Number(event?.metrics?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function traceMatches(event, flow, from, to) {
  if (!event || event.type !== 'structa.trace') return false;
  if (flow && eventId(event, 'flow_id').toLowerCase() !== flow) return false;
  if (from && eventId(event, 'from_id').toLowerCase() !== from) return false;
  if (to && eventId(event, 'to_id').toLowerCase() !== to) return false;
  return true;
}

function sequencePass(proof) {
  if (!Array.isArray(proof.events)) return false;
  let previousMs = -1;
  return proof.events.every((event, index) => {
    const valid = event?.seq === index + 1 &&
      Number.isFinite(event?.ms) && event.ms >= previousMs &&
      event.session_id === proof.session_id && event.build === proof.build?.ui_build_id;
    previousMs = Number.isFinite(event?.ms) ? event.ms : previousMs;
    return valid;
  });
}

function deriveProvider(events) {
  const active = [];
  let outbound = 0;
  let completed = 0;
  let abandoned = 0;
  let observedMax = 0;
  let violations = 0;
  for (const event of events || []) {
    if (event.type === 'session.resume') {
      const newlyAbandoned = Math.max(0, eventMetric(event, 'abandoned_requests'));
      abandoned += newlyAbandoned;
      if (newlyAbandoned > 0) active.splice(0, Math.min(active.length, newlyAbandoned));
      continue;
    }
    if (event.type === 'bridge.outbound' && eventFlag(event, 'provider_call')) {
      active.push(eventId(event, 'provider_slot_id') || `missing-slot-${event.seq}`);
      outbound += 1;
      observedMax = Math.max(observedMax, active.length);
      if (active.length > 1) violations += 1;
      continue;
    }
    if (event.type === 'provider.associate') {
      const previous = eventId(event, 'previous_provider_slot_id');
      const associated = eventId(event, 'provider_slot_id');
      const index = active.indexOf(previous);
      if (index >= 0 && associated) active[index] = associated;
      continue;
    }
    if (event.type === 'provider.complete') {
      const slot = eventId(event, 'provider_slot_id');
      const index = active.indexOf(slot);
      if (index >= 0) {
        active.splice(index, 1);
        completed += 1;
      }
    }
  }
  return {
    outbound,
    completed,
    abandoned,
    outstanding: active.length,
    observed_max_in_flight: observedMax,
    overlap_violations: violations
  };
}

function sameIdSet(left, right) {
  const a = [...new Set((left || []).filter(Boolean))].sort();
  const b = [...new Set((right || []).filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasDeployServerSha(value) {
  return validToken(value) && !/^(?:unavailable|workspace|unknown)$/i.test(value);
}

function deriveExpectedInvariants(proof, provider, storagePass) {
  const events = Array.isArray(proof.events) ? proof.events : [];
  const stepObserved = step => events.some(event => event.step_id === step);
  const requiredSteps = ['B00', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07'];
  const observedStepCount = requiredSteps.filter(stepObserved).length;
  const b02 = stepObserved('B02');
  const b04 = stepObserved('B04');
  const b06 = stepObserved('B06');
  const b04Events = events.filter(event => event.step_id === 'B04');
  const finishEvent = [...events].reverse().find(event => event.type === 'session.finish') || null;
  const finishSeq = finishEvent ? finishEvent.seq : Infinity;
  const transportOutbound = events.filter(event => event.type === 'bridge.outbound' && event.seq <= finishSeq);
  const visionRequests = b04Events.filter(event => traceMatches(event, 'vision.analysis', 'saved', 'requested'));
  const visionPosted = b04Events.filter(event => traceMatches(event, 'vision.bridge', 'prepare', 'posted'));
  const visionParsed = b04Events.filter(event => traceMatches(event, 'plugin.message.parsed', 'in', 'vision'));
  const visionStored = b04Events.filter(event => traceMatches(event, 'vision.analysis', 'requested', 'stored'));
  const visionUnavailable = b04Events.filter(event => traceMatches(event, 'vision.analysis', 'requested', 'unavailable'));
  const requestIds = visionRequests.map(event => eventId(event, 'vision_id'));
  const postedIds = visionPosted.map(event => eventId(event, 'vision_id'));
  const parsedIds = visionParsed.map(event => eventId(event, 'vision_id'));
  const storedIds = visionStored.map(event => eventId(event, 'vision_id'));
  const unavailableIds = visionUnavailable.map(event => eventId(event, 'vision_id'));
  const captureOrderPass = visionRequests.every(request => {
    const captureId = eventId(request, 'capture_id');
    if (!captureId) return false;
    return events.some(candidate => candidate.seq < request.seq &&
      candidate.type === 'camera.event' &&
      eventId(candidate, 'event_id') === 'structa-capture-stored' &&
      (eventId(candidate, 'entry_id') === captureId || eventId(candidate, 'capture_id') === captureId));
  });
  const requestCounts = {};
  const postCounts = {};
  const parseCounts = {};
  const storeCounts = {};
  const unavailableCounts = {};
  requestIds.forEach(id => { if (id) requestCounts[id] = Number(requestCounts[id] || 0) + 1; });
  postedIds.forEach(id => { if (id) postCounts[id] = Number(postCounts[id] || 0) + 1; });
  parsedIds.forEach(id => { if (id) parseCounts[id] = Number(parseCounts[id] || 0) + 1; });
  storedIds.forEach(id => { if (id) storeCounts[id] = Number(storeCounts[id] || 0) + 1; });
  unavailableIds.forEach(id => { if (id) unavailableCounts[id] = Number(unavailableCounts[id] || 0) + 1; });
  const parsePass = visionParsed.every(event => {
    const visionId = eventId(event, 'vision_id');
    if (!visionId) return false;
    return parseCounts[visionId] <= 1;
  });
  const chainIdsValid = requestIds.every(Boolean) && postedIds.every(Boolean) && parsedIds.every(Boolean) && storedIds.every(Boolean);
  const chainDuplicate = [requestCounts, postCounts, parseCounts, storeCounts].some(counts => Object.values(counts).some(count => count > 1));
  const chainExtraId = [...postedIds, ...parsedIds, ...storedIds, ...unavailableIds].some(id => !!id && !requestCounts[id]);
  const chainMissingStage = Object.keys(requestCounts).some(id => !postCounts[id] || !parseCounts[id] || !storeCounts[id]);
  const idChainPass = requestIds.length === 0
    ? (b04 ? null : true)
    : (!chainIdsValid || chainDuplicate || chainExtraId ? false : (chainMissingStage ? null : true));

  const requestCaptureIds = visionRequests.map(event => eventId(event, 'capture_id'));
  const uniqueCaptureIds = [...new Set(requestCaptureIds.filter(Boolean))];
  let matrixInvalid = 0;
  if (!requestIds.every(Boolean) || !requestCaptureIds.every(Boolean) || !postedIds.every(Boolean) || !parsedIds.every(Boolean) || !storedIds.every(Boolean) || !unavailableIds.every(Boolean)) matrixInvalid += 1;
  if (uniqueCaptureIds.length !== requestCaptureIds.length) matrixInvalid += 1;
  if (chainDuplicate || chainExtraId) matrixInvalid += 1;
  let matrixSuccess = 0;
  let matrixDegraded = 0;
  let matrixOpen = 0;
  for (const id of Object.keys(requestCounts)) {
    const requestCount = requestCounts[id] || 0;
    const postedCount = postCounts[id] || 0;
    const parsedCount = parseCounts[id] || 0;
    const storedCount = storeCounts[id] || 0;
    const unavailableCount = unavailableCounts[id] || 0;
    if (requestCount > 1 || postedCount > 1 || parsedCount > 1 || storedCount > 1 || unavailableCount > 1 || (storedCount && unavailableCount)) {
      matrixInvalid += 1;
    } else if (requestCount === 1 && postedCount === 1 && parsedCount === 1 && storedCount === 1 && unavailableCount === 0) {
      matrixSuccess += 1;
    } else if (requestCount === 1 && postedCount === 1 && parsedCount === 0 && storedCount === 0 && unavailableCount === 1) {
      matrixDegraded += 1;
    } else {
      matrixOpen += 1;
    }
  }
  const matrixPass = !b04 && !visionRequests.length
    ? true
    : (matrixInvalid > 0
        ? false
        : (uniqueCaptureIds.length < 20 || matrixOpen > 0
            ? null
            : (uniqueCaptureIds.length === 20 && matrixSuccess >= 18 && matrixDegraded <= 2 && matrixSuccess + matrixDegraded === 20)));
  const pressEvents = events.filter(event => event.step_id === 'B02' && event.type === 'hardware.input' &&
    /^(?:pttStart|pttEnd|longPressStart|longPressEnd)$/.test(eventId(event, 'input_id')));
  const pressStack = [];
  let pressViolations = 0;
  let pressStarts = 0;
  for (const event of pressEvents) {
    const input = eventId(event, 'input_id');
    if (input === 'pttStart' || input === 'longPressStart') {
      pressStack.push(input === 'pttStart' ? 'ptt' : 'longPress');
      pressStarts += 1;
    } else {
      const endType = input === 'pttEnd' ? 'ptt' : 'longPress';
      if (pressStack.length && pressStack.at(-1) === endType) pressStack.pop();
      else pressViolations += 1;
    }
  }
  const queueObserved = !!(finishEvent && eventFlag(finishEvent, 'queue_observed'));
  const queueRunning = finishEvent ? eventMetric(finishEvent, 'queue_running') : 0;
  const queuePending = finishEvent ? eventMetric(finishEvent, 'queue_pending') : 0;
  const queueBlocked = finishEvent ? eventMetric(finishEvent, 'queue_blocked') : 0;
  const errorCount = events.filter(event => ['runtime.error', 'runtime.rejection', 'bridge.post_error'].includes(event.type)).length;
  const finished = proof.status !== 'running';
  return [
    { id: 'event.sequence_monotonic', pass: sequencePass(proof) },
    { id: 'provider.single_inflight', pass: provider.overlap_violations === 0 && provider.observed_max_in_flight <= 1, observed: provider.observed_max_in_flight, violations: provider.overlap_violations },
    { id: 'provider.settled_at_finish', pass: finished ? provider.outstanding === 0 && provider.abandoned === 0 : null, outstanding: provider.outstanding, abandoned: provider.abandoned },
    { id: 'runtime.no_uncaught_errors', pass: errorCount === 0, observed: errorCount },
    { id: 'storage.session_persistent', pass: storagePass },
    { id: 'build.server_sha_available', pass: hasDeployServerSha(proof.build?.server_build_sha) },
    { id: 'coverage.phase_sequence', pass: observedStepCount === requiredSteps.length ? true : null, observed: observedStepCount, required: requiredSteps.length },
    { id: 'transport.no_speaker_request', pass: !transportOutbound.length ? null : !transportOutbound.some(event => eventFlag(event, 'wants_r1_response')), observed: transportOutbound.length },
    { id: 'transport.no_journal_request', pass: !transportOutbound.length ? null : !transportOutbound.some(event => eventFlag(event, 'wants_journal_entry')), observed: transportOutbound.length },
    { id: 'vision.capture_precedes_request', pass: b04 && !visionRequests.length ? null : captureOrderPass, observed: visionRequests.length },
    { id: 'vision.single_parse_per_id', pass: b04 && !visionParsed.length ? null : parsePass, observed: visionParsed.length },
    { id: 'vision.id_chain_matches', pass: idChainPass, observed: requestIds.length },
    { id: 'vision.b04_matrix', pass: matrixPass, captures: uniqueCaptureIds.length, success: matrixSuccess, degraded: matrixDegraded, invalid: matrixInvalid, open: matrixOpen },
    { id: 'input.b02_press_pairs', pass: b02 && !pressEvents.length ? null : (pressViolations === 0 && pressStack.length === 0), observed: pressStarts, violations: pressViolations + pressStack.length },
    { id: 'queue.settled_at_finish', pass: queueObserved ? queueRunning === 0 && queuePending === 0 && queueBlocked === 0 : (b06 || finished ? null : true), running: queueRunning, pending: queuePending, blocked: queueBlocked },
    { id: 'telemetry.content_free', pass: true }
  ];
}

function invariantComparable(value) {
  const result = {};
  for (const key of ['id', 'pass', 'observed', 'violations', 'outstanding', 'abandoned', 'required', 'running', 'pending', 'blocked', 'captures', 'success', 'degraded', 'invalid', 'open']) {
    if (Object.prototype.hasOwnProperty.call(value || {}, key)) result[key] = value[key];
  }
  return result;
}

export function validateDeviceProof(proof) {
  const errors = [];
  if (!isObject(proof)) return { ok: false, errors: ['proof must be an object'], verdict: 'invalid' };

  for (const key of Object.keys(proof)) {
    if (!ROOT_KEYS.has(key)) errors.push(`proof.${key} is not allowed`);
  }
  if (proof.schema !== SCHEMA) errors.push(`proof.schema must equal ${SCHEMA}`);
  if (!validToken(proof.session_id)) errors.push('proof.session_id must be a safe identifier');
  if (!['running', 'passed', 'failed', 'complete'].includes(proof.status)) errors.push('proof.status is invalid');
  if (!validIso(proof.started_at)) errors.push('proof.started_at must be ISO-8601');
  if (!validIso(proof.expires_at)) errors.push('proof.expires_at must be ISO-8601');
  if (proof.status === 'running' && proof.finished_at !== null) errors.push('running proof must have finished_at=null');
  if (proof.status !== 'running' && !validIso(proof.finished_at)) errors.push('finished proof must have an ISO-8601 finished_at');
  if (!validToken(proof.step_id, 64)) errors.push('proof.step_id must be a safe identifier');

  if (validIso(proof.started_at) && validIso(proof.expires_at)) {
    const ttl = Date.parse(proof.expires_at) - Date.parse(proof.started_at);
    if (ttl < 60 * 60 * 1000 || ttl > 3 * 60 * 60 * 1000) errors.push('proof expiry must be approximately two hours');
  }

  if (!isObject(proof.build)) {
    errors.push('proof.build must be an object');
  } else {
    const expectedBuildKeys = ['ui_build_id', 'diagnostics_asset_id', 'asset_epoch_id', 'proof_schema_id', 'server_build_sha'];
    for (const key of expectedBuildKeys) {
      if (!validToken(proof.build[key])) errors.push(`proof.build.${key} must be a safe identifier`);
    }
    for (const key of Object.keys(proof.build)) {
      if (!expectedBuildKeys.includes(key)) errors.push(`proof.build.${key} is not allowed`);
    }
    if (proof.build.proof_schema_id !== SCHEMA) errors.push('proof.build.proof_schema_id does not match schema');
  }

  if (!Array.isArray(proof.events)) {
    errors.push('proof.events must be an array');
  } else {
    let previousMs = -1;
    proof.events.forEach((event, index) => {
      const path = `proof.events[${index}]`;
      if (!isObject(event)) {
        errors.push(`${path} must be an object`);
        return;
      }
      for (const key of Object.keys(event)) {
        if (!EVENT_KEYS.has(key)) errors.push(`${path}.${key} is not allowed`);
      }
      if (event.session_id !== proof.session_id) errors.push(`${path}.session_id does not match proof`);
      if (event.seq !== index + 1) errors.push(`${path}.seq must equal ${index + 1}`);
      if (typeof event.ms !== 'number' || !Number.isFinite(event.ms) || event.ms < previousMs) {
        errors.push(`${path}.ms must be finite and monotonic`);
      }
      previousMs = Number.isFinite(event.ms) ? event.ms : previousMs;
      if (!validIso(event.at)) errors.push(`${path}.at must be ISO-8601`);
      if (validIso(event.at) && validIso(proof.started_at) && Number.isFinite(event.ms)) {
        const observedRelative = Date.parse(event.at) - Date.parse(proof.started_at);
        if (Math.abs(observedRelative - event.ms) > 5000) errors.push(`${path}.ms does not match its relative timestamp`);
      }
      if (!validToken(event.step_id, 64)) errors.push(`${path}.step_id must be a safe identifier`);
      if (event.build !== proof.build?.ui_build_id) errors.push(`${path}.build does not match proof build`);
      if (!validToken(event.type, 72)) errors.push(`${path}.type must be a safe identifier`);
      if (event.ids !== undefined) validateScalarBag(event.ids, 'ids', `${path}.ids`, errors);
      if (event.flags !== undefined) validateScalarBag(event.flags, 'flags', `${path}.flags`, errors);
      if (event.metrics !== undefined) validateScalarBag(event.metrics, 'metrics', `${path}.metrics`, errors);
    });
  }

  if (!isObject(proof.summary)) {
    errors.push('proof.summary must be an object');
  } else {
    if (proof.summary.event_count !== proof.events?.length) errors.push('proof.summary.event_count does not match events');
    if (!isObject(proof.summary.counts)) {
      errors.push('proof.summary.counts must be an object');
    } else if (Array.isArray(proof.events)) {
      const actualCounts = proof.events.reduce((counts, event) => {
        if (event && typeof event.type === 'string') counts[event.type] = Number(counts[event.type] || 0) + 1;
        return counts;
      }, {});
      const expectedEntries = Object.entries(actualCounts).sort(([a], [b]) => a.localeCompare(b));
      const observedEntries = Object.entries(proof.summary.counts).sort(([a], [b]) => a.localeCompare(b));
      if (JSON.stringify(expectedEntries) !== JSON.stringify(observedEntries)) errors.push('proof.summary.counts does not match events');
    }
    if (!isObject(proof.summary.provider)) {
      errors.push('proof.summary.provider must be an object');
    } else {
      const expectedProvider = deriveProvider(proof.events || []);
      if (JSON.stringify(proof.summary.provider) !== JSON.stringify(expectedProvider)) errors.push('proof.summary.provider does not match events');
    }
    if (!isObject(proof.summary.manual)) {
      errors.push('proof.summary.manual must be an object');
    } else if (Array.isArray(proof.events)) {
      const manualEvents = proof.events.filter(event => event.type === 'manual.check');
      const expectedManual = {
        total: manualEvents.length,
        passed: manualEvents.filter(event => eventFlag(event, 'passed')).length,
        failed: manualEvents.filter(event => !eventFlag(event, 'passed')).length
      };
      if (JSON.stringify(proof.summary.manual) !== JSON.stringify(expectedManual)) errors.push('proof.summary.manual does not match events');
    }
    if (!Array.isArray(proof.summary.invariants)) errors.push('proof.summary.invariants must be an array');
  }

  if (Array.isArray(proof.summary?.invariants) && Array.isArray(proof.events)) {
    const storageInvariant = invariantById(proof, 'storage.session_persistent');
    if (!storageInvariant || typeof storageInvariant.pass !== 'boolean') errors.push('storage.session_persistent invariant must be present');
    const providerSummary = deriveProvider(proof.events);
    const expectedInvariants = deriveExpectedInvariants(proof, providerSummary, storageInvariant?.pass === true);
    for (const expected of expectedInvariants) {
      const observed = invariantById(proof, expected.id);
      if (!observed) {
        errors.push(`${expected.id} invariant must be present`);
        continue;
      }
      if (JSON.stringify(invariantComparable(observed)) !== JSON.stringify(invariantComparable(expected))) {
        errors.push(`${expected.id} invariant does not match events`);
      }
    }
  }

  inspectForSensitiveContent(proof, 'proof', errors);

  const failedInvariants = Array.isArray(proof.summary?.invariants)
    ? proof.summary.invariants.filter(entry => entry && entry.pass === false).map(entry => entry.id)
    : [];
  const incompleteInvariants = Array.isArray(proof.summary?.invariants)
    ? proof.summary.invariants.filter(entry => entry && entry.pass === null).map(entry => entry.id)
    : [];
  return {
    ok: errors.length === 0,
    errors,
    verdict: errors.length
      ? 'invalid'
      : (proof.status === 'failed' || failedInvariants.length ? 'failed' : (proof.status === 'running' || incompleteInvariants.length ? 'incomplete' : 'passed')),
    failed_invariants: failedInvariants,
    incomplete_invariants: incompleteInvariants
  };
}

export function parseTransportPart(rawText) {
  const source = String(rawText || '').replace(/\r\n?/g, '\n');
  const markerIndex = source.indexOf(TRANSPORT_MARKER);
  if (markerIndex < 0) throw new Error('transport marker missing');
  const transport = source.slice(markerIndex).trim();
  if (transport.length > MAX_TRANSPORT_BODY) throw new Error('transport part exceeds 2700 characters');
  const lines = transport.split('\n');
  if (lines.shift() !== TRANSPORT_MARKER) throw new Error('transport marker invalid');
  const headers = {};
  let dataIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'data=') {
      dataIndex = index + 1;
      break;
    }
    const match = /^([a-z_]+)=(.*)$/.exec(line);
    if (!match) throw new Error(`transport header invalid at line ${index + 2}`);
    if (headers[match[1]] !== undefined) throw new Error(`transport header duplicated: ${match[1]}`);
    headers[match[1]] = match[2];
  }
  if (dataIndex < 0) throw new Error('transport data header missing');
  const sessionId = headers.session_id;
  const part = Number(headers.part);
  const total = Number(headers.total);
  const encoding = headers.encoding;
  const checksum = headers.checksum;
  const data = lines.slice(dataIndex).join('').replace(/\s+/g, '');
  if (!validToken(sessionId)) throw new Error('transport session_id invalid');
  if (!Number.isInteger(part) || !Number.isInteger(total) || part < 1 || total < 1 || part > total || total > 48) {
    throw new Error('transport part/total invalid');
  }
  if (!['base64', 'gzip+base64'].includes(encoding)) throw new Error('transport encoding invalid');
  if (!/^(?:sha256:[a-f0-9]{64}|fnv1a32:[a-f0-9]{8})$/.test(checksum || '')) throw new Error('transport checksum invalid');
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('transport base64 invalid');
  return { session_id: sessionId, part, total, encoding, checksum, data };
}

function fnv1a32Buffer(buffer) {
  let hash = 2166136261;
  for (const byte of buffer) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function decodeDeviceProofTransport(rawParts) {
  if (!Array.isArray(rawParts) || !rawParts.length) throw new Error('transport parts missing');
  const parts = rawParts.map(parseTransportPart);
  const first = parts[0];
  for (const part of parts) {
    if (part.session_id !== first.session_id || part.total !== first.total || part.encoding !== first.encoding || part.checksum !== first.checksum) {
      throw new Error('transport headers do not agree');
    }
  }
  const byPart = new Map();
  for (const part of parts) {
    if (byPart.has(part.part)) throw new Error(`transport part duplicated: ${part.part}`);
    byPart.set(part.part, part);
  }
  if (byPart.size !== first.total) throw new Error(`transport incomplete: received ${byPart.size}/${first.total}`);
  const encoded = Array.from({ length: first.total }, (_, index) => byPart.get(index + 1).data).join('');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('transport base64 assembly invalid');
  let bytes = Buffer.from(encoded, 'base64');
  if (first.encoding === 'gzip+base64') {
    try {
      bytes = gunzipSync(bytes);
    } catch (_) {
      throw new Error('transport gzip decode failed');
    }
  }
  const [checksumKind, checksumValue] = first.checksum.split(':');
  const observedChecksum = checksumKind === 'sha256'
    ? createHash('sha256').update(bytes).digest('hex')
    : fnv1a32Buffer(bytes);
  if (observedChecksum !== checksumValue) throw new Error('transport checksum mismatch');
  let proof;
  try {
    proof = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    throw new Error('transport JSON decode failed');
  }
  if (proof?.session_id !== first.session_id) throw new Error('transport session does not match proof');
  return proof;
}

function runCli() {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error('usage: node scripts/validate-device-proof.mjs <proof.json|transport-part.txt> [...]');
    process.exitCode = 64;
    return;
  }
  let parsed;
  try {
    const rawParts = targets.map(target => target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8'));
    const first = rawParts[0].trimStart();
    if (first.startsWith('{')) {
      if (rawParts.length !== 1) throw new Error('JSON proof accepts exactly one input file');
      parsed = JSON.parse(rawParts[0]);
    } else {
      parsed = decodeDeviceProofTransport(rawParts);
    }
  } catch (error) {
    console.error(`device proof invalid · ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = validateDeviceProof(parsed);
  if (!result.ok) {
    console.error('device proof invalid');
    result.errors.forEach(error => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }
  const failed = result.failed_invariants.length ? ` · failed invariants ${result.failed_invariants.join(',')}` : '';
  const incomplete = result.incomplete_invariants.length ? ` · incomplete invariants ${result.incomplete_invariants.join(',')}` : '';
  console.log(`device proof valid · verdict ${result.verdict}${failed}${incomplete}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
