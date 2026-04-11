(() => {
  const contracts = window.StructaContracts;
  const validation = window.StructaValidation;
  const runtimeEvents = [];
  const memory = {
    messages: [],
    journals: [],
    assets: []
  };

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
    runtimeEvents.push(record);
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
      const blob = { messages: memory.messages, journals: memory.journals, assets: memory.assets, runtimeEvents };
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

    memory.messages.push(payload);
    saveFallback();
    console.log('[Structa Native Fallback]', payload);
    return { sent: false, bridge: 'fallback' };
  }

  function sendStructuredMessage(raw = {}) {
    const verdict = validation.validateEnvelope(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Structured message', verdict.errors);
      emit('validation_failed', { kind: 'message', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value, capabilities: getCapabilities() };
    }

    const payload = verdict.value;
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

  function writeJournalEntry(raw = {}) {
    const verdict = validation.validateJournalEntry(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Journal entry', verdict.errors);
      emit('validation_failed', { kind: 'journal', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value };
    }

    const payload = verdict.value;
    memory.journals.push(payload);
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

  function storeAsset(raw = {}) {
    const verdict = validation.validateAsset(raw);
    if (!verdict.ok) {
      const error = validation.validationMessage('Asset', verdict.errors);
      emit('validation_failed', { kind: 'asset', errors: verdict.errors, raw });
      return { ok: false, error, payload: verdict.value };
    }

    const payload = verdict.value;
    memory.assets.push(payload);
    saveFallback();
    emit('asset_stored', payload);
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
      runtimeEvents: [...runtimeEvents]
    };
  }

  window.StructaNative = Object.freeze({
    getCapabilities,
    sendStructuredMessage,
    writeJournalEntry,
    storeAsset,
    openCamera,
    setCameraFacing,
    startPTT,
    stopPTT,
    getMemory,
    emit
  });
})();
