/**
 * r1-llm.js -- Structa LLM client via R1 native bridge.
 *
 * Uses PluginMessageHandler.postMessage() to send messages to the R1's
 * on-device LLM. Responses come back via window.onPluginMessage().
 *
 * VOICE DOCTRINE
 * Structa speaks only at milestones. Silence is the default.
 * A milestone is a moment the user did something that produced a real artifact.
 * Voice strings: ≤ 3 words, lowercase, declarative, no hedging, no questions.
 * Tone: quiet accomplishment. Never instructional, never conversational.
 * If unsure whether a moment is a milestone — it isn't.
 *
 * Changes (2026-04-13):
 * - processVoice() now injects project context + conversation history
 * - conversationHistory[] is populated on every exchange
 * - sendToLLM() supports imageBase64 for camera analysis
 * - extractFields() now pulls out decision text
 * - storeAsInsight() auto-creates pending_decisions from LLM decisions
 * - Removed noisy debug logging (thinking..., r1 msg...)
 */
(function() {
  var native = window.StructaNative;
  var requestQueue = [];
  var activeRequest = null;
  var requestId = 0;
  var conversationHistory = [];
  var MAX_HISTORY = 10;
  var lastCallTime = 0;
  var MIN_GAP_MS = 350;
  var BRIDGE_TIMEOUT_CODE = 'bridge-timeout';
  var dispatchTimer = null;
  var lastMilestoneSpeechAt = 0;
  var MILESTONE_COOLDOWN_MS = 6000;
  var pendingBridgeRequests = new Map();
  var pendingImageBridgeRequest = null;
  var operationPolicyStack = [{ allowSpeech: true, silent: false, source: 'default' }];
  var runtimeCaps = window.__structaCaps || {
    hasBridge: typeof PluginMessageHandler !== 'undefined',
    hasVoiceBridge: typeof CreationVoiceHandler !== 'undefined',
    hasNativeCamera: false,
    hasTone: !!window.StructaAudio?.playTone
  };

  function commitRuntimeCaps(next) {
    runtimeCaps = Object.assign({}, runtimeCaps, next || {});
    window.__structaCaps = Object.freeze(Object.assign({}, runtimeCaps));
    return window.__structaCaps;
  }

  function probeCapabilities() {
    var base = {
      hasBridge: typeof PluginMessageHandler !== 'undefined',
      hasVoiceBridge: typeof CreationVoiceHandler !== 'undefined',
      hasNativeCamera: !!(window.r1?.camera?.capturePhoto),
      hasTone: !!window.StructaAudio?.playTone,
      nativeCapturePreferred: false
    };
    try {
      var capabilityResponse = window.r1?.messaging?.getRuntimeCapabilities?.();
      if (capabilityResponse && typeof capabilityResponse.then === 'function') {
        capabilityResponse.then(function(value) {
          var caps = Object.assign({}, base, value || {});
          caps.nativeCapturePreferred = !!(caps.hasNativeCamera || caps.cameraCapture || window.r1?.camera?.capturePhoto);
          commitRuntimeCaps(caps);
        }).catch(function() {
          commitRuntimeCaps(base);
        });
      } else if (capabilityResponse && typeof capabilityResponse === 'object') {
        base = Object.assign(base, capabilityResponse);
        base.nativeCapturePreferred = !!(base.hasNativeCamera || base.cameraCapture || window.r1?.camera?.capturePhoto);
      }
    } catch (_) {}
    return commitRuntimeCaps(base);
  }

  function withTimeout(promise, timeoutMs, label) {
    var settled = false;
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        reject(new Error((label || 'request') + ' timed out'));
      }, timeoutMs);
      Promise.resolve(promise).then(function(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }).catch(function(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function compactText(text, limit) {
    var max = Number(limit || 160);
    var value = String(text || '').trim().replace(/\s+/g, ' ');
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function traceEmail(flow, from, to, ctx) {
    native?.traceEvent?.(flow, from, to, ctx || {});
  }

  function probeEmailCapability() {
    var available = typeof window.r1?.messaging?.emailUser === 'function';
    commitRuntimeCaps({ hasNativeEmail: available });
    traceEmail('email.native.available', 'boot', available ? 'true' : 'false', {
      available: available
    });
    return available;
  }

  probeCapabilities();
  probeEmailCapability();

  function getNextId() {
    requestId++;
    return 'structa-' + Date.now() + '-' + requestId;
  }

  function createCorrelationId() {
    requestId++;
    return 'bridge-' + Date.now() + '-' + requestId;
  }

  function normalizeMilestoneKind(kind) {
    var raw = String(kind || '').trim().toLowerCase();
    var aliases = {
      triangle: 'triangle_captured',
      first_capture: 'frame_ready'
    };
    return aliases[raw] || raw;
  }

  function currentOperationPolicy() {
    return operationPolicyStack[operationPolicyStack.length - 1] || { allowSpeech: true, silent: false, source: 'default' };
  }

  function protectSilentPrompt(prompt) {
    var text = String(prompt || '').trim();
    if (!text) return text;
    if (/DO NOT SEARCH/i.test(text) && /DO NOT SPEAK/i.test(text)) return text;
    return '🚫 DO NOT SEARCH.\n' +
      '🚫 DO NOT SPEAK.\n' +
      '🚫 DO NOT SAVE NOTES.\n' +
      '🚫 DO NOT CREATE JOURNAL ENTRIES.\n' +
      'ONLY PROCESS THE PROVIDED INPUT.\n\n' + text;
  }

  function diagnosticsMuteActive() {
    return !!window.__STRUCTA_DIAGNOSTICS_RUNNING__ || !!window.__STRUCTA_FORCE_SILENT__;
  }

  function shouldBlockSpeech(policy) {
    var activePolicy = policy || currentOperationPolicy();
    return !!(activePolicy.allowSpeech === false || activePolicy.silent === true || diagnosticsMuteActive());
  }

  function effectiveSilentSource(policy) {
    if (diagnosticsMuteActive()) return 'diagnostics';
    return lower(policy?.source || 'background');
  }

  function effectiveSilentReason(policy) {
    if (diagnosticsMuteActive()) return 'diagnostics hard mute';
    return policy?.reason || 'silent policy';
  }

  function pushOperationPolicy(patch) {
    var next = Object.assign({}, currentOperationPolicy(), patch || {});
    operationPolicyStack.push(next);
    if (next.silent || next.allowSpeech === false) {
      native?.traceEvent?.('background.silent', 'active', lower(next.source || 'background'), {
        source: next.source || 'background',
        reason: next.reason || ''
      });
    }
    return function releasePolicy() {
      var index = operationPolicyStack.indexOf(next);
      if (index >= 0) operationPolicyStack.splice(index, 1);
      if (!operationPolicyStack.length) {
        operationPolicyStack.push({ allowSpeech: true, silent: false, source: 'default' });
      }
    };
  }

  function withOperationPolicy(patch, fn) {
    var release = pushOperationPolicy(patch);
    return Promise.resolve().then(function() {
      return fn();
    }).finally(release);
  }

  function speakMilestone(kind) {
    var normalized = normalizeMilestoneKind(kind);
    var STRINGS = {
      triangle_captured: 'signal captured',
      signal_captured: 'signal captured',
      decision_created: 'decision ready',
      decision_approved: 'locked',
      frame_ready: 'frame ready',
      project_live: 'project live'
    };
    var MULTI_FIRE = {
      triangle_captured: true,
      signal_captured: true,
      decision_created: true,
      decision_approved: true
    };
    var text = STRINGS[normalized];
    var policy = currentOperationPolicy();
    if (!text) {
      native?.recordVoiceCall?.(normalized || 'unknown', false, { reason: 'not-allowlisted' });
      return false;
    }
    if (shouldBlockSpeech(policy)) {
      var silentSource = effectiveSilentSource(policy);
      var silentReason = effectiveSilentReason(policy);
      native?.recordVoiceCall?.(normalized, true, {
        reason: 'policy-silent',
        source: silentSource
      });
      native?.traceEvent?.('voice.suppressed', 'requested', normalized, {
        source: silentSource,
        reason: silentReason
      });
      native?.traceEvent?.('speech.blocked_by_policy', 'requested', normalized, {
        source: silentSource,
        reason: silentReason
      });
      return false;
    }
    if (!runtimeCaps.hasBridge || typeof PluginMessageHandler === 'undefined') {
      native?.recordVoiceCall?.(normalized, true, { reason: 'bridge-unavailable' });
      return false;
    }
    var now = Date.now();
    if (!MULTI_FIRE[normalized] && native?.touchProjectMemory) {
      var duplicate = false;
      native.touchProjectMemory(function(project) {
        project.meta = project.meta || {};
        project.meta.milestones = project.meta.milestones || {};
        if (project.meta.milestones[normalized]) {
          duplicate = true;
          return;
        }
        project.meta.milestones[normalized] = new Date().toISOString();
      });
      if (duplicate) {
        native?.recordVoiceCall?.(normalized, true, { reason: 'project-dedupe' });
        return false;
      }
    }
    if (now - lastMilestoneSpeechAt < MILESTONE_COOLDOWN_MS) {
      native?.recordVoiceCall?.(normalized, true, { reason: 'cooldown' });
      return false;
    }
    lastMilestoneSpeechAt = now;
    try {
      PluginMessageHandler.postMessage(JSON.stringify({
        message: text,
        useLLM: false,
        useSerpAPI: false,
        wantsR1Response: true,
        wantsJournalEntry: false
      }));
      native?.recordVoiceCall?.(normalized, true, { reason: 'milestone' });
      native?.traceEvent?.('voice', 'silent', normalized, { milestone: normalized });
      return true;
    } catch (_) {
      native?.recordVoiceCall?.(normalized, true, { reason: 'post-failed' });
      return false;
    }
  }

  function evaluateMilestone(kind, options) {
    var normalized = normalizeMilestoneKind(kind);
    var opts = options && typeof options === 'object' ? options : {};
    var STRINGS = {
      triangle_captured: 'signal captured',
      signal_captured: 'signal captured',
      decision_created: 'decision ready',
      decision_approved: 'locked',
      frame_ready: 'frame ready',
      project_live: 'project live'
    };
    var MULTI_FIRE = {
      triangle_captured: true,
      signal_captured: true,
      decision_created: true,
      decision_approved: true
    };
    if (!STRINGS[normalized]) {
      return { ok: false, normalized: normalized, reason: 'not-allowlisted' };
    }
    if (opts.allowSpeech === false || opts.silent === true) {
      return { ok: false, normalized: normalized, reason: 'policy-silent' };
    }
    if (opts.hasBridge === false) {
      return { ok: false, normalized: normalized, reason: 'bridge-unavailable' };
    }
    if (!MULTI_FIRE[normalized] && opts.projectMilestones && opts.projectMilestones[normalized]) {
      return { ok: false, normalized: normalized, reason: 'project-dedupe' };
    }
    var now = Number(opts.now || Date.now());
    var last = Number(opts.lastMilestoneSpeechAt || 0);
    if (now - last < MILESTONE_COOLDOWN_MS) {
      return { ok: false, normalized: normalized, reason: 'cooldown' };
    }
    return { ok: true, normalized: normalized, reason: 'milestone' };
  }

  function evaluateMilestone(kind, options) {
    var normalized = normalizeMilestoneKind(kind);
    var opts = options && typeof options === 'object' ? options : {};
    var STRINGS = {
      triangle_captured: 'signal captured',
      signal_captured: 'signal captured',
      decision_created: 'decision ready',
      decision_approved: 'locked',
      frame_ready: 'frame ready',
      project_live: 'project live'
    };
    var MULTI_FIRE = {
      triangle_captured: true,
      signal_captured: true,
      decision_created: true,
      decision_approved: true
    };
    if (!STRINGS[normalized]) {
      return { ok: false, normalized: normalized, reason: 'not-allowlisted' };
    }
    if (opts.allowSpeech === false || opts.silent === true) {
      return { ok: false, normalized: normalized, reason: 'policy-silent' };
    }
    if (opts.hasBridge === false) {
      return { ok: false, normalized: normalized, reason: 'bridge-unavailable' };
    }
    if (!MULTI_FIRE[normalized] && opts.projectMilestones && opts.projectMilestones[normalized]) {
      return { ok: false, normalized: normalized, reason: 'project-dedupe' };
    }
    var now = Number(opts.now || Date.now());
    var last = Number(opts.lastMilestoneSpeechAt || 0);
    if (now - last < MILESTONE_COOLDOWN_MS) {
      return { ok: false, normalized: normalized, reason: 'cooldown' };
    }
    return { ok: true, normalized: normalized, reason: 'milestone' };
  }

  /**
   * sendToLLM -- core function.
   * Sends a message to the R1's on-device LLM via PluginMessageHandler.
   * Returns a promise that resolves with { ok, text, clean, structured }.
   * Supports optional imageBase64 for multimodal queries.
   */
  function clearBridgeRequest(request) {
    if (!request) return;
    if (request.timeout) clearTimeout(request.timeout);
    pendingBridgeRequests.delete(request.correlationId);
    if (activeRequest && activeRequest.id === request.id) {
      activeRequest = null;
    }
  }

  function clearImageBridgeRequest(request) {
    if (!request) return;
    if (request.timeout) clearTimeout(request.timeout);
    if (pendingImageBridgeRequest && pendingImageBridgeRequest.id === request.id) {
      pendingImageBridgeRequest = null;
    }
  }

  function bridgeSend(request) {
    return new Promise(function(resolve) {
      if (typeof PluginMessageHandler === 'undefined') {
        clearBridgeRequest(request);
        resolve({
          ok: false,
          error: 'PluginMessageHandler not available',
          code: 'bridge-unavailable',
          layer: 'bridge',
          latencyMs: Date.now() - (request.startedAt || request.createdAt || Date.now())
        });
        return;
      }

      pendingBridgeRequests.set(request.correlationId, request);
      request.timeout = setTimeout(function() {
        if (!pendingBridgeRequests.has(request.correlationId)) return;
        clearBridgeRequest(request);
        native?.traceEvent?.('bridge', 'pending', 'timeout', {
          correlationId: request.correlationId,
          requestId: request.id,
          pluginId: request.opts?.pluginId || ''
        });
        resolve({
          ok: false,
          error: 'BridgeTimeout',
          code: BRIDGE_TIMEOUT_CODE,
          layer: 'bridge',
          latencyMs: Date.now() - (request.startedAt || request.createdAt || Date.now()),
          correlationId: request.correlationId
        });
        processQueue();
      }, request.opts.timeout || 30000);

      var payload = {
        message: request.message,
        correlationId: request.correlationId,
        useLLM: request.opts.useSerpAPI ? false : true,
        wantsR1Response: request.opts.expectBridgeResponse === true,
        wantsJournalEntry: request.opts.journal || false
      };

      if (request.opts.imageBase64) payload.imageBase64 = request.opts.imageBase64;
      if (request.opts.pluginId) payload.pluginId = request.opts.pluginId;
      else if (shouldBlockSpeech(request.opts.policy || currentOperationPolicy())) payload.pluginId = 'com.playgranada.structa';
      if (request.opts.useSerpAPI) payload.useSerpAPI = true;

      try {
        PluginMessageHandler.postMessage(JSON.stringify(payload));
        resolve(null);
      } catch (err) {
        clearBridgeRequest(request);
        resolve({
          ok: false,
          error: 'postMessage failed: ' + err.message,
          code: 'bridge-post-failed',
          layer: 'bridge',
          latencyMs: Date.now() - (request.startedAt || request.createdAt || Date.now())
        });
      }
    });
  }

  function sendToLLM(message, options) {
    var opts = options || {};
    var id = getNextId();
    var protectedMessage = message;
    if (!opts.useSerpAPI && typeof protectedMessage === 'string' && !/DO NOT SEARCH/i.test(protectedMessage)) {
      protectedMessage =
        'Use only the provided context.\n\n' +
        protectedMessage;
    }

    return new Promise(function(resolve) {
      var request = {
        id: id,
        correlationId: createCorrelationId(),
        message: protectedMessage,
        opts: opts,
        createdAt: Date.now(),
        resolve: resolve
      };

      if (opts.priority === 'low') {
        requestQueue.push(request);
      } else {
        var firstLowIndex = requestQueue.findIndex(function(entry) { return entry.opts && entry.opts.priority === 'low'; });
        if (firstLowIndex === -1) requestQueue.push(request);
        else requestQueue.splice(firstLowIndex, 0, request);
      }

      processQueue();
    });
  }

  function sendBridgeImage(imageBase64, prompt, options) {
    var opts = options || {};
    if (typeof PluginMessageHandler === 'undefined') {
      return Promise.resolve({
        ok: false,
        error: 'PluginMessageHandler not available',
        code: 'bridge-unavailable',
        layer: 'bridge'
      });
    }
    if (pendingImageBridgeRequest) {
      return Promise.resolve({
        ok: false,
        error: 'image bridge busy',
        code: 'bridge-busy',
        layer: 'bridge'
      });
    }
    return new Promise(function(resolve) {
      var request = {
        id: getNextId(),
        startedAt: Date.now(),
        resolve: resolve,
        timeout: null
      };
      pendingImageBridgeRequest = request;
      request.timeout = setTimeout(function() {
        if (!pendingImageBridgeRequest || pendingImageBridgeRequest.id !== request.id) return;
        clearImageBridgeRequest(request);
        native?.traceEvent?.('bridge', 'pending', 'timeout', {
          requestId: request.id,
          mode: 'image'
        });
        resolve({
          ok: false,
          error: 'BridgeTimeout',
          code: BRIDGE_TIMEOUT_CODE,
          layer: 'bridge',
          latencyMs: Date.now() - request.startedAt
        });
      }, opts.timeout || 30000);

      var payload = {
        message: String(prompt || '').trim() || 'Describe what you see in this image',
        imageBase64: imageBase64,
        useLLM: true,
        wantsR1Response: false,
        wantsJournalEntry: opts.journal === true
      };

      if (native && native.probeMode && native.appendProbeEvent) {
        native.appendProbeEvent({
          source: 'bridge-out',
          name: 'image request',
          payload: {
            message: compactText(payload.message, 140),
            journal: payload.wantsJournalEntry === true
          }
        });
      }

      try {
        PluginMessageHandler.postMessage(JSON.stringify(payload));
      } catch (err) {
        clearImageBridgeRequest(request);
        resolve({
          ok: false,
          error: 'postMessage failed: ' + err.message,
          code: 'bridge-post-failed',
          layer: 'bridge',
          latencyMs: Date.now() - request.startedAt
        });
      }
    });
  }

  function processQueue() {
    if (activeRequest || !requestQueue.length || dispatchTimer) return;

    var now = Date.now();
    var elapsed = now - lastCallTime;
    var delay = elapsed < MIN_GAP_MS ? MIN_GAP_MS - elapsed : 0;

    dispatchTimer = setTimeout(function() {
      dispatchTimer = null;
      if (activeRequest || !requestQueue.length) return;

      var request = requestQueue.shift();
      if (!request) return;

      lastCallTime = Date.now();
      request.startedAt = lastCallTime;
      activeRequest = request;
      bridgeSend(request).then(function(dispatchResult) {
        if (!dispatchResult) return;
        request.resolve(dispatchResult);
        processQueue();
      });
    }, delay);
  }

  // === Response handler ===
  var previousHandler = window.onPluginMessage;

  function extractCorrelationId(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.correlationId === 'string' && payload.correlationId) return payload.correlationId;
    if (typeof payload.requestId === 'string' && payload.requestId) return payload.requestId;
    if (payload.data && typeof payload.data === 'object') {
      var nested = extractCorrelationId(payload.data);
      if (nested) return nested;
    }
    return '';
  }

  window.onPluginMessage = function(data) {
    if (native && native.probeMode && native.appendProbeEvent) {
      var probeName = 'message';
      try {
        var payload = data && typeof data === 'object' ? data : {};
        var correlation = extractCorrelationId(payload);
        var responseText = extractResponseText(payload);
        var keys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 6).join(',') : typeof data;
        probeName = 'message in' +
          (correlation ? ' corr=' + compactText(correlation, 28) : '') +
          (responseText ? ' text=' + compactText(responseText, 40) : '') +
          (keys ? ' keys=' + keys : '');
      } catch (_) {}
      native.appendProbeEvent({
        source: 'bridge-in',
        name: probeName
      });
    }

    // STT handling — match exact R1 format: { type: 'sttEnded', transcript: '...' }
    if (data && data.type === 'sttEnded' && data.transcript) {
      if (previousHandler) {
        try { previousHandler(data); } catch (e) {}
      }
      window.dispatchEvent(new CustomEvent('structa-stt-ended', {
        detail: { transcript: data.transcript }
      }));
      return;
    }

    if (pendingImageBridgeRequest) {
      var imageRequest = pendingImageBridgeRequest;
      var rawDump = '';
      try {
        rawDump = typeof data === 'string' ? data : JSON.stringify(data || {});
      } catch (_) {
        rawDump = '';
      }
      var imageText = extractResponseText(data);
      if (native && native.probeMode && native.appendProbeEvent) {
        native.appendProbeEvent({
          source: 'bridge-in-raw',
          name: 'image response' +
            (rawDump ? ' raw=' + compactText(rawDump, 120) : '')
        });
      }
      native?.traceEvent?.('plugin.message.raw', 'in', 'image', {
        dump: compactText(rawDump, 800),
        hasText: !!imageText
      });
      clearImageBridgeRequest(imageRequest);
      if (!imageText) {
        if (rawDump && rawDump !== '{}' && rawDump !== 'null') {
          imageText = rawDump;
        } else {
          imageRequest.resolve({
            ok: false,
            error: 'image bridge empty response',
            code: 'bridge-empty-response',
            layer: 'bridge',
            latencyMs: Date.now() - imageRequest.startedAt
          });
          return;
        }
      }
      var imageClean = sanitizeResponse(imageText);
      if (native && native.probeMode && native.appendProbeEvent) {
        native.appendProbeEvent({
          source: 'bridge-in-parsed',
          name: 'image text' +
            (imageClean ? ' text=' + compactText(imageClean, 120) : '')
        });
      }
      native?.traceEvent?.('plugin.message.parsed', 'in', 'image', {
        text: compactText(imageClean, 240)
      });
      imageRequest.resolve({
        ok: true,
        text: imageText,
        clean: imageClean,
        structured: extractFields(imageClean),
        latencyMs: Date.now() - imageRequest.startedAt
      });
      return;
    }

    // Try to extract the LLM response text
    var responseText = extractResponseText(data);
    var correlationId = extractCorrelationId(data);

    if ((correlationId && pendingBridgeRequests.has(correlationId)) || (activeRequest && responseText)) {
      var cb = correlationId && pendingBridgeRequests.has(correlationId)
        ? pendingBridgeRequests.get(correlationId)
        : activeRequest;
      if (cb) {
        clearBridgeRequest(cb);
        if (native && native.probeMode && native.appendProbeEvent) {
          native.appendProbeEvent({
            source: 'bridge-in',
            name: 'response received'
          });
        }
        var clean = sanitizeResponse(responseText);
        cb.resolve({
          ok: true,
          text: responseText,
          clean: clean,
          structured: extractFields(clean),
          correlationId: cb.correlationId || correlationId || ''
        });
        processQueue();
        return;
      }
    }

    // Pass to previous handler if any
    if (previousHandler) {
      try { previousHandler(data); } catch (e) {}
    }
  };

  function extractResponseText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload)) {
      for (var i = 0; i < payload.length; i += 1) {
        var candidate = extractResponseText(payload[i]);
        if (candidate) return candidate;
      }
      return '';
    }
    if (typeof payload !== 'object') return String(payload || '');

    var directKeys = ['message', 'content', 'response', 'transcript', 'text', 'output', 'answer', 'body', 'summary', 'caption', 'value'];
    for (var k = 0; k < directKeys.length; k += 1) {
      var value = payload[directKeys[k]];
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') {
        var nested = extractResponseText(value);
        if (nested) return nested;
      }
    }

    if (payload.content && Array.isArray(payload.content)) {
      var contentText = extractResponseText(payload.content);
      if (contentText) return contentText;
    }
    if (payload.parts && Array.isArray(payload.parts)) {
      var partsText = extractResponseText(payload.parts);
      if (partsText) return partsText;
    }
    if (payload.blocks && Array.isArray(payload.blocks)) {
      var blocksText = extractResponseText(payload.blocks);
      if (blocksText) return blocksText;
    }
    if (payload.segments && Array.isArray(payload.segments)) {
      var segmentsText = extractResponseText(payload.segments);
      if (segmentsText) return segmentsText;
    }
    if (payload.candidates && Array.isArray(payload.candidates)) {
      var candidatesText = extractResponseText(payload.candidates);
      if (candidatesText) return candidatesText;
    }
    if (payload.delta) {
      var deltaText = extractResponseText(payload.delta);
      if (deltaText) return deltaText;
    }

    if (payload.data) {
      if (typeof payload.data === 'string') {
        try {
          var parsed = JSON.parse(payload.data);
          var parsedText = extractResponseText(parsed);
          if (parsedText) return parsedText;
        } catch (e) {
          return payload.data;
        }
      } else {
        var dataText = extractResponseText(payload.data);
        if (dataText) return dataText;
      }
    }

    if (payload.results) {
      var resultText = extractResponseText(payload.results);
      if (resultText) return resultText;
    }
    if (payload.choices) {
      var choiceText = extractResponseText(payload.choices);
      if (choiceText) return choiceText;
    }
    if (payload.result) {
      var nestedResult = extractResponseText(payload.result);
      if (nestedResult) return nestedResult;
    }
    if (payload.candidate) {
      var nestedCandidate = extractResponseText(payload.candidate);
      if (nestedCandidate) return nestedCandidate;
    }
    return '';
  }

  // === Sanitization ===
  var DRIFT = [
    /github|repository/gi,
    /can.t access.*web|unable to.*web/gi,
    /dlam|rabbit\.tech/gi,
    /web search|look up online/gi,
    /I can.t help/gi,
    /let'?s calculate(?:\s+what\s+is|\s+what's)?\s+\d+/gi,
    /\bone plus one\b|\btwo plus two\b|\bthree plus three\b/gi
  ];

  function sanitizeResponse(text) {
    if (!text) return '';
    var clean = text.trim();
    var sentences = clean.split(/(?<=[.!?])\s+/);
    var filtered = sentences.filter(function(s) {
      return !DRIFT.some(function(d) { return d.test(s); });
    });
    return filtered.join(' ').trim() || '';
  }

  function extractFields(text) {
    var result = { raw: text, insight: text, next: '', decision: '', conf: 'med' };

    // Extract decision — LLM prefixes decisions with "DECISION:"
    var dMatch = text.match(/(?:^|\s)DECISION:\s*(.{10,120})/i);
    if (dMatch) {
      result.decision = dMatch[1].trim().replace(/^["']|["']$/g, '');
    } else {
      // Also detect decision language
      var dm = text.match(/(?:we (?:decided|agreed|chose|should|will|plan to))[:\s]*(.{10,100})/i);
      if (dm) result.decision = dm[0].trim();
    }

    // Extract next step
    var m = text.match(/(?:next step|suggest|recommend|you should|start by|try)[:\s]*(.{10,100})/i);
    if (m) result.next = m[1].trim();

    if (/definitely|clearly/i.test(text)) result.conf = 'high';
    if (/maybe|perhaps|might/i.test(text)) result.conf = 'low';

    return result;
  }

  // === Context builder ===

  function buildProjectContext(opts) {
    var options = opts || {};
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var parts = [];

    if (project.name && project.name !== 'untitled project') {
      parts.push('Project: ' + project.name);
    }
    if (project.type && project.type !== 'general') {
      parts.push('Type: ' + project.type);
    }
    if (project.user_role) {
      parts.push('Role: ' + project.user_role);
    }

    // Include recent decisions for deep context (image analysis needs this)
    var decisions = project.decisions || [];
    if (decisions.length && options.deep) {
      parts.push('Recent decisions: ' + decisions.slice(0, 3).map(function(d) {
        return (typeof d === 'string' ? d : (d.text || '')).slice(0, 40);
      }).join('; '));
    }

    // Include recent insights for deep context
    var insights = project.insights || [];
    if (insights.length && options.deep) {
      parts.push('Recent insights: ' + insights.slice(0, 3).map(function(ins) {
        return (ins.body || ins.title || '').slice(0, 40);
      }).join('; '));
    }

    var backlog = project.backlog || [];
    if (backlog.length) {
      parts.push('Backlog (' + backlog.length + '): ' + backlog.slice(0, 3).map(function(b) { return b.title; }).join(', '));
      parts.push('Current focus: ' + (backlog[0].title || '').slice(0, 60));
    }
    var questions = project.open_questions || [];
    if (questions.length) {
      parts.push('Open questions (' + questions.length + '): ' + questions.slice(0, 2).map(function(q) {
        return q.length > 40 ? q.slice(0, 40) + '...' : q;
      }).join('; '));
    }
    var pending = project.pending_decisions || [];
    if (pending.length) {
      var pd = typeof pending[0] === 'string' ? pending[0] : pending[0].text;
      parts.push('Pending decision: ' + (pd || '').slice(0, 60));
    }

    // Clarity score
    if (project.clarity_score > 0) {
      parts.push('Clarity: ' + project.clarity_score + '%');
    }

    return parts.join('\n');
  }

  function getRecentProjectClaims(project, limit) {
    return (project?.claims || [])
      .filter(function(claim) {
        return claim && claim.status === 'active' && claim.text;
      })
      .slice()
      .sort(function(a, b) {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      })
      .slice(0, limit || 3)
      .map(function(claim) {
        return {
          id: claim.id || '',
          text: String(claim.text || '').slice(0, 160),
          kind: claim.kind || 'fact',
          branchId: claim.branchId || 'main',
          status: claim.status || 'active'
        };
      });
  }

  function getProjectOpenQuestions(project, limit) {
    return (project?.open_question_nodes || [])
      .slice(0, limit || 2)
      .map(function(question) {
        return {
          id: question.node_id || '',
          body: String(question.body || question.title || '').slice(0, 160),
          branchId: question.branch_id || question.meta?.branch_id || 'main'
        };
      });
  }

  function getActiveBranch(project) {
    var focus = native?.getActiveFocus?.();
    if (focus?.target?.branchId || focus?.target?.id) {
      return {
        id: focus.target.branchId || focus.target.id || 'main',
        name: focus.target.branchId || focus.target.id || 'main',
        parentBranchId: ''
      };
    }
    return {
      id: 'main',
      name: 'main',
      parentBranchId: ''
    };
  }

  function buildHistoryContext() {
    if (!conversationHistory.length) return '';
    return '\nRecent:\n' + conversationHistory.slice(-4).map(function(h) {
      return (h.role === 'user' ? 'User: ' : 'AI: ') + h.text.slice(0, 60);
    }).join('\n');
  }

  function buildProjectEnvelope(surface) {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    return {
      id: project.project_id || project.id || '',
      name: project.name || 'untitled project',
      type: project.type || 'general',
      brief: project.brief || '',
      topQuestions: (project.open_questions || []).slice(0, 3),
      openQuestions: getProjectOpenQuestions(project, 2),
      recentClaims: getRecentProjectClaims(project, 3),
      activeBranch: getActiveBranch(project),
      selectedSurface: surface || '',
      summary: buildProjectContext({ deep: true })
    };
  }

  function buildSelectionEnvelope(buildContext) {
    if (!buildContext) return null;
    return {
      kind: buildContext.kind || '',
      id: buildContext.nodeId || '',
      title: buildContext.title || '',
      summary: String(buildContext.text || '').slice(0, 220),
      status: buildContext.status || 'open',
      createdAt: buildContext.createdAt || '',
      claims: buildContext.nodeId && native?.getClaimsForItem ? native.getClaimsForItem(buildContext.nodeId).slice(0, 6) : []
    };
  }

  function executePreparedLLM(prepared) {
    if (!prepared || !prepared.llm) {
      return Promise.resolve({ ok: false, error: 'llm payload unavailable' });
    }
    return sendToLLM(prepared.llm.prompt || '', {
      imageBase64: prepared.llm.imageBase64,
      journal: false,
      timeout: prepared.llm.timeout,
      priority: prepared.llm.priority,
      useSerpAPI: prepared.llm.useSerpAPI || false
    });
  }

  // === Specialized entry points ===

  /**
   * processVoice -- main voice handler.
   * Now injects project context and conversation history for grounded responses.
   * options.answeringQuestion + options.questionText = answer mode (for know card)
   */
  function processVoice(transcript, options) {
    var opts = options || {};
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.interpretVoice) {
      return Promise.resolve({ ok: false, error: 'orchestrator unavailable' });
    }

    // Track in conversation history
    conversationHistory.push({ role: 'user', text: transcript, time: Date.now() });
    if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();

    var payload = {
      project: buildProjectEnvelope(opts.buildContext && opts.buildContext.surface ? opts.buildContext.surface : (opts.answeringQuestion ? 'know' : 'tell')),
      selection: buildSelectionEnvelope(opts.buildContext),
      input: {
        transcript: transcript
      },
      policy: {
        priority: 'high',
        allowSearch: false,
        allowSpeech: false
      },
      history: conversationHistory.slice(-4),
      answeringQuestion: !!opts.answeringQuestion,
      questionText: opts.questionText || ''
    };

    return orchestrator.interpretVoice(payload, executePreparedLLM).then(function(result) {
      // Track LLM response in history
      if (result && result.ok && result.clean) {
        conversationHistory.push({ role: 'bot', text: result.clean, time: Date.now() });
        if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
      }
      return result;
    });
  }

  function buildBridgeImagePrompt(projectEnvelope, description, options) {
    var projectName = compactText(projectEnvelope?.name || 'untitled project', 64);
    var context = compactText(description || options?.imageRef || options?.imageId || 'camera frame', 96);
    var intent = compactText(options?.voiceAnnotation || '', 96);
    var lines = [
      'Analyze this image for the current project.',
      'Describe only visible facts relevant to the project context.',
      'Write 2 short sentences in plain prose.',
      'project: ' + projectName,
      'context: ' + context,
      'intent: ' + (intent || 'none')
    ];
    return lines.join('\n');
  }

  function emailText(subject, body) {
    var safeSubject = compactText(subject || 'Structa export', 96);
    var safeBody = String(body || '').trim();
    if (safeBody.length > 2800) {
      safeBody = safeBody.slice(0, 2799).trimEnd() + '…';
    }
    var messaging = window.r1?.messaging;
    var hasNativeEmail = typeof messaging?.emailUser === 'function';
    traceEmail('email.attempt', 'idle', hasNativeEmail ? 'native' : 'unavailable', {
      subject: safeSubject,
      bodyBytes: safeBody.length
    });
    if (hasNativeEmail) {
      return Promise.resolve(messaging.emailUser({
        subject: safeSubject,
        body: safeBody
      })).then(function(result) {
        if (result && typeof result === 'object' && result.ok === false) {
          traceEmail('email.native.failed', 'pending', 'native-rejected', {
            subject: safeSubject,
            bodyBytes: safeBody.length,
            error: result.error || 'native rejected'
          });
          return {
            ok: false,
            error: result.error || 'email failed',
            code: 'email-native-rejected',
            mode: 'native'
          };
        }
        traceEmail('email.native.result', 'pending', 'ok', {
          subject: safeSubject,
          bodyBytes: safeBody.length
        });
        return { ok: true, mode: 'native', subject: safeSubject };
      }).catch(function(error) {
        traceEmail('email.native.failed', 'pending', 'failed', {
          subject: safeSubject,
          bodyBytes: safeBody.length,
          error: error?.message || 'email failed'
        });
        return {
          ok: false,
          error: error?.message || 'email failed',
          code: 'email-native-error',
          mode: 'native'
        };
      });
    }
    traceEmail('email.native.unavailable', 'pending', 'no-native-api', {
      subject: safeSubject,
      bodyBytes: safeBody.length
    });
    return Promise.resolve({
      ok: false,
      error: 'email unavailable',
      code: 'email-unavailable',
      mode: 'none'
    });
  }

  function runImageServerFallback(orchestrator, payload, options, fromState, reason) {
    native?.traceEvent?.('image.dispatch', fromState || 'bridge-timeout', 'fallback-server', {
      entryId: options.imageId || '',
      reason: reason || 'bridge timeout'
    });
    if (!orchestrator?.analyzeImage) {
      return Promise.resolve({ ok: false, error: reason || 'bridge timeout', code: BRIDGE_TIMEOUT_CODE });
    }
    return orchestrator.analyzeImage(payload, executePreparedLLM);
  }

  /**
   * processImage -- sends image to R1 LLM with FULL project context.
   * Project type fundamentally changes how to interpret an image:
   * - Architecture: materials, spatial relationships, structure
   * - Software: UI patterns, error states, code
   * - Design: composition, color, typography
   * - Film: framing, lighting, narrative
   * Returns a promise with { ok, clean, structured }.
   */
  function processImage(rawBase64, description, meta) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.prepareImageContextPrompt) {
      return Promise.resolve({ ok: false, error: 'orchestrator unavailable' });
    }
    var options = meta || {};
    var priority = 'high';
    var projectEnvelope = buildProjectEnvelope('show');
    var selection = {
      kind: 'capture',
      id: options.itemId || options.imageId || '',
      body: description || 'camera capture',
      claims: options.itemId && native?.getClaimsForItem ? native.getClaimsForItem(options.itemId).slice(0, 6) : []
    };
    var payload = {
      project: projectEnvelope,
      selection: selection,
      input: {
        transcript: options.voiceAnnotation || '',
        voiceAnnotation: options.voiceAnnotation || '',
        imageId: options.imageId || '',
        itemId: options.itemId || '',
        imageRef: description || 'camera capture',
        imageBase64: rawBase64
      },
      meta: options,
      policy: {
        priority: priority,
        allowSearch: false,
        allowSpeech: false
      }
    };
    var startedAt = Date.now();

    if (options.forceFallbackServer || !runtimeCaps.hasBridge) {
      native?.traceEvent?.('image.dispatch', 'bridge-unavailable', 'fallback-server', {
        entryId: options.imageId || '',
        reason: options.forceFallbackServer ? 'forced fallback' : 'bridge unavailable'
      });
      return runImageServerFallback(
        orchestrator,
        payload,
        options,
        options.forceFallbackServer ? 'forced-fallback' : 'bridge-unavailable',
        options.forceFallbackServer ? 'forced fallback' : 'bridge unavailable'
      );
    }

    return withOperationPolicy({
      allowSpeech: false,
      silent: true,
      source: 'image',
      reason: 'visual notes stay quiet'
    }, function() {
      var prompt = buildBridgeImagePrompt(projectEnvelope, description, options);
      native?.traceEvent?.('image.dispatch', 'prepare', 'bridge', {
        entryId: options.imageId || '',
        projectId: projectEnvelope.id || '',
        promptLength: prompt.length
      });
      return sendBridgeImage(rawBase64, prompt, {
        journal: options.journal === true,
        timeout: Number(options.timeout || 12000)
      }).then(function(bridgeResult) {
          if (!bridgeResult || !bridgeResult.ok || !bridgeResult.clean) {
            if (bridgeResult?.code === BRIDGE_TIMEOUT_CODE && options.forceBridgeOnly) {
              return bridgeResult;
            }
            if (bridgeResult?.code === BRIDGE_TIMEOUT_CODE) {
              return runImageServerFallback(orchestrator, payload, options, 'bridge-timeout', 'bridge timeout');
            }
            return bridgeResult;
          }
          native?.traceEvent?.('image.bridge', 'pending', 'response', {
            entryId: options.imageId || '',
            textLength: String(bridgeResult.clean || bridgeResult.text || '').length,
            latencyMs: Date.now() - startedAt
          });
          if (native && native.probeMode && native.appendProbeEvent) {
            native.appendProbeEvent({
              source: 'server-normalize',
              name: 'claims extraction',
              payload: {
                imageId: options.imageId || '',
                chars: String(bridgeResult.clean || bridgeResult.text || '').length
              }
            });
          }
          return extractClaimsFromText({
            project: projectEnvelope,
            input: {
              text: bridgeResult.clean || bridgeResult.text || '',
              deviceId: native?.deviceId || ''
            },
            source: options.voiceAnnotation ? 'show-tell' : 'image',
            sourceRef: {
              imageId: options.imageId || '',
              itemId: options.itemId || ''
            },
            meta: {
              deviceId: native?.deviceId || '',
              imageId: options.imageId || ''
            }
          }).then(function(extracted) {
            var claims = Array.isArray(extracted?.claims) ? extracted.claims : [];
            if (claims.length) {
              native?.traceEvent?.('image.claims', 'pending', 'extracted', {
                entryId: options.imageId || '',
                count: claims.length
              });
            } else if (!extracted?.ok) {
              native?.traceEvent?.('image.claims', 'pending', 'extraction_failed', {
                entryId: options.imageId || '',
                reason: extracted?.error || 'extraction failed'
              });
            }
            return {
              ok: true,
              text: bridgeResult.text || bridgeResult.clean || '',
              clean: bridgeResult.clean || bridgeResult.text || '',
              structured: extractFields(bridgeResult.clean || bridgeResult.text || ''),
              claims: claims,
              claim_extraction_pending: !claims.length,
              bridge: true
            };
          });
        });
    });
  }

  function extractClaimsFromText(payload) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.extractClaimsFromText) {
      return Promise.resolve({ ok: false, claims: [], error: 'claims extractor unavailable' });
    }
    var envelope = Object.assign({}, payload || {});
    envelope.policy = {
      priority: 'low',
      allowSearch: false,
      allowSpeech: false
    };
    return withTimeout(
      orchestrator.extractClaimsFromText(envelope),
      12000,
      'image claim extraction'
    ).catch(function(error) {
      return { ok: false, claims: [], error: error?.message || 'image claim extraction failed' };
    });
  }

  function refineThreadComment(payload) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.refineThread) {
      return Promise.resolve({ ok: false, summary: '', claims: [], clarifies: '', contradicts: '' });
    }
    var envelope = Object.assign({}, payload || {});
    envelope.policy = {
      priority: 'low',
      allowSearch: false,
      allowSpeech: false
    };
    return withTimeout(
      orchestrator.refineThread(envelope, executePreparedLLM),
      12000,
      'thread extract'
    ).catch(function() {
      return { ok: false, summary: '', claims: [], clarifies: '', contradicts: '' };
    });
  }

  function backfillClaimsForItem(payload) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.backfillClaims) {
      return Promise.resolve({ ok: false, claims: [] });
    }
    var envelope = Object.assign({}, payload || {});
    envelope.policy = {
      priority: 'low',
      allowSearch: false,
      allowSpeech: false
    };
    return withTimeout(
      orchestrator.backfillClaims(envelope, executePreparedLLM),
      18000,
      'claims backfill'
    ).catch(function() {
      return { ok: false, claims: [] };
    });
  }

  function query(question) {
    var context = buildProjectContext();
    var parts = context ? [context, '', question] : [question];
    return sendToLLM(parts.join('\n'));
  }

  /**
   * storeAsInsight -- stores LLM result as project insight.
   * Auto-extracts decisions and creates pending_decisions.
   */
  function storeAsInsight(result, sourceType, sourceMeta) {
    if (!result || !result.ok || !result.clean) return null;
    if (!native) return null;

    var insight = {
      title: (sourceType || 'llm') + ' insight',
      body: result.clean,
      next: result.structured ? result.structured.next : '',
      confidence: result.structured ? result.structured.conf : 'med',
      created_at: new Date().toISOString()
    };

    var decisionText = result.structured && result.structured.decision;
    var createdNode = null;

    if (native.addNode) {
      createdNode = native.addNode({
        type: 'insight',
        status: 'open',
        title: insight.title,
        body: insight.body,
        source: sourceType || 'voice',
        confidence: insight.confidence,
        next_action: insight.next,
        tags: sourceType ? [sourceType] : []
      });

      if (decisionText) {
        var project = native.getProjectMemory ? native.getProjectMemory() : {};
        var pending = project.pending_decisions || [];
        var exists = pending.some(function(d) { return (d.text || d) === decisionText; });
        if (!exists) {
          native.addNode({
            type: 'decision',
            status: 'open',
            title: decisionText,
            body: result.clean,
            source: sourceType || 'voice',
            decision_options: []
          });
        }
      }

      if (createdNode && window.StructaLLM && window.StructaLLM.linkNode) {
        window.StructaLLM.linkNode(createdNode.node_id);
      }
      if (createdNode && Array.isArray(result.claims) && native.ingestClaims) {
        var sourceRef = {
          itemId: createdNode.node_id
        };
        if (sourceMeta && typeof sourceMeta === 'object') {
          Object.keys(sourceMeta).forEach(function(key) {
            if (sourceMeta[key]) sourceRef[key] = sourceMeta[key];
          });
        }
        var storedClaims = native.ingestClaims(result.claims, {
          source: sourceType || 'voice',
          sourceRef: sourceRef,
          sttConfidence: typeof result.answerNode?.sttConfidence === 'number' ? result.answerNode.sttConfidence : null
        });
        if (storedClaims && storedClaims.length && native.touchProjectMemory) {
          createdNode.meta = { ...(createdNode.meta || {}), claim_ids: storedClaims.map(function(entry) { return entry.id; }) };
          native.touchProjectMemory(function(project) {
            var node = (project.nodes || []).find(function(entry) { return entry.node_id === createdNode.node_id; });
            if (!node) return;
            node.meta = { ...(node.meta || {}), claim_ids: storedClaims.map(function(entry) { return entry.id; }) };
          });
        }
      }
      return createdNode;
    }

    if (native.touchProjectMemory) {
      native.touchProjectMemory(function(project) {
        project.insights = Array.isArray(project.insights) ? project.insights : [];
        project.insights.unshift(insight);
        project.insights = project.insights.slice(0, 16);

        if (decisionText) {
          project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
          var exists = project.pending_decisions.some(function(d) {
            return (d.text || d) === decisionText;
          });
          if (!exists) {
            project.pending_decisions.unshift({
              text: decisionText,
              source: sourceType || 'voice',
              insight_body: result.clean,
              created_at: new Date().toISOString()
            });
            project.pending_decisions = project.pending_decisions.slice(0, 8);
          }
        }
      });
    }

    return insight;
  }

  function resetHistory() { conversationHistory = []; }

  // === Auto-linking ===
  /**
   * linkNode — finds related existing nodes and creates bidirectional links.
   * Called after every new node creation.
   */
  function linkNode(newNodeId) {
    if (!native || !native.getProjectMemory) return Promise.resolve([]);
    var project = native.getProjectMemory();
    var nodes = project.nodes || [];
    var newNode = nodes.find(function(n) { return n.node_id === newNodeId; });
    if (!newNode || nodes.length < 2) return Promise.resolve([]);

    var existing = nodes.filter(function(n) { return n.node_id !== newNodeId && n.status !== 'archived'; }).slice(0, 8);
    if (!existing.length) return Promise.resolve([]);

    var prompt = '🚫 DO NOT SEARCH.\n' +
      'New item: "' + (newNode.title + ' ' + newNode.body).slice(0, 80) + '" (type: ' + newNode.type + ')\n\n' +
      'Existing items:\n' +
      existing.map(function(n, i) { return (i + 1) + '. "' + (n.title + ' ' + n.body).slice(0, 50) + '" (' + n.type + ')'; }).join('\n') +
      '\n\nWhich items (by number) are related? Return ONLY comma-separated numbers, or "none".';

    return sendToLLM(prompt, { journal: false, timeout: 15000, priority: 'low' }).then(function(result) {
      if (!result || !result.ok || !result.clean) return [];
      var matches = result.clean.match(/\d+/g);
      if (!matches) return [];
      var linkedIds = [];
      matches.forEach(function(m) {
        var idx = parseInt(m, 10) - 1;
        if (idx >= 0 && idx < existing.length) {
          linkedIds.push(existing[idx].node_id);
        }
      });
      // Create bidirectional links
      if (linkedIds.length && native.touchProjectMemory) {
        native.touchProjectMemory(function(proj) {
          var target = proj.nodes.find(function(n) { return n.node_id === newNodeId; });
          if (!target) return;
          linkedIds.forEach(function(lid) {
            if (!target.links.includes(lid)) target.links.push(lid);
            var other = proj.nodes.find(function(n) { return n.node_id === lid; });
            if (other && !other.links.includes(newNodeId)) other.links.push(newNodeId);
          });
        });
      }
      return linkedIds;
    }).catch(function() { return []; });
  }

  // === SERP Research ===
  /**
   * research — performs web search via R1 SERP API + LLM synthesis.
   * Returns 3 compressed findings.
   */
  function research(query) {
    return withOperationPolicy({
      allowSpeech: false,
      silent: true,
      source: 'research',
      reason: 'background research stays written'
    }, function() {
      var context = buildProjectContext({ deep: false });
      var formulationPrompt = '🚫 DO NOT SEARCH. DO NOT SAVE NOTES.\n' +
        (context ? 'Project context:\n' + context.slice(0, 220) + '\n\n' : '') +
        'Topic: "' + query + '"\n' +
        'Write the best web search query only. 3 to 8 words.';

      return sendToLLM(formulationPrompt, { journal: false, timeout: 15000, priority: 'high' })
        .then(function(formulated) {
          var searchQuery = (formulated && formulated.ok && formulated.clean) ? formulated.clean.replace(/^["']|["']$/g, '') : query;
          return sendToLLM(JSON.stringify({
            query: searchQuery,
            tag: 'search',
            useLocation: false
          }), {
            useSerpAPI: true,
            journal: false,
            timeout: 25000,
            priority: 'high'
          }).then(function(searchResult) {
            return { searchQuery: searchQuery, searchResult: searchResult };
          });
        })
        .then(function(payload) {
          if (!payload.searchResult || !payload.searchResult.ok) return { ok: false, findings: [] };
          var rawResults = payload.searchResult.text || payload.searchResult.clean || '';
          var synthesisPrompt = '🚫 DO NOT SEARCH AGAIN. DO NOT SAVE NOTES.\n' +
            (context ? 'Project context:\n' + context.slice(0, 220) + '\n\n' : '') +
            'Search topic: "' + query + '"\n' +
            'Search query used: "' + payload.searchQuery + '"\n\n' +
            'Search results:\n' + String(rawResults).slice(0, 2400) + '\n\n' +
            'Return exactly 3 numbered findings. Each finding must be 10 words max and useful for the project.';
          return sendToLLM(synthesisPrompt, { journal: false, timeout: 20000, priority: 'high' })
            .then(function(result) {
              if (!result || !result.ok) return { ok: false, findings: [] };
              var lines = (result.clean || '').split(/\n/).filter(function(l) { return l.trim(); });
              var findings = lines.slice(0, 3).map(function(l) { return l.replace(/^\d+[\.\)]\s*/, '').trim(); });
              if (native && native.addNode && findings.length) {
                native.addNode({
                  type: 'research', title: 'branch: ' + query.slice(0, 40),
                  body: findings.join(' | '), source: 'serp',
                  research_findings: findings,
                  tags: query.toLowerCase().split(/\s+/).slice(0, 3),
                  meta: { search_query: payload.searchQuery, silent: true }
                });
              }
              return { ok: true, query: query, searchQuery: payload.searchQuery, findings: findings, raw: result.clean, serpRaw: rawResults };
            });
        });
    });
  }

  // === Export generation ===
  /**
   * generateExport — creates a project brief, decision log, or research report.
   * Sends result via email through R1's LLM bridge.
   */
  function generateExport(type) {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var exportType = type || 'brief';

    var prompt;
    if (exportType === 'brief') {
      prompt = 'Create a project brief for "' + (project.name || 'untitled') + '".\n' +
        'Type: ' + (project.type || 'general') + '\n' +
        'Decisions: ' + (project.decisions || []).length + '\n' +
        'Insights: ' + (project.insights || []).length + '\n' +
        'Open questions: ' + (project.open_questions || []).length + '\n\n' +
        'Write a 5-sentence executive summary. Then list top 3 decisions and top 3 open items.';
    } else if (exportType === 'decisions') {
      var decs = (project.decisions || []).slice(0, 10);
      prompt = 'Format these project decisions as a clean decision log:\n' +
        decs.map(function(d, i) {
          return (i + 1) + '. ' + (typeof d === 'string' ? d : (d.text || ''));
        }).join('\n') + '\n\nAdd date headers and status for each.';
    } else {
      var research = (project.nodes || []).filter(function(n) { return n.type === 'research'; });
      prompt = 'Compile research findings for "' + (project.name || 'untitled') + '":\n' +
        research.slice(0, 5).map(function(r) { return '- ' + r.title + ': ' + r.body; }).join('\n') +
        '\n\nSummarize key themes and implications in 3 paragraphs.';
    }

    return withOperationPolicy({
      allowSpeech: false,
      silent: true,
      source: 'export',
      reason: 'exports stay quiet'
    }, function() {
      return sendToLLM(prompt, { journal: false }).then(function(result) {
        if (!result || !result.ok) return { ok: false };
        return emailText('Structa ' + exportType + ' — ' + (project.name || 'project'), result.clean).then(function(delivery) {
          return { ok: true, type: exportType, content: result.clean, delivery: delivery };
        });
      });
    });
  }

  function titleProject(transcript, project) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.titleProject) {
      return Promise.resolve({ ok: false, title: '' });
    }
    return Promise.race([
      orchestrator.titleProject({
      project: {
        id: project?.project_id || project?.id || '',
        name: project?.name || 'untitled project',
        type: project?.type || 'general',
        brief: project?.brief || '',
        topQuestions: (project?.open_questions || []).slice(0, 3),
        selectedSurface: 'now',
        summary: buildProjectContext({ deep: true })
      },
      selection: null,
      input: {
        transcript: transcript
      },
      transcript: transcript,
      policy: {
        priority: 'high',
        allowSearch: false,
        allowSpeech: false
      }
    }, function(prepared) {
      if (!prepared || !prepared.llm) {
        return Promise.resolve({ ok: false, error: 'llm payload unavailable' });
      }
      var prompt = prepared.llm.prompt || '';
      if (currentOperationPolicy().silent || currentOperationPolicy().allowSpeech === false) {
        prompt = protectSilentPrompt(prompt);
      }
      return sendToLLM(prompt, {
        journal: false,
        timeout: Math.min(Math.max(prepared.llm.timeout || 22000, 22000), 22000),
        priority: prepared.llm.priority || 'high',
        useSerpAPI: false,
        pluginId: 'com.playgranada.structa',
        policy: currentOperationPolicy()
      });
      }),
      new Promise(function(resolve) {
        setTimeout(function() {
          resolve({ ok: false, title: '', error: 'title timeout' });
        }, 22000);
      })
    ]);
  }

  window.StructaLLM = Object.freeze({
    sendToLLM: sendToLLM,
    executePreparedLLM: executePreparedLLM,
    processVoice: processVoice,
    processImage: processImage,
    extractClaimsFromText: extractClaimsFromText,
    refineThreadComment: refineThreadComment,
    backfillClaimsForItem: backfillClaimsForItem,
    query: query,
    storeAsInsight: storeAsInsight,
    linkNode: linkNode,
    research: research,
    generateExport: generateExport,
    emailText: emailText,
    titleProject: titleProject,
    speakMilestone: speakMilestone,
    evaluateMilestone: evaluateMilestone,
    sendBridgeImage: sendBridgeImage,
    buildBridgeImagePrompt: buildBridgeImagePrompt,
    withOperationPolicy: withOperationPolicy,
    currentOperationPolicy: currentOperationPolicy,
    probeCapabilities: probeCapabilities,
    getCapabilities: function() { return window.__structaCaps || runtimeCaps; },
    resetHistory: resetHistory,
    get pendingCount() { return requestQueue.length + (activeRequest ? 1 : 0); },
    get pendingHighPriorityCount() {
      var queued = requestQueue.filter(function(entry) { return !entry.opts || entry.opts.priority !== 'low'; }).length;
      var active = activeRequest && (!activeRequest.opts || activeRequest.opts.priority !== 'low') ? 1 : 0;
      return queued + active;
    },
    get historyLength() { return conversationHistory.length; }
  });
})();
