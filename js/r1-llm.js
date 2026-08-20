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
  var vision = window.StructaVisionProtocol;
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
  var ambientBridgeListeners = [];
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

  /**
   * sendToLLM -- core function.
   * Sends a message to the R1's on-device LLM via PluginMessageHandler.
   * Returns a promise that resolves with { ok, text, clean, structured }.
   * Supports optional imageBase64 for multimodal queries.
   */
  function clearBridgeRequest(request) {
    if (!request) return;
    if (request.timeout) clearTimeout(request.timeout);
    if (request.plainSettleTimer) clearTimeout(request.plainSettleTimer);
    pendingBridgeRequests.delete(request.correlationId);
    if (activeRequest && activeRequest.id === request.id) {
      activeRequest = null;
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

      var isVisionRequest = request.mode === 'vision' || request.mode === 'vision-probe';
      if (!isVisionRequest) pendingBridgeRequests.set(request.correlationId, request);
      request.timeout = setTimeout(function() {
        if (!activeRequest || activeRequest.id !== request.id) return;
        clearBridgeRequest(request);
        var collectorSnapshot = isVisionRequest ? request.collector?.snapshot?.() : null;
        native?.traceEvent?.(isVisionRequest ? 'vision.bridge' : 'bridge', 'pending', 'timeout', {
          correlationId: request.correlationId,
          requestId: request.id,
          visionId: request.visionId || '',
          statusHistory: collectorSnapshot?.statusHistory || []
        });
        resolve({
          ok: false,
          error: isVisionRequest ? 'VisionTimeout' : 'BridgeTimeout',
          code: isVisionRequest ? 'vision-timeout' : BRIDGE_TIMEOUT_CODE,
          layer: 'bridge',
          latencyMs: Date.now() - (request.startedAt || request.createdAt || Date.now()),
          correlationId: request.correlationId,
          visionId: request.visionId || '',
          imageRunId: request.visionId || '',
          collector: collectorSnapshot
        });
        processQueue();
      }, request.opts.timeout || 30000);

      var payload;
      if (isVisionRequest) {
        payload = vision.buildRabbitPayload(request.message, request.imageBase64);
      } else {
        payload = {
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
      }

      try {
        PluginMessageHandler.postMessage(JSON.stringify(payload));
        if (isVisionRequest) {
          native?.traceEvent?.('vision.bridge', 'prepare', 'posted', {
            visionId: request.visionId,
            imageMode: request.imageMode || 'raw-base64',
            imagePlacement: request.imagePlacement || 'top-level',
            imageChars: Number(request.imageChars || 0),
            imageMimeType: request.imageMimeType || '',
            timeoutMs: request.opts.timeout || 18000,
            payloadKeys: Object.keys(payload),
            silent: payload.wantsR1Response === false,
            journal: payload.wantsJournalEntry === true
          });
        }
        if (request.opts.expectResponse === false) {
          clearBridgeRequest(request);
          resolve({
            ok: true,
            posted: true,
            visionId: request.visionId || '',
            imageRunId: request.visionId || '',
            latencyMs: Date.now() - (request.startedAt || Date.now())
          });
          processQueue();
          return;
        }
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
    if (
      !opts.useSerpAPI &&
      opts.allowMemoryLookup !== true &&
      typeof protectedMessage === 'string' &&
      !/DO NOT SEARCH/i.test(protectedMessage)
    ) {
      protectedMessage =
        'Use only the provided context.\n\n' +
        protectedMessage;
    }

    return new Promise(function(resolve) {
      var request = {
        id: id,
        mode: 'text',
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
    if (!vision) {
      return Promise.resolve({
        ok: false,
        error: 'StructaVisionProtocol not available',
        code: 'vision-protocol-unavailable',
        layer: 'client'
      });
    }
    if (typeof PluginMessageHandler === 'undefined') {
      return Promise.resolve({
        ok: false,
        error: 'PluginMessageHandler not available',
        code: 'bridge-unavailable',
        layer: 'bridge'
      });
    }
    var sourceImage = String(imageBase64 || '');
    var sourceMimeMatch = sourceImage.match(/^data:([^;,]+)(?:;[^,]*)?;base64,/i);
    var requestedMode = String(opts.imageInputMode || opts.inputMode || 'raw-base64').toLowerCase();
    var imageMode = requestedMode === 'dataurl' || requestedMode === 'data-url' ? 'data-url' : 'raw-base64';
    var preparedImage = vision.formatImageInput(imageBase64, imageMode);
    if (!preparedImage) {
      return Promise.resolve({
        ok: false,
        error: 'image missing',
        code: 'image-missing',
        layer: 'client'
      });
    }
    var suppliedPrompt = String(prompt || '').trim();
    var suppliedPromptVisionId = vision.extractVisionIdFromPrompt(suppliedPrompt);
    if (opts.visionId && suppliedPromptVisionId && String(opts.visionId) !== suppliedPromptVisionId) {
      return Promise.resolve({
        ok: false,
        error: 'prompt vision_id does not match request vision_id',
        code: 'vision-id-mismatch',
        layer: 'client'
      });
    }
    var visionId = String(opts.visionId || suppliedPromptVisionId || vision.createVisionId(opts.captureId || 'capture'));
    var preparedPrompt = suppliedPrompt;
    if (!vision.extractVisionIdFromPrompt(preparedPrompt)) {
      preparedPrompt = vision.buildVisionPrompt({
        visionId: visionId,
        captureId: opts.captureId || '',
        project: opts.project || buildProjectEnvelope('show'),
        captureHint: suppliedPrompt || opts.description || 'camera capture',
        annotation: opts.voiceAnnotation || ''
      });
    }
    visionId = vision.extractVisionIdFromPrompt(preparedPrompt);
    if (!visionId || !/^[a-z0-9_-]{4,64}$/.test(visionId)) {
      return Promise.resolve({
        ok: false,
        error: 'vision_id is invalid',
        code: 'vision-id-invalid',
        layer: 'client'
      });
    }
    var timeoutMs = Number(opts.timeout || 18000);
    var requestId = getNextId();
    if (native && native.probeMode && native.appendProbeEvent) {
      native.appendProbeEvent({
        source: 'bridge-out',
        name: 'vision request',
        payload: {
          imageRunId: visionId,
          visionId: visionId,
          message: compactText(preparedPrompt, 140),
          wantsR1Response: false,
          journal: false,
          timeoutMs: timeoutMs,
          pluginId: '',
          imageKind: imageMode,
          imagePlacement: 'top-level',
          imageChars: preparedImage.length,
          imageMimeType: String(sourceMimeMatch?.[1] || opts.imageMimeType || '').toLowerCase()
        }
      });
    }
    native?.traceEvent?.('vision.dispatch', 'prepare', 'queued', {
      imageRunId: visionId,
      visionId: visionId,
      timeoutMs: timeoutMs,
      wantsR1Response: false,
      journal: false,
      pluginId: '',
      imageKind: imageMode,
      imagePlacement: 'top-level',
      imageChars: preparedImage.length,
      imageMimeType: String(sourceMimeMatch?.[1] || opts.imageMimeType || '').toLowerCase()
    });
    return new Promise(function(resolve) {
      var request = {
        id: requestId,
        mode: 'vision',
        correlationId: createCorrelationId(),
        message: preparedPrompt,
        imageBase64: preparedImage,
        imageMode: imageMode,
        imagePlacement: 'top-level',
        imageChars: preparedImage.length,
        imageMimeType: String(sourceMimeMatch?.[1] || opts.imageMimeType || '').toLowerCase(),
        visionId: visionId,
        imageRunId: visionId,
        collector: vision.createCollector(visionId),
        opts: {
          timeout: timeoutMs,
          priority: opts.priority || 'low',
          expectResponse: opts.expectResponse !== false,
          policy: { allowSpeech: false, silent: true, source: 'vision' }
        },
        createdAt: Date.now(),
        resolve: resolve,
        timeout: null
      };
      if (request.opts.priority === 'low') requestQueue.push(request);
      else {
        var firstLowIndex = requestQueue.findIndex(function(entry) { return entry.opts && entry.opts.priority === 'low'; });
        if (firstLowIndex === -1) requestQueue.push(request);
        else requestQueue.splice(firstLowIndex, 0, request);
      }
      processQueue();
    });
  }

  // This is deliberately separate from sendBridgeImage(). The production
  // relay expects STRUCTA's strict JSON envelope; the device probe must first
  // establish that an image-specific *plain text* answer reaches a Creation.
  // Keeping it serial, silent, and lab-only at the call site makes that proof
  // independent of schema parsing and project writeback.
  function sendPlainImageProbe(imageBase64, prompt, options) {
    var opts = options || {};
    if (!vision) {
      return Promise.resolve({ ok: false, error: 'StructaVisionProtocol not available', code: 'vision-protocol-unavailable', layer: 'client' });
    }
    if (typeof PluginMessageHandler === 'undefined') {
      return Promise.resolve({ ok: false, error: 'PluginMessageHandler not available', code: 'bridge-unavailable', layer: 'bridge' });
    }
    var sourceImage = String(imageBase64 || '');
    var sourceMimeMatch = sourceImage.match(/^data:([^;,]+)(?:;[^,]*)?;base64,/i);
    var requestedMode = String(opts.imageInputMode || opts.inputMode || 'raw-base64').toLowerCase();
    var imageMode = requestedMode === 'dataurl' || requestedMode === 'data-url' ? 'data-url' : 'raw-base64';
    var preparedImage = vision.formatImageInput(sourceImage, imageMode);
    if (!preparedImage) {
      return Promise.resolve({ ok: false, error: 'image missing', code: 'image-missing', layer: 'client' });
    }
    var visionId = String(opts.visionId || vision.createVisionId(opts.captureId || 'probe'));
    if (!/^[a-z0-9_-]{4,64}$/.test(visionId)) {
      return Promise.resolve({ ok: false, error: 'vision_id is invalid', code: 'vision-id-invalid', layer: 'client' });
    }
    var message = String(prompt || '').trim() || 'Inspect the attached image. Return one short factual sentence about what is visibly present.';
    var timeoutMs = Number(opts.timeout || 16000);
    native?.traceEvent?.('vision.probe', 'prepare', 'queued', {
      captureId: opts.captureId || '',
      visionId: visionId,
      imageMode: imageMode,
      imagePlacement: 'top-level',
      imageChars: preparedImage.length,
      imageMimeType: String(sourceMimeMatch?.[1] || opts.imageMimeType || '').toLowerCase(),
      timeoutMs: timeoutMs,
      silent: true,
      journal: false
    });
    return new Promise(function(resolve) {
      var request = {
        id: getNextId(),
        mode: 'vision-probe',
        correlationId: createCorrelationId(),
        message: message,
        imageBase64: preparedImage,
        imageMode: imageMode,
        imagePlacement: 'top-level',
        imageChars: preparedImage.length,
        imageMimeType: String(sourceMimeMatch?.[1] || opts.imageMimeType || '').toLowerCase(),
        visionId: visionId,
        imageRunId: visionId,
        captureId: opts.captureId || '',
        plainFragments: [],
        plainSettleTimer: null,
        opts: {
          timeout: timeoutMs,
          priority: opts.priority || 'low',
          expectResponse: true,
          policy: { allowSpeech: false, silent: true, source: 'vision-probe' }
        },
        createdAt: Date.now(),
        resolve: resolve,
        timeout: null
      };
      if (request.opts.priority === 'low') requestQueue.push(request);
      else {
        var firstLowIndex = requestQueue.findIndex(function(entry) { return entry.opts && entry.opts.priority === 'low'; });
        if (firstLowIndex === -1) requestQueue.push(request);
        else requestQueue.splice(firstLowIndex, 0, request);
      }
      processQueue();
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

  function addAmbientBridgeListener(listener) {
    if (typeof listener !== 'function') return function() {};
    ambientBridgeListeners.push(listener);
    return function removeAmbientBridgeListener() {
      ambientBridgeListeners = ambientBridgeListeners.filter(function(entry) {
        return entry !== listener;
      });
    };
  }

  function notifyAmbientBridgeListeners(data) {
    if (!ambientBridgeListeners.length) return;
    var text = '';
    try {
      text = sanitizeResponse(extractResponseText(data));
    } catch (_) {
      text = '';
    }
    ambientBridgeListeners.slice().forEach(function(listener) {
      try {
        listener(data, text);
      } catch (_) {}
    });
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

    // STT handling — an empty sttEnded is still a terminal native capture.
    // Dispatch it so voice-capture can release the saved per-capture context
    // before another PTT session starts.
    if (data && data.type === 'sttEnded') {
      if (previousHandler) {
        try { previousHandler(data); } catch (e) {}
      }
      window.dispatchEvent(new CustomEvent('structa-stt-ended', {
        detail: { transcript: typeof data.transcript === 'string' ? data.transcript : '' }
      }));
      return;
    }

    notifyAmbientBridgeListeners(data);

    if (activeRequest && (activeRequest.mode === 'vision' || activeRequest.mode === 'vision-probe')) {
      var imageRequest = activeRequest;
      var rawDump = '';
      var payloadObject = data && typeof data === 'object' ? data : null;
      var bridgeStatus = String(payloadObject?.status || '').trim().toLowerCase();
      try {
        rawDump = typeof data === 'string' ? data : JSON.stringify(data || {});
      } catch (_) {
        rawDump = '';
      }
      var imageText = extractResponseText(data);
      if (native && native.probeMode && native.appendProbeEvent) {
        native.appendProbeEvent({
          source: 'bridge-in-raw',
          name: 'vision response' +
            (rawDump ? ' raw=' + compactText(rawDump, 120) : ''),
          payload: {
            imageRunId: imageRequest.visionId,
            visionId: imageRequest.visionId,
            raw: compactText(rawDump, 240)
          }
        });
      }
      native?.traceEvent?.('plugin.message.raw', 'in', 'vision', {
        imageRunId: imageRequest.visionId,
        visionId: imageRequest.visionId,
        dump: compactText(rawDump, 800),
        hasText: !!imageText
      });
      if (bridgeStatus) {
        if (native && native.probeMode && native.appendProbeEvent) {
          native.appendProbeEvent({
            source: 'bridge-in-status',
            name: 'vision status ' + compactText(bridgeStatus, 24),
            payload: {
              imageRunId: imageRequest.visionId,
              visionId: imageRequest.visionId,
              status: bridgeStatus
            }
          });
        }
        native?.traceEvent?.('plugin.message.status', 'in', 'vision', {
          imageRunId: imageRequest.visionId,
          visionId: imageRequest.visionId,
          status: bridgeStatus
        });
      }
      if (payloadObject?.error && !imageText) {
        clearBridgeRequest(imageRequest);
        imageRequest.resolve({
          ok: false,
          error: String(payloadObject.error?.message || payloadObject.error || 'vision bridge error'),
          code: 'vision-bridge-error',
          layer: 'bridge',
          visionId: imageRequest.visionId,
          imageRunId: imageRequest.visionId,
          raw: rawDump,
          latencyMs: Date.now() - imageRequest.startedAt
        });
        processQueue();
        return;
      }
      if (imageRequest.mode === 'vision-probe') {
        var plainReply = sanitizeResponse(imageText);
        var filler = /^(?:processing|thinking|analysing|analyzing|taking a look|one moment|image received|looking at the image)[.!…\s]*$/i.test(plainReply);
        if (!plainReply || filler) {
          native?.traceEvent?.('vision.probe', 'bridge', 'collecting', {
            captureId: imageRequest.captureId || '',
            visionId: imageRequest.visionId,
            hasText: !!plainReply
          });
          return;
        }
        if (!Array.isArray(imageRequest.plainFragments)) imageRequest.plainFragments = [];
        if (imageRequest.plainFragments[imageRequest.plainFragments.length - 1] !== plainReply) {
          imageRequest.plainFragments.push(plainReply);
        }
        if (imageRequest.plainSettleTimer) clearTimeout(imageRequest.plainSettleTimer);
        imageRequest.plainSettleTimer = setTimeout(function() {
          if (!activeRequest || activeRequest.id !== imageRequest.id) return;
          var combined = sanitizeResponse((imageRequest.plainFragments || []).join('\n'));
          if (!combined) return;
          clearBridgeRequest(imageRequest);
          native?.traceEvent?.('vision.probe', 'bridge', 'stored', {
            captureId: imageRequest.captureId || '',
            visionId: imageRequest.visionId,
            responseChars: combined.length,
            silent: true,
            journal: false
          });
          imageRequest.resolve({
            ok: true,
            visionId: imageRequest.visionId,
            imageRunId: imageRequest.visionId,
            text: combined,
            clean: combined,
            latencyMs: Date.now() - imageRequest.startedAt
          });
          processQueue();
        }, 450);
        native?.traceEvent?.('vision.probe', 'bridge', 'reply-received', {
          captureId: imageRequest.captureId || '',
          visionId: imageRequest.visionId,
          fragmentCount: imageRequest.plainFragments.length
        });
        return;
      }
      var collected = imageRequest.collector.feed(data);
      var collectorSnapshot = imageRequest.collector.snapshot();
      if (!collected.done) {
        native?.traceEvent?.('vision.response', 'received', 'collecting', {
          visionId: imageRequest.visionId,
          reason: collected.reason || 'pending',
          messageCount: collectorSnapshot.messages.length,
          fragmentCount: collectorSnapshot.fragments.length
        });
        return;
      }
      var envelope = collected.envelope;
      var imageClean = vision.observationSummary(envelope) || 'visual signal insufficient';
      clearBridgeRequest(imageRequest);
      if (native && native.probeMode && native.appendProbeEvent) {
        native.appendProbeEvent({
          source: 'bridge-in-parsed',
          name: 'vision envelope' +
            (imageClean ? ' text=' + compactText(imageClean, 120) : ''),
          payload: {
            imageRunId: imageRequest.visionId,
            visionId: imageRequest.visionId,
            text: compactText(imageClean, 240)
          }
        });
      }
      native?.traceEvent?.('plugin.message.parsed', 'in', 'vision', {
        imageRunId: imageRequest.visionId,
        visionId: imageRequest.visionId,
        status: envelope.status,
        captureKind: envelope.capture_kind,
        projectRole: envelope.project_role,
        observationCount: envelope.observations.length,
        interpretationCount: envelope.interpretations.length,
        implicationCount: envelope.implications.length,
        uncertaintyCount: envelope.uncertainties.length,
        text: compactText(imageClean, 240)
      });
      imageRequest.resolve({
        ok: true,
        imageRunId: imageRequest.visionId,
        visionId: imageRequest.visionId,
        text: collected.candidate || JSON.stringify(envelope),
        clean: imageClean,
        raw: rawDump,
        structured: envelope,
        envelope: envelope,
        ocr: envelope.ocr,
        projectRole: envelope.project_role,
        projectRoleConfidence: envelope.project_role_confidence,
        observations: envelope.observations,
        interpretations: envelope.interpretations,
        implications: envelope.implications,
        uncertainties: envelope.uncertainties,
        statusHistory: collectorSnapshot.statusHistory,
        latencyMs: Date.now() - imageRequest.startedAt
      });
      processQueue();
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
        var clean = sanitizeResponse(responseText);
        clearBridgeRequest(cb);
        if (native && native.probeMode && native.appendProbeEvent) {
          native.appendProbeEvent({
            source: 'bridge-in',
            name: 'response received'
          });
        }
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

    if (payload.data) {
      if (typeof payload.data === 'string') {
        try {
          var parsed = JSON.parse(payload.data);
          var parsedText = extractResponseText(parsed);
          if (parsedText) return parsedText;
          return payload.data;
        } catch (e) {
          return payload.data;
        }
      } else {
        var dataText = extractResponseText(payload.data);
        if (dataText) return dataText;
      }
    }

    var directKeys = ['response', 'text', 'output', 'answer', 'body', 'summary', 'caption', 'value', 'note_text', 'details', 'note', 'message', 'content', 'transcript'];
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

  function activeProjectId() {
    return String(native?.getActiveProjectId?.() || native?.getProjectMemory?.()?.project_id || native?.getProjectMemory?.()?.id || '');
  }

  function projectById(projectId) {
    var target = String(projectId || '').trim();
    if (target && native?.getProjectMemoryById) return native.getProjectMemoryById(target) || null;
    var active = native?.getProjectMemory?.() || null;
    if (!target || String(active?.project_id || active?.id || '') === target) return active;
    return null;
  }

  function originProjectExists(projectId) {
    return !!projectById(projectId);
  }

  function originProjectActive(projectId) {
    return !projectId || activeProjectId() === String(projectId);
  }

  function buildProjectContext(opts) {
    var options = opts || {};
    var project = options.project || projectById(options.projectId) || {};
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

  function getActiveBranch(project, projectId) {
    var focus = projectId && native?.getActiveFocusForProject
      ? native.getActiveFocusForProject(projectId)
      : native?.getActiveFocus?.();
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

  function buildProjectEnvelope(surface, projectId) {
    var project = projectById(projectId) || {};
    var map = window.StructaProjectEngine?.getMapView?.(project) || null;
    var composedPacks = window.StructaDomainPacks?.compose?.(map?.pack_ids || project?.structa_v3?.pack_ids || []) || null;
    return {
      id: project.project_id || project.id || '',
      name: project.name || 'untitled project',
      type: project.type || 'general',
      brief: project.brief || '',
      outcome: map?.outcome || project?.structa_v3?.constitution?.outcome || '',
      constitution: map?.constitution || project?.structa_v3?.constitution || {},
      pack_ids: map?.pack_ids || project?.structa_v3?.pack_ids || ['creative-core'],
      branches: map?.branches || project?.structa_v3?.branches || [],
      imageLenses: composedPacks?.imageLenses || {},
      expertOnly: composedPacks?.expertOnly || [],
      topQuestions: (project.open_questions || []).slice(0, 3),
      openQuestions: getProjectOpenQuestions(project, 2),
      recentClaims: getRecentProjectClaims(project, 3),
      activeBranch: getActiveBranch(project, projectId),
      selectedSurface: surface || '',
      summary: buildProjectContext({ deep: true, project: project, projectId: projectId })
    };
  }

  function buildSelectionEnvelope(buildContext, projectId) {
    if (!buildContext) return null;
    var project = projectById(projectId) || {};
    var itemClaims = buildContext.nodeId
      ? (project.claims || []).filter(function(claim) {
          var sourceRef = claim?.sourceRef || {};
          return [sourceRef.itemId, sourceRef.imageId, sourceRef.questionId, sourceRef.answerId]
            .some(function(id) { return String(id || '') === String(buildContext.nodeId); });
        }).slice(0, 6)
      : [];
    return {
      kind: buildContext.kind || '',
      id: buildContext.nodeId || '',
      title: buildContext.title || '',
      summary: String(buildContext.text || '').slice(0, 220),
      status: buildContext.status || 'open',
      createdAt: buildContext.createdAt || '',
      claims: itemClaims
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

    var projectId = String(opts.projectId || activeProjectId() || '');
    if (projectId && !originProjectExists(projectId)) {
      return Promise.resolve({ ok: false, stale: true, error: 'origin project unavailable' });
    }

    // History is project-scoped so switching projects never leaks conversational context.
    conversationHistory.push({ role: 'user', text: transcript, time: Date.now(), projectId: projectId });
    if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
    var projectHistory = conversationHistory.filter(function(entry) {
      return String(entry.projectId || '') === projectId;
    }).slice(-4);

    var payload = {
      projectId: projectId,
      project: buildProjectEnvelope(opts.buildContext && opts.buildContext.surface ? opts.buildContext.surface : (opts.answeringQuestion ? 'know' : 'tell'), projectId),
      selection: buildSelectionEnvelope(opts.buildContext, projectId),
      input: {
        transcript: transcript
      },
      policy: {
        priority: 'high',
        allowSearch: false,
        allowSpeech: false
      },
      history: projectHistory,
      answeringQuestion: !!opts.answeringQuestion,
      questionText: opts.questionText || ''
    };

    return orchestrator.interpretVoice(payload, executePreparedLLM).then(function(result) {
      // Track LLM response in history
      if (result && result.ok && result.clean) {
        conversationHistory.push({ role: 'bot', text: result.clean, time: Date.now(), projectId: projectId });
        if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
      }
      return Object.assign({}, result || {}, { projectId: projectId });
    });
  }

  function buildBridgeImagePrompt(projectEnvelope, description, options) {
    var opts = options || {};
    if (!vision) return '';
    return vision.buildVisionPrompt({
      visionId: opts.visionId || vision.createVisionId(opts.imageId || opts.captureId || 'capture'),
      captureId: opts.imageId || opts.captureId || '',
      project: projectEnvelope || buildProjectEnvelope('show'),
      captureHint: description || opts.promptContext || 'camera capture',
      annotation: opts.voiceAnnotation || opts.annotation || ''
    });
  }

  function buildShowCaptureContext(description, options) {
    var opts = options || {};
    return {
      surface: 'show',
      kind: 'capture',
      nodeId: opts.itemId || opts.imageId || '',
      title: opts.voiceAnnotation
        ? 'show+tell: ' + compactText(opts.voiceAnnotation, 48)
        : compactText(description || 'visual note', 48),
      text: opts.voiceAnnotation || description || 'camera capture',
      status: 'open',
      createdAt: new Date().toISOString()
    };
  }

  function normalizeShowTellResult(voiceResult, options) {
    var opts = options || {};
    return extractClaimsFromText({
      project: buildProjectEnvelope('show'),
      input: {
        text: voiceResult.clean || voiceResult.text || '',
        deviceId: native?.deviceId || ''
      },
      source: 'show-tell',
      sourceRef: {
        imageId: opts.imageId || '',
        itemId: opts.itemId || ''
      },
      meta: {
        deviceId: native?.deviceId || '',
        imageId: opts.imageId || ''
      }
    }).then(function(extracted) {
      var claims = Array.isArray(extracted?.claims) ? extracted.claims : [];
      if (claims.length) {
        native?.traceEvent?.('show.tell', 'pending', 'claims_extracted', {
          entryId: opts.imageId || '',
          count: claims.length
        });
      } else if (!extracted?.ok) {
        native?.traceEvent?.('show.tell', 'pending', 'claims_pending', {
          entryId: opts.imageId || '',
          reason: extracted?.error || 'extraction failed'
        });
      }
      return {
        ok: true,
        text: voiceResult.text || voiceResult.clean || '',
        clean: voiceResult.clean || voiceResult.text || '',
        structured: voiceResult.structured || extractFields(voiceResult.clean || voiceResult.text || ''),
        claims: claims,
        claim_extraction_pending: !claims.length,
        bridge: false,
        semanticMode: 'show-tell'
      };
    });
  }

  function analyzeShowTell(rawBase64, description, options) {
    var opts = options || {};
    var transcript = String(opts.voiceAnnotation || '').trim();
    if (!transcript) {
      return Promise.resolve({
        ok: false,
        error: 'show-tell transcript unavailable',
        code: 'show-tell-missing-transcript',
        layer: 'voice'
      });
    }
    native?.traceEvent?.('show.tell', 'prepare', 'voice', {
      entryId: opts.imageId || '',
      itemId: opts.itemId || '',
      chars: transcript.length
    });
    return processVoice(transcript, {
      buildContext: buildShowCaptureContext(description, opts)
    }).then(function(voiceResult) {
      if (!voiceResult || !voiceResult.ok || !voiceResult.clean) {
        native?.traceEvent?.('show.tell', 'pending', 'failed', {
          entryId: opts.imageId || '',
          error: voiceResult?.error || 'voice failed'
        });
        return voiceResult || {
          ok: false,
          error: 'show-tell failed',
          code: 'show-tell-failed',
          layer: 'voice'
        };
      }
      native?.traceEvent?.('show.tell', 'pending', 'response', {
        entryId: opts.imageId || '',
        chars: String(voiceResult.clean || '').length
      });
      return normalizeShowTellResult(voiceResult, opts);
    });
  }

  function storeCaptureOnlyResult(options) {
    var opts = options || {};
    native?.traceEvent?.('show.capture', 'pending', 'saved', {
      entryId: opts.imageId || '',
      itemId: opts.itemId || ''
    });
    return Promise.resolve({
      ok: true,
      savedOnly: true,
      bridge: false,
      semanticMode: 'capture-only',
      clean: '',
      text: '',
      structured: {},
      claims: [],
      claim_extraction_pending: false,
      savedSummary: 'frame saved',
      savedPrompt: 'hold ptt to describe'
    });
  }

  function emailText(subject, body) {
    var safeSubject = compactText(subject || 'Structa export', 96);
    var safeBody = String(body || '').trim();
    if (safeBody.length > 2800) {
      safeBody = safeBody.slice(0, 2799).trimEnd() + '…';
    }
    var messaging = window.r1?.messaging;
    var hasNativeEmail = typeof messaging?.emailUser === 'function';
    var hasBridgeEmail = typeof PluginMessageHandler !== 'undefined'
      && typeof PluginMessageHandler.postMessage === 'function';
    traceEmail('email.attempt', 'idle', hasBridgeEmail ? 'bridge' : (hasNativeEmail ? 'native' : 'unavailable'), {
      subject: safeSubject,
      bodyBytes: safeBody.length
    });
    if (hasBridgeEmail) {
      try {
        // Mirrors r1-create's emailUser helper without assuming that its
        // `window.r1` facade is injected into the creation WebView.
        PluginMessageHandler.postMessage(JSON.stringify({
          message: 'Please email this to the user: ' + safeSubject + '\n\n' + safeBody,
          useLLM: true,
          useSerpAPI: false,
          wantsR1Response: false,
          wantsJournalEntry: false
        }));
        traceEmail('email.bridge.requested', 'pending', 'requested', {
          subject: safeSubject,
          bodyBytes: safeBody.length
        });
        return Promise.resolve({
          ok: true,
          requested: true,
          confirmed: false,
          mode: 'bridge-requested',
          subject: safeSubject
        });
      } catch (error) {
        traceEmail('email.bridge.failed', 'pending', 'failed', {
          subject: safeSubject,
          bodyBytes: safeBody.length,
          error: error?.message || 'email request failed'
        });
        return Promise.resolve({
          ok: false,
          requested: false,
          confirmed: false,
          error: error?.message || 'email request failed',
          code: 'email-bridge-error',
          mode: 'bridge-failed'
        });
      }
    }
    if (hasNativeEmail) {
      // The R1 messaging SDK accepts content as its first argument, not a
      // `{ subject, body }` object. Include the proof subject in the content so
      // multipart exports remain identifiable in the user's inbox.
      return Promise.resolve(messaging.emailUser(safeSubject + '\n\n' + safeBody)).then(function(result) {
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
        return {
          ok: true,
          requested: true,
          confirmed: false,
          mode: 'native-requested',
          subject: safeSubject
        };
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
    traceEmail('email.native.unavailable', 'pending', 'no-email-bridge', {
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
   * processImage -- silent, schema-bound Rabbit vision entry.
   *
   * Capture persistence is owned by camera-capture.js. This method is an
   * asynchronous enhancement: failure returns a degraded result and never
   * changes the fact that the original frame was saved.
   */
  function processImage(rawBase64, description, meta) {
    var options = meta || {};
    return requestCaptureDescription(options.imageId || '', rawBase64, {
      itemId: options.itemId || '',
      facingMode: options.facingMode || '',
      description: description || '',
      voiceAnnotation: options.voiceAnnotation || '',
      imageInputMode: options.imageInputMode || 'raw-base64',
      priority: options.priority || 'low',
      timeout: options.timeout || 18000
    });
  }

  function requestCaptureDescription(captureId, imageBase64, context) {
    var options = context || {};
    if (!vision) {
      return Promise.resolve({
        ok: false,
        error: 'StructaVisionProtocol not available',
        code: 'vision-protocol-unavailable',
        layer: 'client',
        captureId: captureId || ''
      });
    }
    if (!imageBase64) {
      native?.recordProductEvent?.('description unavailable', {
        captureId: captureId || '',
        detail: 'image missing'
      });
      return Promise.resolve({
        ok: false,
        error: 'image missing',
        code: 'image-missing',
        layer: 'bridge',
        captureId: captureId || ''
      });
    }
    var projectEnvelope = buildProjectEnvelope('show');
    var visionId = options.visionId || vision.createVisionId(captureId || 'capture');
    var prompt = buildBridgeImagePrompt(projectEnvelope, options.description || 'camera capture', {
      visionId: visionId,
      voiceAnnotation: options.voiceAnnotation || '',
      itemId: options.itemId || '',
      imageId: captureId || '',
      facingMode: options.facingMode || '',
      promptContext: options.promptContext || ''
    });
    return withOperationPolicy({
      allowSpeech: false,
      silent: true,
      source: 'image',
      reason: 'image description stays quiet'
    }, function() {
      native?.recordProductEvent?.('description requested', {
        captureId: captureId || '',
        detail: 'silent vision relay'
      });
      native?.traceEvent?.('vision.analysis', 'saved', 'requested', {
        captureId: captureId || '',
        visionId: visionId,
        timeoutMs: Number(options.timeout || 18000),
        itemId: options.itemId || ''
      });
      return sendBridgeImage(imageBase64, prompt, {
        visionId: visionId,
        captureId: captureId || '',
        project: projectEnvelope,
        voiceAnnotation: options.voiceAnnotation || '',
        imageInputMode: options.imageInputMode || 'raw-base64',
        timeout: Number(options.timeout || 18000),
        priority: options.priority || 'low'
      }).then(function(result) {
        if (!result || !result.ok || !result.envelope) {
          native?.recordProductEvent?.('description unavailable', {
            captureId: captureId || '',
            detail: compactText(result?.code || result?.error || 'vision unavailable', 10)
          });
          native?.traceEvent?.('vision.analysis', 'requested', 'unavailable', {
            captureId: captureId || '',
            visionId: visionId,
            itemId: options.itemId || '',
            code: result?.code || '',
            error: result?.error || ''
          });
          return result;
        }
        native?.recordProductEvent?.('description stored', {
          captureId: captureId || '',
          detail: compactText(result.clean || 'visual signal stored', 10)
        });
        native?.traceEvent?.('vision.analysis', 'requested', 'stored', {
          captureId: captureId || '',
          visionId: visionId,
          itemId: options.itemId || '',
          status: result.envelope?.status || '',
          captureKind: result.envelope?.capture_kind || '',
          projectRole: result.envelope?.project_role || '',
          observationCount: result.observations?.length || 0,
          interpretationCount: result.interpretations?.length || 0,
          implicationCount: result.implications?.length || 0,
          uncertaintyCount: result.uncertainties?.length || 0
        });
        return Object.assign({}, result, {
          captureId: captureId || '',
          visionId: visionId,
          imageRunId: visionId,
          structured: result.envelope,
          claims: [],
          claim_extraction_pending: false,
          bridge: true
        });
      });
    });
  }

  function probeImagePrompt(rawBase64, prompt, meta) {
    var options = meta || {};
    if (!rawBase64) {
      native?.recordProductEvent?.('background work failed', {
        captureId: options.captureId || '',
        detail: 'probe image missing'
      });
      return Promise.resolve({ ok: false, error: 'probe image missing', code: 'probe-image-missing' });
    }
    var timeoutMs = Number(options.timeout || 14000);
    native?.traceEvent?.('image.probe', 'prepare', 'bridge', {
      captureId: options.captureId || '',
      label: options.label || '',
      keyword: options.keyword || '',
      timeoutMs: timeoutMs
    });
    var imageInput = String(rawBase64 || '');
    return withOperationPolicy({
      allowSpeech: false,
      silent: true,
      source: 'image-probe',
      reason: 'image prompt probes stay quiet'
    }, function() {
      var bridgeCall = sendPlainImageProbe(imageInput, String(prompt || '').trim(), {
        visionId: options.visionId || '',
        captureId: options.captureId || '',
        project: options.project || buildProjectEnvelope('show'),
        voiceAnnotation: options.voiceAnnotation || '',
        imageInputMode: options.imageInputMode || 'raw-base64',
        timeout: timeoutMs,
        expectResponse: options.expectResponse !== false,
        priority: options.priority || 'low'
      });
      return bridgeCall.then(function(result) {
        if (options.expectResponse === false && result && result.ok && !result.clean) {
          native?.appendLogEntry?.({
            kind: 'product',
            message: lower((options.label || 'image harness') + ' posted'),
            linked_capture_id: options.captureId || null,
            meta: {
              keyword: options.keyword || '',
              mode: result.mode || 'posted'
            }
          });
          return {
            ok: true,
            posted: true,
            mode: result.mode || 'posted'
          };
        }
        if (!result || !result.ok || !result.clean) {
          native?.appendLogEntry?.({
            kind: 'product',
            message: lower((options.label || 'image probe') + ' unavailable'),
            linked_capture_id: options.captureId || null,
            meta: {
              keyword: options.keyword || '',
              code: result?.code || '',
              error: result?.error || ''
            }
          });
          native?.traceEvent?.('image.probe', 'bridge', 'timeout', {
            captureId: options.captureId || '',
            label: options.label || '',
            keyword: options.keyword || '',
            code: result?.code || '',
            error: result?.error || ''
          });
          return result;
        }
        native?.appendLogEntry?.({
          kind: 'product',
          message: lower((options.label || 'image probe') + ' stored'),
          linked_capture_id: options.captureId || null,
          meta: {
            keyword: options.keyword || '',
            text: compactText(result.clean || result.text || '', 120)
          }
        });
        native?.traceEvent?.('image.probe', 'bridge', 'stored', {
          captureId: options.captureId || '',
          label: options.label || '',
          keyword: options.keyword || '',
          text: compactText(result.clean || result.text || '', 120)
        });
        return result;
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
  function normalizeResearchUrl(value) {
    var match = String(value || '').trim().match(/https?:\/\/[^\s<>"'`]+/i);
    if (!match) return '';
    return match[0].replace(/[\])},.;!?]+$/g, '');
  }

  function researchUrlKey(value) {
    return normalizeResearchUrl(value);
  }

  function researchDomain(value) {
    return normalizeResearchUrl(value)
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .replace(/^www\./i, '')
      .toLowerCase();
  }

  function parseResearchJSON(value) {
    var raw = String(value || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) {}
    var fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch (_) {}
    }
    var objectStart = raw.indexOf('{');
    var objectEnd = raw.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try { return JSON.parse(raw.slice(objectStart, objectEnd + 1)); } catch (_) {}
    }
    var arrayStart = raw.indexOf('[');
    var arrayEnd = raw.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try { return JSON.parse(raw.slice(arrayStart, arrayEnd + 1)); } catch (_) {}
    }
    return null;
  }

  function collectResearchSources(searchResult, searchQuery, retrievedAt) {
    var sources = [];
    var byUrl = {};
    var visited = new Set();
    var stamp = retrievedAt || new Date().toISOString();

    function addSource(urlValue, record, path, recordType) {
      var url = normalizeResearchUrl(urlValue);
      var key = researchUrlKey(url);
      if (!key) return;
      var input = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
      var title = compactText(input.title || input.name || input.headline || '', 180);
      var snippet = compactText(input.snippet || input.description || input.summary || input.text || '', 360);
      var publisher = compactText(input.publisher || input.source || input.site_name || input.siteName || '', 120);
      var publishedAt = compactText(input.published_at || input.publishedAt || input.date || input.datePublished || '', 80);
      if (byUrl[key]) {
        if (!byUrl[key].title && title) byUrl[key].title = title;
        if (!byUrl[key].snippet && snippet) byUrl[key].snippet = snippet;
        if (!byUrl[key].publisher && publisher) byUrl[key].publisher = publisher;
        if (!byUrl[key].published_at && publishedAt) byUrl[key].published_at = publishedAt;
        if (byUrl[key].record_type === 'url-only' && recordType === 'structured') byUrl[key].record_type = 'structured';
        return;
      }
      var rankValue = Number(input.position || input.rank || input.index || sources.length + 1);
      var source = {
        id: 'serp-source-' + String(sources.length + 1),
        url: url,
        title: title,
        snippet: snippet,
        domain: researchDomain(url),
        publisher: publisher,
        published_at: publishedAt,
        rank: Number.isFinite(rankValue) && rankValue > 0 ? rankValue : sources.length + 1,
        provider: 'rabbit-serp',
        search_query: String(searchQuery || ''),
        retrieved_at: stamp,
        record_type: recordType || 'structured',
        record_path: compactText(path || '', 120)
      };
      sources.push(source);
      byUrl[key] = source;
    }

    function walk(value, path, depth) {
      if (value == null || depth > 6 || sources.length >= 20) return;
      if (typeof value === 'string') {
        var parsed = parseResearchJSON(value);
        if (parsed && parsed !== value) walk(parsed, path + '.json', depth + 1);
        var matches = value.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
        matches.forEach(function(url) { addSource(url, null, path, 'url-only'); });
        return;
      }
      if (typeof value !== 'object') return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        value.slice(0, 30).forEach(function(entry, index) {
          walk(entry, path + '[' + index + ']', depth + 1);
        });
        return;
      }
      var directUrl = value.url || value.link || value.href || value.source_url || value.sourceUrl || value.canonical_url || value.canonicalUrl;
      if (directUrl) addSource(directUrl, value, path, 'structured');
      Object.keys(value).slice(0, 40).forEach(function(key) {
        walk(value[key], path ? path + '.' + key : key, depth + 1);
      });
    }

    walk(searchResult || {}, 'searchResult', 0);
    return sources.slice(0, 12);
  }

  function serializeResearchResults(searchResult, sources) {
    var raw = searchResult?.text || searchResult?.clean || searchResult?.raw || '';
    if (raw) return String(raw);
    var structured = searchResult?.results || searchResult?.organic_results || searchResult?.organicResults || searchResult?.items || searchResult?.sources || searchResult?.records || searchResult?.data;
    if (structured) {
      try { return JSON.stringify(structured); } catch (_) {}
    }
    return (sources || []).map(function(source) {
      return [source.title, source.url, source.snippet].filter(Boolean).join(' — ');
    }).join('\n');
  }

  function parseResearchSynthesis(rawValue, sources, query, searchQuery, retrievedAt) {
    var raw = String(rawValue || '');
    var labels = {};
    raw.split(/\r?\n/).forEach(function(line) {
      var separator = line.indexOf(':');
      if (separator < 1) return;
      labels[line.slice(0, separator).trim().toUpperCase()] = line.slice(separator + 1).trim();
    });
    var numbered = raw.split(/\r?\n/).map(function(line) {
      return line.replace(/^\s*\d+[.)]\s*/, '').trim();
    }).filter(function(line) {
      return !!line && !/^SOURCE\d*\s*:/i.test(line) && !/^FINDING\d*\s*:/i.test(line);
    });
    var sourceByUrl = {};
    (sources || []).forEach(function(source) {
      sourceByUrl[researchUrlKey(source.url)] = source;
    });
    var records = [];
    for (var index = 1; index <= 3; index += 1) {
      var findingText = compactText(labels['FINDING' + index] || numbered[index - 1] || '', 180);
      if (!findingText || lower(findingText) === 'omit') continue;
      var requestedUrl = normalizeResearchUrl(labels['SOURCE' + index] || findingText);
      var matchedSource = requestedUrl ? sourceByUrl[researchUrlKey(requestedUrl)] || null : null;
      if (matchedSource && findingText.indexOf(requestedUrl) !== -1) {
        findingText = compactText(findingText.replace(requestedUrl, '').replace(/[—–-]\s*$/, ''), 180);
      }
      var sourceBacked = !!matchedSource;
      records.push({
        id: 'research-finding-' + index,
        text: findingText,
        epistemic_status: sourceBacked ? 'source-backed' : 'hypothesis',
        truth_role: sourceBacked ? 'sourced_research' : 'research_lead',
        evidence_status: sourceBacked ? 'candidate' : 'withheld',
        source_id: matchedSource?.id || '',
        source_url: matchedSource?.url || '',
        source_title: matchedSource?.title || '',
        provenance: {
          provider: sourceBacked ? 'rabbit-serp' : 'llm-synthesis',
          query: String(query || ''),
          search_query: String(searchQuery || ''),
          retrieved_at: retrievedAt || '',
          source_id: matchedSource?.id || '',
          source_url: matchedSource?.url || '',
          basis: sourceBacked ? 'returned-source-url' : 'unsourced-synthesis'
        }
      });
    }
    return records;
  }

  /**
   * research — performs web search via R1 SERP API + LLM synthesis.
   * Returns 3 compressed findings while retaining source provenance. A
   * synthesized statement without a URL returned by SERP stays a hypothesis.
   */
  function research(query, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var projectId = String(opts.projectId || activeProjectId() || '');
    var originProject = projectById(projectId);
    if (projectId && !originProject) {
      return Promise.resolve({ ok: false, stale: true, error: 'origin project unavailable', projectId: projectId, findings: [] });
    }
    return withOperationPolicy({
      allowSpeech: false,
      silent: true,
      source: 'research',
      reason: 'background research stays written'
    }, function() {
      var context = buildProjectContext({ deep: false, project: originProject || {}, projectId: projectId });
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
            var retrievedAt = new Date().toISOString();
            var sources = collectResearchSources(searchResult, searchQuery, retrievedAt);
            return {
              searchQuery: searchQuery,
              searchResult: searchResult,
              retrievedAt: retrievedAt,
              sources: sources,
              rawResults: serializeResearchResults(searchResult, sources)
            };
          });
        })
        .then(function(payload) {
          if (!payload.searchResult || !payload.searchResult.ok) return { ok: false, findings: [] };
          var rawResults = payload.rawResults || '';
          var sourceLines = (payload.sources || []).map(function(source) {
            return source.id + ': ' + source.url + (source.title ? ' — ' + source.title : '');
          }).join('\n');
          var synthesisPrompt = '🚫 DO NOT SEARCH AGAIN. DO NOT SAVE NOTES.\n' +
            (context ? 'Project context:\n' + context.slice(0, 220) + '\n\n' : '') +
            'Search topic: "' + query + '"\n' +
            'Search query used: "' + payload.searchQuery + '"\n\n' +
            'Search results:\n' + String(rawResults).slice(0, 2400) + '\n\n' +
            'Returned source URLs:\n' + (sourceLines || 'none returned') + '\n\n' +
            'Return exactly these labeled lines:\n' +
            'FINDING1: <10 words max and useful for the project>\n' +
            'SOURCE1: <exact returned URL, or NONE>\n' +
            'FINDING2: <10 words max and useful for the project>\n' +
            'SOURCE2: <exact returned URL, or NONE>\n' +
            'FINDING3: <10 words max and useful for the project>\n' +
            'SOURCE3: <exact returned URL, or NONE>\n' +
            'Never invent or rewrite a URL. Use NONE when no returned URL directly supports a finding.';
          return sendToLLM(synthesisPrompt, { journal: false, timeout: 20000, priority: 'high' })
            .then(function(result) {
              if (!result || !result.ok) return { ok: false, findings: [] };
              var findingRecords = parseResearchSynthesis(
                result.text || result.clean || '',
                payload.sources || [],
                query,
                payload.searchQuery,
                payload.retrievedAt
              );
              var findings = findingRecords.map(function(record) { return record.text; });
              if (!originProjectExists(projectId)) {
                return { ok: false, stale: true, error: 'origin project unavailable', projectId: projectId, findings: [] };
              }
              var provenance = {
                provider: 'rabbit-serp',
                query: String(query || ''),
                search_query: payload.searchQuery,
                retrieved_at: payload.retrievedAt,
                source_count: (payload.sources || []).length,
                source_urls: (payload.sources || []).map(function(source) { return source.url; }),
                synthesis_policy: 'unsourced findings remain hypotheses with evidence withheld'
              };
              var nodeInput = {
                  type: 'research', title: 'branch: ' + query.slice(0, 40),
                  body: findings.join(' | '), source: 'serp',
                  research_findings: findingRecords,
                  tags: query.toLowerCase().split(/\s+/).slice(0, 3),
                  meta: {
                    search_query: payload.searchQuery,
                    silent: true,
                    project_id: projectId,
                    research_sources: payload.sources || [],
                    research_records: findingRecords,
                    provenance: provenance
                  }
                };
              var stored = null;
              if (findings.length && projectId && native?.addNodeToProject) {
                stored = native.addNodeToProject(projectId, nodeInput);
              } else if (findings.length && originProjectActive(projectId) && native?.addNode) {
                stored = native.addNode(nodeInput);
              }
              if (findings.length && !stored) {
                return { ok: false, stale: true, error: 'origin project write unavailable', projectId: projectId, findings: [] };
              }
              return {
                ok: true,
                query: query,
                searchQuery: payload.searchQuery,
                findings: findings,
                findingRecords: findingRecords,
                sources: payload.sources || [],
                provenance: provenance,
                raw: result.text || result.clean || '',
                serpRaw: rawResults,
                projectId: projectId,
                node: stored
              };
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
        user_role: project?.user_role || '',
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

  function buildProjectBrief(transcript, project) {
    var orchestrator = window.StructaOrchestrator;
    if (!orchestrator || !orchestrator.buildProjectBrief) {
      return Promise.resolve({ ok: false, title: '', brief: '', candidates: {} });
    }
    return Promise.all([
      titleProject(transcript, project).catch(function() {
        return { ok: false, title: '' };
      }),
      Promise.race([
        orchestrator.buildProjectBrief({
          project: {
            id: project?.project_id || project?.id || '',
            name: project?.name || 'untitled project',
            type: project?.type || 'general',
            brief: project?.brief || '',
            user_role: project?.user_role || '',
            topQuestions: (project?.open_questions || []).slice(0, 3),
            selectedSurface: 'tell',
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
            resolve({ ok: false, error: 'project brief timeout' });
          }, 22000);
        })
      ])
    ]).then(function(results) {
      var titleResult = results[0] || {};
      var briefResult = results[1] || {};
      var mergedCandidates = briefResult.candidates && typeof briefResult.candidates === 'object'
        ? briefResult.candidates
        : { decisions: [], asks: [], blockers: [], themes: [] };
      return {
        ok: !!(briefResult.ok || titleResult.title),
        title: titleResult.title || '',
        brief: briefResult.brief || '',
        candidates: mergedCandidates,
        constitution: briefResult.constitution && typeof briefResult.constitution === 'object'
          ? briefResult.constitution
          : {},
        packHints: Array.isArray(briefResult.packHints)
          ? briefResult.packHints
          : (Array.isArray(briefResult.pack_hints) ? briefResult.pack_hints : []),
        branches: Array.isArray(briefResult.branches) ? briefResult.branches : [],
        suggestedNext: briefResult.suggestedNext || ''
      };
    });
  }

  window.StructaLLM = Object.freeze({
    sendToLLM: sendToLLM,
    executePreparedLLM: executePreparedLLM,
    processVoice: processVoice,
    processImage: processImage,
    analyzeShowTell: analyzeShowTell,
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
    buildProjectBrief: buildProjectBrief,
    speakMilestone: speakMilestone,
    evaluateMilestone: evaluateMilestone,
    requestCaptureDescription: requestCaptureDescription,
    probeImagePrompt: probeImagePrompt,
    probeNativeImage: sendPlainImageProbe,
    sendBridgeImage: sendBridgeImage,
    askRabbitAboutImage: sendBridgeImage,
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
