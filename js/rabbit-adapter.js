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

  function createDefaultProject(input = {}) {
    const project = contracts.createProject({
      project_id: input.project_id || contracts.baseProjectCode,
      device_scope_key: deviceScopeKey,
      name: input.name || 'untitled project',
      type: input.type || 'general',
      user_role: input.user_role || '',
      nodes: input.nodes || [],
      impact_chain: input.impact_chain || [],
      exports: input.exports || [],
      clarity_score: input.clarity_score || 0,
      created_at: input.created_at,
      meta: input.meta || {}
    });
    project.status = input.status || 'active';
    project.structure = Array.isArray(input.structure) ? input.structure : [];
    project.backlog = Array.isArray(input.backlog) ? input.backlog : [];
    project.decisions = Array.isArray(input.decisions) ? input.decisions : [];
    project.pending_decisions = Array.isArray(input.pending_decisions) ? input.pending_decisions : [];
    project.captures = Array.isArray(input.captures) ? input.captures : [];
    project.insights = Array.isArray(input.insights) ? input.insights : [];
    project.open_questions = Array.isArray(input.open_questions) ? input.open_questions : [];
    project.schema_version = input.schema_version || 3;
    return project;
  }

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
    active_project_id: contracts.baseProjectCode,
    projects: [],
    projectMemory: null
  };

  memory.projects = [createDefaultProject({ project_id: contracts.baseProjectCode })];
  memory.projectMemory = memory.projects[0];

  function syncActiveProjectAlias() {
    var active = Array.isArray(memory.projects)
      ? memory.projects.find(function(project) { return project.project_id === memory.active_project_id; })
      : null;
    if (!active) {
      if (!Array.isArray(memory.projects) || !memory.projects.length) {
        memory.projects = [createDefaultProject({ project_id: contracts.baseProjectCode })];
      }
      active = memory.projects[0];
      memory.active_project_id = active.project_id;
    }
    memory.projectMemory = active;
    return active;
  }

  function ensureProjectRegistry() {
    if (!Array.isArray(memory.projects) || !memory.projects.length) {
      var legacyProject = memory.projectMemory && typeof memory.projectMemory === 'object'
        ? memory.projectMemory
        : createDefaultProject({ project_id: contracts.baseProjectCode });
      memory.projects = [createDefaultProject(legacyProject)];
      memory.active_project_id = legacyProject.project_id || contracts.baseProjectCode;
    }

    memory.projects = memory.projects.map(function(project, index) {
      var hydrated = createDefaultProject(project || {});
      if (!hydrated.project_id) hydrated.project_id = index === 0 ? contracts.baseProjectCode : contracts.makeEntryId('project');
      if (!hydrated.device_scope_key) hydrated.device_scope_key = deviceScopeKey;
      if (!hydrated.schema_version || hydrated.schema_version < 3) migrateV2toV3(hydrated);
      return hydrated;
    });

    if (!memory.active_project_id || !memory.projects.some(function(project) { return project.project_id === memory.active_project_id; })) {
      memory.active_project_id = memory.projects[0].project_id;
    }

    var activeProjectId = memory.active_project_id;
    memory.captures = (memory.captures || []).map(function(capture) {
      return capture && !capture.project_id ? { ...capture, project_id: activeProjectId } : capture;
    });
    memory.journals = (memory.journals || []).map(function(journal) {
      return journal && !journal.project_id ? { ...journal, project_id: activeProjectId } : journal;
    });

    syncActiveProjectAlias();
    return memory.projectMemory;
  }

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
      visible_message: `${entry.source} ${lower(entry.name)}`,
      visible: true,
      linked_capture_id: null,
      linked_response_id: null,
      created_at: entry.created_at
    }, MAX_LOG_ITEMS);
    persist();
    try {
      window.dispatchEvent(new CustomEvent('structa-probe-event', { detail: entry }));
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    } catch (_) {}
    return entry;
  }

  let probeListenerAttached = false;
  let probeBridgeWrapped = false;

  function startProbeIfNeeded() {
    if (!probeMode || probeListenerAttached) return;
    probeListenerAttached = true;

    try { window.localStorage?.setItem('structa-probe', '1'); } catch (_) {}

    appendProbeEvent({ source: 'probe', name: 'started' });
    appendProbeEvent({ source: 'probe', name: 'mode active' });
    appendProbeEvent({ source: 'window', name: `viewport ${window.innerWidth}x${window.innerHeight}` });
    appendProbeEvent({ source: 'window', name: `screen ${window.screen?.width || 0}x${window.screen?.height || 0}` });

    [
      'sideClick',
      'scrollUp',
      'scrollDown',
      'longPressStart',
      'longPressEnd',
      'pttStart',
      'pttEnd',
      'backbutton',
      'popstate'
    ].forEach(function(eventName) {
      window.addEventListener(eventName, function() {
        var label = eventName;
        if (eventName === 'scrollUp') label = 'scrollDown';
        if (eventName === 'scrollDown') label = 'scrollUp';
        appendProbeEvent({ source: 'window', name: label });
      });
    });

    ['visibilitychange', 'focus', 'blur', 'pagehide'].forEach(function(eventName) {
      var target = eventName === 'visibilitychange' ? document : window;
      target.addEventListener(eventName, function() {
        var suffix = '';
        if (eventName === 'visibilitychange') suffix = document.hidden ? ' hidden' : ' visible';
        appendProbeEvent({ source: target === document ? 'document' : 'window', name: eventName + suffix });
      });
    });

    if (!probeBridgeWrapped && window.PluginMessageHandler && typeof window.PluginMessageHandler.postMessage === 'function') {
      probeBridgeWrapped = true;
      const originalPostMessage = window.PluginMessageHandler.postMessage.bind(window.PluginMessageHandler);
      window.PluginMessageHandler.postMessage = function(payload) {
        var summary = 'bridge-out PluginMessageHandler.postMessage';
        try {
          var parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
          var text = parsed?.message || parsed?.intent || parsed?.goal || '';
          if (parsed?.imageBase64) summary += ' imageBase64';
          if (text) summary += ' ' + String(text).slice(0, 48).replace(/\s+/g, ' ').trim();
        } catch (_) {}
        appendProbeEvent({ source: 'bridge-out', name: summary });
        return originalPostMessage(payload);
      };
    }
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
    ensureProjectRegistry();
    rebuildLegacyViews();
  }

  // Async hydrate from StructaStorage (runs after sync hydrate)
  async function hydrateAsync() {
    if (!window.StructaStorage) return;
    try {
      await window.StructaStorage.init();
      var data = await window.StructaStorage.load();
      if (data && data.memory) {
        // Only use if newer than localStorage version
        var storedActive = Array.isArray(data.memory?.projects)
          ? data.memory.projects.find(function(project) { return project.project_id === data.memory.active_project_id; })
          : data.memory?.projectMemory;
        var storedTime = new Date(storedActive?.updated_at || 0).getTime();
        var localTime = new Date(memory.projectMemory?.updated_at || 0).getTime();
        if (storedTime > localTime) {
          Object.assign(memory, data.memory);
          ensureProjectRegistry();
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
    ensureProjectRegistry();
    mutator(memory.projectMemory);
    memory.projectMemory.updated_at = new Date().toISOString();
    rebuildLegacyViews();
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return memory.projectMemory;
  }

  function getProjects() {
    ensureProjectRegistry();
    return memory.projects
      .slice()
      .sort(function(a, b) {
        return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
      })
      .map(function(project) {
        return {
          project_id: project.project_id,
          name: project.name || 'untitled project',
          type: project.type || 'general',
          status: project.status || 'active',
          user_role: project.user_role || '',
          updated_at: project.updated_at,
          created_at: project.created_at,
          counts: {
            captures: (project.captures || []).length,
            insights: (project.insights || []).length,
            backlog: (project.backlog || []).length,
            questions: (project.open_questions || []).length
          },
          is_active: project.project_id === memory.active_project_id
        };
      });
  }

  function createProject(name, type) {
    ensureProjectRegistry();
    var rawName = String((name || '').trim() || 'Untitled Project');
    var normalizedName = lower(rawName);
    var existing = memory.projects.find(function(project) { return lower(project.name) === normalizedName; });
    if (existing) return switchProject(existing.project_id);

    var project = createDefaultProject({
      project_id: contracts.makeEntryId('project'),
      name: rawName,
      type: contracts.projectTypes.includes(type) ? type : 'general',
      status: 'active'
    });
    memory.projects.forEach(function(entry) {
      if (entry.project_id !== project.project_id && entry.status !== 'archived') entry.status = 'parked';
    });
    memory.projects.unshift(project);
    memory.active_project_id = project.project_id;
    syncActiveProjectAlias();
    updateUIState({ last_event_summary: 'project created', last_surface: 'home' });
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return project;
  }

  function switchProject(projectIdOrName) {
    ensureProjectRegistry();
    var needle = lower(projectIdOrName || '').trim();
    if (!needle) return null;
    var project = memory.projects.find(function(entry) {
      return entry.project_id === projectIdOrName || lower(entry.name) === needle;
    }) || memory.projects.find(function(entry) {
      return lower(entry.name).includes(needle);
    });
    if (!project) return null;
    memory.projects.forEach(function(entry) {
      if (entry.project_id !== project.project_id && entry.status !== 'archived') entry.status = 'parked';
    });
    project.status = 'active';
    memory.active_project_id = project.project_id;
    syncActiveProjectAlias();
    rebuildLegacyViews();
    memory.uiState.last_event_summary = 'project opened';
    memory.uiState.last_surface = 'home';
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return project;
  }

  function archiveProject(projectIdOrName) {
    ensureProjectRegistry();
    var project = switchProject(projectIdOrName) || memory.projectMemory;
    if (!project) return { ok: false, error: 'project not found' };
    if (memory.projects.length <= 1) return { ok: false, error: 'cannot archive last project' };

    project.status = 'archived';
    var replacement = memory.projects.find(function(entry) {
      return entry.project_id !== project.project_id && entry.status !== 'archived';
    }) || memory.projects.find(function(entry) { return entry.project_id !== project.project_id; });
    if (replacement) {
      replacement.status = 'active';
      memory.active_project_id = replacement.project_id;
      syncActiveProjectAlias();
      rebuildLegacyViews();
    }
    memory.uiState.last_event_summary = 'project archived';
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return { ok: true, project: project };
  }

  function deleteProject(projectIdOrName) {
    ensureProjectRegistry();
    var needle = lower(projectIdOrName || '').trim();
    var project = memory.projects.find(function(entry) {
      return entry.project_id === projectIdOrName || lower(entry.name) === needle;
    }) || memory.projects.find(function(entry) {
      return lower(entry.name).includes(needle);
    }) || memory.projectMemory;
    if (!project) return { ok: false, error: 'project not found' };
    if (memory.projects.length <= 1) return { ok: false, error: 'cannot delete last project' };

    memory.projects = memory.projects.filter(function(entry) { return entry.project_id !== project.project_id; });
    if (memory.active_project_id === project.project_id) {
      var replacement = memory.projects.find(function(entry) { return entry.status !== 'archived'; }) || memory.projects[0];
      if (replacement) {
        replacement.status = 'active';
        memory.active_project_id = replacement.project_id;
      }
    }
    syncActiveProjectAlias();
    rebuildLegacyViews();
    memory.uiState.last_event_summary = 'project deleted';
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return { ok: true, project_id: project.project_id };
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

  function normalizeSpacing(text = '') {
    return lower(String(text || ''))
      .replace(/\s+/g, ' ')
      .replace(/\bthe the\b/g, 'the')
      .trim();
  }

  function normalizeVisibleMessage(kind = '', message = '') {
    const k = lower(kind || 'event');
    const raw = normalizeSpacing(message || 'event');
    if (!raw || raw === 'event' || raw === 'no event') return null;

    if (raw.startsWith('stt:')) return null;
    if (raw.startsWith('beat ')) return null;
    if (raw.includes('started at') && k === 'heartbeat') return null;
    if (raw.includes('paused —') && k === 'heartbeat') return null;
    if (raw.includes('chain started')) return null;
    if (raw.includes('chain paused')) return null;
    if (raw === 'camera opened' || raw.endsWith('camera open')) return 'camera ready';
    if (raw === 'capture capture') return 'capturing image';
    if (raw === 'camera image captured' || raw === 'image captured') return 'image captured';
    if (raw === 'image saved') return 'image saved';
    if (raw === 'voice saved') return 'voice saved';
    if (raw === 'question answered') return 'question answered';
    if (raw === 'insight extracted') return 'insight added';
    if (raw === 'insight unavailable' || raw === 'insight failed') return 'insight unavailable';
    if (raw === 'visual insight ready') return 'visual note ready';
    if (raw === 'visual insight unavailable' || raw === 'visual insight failed') return 'visual note unavailable';
    if (raw.startsWith('bridge-in onpluginmessage')) return null;
    if (raw.startsWith('bridge-out pluginmessagehandler.postmessage')) return null;
    if (raw.startsWith('answering:')) return 'answering question';
    if (raw.startsWith('answered:')) return 'question answered';
    if (raw.startsWith('saved 33 logs')) return 'log export saved';
    if (raw.startsWith('could not save logs')) return 'log export unavailable';
    if (raw.startsWith('decision created:')) return 'decision ready';
    if (raw === 'decision skipped' || raw === 'decision decision skipped') return 'decision skipped';
    if (raw === 'decision decision approved') return 'decision approved';
    if (raw.startsWith('suggestion:')) return 'new suggestion ready';
    if (raw.includes('inspect camera') || raw.includes('environment facing')) return null;
    if (raw.includes('r1 msg:') || raw === 'llm: thinking...' || raw === 'r1 stt: start') return null;
    if (raw.includes('heartbeat started') || raw.includes('heartbeat stopped')) return null;
    if (raw.includes('window ') || raw.includes('document ')) return null;

    if (k === 'heartbeat') return null;
    if (k === 'chain' && raw.startsWith('observe:')) return null;
    if (k === 'chain' && raw.startsWith('research:')) return null;
    if (k === 'chain' && raw.startsWith('evaluate:')) return null;
    if (k === 'chain' && raw.startsWith('decision:')) return 'decision ready';

    return raw;
  }

  function isDuplicateVisibleMessage(message = '', createdAt = Date.now()) {
    if (!message) return false;
    for (let i = memory.logs.length - 1; i >= 0; i -= 1) {
      const entry = memory.logs[i];
      if (!entry?.visible_message) continue;
      const ageMs = Math.abs(new Date(createdAt).getTime() - new Date(entry.created_at || createdAt).getTime());
      if (ageMs > 8000) break;
      if (entry.visible_message === message) return true;
    }
    return false;
  }

  function appendLogEntry(raw = {}) {
    const createdAt = raw.created_at || new Date().toISOString();
    const rawMessage = normalizeSpacing(raw.message || 'event');
    const visibleMessage = normalizeVisibleMessage(raw.kind || 'event', rawMessage);
    const entry = {
      id: contracts.makeEntryId('log'),
      kind: lower(raw.kind || 'event'),
      message: rawMessage,
      visible_message: visibleMessage,
      visible: visibleMessage ? !isDuplicateVisibleMessage(visibleMessage, createdAt) : false,
      linked_capture_id: raw.linked_capture_id || null,
      linked_response_id: raw.linked_response_id || null,
      created_at: createdAt
    };
    pushLimited(memory.logs, entry, MAX_LOG_ITEMS);
    if (entry.visible && entry.visible_message) {
      memory.uiState.last_event_summary = entry.visible_message;
    }
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
    const message = lower(entry.visible_message || entry.message || '');

    if (entry.visible === false) return false;
    if (!entry.visible_message) return false;

    if (probeMode && kind === 'probe') return true;

    // Suppress ALL probe messages outside probe mode
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
    return memory.logs
      .filter(isVisibleLogEntry)
      .map(entry => ({ ...entry, message: entry.visible_message || entry.message }))
      .slice(-limit);
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
        ai_analysis: lower(bundle.ai_analysis || bundle.ai_response || bundle.summary || bundle.prompt_text || 'capture'),
        image_asset: bundle.image_asset || null,
        prompt_text: bundle.prompt_text || '',
        created_at: bundle.captured_at || new Date().toISOString(),
        project_id: memory.active_project_id,
        meta: { image_asset: bundle.image_asset || null }
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
    const payload = { ...verdict.value, project_id: memory.active_project_id, project_code: memory.active_project_id };
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
    const payload = { ...verdict.value, project_id: memory.active_project_id, project_code: memory.active_project_id };
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
      project_code: raw.project_code || memory.active_project_id,
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
      project_id: memory.active_project_id,
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
    ensureProjectRegistry();
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
    ensureProjectRegistry();
    return JSON.parse(JSON.stringify(memory.projectMemory));
  }

  function getActiveProjectId() {
    ensureProjectRegistry();
    return memory.active_project_id;
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
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'decision-approved' }
      }));
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
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'decision-approved' }
      }));
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
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'decision-dismissed' }
      }));
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
        project_code: memory.active_project_id,
        project_id: memory.active_project_id,
        entry_id: contracts.makeEntryId('answer'),
        source_type: 'voice',
        title: 'answered: ' + (questionNodes[idx].body || '').slice(0, 30),
        body: 'Q: ' + (questionNodes[idx].body || '') + '\nA: ' + (answer || ''),
        created_at: new Date().toISOString(),
        meta: { answered: true }
      });
      appendLogEntry({ kind: 'journal', message: 'answered: ' + (questionNodes[idx].body || '').slice(0, 40) });
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'question-resolved' }
      }));
      return memory.projectMemory;
    }
    // Legacy fallback
    return touchProjectMemory(function(project) {
      project.open_questions = Array.isArray(project.open_questions) ? project.open_questions : [];
      if (idx >= project.open_questions.length) return;
      var question = project.open_questions.splice(idx, 1)[0];
      pushLimited(memory.journals, {
        project_code: memory.active_project_id,
        project_id: memory.active_project_id,
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
    getProjects,
    getActiveProjectId,
    switchProject,
    createProject,
    archiveProject,
    deleteProject,
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
