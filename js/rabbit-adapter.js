(() => {
  const contracts = window.StructaContracts;
  const validation = window.StructaValidation;
  const router = window.StructaActionRouter;
  const runtimeEvents = [];
  const memory = {
    messages: [],
    journals: [],
    assets: [],
    captures: [],
    exports: []
  };
  const MAX_RUNTIME_EVENTS = 200;
  const MAX_MEMORY_ITEMS = 120;
  const MAX_EXPORTS = 40;

  function pushLimited(list, item, limit = MAX_MEMORY_ITEMS) {
    list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
    return item;
  }

  function hasBridge() {
    return typeof window.PluginMessageHandler !== 'undefined' && typeof window.PluginMessageHandler.postMessage === 'function';
  }

  function getCapabilities() {
    return {
      hasPluginMessageHandler: hasBridge(),
      hasJournal: typeof window.PluginMessageHandler !== 'undefined',
      hasStorage: typeof window.localStorage !== 'undefined',
      hasCamera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      hasSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      hasVibration: typeof navigator.vibrate === 'function',
      hasMotion: 'DeviceOrientationEvent' in window || 'DeviceMotionEvent' in window,
      hasScrollHardware: true,
      hasPTT: true
    };
  }

  function emit(eventType, payload) {
    const record = {
      event_type: eventType,
      payload,
      created_at: new Date().toISOString()
    };
    pushLimited(runtimeEvents, record, MAX_RUNTIME_EVENTS);
    try {
      window.dispatchEvent(new CustomEvent('structa-native-event', { detail: record }));
    } catch (_) {
      // no-op in older runtimes
    }
    return record;
  }

  function saveFallback() {
    if (!window.localStorage) return;
    try {
      const blob = { messages: memory.messages, journals: memory.journals, assets: memory.assets, captures: memory.captures, exports: memory.exports, runtimeEvents };
      window.localStorage.setItem('structa-native-cache-v1', JSON.stringify(blob));
    } catch (_) {
      // ignore quota or serialization issues in browser fallback
    }
  }

  function postPayload(payload) {
    if (hasBridge()) {
      window.PluginMessageHandler.postMessage(JSON.stringify(payload));
      return { sent: true, bridge: 'PluginMessageHandler' };
    }

    pushLimited(memory.messages, payload);
    saveFallback();
    console.log('[Structa Native Fallback]', payload);
    return { sent: false, bridge: 'fallback' };
  }

  function sendStructuredMessage(raw = {}) {
    const routed = router?.routeAction?.(raw);
    const verdict = validation.validateEnvelope(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Structured message', verdict.errors);
      emit('validation_failed', { kind: 'message', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value, capabilities: getCapabilities() };
    }

    const payload = verdict.value;
    if (routed?.ok) {
      payload.meta = {
        ...(payload.meta || {}),
        route: routed.route,
        context_snapshot: routed.context_snapshot,
        context_summary: router?.summarizeContext?.(routed.context_snapshot)
      };
      emit('action_routed', routed.route);
    }
    emit('message_prepared', payload);
    const result = postPayload({
      ...payload,
      useLLM: true,
      wantsR1Response: payload.wantsR1Response !== false,
      wantsJournalEntry: payload.wantsJournalEntry === true
    });
    emit('message_sent', { payload, result });
    return { ok: true, payload, result, capabilities: getCapabilities() };
  }

  function buildJournalExport(raw = {}) {
    const now = new Date().toISOString();
    return {
      project_code: raw.project_code || contracts.baseProjectCode,
      entry_id: raw.entry_id || contracts.makeEntryId('export'),
      source_type: raw.source_type || 'voice',
      destination: raw.destination || 'email',
      approval_state: raw.approval_state || 'pending',
      title: raw.title || 'Journal export',
      body: raw.body || '',
      journals: [...memory.journals],
      assets: [...memory.assets],
      runtime_events: [...runtimeEvents],
      created_at: raw.created_at || now,
      meta: raw.meta || {}
    };
  }

  function queueJournalExport(raw = {}) {
    const payload = buildJournalExport(raw);
    pushLimited(memory.exports, payload, MAX_EXPORTS);
    saveFallback();
    emit('journal_export_prepared', payload);
    return payload;
  }

  function writeJournalEntry(raw = {}) {
    const verdict = validation.validateJournalEntry(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Journal entry', verdict.errors);
      emit('validation_failed', { kind: 'journal', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value };
    }

    const payload = verdict.value;
    pushLimited(memory.journals, payload);
    saveFallback();
    emit('journal_written', payload);
    return sendStructuredMessage({
      project_code: payload.project_code,
      entry_id: payload.entry_id,
      source_type: payload.source_type,
      input_type: 'journal',
      target: 'journal',
      verb: 'journal',
      intent: `journal ${payload.title}`,
      goal: payload.body,
      approval_mode: 'human_required',
      fallback: 'store-only',
      payload
    });
  }

  function requestEmailWithdrawal(raw = {}) {
    const bundle = queueJournalExport({
      ...raw,
      title: raw.title || 'Email withdrawal',
      body: raw.body || (raw.note || ''),
      destination: 'email',
      approval_state: 'pending'
    });
    return sendStructuredMessage({
      project_code: bundle.project_code,
      entry_id: bundle.entry_id,
      source_type: bundle.source_type,
      input_type: 'withdrawal',
      target: 'export',
      verb: 'withdraw',
      intent: `withdraw journal export via email`,
      goal: bundle.body || 'prepare email export',
      approval_mode: 'human_required',
      fallback: 'store-only',
      payload: bundle
    });
  }

  function storeAsset(raw = {}) {
    const verdict = validation.validateAsset(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Asset', verdict.errors);
      emit('validation_failed', { kind: 'asset', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value };
    }

    const payload = verdict.value;
    pushLimited(memory.assets, payload);
    saveFallback();
    emit('asset_stored', payload);
    return { ok: true, payload };
  }

  function storeCaptureBundle(raw = {}) {
    const verdict = validation.validateCaptureBundle(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Capture bundle', verdict.errors);
      emit('validation_failed', { kind: 'capture_bundle', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value };
    }

    const payload = verdict.value;
    pushLimited(memory.captures, payload);
    saveFallback();
    emit('capture_bundle_stored', payload);
    return { ok: true, payload };
  }

  function openCamera(mode = 'rear') {
    const payload = contracts.createEnvelope({
      verb: 'capture',
      target: 'camera',
      input_type: 'camera',
      source_type: 'camera',
      intent: `open camera ${mode}`,
      goal: `open ${mode} camera`,
      approval_mode: 'human_required',
      fallback: 'camera-ui',
      meta: { mode }
    });
    return sendStructuredMessage(payload);
  }

  function setCameraFacing(facing = 'rear') {
    const payload = contracts.createEnvelope({
      verb: 'capture',
      target: 'camera',
      input_type: 'camera-facing',
      source_type: 'camera',
      intent: `set camera facing ${facing}`,
      goal: `switch camera to ${facing}`,
      approval_mode: 'human_required',
      fallback: 'camera-ui',
      meta: { facing }
    });
    return sendStructuredMessage(payload);
  }

  function startPTT() {
    emit('ptt_started', { active: true });
    return sendStructuredMessage({
      verb: 'capture',
      target: 'voice',
      input_type: 'ptt-start',
      source_type: 'microphone',
      intent: 'start voice capture',
      goal: 'capture spoken intent',
      approval_mode: 'human_required',
      fallback: 'voice-capture'
    });
  }

  function stopPTT(transcript = '') {
    emit('ptt_stopped', { transcript });
    return sendStructuredMessage({
      verb: 'inspect',
      target: 'voice',
      input_type: 'ptt-stop',
      source_type: 'microphone',
      intent: transcript ? `process transcript: ${transcript}` : 'process voice capture',
      goal: 'normalize spoken intent',
      approval_mode: 'human_required',
      fallback: 'voice-capture',
      payload: { transcript }
    });
  }

  function getMemory() {
    return {
      messages: [...memory.messages],
      journals: [...memory.journals],
      assets: [...memory.assets],
      captures: [...memory.captures],
      exports: [...memory.exports],
      runtimeEvents: [...runtimeEvents]
    };
  }

  window.StructaNative = Object.freeze({
    getCapabilities,
    getContext: () => router?.getContext?.() || null,
    routeAction: (raw = {}) => router?.routeAction?.(raw) || { ok: false },
    setActiveVerb: (verb, target) => router?.setActiveVerb?.(verb, target),
    setActiveNode: node => router?.setActiveNode?.(node),
    sendStructuredMessage,
    writeJournalEntry,
    requestEmailWithdrawal,
    queueJournalExport,
    storeAsset,
    storeCaptureBundle,
    openCamera,
    setCameraFacing,
    startPTT,
    stopPTT,
    getMemory,
    emit
  });
})();
