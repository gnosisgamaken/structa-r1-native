(() => {
  const contracts = window.StructaContracts;
  const validation = window.StructaValidation;
  const router = window.StructaActionRouter;
  const probe = window.StructaRuntimeProbe;

  const runtimeEvents = [];
  const MAX_RUNTIME_EVENTS = 200;
  const MAX_MEMORY_ITEMS = 200;
  const MAX_LOG_ITEMS = 240;
  const MAX_PROBE_EVENTS = 240;
  const EXPORT_BATCH_SIZE = 33;

  function pushLimited(list, item, limit = MAX_MEMORY_ITEMS) {
    list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
    return item;
  }

  function lower(value = '') {
    return String(value || '').toLowerCase();
  }

  function hashText(value = '') {
    let hash = 2166136261;
    const text = String(value || 'structa');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `r1-${(hash >>> 0).toString(16)}`;
  }

  function detectDeviceId() {
    const candidates = [
      window.__RABBIT_DEVICE_ID__,
      window.rabbit?.deviceId,
      window.Rabbit?.deviceId,
      window.creationStorage?.deviceId,
      window.PluginMessageHandler?.deviceId
    ].filter(Boolean);
    if (candidates.length) return String(candidates[0]);
    try {
      const existing = window.localStorage?.getItem('structa-device-id');
      if (existing) return existing;
      const generated = `browser-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage?.setItem('structa-device-id', generated);
      return generated;
    } catch (_) {
      return 'browser-fallback';
    }
  }

  const probeMode = window.location.hash.includes('probe') || (() => {
    try {
      return window.localStorage?.getItem('structa-probe') === '1';
    } catch (_) {
      return false;
    }
  })();

  const deviceId = detectDeviceId();
  const deviceScopeKey = hashText(deviceId);
  const cacheKey = `structa-native-cache-v2:${deviceScopeKey}`;

  const memory = {
    messages: [],
    journals: [],
    assets: [],
    captures: [],
    exports: [],
    logs: [],
    probeEvents: [],
    uiState: {
      selected_card_id: 'now',
      last_surface: 'home',
      resumed_at: null,
      last_capture_summary: '',
      last_insight_summary: '',
      last_event_summary: ''
    },
    projectMemory: {
      project_id: contracts.baseProjectCode,
      device_scope_key: deviceScopeKey,
      name: 'untitled project',
      structure: [],
      backlog: [],
      decisions: [],
      captures: [],
      insights: [],
      open_questions: [],
      exports: [],
      updated_at: new Date().toISOString()
    }
  };

  function emit(eventType, payload) {
    const record = {
      event_type: eventType,
      payload,
      created_at: new Date().toISOString()
    };
    pushLimited(runtimeEvents, record, MAX_RUNTIME_EVENTS);
    try {
      window.dispatchEvent(new CustomEvent('structa-native-event', { detail: record }));
    } catch (_) {}
    return record;
  }

  function appendProbeEvent(raw = {}) {
    const entry = {
      id: raw.id || contracts.makeEntryId('probe'),
      source: lower(raw.source || 'probe'),
      name: raw.name || 'event',
      payload: raw.payload ?? null,
      created_at: raw.created_at || new Date().toISOString()
    };
    pushLimited(memory.probeEvents, entry, MAX_PROBE_EVENTS);
    pushLimited(memory.logs, {
      id: contracts.makeEntryId('log'),
      kind: 'probe',
      message: `${entry.source} ${lower(entry.name)}`,
      linked_capture_id: null,
      linked_response_id: null,
      created_at: entry.created_at
    }, MAX_LOG_ITEMS);
    persist();
    try {
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    } catch (_) {}
    return entry;
  }

  let probeListenerAttached = false;

  function startProbeIfNeeded() {
    if (!probeMode || !probe?.start) return;
    probe.start();
    probe.getEvents?.().forEach(event => appendProbeEvent(event));
    if (probeListenerAttached) return;
    probeListenerAttached = true;
    window.addEventListener('structa-probe-event', event => {
      appendProbeEvent(event.detail || {});
    });
  }

  function persist() {
    const blob = {
      deviceId,
      deviceScopeKey,
      memory,
      runtimeEvents
    };
    try {
      window.localStorage?.setItem(cacheKey, JSON.stringify(blob));
    } catch (_) {}
  }

  function hydrate() {
    try {
      const raw = window.localStorage?.getItem(cacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.assign(memory, parsed.memory || {});
    } catch (_) {}
  }

  hydrate();
  startProbeIfNeeded();

  function postPayload(payload) {
    if (typeof window.PluginMessageHandler !== 'undefined' && typeof window.PluginMessageHandler.postMessage === 'function') {
      window.PluginMessageHandler.postMessage(JSON.stringify(payload));
      return { sent: true, bridge: 'PluginMessageHandler' };
    }
    pushLimited(memory.messages, payload);
    persist();
    return { sent: false, bridge: 'fallback' };
  }

  function touchProjectMemory(mutator) {
    mutator(memory.projectMemory);
    memory.projectMemory.updated_at = new Date().toISOString();
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return memory.projectMemory;
  }

  function updateUIState(patch = {}) {
    memory.uiState = { ...(memory.uiState || {}), ...patch };
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return { ...memory.uiState };
  }

  function getUIState() {
    return { ...(memory.uiState || {}) };
  }

  function appendLogEntry(raw = {}) {
    const entry = {
      id: contracts.makeEntryId('log'),
      kind: lower(raw.kind || 'event'),
      message: lower(raw.message || 'event'),
      linked_capture_id: raw.linked_capture_id || null,
      linked_response_id: raw.linked_response_id || null,
      created_at: raw.created_at || new Date().toISOString()
    };
    pushLimited(memory.logs, entry, MAX_LOG_ITEMS);
    memory.uiState.last_event_summary = entry.message;
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return entry;
  }

  function isVisibleLogEntry(entry = {}) {
    const kind = lower(entry.kind || '');
    const message = lower(entry.message || '');
    if (kind === 'probe' && (message.includes('document pointerdown') || message.includes('document pointerup'))) return false;
    if (kind === 'probe' && message.includes('window structa-native-event')) return false;
    if (kind === 'ui' && message.includes('probe probe mode active')) return false;
    return true;
  }

  function getVisibleLogs(limit = 5) {
    return memory.logs.filter(isVisibleLogEntry).slice(-limit);
  }

  function inferCaptureInsight(bundle) {
    if (!bundle) return '';
    if (bundle.ai_response) return lower(bundle.ai_response);
    if (bundle.summary) return lower(bundle.summary);
    if (bundle.prompt_text) return lower(bundle.prompt_text);
    return 'new capture stored';
  }

  function updateProjectFromCapture(bundle) {
    touchProjectMemory(project => {
      project.captures = Array.isArray(project.captures) ? project.captures : [];
      project.captures.push({
        id: bundle.entry_id,
        type: bundle.input_type,
        summary: lower(bundle.summary || bundle.prompt_text || 'capture'),
        created_at: bundle.captured_at || new Date().toISOString()
      });
      project.structure = [
        { title: 'captures', count: project.captures.length },
        { title: 'insights', count: (project.insights || []).length },
        { title: 'open items', count: (project.backlog || []).length }
      ];
      if (bundle.summary) {
        project.insights = Array.isArray(project.insights) ? project.insights : [];
        project.insights.unshift({ title: 'capture insight', body: lower(bundle.summary), created_at: new Date().toISOString() });
        project.insights = project.insights.slice(0, 16);
      }
    });
    updateUIState({
      last_capture_summary: lower(bundle.summary || bundle.prompt_text || 'capture stored'),
      last_insight_summary: lower(bundle.summary || bundle.prompt_text || 'capture stored')
    });
  }

  function sendStructuredMessage(raw = {}) {
    const routed = router?.routeAction?.(raw);
    const verdict = validation.validateEnvelope(raw);
    if (!verdict.ok) {
      emit('validation_failed', { kind: 'message', errors: verdict.errors, raw });
      return { ok: false, error: validation.validationMessage('structured message', verdict.errors), payload: verdict.value };
    }
    const payload = verdict.value;
    if (routed?.ok) {
      payload.meta = {
        ...(payload.meta || {}),
        route: routed.route,
        context_snapshot: routed.context_snapshot,
        context_summary: router?.summarizeContext?.(routed.context_snapshot)
      };
    }
    const result = postPayload({
      ...payload,
      useLLM: true,
      wantsR1Response: payload.wantsR1Response !== false,
      wantsJournalEntry: payload.wantsJournalEntry === true
    });
    appendLogEntry({ kind: payload.verb, message: `${payload.verb} ${payload.target}` });
    emit('message_sent', { payload, result });
    return { ok: true, payload, result };
  }

  function writeJournalEntry(raw = {}) {
    const verdict = validation.validateJournalEntry(raw);
    if (!verdict.ok) {
      emit('validation_failed', { kind: 'journal', errors: verdict.errors, raw });
      return { ok: false, error: validation.validationMessage('journal entry', verdict.errors), payload: verdict.value };
    }
    const payload = verdict.value;
    pushLimited(memory.journals, payload);
    appendLogEntry({ kind: 'journal', message: payload.title });
    touchProjectMemory(project => {
      project.open_questions = Array.isArray(project.open_questions) ? project.open_questions : [];
      if (payload.body.includes('?')) project.open_questions.unshift(payload.body);
      project.open_questions = project.open_questions.slice(0, 12);
      if (!project.backlog.length) {
        project.backlog.push({ title: payload.title, created_at: payload.created_at, state: 'open' });
      }
    });
    updateUIState({ last_event_summary: lower(payload.title), last_insight_summary: lower(payload.body.slice(0, 80)) });
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
      emit('validation_failed', { kind: 'asset', errors: verdict.errors, raw });
      return { ok: false, error: validation.validationMessage('asset', verdict.errors), payload: verdict.value };
    }
    pushLimited(memory.assets, verdict.value);
    persist();
    return { ok: true, payload: verdict.value };
  }

  function storeCaptureBundle(raw = {}) {
    const verdict = validation.validateCaptureBundle(raw);
    if (!verdict.ok) {
      emit('validation_failed', { kind: 'capture_bundle', errors: verdict.errors, raw });
      return { ok: false, error: validation.validationMessage('capture bundle', verdict.errors), payload: verdict.value };
    }
    const payload = verdict.value;
    pushLimited(memory.captures, payload);
    appendLogEntry({ kind: payload.input_type, message: payload.summary || payload.prompt_text || 'capture stored', linked_capture_id: payload.entry_id });
    updateProjectFromCapture(payload);
    persist();
    return { ok: true, payload };
  }

  function requestEmailWithdrawal(raw = {}) {
    const body = lower(raw.body || raw.note || 'prepare export');
    appendLogEntry({ kind: 'withdraw', message: body });
    return sendStructuredMessage({
      project_code: raw.project_code || contracts.baseProjectCode,
      entry_id: raw.entry_id || contracts.makeEntryId('withdraw'),
      source_type: raw.source_type || 'voice',
      input_type: 'withdrawal',
      target: 'export',
      verb: 'withdraw',
      intent: 'withdraw journal export via email',
      goal: body,
      approval_mode: 'human_required',
      fallback: 'store-only',
      payload: raw
    });
  }

  function exportLatestLogs(limit = EXPORT_BATCH_SIZE) {
    const items = memory.logs.slice(-limit);
    const now = new Date();
    const name = `structa logs ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const body = [
      `# ${name}`,
      '',
      ...items.map(item => `- ${item.created_at} · ${item.message}`)
    ].join("\n");
    const payload = {
      name,
      body,
      created_at: new Date().toISOString(),
      device_scope_key: deviceScopeKey,
      items
    };
    pushLimited(memory.exports, payload, 60);
    touchProjectMemory(project => {
      project.exports = Array.isArray(project.exports) ? project.exports : [];
      project.exports.unshift({ name, created_at: payload.created_at, count: items.length });
      project.exports = project.exports.slice(0, 20);
    });
    postPayload({
      message: body,
      useLLM: false,
      wantsJournalEntry: true
    });
    appendLogEntry({ kind: 'export', message: `${name} saved` });
    persist();
    return { ok: true, payload };
  }

  function openCamera(mode = 'environment') {
    appendLogEntry({ kind: 'camera', message: `${mode} camera open` });
    return sendStructuredMessage(contracts.createEnvelope({
      verb: 'inspect',
      target: 'camera',
      input_type: 'camera-open',
      source_type: 'camera',
      intent: `open camera ${mode}`,
      goal: `open ${mode} camera`,
      approval_mode: 'human_required',
      fallback: 'camera-ui',
      meta: { mode, device_scope_key: deviceScopeKey }
    }));
  }

  function setCameraFacing(facing = 'environment') {
    appendLogEntry({ kind: 'camera', message: `${facing} facing` });
    return sendStructuredMessage(contracts.createEnvelope({
      verb: 'inspect',
      target: 'camera',
      input_type: 'camera-facing',
      source_type: 'camera',
      intent: `set camera facing ${facing}`,
      goal: `switch camera to ${facing}`,
      approval_mode: 'human_required',
      fallback: 'camera-ui',
      meta: { facing, device_scope_key: deviceScopeKey }
    }));
  }

  function startPTT() {
    appendLogEntry({ kind: 'voice', message: 'voice capture started' });
    emit('ptt_started', { active: true });
    return sendStructuredMessage({
      verb: 'capture',
      target: 'voice',
      input_type: 'ptt-start',
      source_type: 'microphone',
      intent: 'start voice capture',
      goal: 'capture spoken intent',
      approval_mode: 'human_required',
      fallback: 'voice-capture',
      payload: { device_scope_key: deviceScopeKey }
    });
  }

  function stopPTT(transcript = '') {
    appendLogEntry({ kind: 'voice', message: transcript ? `voice ${lower(transcript).slice(0, 48)}` : 'voice capture stopped' });
    emit('ptt_stopped', { transcript });
    return sendStructuredMessage({
      verb: 'inspect',
      target: 'voice',
      input_type: 'ptt-stop',
      source_type: 'microphone',
      intent: transcript ? `process transcript ${lower(transcript)}` : 'process voice capture',
      goal: 'normalize spoken intent',
      approval_mode: 'human_required',
      fallback: 'voice-capture',
      payload: { transcript: lower(transcript), device_scope_key: deviceScopeKey }
    });
  }

  function getRecentLogEntries(limit = 5, options = {}) {
    return options.visible_only ? getVisibleLogs(limit) : memory.logs.slice(-limit);
  }

  function getMemory() {
    return {
      ...memory,
      messages: [...memory.messages],
      journals: [...memory.journals],
      assets: [...memory.assets],
      captures: [...memory.captures],
      exports: [...memory.exports],
      logs: [...memory.logs],
      probeEvents: [...memory.probeEvents],
      uiState: { ...(memory.uiState || {}) },
      runtimeEvents: [...runtimeEvents],
      deviceId,
      deviceScopeKey,
      probeMode
    };
  }

  function getProjectMemory() {
    return JSON.parse(JSON.stringify(memory.projectMemory));
  }

  function returnHome() {
    router?.updateContext?.({ surface: 'home', active_node: 'now' });
    updateUIState({ last_surface: 'home', resumed_at: new Date().toISOString() });
    emit('return_home', { surface: 'home' });
  }

  persist();

  window.StructaNative = Object.freeze({
    getCapabilities: () => ({ hasSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition), hasCamera: !!navigator.mediaDevices?.getUserMedia, hasPTT: true, hasScrollHardware: true, probeMode, hasProbe: !!probe }),
    getContext: () => router?.getContext?.() || null,
    routeAction: raw => router?.routeAction?.(raw) || { ok: false },
    setActiveVerb: (verb, target) => router?.setActiveVerb?.(verb, target),
    setActiveNode: node => router?.setActiveNode?.(node),
    sendStructuredMessage,
    writeJournalEntry,
    requestEmailWithdrawal,
    storeAsset,
    storeCaptureBundle,
    openCamera,
    setCameraFacing,
    startPTT,
    stopPTT,
    appendLogEntry,
    getRecentLogEntries,
    exportLatestLogs,
    getProjectMemory,
    getMemory,
    getUIState,
    updateUIState,
    getProbeEvents: () => [...memory.probeEvents],
    appendProbeEvent,
    returnHome,
    emit,
    deviceId,
    deviceScopeKey,
    probeMode
  });
})();
