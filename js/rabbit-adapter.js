(() => {
  const contracts = window.StructaContracts;
  const validation = window.StructaValidation;
  const router = window.StructaActionRouter;   // optional — loaded if present

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

  const MAX_NODES = 60;

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
      last_event_summary: '',
      onboarded: false
    },
    projectMemory: {
      project_id: contracts.baseProjectCode,
      device_scope_key: deviceScopeKey,
      name: 'untitled project',
      type: 'general',
      user_role: '',
      nodes: [],
      impact_chain: [],
      exports: [],
      clarity_score: 0,
      // Legacy compat views (computed from nodes)
      structure: [],
      backlog: [],
      decisions: [],
      pending_decisions: [],
      captures: [],
      insights: [],
      open_questions: [],
      updated_at: new Date().toISOString(),
      schema_version: 3
    }
  };

  // === Node helpers ===
  function addNode(input) {
    var node = contracts.createNode({
      ...input,
      project_id: memory.projectMemory.project_id
    });
    memory.projectMemory.nodes.unshift(node);
    if (memory.projectMemory.nodes.length > MAX_NODES) {
      memory.projectMemory.nodes = memory.projectMemory.nodes.slice(0, MAX_NODES);
    }
    rebuildLegacyViews();
    memory.projectMemory.updated_at = new Date().toISOString();
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return node;
  }

  function resolveNode(nodeId, resolution) {
    var node = memory.projectMemory.nodes.find(function(n) { return n.node_id === nodeId; });
    if (!node) return null;
    node.status = 'resolved';
    node.resolved_at = new Date().toISOString();
    if (resolution) {
      if (resolution.selected_option) node.selected_option = resolution.selected_option;
      if (resolution.question_answer) node.question_answer = resolution.question_answer;
    }
    rebuildLegacyViews();
    memory.projectMemory.updated_at = new Date().toISOString();
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return node;
  }

  function archiveNode(nodeId) {
    var node = memory.projectMemory.nodes.find(function(n) { return n.node_id === nodeId; });
    if (!node) return null;
    node.status = 'archived';
    rebuildLegacyViews();
    persist();
    return node;
  }

  function getNodesByType(type) {
    return memory.projectMemory.nodes.filter(function(n) { return n.type === type && n.status !== 'archived'; });
  }

  function getNodesByStatus(status) {
    return memory.projectMemory.nodes.filter(function(n) { return n.status === status; });
  }

  function computeClarityScore() {
    var nodes = memory.projectMemory.nodes;
    if (!nodes.length) return 0;
    var resolved = nodes.filter(function(n) { return n.status === 'resolved'; }).length;
    return Math.round((resolved / nodes.length) * 100);
  }

  // Rebuild legacy flat-array views from unified nodes[]
  function rebuildLegacyViews() {
    var pm = memory.projectMemory;
    var nodes = pm.nodes;

    pm.backlog = nodes.filter(function(n) { return n.type === 'task' && n.status === 'open'; })
      .map(function(n) { return { title: n.title, body: n.body, created_at: n.created_at, state: 'open', node_id: n.node_id }; });

    pm.decisions = nodes.filter(function(n) { return n.type === 'decision' && n.status === 'resolved'; })
      .map(function(n) {
        return {
          text: n.title, body: n.body, reason: n.body,
          options: n.decision_options, selected_option: n.selected_option,
          selected_option_index: n.decision_options.indexOf(n.selected_option),
          source: n.source + ' → approved',
          created_at: n.created_at, approved_at: n.resolved_at, node_id: n.node_id
        };
      });

    pm.pending_decisions = nodes.filter(function(n) { return n.type === 'decision' && n.status === 'open'; })
      .map(function(n) {
        return {
          text: n.title, options: n.decision_options, source: n.source,
          insight_body: n.body, created_at: n.created_at, node_id: n.node_id
        };
      });

    pm.captures = nodes.filter(function(n) { return n.type === 'capture'; })
      .map(function(n) {
        return {
          id: n.node_id, type: n.capture_image ? 'image' : 'voice',
          summary: n.body || n.title, ai_analysis: n.body,
          created_at: n.created_at, node_id: n.node_id
        };
      });

    pm.insights = nodes.filter(function(n) { return n.type === 'insight'; })
      .map(function(n) {
        return {
          title: n.title, body: n.body, next: n.next_action,
          confidence: n.confidence, created_at: n.created_at, node_id: n.node_id
        };
      });

    pm.open_questions = nodes.filter(function(n) { return n.type === 'question' && n.status === 'open'; })
      .map(function(n) { return n.body || n.title; });

    pm.clarity_score = computeClarityScore();

    pm.structure = [
      { title: 'captures', count: pm.captures.length },
      { title: 'insights', count: pm.insights.length },
      { title: 'decisions', count: pm.decisions.length },
      { title: 'open items', count: pm.backlog.length }
    ];
  }

  // === v2 → v3 migration ===
  function migrateV2toV3(pm) {
    if (pm.schema_version >= 3) return pm;
    var nodes = [];

    (pm.backlog || []).forEach(function(item) {
      nodes.push(contracts.createNode({
        type: 'task', status: 'open', title: item.title || '', body: item.body || '',
        source: 'migration', created_at: item.created_at
      }));
    });

    (pm.decisions || []).forEach(function(d) {
      var text = typeof d === 'string' ? d : (d.text || d.title || '');
      nodes.push(contracts.createNode({
        type: 'decision', status: 'resolved', title: text, body: d.reason || d.body || text,
        source: (d.source || 'migration'), decision_options: d.options || [],
        selected_option: d.selected_option || null,
        created_at: d.created_at, resolved_at: d.approved_at || d.created_at
      }));
    });

    (pm.pending_decisions || []).forEach(function(d) {
      var text = typeof d === 'string' ? d : (d.text || '');
      nodes.push(contracts.createNode({
        type: 'decision', status: 'open', title: text, body: d.insight_body || '',
        source: d.source || 'migration', decision_options: d.options || [],
        created_at: d.created_at
      }));
    });

    (pm.captures || []).forEach(function(c) {
      nodes.push(contracts.createNode({
        type: 'capture', title: c.summary || 'capture', body: c.ai_analysis || c.summary || '',
        source: 'camera', capture_image: c.id, created_at: c.created_at
      }));
    });

    (pm.insights || []).forEach(function(ins) {
      nodes.push(contracts.createNode({
        type: 'insight', title: ins.title || 'insight', body: ins.body || '',
        confidence: ins.confidence || 'med', next_action: ins.next || '',
        source: 'llm', created_at: ins.created_at
      }));
    });

    (pm.open_questions || []).forEach(function(q) {
      nodes.push(contracts.createNode({
        type: 'question', status: 'open', title: 'question', body: q,
        source: 'migration', created_at: new Date().toISOString()
      }));
    });

    pm.nodes = nodes.slice(0, MAX_NODES);
    pm.schema_version = 3;
    pm.type = pm.type || 'general';
    pm.user_role = pm.user_role || '';
    return pm;
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
    // Probe module removed — no-op
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
    // Also write to StructaStorage if available
    if (window.StructaStorage) {
      window.StructaStorage.save(blob).catch(function() {});
    }
  }

  function hydrate() {
    try {
      const raw = window.localStorage?.getItem(cacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.assign(memory, parsed.memory || {});
    } catch (_) {}
    // Migrate v2 → v3 if needed
    if (memory.projectMemory && (!memory.projectMemory.schema_version || memory.projectMemory.schema_version < 3)) {
      migrateV2toV3(memory.projectMemory);
      rebuildLegacyViews();
      persist();
    } else if (memory.projectMemory && memory.projectMemory.nodes) {
      rebuildLegacyViews();
    }
  }

  // Async hydrate from StructaStorage (runs after sync hydrate)
  async function hydrateAsync() {
    if (!window.StructaStorage) return;
    try {
      await window.StructaStorage.init();
      var data = await window.StructaStorage.load();
      if (data && data.memory) {
        // Only use if newer than localStorage version
        var storedTime = new Date(data.memory?.projectMemory?.updated_at || 0).getTime();
        var localTime = new Date(memory.projectMemory?.updated_at || 0).getTime();
        if (storedTime > localTime) {
          Object.assign(memory, data.memory);
          if (!memory.projectMemory.schema_version || memory.projectMemory.schema_version < 3) {
            migrateV2toV3(memory.projectMemory);
          }
          rebuildLegacyViews();
          persist();
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        }
      }
    } catch (_) {}
  }

  // Emergency snapshot on beforeunload
  window.addEventListener('beforeunload', function() {
    if (window.StructaStorage) {
      window.StructaStorage.snapshot({ deviceId, deviceScopeKey, memory, runtimeEvents });
    }
  });

  hydrate();
  hydrateAsync();
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
    rebuildLegacyViews();
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

  /**
   * isVisibleLogEntry -- aggressive noise suppression.
   * Only shows content-creation actions: voice, camera, llm insights, journal, export, heartbeat.
   */
  function isVisibleLogEntry(entry = {}) {
    const kind = lower(entry.kind || '');
    const message = lower(entry.message || '');

    // Suppress ALL probe messages (hardware events, API probes)
    if (kind === 'probe') return false;

    // Suppress UI noise
    if (kind === 'ui') {
      const noisePatterns = [
        'window focus', 'window blur', 'window scroll', 'window scrollup', 'window scrolldown',
        'window beforeunload', 'window pagehide', 'window visibilitychange',
        'document visibilitychange', 'document pointerdown', 'document pointerup',
        'document keydown', 'document wheel',
        'probe probe mode active',
        'hint mode: show', 'hint mode exit', 'hint mode: tell',
        'show hint', 'tell hint', 'show active', 'tell active',
        'show ready', 'tell ready', 'tell ready from ptt',
        'hint mode: show', 'hint mode exit',
        'camera ready', 'camera frame captured',
        'voice capture started', 'voice capture stopped'
      ];
      if (noisePatterns.some(p => message.includes(p))) return false;
      // Show meaningful focus events only
      if (message.includes('surface:')) return false;
      if (message.includes('ready')) return false;
    }

    // Suppress empty/meaningless messages
    if (message === 'event' || message === 'no event') return false;
    if (message.startsWith('r1 msg:')) return false;  // Debug bridge noise
    if (message === 'llm: thinking...') return false;  // LLM noise
    if (message === 'r1 stt: start') return false;     // STT internal
    if (message === 'no creationvoicehandler') return false;
    if (message.startsWith('camera ready') || message === 'camera frame captured') return false;

    // Suppress heartbeat start/stop messages from visible log (keep in memory)
    if (kind === 'system' && (message.includes('heartbeat started') || message.includes('heartbeat stopped'))) return false;

    // Suppress R1 hardware bridge noise
    if (message.includes('inspect camera') || message.includes('environment facing')) return false;

    // Suppress heartbeat beat messages (only show suggestions and start/stop)
    if (kind === 'heartbeat' && message.startsWith('beat ')) return false;

    return true;
  }

  function getVisibleLogs(limit = 5) {
    return memory.logs.filter(isVisibleLogEntry).slice(-limit);
  }

  function inferCaptureInsight(bundle) {
    if (!bundle) return '';
    if (bundle.ai_response) return lower(bundle.ai_response);
    if (bundle.ai_analysis) return lower(bundle.ai_analysis);
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
    });
    updateUIState({
      last_capture_summary: lower(bundle.summary || bundle.prompt_text || 'capture stored')
    });
  }

  function sendStructuredMessage(raw = {}) {
    const routed = router?.routeAction?.(raw);
    const verdict = validation.validateEnvelope(raw);
    if (!verdict.ok) {
      emit('validation_failed', { kind: 'message', errors: verdict.errors, raw });
      return { ok: false, error: validation.validationMessage('structured message', verdict.errors), payload: verdict.value };
    }
    const envelope = verdict.value;
    if (routed?.ok) {
      envelope.meta = {
        ...(envelope.meta || {}),
        route: routed.route,
        context_snapshot: routed.context_snapshot,
        context_summary: router?.summarizeContext?.(routed.context_snapshot)
      };
    }
    var llmMessage = buildLLMMessage(envelope);
    // Camera operations must NOT trigger R1 voice assistant
    // Setting useLLM=false + wantsR1Response=false prevents the R1 from speaking
    var isCameraOp = envelope.source_type === 'camera' ||
                     envelope.input_type?.includes('camera') ||
                     envelope.verb === 'inspect';
    var sdkPayload = {
      message: llmMessage,
      useLLM: isCameraOp ? false : true,
      wantsR1Response: isCameraOp ? false : (envelope.wantsR1Response !== false),
      wantsJournalEntry: envelope.wantsJournalEntry === true
    };
    const result = postPayload(sdkPayload);
    appendLogEntry({ kind: envelope.verb, message: envelope.target === 'camera' ? 'camera opened' : `${envelope.verb} ${envelope.target}` });
    emit('message_sent', { envelope, result });
    return { ok: true, envelope, result };
  }

  function buildLLMMessage(envelope) {
    var verb = lower(envelope.verb || 'capture');
    var target = lower(envelope.target || 'item');
    var intent = lower(envelope.intent || '');
    var goal = lower(envelope.goal || '');

    if (envelope.input_type === 'ptt-stop' && envelope.payload?.transcript) {
      return envelope.payload.transcript;
    }
    if (envelope.input_type === 'journal') {
      var title = envelope.payload?.title || 'note';
      var body = envelope.payload?.body || '';
      return body || title;
    }
    if (envelope.source_type === 'camera' || envelope.input_type?.includes('capture')) {
      return goal || intent || `${verb} ${target}`;
    }
    return intent || goal || `${verb} ${target}`;
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
    persist();
    return { ok: true, payload };
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
    emit('ptt_started', { active: true });
  }

  function stopPTT(transcript = '') {
    emit('ptt_stopped', { transcript });
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

  // === Decision management ===

  /**
   * approvePendingDecision -- moves a pending decision to locked decisions.
   * @param {number} index - index in pending_decisions array (default: 0 = most recent)
   * @param {number} selectedOptionIndex - selected option index for multi-option decisions
   * @param {string|null} selectedOption - selected option label for multi-option decisions
   * @returns {{ ok: boolean, decision: object }}
   */
  function approvePendingDecision(index, selectedOptionIndex, selectedOption) {
    var idx = index || 0;
    var optionIndex = typeof selectedOptionIndex === 'number' ? selectedOptionIndex : null;
    var optionLabel = typeof selectedOption === 'string' ? selectedOption : null;

    // Try node-based approval first
    var pendingNodes = memory.projectMemory.nodes.filter(function(n) { return n.type === 'decision' && n.status === 'open'; });
    if (idx < pendingNodes.length) {
      var node = pendingNodes[idx];
      var options = node.decision_options || [];
      var resolvedOption = optionLabel;
      if (!resolvedOption && optionIndex !== null && optionIndex >= 0 && optionIndex < options.length) {
        resolvedOption = options[optionIndex];
      }
      resolveNode(node.node_id, { selected_option: resolvedOption });
      // Also journal the decision
      pushLimited(memory.messages, {
        message: 'decision locked: ' + (node.title || '').slice(0, 60),
        useLLM: false,
        wantsJournalEntry: true
      });
      return memory.projectMemory;
    }

    // Fallback to legacy
    return touchProjectMemory(function(project) {
      project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
      if (idx >= project.pending_decisions.length) return;
      var pending = project.pending_decisions.splice(idx, 1)[0];
      // Convert to node
      var text = typeof pending === 'string' ? pending : (pending.text || 'decision locked');
      var pendingOptions = Array.isArray(pending && pending.options) ? pending.options.slice(0, 3) : [];
      var resolvedOpt = optionLabel;
      if (!resolvedOpt && optionIndex !== null && optionIndex >= 0 && optionIndex < pendingOptions.length) {
        resolvedOpt = pendingOptions[optionIndex];
      }
      addNode({
        type: 'decision', status: 'resolved', title: text,
        body: pending.insight_body || text, source: (pending.source || 'voice'),
        decision_options: pendingOptions, selected_option: resolvedOpt,
        resolved_at: new Date().toISOString()
      });
    });
  }

  /**
   * dismissPendingDecision -- removes a pending decision (user skips it).
   */
  function dismissPendingDecision(index) {
    var idx = index || 0;
    var pendingNodes = memory.projectMemory.nodes.filter(function(n) { return n.type === 'decision' && n.status === 'open'; });
    if (idx < pendingNodes.length) {
      archiveNode(pendingNodes[idx].node_id);
      rebuildLegacyViews();
      persist();
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      return memory.projectMemory;
    }
    return touchProjectMemory(function(project) {
      project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
      if (idx >= project.pending_decisions.length) return;
      project.pending_decisions.splice(idx, 1);
    });
  }

  /**
   * resolveQuestion -- marks an open question as answered.
   * @param {number} index - index in open_questions array
   * @param {string} answer - the user's answer
   */
  function resolveQuestion(index, answer) {
    var idx = index || 0;
    // Try node-based resolution
    var questionNodes = memory.projectMemory.nodes.filter(function(n) { return n.type === 'question' && n.status === 'open'; });
    if (idx < questionNodes.length) {
      resolveNode(questionNodes[idx].node_id, { question_answer: answer });
      pushLimited(memory.journals, {
        project_code: contracts.baseProjectCode,
        entry_id: contracts.makeEntryId('answer'),
        source_type: 'voice',
        title: 'answered: ' + (questionNodes[idx].body || '').slice(0, 30),
        body: 'Q: ' + (questionNodes[idx].body || '') + '\nA: ' + (answer || ''),
        created_at: new Date().toISOString(),
        meta: { answered: true }
      });
      appendLogEntry({ kind: 'journal', message: 'answered: ' + (questionNodes[idx].body || '').slice(0, 40) });
      return memory.projectMemory;
    }
    // Legacy fallback
    return touchProjectMemory(function(project) {
      project.open_questions = Array.isArray(project.open_questions) ? project.open_questions : [];
      if (idx >= project.open_questions.length) return;
      var question = project.open_questions.splice(idx, 1)[0];
      pushLimited(memory.journals, {
        project_code: contracts.baseProjectCode,
        entry_id: contracts.makeEntryId('answer'),
        source_type: 'voice',
        title: 'answered: ' + (question || '').slice(0, 30),
        body: 'Q: ' + (question || '') + '\nA: ' + (answer || ''),
        created_at: new Date().toISOString(),
        meta: { question_index: idx, answered: true }
      });
      appendLogEntry({ kind: 'journal', message: 'answered: ' + (question || '').slice(0, 40) });
    });
  }

  /**
   * addBacklogItem -- adds a task to the project backlog from voice.
   */
  function addBacklogItem(title, body) {
    return addNode({
      type: 'task', status: 'open',
      title: title || 'new task', body: body || '',
      source: 'voice'
    });
  }

  /**
   * setProjectName -- sets the project name (first meaningful voice input).
   */
  function setProjectName(name) {
    if (!name || name === 'untitled project') return;
    return touchProjectMemory(function(project) {
      if (project.name === 'untitled project') {
        project.name = name;
      }
    });
  }

  function setProjectType(type) {
    if (!type || !contracts.projectTypes.includes(type)) return;
    return touchProjectMemory(function(project) {
      project.type = type;
    });
  }

  function setUserRole(role) {
    if (!role) return;
    return touchProjectMemory(function(project) {
      project.user_role = role;
    });
  }

  function getActiveProject() {
    return JSON.parse(JSON.stringify(memory.projectMemory));
  }

  persist();

  window.StructaNative = Object.freeze({
    getCapabilities: () => ({ hasSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition), hasCamera: !!navigator.mediaDevices?.getUserMedia, hasPTT: true, hasScrollHardware: true, probeMode }),
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
    isVisibleLogEntry,
    exportLatestLogs,
    getProjectMemory,
    getMemory,
    getUIState,
    updateUIState,
    getProbeEvents: () => [...memory.probeEvents],
    appendProbeEvent,
    returnHome,
    emit,
    touchProjectMemory,
    approvePendingDecision,
    dismissPendingDecision,
    resolveQuestion,
    addBacklogItem,
    setProjectName,
    setProjectType,
    setUserRole,
    getActiveProject,
    addNode,
    resolveNode,
    archiveNode,
    getNodesByType,
    getNodesByStatus,
    deviceId,
    deviceScopeKey,
    probeMode
  });
})();
