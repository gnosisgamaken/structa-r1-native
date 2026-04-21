(() => {
  const contracts = window.StructaContracts;
  const validation = window.StructaValidation;
  const router = window.StructaActionRouter;   // optional — loaded if present
  const COPY = window.StructaCopy || Object.freeze({
    backgroundWorking: 'working in background',
    waitingAnswer: 'waiting on your answer',
    boilerRoomReady: 'boiler room ready',
    holdPttBegin: 'hold ptt to begin',
    holdPttExtend: 'hold ptt to extend',
    holdPttComment: 'hold ptt · comment',
    readyForFrame: 'ready for a frame',
    frameSaved: 'frame saved',
    frameCaptured: 'frame captured',
    visualNoteReady: 'visual note ready',
    visualNoteUnavailable: 'visual note unavailable',
    reportSavedLocally: 'report saved locally',
    reportSavedLocallyOnly: 'report saved locally only',
    queuedWorking: function(count) {
      return count + ' queued · working in background';
    }
  });
  window.StructaCopy = COPY;

  const runtimeEvents = [];
  const MAX_RUNTIME_EVENTS = 200;
  const MAX_MEMORY_ITEMS = 200;
  const MAX_LOG_ITEMS = 240;
  const MAX_PROBE_EVENTS = 240;
  const MAX_TRACE_ITEMS = 200;
  const MAX_CLAIMS = 9999;
  const MAX_ANSWERS = 120;
  const EXPORT_BATCH_SIZE = 33;
  const UI_STATE_PERSIST_DELAY_MS = 120;
  const DIAGNOSTIC_PROJECT_NAME = '__diagnostic';

  function pushLimited(list, item, limit = MAX_MEMORY_ITEMS) {
    list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
    return item;
  }

  function cloneValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function sanitizeTraceValue(value, depth = 0) {
    if (value == null) return value;
    if (depth > 2) return '[depth]';
    if (typeof value === 'string') return compact(value, 120);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      return value.slice(0, 6).map(function(entry) {
        return sanitizeTraceValue(entry, depth + 1);
      });
    }
    if (typeof value === 'object') {
      var output = {};
      Object.keys(value).slice(0, 10).forEach(function(key) {
        if (/^(imageBase64|previewData|data|blob|prompt)$/i.test(key)) {
          output[key] = '[omitted]';
          return;
        }
        output[key] = sanitizeTraceValue(value[key], depth + 1);
      });
      return output;
    }
    return String(value);
  }

  function ensureTraceStore() {
    if (!memory.__trace || typeof memory.__trace !== 'object') {
      memory.__trace = {
        events: [],
        voiceCalls: {
          total: 0,
          violations: 0,
          byKind: {}
        }
      };
    }
    if (!Array.isArray(memory.__trace.events)) memory.__trace.events = [];
    if (!memory.__trace.voiceCalls || typeof memory.__trace.voiceCalls !== 'object') {
      memory.__trace.voiceCalls = { total: 0, violations: 0, byKind: {} };
    }
    if (!memory.__trace.voiceCalls.byKind || typeof memory.__trace.voiceCalls.byKind !== 'object') {
      memory.__trace.voiceCalls.byKind = {};
    }
    return memory.__trace;
  }

  function traceEvent(flow, from, to, ctx) {
    var trace = ensureTraceStore();
    var entry = {
      t: new Date().toISOString(),
      flow: lower(flow || 'runtime'),
      from: lower(from || ''),
      to: lower(to || ''),
      ctx: sanitizeTraceValue(ctx || {})
    };
    pushLimited(trace.events, entry, MAX_TRACE_ITEMS);
    try {
      window.dispatchEvent(new CustomEvent('structa-trace', {
        detail: cloneValue(entry)
      }));
    } catch (_) {}
    return entry;
  }

  function recordVoiceCall(kind, allowed, meta) {
    var trace = ensureTraceStore();
    var voiceCalls = trace.voiceCalls;
    var name = lower(kind || 'unknown');
    voiceCalls.total = Number(voiceCalls.total || 0) + 1;
    voiceCalls.byKind[name] = Number(voiceCalls.byKind[name] || 0) + 1;
    if (!allowed) {
      voiceCalls.violations = Number(voiceCalls.violations || 0) + 1;
    }
    traceEvent('voice-call', allowed ? 'requested' : 'suppressed', name, {
      allowed: !!allowed,
      meta: meta || {}
    });
    return cloneValue(voiceCalls);
  }

  function getTrace() {
    return cloneValue(ensureTraceStore());
  }

  function snapshotState() {
    ensureProjectRegistry();
    var project = cloneValue(memory.projectMemory || {});
    var queue = cloneValue(window.StructaProcessingQueue?.snapshot?.() || []);
    var openQuestions = Array.isArray(project?.open_question_nodes)
      ? project.open_question_nodes.length
      : ((project?.nodes || []).filter(function(node) { return node.type === 'question' && node.status === 'open'; }).length);
    var activeFocus = Array.isArray(project?.focuses)
      ? project.focuses.find(function(entry) { return entry.id === project.activeFocusId; }) || null
      : null;
    return {
      memory: cloneValue(memory),
      project: project,
      queue: queue,
      queueState: {
        items: queue,
        paused: !!window.StructaProcessingQueue?.isPaused?.()
      },
      trace: getTrace(),
      model: {
        questions_open: openQuestions,
        answers_count: Array.isArray(project?.answers) ? project.answers.length : 0,
        claims_count: Array.isArray(project?.claims) ? project.claims.length : 0,
        disputed_claims: Array.isArray(project?.claims) ? project.claims.filter(function(claim) { return claim?.status === 'disputed'; }).length : 0,
        blockers_live: openQuestions,
        focus_state: activeFocus?.state || 'idle',
        active_focus_id: activeFocus?.id || '',
        history_entries: Array.isArray(project?.chainHistory) ? project.chainHistory.length : 0
      }
    };
  }

  function emitModelChange(detail) {
    try {
      window.dispatchEvent(new CustomEvent('structa-model-change', {
        detail: detail || {}
      }));
    } catch (_) {}
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

  function compact(text = '', limit = 72) {
    var value = String(text || '').trim().replace(/\s+/g, ' ');
    if (value.length <= limit) return value;
    return value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
  }

  function encodeStorageValue(value) {
    var payload = JSON.stringify({
      __structa_storage_v1: true,
      value: cloneValue(value)
    });
    return btoa(unescape(encodeURIComponent(payload)));
  }

  function decodeStorageValue(raw) {
    if (raw == null || raw === '') {
      return { ok: true, value: null, raw: raw, encoded: false };
    }
    var rawString = String(raw);
    var candidates = [{ value: rawString, encoded: false }];
    try {
      candidates.unshift({
        value: decodeURIComponent(escape(atob(rawString))),
        encoded: true
      });
    } catch (_) {}

    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      try {
        var parsed = JSON.parse(candidate.value);
        if (parsed && typeof parsed === 'object' && parsed.__structa_storage_v1) {
          return { ok: true, value: parsed.value, raw: rawString, encoded: candidate.encoded };
        }
        return { ok: true, value: parsed, raw: rawString, encoded: candidate.encoded };
      } catch (_) {}
    }

    return { ok: true, value: rawString, raw: rawString, encoded: false };
  }

  function getStorageBucket(tier) {
    if (tier === 'secure') return window.creationStorage?.secure || null;
    return window.creationStorage?.plain || null;
  }

  function storageWrite(tier, key, value) {
    var bucket = getStorageBucket(tier);
    if (!bucket?.setItem) {
      return Promise.resolve({ ok: false, error: tier + ' storage unavailable' });
    }
    try {
      var encoded = encodeStorageValue(value);
      return Promise.resolve(bucket.setItem(key, encoded)).then(function() {
        return { ok: true, key: key, encoded: true };
      }).catch(function(error) {
        return { ok: false, error: error?.message || (tier + ' storage write failed') };
      });
    } catch (error) {
      return Promise.resolve({ ok: false, error: error?.message || (tier + ' storage encode failed') });
    }
  }

  function storageRead(tier, key) {
    var bucket = getStorageBucket(tier);
    if (!bucket?.getItem) {
      return Promise.resolve({ ok: false, error: tier + ' storage unavailable', value: null });
    }
    return Promise.resolve(bucket.getItem(key)).then(function(raw) {
      var decoded = decodeStorageValue(raw);
      return {
        ok: true,
        key: key,
        value: decoded.value,
        raw: decoded.raw,
        encoded: decoded.encoded
      };
    }).catch(function(error) {
      return { ok: false, error: error?.message || (tier + ' storage read failed'), value: null };
    });
  }

  function storageRemove(tier, key) {
    var bucket = getStorageBucket(tier);
    if (!bucket?.removeItem) {
      return Promise.resolve({ ok: false, error: tier + ' storage unavailable' });
    }
    return Promise.resolve(bucket.removeItem(key)).then(function() {
      return { ok: true, key: key };
    }).catch(function(error) {
      return { ok: false, error: error?.message || (tier + ' storage remove failed') };
    });
  }

  var storage = Object.freeze({
    encode: encodeStorageValue,
    decode: function(raw) { return decodeStorageValue(raw).value; },
    plain: Object.freeze({
      write: function(key, value) { return storageWrite('plain', key, value); },
      read: function(key) { return storageRead('plain', key); },
      remove: function(key) { return storageRemove('plain', key); }
    }),
    secure: Object.freeze({
      write: function(key, value) { return storageWrite('secure', key, value); },
      read: function(key) { return storageRead('secure', key); },
      remove: function(key) { return storageRemove('secure', key); }
    })
  });

  function probeStorageHealth() {
    var cases = [
      { label: 'empty-object', value: {} },
      { label: 'ascii-only', value: { text: 'plain ascii ok' } },
      { label: 'emoji', value: { text: 'queue ready 🚀' } },
      { label: 'blob-32kb', value: { blob: 'x'.repeat(32768) } },
      { label: 'symbols', value: { text: 'plus+/ slash/ equals= keep' } }
    ];
    ['plain', 'secure'].forEach(function(tier) {
      var bucket = getStorageBucket(tier);
      if (!bucket?.setItem || !bucket?.getItem || !bucket?.removeItem) {
        traceEvent('storage.probe', tier, 'skipped', { reason: 'unavailable' });
        return;
      }
      cases.forEach(function(entry) {
        var key = '__structa_storage_probe__.' + tier + '.' + entry.label;
        storageWrite(tier, key, entry.value).then(function(writeResult) {
          if (!writeResult.ok) {
            traceEvent('storage.probe', entry.label, 'failed', {
              tier: tier,
              reason: writeResult.error || 'write failed'
            });
            return;
          }
          return storageRead(tier, key).then(function(readResult) {
            var passed = readResult.ok && JSON.stringify(readResult.value) === JSON.stringify(entry.value);
            traceEvent('storage.probe', entry.label, passed ? 'passed' : 'failed', {
              tier: tier,
              reason: passed ? '' : (readResult.error || 'mismatch')
            });
            return storageRemove(tier, key);
          });
        }).catch(function(error) {
          traceEvent('storage.probe', entry.label, 'failed', {
            tier: tier,
            reason: error?.message || 'probe failed'
          });
        });
      });
    });
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

  const probeMode = window.location.hash.includes('probe') || new URLSearchParams(window.location.search || '').get('debug') === '1';

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
    project.claims = Array.isArray(input.claims) ? input.claims : [];
    project.answers = Array.isArray(input.answers) ? input.answers : [];
    project.claimIndex = input.claimIndex && typeof input.claimIndex === 'object' ? input.claimIndex : {
      byItem: {},
      byBranch: {},
      byStatus: {}
    };
    project.focuses = Array.isArray(input.focuses) ? input.focuses : [];
    project.activeFocusId = input.activeFocusId || null;
    project.chainHistory = Array.isArray(input.chainHistory) ? input.chainHistory : [];
    project.schema_version = input.schema_version || 6;
    return project;
  }

  function ensureProjectKnowledge(project) {
    if (!project || typeof project !== 'object') return project;
    project.claims = Array.isArray(project.claims) ? project.claims : [];
    project.answers = Array.isArray(project.answers) ? project.answers : [];
    project.claimIndex = project.claimIndex && typeof project.claimIndex === 'object' ? project.claimIndex : {
      byItem: {},
      byBranch: {},
      byStatus: {}
    };
    project.focuses = Array.isArray(project.focuses) ? project.focuses : [];
    project.activeFocusId = project.activeFocusId || null;
    project.chainHistory = Array.isArray(project.chainHistory) ? project.chainHistory : [];
    return project;
  }

  function ensureProjectChainState(project) {
    ensureProjectKnowledge(project);
    project.focuses = Array.isArray(project.focuses) ? project.focuses.map(function(entry) {
      return contracts.createFocus(entry || {});
    }) : [];
    if (project.activeFocusId && !project.focuses.some(function(entry) { return entry.id === project.activeFocusId; })) {
      project.activeFocusId = null;
    }
    project.chainHistory = Array.isArray(project.chainHistory) ? project.chainHistory : [];
    return project;
  }

  function getActiveFocusOnProject(project) {
    ensureProjectChainState(project);
    if (!project.activeFocusId) return null;
    return project.focuses.find(function(entry) { return entry.id === project.activeFocusId; }) || null;
  }

  function getLiveEvidenceRegistry(project) {
    ensureProjectKnowledge(project);
    var registry = {};
    (project.claims || []).forEach(function(claim) {
      if (!claim?.id) return;
      registry[claim.id] = {
        kind: 'claim',
        id: claim.id,
        status: claim.status || 'active'
      };
    });
    (project.answers || []).forEach(function(answer) {
      if (!answer?.id) return;
      registry[answer.id] = {
        kind: 'answer',
        id: answer.id,
        status: 'active'
      };
    });
    (project.nodes || []).forEach(function(node) {
      if (!node?.node_id || node.type !== 'question') return;
      registry[node.node_id] = {
        kind: 'question',
        id: node.node_id,
        status: node.status || 'open'
      };
    });
    return registry;
  }

  function sanitizeEvidenceRefs(refs, registry) {
    if (!Array.isArray(refs) || !refs.length) return [];
    var seen = new Set();
    return refs.reduce(function(all, ref) {
      var key = String(ref || '').trim();
      if (!key || !registry[key] || seen.has(key)) return all;
      seen.add(key);
      all.push(key);
      return all;
    }, []);
  }

  function repairEvidenceIntegrity(project, options) {
    ensureProjectChainState(project);
    var opts = options && typeof options === 'object' ? options : {};
    var registry = getLiveEvidenceRegistry(project);
    var repairs = [];

    function rememberRepair(kind, ownerId, before, after) {
      repairs.push({
        kind: kind,
        ownerId: String(ownerId || ''),
        before: before.slice(),
        after: after.slice()
      });
    }

    (project.claims || []).forEach(function(claim) {
      var before = Array.isArray(claim?.evidence) ? claim.evidence.filter(Boolean).map(String) : [];
      if (!before.length) return;
      var after = sanitizeEvidenceRefs(before, registry);
      if (after.length === before.length && after.every(function(ref, index) { return ref === before[index]; })) return;
      claim.evidence = after;
      rememberRepair('claim', claim.id, before, after);
    });

    (project.nodes || []).forEach(function(node) {
      var before = Array.isArray(node?.meta?.evidence_claims) ? node.meta.evidence_claims.filter(Boolean).map(String) : [];
      if (!before.length) return;
      var after = sanitizeEvidenceRefs(before, registry);
      if (after.length === before.length && after.every(function(ref, index) { return ref === before[index]; })) return;
      node.meta = { ...(node.meta || {}), evidence_claims: after };
      rememberRepair('node', node.node_id, before, after);
    });

    if (!opts.silent) {
      repairs.forEach(function(repair) {
        traceEvent('chain.orphan_evidence', 'repaired', repair.ownerId, {
          kind: repair.kind,
          removed: repair.before.filter(function(ref) { return repair.after.indexOf(ref) === -1; }).join(','),
          kept: repair.after.join(',')
        });
      });
    }

    return repairs;
  }

  function validateEvidenceIntegrity(project, options) {
    ensureProjectChainState(project);
    var opts = options && typeof options === 'object' ? options : {};
    var registry = getLiveEvidenceRegistry(project);
    var orphans = [];
    function pushOrphan(nodeId, missingRef) {
      orphans.push({ nodeId: String(nodeId || ''), missingRef: String(missingRef || '') });
    }
    (project.claims || []).forEach(function(claim) {
      (claim?.evidence || []).forEach(function(ref) {
        if (!registry[ref]) pushOrphan(claim.id, ref);
      });
    });
    (project.nodes || []).forEach(function(node) {
      var refs = Array.isArray(node?.meta?.evidence_claims) ? node.meta.evidence_claims : [];
      refs.forEach(function(ref) {
        if (!registry[ref]) pushOrphan(node.node_id, ref);
      });
    });
    if (!opts.silent) {
      orphans.forEach(function(orphan) {
        traceEvent('chain.orphan_evidence', 'found', orphan.nodeId, {
          nodeId: orphan.nodeId,
          missingRef: orphan.missingRef
        });
      });
    }
    return orphans;
  }

  function createChainHistoryEntry(input) {
    var now = new Date().toISOString();
    return {
      focusId: input.focusId || '',
      target: input.target || null,
      outcome: lower(input.outcome || 'resolved'),
      durationMs: Number(input.durationMs || 0),
      stepCount: Number(input.stepCount || 0),
      producedClaimCount: Number(input.producedClaimCount || 0),
      at: now
    };
  }

  function startFocusOnProject(project, target, options) {
    if (!project || !target) return null;
    ensureProjectChainState(project);
    var opts = options && typeof options === 'object' ? options : {};
    var focus = contracts.createFocus({
      projectId: project.project_id,
      target: {
        kind: target.kind || 'branch',
        id: target.id || 'main',
        branchId: target.branchId || target.id || 'main'
      },
      phase: opts.phase || 'observe',
      state: 'active',
      createdAt: new Date().toISOString(),
      lastUserSignalAt: opts.lastUserSignalAt || new Date().toISOString()
    });
    project.focuses.unshift(focus);
    project.activeFocusId = focus.id;
    return focus;
  }

  function updateActiveFocusOnProject(project, patch) {
    ensureProjectChainState(project);
    var focus = getActiveFocusOnProject(project);
    if (!focus || !patch || typeof patch !== 'object') return null;
    Object.keys(patch).forEach(function(key) {
      if (key === 'target' && patch.target && typeof patch.target === 'object') {
        focus.target = { ...(focus.target || {}), ...patch.target };
        return;
      }
      focus[key] = patch[key];
    });
    return focus;
  }

  function endFocusOnProject(project, focusId, outcome, options) {
    ensureProjectChainState(project);
    var focus = (project.focuses || []).find(function(entry) { return entry.id === focusId; }) || null;
    if (!focus) return null;
    var opts = options && typeof options === 'object' ? options : {};
    focus.state = lower(outcome || focus.state || 'resolved');
    focus.endedAt = new Date().toISOString();
    var historyEntry = createChainHistoryEntry({
      focusId: focus.id,
      target: cloneValue(focus.target),
      outcome: focus.state,
      durationMs: Math.max(0, new Date(focus.endedAt).getTime() - new Date(focus.createdAt || focus.endedAt).getTime()),
      stepCount: Array.isArray(focus.steps) ? focus.steps.length : 0,
      producedClaimCount: Number(opts.producedClaimCount || 0)
    });
    project.chainHistory.unshift(historyEntry);
    project.chainHistory = project.chainHistory.slice(0, 80);
    if (project.activeFocusId === focus.id) {
      project.activeFocusId = null;
    }
    return {
      focus: focus,
      historyEntry: historyEntry
    };
  }

  function normalizeQuestionText(text) {
    return lower(String(text || '')).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function getQuestionBranchId(questionNode) {
    return String(questionNode?.meta?.branch_id || questionNode?.meta?.branchId || 'main');
  }

  function selectChainFocusOnProject(project) {
    ensureProjectChainState(project);
    var now = Date.now();
    var openQuestions = (project.nodes || []).filter(function(node) {
      return node?.type === 'question'
        && node.status === 'open'
        && (!node.meta?.skipped_until || new Date(node.meta.skipped_until).getTime() <= now);
    });
    var highPriorityQuestion = openQuestions.find(function(node) {
      return lower(node?.meta?.priority || '') === 'high'
        || (node?.meta?.viewed_at && (now - new Date(node.meta.viewed_at).getTime()) < 15 * 60 * 1000);
    });
    if (highPriorityQuestion) {
      return {
        target: {
          kind: 'question',
          id: highPriorityQuestion.node_id,
          branchId: getQuestionBranchId(highPriorityQuestion)
        },
        reason: 'question-priority'
      };
    }
    if (openQuestions.length) {
      var branchId = getQuestionBranchId(openQuestions[0]);
      return {
        target: {
          kind: 'branch',
          id: branchId,
          branchId: branchId
        },
        reason: 'branch-open-questions'
      };
    }
    var disputed = (project.claims || []).find(function(claim) {
      return claim?.status === 'disputed';
    });
    if (disputed) {
      return {
        target: {
          kind: 'claim',
          id: disputed.id,
          branchId: disputed.branchId || 'main'
        },
        reason: 'disputed-claim'
      };
    }
    return null;
  }

  function normalizeClaimText(text = '') {
    return compact(String(text || '').trim().toLowerCase(), 160);
  }

  function normalizeClaimConfidence(value, fallback) {
    if (typeof value === 'number' && isFinite(value)) {
      return Math.max(0, Math.min(1, value));
    }
    if (value === 'high') return 0.86;
    if (value === 'med') return 0.68;
    if (value === 'low') return 0.42;
    return typeof fallback === 'number' ? fallback : 0.68;
  }

  function normalizeClaimRef(ref, fallback) {
    var base = {};
    if (fallback && typeof fallback === 'object') {
      Object.keys(fallback).forEach(function(key) {
        if (fallback[key]) base[key] = fallback[key];
      });
    }
    if (ref && typeof ref === 'object') {
      Object.keys(ref).forEach(function(key) {
        if (ref[key]) base[key] = ref[key];
      });
    }
    return base;
  }

  function migrateClaimRefs(project) {
    ensureProjectKnowledge(project);
    var captures = Array.isArray(project.captures) ? project.captures : [];
    var captureKeys = new Set();
    captures.forEach(function(capture) {
      [capture?.entry_id, capture?.id, capture?.node_id, capture?.capture_image].forEach(function(value) {
        if (value) captureKeys.add(String(value));
      });
    });
    (project.nodes || []).forEach(function(node) {
      if (node?.type !== 'capture') return;
      [node?.node_id, node?.capture_image, node?.meta?.bundle_id].forEach(function(value) {
        if (value) captureKeys.add(String(value));
      });
    });
    (project.claims || []).forEach(function(claim) {
      if (!claim || !claim.sourceRef || typeof claim.sourceRef !== 'object') return;
      var imageRef = String(claim.sourceRef.imageRef || '').trim();
      if (imageRef && !claim.sourceRef.imageId) {
        if (captureKeys.has(imageRef)) {
          claim.sourceRef.imageId = imageRef;
        } else if (claim.sourceRef.itemId && captureKeys.has(String(claim.sourceRef.itemId))) {
          claim.sourceRef.imageId = String(claim.sourceRef.itemId);
        }
      }
      if ('imageRef' in claim.sourceRef) {
        delete claim.sourceRef.imageRef;
      }
    });
  }

  function rebuildClaimIndex(project) {
    ensureProjectKnowledge(project);
    var index = {
      byItem: {},
      byBranch: {},
      byStatus: {}
    };
    (project.claims || []).forEach(function(claim) {
      if (!claim || !claim.id) return;
      var itemKeys = [];
      if (claim.sourceRef && typeof claim.sourceRef === 'object') {
        ['itemId', 'imageId', 'questionId', 'threadEntryId', 'answerId'].forEach(function(key) {
          if (claim.sourceRef[key]) itemKeys.push(String(claim.sourceRef[key]));
        });
      }
      itemKeys.forEach(function(key) {
        index.byItem[key] = index.byItem[key] || [];
        if (index.byItem[key].indexOf(claim.id) === -1) index.byItem[key].push(claim.id);
      });
      var branchId = String(claim.branchId || 'main');
      index.byBranch[branchId] = index.byBranch[branchId] || [];
      if (index.byBranch[branchId].indexOf(claim.id) === -1) index.byBranch[branchId].push(claim.id);
      var status = String(claim.status || 'active');
      index.byStatus[status] = index.byStatus[status] || [];
      if (index.byStatus[status].indexOf(claim.id) === -1) index.byStatus[status].push(claim.id);
    });
    project.claimIndex = index;
    return index;
  }

  function findExistingClaim(project, claim) {
    var text = normalizeClaimText(claim.text || '');
    var kind = lower(claim.kind || 'fact');
    var source = lower(claim.source || '');
    var sourceRef = normalizeClaimRef(claim.sourceRef);
    return (project.claims || []).find(function(entry) {
      if (!entry) return false;
      if (normalizeClaimText(entry.text || '') !== text) return false;
      if (lower(entry.kind || 'fact') !== kind) return false;
      if (lower(entry.source || '') !== source) return false;
      var existingRef = normalizeClaimRef(entry.sourceRef);
      return ['itemId', 'imageId', 'questionId', 'threadEntryId', 'answerId'].every(function(key) {
        return String(existingRef[key] || '') === String(sourceRef[key] || '');
      });
    }) || null;
  }

  function findMatchingBranchClaim(project, claim) {
    var text = normalizeClaimText(claim.text || '');
    var kind = lower(claim.kind || 'fact');
    var branchId = String(claim.branchId || 'main');
    return (project.claims || []).find(function(entry) {
      return !!entry
        && normalizeClaimText(entry.text || '') === text
        && lower(entry.kind || 'fact') === kind
        && String(entry.branchId || 'main') === branchId;
    }) || null;
  }

  function addClaimsToProject(project, rawClaims, options) {
    ensureProjectKnowledge(project);
    var claims = Array.isArray(rawClaims) ? rawClaims : [];
    var opts = options && typeof options === 'object' ? options : {};
    var added = [];
    claims.forEach(function(rawClaim) {
      if (!rawClaim || !normalizeClaimText(rawClaim.text || '')) return;
      var candidate = contracts.createClaim({
        id: rawClaim.id || contracts.makeEntryId('claim'),
        projectId: project.project_id,
        branchId: rawClaim.branchId || opts.branchId || 'main',
        text: normalizeClaimText(rawClaim.text || ''),
        kind: rawClaim.kind || opts.kind || 'fact',
        source: rawClaim.source || opts.source || 'voice',
        sourceRef: normalizeClaimRef(rawClaim.sourceRef, opts.sourceRef),
        evidence: Array.isArray(rawClaim.evidence) ? rawClaim.evidence.filter(Boolean) : [],
        confidence: normalizeClaimConfidence(rawClaim.confidence, normalizeClaimConfidence(opts.confidence, 0.68)),
        sttConfidence: typeof rawClaim.sttConfidence === 'number' ? rawClaim.sttConfidence : (typeof opts.sttConfidence === 'number' ? opts.sttConfidence : null),
        status: rawClaim.status || 'active',
        supersededBy: rawClaim.supersededBy || null,
        clarifications: Array.isArray(rawClaim.clarifications) ? rawClaim.clarifications.filter(Boolean) : [],
        disputedBy: Array.isArray(rawClaim.disputedBy) ? rawClaim.disputedBy.filter(Boolean) : [],
        createdAt: rawClaim.createdAt || new Date().toISOString(),
        expiresAt: rawClaim.expiresAt || null
      });
      var existing = findExistingClaim(project, candidate);
      if (!existing && opts.dedupByBranchText) {
        existing = findMatchingBranchClaim(project, candidate);
      }
      if (existing) {
        var newEvidence = Array.isArray(candidate.evidence) ? candidate.evidence.filter(Boolean) : [];
        var existingEvidence = Array.isArray(existing.evidence) ? existing.evidence : [];
        var appended = newEvidence.filter(function(ref) { return existingEvidence.indexOf(ref) === -1; });
        if (appended.length) {
          existing.evidence = existingEvidence.concat(appended);
          traceEvent('claim.evidence.extended', 'existing', existing.id, {
            claimId: existing.id,
            newEvidenceIds: appended
          });
        }
        added.push(existing);
        return;
      }
      project.claims.unshift(candidate);
      added.push(candidate);
    });
    rebuildClaimIndex(project);
    return added;
  }

  function setClaimStatusOnProject(project, claimId, nextStatus, options) {
    if (!project || !claimId || !nextStatus) return null;
    ensureProjectKnowledge(project);
    var claim = findClaimById(project, claimId);
    if (!claim) return null;
    var opts = options && typeof options === 'object' ? options : {};
    var previous = String(claim.status || 'active');
    claim.status = nextStatus;
    if (opts.supersededBy) claim.supersededBy = opts.supersededBy;
    if (nextStatus === 'superseded') {
      var activeFocus = getActiveFocusOnProject(project);
      if (activeFocus && activeFocus.target?.kind === 'claim' && activeFocus.target?.id === claimId) {
        endFocusOnProject(project, activeFocus.id, 'superseded', { producedClaimCount: 0 });
      }
    }
    rebuildClaimIndex(project);
    return {
      id: claim.id,
      previousStatus: previous,
      status: claim.status,
      supersededBy: claim.supersededBy || '',
      reason: opts.reason || ''
    };
  }

  function setClaimStatus(claimId, nextStatus, options) {
    if (!claimId || !nextStatus) return null;
    var opts = options && typeof options === 'object' ? options : {};
    var updated = null;
    touchProjectMemory(function(project) {
      updated = setClaimStatusOnProject(project, claimId, nextStatus, opts);
    });
    if (updated) {
      traceEvent('claim', updated.previousStatus, updated.status, {
        claimId: updated.id,
        supersededBy: updated.supersededBy,
        reason: opts.reason || ''
      });
    }
    return updated;
  }

  function buildInitialUIState() {
    return {
      selected_card_id: 'now',
      last_surface: 'home',
      resumed_at: null,
      user_status: '',
      system_status: '',
      diagnostic_status: '',
      last_capture_summary: '',
      last_capture_entry_id: '',
      last_insight_summary: '',
      last_event_summary: '',
      onboarded: false,
      onboarding_step: 0,
      onboarding_paused: false,
      onboarding_step2_skipped: false,
      onboarding_step4_skipped: false,
      tutorial_last_entered_step: 0,
      tutorial_step_entered_at: null,
      tutorial_step2_fallback_visible: false,
      tutorial_step2_fallback_reason: '',
      tutorial_step2_fallback_index: 0,
      tutorial_step2_ptt_attempted: false,
      tutorial_step4_camera_denied: false,
      queue_blockers: [],
      project_cap_notice: '',
      flush_undo_available_until: 0,
      depth_comment_count: 0,
      depth_chevron_seen: false,
      diagnostic_last_error: '',
      diagnostic_delivery_mode: '',
      diagnostic_report_status: '',
      diagnostic_last_run_id: '',
      blocker_summary: '',
      answer_summary: '',
      research_summary: ''
    };
  }

  function buildInitialMemory() {
    var baseProject = createDefaultProject({ project_id: contracts.baseProjectCode });
    return {
      messages: [],
      journals: [],
      assets: [],
      captures: [],
      triangleSlot: null,
      exports: [],
      logs: [],
      probeEvents: [],
      __trace: {
        events: [],
        voiceCalls: {
          total: 0,
          violations: 0,
          byKind: {}
        }
      },
      uiState: buildInitialUIState(),
      active_project_id: baseProject.project_id,
      projects: [baseProject],
      projectMemory: baseProject
    };
  }

  const memory = buildInitialMemory();
  let uiStatePersistTimer = null;

  function flushPendingUIStatePersist() {
    if (!uiStatePersistTimer) return;
    clearTimeout(uiStatePersistTimer);
    uiStatePersistTimer = null;
    persist();
  }

  function scheduleUIStatePersist(immediate) {
    if (immediate) {
      if (uiStatePersistTimer) {
        clearTimeout(uiStatePersistTimer);
        uiStatePersistTimer = null;
      }
      persist();
      return;
    }
    if (uiStatePersistTimer) return;
    uiStatePersistTimer = setTimeout(function() {
      uiStatePersistTimer = null;
      persist();
    }, UI_STATE_PERSIST_DELAY_MS);
  }

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
      ensureProjectKnowledge(hydrated);
      ensureProjectChainState(hydrated);
      migrateClaimRefs(hydrated);
      rebuildClaimIndex(hydrated);
      repairEvidenceIntegrity(hydrated, { silent: false });
      validateEvidenceIntegrity(hydrated, { silent: false });
      if (!hydrated.schema_version || hydrated.schema_version < 6) {
        hydrated.schema_version = 6;
        traceEvent('chain', 'legacy', 'migrated', {
          projectId: hydrated.project_id
        });
      }
      return hydrated;
    });

    function isEmptyUntitled(project) {
      return lower(project?.name || '') === 'untitled project'
        && (project?.nodes || []).length === 0
        && (project?.captures || []).length === 0
        && (project?.insights || []).length === 0
        && (project?.open_questions || []).length === 0
        && (project?.pending_decisions || []).length === 0;
    }

    var emptyUntitled = memory.projects.filter(isEmptyUntitled);
    if (emptyUntitled.length > 1) {
      var keep = emptyUntitled.find(function(project) {
        return project.project_id === memory.active_project_id;
      }) || emptyUntitled.slice().sort(function(a, b) {
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      })[0];
      memory.projects = memory.projects.filter(function(project) {
        return !isEmptyUntitled(project) || project.project_id === keep.project_id;
      });
    }

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
    ensureProjectKnowledge(memory.projectMemory);
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

  function addVoiceEntry(raw = {}) {
    var text = String(raw.body || raw.text || '').trim();
    if (!text) return null;
    return addNode({
      type: 'voice-entry',
      status: 'open',
      title: (raw.title || text.slice(0, 42) || 'voice note'),
      body: text,
      source: raw.source || 'voice',
      meta: {
        entry_mode: raw.entry_mode || 'auto',
        created_via: raw.created_via || 'tell'
      }
    });
  }

  function appendToVoiceEntry(nodeId, text, meta) {
    var bodyText = String(text || '').trim();
    if (!nodeId || !bodyText) return null;
    var updated = null;
    touchProjectMemory(function(project) {
      var node = (project.nodes || []).find(function(entry) {
        return entry.node_id === nodeId && entry.type === 'voice-entry' && entry.status !== 'archived';
      });
      if (!node) return;
      var currentBody = String(node.body || '').trim();
      node.body = currentBody ? (currentBody + '\n' + bodyText) : bodyText;
      node.title = String(node.title || bodyText.slice(0, 42) || 'voice note').slice(0, 42);
      node.updated_at = new Date().toISOString();
      node.meta = { ...(node.meta || {}), ...(meta || {}), appended_at: new Date().toISOString() };
      updated = node;
    });
    return updated;
  }

  function annotateCapture(entryId, nodeId, text) {
    var bodyText = String(text || '').trim();
    if (!entryId && !nodeId) return null;
    var updated = null;
    touchProjectMemory(function(project) {
      var capture = (project.captures || []).find(function(entry) {
        return entry && (entry.entry_id === entryId || entry.id === entryId || entry.node_id === nodeId);
      }) || null;
      var node = (project.nodes || []).find(function(entry) {
        return entry && (entry.node_id === nodeId || entry.capture_image === entryId || entry.meta?.bundle_id === entryId);
      }) || null;
      if (capture) {
        capture.voice_annotation = bodyText || capture.voice_annotation || '';
        capture.prompt_text = bodyText || capture.prompt_text || '';
        capture.summary = bodyText ? compact(bodyText, 72) : capture.summary;
        capture.meta = {
          ...(capture.meta || {}),
          voiceAnnotation: capture.voice_annotation || '',
          annotation_updated_at: new Date().toISOString(),
          annotation_window_until: 0
        };
      }
      if (node) {
        node.voice_annotation = bodyText || node.voice_annotation || '';
        node.body = bodyText || node.body || '';
        node.title = bodyText ? compact(bodyText, 42) : (node.title || 'visual capture');
        node.meta = {
          ...(node.meta || {}),
          annotation_updated_at: new Date().toISOString(),
          annotation_window_until: 0
        };
      }
      updated = {
        entryId: entryId || capture?.entry_id || capture?.id || '',
        nodeId: nodeId || node?.node_id || capture?.node_id || '',
        text: bodyText
      };
    });
    if (updated) {
      traceEvent('capture.annotation', bodyText ? 'pending' : 'idle', bodyText ? 'captured' : 'cleared', {
        entryId: updated.entryId,
        nodeId: updated.nodeId,
        length: bodyText.length
      });
      emitModelChange({ scope: 'item', itemId: updated.nodeId || updated.entryId });
    }
    return updated;
  }

  function cloneThread(thread) {
    return Array.isArray(thread) ? thread.map(function(entry) {
      return {
        id: entry.id || contracts.makeEntryId('thread'),
        kind: entry.kind || 'comment',
        body: String(entry.body || '').trim(),
        summary: String(entry.summary || entry.body || '').trim(),
        at: entry.at || new Date().toISOString(),
        origin: entry.origin || 'ptt',
        claim_ids: Array.isArray(entry.claim_ids) ? entry.claim_ids.filter(Boolean) : [],
        clarifies: entry.clarifies || '',
        contradicts: entry.contradicts || ''
      };
    }) : [];
  }

  function countDistinctThreadClaims(thread) {
    var seen = new Set();
    cloneThread(thread).forEach(function(entry) {
      (entry.claim_ids || []).forEach(function(claimId) {
        if (claimId) seen.add(String(claimId));
      });
    });
    return seen.size;
  }

  function appendThreadComment(nodeId, text, kind, origin) {
    var bodyText = String(text || '').trim();
    if (!nodeId || bodyText.length < 3) return null;
    var created = null;
    touchProjectMemory(function(project) {
      var node = (project.nodes || []).find(function(entry) {
        return entry.node_id === nodeId && entry.status !== 'archived';
      });
      if (!node) return;
      node.meta = { ...(node.meta || {}) };
      node.meta.thread = cloneThread(node.meta.thread);
      var comment = {
        id: contracts.makeEntryId('thread'),
        kind: kind || 'comment',
        body: bodyText,
        summary: compact(bodyText, 72),
        at: new Date().toISOString(),
        origin: origin || 'ptt',
        claim_ids: [],
        clarifies: '',
        contradicts: ''
      };
      node.meta.thread.push(comment);
      node.meta.thread_summary = compact(bodyText, 72);
      node.meta.thread_updated_at = comment.at;
      created = {
        nodeId: node.node_id,
        comment: { ...comment },
        depth: countDistinctThreadClaims(node.meta.thread)
      };
    });
    if (created) {
      traceEvent('thread', 'append-request', 'comment-added', {
        nodeId: created.nodeId,
        commentId: created.comment.id,
        depth: created.depth,
        kind: created.comment.kind,
        origin: created.comment.origin
      });
      emitModelChange({ scope: 'item', itemId: created.nodeId, commentId: created.comment.id });
    }
    return created;
  }

  function findClaimById(project, claimId) {
    ensureProjectKnowledge(project);
    return (project.claims || []).find(function(entry) {
      return entry && entry.id === claimId;
    }) || null;
  }

  function findClaimByReference(project, value) {
    ensureProjectKnowledge(project);
    var ref = String(value || '').trim();
    if (!ref) return null;
    var byId = findClaimById(project, ref);
    if (byId) return byId;
    var normalized = compact(ref, 160).toLowerCase();
    var exact = (project.claims || []).find(function(entry) {
      return entry && compact(entry.text || '', 160).toLowerCase() === normalized;
    }) || null;
    if (exact) return exact;
    var normalizedTokens = normalized.split(/\s+/).filter(Boolean);
    return (project.claims || []).find(function(entry) {
      if (!entry) return false;
      var text = compact(entry.text || '', 160).toLowerCase();
      if (!text) return false;
      if (text.indexOf(normalized) !== -1 || normalized.indexOf(text) !== -1) return true;
      if (normalizedTokens.length < 3) return false;
      var overlap = normalizedTokens.filter(function(token) {
        return token.length > 3 && text.indexOf(token) !== -1;
      });
      return overlap.length >= Math.min(3, normalizedTokens.length);
    }) || null;
  }

  function buildReconciliationQuestionBody(previousText, nextText) {
    var prior = compact(previousText || 'that earlier claim', 52).replace(/[.?!]+$/g, '');
    var next = compact(nextText || 'this newer claim', 52).replace(/[.?!]+$/g, '');
    return ('you said ' + prior + ' earlier, now ' + next + ' — which holds?').toLowerCase();
  }

  function ensureReconciliationQuestion(project, contradictedClaim, newClaim, nodeId, commentId) {
    if (!contradictedClaim || !newClaim) return null;
    var evidenceClaims = [contradictedClaim.id, newClaim.id].filter(Boolean);
    var existing = (project.nodes || []).find(function(node) {
      if (!node || node.type !== 'question' || node.status === 'archived') return false;
      var refs = Array.isArray(node.meta?.evidence_claims) ? node.meta.evidence_claims : [];
      return evidenceClaims.every(function(claimId) { return refs.indexOf(claimId) !== -1; });
    });
    if (existing) return existing;
    var question = contracts.createNode({
      type: 'question',
      status: 'open',
      title: 'reconciliation',
      body: buildReconciliationQuestionBody(contradictedClaim.text, newClaim.text),
      source: 'comment',
      links: nodeId ? [nodeId] : [],
      meta: {
        contradiction: true,
        contradiction_thread_entry_id: commentId || '',
        evidence_claims: evidenceClaims
      }
    });
    project.nodes.unshift(question);
    if (project.nodes.length > MAX_NODES) {
      project.nodes = project.nodes.slice(0, MAX_NODES);
    }
    return question;
  }

  function applyThreadExtraction(nodeId, commentId, extraction, options) {
    if (!nodeId || !commentId || !extraction || typeof extraction !== 'object') return null;
    var opts = options && typeof options === 'object' ? options : {};
    var updated = null;
    touchProjectMemory(function(project) {
      ensureProjectKnowledge(project);
      var node = (project.nodes || []).find(function(entry) {
        return entry.node_id === nodeId && entry.status !== 'archived';
      });
      if (!node || !node.meta) return;
      node.meta.thread = cloneThread(node.meta.thread);
      var comment = node.meta.thread.find(function(entry) { return entry.id === commentId; });
      if (!comment) return;

      var extractionClaims = Array.isArray(extraction.claims) ? extraction.claims.slice() : [];
      if (!extractionClaims.length && extraction.contradicts) {
        var fallbackText = String(extraction.summary || comment.summary || comment.body || '').trim();
        if (fallbackText) {
          extractionClaims = [{
            text: fallbackText,
            kind: comment.kind === 'clarification' ? 'fact' : 'preference',
            source: 'comment',
            sourceRef: {
              itemId: nodeId,
              threadEntryId: commentId
            }
          }];
        }
      }

      var storedClaims = addClaimsToProject(project, extractionClaims, {
        source: 'comment',
        sourceRef: {
          itemId: nodeId,
          threadEntryId: commentId
        },
        sttConfidence: typeof opts.sttConfidence === 'number' ? opts.sttConfidence : null
      });
      var storedClaimIds = storedClaims.map(function(entry) { return entry.id; });

      if (typeof extraction.summary === 'string' && extraction.summary.trim()) {
        comment.summary = compact(extraction.summary, 72);
      }
      if (storedClaimIds.length) {
        comment.claim_ids = storedClaimIds.slice();
      } else if (!Array.isArray(comment.claim_ids)) {
        comment.claim_ids = [];
      }
      if (typeof extraction.clarifies === 'string') {
        comment.clarifies = extraction.clarifies.trim();
      }
      if (typeof extraction.contradicts === 'string') {
        comment.contradicts = extraction.contradicts.trim();
      }

      node.meta.thread_summary = comment.summary || node.meta.thread_summary || compact(comment.body, 72);
      node.meta.thread_updated_at = comment.at || new Date().toISOString();
      node.meta.thread_claim_ids = Array.from(new Set(node.meta.thread.reduce(function(all, entry) {
        if (Array.isArray(entry.claim_ids)) {
          return all.concat(entry.claim_ids.filter(Boolean));
        }
        return all;
      }, [])));

      var clarifiedClaim = comment.clarifies ? findClaimByReference(project, comment.clarifies) : null;
      if (clarifiedClaim && storedClaimIds.length) {
        clarifiedClaim.clarifications = Array.isArray(clarifiedClaim.clarifications) ? clarifiedClaim.clarifications : [];
        storedClaimIds.forEach(function(claimId) {
          if (clarifiedClaim.clarifications.indexOf(claimId) === -1) {
            clarifiedClaim.clarifications.push(claimId);
          }
        });
      }

      var contradictedClaim = comment.contradicts ? findClaimByReference(project, comment.contradicts) : null;
      if (!contradictedClaim && comment.contradicts) {
        contradictedClaim = (project.claims || []).find(function(entry) {
          if (!entry || !entry.id) return false;
          if (storedClaimIds.indexOf(entry.id) !== -1) return false;
          var sourceItemId = String(entry.sourceRef?.itemId || '');
          return sourceItemId && sourceItemId === String(nodeId || '');
        }) || null;
      }
      var reconciliationQuestion = null;
      var claimStatusUpdate = null;
      if (contradictedClaim && storedClaims.length) {
        claimStatusUpdate = setClaimStatusOnProject(project, contradictedClaim.id, 'disputed', {
          reason: 'comment-contradiction'
        });
        contradictedClaim = findClaimByReference(project, contradictedClaim.id) || contradictedClaim;
        contradictedClaim.disputedBy = Array.isArray(contradictedClaim.disputedBy) ? contradictedClaim.disputedBy : [];
        storedClaimIds.forEach(function(claimId) {
          if (contradictedClaim.disputedBy.indexOf(claimId) === -1) {
            contradictedClaim.disputedBy.push(claimId);
          }
        });
        reconciliationQuestion = ensureReconciliationQuestion(project, contradictedClaim, storedClaims[0], nodeId, commentId);
      }

      rebuildClaimIndex(project);
      updated = {
        nodeId: node.node_id,
        comment: { ...comment },
        claims: storedClaims.map(function(entry) { return JSON.parse(JSON.stringify(entry)); }),
        clarificationId: clarifiedClaim?.id || '',
        contradictionId: contradictedClaim?.id || '',
        reconciliationQuestionId: reconciliationQuestion?.node_id || '',
        claimStatusUpdate: claimStatusUpdate,
        depth: countDistinctThreadClaims(node.meta.thread)
      };
    });
    if (updated) {
      if (updated.claims.length) {
        traceEvent('claim', 'pending', 'stored', {
          count: updated.claims.length,
          ids: updated.claims.map(function(entry) { return entry.id; }).slice(0, 6),
          source: 'comment'
        });
      }
      traceEvent('thread', 'refine-pending', 'extracted', {
        nodeId: updated.nodeId,
        commentId: updated.comment.id,
        claimCount: updated.claims.length,
        clarifies: updated.clarificationId,
        contradicts: updated.contradictionId,
        questionId: updated.reconciliationQuestionId
      });
      if (updated.contradictionId) {
        traceEvent('claim', updated.claimStatusUpdate?.previousStatus || 'active', updated.claimStatusUpdate?.status || 'disputed', {
          claimId: updated.contradictionId,
          commentId: updated.comment.id,
          questionId: updated.reconciliationQuestionId,
          reason: updated.claimStatusUpdate?.reason || 'comment-contradiction'
        });
      }
      emitModelChange({ scope: updated.reconciliationQuestionId ? 'now' : 'item', itemId: updated.nodeId, commentId: updated.comment.id });
    }
    return updated;
  }

  function setThreadCommentSummary(nodeId, commentId, summary) {
    var value = String(summary || '').trim();
    if (!value) return null;
    return applyThreadExtraction(nodeId, commentId, { summary: value, claims: [] });
  }

  function getNodeThread(nodeId) {
    var node = (memory.projectMemory?.nodes || []).find(function(entry) {
      return entry.node_id === nodeId;
    });
    return cloneThread(node?.meta?.thread);
  }

  function findAnswerNode(project, answerId) {
    ensureProjectKnowledge(project);
    return (project.answers || []).find(function(entry) {
      return entry && entry.id === answerId;
    }) || null;
  }

  function addAnswerNode(questionId, body, options) {
    var answerText = String(body || '').trim();
    if (!questionId || answerText.length < 3) return null;
    var opts = options && typeof options === 'object' ? options : {};
    var created = null;
    touchProjectMemory(function(project) {
      ensureProjectKnowledge(project);
      created = contracts.createAnswerNode({
        id: opts.id || contracts.makeEntryId('answer'),
        questionId: questionId,
        body: answerText,
        claims: Array.isArray(opts.claims) ? opts.claims.filter(Boolean) : [],
        sttConfidence: typeof opts.sttConfidence === 'number' ? opts.sttConfidence : null,
        at: opts.at || new Date().toISOString()
      });
      project.answers.unshift(created);
      if (project.answers.length > MAX_ANSWERS) {
        project.answers = project.answers.slice(0, MAX_ANSWERS);
      }
      var questionNode = (project.nodes || []).find(function(entry) {
        return entry.node_id === questionId;
      });
      if (questionNode) {
        questionNode.meta = { ...(questionNode.meta || {}), answer_node_id: created.id, answered_at: created.at };
      }
    });
    if (created) {
      traceEvent('answer', 'captured', 'stored', {
        questionId: questionId,
        answerId: created.id
      });
    }
    return created;
  }

  function enrichAnswerNode(answerId, patch) {
    if (!answerId || !patch || typeof patch !== 'object') return null;
    var updated = null;
    touchProjectMemory(function(project) {
      ensureProjectKnowledge(project);
      var answerNode = findAnswerNode(project, answerId);
      if (!answerNode) return;
      if (typeof patch.body === 'string' && patch.body.trim()) answerNode.body = patch.body.trim().toLowerCase();
      if (Array.isArray(patch.claims)) answerNode.claims = patch.claims.filter(Boolean);
      if (typeof patch.sttConfidence === 'number') answerNode.sttConfidence = patch.sttConfidence;
      if (patch.at) answerNode.at = patch.at;
      updated = JSON.parse(JSON.stringify(answerNode));
    });
    if (updated) {
      traceEvent('answer', 'stored', 'enriched', {
        answerId: updated.id,
        claimCount: (updated.claims || []).length
      });
    }
    return updated;
  }

  function ingestClaims(rawClaims, options) {
    var added = [];
    touchProjectMemory(function(project) {
      added = addClaimsToProject(project, rawClaims, options);
    });
    if (added.length) {
      traceEvent('claim', 'pending', 'stored', {
        count: added.length,
        ids: added.map(function(entry) { return entry.id; }).slice(0, 6),
        source: lower(options?.source || rawClaims?.[0]?.source || 'unknown')
      });
    }
    return JSON.parse(JSON.stringify(added));
  }

  function getClaimsForItem(itemId) {
    ensureProjectRegistry();
    var ids = memory.projectMemory?.claimIndex?.byItem?.[itemId] || [];
    return (memory.projectMemory?.claims || []).filter(function(claim) {
      return ids.indexOf(claim.id) !== -1;
    }).map(function(claim) { return JSON.parse(JSON.stringify(claim)); });
  }

  function resolveNode(nodeId, resolution) {
    var node = memory.projectMemory.nodes.find(function(n) { return n.node_id === nodeId; });
    if (!node) return null;
    traceEvent('node', node.status || 'open', 'resolving', {
      nodeId: nodeId,
      type: node.type,
      resolution: resolution || {}
    });
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
    emitModelChange({ scope: node.type === 'question' || node.type === 'decision' ? 'now' : 'item', itemId: node.node_id });
    traceEvent('node', 'resolving', 'resolved', {
      nodeId: nodeId,
      type: node.type
    });
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
    ensureProjectKnowledge(pm);
    var nodes = pm.nodes;

    pm.backlog = nodes.filter(function(n) { return n.type === 'task' && n.status === 'open'; })
      .map(function(n) {
        var thread = cloneThread(n.meta?.thread);
        return {
          title: n.title,
          body: n.body,
          created_at: n.created_at,
          state: 'open',
          node_id: n.node_id,
          links: Array.isArray(n.links) ? n.links.slice() : [],
          thread: thread,
          thread_depth: countDistinctThreadClaims(thread),
          thread_summary: n.meta?.thread_summary || (thread[thread.length - 1]?.summary || '')
        };
      });

    pm.decisions = nodes.filter(function(n) { return n.type === 'decision' && n.status === 'resolved'; })
      .map(function(n) {
        var thread = cloneThread(n.meta?.thread);
        return {
          text: n.title, body: n.body, reason: n.body,
          options: n.decision_options, selected_option: n.selected_option,
          selected_option_index: n.decision_options.indexOf(n.selected_option),
          source: n.source + ' → approved',
          created_at: n.created_at, approved_at: n.resolved_at, node_id: n.node_id,
          links: Array.isArray(n.links) ? n.links.slice() : [],
          thread: thread,
          thread_depth: countDistinctThreadClaims(thread),
          thread_summary: n.meta?.thread_summary || (thread[thread.length - 1]?.summary || '')
        };
      });

    pm.pending_decisions = nodes.filter(function(n) { return n.type === 'decision' && n.status === 'open'; })
      .map(function(n) {
        var thread = cloneThread(n.meta?.thread);
        return {
          text: n.title, options: n.decision_options, source: n.source,
          insight_body: n.body, created_at: n.created_at, node_id: n.node_id,
          links: Array.isArray(n.links) ? n.links.slice() : [],
          thread: thread,
          thread_depth: countDistinctThreadClaims(thread),
          thread_summary: n.meta?.thread_summary || (thread[thread.length - 1]?.summary || '')
        };
      });

    pm.captures = nodes.filter(function(n) { return n.type === 'capture'; })
      .map(function(n) {
        var meta = n.meta || {};
        var thread = cloneThread(meta.thread);
        return {
          id: n.node_id,
          entry_id: meta.bundle_id || n.capture_image || n.node_id,
          type: n.capture_image ? 'image' : 'voice',
          summary: n.body || n.title,
          ai_analysis: n.body,
          created_at: n.created_at,
          captured_at: meta.captured_at || n.created_at,
          node_id: n.node_id,
          capture_image: n.capture_image || meta.bundle_id || '',
          voice_annotation: n.voice_annotation || '',
          prompt_text: n.voice_annotation || '',
          preview_data: meta.preview_data || '',
          image_asset: meta.image_asset || {
            entry_id: meta.image_asset_id || '',
            name: meta.image_asset_name || '',
            data: meta.preview_data || ''
          },
          meta: {
            ...meta,
            analysis_status: meta.analysis_status || '',
            preview_data: meta.preview_data || ''
          },
          links: Array.isArray(n.links) ? n.links.slice() : [],
          thread: thread,
          thread_depth: countDistinctThreadClaims(thread),
          thread_summary: meta.thread_summary || (thread[thread.length - 1]?.summary || '')
        };
      });

    pm.insights = nodes.filter(function(n) { return n.type === 'insight'; })
      .map(function(n) {
        var thread = cloneThread(n.meta?.thread);
        return {
          title: n.title, body: n.body, next: n.next_action,
          confidence: n.confidence, created_at: n.created_at, node_id: n.node_id,
          source: n.source || '',
          triangulated: !!(n.meta && n.meta.triangulated),
          meta: n.meta || {},
          links: Array.isArray(n.links) ? n.links.slice() : [],
          thread: thread,
          thread_depth: countDistinctThreadClaims(thread),
          thread_summary: n.meta?.thread_summary || (thread[thread.length - 1]?.summary || '')
        };
      });

    pm.open_questions = nodes.filter(function(n) { return n.type === 'question' && n.status === 'open'; })
      .map(function(n) { return n.body || n.title; });
    pm.open_question_nodes = nodes.filter(function(n) { return n.type === 'question' && n.status === 'open'; })
      .map(function(n) {
        var thread = cloneThread(n.meta?.thread);
        return {
          node_id: n.node_id,
          title: n.title,
          body: n.body || n.title,
          created_at: n.created_at,
          source: n.source || 'question',
          branch_id: n.meta?.branch_id || 'main',
          meta: cloneValue(n.meta || {}),
          links: Array.isArray(n.links) ? n.links.slice() : [],
          thread: thread,
          thread_depth: countDistinctThreadClaims(thread),
          thread_summary: n.meta?.thread_summary || (thread[thread.length - 1]?.summary || '')
        };
      });

    pm.clarity_score = computeClarityScore();

    pm.structure = [
      { title: 'captures', count: pm.captures.length },
      { title: 'insights', count: pm.insights.length },
      { title: 'decisions', count: pm.decisions.length },
      { title: 'open items', count: pm.backlog.length }
    ];
    rebuildClaimIndex(pm);
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
    } catch (_) {}
    return entry;
  }

  let probeListenerAttached = false;
  let probeBridgeWrapped = false;

  function startProbeIfNeeded() {
    if (!probeMode || probeListenerAttached) return;
    probeListenerAttached = true;
    memory.probeEvents = [];
    memory.logs = memory.logs.filter(function(entry) { return entry.kind !== 'probe'; });

    appendProbeEvent({ source: 'probe', name: 'started' });
    appendProbeEvent({ source: 'probe', name: 'mode active' });
    const eventLabels = {
      sideClick: 'ptt click',
      scrollUp: 'scroll down',
      scrollDown: 'scroll up',
      longPressStart: 'ptt hold',
      longPressEnd: 'ptt release',
      backbutton: 'back',
      popstate: 'back'
    };

    [
      'sideClick',
      'scrollUp',
      'scrollDown',
      'longPressStart',
      'longPressEnd',
      'backbutton',
      'popstate'
    ].forEach(function(eventName) {
      window.addEventListener(eventName, function() {
        appendProbeEvent({ source: 'window', name: eventLabels[eventName] || eventName });
      });
    });

    if (!probeBridgeWrapped && window.PluginMessageHandler && typeof window.PluginMessageHandler.postMessage === 'function') {
      probeBridgeWrapped = true;
      const originalPostMessage = window.PluginMessageHandler.postMessage.bind(window.PluginMessageHandler);
      window.PluginMessageHandler.postMessage = function(payload) {
        var summary = 'llm request';
        try {
          var parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
          var text = parsed?.message || parsed?.intent || parsed?.goal || '';
          if (parsed?.useSerpAPI) summary = 'serp request';
          else if (parsed?.imageBase64) summary = 'image request';
          else if (!text) summary = 'bridge request';
        } catch (_) {}
        appendProbeEvent({ source: 'bridge-out', name: summary });
        return originalPostMessage(payload);
      };
    }
  }

  function persist() {
    if (uiStatePersistTimer) {
      clearTimeout(uiStatePersistTimer);
      uiStatePersistTimer = null;
    }
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
    flushPendingUIStatePersist();
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
    ensureProjectKnowledge(memory.projectMemory);
    mutator(memory.projectMemory);
    rebuildClaimIndex(memory.projectMemory);
    repairEvidenceIntegrity(memory.projectMemory, { silent: false });
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

  function activeProjectCount() {
    ensureProjectRegistry();
    return memory.projects.filter(function(project) {
      return project && project.status !== 'archived';
    }).length;
  }

  function createProject(name, type) {
    var options = arguments[2];
    ensureProjectRegistry();
    var opts = options && typeof options === 'object' ? options : {};
    var rawName = String((name || '').trim() || 'Untitled Project');
    var normalizedName = lower(rawName);
    if (normalizedName === '' || normalizedName === 'untitled project' || normalizedName === 'project') {
      return syncActiveProjectAlias();
    }
    if (normalizedName === DIAGNOSTIC_PROJECT_NAME && !opts.internal) {
      return { ok: false, error: 'reserved project name' };
    }
    if (!opts.bypassCap && activeProjectCount() >= 3) {
      updateUIState({
        project_cap_notice: 'three projects active — archive one to start another',
        last_surface: 'home'
      });
      return { ok: false, error: 'project cap reached' };
    }
    var allowDuplicate = !!opts.allowDuplicate;
    var existing = allowDuplicate ? null : memory.projects.find(function(project) { return lower(project.name) === normalizedName; });
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
    updateUIState({
      user_status: 'project created',
      last_event_summary: 'project created',
      last_surface: 'home',
      project_cap_notice: ''
    });
    persist();
    if (!opts.silentMilestone) {
      window.StructaLLM?.speakMilestone?.('project_live');
    }
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
    memory.uiState.user_status = 'project opened';
    memory.uiState.last_event_summary = 'project opened';
    memory.uiState.last_surface = 'home';
    memory.uiState.project_cap_notice = '';
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
    memory.uiState.user_status = 'project archived';
    memory.uiState.last_event_summary = 'project archived';
    memory.uiState.project_cap_notice = '';
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
    memory.uiState.user_status = 'project deleted';
    memory.uiState.last_event_summary = 'project deleted';
    memory.uiState.project_cap_notice = '';
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return { ok: true, project_id: project.project_id };
  }

  function stopPrimedStream() {
    try {
      var stream = window.__STRUCTA_PRIMED_STREAM__;
      if (stream?.getTracks) {
        stream.getTracks().forEach(function(track) {
          try { track.stop(); } catch (_) {}
        });
      }
      window.__STRUCTA_PRIMED_STREAM__ = null;
    } catch (_) {}
  }

  function resetRuntimeTransientState() {
    stopPrimedStream();
    delete window.__STRUCTA_DIAGNOSTICS_RUNNING__;
    delete window.__STRUCTA_FORCE_SILENT__;
    window.__STRUCTA_PTT_TARGET__ = null;
    window.__STRUCTA_INLINE_PTT__ = false;
    if (window.StructaDiagnostics?.resetLocalState) {
      try { window.StructaDiagnostics.resetLocalState(); } catch (_) {}
    }
  }

  function resetUIStateToBaseline(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var baseline = buildInitialUIState();
    baseline.flush_undo_available_until = Math.max(0, Number(opts.flushUndoUntil || 0));
    memory.uiState = baseline;
    return baseline;
  }

  function clearLocalCacheArtifacts() {
    try {
      var storageRef = window.localStorage;
      if (storageRef) {
        var keysToRemove = [];
        for (var index = 0; index < storageRef.length; index += 1) {
          var key = storageRef.key(index);
          if (!key) continue;
          if (key === 'structa.queue.v1' || key === 'structa-probe') {
            keysToRemove.push(key);
            continue;
          }
          if (key.indexOf('structa-native-cache-v2:') === 0) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(function(key) {
          try { storageRef.removeItem(key); } catch (_) {}
        });
      }
    } catch (_) {}
  }

  function resetQueueToEmpty() {
    if (!window.StructaProcessingQueue?.restore) return;
    try {
      window.StructaProcessingQueue.restore([], { paused: true });
    } catch (_) {}
  }

  function flushMemory() {
    var secureSnapshot = null;
    var snapshotSave = Promise.resolve(false);
    var queueWasPaused = !!window.StructaProcessingQueue?.isPaused?.();
    try {
      flushPendingUIStatePersist();
      secureSnapshot = snapshotState();
      snapshotSave = storage.secure.write('structa.snapshot.last', secureSnapshot).then(function(result) {
        return !!result?.ok;
      });
    } catch (_) {}
    traceEvent('flush.runtime.stop', 'running', 'started', {
      projectId: memory.active_project_id
    });
    if (window.StructaImpactChain?.pause) {
      try { window.StructaImpactChain.pause('memory flush'); } catch (_) {}
    }
    if (window.StructaProcessingQueue?.pause) {
      try { window.StructaProcessingQueue.pause(); } catch (_) {}
    }
    resetRuntimeTransientState();
    const fresh = buildInitialMemory();
    Object.keys(memory).forEach(function(key) { delete memory[key]; });
    Object.assign(memory, fresh);
    runtimeEvents.splice(0, runtimeEvents.length);
    resetUIStateToBaseline();
    syncActiveProjectAlias();
    rebuildLegacyViews();
    if (window.StructaLLM?.resetHistory) {
      try { window.StructaLLM.resetHistory(); } catch (_) {}
    }
    memory.triangleSlot = null;
    resetQueueToEmpty();
    clearLocalCacheArtifacts();
    traceEvent('flush.cache.clear', 'pending', 'completed', {
      projectId: memory.active_project_id
    });

    if (window.StructaUIRuntime?.fullReset) {
      try {
        window.StructaUIRuntime.fullReset({ reason: 'flush', preserveUndo: false });
      } catch (_) {}
    }

    var clearTasks = [
      window.StructaStorage?.clear
        ? window.StructaStorage.clear().catch(function() { return []; })
        : Promise.resolve([]),
      storage.plain.remove('structa.queue.v1').catch(function() { return { ok: false }; }),
      storage.plain.remove('structa-probe').catch(function() { return { ok: false }; }),
      storage.plain.remove('structa.diagnostics.reports').catch(function() { return { ok: false }; })
    ];

    return Promise.all(clearTasks.concat([snapshotSave])).then(function(results) {
      var cleared = results[0];
      var snapshotSaved = !!results[results.length - 1];
      resetUIStateToBaseline({
        flushUndoUntil: snapshotSaved ? (Date.now() + 120000) : 0
      });
      if (window.StructaUIRuntime?.fullReset) {
        try {
          window.StructaUIRuntime.fullReset({
            reason: 'flush',
            preserveUndo: snapshotSaved
          });
        } catch (_) {}
      }
      persist();
      appendLogEntry({ kind: 'system', message: 'flush complete · local state cleared' });
      appendLogEntry({ kind: 'system', message: 'ui reset complete' });
      traceEvent('flush.ui.reset', 'pending', 'completed', {
        projectId: memory.active_project_id,
        undoAvailable: snapshotSaved
      });
      traceEvent('flush', 'running', 'completed', {
        projectId: memory.active_project_id,
        snapshotSaved: snapshotSaved
      });
      traceEvent('flush.runtime.ready', 'resetting', 'idle', {
        projectId: memory.active_project_id,
        queuePaused: queueWasPaused
      });
      traceEvent('system', 'flush', 'complete', {
        projectId: memory.active_project_id,
        cleared: Array.isArray(cleared) ? cleared.length : 0
      });
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      emitModelChange({ scope: 'all' });
      if (window.StructaProcessingQueue?.resume) {
        try { window.StructaProcessingQueue.resume(); } catch (_) {}
      }
      return { ok: true, cleared: cleared, project_id: memory.active_project_id, snapshot_saved: snapshotSaved };
    });
  }

  function restoreLastFlushSnapshot() {
    if (!window.creationStorage?.secure?.getItem) {
      return Promise.resolve({ ok: false, error: 'secure storage unavailable' });
    }
    return storage.secure.read('structa.snapshot.last').then(function(result) {
      if (!result?.ok) return { ok: false, error: result?.error || 'snapshot unavailable' };
      var snapshot = result.value;
      if (!snapshot) return { ok: false, error: 'no snapshot' };
      var restored = snapshot?.memory || snapshot;
      if (!restored || typeof restored !== 'object') {
        return { ok: false, error: 'invalid snapshot' };
      }
      Object.keys(memory).forEach(function(key) { delete memory[key]; });
      Object.assign(memory, cloneValue(restored));
      ensureProjectRegistry();
      syncActiveProjectAlias();
      rebuildLegacyViews();
      ensureTraceStore();
      var queueItems = snapshot?.queueState?.items || snapshot?.queue || [];
      var queuePaused = !!snapshot?.queueState?.paused;
      memory.uiState = {
        ...buildInitialUIState(),
        ...(memory.uiState || {}),
        flush_undo_available_until: 0
      };
      resetRuntimeTransientState();
      if (window.StructaProcessingQueue?.restore) {
        try {
          window.StructaProcessingQueue.restore(queueItems, { paused: queuePaused });
        } catch (_) {
          resetQueueToEmpty();
        }
      }
      if (window.StructaUIRuntime?.fullReset) {
        try {
          window.StructaUIRuntime.fullReset({ reason: 'flush-undo', preserveUndo: false });
        } catch (_) {}
      }
      persist();
      traceEvent('flush', 'undo', 'restored', {
        projectId: memory.active_project_id
      });
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      emitModelChange({ scope: 'all' });
      return { ok: true, project_id: memory.active_project_id };
    });
  }

  function restoreSnapshot(snapshot, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var parsed = snapshot?.memory || snapshot;
    if (!parsed || typeof parsed !== 'object') {
      return Promise.resolve({ ok: false, error: 'invalid snapshot' });
    }
    var currentTrace = ensureTraceStore().events.slice();
    var currentVoiceCalls = cloneValue(ensureTraceStore().voiceCalls);
    var restored = cloneValue(parsed);
    var queueItems = snapshot?.queueState?.items || snapshot?.queue || [];
    var queuePaused = !!snapshot?.queueState?.paused;
    if (opts.preserveCurrentTrace) {
      var restoredTrace = restored.__trace && typeof restored.__trace === 'object' ? restored.__trace : {};
      restoredTrace.events = Array.isArray(restoredTrace.events) ? restoredTrace.events.slice() : [];
      var traceToAppend = Array.isArray(opts.appendTraceEvents)
        ? opts.appendTraceEvents
        : currentTrace;
      traceToAppend.forEach(function(entry) {
        restoredTrace.events.push(entry);
      });
      if (restoredTrace.events.length > MAX_TRACE_ITEMS) {
        restoredTrace.events.splice(0, restoredTrace.events.length - MAX_TRACE_ITEMS);
      }
      restoredTrace.voiceCalls = opts.preserveCurrentVoiceCalls
        ? currentVoiceCalls
        : (restoredTrace.voiceCalls || currentVoiceCalls);
      restored.__trace = restoredTrace;
    }
    Object.keys(memory).forEach(function(key) { delete memory[key]; });
    Object.assign(memory, restored);
    ensureProjectRegistry();
    syncActiveProjectAlias();
    rebuildLegacyViews();
    ensureTraceStore();
    if (window.StructaProcessingQueue?.restore) {
      try {
        window.StructaProcessingQueue.restore(queueItems, { paused: queuePaused });
      } catch (_) {}
    }
    persist();
    traceEvent('system', 'snapshot', 'restored', {
      queueItems: Array.isArray(queueItems) ? queueItems.length : 0,
      preservedTrace: !!opts.preserveCurrentTrace
    });
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    emitModelChange({ scope: 'all' });
    return Promise.resolve({ ok: true, project_id: memory.active_project_id });
  }

  function updateUIState(patch = {}, options = {}) {
    var current = memory.uiState || {};
    var keys = Object.keys(patch || {});
    var changed = keys.some(function(key) {
      return current[key] !== patch[key];
    });
    if (!changed) return { ...current };
    memory.uiState = { ...current, ...patch };
    scheduleUIStatePersist(!!options.immediate);
    window.dispatchEvent(new CustomEvent('structa-ui-state-updated', {
      detail: { patch: { ...patch } }
    }));
    return { ...memory.uiState };
  }

  function getUIState() {
    return { ...(memory.uiState || {}) };
  }

  function getTriangleSlot() {
    return memory.triangleSlot ? JSON.parse(JSON.stringify(memory.triangleSlot)) : null;
  }

  function setTriangleSlot(slot) {
    memory.triangleSlot = slot ? JSON.parse(JSON.stringify(slot)) : null;
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return getTriangleSlot();
  }

  function clearTriangleSlot() {
    memory.triangleSlot = null;
    persist();
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return null;
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
    function compact(text = '', maxWords = 7) {
      const words = String(text || '').split(/\s+/).filter(Boolean);
      if (words.length <= maxWords) return words.join(' ');
      return words.slice(0, maxWords).join(' ') + '…';
    }

    if (raw.startsWith('stt:')) return null;
    if (raw.startsWith('beat ')) return null;
    if (raw.includes('started at') && k === 'heartbeat') return null;
    if (raw.includes('paused —') && k === 'heartbeat') return null;
    if (raw.includes('chain started')) return null;
    if (raw.includes('chain paused')) return null;
    if (raw.includes('chain resumed')) return null;
    if (raw.includes('chain speed:')) return null;
    if (raw.includes('visual analysis queued')) return null;
    if (raw.includes('visual analysis timed out')) return null;
    if (raw.includes('lesson 0 complete') || raw.includes('lesson 1 complete') || raw.includes('lesson 2 complete') || raw.includes('lesson 3 complete')) return null;
    if (raw === 'camera opened' || raw.endsWith('camera open')) return null;
    if (raw === 'capture capture') return null;
    if (raw === 'camera image captured' || raw === 'image captured') return 'frame captured';
    if (raw === 'show+tell captured' || raw === 'show+tell saved') return 'show+tell saved';
    if (raw === 'image saved') return 'frame saved';
    if (raw === 'voice saved') return null;
    if (raw === 'question answered') return null;
    if (raw === 'insight extracted') return 'signal ready';
    if (raw === 'insight unavailable' || raw === 'insight failed') return null;
    if (raw === 'visual insight ready' || raw === 'show+tell insight ready' || raw === 'visual result ready' || raw === 'show+tell result ready') return 'visual note ready';
    if (raw === 'visual insight unavailable' || raw === 'visual insight failed') return 'visual note unavailable';
    if (raw.startsWith('bridge-in onpluginmessage')) return null;
    if (raw.startsWith('bridge-in response')) return null;
    if (raw.startsWith('bridge-in response received')) return null;
    if (raw.startsWith('bridge-out pluginmessagehandler.postmessage')) return null;
    if (raw.startsWith('answering:')) return null;
    if (raw.startsWith('answered:')) return null;
    if (raw.startsWith('saved 33 logs')) return 'log export saved';
    if (raw.startsWith('could not save logs')) return 'log export unavailable';
    if (raw.startsWith('decision created:')) return 'decision ready';
    if (raw === 'decision skipped' || raw === 'decision decision skipped') return 'decision skipped';
    if (raw === 'decision decision approved') return 'decision approved';
    if (raw.startsWith('suggestion:')) return null;
    if (raw.startsWith('triangle copy')) return null;
    if (raw.startsWith('triangle dismiss')) return null;
    if (raw.startsWith('triangle complete')) return null;
    if (raw.startsWith('triangle slot cleared')) return null;
    if (raw.startsWith('triangle signal:')) return compact(raw.replace(/^triangle signal:\s*/i, 'triangle signal: '), 8);
    if (raw.startsWith('naming project')) return null;
    if (raw.includes('inspect camera') || raw.includes('environment facing')) return null;
    if (raw.includes('r1 msg:') || raw === 'llm: thinking...' || raw === 'r1 stt: start') return null;
    if (raw.includes('heartbeat started') || raw.includes('heartbeat stopped')) return null;
    if (raw.includes('window ') || raw.includes('document ')) return null;
    if (raw.includes('ptt click') || raw.includes('ptt hold') || raw.includes('longpress')) return null;

    if (k === 'heartbeat') return null;
    if (k === 'chain' && raw.startsWith('observe:')) return null;
    if (k === 'chain' && raw.startsWith('research:')) return null;
    if (k === 'chain' && raw.startsWith('clarify:')) return null;
    if (k === 'chain' && raw.startsWith('evaluate:')) return null;
    if (k === 'chain' && raw.startsWith('decision:')) return 'decision ready';
    if (k === 'chain' && raw.startsWith('structa asks:')) return compact(raw.replace(/^structa asks:/i, 'blocker:'), 8);

    if (k === 'system') {
      if (raw === 'onboarding complete') return 'onboarding complete';
      if (raw === 'flush complete · local state cleared') return raw;
      if (raw === 'ui reset complete') return raw;
      return null;
    }

    if (k === 'diagnostic') {
      return compact(raw, 10);
    }

    if (k === 'triangle') return null;
    if (k === 'voice') {
      if (raw.startsWith('project:')) return compact(raw, 6);
      if (raw.startsWith('project not found:')) return compact(raw, 6);
      if (raw === 'project archived' || raw === 'project deleted') return raw;
      if (raw.includes('archive unavailable') || raw.includes('delete unavailable')) return compact(raw, 6);
      return null;
    }
    if (k === 'camera') {
      if (
        raw === 'frame captured' ||
        raw === 'show+tell captured' ||
        raw === 'show+tell saved' ||
        raw === 'visual note ready' ||
        raw === 'visual note unavailable' ||
        raw === 'frame capture failed — try again'
      ) return raw;
      return null;
    }
    if (k === 'llm') {
      if (raw === 'signal ready' || raw === 'visual note ready' || raw === 'visual note unavailable') return raw;
      return null;
    }
    if (k === 'decision') return compact(raw, 6);
    if (k === 'export') return compact(raw, 6);

    if (k === 'insight') return compact('insight ' + raw.replace(/^new\s+/i, ''));
    if (k === 'question') return compact(raw);

    return compact(raw
      .replace(/[`*_#{}[\]|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
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
      if (entry.kind === 'diagnostic') {
        memory.uiState.diagnostic_status = entry.visible_message;
        memory.uiState.diagnostic_report_status = entry.visible_message;
      } else if (entry.kind === 'system') {
        memory.uiState.system_status = entry.visible_message;
      } else {
        memory.uiState.user_status = entry.visible_message;
        memory.uiState.last_event_summary = entry.visible_message;
      }
      window.dispatchEvent(new CustomEvent('structa-log-updated', { detail: { entry: entry } }));
    }
    persist();
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

    if (kind === 'probe') return false;
    if (kind === 'diagnostic') return false;

    if (kind === 'ui') return false;

    // Suppress empty/meaningless messages
    if (message === 'event' || message === 'no event') return false;
    if (message.startsWith('r1 msg:')) return false;  // Debug bridge noise
    if (message === 'llm: thinking...') return false;  // LLM noise
    if (message === 'r1 stt: start') return false;     // STT internal
    if (message === 'no creationvoicehandler') return false;
    if (message.startsWith('camera ready') || message === 'camera frame captured') return false;

    if (kind === 'heartbeat') return false;

    return true;
  }

  function getVisibleLogs(limit = 5, options = {}) {
    const includeDiagnostic = options.include_diagnostic === true;
    return memory.logs
      .filter(function(entry) {
        if (includeDiagnostic && lower(entry?.kind || '') === 'diagnostic') return true;
        return isVisibleLogEntry(entry);
      })
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
        voice_annotation: bundle.meta?.voiceAnnotation || '',
        preview_data: bundle.meta?.preview_data || '',
        data: bundle.meta?.preview_data || '',
        created_at: bundle.captured_at || new Date().toISOString(),
        project_id: memory.active_project_id,
        meta: {
          ...(bundle.meta || {}),
          image_asset: bundle.image_asset || null,
          analysis_status: bundle.meta?.analysis_status || 'pending'
        }
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
      wantsR1Response: false,
      wantsJournalEntry: envelope.wantsJournalEntry === true
    };
    if (envelope.wantsR1Response === true) {
      recordVoiceCall('structured-message', false, {
        sourceType: envelope.source_type || '',
        target: envelope.target || ''
      });
    }
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
    if (!payload.meta || payload.meta.silent !== true) {
      appendLogEntry({ kind: 'journal', message: payload.title });
    }
    touchProjectMemory(project => {
      project.open_questions = Array.isArray(project.open_questions) ? project.open_questions : [];
      if (payload.body.includes('?')) project.open_questions.unshift(payload.body);
      project.open_questions = project.open_questions.slice(0, 12);
      if (!project.backlog.length) {
        project.backlog.push({ title: payload.title, created_at: payload.created_at, state: 'open' });
      }
    });
    updateUIState({
      user_status: lower(payload.title),
      last_event_summary: lower(payload.title),
      last_insight_summary: lower(payload.body.slice(0, 80))
    });
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
    appendLogEntry({
      kind: 'camera',
      message: payload.input_type === 'image+voice' ? 'show+tell captured' : 'image captured',
      linked_capture_id: payload.entry_id
    });
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

  function dumpDebugSnapshot(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var stamp = new Date().toISOString();
    var key = 'structa.snapshot.debug.' + stamp;
    var snapshot = snapshotState();
    storage.plain.write(key, snapshot).catch(function() {});
    if (opts.export) {
      var body = JSON.stringify(snapshot, null, 2);
      postPayload({
        message: body,
        useLLM: false,
        wantsJournalEntry: true
      });
    }
    appendLogEntry({ kind: 'export', message: 'snapshot dumped' });
    traceEvent('system', 'snapshot', 'dumped', {
      key: key,
      exported: !!opts.export
    });
    return { ok: true, key: key, snapshot: snapshot };
  }

  function markQuestionSkipped(nodeId, options) {
    if (!nodeId) return null;
    var opts = options && typeof options === 'object' ? options : {};
    var updated = null;
    touchProjectMemory(function(project) {
      var node = (project.nodes || []).find(function(entry) {
        return entry.node_id === nodeId && entry.type === 'question';
      });
      if (!node) return;
      node.meta = { ...(node.meta || {}) };
      var until = new Date(Date.now() + Number(opts.durationMs || 24 * 60 * 60 * 1000)).toISOString();
      node.meta.skipped_until = until;
      node.meta.skip_reason = opts.reason || 'user-dismissed';
      updated = {
        nodeId: node.node_id,
        skippedUntil: until,
        reason: node.meta.skip_reason
      };
    });
    if (updated) {
      traceEvent('question.skip.cooldown', 'open', updated.nodeId, {
        nodeId: updated.nodeId,
        skippedUntil: updated.skippedUntil,
        reason: updated.reason
      });
    }
    return updated;
  }

  function getActiveFocus() {
    ensureProjectRegistry();
    var focus = getActiveFocusOnProject(memory.projectMemory);
    return focus ? cloneValue(focus) : null;
  }

  function activateNextFocus(options) {
    var activated = null;
    var selection = null;
    touchProjectMemory(function(project) {
      ensureProjectChainState(project);
      var existing = getActiveFocusOnProject(project);
      if (existing) {
        activated = cloneValue(existing);
        return;
      }
      selection = selectChainFocusOnProject(project);
      if (!selection) return;
      var focus = startFocusOnProject(project, selection.target, options);
      activated = focus ? cloneValue(focus) : null;
    });
    if (activated && selection) {
      traceEvent('focus.select', 'idle', selection.target.kind, {
        targetKind: selection.target.kind,
        targetId: selection.target.id,
        reason: selection.reason || ''
      });
      traceEvent('focus.start', 'selected', activated.id, {
        focusId: activated.id,
        targetKind: activated.target?.kind || '',
        targetId: activated.target?.id || ''
      });
    } else if (!activated) {
      var project = getProjectMemory();
      traceEvent('chain.idle', 'selection', 'idle', {
        resolvedCount: Array.isArray(project?.chainHistory) ? project.chainHistory.filter(function(entry) { return entry?.outcome === 'resolved'; }).length : 0,
        awaitingCount: (project?.open_question_nodes || []).length
      });
    }
    return activated;
  }

  function updateActiveFocus(patch) {
    var updated = null;
    touchProjectMemory(function(project) {
      updated = updateActiveFocusOnProject(project, patch);
      if (updated) updated = cloneValue(updated);
    });
    return updated;
  }

  function completeActiveFocus(outcome, options) {
    var result = null;
    touchProjectMemory(function(project) {
      var active = getActiveFocusOnProject(project);
      if (!active) return;
      result = endFocusOnProject(project, active.id, outcome, options);
      if (result) result = cloneValue(result);
    });
    if (result) {
      traceEvent('focus.end', result.focus?.id || '', lower(outcome || ''), {
        focusId: result.focus?.id || '',
        outcome: lower(outcome || ''),
        durationMs: result.historyEntry?.durationMs || 0,
        stepCount: result.historyEntry?.stepCount || 0
      });
      emitModelChange({ scope: 'chain', focusId: result.focus?.id || '' });
    }
    return result;
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
    return options.visible_only ? getVisibleLogs(limit, options) : memory.logs.slice(-limit);
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
    var idx = 0;
    var nodeId = '';
    var questionText = '';
    if (typeof index === 'object' && index) {
      idx = typeof index.index === 'number' ? index.index : 0;
      nodeId = String(index.nodeId || '').trim();
      questionText = String(index.text || '').trim();
    } else {
      idx = index || 0;
    }
    // Try node-based resolution
    var questionNodes = memory.projectMemory.nodes.filter(function(n) { return n.type === 'question' && n.status === 'open'; });
    var questionNode = null;
    if (nodeId) {
      questionNode = questionNodes.find(function(node) { return node.node_id === nodeId; }) || null;
    }
    if (!questionNode && questionText) {
      var normalizedText = lower(questionText).trim();
      questionNode = questionNodes.find(function(node) {
        var body = lower(node.body || node.title || '').trim();
        return body === normalizedText || body.indexOf(normalizedText) !== -1 || normalizedText.indexOf(body) !== -1;
      }) || null;
    }
    if (!questionNode && idx < questionNodes.length) {
      questionNode = questionNodes[idx];
    }
    if (questionNode) {
      var createdAnswer = addAnswerNode(questionNode.node_id, answer || '', {
        sttConfidence: typeof index?.sttConfidence === 'number' ? index.sttConfidence : null
      });
      traceEvent('blocker', 'open', 'answer-received', {
        nodeId: questionNode.node_id,
        index: idx,
        text: questionNode.body || questionNode.title || '',
        answer: answer || '',
        answerId: createdAnswer?.id || ''
      });
      resolveNode(questionNode.node_id, { question_answer: answer });
      addVoiceEntry({
        title: 'answered: ' + (questionNode.body || '').slice(0, 30),
        body: 'Q: ' + (questionNode.body || '') + '\nA: ' + (answer || ''),
        source: 'voice-answer',
        entry_mode: 'answer',
        meta: {
          answer_node_id: createdAnswer?.id || '',
          question_node_id: questionNode.node_id
        }
      });
      appendLogEntry({ kind: 'voice', message: 'question answered' });
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'question-resolved' }
      }));
      emitModelChange({ scope: 'now', itemId: questionNode.node_id });
      return {
        project: memory.projectMemory,
        questionNode: JSON.parse(JSON.stringify(questionNode)),
        answerNode: createdAnswer ? JSON.parse(JSON.stringify(createdAnswer)) : null
      };
    }
    // Legacy fallback
    return touchProjectMemory(function(project) {
      project.open_questions = Array.isArray(project.open_questions) ? project.open_questions : [];
      if (idx >= project.open_questions.length) return;
      var question = project.open_questions.splice(idx, 1)[0];
      addVoiceEntry({
        title: 'answered: ' + (question || '').slice(0, 30),
        body: 'Q: ' + (question || '') + '\nA: ' + (answer || ''),
        source: 'voice-answer',
        entry_mode: 'answer'
      });
      appendLogEntry({ kind: 'voice', message: 'question answered' });
    });
  }

  function isBlockerLive(blocker) {
    if (!blocker) return false;
    var nodeId = String(blocker.nodeId || blocker.node_id || '').trim();
    var questionText = lower(blocker.text || blocker.body || '').trim();
    var nodes = Array.isArray(memory.projectMemory?.nodes) ? memory.projectMemory.nodes : [];
    var questionNode = null;
    if (nodeId) {
      questionNode = nodes.find(function(node) {
        return node.node_id === nodeId && node.type === 'question';
      }) || null;
    }
    if (!questionNode && questionText) {
      questionNode = nodes.find(function(node) {
        if (node.type !== 'question') return false;
        var body = lower(node.body || node.title || '').trim();
        return body === questionText || body.indexOf(questionText) !== -1 || questionText.indexOf(body) !== -1;
      }) || null;
    }
    if (!questionNode) return false;
    if (questionNode.status !== 'open') return false;
    if (questionNode.meta?.skipped_until && new Date(questionNode.meta.skipped_until).getTime() > Date.now()) return false;
    var blockerCreatedAt = new Date(blocker.createdAt || blocker.created_at || questionNode.created_at || 0).getTime();
    var childAnswer = nodes.find(function(node) {
      if (node.status === 'archived' || node.node_id === questionNode.node_id) return false;
      var parentId = String(node.meta?.question_node_id || node.meta?.parent_question_id || '').trim();
      var linked = Array.isArray(node.links) && node.links.indexOf(questionNode.node_id) !== -1;
      var createdAt = new Date(node.created_at || 0).getTime();
      return (parentId === questionNode.node_id || linked) && createdAt > blockerCreatedAt;
    });
    return !childAnswer;
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

  if (!window.__STRUCTA_TRACE_QUEUE_LISTENERS__) {
    window.__STRUCTA_TRACE_QUEUE_LISTENERS__ = true;
    ['enqueued', 'started', 'progress', 'resolved', 'rejected', 'blocked'].forEach(function(name) {
      window.addEventListener('structa-queue-' + name, function(event) {
        var detail = event && event.detail ? event.detail : {};
        var job = detail.job || {};
        traceEvent('queue', name, job.kind || job.status || name, {
          jobId: job.id || '',
          kind: job.kind || '',
          priority: job.priority || '',
          status: job.status || '',
          reason: detail.reason || '',
          message: detail.message || '',
          error: detail.error || ''
        });
      });
    });
  }

  window.StructaNative = Object.freeze({
    getCapabilities: () => ({
      hasSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      hasCamera: !!navigator.mediaDevices?.getUserMedia,
      hasPTT: true,
      hasScrollHardware: true,
      probeMode,
      ...(window.__structaCaps || {})
    }),
    getContext: () => router?.getContext?.() || null,
    routeAction: raw => router?.routeAction?.(raw) || { ok: false },
    setActiveVerb: (verb, target) => router?.setActiveVerb?.(verb, target),
    setActiveNode: node => router?.setActiveNode?.(node),
    sendStructuredMessage,
    writeJournalEntry,
    requestEmailWithdrawal,
    dumpDebugSnapshot,
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
    flushMemory,
    restoreLastFlushSnapshot,
    restoreSnapshot,
    getMemory,
    getTriangleSlot,
    setTriangleSlot,
    clearTriangleSlot,
    getUIState,
    updateUIState,
    getProbeEvents: () => [...memory.probeEvents],
    appendProbeEvent,
    traceEvent,
    getTrace,
    snapshotState,
    storage,
    recordVoiceCall,
    emitModelChange,
    returnHome,
    emit,
    touchProjectMemory,
    approvePendingDecision,
    dismissPendingDecision,
    resolveQuestion,
    isBlockerLive,
    addBacklogItem,
    setProjectName,
    setProjectType,
    setUserRole,
    getActiveProject,
    appendThreadComment,
    setThreadCommentSummary,
    applyThreadExtraction,
    getNodeThread,
    addAnswerNode,
    enrichAnswerNode,
    ingestClaims,
    getClaimsForItem,
    getOpenQuestionNodes: function() { return JSON.parse(JSON.stringify(memory.projectMemory?.open_question_nodes || [])); },
    getActiveFocus,
    activateNextFocus,
    updateActiveFocus,
    completeActiveFocus,
    markQuestionSkipped,
    validateEvidenceIntegrity: function() {
      return validateEvidenceIntegrity(memory.projectMemory || {}, { silent: false });
    },
    addVoiceEntry,
    appendToVoiceEntry,
    annotateCapture,
    addNode,
    resolveNode,
    archiveNode,
    getNodesByType,
    getNodesByStatus,
    setClaimStatus,
    deviceId,
    deviceScopeKey,
    probeMode
  });

  window.__structa = Object.freeze({
    snapshot: snapshotState
  });

  setTimeout(function() {
    try { probeStorageHealth(); } catch (_) {}
  }, 0);
})();
