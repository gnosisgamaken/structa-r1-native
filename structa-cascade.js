/**
 * structa-cascade.js — V2 State Machine Rewrite
 *
 * Replaces all scattered booleans (hintMode, pttActive, activeSurface,
 * knowDetail, answeringQuestion, etc.) with a single formal state machine.
 *
 * States: HOME, SHOW_PRIMED, CAMERA_OPEN, CAMERA_CAPTURE,
 *         TELL_PRIMED, VOICE_OPEN, VOICE_PROCESSING,
 *         KNOW_BROWSE, KNOW_DETAIL, KNOW_ANSWER,
 *         NOW_BROWSE, LOG_OPEN
 *
 * Each state has: enter(), exit(), render(), and input handlers.
 * transition(newState, data) manages all state changes atomically.
 */
(() => {
  'use strict';

  // === DOM refs ===
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const logDrawer = document.getElementById('log-drawer');
  const logHandle = document.getElementById('log-handle');
  const logPreview = document.getElementById('log-preview');
  const logOps = document.getElementById('log-ops');
  const logQueueRow = document.getElementById('log-queue-row');
  const logPhaseRow = document.getElementById('log-phase-row');
  const logStatsRow = document.getElementById('log-stats-row');
  const native = window.StructaNative;
  const router = window.StructaActionRouter;
  const processingQueue = window.StructaProcessingQueue;
  const diagnostics = window.StructaDiagnostics;
  const projectCode = window.StructaContracts?.baseProjectCode || 'prj-structa-r1';
  const COPY = window.StructaCopy || {
    backgroundWorking: 'working in background',
    waitingAnswer: 'waiting on your answer',
    boilerRoomReady: 'boiler room ready',
    holdPttBegin: 'hold ptt to begin',
    holdPttExtend: 'hold ptt to extend',
    holdPttComment: 'hold ptt · comment',
    readyForFrame: 'ready for a frame',
    queuedWorking: function(count) { return count + ' queued · working in background'; }
  };

  // === Constants ===
  const STATES = Object.freeze({
    HOME: 'home',
    PROJECT_SWITCHER: 'project_switcher',
    TELL_BROWSE: 'tell_browse',
    SHOW_BROWSE: 'show_browse',
    SHOW_PRIMED: 'show_primed',
    CAMERA_OPEN: 'camera_open',
    CAMERA_CAPTURE: 'camera_capture',
    TELL_PRIMED: 'tell_primed',
    VOICE_OPEN: 'voice_open',
    VOICE_PROCESSING: 'voice_processing',
    KNOW_BROWSE: 'know_browse',
    KNOW_DETAIL: 'know_detail',
    KNOW_ANSWER: 'know_answer',
    NOW_BROWSE: 'now_browse',
    LOG_OPEN: 'log_open',
    TRIANGLE_OPEN: 'triangle_open'
  });

  const IC = window.StructaIcons || {};
  function iconAsset(slot, fallback = '') {
    return IC.get?.(slot) || IC.slots?.[slot] || IC.byId?.[slot] || fallback;
  }
  const triangleEngine = window.StructaTriangle;
  const cards = [
    { id: 'show', title: 'show', iconPath: iconAsset('card-show', 'assets/icons/png/4.png'), iconFallback: '▣', role: 'visual note', roleShort: 'see it', color: 'var(--show)', surface: 'camera' },
    { id: 'tell', title: 'tell', iconPath: iconAsset('card-tell', 'assets/icons/png/3.png'), iconFallback: '◉', role: 'voice note', roleShort: 'voice in', color: 'var(--tell)', surface: 'voice' },
    { id: 'know', title: 'know', iconPath: iconAsset('card-know', 'assets/icons/png/7.png'), iconFallback: '◈', role: 'signal extraction', roleShort: 'find signal', color: 'var(--know)', surface: 'insight' },
    { id: 'now', title: 'now', iconPath: iconAsset('card-now', 'assets/icons/png/6.png'), iconFallback: '▣', role: 'decision surface', roleShort: 'act on it', color: 'var(--now)', surface: 'project' }
  ];

  // === State machine ===
  let currentState = STATES.HOME;
  let stateData = {}; // per-state context
  let selectedIndex = 0;
  let logOpen = false;
  let logReturnState = STATES.HOME;
  let cameraReturnState = STATES.HOME;
  let voiceReturnState = STATES.HOME;
  let transitionTargetState = null;
  let sideClickTimer = null;
  let touchLogPressTimer = null;
  let touchLogPressPointerId = null;
  let touchLogPressStart = null;
  let touchLogPressTriggered = false;
  let touchLogSuppressClickUntil = 0;
  const DOUBLE_SIDE_WINDOW_MS = 220;
  const TOUCH_LOG_LONG_PRESS_MS = 620;
  const TOUCH_LOG_MOVE_TOLERANCE = 12;
  const TUTORIAL_SKIP_LONG_PRESS_MS = 3000;
  const TUTORIAL_SKIP_MOVE_TOLERANCE = 12;
  const TUTORIAL_STEP2_TIMEOUT_MS = 45000;
  const TUTORIAL_STEP2_START_TIMEOUT_MS = 800;
  const FLUSH_CONFIRM_HOLD_MS = 1000;
  const LOG_FOLLOW_THRESHOLD = 24;
  const WHEEL_STEP_THRESHOLD = 36;
  const NATIVE_SCROLL_DEDUPE_MS = 75;
  const TUTORIAL_FALLBACK_OPTIONS = [
    'a project',
    "something i'm figuring out",
    'a decision to make'
  ];
  const onNextFrame = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : function(callback) { return setTimeout(callback, 16); };
  const debugMode = new URLSearchParams(window.location.search || '').get('debug') === '1';
  const probeMode = window.location.hash.includes('probe') || debugMode;
  let renderScheduled = false;
  let logRefreshScheduled = false;
  let opsRefreshScheduled = false;
  let pendingLogRefreshOptions = {};
  let pendingOpsDetail = null;
  let logPinnedToBottom = true;
  let dataCacheVersion = 0;
  let cachedMemoryVersion = -1;
  let cachedProjectVersion = -1;
  let cachedMemory = null;
  let cachedProject = null;
  let cachedCaptureList = { version: -1, projectId: '', value: [] };
  let cachedVoiceEntries = { version: -1, projectId: '', value: [] };
  let cachedKnowModel = { version: -1, projectId: '', focusNodeId: '', value: null };
  let fpsMeterEl = null;
  let wheelDeltaAccumulator = 0;
  let lastNativeScrollAt = 0;
  let lastNativeScrollDirection = 0;
  let lastRenderDurationMs = 0;
  let lastScrollAt = 0;
  let scrollEventsInWindow = 0;
  let scrollWindowStartedAt = performance.now();
  let logHeaderTapCount = 0;
  let logHeaderTapWindowStartedAt = 0;
  let logHeaderTapEvalTimer = null;
  let tutorialSkipTimer = null;
  let tutorialSkipPointerId = null;
  let tutorialSkipStart = null;
  let tutorialSkipTriggered = false;
  let tutorialSkipSuppressClickUntil = 0;
  let tutorialStep2HintTimer = null;
  let flushConfirmTimer = null;
  function startDebugFPSMeter() {
    if (!debugMode || fpsMeterEl) return;
    fpsMeterEl = document.createElement('div');
    fpsMeterEl.setAttribute('aria-hidden', 'true');
    fpsMeterEl.style.position = 'fixed';
    fpsMeterEl.style.right = '8px';
    fpsMeterEl.style.bottom = '8px';
    fpsMeterEl.style.zIndex = '40';
    fpsMeterEl.style.padding = '2px 6px';
    fpsMeterEl.style.borderRadius = '8px';
    fpsMeterEl.style.background = 'rgba(8,8,8,0.78)';
    fpsMeterEl.style.color = '#f4efe4';
    fpsMeterEl.style.fontFamily = 'PowerGrotesk-Regular, sans-serif';
    fpsMeterEl.style.fontSize = '10px';
    fpsMeterEl.style.letterSpacing = '0.02em';
    fpsMeterEl.textContent = 'fps --';
    document.body.appendChild(fpsMeterEl);
    let last = performance.now();
    let frames = 0;
    function tick(now) {
      frames += 1;
      if (now - last >= 500) {
        const fps = Math.round((frames * 1000) / (now - last));
        const scrollAge = lastScrollAt ? Math.max(0, Math.round(performance.now() - lastScrollAt)) : 0;
        const scrollRate = Math.round((scrollEventsInWindow * 1000) / Math.max(1, now - scrollWindowStartedAt));
        fpsMeterEl.textContent = 'fps ' + fps + ' · r' + Math.round(lastRenderDurationMs) + 'ms · s' + scrollRate + ' · ' + scrollAge + 'ms';
        frames = 0;
        last = now;
        scrollEventsInWindow = 0;
        scrollWindowStartedAt = now;
      }
      onNextFrame(tick);
    }
    onNextFrame(tick);
  }

  function markScrollActivity() {
    lastScrollAt = performance.now();
    scrollEventsInWindow += 1;
  }

  function recordingActive() {
    return currentState === STATES.VOICE_OPEN && !!window.StructaVoice?.listening;
  }

  function recordingDot(x, y, r, parent = svg, fill = '#b51212') {
    const group = mk('g', {}, parent);
    mk('circle', { cx: x, cy: y, r: r + 1, fill: 'rgba(22,3,3,0.48)' }, group);
    const outer = mk('circle', { cx: x, cy: y, r, fill, opacity: '0.96' }, group);
    const inner = mk('circle', { cx: x, cy: y, r: Math.max(1, r - 2), fill: 'rgba(255,255,255,0.10)' }, group);
    const animateOuter = mk('animate', {
      attributeName: 'opacity',
      values: '0.98;0.44;0.98',
      dur: '0.82s',
      repeatCount: 'indefinite'
    }, outer);
    const animateInner = mk('animate', {
      attributeName: 'opacity',
      values: '0.18;0.02;0.18',
      dur: '0.82s',
      repeatCount: 'indefinite'
    }, inner);
    return group;
  }

  // Derived from stateData (shorthand accessors)
  function isHome() { return currentState === STATES.HOME; }
  function isCaptureState() { return currentState === STATES.CAMERA_OPEN || currentState === STATES.VOICE_OPEN; }

  // === Utility ===
  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function lower(text = '') {
    return String(text || '').toLowerCase();
  }

  function fireFeedback(kind) {
    return window.StructaFeedback?.fire?.(kind) || false;
  }

  function normalizeTinyText(text = '') {
    return String(text || '')
      .replace(/[#*_`>\[\]\{\}]/g, ' ')
      .replace(/\b(decision|insight|next|signal)\s*:\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function softenGuidedAsk(text = '') {
    const value = normalizeTinyText(text);
    if (!value) return '';
    const lowered = lower(value);
    if (lowered.startsWith('what specific help do you need')) {
      return 'let\'s open the next branch: what matters most first?';
    }
    if (lowered.startsWith('what help do you need') || lowered.startsWith('what do you need help')) {
      return 'let\'s open the next branch: what matters most first?';
    }
    if (lowered.startsWith('how can i help') || lowered.startsWith('how can structa help')) {
      return 'let\'s choose where this should begin.';
    }
    if (lowered.startsWith('what should happen first')) {
      return 'let\'s decide what should happen first.';
    }
    if (lowered.startsWith('what do you need for') || lowered.startsWith('what do you need to')) {
      return 'let\'s choose what this needs first.';
    }
    if (lowered.startsWith('what are you trying to')) {
      return 'let\'s name what this is moving toward.';
    }
    if (/[?!.]$/.test(value)) return value;
    if (/^(what|how|where|when|who)\b/i.test(value)) return value + '?';
    return value;
  }

  function projectDisplayName(project = getProjectMemory()) {
    const value = String(project?.name || '').trim();
    if (!value) return 'Project';
    if (lower(value) === 'untitled project') return 'Project';
    return value;
  }

  function compactProjectName(name = '') {
    const value = String(name || '').trim();
    return value.length > 20 ? value.slice(0, 19) + '…' : value;
  }

  function recentTimeLabel(raw) {
    if (!raw) return 'recent';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return 'recent';
    const diff = Date.now() - date.getTime();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    if (diff < hour) return 'now';
    if (diff < day) return `${Math.max(1, Math.floor(diff / hour))}h`;
    if (diff < 7 * day) return `${Math.max(1, Math.floor(diff / day))}d`;
    return formatTimeLabel(raw);
  }

  function formatLogTime(raw) {
    return new Date(raw || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function cloneThread(thread) {
    return Array.isArray(thread) ? thread.map(function(entry) {
      return {
        id: entry.id || '',
        kind: entry.kind || 'comment',
        body: String(entry.body || '').trim(),
        summary: String(entry.summary || entry.body || '').trim(),
        at: entry.at || '',
        origin: entry.origin || 'ptt',
        claim_ids: Array.isArray(entry.claim_ids) ? entry.claim_ids.filter(Boolean) : [],
        clarifies: entry.clarifies || '',
        contradicts: entry.contradicts || ''
      };
    }) : [];
  }

  function threadDepth(thread) {
    const ids = new Set();
    cloneThread(thread).forEach(function(entry) {
      (entry.claim_ids || []).forEach(function(claimId) {
        if (claimId) ids.add(String(claimId));
      });
    });
    return ids.size;
  }

  function threadBars(depth) {
    if (depth >= 3) return 3;
    if (depth >= 1) return 2;
    return 1;
  }

  function allowMenuFlush() {
    return !!native?.flushMemory;
  }

  function currentCard() {
    return cards[selectedIndex];
  }

  function getMemory() {
    if (cachedMemoryVersion === dataCacheVersion && cachedMemory) return cachedMemory;
    cachedMemory = native?.getMemory?.() || { captures: [], runtimeEvents: [], projectMemory: null };
    cachedMemoryVersion = dataCacheVersion;
    return cachedMemory;
  }

  function getProjectMemory() {
    if (cachedProjectVersion === dataCacheVersion && cachedProject) return cachedProject;
    cachedProject = native?.getProjectMemory?.() || getMemory().projectMemory || null;
    cachedProjectVersion = dataCacheVersion;
    return cachedProject;
  }

  function getProjects() {
    return native?.getProjects?.() || [];
  }

  function getClaimsForRefs(refs) {
    const claimMap = new Map();
    (Array.isArray(refs) ? refs : [refs]).filter(Boolean).forEach(function(ref) {
      (native?.getClaimsForItem?.(ref) || []).forEach(function(claim) {
        if (claim?.id && !claimMap.has(claim.id)) claimMap.set(claim.id, claim);
      });
    });
    return Array.from(claimMap.values());
  }

  function getActiveProjectId() {
    return native?.getActiveProjectId?.() || getProjectMemory()?.project_id || '';
  }

  function getUIState() {
    return native?.getUIState?.() || getMemory().uiState || {};
  }

  function getCaptureList() {
    const activeProjectId = getActiveProjectId();
    if (cachedCaptureList.version === dataCacheVersion && cachedCaptureList.projectId === activeProjectId) {
      return cachedCaptureList.value;
    }
    const memoryCaptures = (getMemory().captures || []).filter(capture => capture && (!capture.project_id || capture.project_id === activeProjectId));
    const projectCaptures = ((getProjectMemory()?.captures) || []).filter(Boolean).map(capture => {
      return capture && !capture.project_id ? { ...capture, project_id: activeProjectId } : capture;
    });
    const merged = new Map();
    memoryCaptures.forEach(function(capture) {
      const key = capture?.entry_id || capture?.id || capture?.node_id || '';
      if (!key) return;
      merged.set(key, capture);
    });
    projectCaptures.forEach(function(capture) {
      const key = capture?.entry_id || capture?.id || capture?.node_id || '';
      if (!key) return;
      const existing = merged.get(key) || {};
      merged.set(key, {
        ...existing,
        ...capture,
        meta: { ...(existing.meta || {}), ...(capture.meta || {}) },
        image_asset: capture.image_asset || existing.image_asset || null
      });
    });
    cachedCaptureList = {
      version: dataCacheVersion,
      projectId: activeProjectId,
      value: Array.from(merged.values()).sort((a, b) => {
      const aTime = new Date(a?.captured_at || a?.created_at || a?.meta?.captured_at || 0).getTime();
      const bTime = new Date(b?.captured_at || b?.created_at || b?.meta?.captured_at || 0).getTime();
      return aTime - bTime;
      })
    };
    return cachedCaptureList.value;
  }

  function getVoiceEntries() {
    const activeProjectId = getActiveProjectId();
    if (cachedVoiceEntries.version === dataCacheVersion && cachedVoiceEntries.projectId === activeProjectId) {
      return cachedVoiceEntries.value;
    }
    const nodes = (getProjectMemory()?.nodes || []).filter(Boolean);
    const voiceNodes = nodes
      .filter(entry => entry.type === 'voice-entry' && entry.status !== 'archived' && (!entry.project_id || entry.project_id === activeProjectId))
      .slice()
      .sort(function(a, b) {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      });
    if (voiceNodes.length) {
      cachedVoiceEntries = {
        version: dataCacheVersion,
        projectId: activeProjectId,
        value: voiceNodes
      };
      return cachedVoiceEntries.value;
    }
    const journals = (getMemory().journals || []).filter(Boolean);
    cachedVoiceEntries = {
      version: dataCacheVersion,
      projectId: activeProjectId,
      value: journals
      .filter(entry => lower(entry?.source_type || '') === 'voice' && (!entry.project_id || entry.project_id === activeProjectId))
      .slice()
      .reverse()
    };
    return cachedVoiceEntries.value;
  }

  function getCaptureImageHref(capture) {
    const direct = capture?.preview_data || capture?.image_asset?.data || capture?.image_asset?.url || capture?.asset?.data || capture?.data || capture?.meta?.preview_data || capture?.meta?.image_asset?.data || '';
    if (direct) return direct;
    const key = capture?.entry_id || capture?.id || capture?.node_id || capture?.capture_image || capture?.meta?.bundle_id || '';
    const imageAssetId = capture?.image_asset?.entry_id || capture?.meta?.image_asset_id || '';
    const imageAssetName = capture?.image_asset?.name || capture?.meta?.image_asset_name || '';
    if (!key && !imageAssetId && !imageAssetName) return '';
    const memory = native?.getMemory?.() || {};
    const pool = []
      .concat(Array.isArray(memory.captures) ? memory.captures : [])
      .concat(Array.isArray(memory.projectMemory?.captures) ? memory.projectMemory.captures : [])
      .concat(Array.isArray(memory.assets) ? memory.assets : []);
    const linked = pool.find(item => {
      return item?.entry_id === key ||
        item?.entry_id === imageAssetId ||
        item?.id === key ||
        item?.node_id === key ||
        item?.capture_image === key ||
        item?.meta?.bundle_id === key ||
        item?.name === key ||
        item?.name === imageAssetName;
    });
    return linked?.preview_data || linked?.image_asset?.data || linked?.image_asset?.url || linked?.asset?.data || linked?.data || linked?.meta?.preview_data || linked?.meta?.image_asset?.data || '';
  }

  function captureAnalysisReady(capture) {
    if (!capture) return false;
    const state = lower(capture?.meta?.analysis_status || '');
    if (state === 'ready') return true;
    const summary = lower(capture?.ai_analysis || capture?.summary || '');
    if (!summary) return false;
    return !summary.includes('analyzing') &&
      !summary.includes('image captured') &&
      !summary.includes('show+tell captured') &&
      !summary.includes('image saved') &&
      !summary.includes('frame saved') &&
      !summary.includes('preview unavailable') &&
      !summary.includes('visual capture');
  }

  function freshWorkspaceState() {
    const ui = getUIState();
    const projects = getProjects();
    const project = getProjectMemory();
    if (ui?.onboarded) return false;
    if (projects.length !== 1) return false;
    if (lower(project?.name || '') !== 'untitled project') return false;
    const captures = (project?.captures || []).length;
    const insights = (project?.insights || []).length;
    const backlog = (project?.backlog || []).length;
    const asks = (project?.open_questions || []).length;
    const pending = (project?.pending_decisions || []).length;
    const nodes = (project?.nodes || []).length;
    return captures + insights + backlog + asks + pending + nodes === 0;
  }

  function getOnboardingStep() {
    const ui = getUIState();
    const projects = getProjects();
    if (projects.length > 1) {
      native?.updateUIState?.({
        onboarded: true,
        onboarding_step: 'complete'
      });
      return 'complete';
    }
    if (ui?.onboarded) return 'complete';
    if (ui?.onboarding_step === 'complete') return 'complete';
    if (typeof ui?.onboarding_step === 'number') return ui.onboarding_step;
    return freshWorkspaceState() ? 0 : 'complete';
  }

  function onboardingActive() {
    return getOnboardingStep() !== 'complete';
  }

  function onboardingPaused() {
    return false;
  }

  function skippedOnboardingSteps() {
    return [];
  }

  function traceTutorial(flow, from, to, ctx) {
    native?.traceEvent?.(flow, from, to, ctx || {});
  }

  function markTutorialStepEntered(step) {
    if (step === 'complete') return;
    const ui = getUIState();
    if (ui.tutorial_last_entered_step === step && ui.tutorial_step_entered_at) return;
    native?.updateUIState?.({
      tutorial_last_entered_step: step,
      tutorial_step_entered_at: Date.now()
    });
    traceTutorial('tutorial.step', 'enter', String(step), { step: step });
  }

  function clearTutorialStep2HintTimer() {
    if (!tutorialStep2HintTimer) return;
    clearTimeout(tutorialStep2HintTimer);
    tutorialStep2HintTimer = null;
  }

  function clearFlushConfirmTimer() {
    if (!flushConfirmTimer) return;
    clearTimeout(flushConfirmTimer);
    flushConfirmTimer = null;
  }

  function tutorialSkipEligible(step = getOnboardingStep()) {
    return false;
  }

  function showTutorialStep2Fallback(reason) {
    if (!onboardingActive() || getOnboardingStep() !== 2) return;
    native?.updateUIState?.({
      tutorial_step2_fallback_visible: true,
      tutorial_step2_fallback_reason: reason || 'retry',
      tutorial_step2_fallback_index: Math.max(0, Math.min(Number(getUIState().tutorial_step2_fallback_index || 0), TUTORIAL_FALLBACK_OPTIONS.length - 1))
    });
    scheduleRender();
  }

  function armTutorialStep2HintTimer() {
    clearTutorialStep2HintTimer();
    if (!onboardingActive() || getOnboardingStep() !== 2) return;
    const enteredAt = Number(getUIState().tutorial_step_entered_at || Date.now());
    const remaining = Math.max(0, TUTORIAL_STEP2_TIMEOUT_MS - (Date.now() - enteredAt));
    tutorialStep2HintTimer = setTimeout(function() {
      tutorialStep2HintTimer = null;
      if (!onboardingActive() || getOnboardingStep() !== 2) return;
      traceTutorial('tutorial.step', 'timeout', '2', { step: 2 });
      showTutorialStep2Fallback('timeout');
    }, remaining || 1);
  }

  function completeOnboardingStep(step, options = {}) {
    const via = options.via || 'primary';
    const previous = getOnboardingStep();
    if (previous === 'complete') return;
    native?.updateUIState?.({
      onboarding_step: step,
      onboarded: step === 'complete',
      tutorial_last_entered_step: step === 'complete' ? previous : step,
      tutorial_step_entered_at: step === 'complete' ? null : Date.now(),
      tutorial_step2_fallback_visible: step === 2 ? !!getUIState().tutorial_step2_fallback_visible : false,
      tutorial_step2_fallback_reason: step === 2 ? String(getUIState().tutorial_step2_fallback_reason || '') : '',
      tutorial_step2_ptt_attempted: step === 2 ? !!getUIState().tutorial_step2_ptt_attempted : false,
      tutorial_step4_camera_denied: step === 4 ? !!getUIState().tutorial_step4_camera_denied : false,
      onboarding_paused: false
    });
    traceTutorial('tutorial.step', 'advance', String(step), {
      step: previous,
      via: via
    });
    if (step === 'complete') {
      traceTutorial('tutorial', 'completed', 'done', {
        stepsSkipped: skippedOnboardingSteps()
      });
      clearTutorialStep2HintTimer();
      return;
    }
    traceTutorial('tutorial.step', 'enter', String(step), { step: step });
    if (step === 2) armTutorialStep2HintTimer();
    else clearTutorialStep2HintTimer();
  }

  function onboardingAllowedCardIds(step = getOnboardingStep()) {
    if (step === 'complete') return cards.map(card => card.id);
    if (step === 3) return ['now', 'know'];
    if (step === 4) return ['know', 'show'];
    return ['now'];
  }

  function onboardingAllowsLogs() {
    return true;
  }

  function onboardingAllowsProjectSwitcher() {
    return getOnboardingStep() === 1;
  }

  function setOnboardingStep(step, options = {}) {
    completeOnboardingStep(step, options);
  }

  function completeOnboarding() {
    setOnboardingStep('complete', { via: 'primary' });
    pushLog('onboarding complete', 'system');
    if (window.StructaHeartbeat && window.StructaHeartbeat.bpm === 0 && projectHasMeaningfulContent()) {
      window.StructaHeartbeat.start(3);
    }
    if (projectHasMeaningfulContent()) {
      chainStarted = true;
      window.StructaImpactChain?.start?.(2);
    }
  }

  function resetTutorialSurfaceState() {
    clearTutorialStep2HintTimer();
    stateData.projectFlushConfirm = false;
    stateData.flushRequestSource = '';
    stateData.flushConfirmHolding = false;
    stateData.showCaptureEntryId = '';
    stateData.showCaptureIndex = 0;
    stateData.showStatus = '';
    stateData.tellEntryIndex = 0;
    stateData.tellStatus = '';
    stateData.knowLaneIndex = 0;
    stateData.knowItemIndex = 0;
    stateData.knowChipIndex = 0;
    stateData.knowFocusNodeId = '';
    stateData.knowBodyScrollTop = 0;
    stateData.knowBodyMaxScroll = 0;
    stateData.decisionIndex = 0;
    stateData.selectedOption = 0;
    stateData.projectListIndex = 0;
    stateData.inlinePTTSurface = '';
    stateData.triangleStatus = '';
    window.__STRUCTA_PTT_TARGET__ = null;
    window.__STRUCTA_INLINE_PTT__ = false;
    voiceReturnState = STATES.HOME;
    cameraReturnState = STATES.HOME;
    logReturnState = STATES.HOME;
  }

  function homeOnboardingSelectionAllowed(cardId) {
    return onboardingAllowedCardIds().includes(cardId);
  }

  function selectNextAllowedCard(direction) {
    const allowed = onboardingAllowedCardIds();
    if (!allowed.length) return;
    if (allowed.length === 1) {
      const onlyIndex = cards.findIndex(card => card.id === allowed[0]);
      if (onlyIndex >= 0) selectedIndex = onlyIndex;
      render();
      return;
    }
    const currentId = currentCard()?.id;
    let idx = allowed.indexOf(currentId);
    if (idx === -1) idx = 0;
    idx = (idx + (direction > 0 ? 1 : -1) + allowed.length) % allowed.length;
    const nextIndex = cards.findIndex(card => card.id === allowed[idx]);
    if (nextIndex >= 0) {
      selectedIndex = nextIndex;
      native?.setActiveNode?.(currentCard().id);
      native?.updateUIState?.({ selected_card_id: currentCard().id, last_surface: currentState });
      render();
    }
  }

  function getCaptureSummary(capture) {
    if (!capture) return 'no frames';
    const status = lower(capture?.meta?.analysis_status || '');
    if (status === 'pending') return 'analyzing…';
    if (status === 'unavailable') {
      const fallback = String(capture?.summary || capture?.prompt_text || capture?.voice_annotation || 'frame saved');
      return lower('unanalyzed · ' + fallback);
    }
    const raw = String(capture?.ai_analysis || capture?.ai_response || capture?.summary || capture?.prompt_text || 'untitled capture');
    const signalMatch = raw.match(/signal:\s*(.+)/i);
    if (signalMatch && signalMatch[1]) return lower(signalMatch[1].trim());
    return lower(raw);
  }

  function getCaptureProcessingLine(capture) {
    if (!capture) return 'ready';
    const meta = capture?.meta || {};
    if (Number(meta.annotation_window_until || 0) > Date.now()) return 'speak to tag, or wait';
    const stage = lower(meta.analysis_stage || '');
    if (stage === 'capturing') return 'capturing';
    if (stage === 'queued') return 'working in background';
    if (stage === 'analyzing') return 'analyzing';
    if (stage === 'extracting claims') return 'extracting claims';
    if (lower(meta.analysis_status || '') === 'pending') return 'working in background';
    if (meta.claim_extraction_pending) return 'will finish soon';
    return 'done';
  }

  function latestLogText() {
    const entries = native?.getRecentLogEntries?.(1, { visible_only: true, include_diagnostic: false }) || [];
    const latest = entries[entries.length - 1];
    return lower(latest?.visible_message || latest?.message || getQueueLine());
  }

  function getStatsLines() {
    const project = getProjectMemory() || {};
    const captures = getCaptureList().length;
    const notes = getVoiceEntries().length;
    const asks = (project.open_questions || []).length;
    const locked = (project.decisions || []).length;
    const pending = (project.pending_decisions || []).length;
    const signals = (project.insights || []).length;
    return [
      `${notes} notes · ${captures} frames · ${signals} signals`,
      `${asks} asks · ${pending} waiting · ${locked} locked`
    ];
  }

  function getOpsStatsLine() {
    const project = getProjectMemory() || {};
    const captures = getCaptureList().length;
    const signals = (project.insights || []).length;
    const decisions = (project.decisions || []).length;
    const open = (project.open_questions || []).filter(function(item) {
      return !item || typeof item === 'string' || item.status !== 'answered';
    }).length;
    return `captures ${captures} · signals ${signals} · decisions ${decisions} · open ${open}`;
  }

  function getPendingCaptureQueueCount() {
    const project = getProjectMemory() || {};
    return (project.captures || []).filter(function(capture) {
      return lower(capture?.meta?.analysis_status || '') === 'pending';
    }).length;
  }

  function getQueueSnapshot() {
    return processingQueue?.snapshot?.() || [];
  }

  function getQueuePendingJobs() {
    return getQueueSnapshot().filter(function(job) {
      return job.status === 'pending' || job.status === 'running';
    });
  }

  function getQueueBlockedJobs() {
    return getQueueSnapshot().filter(function(job) {
      return job.status === 'blocked';
    });
  }

  function getQueueTierColor(priority) {
    switch (priority) {
      case 'P0': return 'rgba(248,193,93,0.92)';
      case 'P1': return 'rgba(119,213,255,0.92)';
      case 'P2': return 'rgba(146,255,157,0.88)';
      default: return 'rgba(244,239,228,0.68)';
    }
  }

  function formatQueueJob(job) {
    const label = {
      'triangle-synthesize': 'synthesizing triangle',
      'image-analyze': 'analyzing frame',
      'project-title': 'titling project',
      'voice-interpret': 'interpreting voice',
      'thread-refine': 'refining comment',
      'chain-step': 'running chain'
    }[job.kind] || lower(job.kind || 'queued work');
    const prefix = job.status === 'running' ? '▸ ' : '  ';
    return prefix + label + (job.status === 'running' ? ' ' + formatElapsed(job.elapsedMs || 0) : '');
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function getQueueBlockerCopy(job) {
    if (!job) return '';
    switch (job.kind) {
      case 'triangle-synthesize':
        return 'synthesis stalled — click retry, double side skips';
      case 'image-analyze':
        return 'visual note stalled — click retry, double side skips';
      case 'voice-interpret':
        return 'interpretation stalled — click retry, double side skips';
      case 'project-title':
        return 'project naming stalled — click retry, double side skips';
      default:
        return 'queue stalled — click retry, double side skips';
    }
  }

  function syncQueueBlockers() {
    const existing = getUIState().queue_blockers || [];
    const blocked = getQueueBlockedJobs().map(function(job) {
      return {
        id: job.id,
        kind: job.kind,
        body: getQueueBlockerCopy(job),
        payload: job.payload || {}
      };
    });
    const unchanged = JSON.stringify(existing) === JSON.stringify(blocked);
    if (!unchanged) native?.updateUIState?.({ queue_blockers: blocked });
  }

  function getQueueLine() {
    const pendingJobs = getQueuePendingJobs();
    const total = pendingJobs.length;
    const running = pendingJobs.find(function(job) { return job.status === 'running'; });
    const chain = window.StructaImpactChain || {};
    const phase = lower(chain?.phase || 'idle');
    const focus = lower(chain?.focusLabel || '');
    if (!total) return focus ? `queue clear · ${focus}` : `queue clear · ${phase}`;
    if (running) return `${total} pending · ${formatQueueJob(running).replace(/^▸\s*/, '')}`;
    return `${total} pending · ${focus || phase}`;
  }

  function invalidateDataCaches() {
    dataCacheVersion += 1;
    cachedMemoryVersion = -1;
    cachedProjectVersion = -1;
    cachedMemory = null;
    cachedProject = null;
    cachedCaptureList = { version: -1, projectId: '', value: [] };
    cachedVoiceEntries = { version: -1, projectId: '', value: [] };
    cachedKnowModel = { version: -1, projectId: '', focusNodeId: '', value: null };
  }

  function invalidateUICaches() {
    cachedKnowModel = { version: -1, projectId: '', focusNodeId: '', value: null };
  }

  function resetVoiceChrome() {
    var voiceOverlay = document.getElementById('voice-overlay');
    var contextLabel = document.getElementById('voice-context-label');
    if (voiceOverlay) voiceOverlay.classList.remove('answer-mode');
    if (contextLabel) contextLabel.textContent = '';
    document.body.classList.remove('input-locked');
  }

  function fullUIRuntimeReset(options = {}) {
    clearPendingSideClick();
    clearTouchLogPress();
    clearTutorialSkipTouch();
    clearTutorialStep2HintTimer();
    clearFlushConfirmTimer();
    if (logHeaderTapEvalTimer) {
      clearTimeout(logHeaderTapEvalTimer);
      logHeaderTapEvalTimer = null;
    }
    logHeaderTapCount = 0;
    logHeaderTapWindowStartedAt = 0;
    tutorialSkipTriggered = false;
    tutorialSkipSuppressClickUntil = 0;
    touchLogPressTriggered = false;
    touchLogSuppressClickUntil = 0;
    transitionTargetState = null;
    wheelDeltaAccumulator = 0;
    lastNativeScrollAt = 0;
    lastNativeScrollDirection = 0;
    resetTutorialSurfaceState();
    resetVoiceChrome();
    invalidateDataCaches();
    invalidateUICaches();
    currentState = STATES.HOME;
    stateData = {};
    selectedIndex = Math.max(0, cards.findIndex(function(card) { return card.id === 'now'; }));
    logOpen = false;
    logReturnState = STATES.HOME;
    cameraReturnState = STATES.HOME;
    voiceReturnState = STATES.HOME;
    if (!options.preserveUndo && Number(getUIState().flush_undo_available_until || 0) > 0) {
      native?.updateUIState?.({ flush_undo_available_until: 0 });
    }
    scheduleLogRefresh({ jumpToLatest: true, forceFollow: true });
    scheduleOpsRefresh({ queueLine: getQueueLine() });
    scheduleRender();
  }

  function refreshBundle(reason = 'manual') {
    const stamp = Date.now();
    try {
      const session = window.sessionStorage;
      const previous = Number(session?.getItem('structa-ui-refresh-at') || 0);
      if (previous && (stamp - previous) < 10000) return Promise.resolve(false);
      session?.setItem('structa-ui-refresh-at', String(stamp));
    } catch (_) {}
    const clearCaches = (async function() {
      try {
        if (window.caches?.keys) {
          const names = await window.caches.keys();
          await Promise.all(names.map(function(name) {
            return window.caches.delete(name).catch(function() { return false; });
          }));
        }
      } catch (_) {}
      try {
        if (navigator.serviceWorker?.getRegistrations) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all((registrations || []).map(function(registration) {
            return registration.unregister().catch(function() { return false; });
          }));
        }
      } catch (_) {}
    })();
    return Promise.resolve(clearCaches).finally(function() {
      try {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('ui_refresh', String(stamp));
        nextUrl.searchParams.set('asset_epoch', String(stamp));
        if (reason) nextUrl.searchParams.set('ui_reason', String(reason));
        window.location.replace(nextUrl.toString());
      } catch (_) {
        window.location.reload();
      }
    });
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    onNextFrame(function() {
      renderScheduled = false;
      renderNow();
    });
  }

  function isLogNearBottom() {
    return Math.max(0, log.scrollHeight - (log.scrollTop + log.clientHeight)) <= LOG_FOLLOW_THRESHOLD;
  }

  function scheduleLogRefresh(options = {}) {
    pendingLogRefreshOptions = {
      jumpToLatest: pendingLogRefreshOptions.jumpToLatest || !!options.jumpToLatest,
      forceFollow: pendingLogRefreshOptions.forceFollow || !!options.forceFollow
    };
    if (logRefreshScheduled) return;
    logRefreshScheduled = true;
    onNextFrame(function() {
      logRefreshScheduled = false;
      const refreshOptions = pendingLogRefreshOptions;
      pendingLogRefreshOptions = {};
      refreshLogFromMemory(refreshOptions);
    });
  }

  function scheduleOpsRefresh(detail) {
    if (detail) pendingOpsDetail = { ...(pendingOpsDetail || {}), ...detail };
    if (opsRefreshScheduled) return;
    opsRefreshScheduled = true;
    onNextFrame(function() {
      opsRefreshScheduled = false;
      const nextDetail = pendingOpsDetail || {};
      pendingOpsDetail = null;
      updateLogOps(nextDetail);
      updateChainBadge();
    });
  }

  function getPhaseDots(phase = '') {
    const order = ['observe', 'clarify', 'evaluate', 'decision', 'cooldown'];
    const activeIndex = order.indexOf(lower(phase));
    if (lower(phase) === 'paused') return '■□□□□';
    if (lower(phase) === 'idle') return '□□□□□';
    return order.map(function(_, index) { return index <= activeIndex ? '●' : '○'; }).join('');
  }

  function updateLogOps(detail) {
    if (!logQueueRow || !logPhaseRow || !logStatsRow) return;
    const chain = window.StructaImpactChain;
    const phase = lower(detail?.phase || chain?.phase || 'idle');
    const jobs = getQueuePendingJobs();
    const queueHeader = jobs.length ? `queue · ${jobs.length} pending` : 'queue · clear';
    const queueRows = jobs.slice(0, 3).map(formatQueueJob);
    logQueueRow.textContent = [queueHeader].concat(queueRows).join('\n');
    if (!chain || phase === 'idle') {
      logPhaseRow.textContent = `chain idle · ${chain?.historyCount || 0} resolved · ${chain?.awaitingCount || 0} awaiting input`;
    } else {
      const focusLabel = lower(chain?.focusLabel || 'focus');
      const steps = Number(chain?.focusStepCount || 0);
      const plateau = Number(chain?.focusPlateauCount || 0);
      logPhaseRow.textContent = `chain ${phase} · ${focusLabel} · steps ${steps} · plateau ${plateau}`;
    }
    logStatsRow.textContent = getOpsStatsLine();
    if (logOps) logOps.hidden = !logOpen;
  }

  function getTriangleState() {
    return triangleEngine?.validateOrClear?.() || triangleEngine?.getState?.() || { mode: 'empty', item: null, pair: null, status: '', lastError: '' };
  }

  function triangleCardId(item) {
    return item?.type === 'show' || item?.type === 'tell' || item?.type === 'know' || item?.type === 'now'
      ? item.type
      : 'know';
  }

  function triangleColor(item) {
    const cardId = triangleCardId(item);
    return cards.find(function(card) { return card.id === cardId; })?.color || 'rgba(244,239,228,0.18)';
  }

  function triangleInitial(item) {
    const map = { show: 's', tell: 't', know: 'k', now: 'n' };
    return map[triangleCardId(item)] || 't';
  }

  function triangleSummaryText(item) {
    if (!item) return '';
    const textValue = String(item.summary || item.body || item.title || '').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    return lower(textValue.slice(0, 120));
  }

  function triangleIndicatorVisible() {
    if (currentState === STATES.CAMERA_OPEN || currentState === STATES.CAMERA_CAPTURE) return false;
    return true;
  }

  function renderLogRows(entries) {
    const fragment = document.createDocumentFragment();
    entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'entry';
      if (entry?.kind) row.dataset.kind = lower(entry.kind);
      if (entry?.actionId) row.dataset.action = entry.actionId;
      if (entry?.disabled) row.setAttribute('aria-disabled', 'true');
      const time = document.createElement('span');
      time.className = 'muted';
      time.textContent = entry?.actionId
        ? 'tap'
        : `[${formatLogTime(entry.created_at || new Date().toISOString())}]`;
      row.appendChild(time);
      const message = document.createElement('span');
      const detail = entry?.detail ? ' · ' + lower(entry.detail) : '';
      message.textContent = lower(entry.message || 'event') + detail;
      row.appendChild(message);
      fragment.appendChild(row);
    });
    log.replaceChildren(fragment);
  }

  function getTraceEntries(limit = 20) {
    const trace = native?.getTrace?.() || {};
    const events = Array.isArray(trace.events) ? trace.events.slice(-limit) : [];
    return events.map(function(entry) {
      const ctx = entry && entry.ctx ? Object.keys(entry.ctx).map(function(key) {
        return key + ':' + String(entry.ctx[key]);
      }).join(' · ') : '';
      return {
        created_at: entry?.t || new Date().toISOString(),
        message: [entry?.flow || 'trace', entry?.from || '', entry?.to || '', ctx].filter(Boolean).join(' · ')
      };
    });
  }

  // === Transition ===
  function transition(newState, data = {}) {
    const prev = currentState;
    const prevStateData = { ...stateData };
    transitionTargetState = newState;

    // Exit previous state
    stateExitHandlers[prev]?.(prevStateData);

    currentState = newState;
    stateData = { ...stateData, ...data };
    transitionTargetState = null;

    // Enter new state
    stateEnterHandlers[newState]?.(stateData);
    native?.traceEvent?.('surface', prev, newState, {
      data: data || {}
    });

    // Render
    scheduleRender();
  }

  // === Log management ===
  function pushLog(text, strong = '') {
    native?.appendLogEntry?.({ kind: lower(strong || 'ui'), message: lower(text) });
    scheduleLogRefresh();
  }

  function refreshLogFromMemory(options = {}) {
    const limit = logOpen ? 33 : 5;
    const previousScroll = log.scrollTop;
    const previousBottomOffset = Math.max(0, log.scrollHeight - (log.scrollTop + log.clientHeight));
    const followLatest = !!options.jumpToLatest || (logOpen && (!!options.forceFollow || logPinnedToBottom || isLogNearBottom()));
    const traceMode = !!stateData.logTraceMode;
    const diagnosticRows = logOpen && diagnostics?.getDrawerRows ? diagnostics.getDrawerRows() : null;
    const entries = diagnosticRows && diagnosticRows.length
      ? diagnosticRows
      : (traceMode
        ? getTraceEntries(logOpen ? 20 : 5)
        : (native?.getRecentLogEntries?.(limit, { visible_only: true }) || []).slice(-limit));
    if (!entries.length) {
      if (logOpen) renderLogRows([]);
      else log.innerHTML = '';
      logPreview.textContent = traceMode ? 'trace empty' : (diagnosticRows ? 'diagnostics ready' : getQueueLine());
      updateLogOps();
      if (logOpen) logPinnedToBottom = true;
      return;
    }
    renderLogRows(entries);
    if (diagnosticRows) {
      logPreview.textContent = diagnostics?.getState?.()?.running ? 'diagnostics running' : 'diagnostics';
    } else {
      logPreview.textContent = traceMode ? 'trace · ' + entries.length : latestLogText();
    }
    updateLogOps();
    if (logOpen) {
      if (diagnosticRows) {
        log.scrollTop = 0;
        logPinnedToBottom = true;
      } else if (followLatest) {
        log.scrollTop = log.scrollHeight;
        logPinnedToBottom = true;
      } else {
        log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - previousBottomOffset);
        if (!Number.isFinite(log.scrollTop)) log.scrollTop = previousScroll;
        logPinnedToBottom = isLogNearBottom();
      }
    }
  }

  function setLogDrawer(open) {
    logOpen = !!open;
    logDrawer.classList.toggle('open', logOpen);
    logDrawer.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
    if (logOps) logOps.hidden = !logOpen;
    if (logOpen) {
      logPinnedToBottom = true;
      refreshLogFromMemory({ jumpToLatest: true, forceFollow: true });
    } else {
      stateData.logTraceMode = false;
      scheduleLogRefresh();
    }
  }

  log?.addEventListener('scroll', function() {
    if (!logOpen) return;
    logPinnedToBottom = isLogNearBottom();
  });

  log?.addEventListener('pointerup', function(event) {
    const row = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    const actionId = row.dataset.action || '';
    if (!actionId || !diagnostics?.handleAction) return;
    event.preventDefault();
    event.stopPropagation();
    fireFeedback('touch-commit');
    diagnostics.handleAction(actionId).then(function() {
      refreshLogFromMemory({ jumpToLatest: true, forceFollow: true });
    }).catch(function() {
      refreshLogFromMemory({ jumpToLatest: true, forceFollow: true });
    });
  });

  logDrawer?.addEventListener('pointerup', function(event) {
    if (!logOpen) return;
    const bounds = logDrawer.getBoundingClientRect();
    const relY = event.clientY - bounds.top;
    if (relY < 0 || relY > 44) return;
    const now = Date.now();
    if (now - logHeaderTapWindowStartedAt > 700) {
      logHeaderTapCount = 0;
      logHeaderTapWindowStartedAt = now;
    }
    logHeaderTapCount += 1;
    clearTimeout(logHeaderTapEvalTimer);
    if (logHeaderTapCount >= 4) {
      logHeaderTapCount = 0;
      logHeaderTapWindowStartedAt = 0;
      fireFeedback('touch-commit');
      native?.dumpDebugSnapshot?.({ export: false });
      pushLog('snapshot dumped', 'export');
      scheduleLogRefresh({ jumpToLatest: true, forceFollow: true });
      return;
    }
    logHeaderTapEvalTimer = setTimeout(function() {
      if (logHeaderTapCount === 3) {
        stateData.logTraceMode = !stateData.logTraceMode;
        fireFeedback('touch-commit');
        refreshLogFromMemory({ jumpToLatest: true, forceFollow: true });
      }
      logHeaderTapCount = 0;
      logHeaderTapWindowStartedAt = 0;
      logHeaderTapEvalTimer = null;
    }, 240);
  });

  // === State enter/exit handlers ===
  const stateEnterHandlers = {};
  const stateExitHandlers = {};

  // --- HOME ---
  stateEnterHandlers[STATES.HOME] = function(data) {
    document.title = 'structa';
    window.__STRUCTA_PTT_TARGET__ = null;
    document.body.classList.remove('input-locked');
    if (onboardingActive()) {
      const step = getOnboardingStep();
      markTutorialStepEntered(step);
      const allowed = onboardingAllowedCardIds(step);
      const preferredCardId = step === 4 ? 'show' : (step === 3 ? 'know' : allowed[0]);
      if (!allowed.includes(currentCard()?.id) || (preferredCardId && currentCard()?.id !== preferredCardId)) {
        const nextIndex = cards.findIndex(function(card) { return card.id === preferredCardId; });
        if (nextIndex >= 0) selectedIndex = nextIndex;
      }
    }
    maybeStartHeartbeat();
  };

  stateExitHandlers[STATES.HOME] = function(data) {
    stateData.projectFlushConfirm = false;
  };

  // --- PROJECT_SWITCHER ---
  stateEnterHandlers[STATES.PROJECT_SWITCHER] = function(data) {
    document.title = 'projects';
    setLogDrawer(false);
    const projects = getProjects();
    const activeId = getActiveProjectId();
    const activeIndex = Math.max(0, projects.findIndex(project => project.project_id === activeId));
    stateData.projectListIndex = typeof data.projectListIndex === 'number' ? data.projectListIndex : activeIndex;
    stateData.projectFlushConfirm = false;
    if (onboardingActive()) markTutorialStepEntered(getOnboardingStep());
  };

  stateExitHandlers[STATES.PROJECT_SWITCHER] = function() {
    stateData.projectFlushConfirm = false;
  };

  // --- TELL_BROWSE ---
  stateEnterHandlers[STATES.TELL_BROWSE] = function(data) {
    document.title = 'tell';
    native?.setActiveNode?.('tell');
    native?.updateUIState?.({ selected_card_id: 'tell', last_surface: 'tell' });
    setLogDrawer(false);
    const entries = getVoiceEntries();
    const maxIndex = Math.max(0, entries.length - 1);
    if (typeof stateData.tellEntryIndex !== 'number') {
      stateData.tellEntryIndex = 0;
    }
    stateData.tellEntryIndex = Math.min(stateData.tellEntryIndex, maxIndex);
    if (!stateData.tellStatus) {
      stateData.tellStatus = entries.length ? 'ready' : 'empty';
    }
  };

  // --- SHOW_BROWSE ---
  stateEnterHandlers[STATES.SHOW_BROWSE] = function(data) {
    document.title = 'show';
    native?.setActiveNode?.('show');
    native?.updateUIState?.({ selected_card_id: 'show', last_surface: 'show' });
    setLogDrawer(false);
    const captures = getCaptureList();
    const maxIndex = Math.max(0, captures.length - 1);
    stateData.showCaptureIndex = Math.min(stateData.showCaptureIndex || 0, maxIndex);
    if (!stateData.showStatus) {
      stateData.showStatus = captures.length ? 'reviewing' : 'empty';
    }
  };

  // --- SHOW_PRIMED (legacy invisible warm state) ---
  stateEnterHandlers[STATES.SHOW_PRIMED] = function(data) {
    document.title = 'show';
    native?.setActiveNode?.('show');
    native?.updateUIState?.({ selected_card_id: 'show', last_surface: 'camera' });
    window.StructaVoice?.close?.();
  };

  stateExitHandlers[STATES.SHOW_PRIMED] = function(data) {
    if (currentState !== STATES.CAMERA_OPEN) {
      // User cancelled priming — close camera
      window.StructaCamera?.close?.();
      window.__STRUCTA_PTT_TARGET__ = null;
    }
  };

  // --- CAMERA_OPEN ---
  stateEnterHandlers[STATES.CAMERA_OPEN] = function(data) {
    document.title = 'show';
    native?.setActiveNode?.('show');
    native?.updateUIState?.({ selected_card_id: 'show', last_surface: 'camera' });
  };

  stateExitHandlers[STATES.CAMERA_OPEN] = function(data) {
    if (transitionTargetState !== STATES.CAMERA_CAPTURE) {
      window.StructaCamera?.close?.();
    }
    window.__STRUCTA_PTT_TARGET__ = null;
  };

  // --- CAMERA_CAPTURE ---
  stateEnterHandlers[STATES.CAMERA_CAPTURE] = function(data) {
    // Flash effect — handled by CSS
    svg.classList.add('capture-flash');
    setTimeout(() => svg.classList.remove('capture-flash'), 150);

    // Perform capture
    window.StructaCamera?.capture?.();
    pushLog('image captured', 'camera');

    // Auto-transition back after brief delay if the overlay did not already close us.
    setTimeout(() => {
      if (currentState === STATES.CAMERA_CAPTURE) {
        const returnState = cameraReturnState;
        cameraReturnState = STATES.HOME;
        transition(returnState === STATES.SHOW_BROWSE ? STATES.SHOW_BROWSE : STATES.HOME, {
          showStatus: 'captured'
        });
      }
    }, 300);
  };

  // --- TELL_PRIMED (invisible, pre-warming voice) ---
  stateEnterHandlers[STATES.TELL_PRIMED] = function(data) {
    window.__STRUCTA_PTT_TARGET__ = 'voice';
    native?.setActiveNode?.('tell');
    native?.updateUIState?.({ selected_card_id: 'tell', last_surface: 'voice' });
  };

  stateExitHandlers[STATES.TELL_PRIMED] = function(data) {
    if (currentState !== STATES.VOICE_OPEN) {
      window.__STRUCTA_PTT_TARGET__ = null;
    }
  };

  // --- VOICE_OPEN ---
  stateEnterHandlers[STATES.VOICE_OPEN] = function(data) {
    document.title = 'tell';
    native?.setActiveNode?.('tell');
    native?.updateUIState?.({ selected_card_id: 'tell', last_surface: 'voice' });
    window.__STRUCTA_PTT_TARGET__ = 'voice';
    window.__STRUCTA_INLINE_PTT__ = !!data.fromPTT;
    stateData.inlinePTTSurface = data.inlinePTTSurface || stateData.inlinePTTSurface || '';

    // If answering a question, set context before starting
    if (data.triangleMode) {
      window.StructaVoice?.setTriangleContext?.({ label: 'your angle' });
    } else if (data.answeringQuestion) {
      if (window.StructaVoice?.setQuestionContext) {
        window.StructaVoice.setQuestionContext(data.answeringQuestion);
      }
      native?.appendLogEntry?.({ kind: 'voice', message: 'answering: ' + data.answeringQuestion.text.slice(0, 40) });
    } else if (data.buildContext && window.StructaVoice?.setBuildContext) {
      window.StructaVoice.setBuildContext(data.buildContext);
    }

    const voiceOverlay = document.getElementById('voice-overlay');
    const surfaceMap = { home: 'project context', tell: 'on note', show: 'on frame', know: 'on signal', insight: 'on signal', project: 'on decision', now: 'on decision', log: 'to log' };
    const surface = data.inlinePTTSurface || data.buildContext?.surface || '';
    const suppressTutorialVoiceChrome = !!(onboardingActive() && getOnboardingStep() === 2);
    const contextLabelText = data.triangleMode
      ? 'your angle'
      : suppressTutorialVoiceChrome
        ? ''
        : data.answeringQuestion
        ? 'answering ask'
        : (surface && surfaceMap[surface] ? surfaceMap[surface] : '');
    if (voiceOverlay) {
      if (data.answeringQuestion && !suppressTutorialVoiceChrome) voiceOverlay.classList.add('answer-mode');
      else voiceOverlay.classList.remove('answer-mode');
    }
    window.StructaVoice?.setContextLabel?.(contextLabelText);

    if (data.fromPTT) {
      document.body.classList.add('input-locked');
      window.StructaVoice?.startListening?.();
    } else {
      window.StructaVoice?.open?.();
    }
  };

  stateExitHandlers[STATES.VOICE_OPEN] = function(data) {
    document.body.classList.remove('input-locked');
    window.__STRUCTA_PTT_TARGET__ = null;
    window.__STRUCTA_INLINE_PTT__ = false;
    window.StructaVoice?.setTriangleContext?.(null);
    if (transitionTargetState !== STATES.VOICE_PROCESSING) {
      stateData.inlinePTTSurface = '';
    }
    const voiceOverlay = document.getElementById('voice-overlay');
    const voiceContextLabel = document.getElementById('voice-context-label');
    if (voiceOverlay) voiceOverlay.classList.remove('answer-mode');
    if (voiceContextLabel) {
      voiceContextLabel.textContent = '';
      voiceContextLabel.style.display = 'none';
    }
  };

  // --- VOICE_PROCESSING ---
  stateEnterHandlers[STATES.VOICE_PROCESSING] = function(data) {
    // Brief processing state — return to the prior surface
    setTimeout(() => {
      if (currentState === STATES.VOICE_PROCESSING) {
        const returnState = voiceReturnState;
        voiceReturnState = STATES.HOME;
        stateData.inlinePTTSurface = '';
        transition(returnState || STATES.HOME, {
          tellStatus: 'saved'
        });
      }
    }, 300);
  };

  // --- KNOW_BROWSE ---
  stateEnterHandlers[STATES.KNOW_BROWSE] = function(data) {
    document.title = 'stack';
    native?.setActiveNode?.('know');
    native?.updateUIState?.({ selected_card_id: 'know', last_surface: 'insight' });
    setLogDrawer(false);
    stateData.knowLaneIndex = typeof data?.knowLaneIndex === 'number' ? data.knowLaneIndex : (typeof stateData.knowLaneIndex === 'number' ? stateData.knowLaneIndex : 0);
    stateData.knowItemIndex = typeof data?.knowItemIndex === 'number' ? data.knowItemIndex : (typeof stateData.knowItemIndex === 'number' ? stateData.knowItemIndex : 0);
    stateData.knowChipIndex = typeof data?.knowChipIndex === 'number' ? data.knowChipIndex : (typeof stateData.knowChipIndex === 'number' ? stateData.knowChipIndex : 0);
    stateData.knowFocusNodeId = data?.preserveKnowFocus ? (stateData.knowFocusNodeId || '') : (typeof data?.knowFocusNodeId === 'string' ? data.knowFocusNodeId : '');
    if (onboardingActive()) {
      const step = getOnboardingStep();
      markTutorialStepEntered(step);
      if (step === 3) {
        setOnboardingStep(4, { via: 'primary' });
        pushLog('lesson 3 complete', 'system');
        selectedIndex = Math.max(0, cards.findIndex(card => card.id === 'show'));
      }
    }
  };

  // --- KNOW_DETAIL ---
  stateEnterHandlers[STATES.KNOW_DETAIL] = function(data) {
    stateData.knowItemIndex = typeof data?.itemIndex === 'number' ? data.itemIndex : (typeof stateData.knowItemIndex === 'number' ? stateData.knowItemIndex : 0);
    stateData.knowBodyScrollTop = 0;
    stateData.knowBodyMaxScroll = 0;
  };

  // --- KNOW_ANSWER ---
  stateEnterHandlers[STATES.KNOW_ANSWER] = function(data) {
    // Reuses VOICE_OPEN but with question context
    voiceReturnState = STATES.KNOW_BROWSE;
    transition(STATES.VOICE_OPEN, {
      answeringQuestion: data.question,
      fromPTT: true
    });
  };

  // --- NOW_BROWSE ---
  stateEnterHandlers[STATES.NOW_BROWSE] = function(data) {
    document.title = 'stack';
    native?.setActiveNode?.('now');
    native?.updateUIState?.({ selected_card_id: 'now', last_surface: 'project' });
    setLogDrawer(false);
    stateData.decisionIndex = 0;
    stateData.selectedOption = 0;
    if (onboardingActive()) {
      markTutorialStepEntered(getOnboardingStep());
      armTutorialStep2HintTimer();
    } else {
      clearTutorialStep2HintTimer();
    }
  };

  // --- LOG_OPEN ---
  stateEnterHandlers[STATES.LOG_OPEN] = function(data) {
    setLogDrawer(true);
  };

  stateExitHandlers[STATES.LOG_OPEN] = function(data) {
    setLogDrawer(false);
  };

  // --- TRIANGLE_OPEN ---
  stateEnterHandlers[STATES.TRIANGLE_OPEN] = function(data) {
    document.title = 'triangle';
    window.__STRUCTA_PTT_TARGET__ = null;
    if (data?.triangleStatus) stateData.triangleStatus = data.triangleStatus;
  };

  stateExitHandlers[STATES.TRIANGLE_OPEN] = function() {
    window.StructaVoice?.setTriangleContext?.(null);
    stateData.inlinePTTSurface = '';
  };

  // === Card selection (HOME only) ===
  function selectIndex(next) {
    selectedIndex = (next + cards.length) % cards.length;
    native?.setActiveNode?.(currentCard().id);
    native?.updateUIState?.({ selected_card_id: currentCard().id, last_surface: currentState });
    render();
  }

  // === Open a card's primary surface ===
  function openCard(card) {
    if (onboardingActive() && !onboardingAllowedCardIds().includes(card.id)) {
      fireFeedback('blocked');
      return;
    }
    fireFeedback('touch-commit');
    if (card.surface === 'camera') {
      transition(STATES.SHOW_BROWSE);
      return;
    }
    if (card.surface === 'voice') {
      transition(STATES.TELL_BROWSE, { tellStatus: 'ready' });
      return;
    }
    if (card.surface === 'insight') {
      transition(STATES.KNOW_BROWSE);
      return;
    }
    if (card.surface === 'project') {
      transition(STATES.NOW_BROWSE);
      return;
    }
  }

  function openCameraFromShow(source = 'touch', options = {}) {
    cameraReturnState = STATES.SHOW_BROWSE;
    const wantsNarration = !!options.narrate;
    const entryState = wantsNarration ? STATES.SHOW_PRIMED : STATES.SHOW_BROWSE;
    if (currentState !== entryState && currentState !== STATES.CAMERA_OPEN && currentState !== STATES.CAMERA_CAPTURE) {
      transition(entryState, {
        showStatus: wantsNarration ? 'opening show + tell' : 'opening lens',
        pendingShowNarration: wantsNarration
      });
    } else {
      stateData.showStatus = wantsNarration ? 'opening show + tell' : 'opening lens';
      stateData.pendingShowNarration = wantsNarration;
      render();
    }
    if (source !== 'touch') {
      stateData.showStatus = 'click to start camera';
      stateData.pendingShowNarration = false;
      fireFeedback('blocked');
      render();
      return false;
    }
    fireFeedback('touch-commit');
    window.StructaCamera?.openFromGesture?.('environment');
    return true;
  }

  function openTellSurface(extra = {}) {
    voiceReturnState = extra.returnState || STATES.TELL_BROWSE;
    transition(STATES.VOICE_OPEN, { fromPTT: false, ...extra });
  }

  function openNowNextMove() {
    const project = getProjectMemory();
    const openQuestionNodes = project?.open_question_nodes || [];
    if (openQuestionNodes.length) {
      const activeQuestion = openQuestionNodes[0] || {};
      voiceReturnState = STATES.NOW_BROWSE;
      transition(STATES.VOICE_OPEN, {
        answeringQuestion: {
          index: 0,
          nodeId: activeQuestion.node_id || '',
          text: softenGuidedAsk(activeQuestion?.body || activeQuestion?.title || ''),
          source: activeQuestion.source || 'question'
        },
        fromPTT: false
      });
      return;
    }
    openTellSurface({ returnState: STATES.NOW_BROWSE });
  }

  function approveCurrentNowDecision() {
    const project = getProjectMemory();
    const pending = project?.pending_decisions || [];
    const decisionIndex = stateData.decisionIndex || 0;
    if (!(pending.length && decisionIndex < pending.length)) return false;
    const current = pending[decisionIndex];
    const options = (typeof current !== 'string' && current?.options) || [];
    const selectedOptionIndex = Math.max(0, Math.min(stateData.selectedOption || 0, Math.max(options.length - 1, 0)));
    const selectedOption = options.length ? options[selectedOptionIndex] : null;
    native?.approvePendingDecision?.(decisionIndex, selectedOptionIndex, selectedOption);
    window.StructaLLM?.speakMilestone?.('decision_approved');
    pushLog(selectedOption ? `decision approved: ${selectedOption}` : 'decision approved', 'decision');
    stateData.decisionIndex = 0;
    stateData.selectedOption = 0;
    stateData.nowFeedback = 'decision queued';
    setTimeout(function() {
      if (stateData.nowFeedback === 'decision queued') {
        stateData.nowFeedback = '';
        scheduleRender();
      }
    }, 520);
    scheduleRender();
    return true;
  }

  function dismissCurrentNowDecision() {
    const project = getProjectMemory();
    const pending = project?.pending_decisions || [];
    const decisionIndex = stateData.decisionIndex || 0;
    if (!(pending.length && decisionIndex < pending.length)) return false;
    native?.dismissPendingDecision?.(decisionIndex);
    pushLog('decision skipped', 'decision');
    stateData.decisionIndex = 0;
    stateData.selectedOption = 0;
    scheduleRender();
    return true;
  }

  function advanceCurrentNowDecision() {
    const project = getProjectMemory();
    const pending = project?.pending_decisions || [];
    if (pending.length <= 1) return false;
    stateData.decisionIndex = ((stateData.decisionIndex || 0) + 1) % pending.length;
    stateData.selectedOption = 0;
    scheduleRender();
    return true;
  }

  function retryCurrentQueueBlocker() {
    const blocker = buildNowSummary().queueBlocker;
    if (!blocker || !processingQueue?.retry) {
      fireFeedback('blocked');
      return false;
    }
    const didRetry = processingQueue.retry(blocker.id);
    if (!didRetry) {
      fireFeedback('blocked');
      return false;
    }
    fireFeedback('touch-commit');
    const remaining = (getUIState().queue_blockers || []).filter(function(entry) {
      return entry.id !== blocker.id;
    });
    native?.updateUIState?.({ queue_blockers: remaining });
    stateData.nowFeedback = 'retry queued';
    setTimeout(function() {
      if (stateData.nowFeedback === 'retry queued') {
        stateData.nowFeedback = '';
        scheduleRender();
      }
    }, 520);
    scheduleRender();
    return true;
  }

  function skipCurrentQueueBlocker() {
    const blocker = buildNowSummary().queueBlocker;
    if (!blocker) {
      fireFeedback('blocked');
      return false;
    }
    fireFeedback('touch-commit');
    processingQueue?.cancel?.(blocker.id);
    if (blocker.kind === 'image-analyze') {
      window.StructaCamera?.skipBlockedAnalysis?.(blocker.payload?.entryId, blocker.payload?.nodeId);
    }
    const remaining = (getUIState().queue_blockers || []).filter(function(entry) {
      return entry.id !== blocker.id;
    });
    native?.updateUIState?.({ queue_blockers: remaining });
    scheduleRender();
    return true;
  }

  function openProjectSwitcher() {
    if (onboardingActive() && !onboardingAllowsProjectSwitcher()) return;
    const projects = getProjects();
    if (!projects.length) return;
    const activeId = getActiveProjectId();
    const index = Math.max(0, projects.findIndex(project => project.project_id === activeId));
    transition(STATES.PROJECT_SWITCHER, { projectListIndex: index });
  }

  function getProjectSwitcherRows() {
    const projects = getProjects();
    const activeCount = projects.filter(function(project) { return project.status !== 'archived'; }).length;
    const rows = projects.map(function(project) {
      return { type: 'project', project: project };
    });
    if (activeCount < 3) rows.push({ type: 'add' });
    return rows;
  }

  function openNewProjectFlow() {
    voiceReturnState = STATES.PROJECT_SWITCHER;
    transition(STATES.VOICE_OPEN, {
      fromPTT: true,
      tellStatus: 'name project',
      inlinePTTSurface: 'project',
      buildContext: {
        kind: 'new-project-name',
        text: 'name a new project',
        surface: 'project_switcher'
      }
    });
  }

  function activateSelectedProject() {
    const rows = getProjectSwitcherRows();
    if (!rows.length) {
      fireFeedback('blocked');
      return false;
    }
    if (onboardingActive() && getOnboardingStep() === 1) {
      fireFeedback('touch-commit');
      setOnboardingStep(2, { via: 'primary' });
      pushLog('lesson 1 complete', 'system');
      transition(STATES.NOW_BROWSE);
      return true;
    }
    const selectedIndexValue = typeof stateData.projectListIndex === 'number' ? stateData.projectListIndex : 0;
    const index = Math.max(0, Math.min(selectedIndexValue, rows.length - 1));
    const row = rows[index];
    if (!row) {
      fireFeedback('blocked');
      return false;
    }
    if (row.type === 'add') {
      fireFeedback('touch-commit');
      openNewProjectFlow();
      return true;
    }
    const project = row.project;
    fireFeedback('touch-commit');
    native?.switchProject?.(project.project_id);
    pushLog(`project: ${project.name}`, 'voice');
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: 'project-switch' }
    }));
    transition(STATES.HOME);
    return true;
  }

  function clearFlushRequest(options = {}) {
    clearFlushConfirmTimer();
    const source = stateData.flushRequestSource || '';
    const step = onboardingActive() ? getOnboardingStep() : 'complete';
    stateData.flushRequestSource = '';
    stateData.flushConfirmHolding = false;
    if (options.trace !== false && source) {
      traceTutorial('flush', 'cancelled', source, { from: source, step: step });
    }
  }

  function requestFlush(source = 'home') {
    if (!allowMenuFlush() || !native?.flushMemory) return false;
    clearPendingSideClick();
    clearFlushRequest({ trace: false });
    stateData.projectFlushConfirm = false;
    stateData.flushRequestSource = source;
    stateData.flushConfirmHolding = false;
    traceTutorial('flush', 'requested', source, {
      from: source,
      step: onboardingActive() ? getOnboardingStep() : 'complete'
    });
    selectedIndex = cards.findIndex(function(card) { return card.id === 'now'; });
    transition(STATES.NOW_BROWSE);
    return true;
  }

  function confirmFlushRequest() {
    if (!stateData.flushRequestSource || !native?.flushMemory) return false;
    const source = stateData.flushRequestSource;
    const step = onboardingActive() ? getOnboardingStep() : 'complete';
    clearFlushConfirmTimer();
    stateData.flushConfirmHolding = false;
    traceTutorial('flush', 'confirmed', source, { from: source, step: step });
    if (onboardingActive()) {
      traceTutorial('tutorial', 'flushed_mid', String(step), { step: step, from: source });
    }
    native.flushMemory().then(function() {
      const undoAvailable = Number(native?.getUIState?.()?.flush_undo_available_until || 0) > Date.now();
      resetTutorialSurfaceState();
      native?.updateUIState?.({
        selected_card_id: 'now',
        last_surface: 'home',
        onboarding_paused: false,
        tutorial_step2_fallback_visible: false,
        tutorial_step2_fallback_reason: '',
        tutorial_step2_fallback_index: 0,
        tutorial_step2_ptt_attempted: false,
        tutorial_step4_camera_denied: false
      });
      if (window.StructaHeartbeat?.stop) {
        try { window.StructaHeartbeat.stop(); } catch (_) {}
      }
      if (window.StructaImpactChain?.pause) {
        try { window.StructaImpactChain.pause('memory flush'); } catch (_) {}
      }
      chainStarted = false;
      selectedIndex = cards.findIndex(function(card) { return card.id === 'now'; });
      transition(undoAvailable ? STATES.NOW_BROWSE : STATES.HOME);
      setTimeout(function() {
        window.StructaUIRuntime?.refreshBundle?.('flush');
      }, 40);
    }).catch(function() {
      clearFlushRequest({ trace: false });
      render();
    });
    return true;
  }

  function tutorialStep2FallbackIndex() {
    return Math.max(0, Math.min(Number(getUIState().tutorial_step2_fallback_index || 0), TUTORIAL_FALLBACK_OPTIONS.length - 1));
  }

  function skipTutorialStep(step, reason = 'long-press-home') {
    if (!tutorialSkipEligible(step)) return false;
    if (step === 2) {
      native?.updateUIState?.({
        onboarding_step2_skipped: true,
        tutorial_step2_fallback_visible: true,
        tutorial_step2_fallback_reason: 'skip'
      });
      traceTutorial('tutorial.step', 'skip', '2', { step: 2, reason: reason });
      setOnboardingStep(3, { via: 'skip' });
      transition(STATES.NOW_BROWSE);
      return true;
    }
    if (step === 4) {
      native?.updateUIState?.({
        onboarding_step4_skipped: true,
        tutorial_step4_camera_denied: false
      });
      traceTutorial('tutorial.step', 'skip', '4', { step: 4, reason: reason });
      completeOnboarding();
      return true;
    }
    return false;
  }

  function submitTutorialWheelFallback() {
    if (!onboardingActive() || getOnboardingStep() !== 2) return false;
    const answer = TUTORIAL_FALLBACK_OPTIONS[tutorialStep2FallbackIndex()] || TUTORIAL_FALLBACK_OPTIONS[0];
    native?.updateUIState?.({
      tutorial_step2_fallback_visible: true,
      tutorial_step2_fallback_reason: 'wheel'
    });
    window.dispatchEvent(new CustomEvent('structa-onboarding-answer', {
      detail: {
        answer: answer,
        origin: 'tutorial_fallback_wheel',
        inferredName: ''
      }
    }));
    return true;
  }

  function flushTestingMemory() {
    return requestFlush('switcher');
  }

  // === Surface identification (backward compat for render) ===
  function activeSurface() {
    switch (currentState) {
      case STATES.HOME:
      case STATES.PROJECT_SWITCHER:
      case STATES.TELL_PRIMED:
      case STATES.LOG_OPEN:
        return 'home';
      case STATES.TELL_BROWSE:
        return 'tell';
      case STATES.SHOW_BROWSE:
        return 'show';
      case STATES.SHOW_PRIMED:
      case STATES.CAMERA_OPEN:
      case STATES.CAMERA_CAPTURE:
        return 'camera';
      case STATES.VOICE_OPEN:
      case STATES.VOICE_PROCESSING:
      case STATES.KNOW_ANSWER:
        return stateData.inlinePTTSurface || 'voice';
      case STATES.TRIANGLE_OPEN:
        return 'triangle';
      case STATES.KNOW_BROWSE:
      case STATES.KNOW_DETAIL:
        return 'insight';
      case STATES.NOW_BROWSE:
        return 'project';
      default:
        return 'home';
    }
  }

  function surfaceIsVisible(surface) {
    return !!surface && activeSurface() === surface;
  }

  // === Notification system (spring-jump) ===
  function notifyCard(cardId, severity) {
    if (currentState !== STATES.HOME) return;
    const cardIndex = cards.findIndex(c => c.id === cardId);
    if (cardIndex < 0) return;
    const el = document.querySelector(`[data-card-index="${cardIndex}"]`);
    if (el) {
      el.classList.add(`notify-${severity}`);
      setTimeout(() => el.classList.remove(`notify-${severity}`), 1200);
    }
  }

  // === Heartbeat ===
  function maybeStartHeartbeat() {
    if (onboardingActive()) return;
    if (window.StructaHeartbeat && window.StructaHeartbeat.bpm === 0) {
      if (projectHasMeaningfulContent()) {
        window.StructaHeartbeat.start(3);
      }
    }
  }

  function projectHasMeaningfulContent() {
    const project = getProjectMemory();
    const captures = (project?.captures?.length || 0) + getCaptureList().length;
    const voiceEntries = getVoiceEntries().length;
    const count =
      (project?.backlog?.length || 0) +
      (project?.insights?.length || 0) +
      (project?.open_questions?.length || 0) +
      (project?.pending_decisions?.length || 0) +
      (project?.decisions?.length || 0) +
      (project?.nodes?.length || 0) +
      captures +
      voiceEntries;
    return count > 0;
  }

  // === NOW card builder ===
  function buildNowSummary() {
    const memory = getMemory();
    const project = getProjectMemory();
    const ui = getUIState();
    const onboardingStep = getOnboardingStep();
    const captures = getCaptureList();
    const insights = project?.insights || [];
    const allQuestionNodes = project?.open_question_nodes || [];
    const suppressBlockers = (stateData.nowHideQuestionsUntil || 0) > Date.now();
    const openQuestionNodes = suppressBlockers
      ? []
      : allQuestionNodes.filter(function(question) {
          return native?.isBlockerLive?.({
            nodeId: question?.node_id || '',
            text: question?.body || question?.title || '',
            createdAt: question?.created_at || ''
          }) !== false;
        });
    const openQuestions = openQuestionNodes.length
      ? openQuestionNodes.map(function(question) {
          return softenGuidedAsk(question?.body || question);
        })
      : (project?.open_questions || []).map(function(question) {
          return softenGuidedAsk(question);
        });
    const queueBlockers = Array.isArray(ui.queue_blockers) ? ui.queue_blockers : [];
    const queueBlocker = queueBlockers[0] || null;
    const projectCapNotice = lower(ui.project_cap_notice || '');
    const backlog = project?.backlog || [];
    const decisions = project?.decisions || [];
    const pendingDecisions = project?.pending_decisions || [];
    const decIdx = stateData.decisionIndex || 0;

    // Impact chain state
    const chain = window.StructaImpactChain || {};
    const chainPhase = chain.phase || 'idle';
    const chainActive = chain.active || false;
    const chainImpacts = chain.impacts || [];
    const chainBpm = chain.bpm || 4;
    const chainBeatCount = chain.beatCount || 0;
    const lastImpact = chain.lastImpact || null;
    const totalImpacts = chain.totalImpacts || 0;
    const totalDecisions = chain.totalDecisions || 0;
    const cooldownRemaining = chain.cooldownRemaining || 0;

    // Latest impact chain from storage
    const storedImpacts = project?.impact_chain || [];
    const blockerQuestion = queueBlocker?.body || projectCapNotice || openQuestions[0] || '';
    const blockerCount = pendingDecisions.length + openQuestions.length + (queueBlocker ? 1 : 0) + (projectCapNotice ? 1 : 0);
    const activePendingDecision = pendingDecisions.length ? (pendingDecisions[decIdx] || pendingDecisions[0]) : null;
    const activeQuestionNode = openQuestionNodes[0] || null;
    const activeThread = activePendingDecision?.thread || activeQuestionNode?.thread || [];
    const activeThreadSummary = activePendingDecision?.thread_summary || activeQuestionNode?.thread_summary || '';
    const tutorialFallbackIndex = tutorialStep2FallbackIndex();

    return {
      title: project?.name || 'new project',
      changed: ui.user_status || ui.last_event_summary || '',
      capture: ui.last_capture_summary || (captures[captures.length - 1]?.summary || ''),
      insight: ui.last_insight_summary || (insights[0]?.body || ''),
      next: backlog[0]?.title || (blockerQuestion ? `answer: ${blockerQuestion.slice(0, 30)}` : ''),
      openQuestions: openQuestions.length,
      captures: captures.length,
      insights: insights.length,
      decisions: decisions.length,
      pendingDecisions: pendingDecisions,
      pendingDecisionText: pendingDecisions.length ? (typeof pendingDecisions[0] === 'string' ? pendingDecisions[0] : pendingDecisions[0].text) : null,
      pendingDecisionIndex: decIdx,
      pendingDecisionOptions: pendingDecisions.length ? (typeof pendingDecisions[0] === 'string' ? [] : (pendingDecisions[0].options || [])) : [],
      activePendingDecision: activePendingDecision,
      activeQuestionNode: activeQuestionNode,
      activeQuestionNodeId: activeQuestionNode?.node_id || '',
      activeThreadSummary: activeThreadSummary,
      activeThreadDepth: threadDepth(activeThread),
      blockerCount,
      blockerQuestion,
      queueBlocker,
      projectCapNotice,
      chainPhase,
      chainActive,
      chainImpacts,
      chainBpm,
      chainBeatCount,
      lastImpact,
      totalImpacts,
      totalDecisions,
      cooldownRemaining,
      storedImpacts: storedImpacts.slice(0, 5),
      onboardingStep,
      onboardingPaused: false,
      flushRequested: !!stateData.flushRequestSource,
      flushRequestSource: stateData.flushRequestSource || '',
      tutorialStep2FallbackVisible: !!ui.tutorial_step2_fallback_visible,
      tutorialStep2FallbackReason: ui.tutorial_step2_fallback_reason || '',
      tutorialStep2FallbackIndex: tutorialFallbackIndex,
      tutorialStep2FallbackOptions: TUTORIAL_FALLBACK_OPTIONS.slice(),
      tutorialStep4CameraDenied: !!ui.tutorial_step4_camera_denied,
      flushUndoAvailableUntil: Number(ui.flush_undo_available_until || 0),
      flushUndoAvailable: Number(ui.flush_undo_available_until || 0) > Date.now()
    };
  }

  function drawOnboardingNowPanel(nowCard, data) {
    const step = getOnboardingStep();
    const cardY = 84;
    mk('rect', { x: 10, y: cardY, width: 220, height: 158, rx: 12, fill: 'rgba(8,8,8,0.13)' });

    if (data.flushUndoAvailable) {
      text(18, cardY + 18, 'flush complete', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, 'hold ptt to undo and restore the last snapshot.', 18, cardY + 48, 194, 14, 'rgba(8,8,8,0.80)', '13', 4);
      mk('rect', { x: 18, y: cardY + 110, width: 138, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
      text(30, cardY + 126, 'hold ptt to undo', {
        fill: 'rgba(244,239,228,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'undo stays for 120s', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    if (data.flushRequested) {
      text(18, cardY + 18, 'flush tutorial state?', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, 'flush clears this project and restarts tutorial.', 18, cardY + 48, 194, 14, 'rgba(8,8,8,0.80)', '13', 4);
      mk('rect', { x: 18, y: cardY + 110, width: 154, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
      text(30, cardY + 126, 'hold ptt to confirm', {
        fill: 'rgba(244,239,228,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'side click cancels', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    if (step === 0) {
      text(18, cardY + 18, 'welcome to structa', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, 'this is your project surface. everything starts here.', 18, cardY + 46, 194, 14, 'rgba(8,8,8,0.78)', '13', 4);
      mk('rect', { x: 18, y: cardY + 116, width: 116, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
      text(30, cardY + 132, 'click → begin', {
        fill: 'rgba(244,239,228,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'lesson 1 of 4', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    if (step === 1) {
      text(18, cardY + 18, 'lesson 1 · shake to stack', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, 'shake the device to see your projects. this is how you switch context.', 18, cardY + 46, 194, 14, 'rgba(8,8,8,0.78)', '13', 5);
      text(18, cardY + 132, 'shake now →', {
        fill: 'rgba(8,8,8,0.54)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'lesson 2 unlocks after stack', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    if (step === 2) {
      text(18, cardY + 18, 'lesson 2 · hold ptt', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      mk('rect', { x: 14, y: cardY + 30, width: 3, height: 108, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.76)' });
      wrapTextBlock(undefined, 'what is this project about?', 20, cardY + 50, 190, 15, 'rgba(8,8,8,0.96)', '16', 4);
      if (data.tutorialStep2FallbackVisible) {
        const baseY = cardY + 96;
        data.tutorialStep2FallbackOptions.forEach(function(option, index) {
          const selected = index === data.tutorialStep2FallbackIndex;
          mk('rect', {
            x: 18, y: baseY + (index * 20), width: 176, height: 16, rx: 6, ry: 6,
            fill: selected ? 'rgba(8,8,8,0.92)' : 'rgba(8,8,8,0.10)'
          });
          text(24, baseY + 11 + (index * 20), lower(option), {
            fill: selected ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.84)',
            'font-family': 'PowerGrotesk-Regular, sans-serif',
            'font-size': '10'
          });
        });
        text(20, cardY + 156, 'voice did not catch — scroll, then click', {
          fill: 'rgba(8,8,8,0.46)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
      } else {
        mk('rect', { x: 18, y: cardY + 118, width: 148, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
        text(30, cardY + 134, 'hold ptt → answer', {
          fill: 'rgba(244,239,228,0.96)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '12'
        });
      }
      text(226, 276, data.tutorialStep2FallbackVisible ? 'scroll → choose · click confirms' : 'answer in your own words', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    if (step === 3) {
      text(18, cardY + 18, 'lesson 3 · open know', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, 'know is ready. click know to open the project map.', 18, cardY + 46, 194, 14, 'rgba(8,8,8,0.78)', '13', 5);
      text(18, cardY + 132, 'click know →', {
        fill: 'rgba(8,8,8,0.54)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'show is next', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    return false;
  }

  // === KNOW card builder ===
  function textHasAny(text = '', terms = []) {
    const value = lower(text);
    return terms.some(term => value.includes(term));
  }

  function formatTimeLabel(raw) {
    if (!raw) return 'recent';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return 'recent';
    return lower(date.toLocaleDateString([], { month: 'short', day: 'numeric' }));
  }

  function buildKnowModel() {
    const activeProjectId = getActiveProjectId();
    const focusNodeId = stateData.knowFocusNodeId || '';
    if (
      cachedKnowModel.version === dataCacheVersion &&
      cachedKnowModel.projectId === activeProjectId &&
      cachedKnowModel.focusNodeId === focusNodeId &&
      cachedKnowModel.value
    ) {
      return cachedKnowModel.value;
    }
    const memory = getMemory();
    const project = getProjectMemory();
    const ui = getUIState();
    const chips = [
      { id: 'latest', label: 'latest' },
      { id: 'branch', label: 'branch' },
      { id: 'asks', label: 'asks' },
      { id: 'frames', label: 'frames' }
    ];

    const classify = item => {
      const text = lower(`${item.title} ${item.body} ${item.next}`);
      const bucket = new Set(item.chips || []);
      if (item.source === 'question') bucket.add('asks');
      if (item.source === 'asset' || item.source === 'capture-image') bucket.add('frames');
      if (item.next && textHasAny(item.next, ['next', 'capture', 'answer', 'send', 'review', 'fix', 'act', 'move', 'plan'])) bucket.add('branch');
      item.chips = Array.from(bucket);
      return item;
    };

    const makeItem = ({ lane, title, body, next, created_at, source, chips: chipHints = [], questionIndex, node_id, links = [], triangulated = false, thread = [], threadDepth: providedThreadDepth = null, threadSummary = '', meta = {} }) => {
      const claimsForItem = node_id ? (native?.getClaimsForItem?.(node_id) || []).filter(function(claim) {
        const statusValue = lower(claim?.status || 'active');
        return statusValue === 'active' || statusValue === 'disputed';
      }) : [];
      const evidenceStrength = claimsForItem.reduce(function(max, claim) {
        return Math.max(max, Array.isArray(claim?.evidence) ? claim.evidence.length : 0);
      }, 0);
      const normalizedMeta = meta && typeof meta === 'object' ? JSON.parse(JSON.stringify(meta)) : {};
      const triangleClaims = triangulated
        ? claimsForItem.filter(function(claim) { return lower(claim?.source || '') === 'triangle'; })
        : [];
      const triangleBody = triangulated && normalizedMeta?.triangle_format === 'claims-v1' && triangleClaims.length
        ? triangleClaims.slice(0, 3).map(function(claim) { return lower(normalizeTinyText(claim?.text || '')); }).join('\n')
        : '';
      return classify({
      lane,
      title: lower(normalizeTinyText(title || lane)),
      body: lower(normalizeTinyText(triangleBody || body || '')),
      next: lower(normalizeTinyText(next || '')),
      created_at: created_at || new Date().toISOString(),
      source: source || lane,
      chips: chipHints.slice(),
      questionIndex,
      node_id: node_id || '',
      links: Array.isArray(links) ? links.slice() : [],
      triangulated: !!triangulated,
      meta: normalizedMeta,
      claimsForItem: claimsForItem,
      thread: cloneThread(thread),
      threadDepth: Math.max(0, Number(providedThreadDepth !== null ? providedThreadDepth : threadDepth(thread))),
      threadSummary: lower(normalizeTinyText(threadSummary || '')),
      evidenceStrength: evidenceStrength
    });
    };

    const questions = [];
    const signals = [];
    const decisionsLane = [];
    const loops = [];

    const insights = project?.insights || [];
    const captures = project?.captures || [];
    const backlog = project?.backlog || [];
    const decisions = project?.decisions || [];
    const openQuestions = project?.open_question_nodes || [];

    // Questions lane
    openQuestions.slice(0, 5).forEach((question, index) => {
      const guidedAsk = softenGuidedAsk(question?.body || question);
      const questionThread = cloneThread(question?.thread);
      questions.push(makeItem({
        lane: 'questions', title: index === 0 ? 'guided ask' : `guided ask ${index + 1}`, body: guidedAsk,
        next: '', created_at: question?.created_at || new Date().toISOString(),
        source: 'question', chips: ['asks'], questionIndex: index, node_id: question?.node_id || '', links: question?.links || [],
        thread: questionThread, threadDepth: threadDepth(questionThread), threadSummary: question?.thread_summary || (questionThread[questionThread.length - 1]?.summary || '')
      }));
    });

    if (!questions.length) {
      questions.push(makeItem({
        lane: 'questions', title: 'no asks', body: 'structa will open the next branch here',
        next: '',
        created_at: new Date().toISOString(), source: 'empty', chips: ['latest']
      }));
    }

    // Signals
    if (ui.last_insight_summary || ui.last_capture_summary) {
      signals.push(makeItem({
        lane: 'signals', title: 'working signal',
        body: ui.last_insight_summary || ui.last_capture_summary,
        next: backlog[0]?.title || '',
        created_at: new Date().toISOString(), source: 'ui', chips: ['latest', 'branch']
      }));
    }

    insights.slice(0, 4).forEach((insight, index) => {
      const insightThread = cloneThread(insight.thread);
      signals.push(makeItem({
        lane: 'signals', title: insight.title || `signal ${index + 1}`,
        body: insight.body || 'extracted',
        next: backlog[0]?.title || '',
        created_at: insight.created_at, source: insight.source || 'insight', chips: index < 2 ? ['latest'] : [],
        triangulated: !!insight.triangulated || lower(insight.source || '') === 'triangle',
        node_id: insight.node_id, links: insight.links, thread: insightThread, threadDepth: threadDepth(insightThread),
        threadSummary: insight.thread_summary || (insightThread[insightThread.length - 1]?.summary || ''),
        meta: insight.meta || {}
      }));
    });

    captures.slice(-4).reverse().forEach((capture, index) => {
      const captureThread = cloneThread(capture.thread);
      signals.push(makeItem({
        lane: 'signals', title: capture.type === 'image' ? 'visual note' : 'voice note',
        body: capture.summary || 'stored',
        next: backlog[0]?.title || '',
        created_at: capture.created_at,
        source: capture.type === 'image' ? 'capture-image' : 'capture', chips: index < 2 ? ['latest'] : [],
        node_id: capture.node_id, links: capture.links, thread: captureThread, threadDepth: threadDepth(captureThread),
        threadSummary: capture.thread_summary || (captureThread[captureThread.length - 1]?.summary || '')
      }));
    });

    // Decisions
    decisions.slice(0, 5).forEach((decision, index) => {
      const decisionTitle = typeof decision === 'string' ? decision : (decision.title || `decision ${index + 1}`);
      const decisionBody = typeof decision === 'string' ? decision : (decision.body || decision.reason || 'locked');
      const decisionThread = cloneThread(decision.thread);
      decisionsLane.push(makeItem({
        lane: 'decisions', title: decisionTitle, body: decisionBody,
        next: backlog[0]?.title || '',
        created_at: decision.created_at, source: 'decision', chips: index === 0 ? ['latest'] : [],
        node_id: decision.node_id, links: decision.links, thread: decisionThread, threadDepth: threadDepth(decisionThread),
        threadSummary: decision.thread_summary || (decisionThread[decisionThread.length - 1]?.summary || '')
      }));
    });

    if (!decisionsLane.length) {
      decisionsLane.push(makeItem({
        lane: 'decisions', title: 'no decisions',
        body: 'no decisions yet',
        next: '',
        created_at: new Date().toISOString(), source: 'decision-gap', chips: []
      }));
    }

    // Loops
    backlog.slice(0, 5).forEach((item, index) => {
      const backlogThread = cloneThread(item.thread);
      loops.push(makeItem({
        lane: 'open loops', title: item.title || `task ${index + 1}`,
        body: item.body || item.state || 'open',
        next: item.title || '',
        created_at: item.created_at, source: 'backlog', chips: ['branch'], node_id: item.node_id || '', links: item.links || [],
        thread: backlogThread, threadDepth: threadDepth(backlogThread),
        threadSummary: item.thread_summary || (backlogThread[backlogThread.length - 1]?.summary || '')
      }));
    });

    const lanes = [
      { id: 'questions', label: 'asks', summary: 'guided asks', items: questions },
      { id: 'signals', label: 'signals', summary: 'working signals', items: signals.length ? signals : [makeItem({ lane: 'signals', title: 'no signals', body: 'hold ptt or open show to begin shaping signal', next: '', created_at: new Date().toISOString(), source: 'empty', chips: ['latest'] })] },
      { id: 'decisions', label: 'decisions', summary: 'locked decisions', items: decisionsLane },
      { id: 'open loops', label: 'tasks', summary: 'open tasks', items: loops.length ? loops : [makeItem({ lane: 'open loops', title: 'no tasks', body: 'new tasks gather here as the project grows', next: '', created_at: new Date().toISOString(), source: 'empty', chips: [] })] }
    ].map(lane => {
      lane.items
        .sort((a, b) => {
          if (focusNodeId) {
            const aLinked = a.node_id === focusNodeId || (a.links || []).includes(focusNodeId);
            const bLinked = b.node_id === focusNodeId || (b.links || []).includes(focusNodeId);
            if (aLinked !== bLinked) return aLinked ? -1 : 1;
          }
          return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        })
        .forEach((item, index) => {
          if (index < 2 && !item.chips.includes('latest')) item.chips.push('latest');
        });
      const availableChipIndexes = chips
        .map((chip, index) => lane.items.some(item => item.chips.includes(chip.id)) ? index : -1)
        .filter(index => index >= 0);
      return { ...lane, availableChipIndexes: availableChipIndexes.length ? availableChipIndexes : [0] };
    });

    cachedKnowModel = {
      version: dataCacheVersion,
      projectId: activeProjectId,
      focusNodeId: focusNodeId,
      value: { chips, lanes }
    };
    return cachedKnowModel.value;
  }

  function getKnowVisibleItems(model = buildKnowModel()) {
    const lane = model.lanes[stateData.knowLaneIndex || 0] || model.lanes[0];
    if (!lane) return [];
    const chipId = model.chips[stateData.knowChipIndex || 0]?.id || model.chips[0]?.id;
    const filtered = lane.items.filter(item => item.chips.includes(chipId));
    return filtered.length ? filtered : lane.items;
  }

  function getKnowHintText(item, lane, itemsCount, detailMode) {
    if (!item) return itemsCount > 1 ? 'scroll items' : 'hold ptt';
    if (item.source === 'question') {
      return detailMode
        ? 'hold ptt to answer'
        : (itemsCount > 1 ? 'scroll asks · hold ptt to answer' : 'hold ptt to answer');
    }
    return detailMode
      ? (itemsCount > 1 ? 'scroll items · hold ptt to reflect' : 'hold ptt to reflect')
      : (itemsCount > 1 ? 'scroll items · click detail' : 'click detail');
  }

  // === SVG rendering helpers ===
  function cardLayout(index) {
    if (index === selectedIndex) return { x: 106, y: 62, scale: 1.62, opacity: 1, depth: -1 };
    const depth = ((selectedIndex - index - 1 + cards.length) % cards.length);
    var heroCenterY = 62 + (150 * 1.62) / 2;
    var scales = [0.54, 0.74, 0.96];
    var xPositions = [18, 46, 74];
    var stack = scales.map(function(s, i) {
      var cardH = 150 * s;
      return { x: xPositions[i], y: heroCenterY - cardH / 2, scale: s, opacity: 1, depth: i };
    });
    return stack[Math.min(depth, stack.length - 1)];
  }

  function mk(name, attrs = {}, parent = svg) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    parent.appendChild(el);
    return el;
  }

  function text(x, y, value, attrs = {}, parent = svg) {
    const el = mk('text', { x, y, ...attrs }, parent);
    el.textContent = value;
    return el;
  }

  function image(href, attrs = {}, parent = svg) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    el.setAttribute('href', href);
    try {
      el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
    } catch (_) {}
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    parent.appendChild(el);
    return el;
  }

  function drawRasterFrame(href, attrs = {}, parent = svg) {
    if (!href) return null;
    const useForeignObject = /^data:image|^blob:/i.test(href);
    if (!useForeignObject) return image(href, attrs, parent);

    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    Object.entries(attrs).forEach(([key, value]) => fo.setAttribute(key, value));
    const wrapper = document.createElement('div');
    wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.overflow = 'hidden';
    wrapper.style.borderRadius = ((attrs.rx || 0) + 'px');
    wrapper.style.opacity = attrs.opacity != null ? String(attrs.opacity) : '1';
    const img = document.createElement('img');
    img.src = href;
    img.alt = '';
    img.draggable = false;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.display = 'block';
    img.style.objectFit = 'cover';
    img.style.objectPosition = 'center';
    wrapper.appendChild(img);
    fo.appendChild(wrapper);
    parent.appendChild(fo);
    return fo;
  }

  let iconClipCounter = 0;
  function drawFramedIcon(href, frame, parent = svg, options = {}) {
    const inset = typeof options.inset === 'number' ? options.inset : 1.25;
    const clipId = `structa-icon-clip-${iconClipCounter++}`;
    const clip = mk('clipPath', { id: clipId }, svg);
    mk('rect', {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      rx: frame.rx || 0,
      ry: frame.ry || frame.rx || 0
    }, clip);
    return image(href, {
      x: frame.x - inset,
      y: frame.y - inset,
      width: frame.width + (inset * 2),
      height: frame.height + (inset * 2),
      preserveAspectRatio: options.preserveAspectRatio || 'xMidYMid slice',
      opacity: options.opacity == null ? 1 : options.opacity,
      style: options.style || 'filter: brightness(0) saturate(100%);',
      'clip-path': `url(#${clipId})`
    }, parent);
  }

  function drawTriangleIndicator() {
    if (!triangleIndicatorVisible()) return;
    const triangle = getTriangleState();
    const armedItem = triangle.mode === 'armed'
      ? triangle.item
      : (triangle.mode === 'synthesizing' ? triangle.pair?.a : null);
    const x = 8;
    const y = 264;
    const fill = triangle.mode === 'empty'
      ? 'rgba(244,239,228,0.18)'
      : triangleColor(armedItem);
    if (triangle.mode !== 'empty' && armedItem) {
      text(x + 7, y - 2, triangleInitial(armedItem), {
        fill: 'rgba(244,239,228,0.82)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '8',
        'text-anchor': 'middle'
      });
    }
    mk('path', {
      d: `M ${x} ${y} L ${x + 7} ${y + 12} L ${x + 14} ${y} Z`,
      fill: fill,
      opacity: triangle.mode === 'empty' ? '0.68' : '1'
    });
  }

  function drawAmbientQueueIndicator() {
    if (logOpen || currentState === STATES.LOG_OPEN) return;
    const jobs = getQueuePendingJobs();
    const depth = jobs.length;
    const width = depth ? Math.min(220, 24 + depth * 28) : 220;
    const opacity = depth ? String(0.96 + (Math.sin(Date.now() / 260) * 0.04)) : '0.08';
    const fill = depth ? getQueueTierColor(jobs[0].priority) : 'rgba(244,239,228,0.18)';
    const indicator = mk('rect', {
      x: 10,
      y: 288,
      width: width,
      height: 2,
      rx: 1,
      ry: 1,
      fill: fill,
      opacity: opacity,
      style: onboardingAllowsLogs() ? 'cursor: pointer;' : ''
    });
    if (onboardingAllowsLogs()) {
      indicator.addEventListener('pointerup', function(event) {
        event.preventDefault();
        event.stopPropagation();
        fireFeedback('touch-commit');
        transition(STATES.LOG_OPEN);
      });
    }
  }

  function drawKnowItemDots(count, currentIndex, x, y) {
    const safeCount = Math.max(1, count || 1);
    for (let index = 0; index < safeCount; index += 1) {
      mk('circle', {
        cx: x + (index * 8),
        cy: y,
        r: index === currentIndex ? 2 : 1.5,
        fill: index === currentIndex ? 'rgba(8,8,8,0.88)' : 'transparent',
        stroke: index === currentIndex ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.30)',
        'stroke-width': index === currentIndex ? 0 : 1
      });
    }
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function drawKnowDepthGlyph(depth, x, y, parent = svg) {
    const bars = depth > 0 ? threadBars(depth) : 0;
    const group = mk('g', {}, parent);
    for (let index = 0; index < 3; index += 1) {
      const active = index < bars;
      mk('rect', {
        x: x + (index * 5),
        y: y + (6 - index * 2),
        width: 3,
        height: 6 + (index * 2),
        rx: 1,
        ry: 1,
        fill: active ? 'rgba(248,193,93,0.88)' : 'rgba(8,8,8,0.14)',
        opacity: depth > 0 ? '1' : '0.22',
        stroke: active ? 'rgba(8,8,8,0.10)' : 'rgba(8,8,8,0.10)',
        'stroke-width': active ? 0.4 : 0
      }, group);
    }
    return group;
  }

  function drawKnowEvidenceGlyph(strength, x, y, parent = svg) {
    const safe = Math.max(0, Number(strength || 0));
    const opacity = safe >= 2 ? 0.88 : 0.30;
    const group = mk('g', {}, parent);
    for (let index = 0; index < 3; index += 1) {
      mk('rect', {
        x: x + (index * 3),
        y: y + (index % 2 === 0 ? 0 : 2),
        width: 2,
        height: 5,
        rx: 1,
        ry: 1,
        fill: safe >= 2 ? 'rgba(248,193,93,0.88)' : 'rgba(8,8,8,0.44)',
        opacity: opacity
      }, group);
    }
    return group;
  }

  function rejectTriangleSignal(item) {
    if (!item?.triangulated || !item?.node_id) return false;
    const derivedClaims = Array.isArray(item?.claimsForItem)
      ? item.claimsForItem.filter(function(claim) { return lower(claim?.source || '') === 'triangle'; })
      : [];
    derivedClaims.forEach(function(claim) {
      native?.setClaimStatus?.(claim.id, 'superseded', {
        reason: 'triangle rejected'
      });
    });
    native?.archiveNode?.(item.node_id);
    native?.traceEvent?.('triangle.synth.rejected_by_user', item.node_id, 'archived', {
      signalId: item.node_id,
      claimCount: derivedClaims.length
    });
    pushLog('triangle rejected', 'triangle');
    return true;
  }

  function buildKnowFrameMarkup(item, detailMode) {
    const thread = cloneThread(item?.thread);
    const comments = detailMode ? thread : thread.slice(-1);
    const triangulatedClaims = Array.isArray(item?.claimsForItem)
      ? item.claimsForItem.filter(function(claim) { return lower(claim?.source || '') === 'triangle'; })
      : [];
    const isClaimTriangle = !!item?.triangulated && item?.meta?.triangle_format === 'claims-v1';
    const kindLabel = item?.source === 'question' ? 'guided ask'
      : item?.source === 'capture-image' ? 'visual note'
      : item?.source === 'backlog' ? 'task'
      : item?.source === 'decision' ? 'decision'
      : item?.source === 'triangle' ? 'triangle signal'
      : 'signal';
    const body = escapeHtml(item?.body || 'no content yet').replace(/\n/g, '<br />');
    const claimRows = isClaimTriangle ? triangulatedClaims.slice(0, detailMode ? 4 : 2).map(function(claim) {
      var sourceCount = Array.isArray(claim?.evidence) ? claim.evidence.length : 0;
      return [
        '<div style="margin-top:8px;">',
        '<div style="font-size:12px; line-height:1.42; color:rgba(42,37,31,0.94);">',
        escapeHtml(claim?.text || ''),
        '</div>',
        '<div style="font-size:10px; color:rgba(8,8,8,0.46); margin-top:3px;">',
        escapeHtml('· ' + String(sourceCount) + ' source' + (sourceCount === 1 ? '' : 's')),
        '</div>',
        '</div>'
      ].join('');
    }).join('') : '';
    const tensionRows = isClaimTriangle ? (item?.meta?.triangle_tensions || []).slice(0, 2).map(function(entry) {
      return [
        '<div style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(8,8,8,0.32);">',
        '<div style="font-size:10px; color:rgba(8,8,8,0.44);">',
        escapeHtml(entry?.note || 'unresolved tension'),
        '</div>',
        '</div>'
      ].join('');
    }).join('') : '';
    const commentRows = comments.map(function(comment) {
      return [
        '<div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(8,8,8,0.10);">',
        '<div style="font-size:10px; color:rgba(8,8,8,0.46); margin-bottom:4px;">',
        escapeHtml(comment.kind || 'comment'),
        ' · ',
        escapeHtml(recentTimeLabel(comment.at)),
        '</div>',
        '<div style="font-size:12px; line-height:1.45; color:rgba(42,37,31,0.92);">',
        escapeHtml(comment.body || comment.summary || '').replace(/\n/g, '<br />'),
        '</div>',
        '</div>'
      ].join('');
    }).join('');
    const olderCount = detailMode && thread.length > 3 ? thread.length - 3 : 0;
    return [
      '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:6px;">',
      '<div style="font-size:10px; color:rgba(138,132,122,1);">',
      escapeHtml(kindLabel),
      '</div>',
      '<div style="font-size:10px; color:rgba(138,132,122,1); text-align:right; white-space:nowrap;">',
      escapeHtml(formatTimeLabel(item?.created_at)),
      '</div>',
      '</div>',
      '<div style="font-size:15px; line-height:1.2; font-weight:600; color:rgba(26,22,18,1); margin-bottom:8px;">',
      escapeHtml(item?.title || 'untitled'),
      '</div>',
      isClaimTriangle
        ? '<div style="font-size:10px; color:rgba(138,132,122,1); margin-bottom:6px;">derived claims</div>' + claimRows + tensionRows
        : '<div style="font-size:13px; line-height:1.45; color:rgba(42,37,31,0.94); overflow-wrap:anywhere;">' + body + '</div>',
      commentRows,
      olderCount > 0 ? '<div style="margin-top:8px; font-size:10px; color:rgba(8,8,8,0.42);">+ ' + olderCount + ' older</div>' : ''
    ].join('');
  }

  function drawKnowScrollFrame(content, frame, key) {
    const frameGroup = mk('g');
    mk('rect', {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      rx: 10,
      ry: 10,
      fill: 'rgba(8,8,8,0.06)'
    }, frameGroup);

    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', frame.x);
    fo.setAttribute('y', frame.y);
    fo.setAttribute('width', frame.width);
    fo.setAttribute('height', frame.height);

    const wrapper = document.createElement('div');
    wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrapper.style.position = 'relative';
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.overflow = 'hidden';
    wrapper.style.borderRadius = '10px';

    const scroller = document.createElement('div');
    scroller.style.height = '100%';
    scroller.style.overflowY = 'auto';
    scroller.style.padding = '8px 8px 20px 8px';
    scroller.style.color = 'rgba(8,8,8,0.88)';
    scroller.style.fontFamily = 'PowerGrotesk-Regular, sans-serif';
    scroller.style.fontSize = '12px';
    scroller.style.lineHeight = '1.5';
    scroller.style.textTransform = 'lowercase';
    scroller.style.whiteSpace = 'normal';
    scroller.style.wordBreak = 'normal';
    scroller.style.overflowWrap = 'anywhere';
    scroller.innerHTML = typeof content === 'string'
      ? ('<div style="font-size:13px; line-height:1.45; color:rgba(42,37,31,0.94);">' + escapeHtml(lower(content || 'no content yet')).replace(/\n/g, '<br />') + '</div>')
      : (content?.html || '<div>no content yet</div>');

    const track = document.createElement('div');
    track.style.position = 'absolute';
    track.style.top = '0';
    track.style.right = '0';
    track.style.width = '2px';
    track.style.height = '100%';
    track.style.borderRadius = '1px';
    track.style.background = 'rgba(8,8,8,0.10)';
    track.style.display = 'none';

    const fill = document.createElement('div');
    fill.style.position = 'absolute';
    fill.style.top = '0';
    fill.style.right = '0';
    fill.style.width = '2px';
    fill.style.borderRadius = '1px';
    fill.style.background = 'rgba(8,8,8,0.42)';
    track.appendChild(fill);

    const fade = document.createElement('div');
    fade.style.position = 'absolute';
    fade.style.left = '0';
    fade.style.right = '6px';
    fade.style.bottom = '0';
    fade.style.height = '6px';
    fade.style.background = 'linear-gradient(to bottom, rgba(244,239,228,0), rgba(244,239,228,1))';
    fade.style.pointerEvents = 'none';
    fade.style.display = 'none';

    function updateIndicators() {
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      stateData.knowBodyMaxScroll = maxScroll;
      const needsOverflow = maxScroll > 6;
      track.style.display = needsOverflow ? 'block' : 'none';
      fade.style.display = needsOverflow && scroller.scrollTop < maxScroll - 2 ? 'block' : 'none';
      if (!needsOverflow) return;
      const ratio = scroller.clientHeight / scroller.scrollHeight;
      const thumbHeight = Math.max(18, scroller.clientHeight * ratio);
      const top = maxScroll <= 0 ? 0 : ((scroller.scrollTop / maxScroll) * (scroller.clientHeight - thumbHeight));
      fill.style.height = thumbHeight + 'px';
      fill.style.transform = 'translateY(' + top + 'px)';
    }

    const scrollKey = key || '';
    if (stateData.knowBodyKey !== scrollKey) {
      stateData.knowBodyKey = scrollKey;
      stateData.knowBodyScrollTop = 0;
    }

    scroller.addEventListener('scroll', function() {
      stateData.knowBodyScrollTop = scroller.scrollTop;
      updateIndicators();
    });

    wrapper.appendChild(scroller);
    wrapper.appendChild(track);
    wrapper.appendChild(fade);
    fo.appendChild(wrapper);
    frameGroup.appendChild(fo);

    setTimeout(function() {
      try { scroller.scrollTop = stateData.knowBodyScrollTop || 0; } catch (_) {}
      updateIndicators();
    }, 0);
  }

  function drawTriangleOverlay() {
    if (!surfaceIsVisible('triangle')) return;
    const triangle = getTriangleState();
    const pair = triangle.pair || {};
    const pointA = pair.a;
    const pointB = pair.b;
    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: 'rgba(7,7,7,0.985)' });
    const accent = triangleColor(pointB || pointA);
    mk('path', { d: 'M 14 18 L 23 34 L 32 18 Z', fill: accent });
    text(40, 31, 'triangle', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '18'
    });
    mk('rect', { x: 12, y: 42, width: 216, height: 1, fill: 'rgba(244,239,228,0.10)' });

    const describe = function(item) {
      return {
        title: item?.type === 'show' ? 'point ' + (item === pointA ? 'a' : 'b') + ' · visual note'
          : item?.type === 'tell' ? 'point ' + (item === pointA ? 'a' : 'b') + ' · voice note'
          : item?.type === 'know' ? 'point ' + (item === pointA ? 'a' : 'b') + ' · signal'
          : 'point ' + (item === pointA ? 'a' : 'b') + ' · decision',
        time: item?.timeLabel || recentTimeLabel(item?.created_at),
        body: triangleSummaryText(item) || 'no context'
      };
    };

    const aDesc = describe(pointA);
    const bDesc = describe(pointB);
    let cursorY = 66;
    [aDesc, bDesc].forEach(function(entry, index) {
      text(16, cursorY, entry.title, {
        fill: 'rgba(244,239,228,0.44)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      text(224, cursorY, entry.time || 'recent', {
        fill: 'rgba(244,239,228,0.32)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      const bodyRows = wrapTextBlock(undefined, entry.body, 16, cursorY + 18, 204, 13, 'rgba(244,239,228,0.92)', '12', 3);
      cursorY += 18 + (bodyRows * 13) + (index === 0 ? 26 : 18);
    });

    mk('rect', { x: 12, y: cursorY, width: 216, height: 1, fill: 'rgba(244,239,228,0.10)' });
    const transcript = lower(document.getElementById('voice-transcript')?.textContent || '');
    const promptY = cursorY + 28;
    let promptText = stateData.triangleStatus || triangle.lastError || 'hold ptt to tell your angle';
    if (recordingActive() && activeSurface() === 'triangle') {
      promptText = transcript || 'listening for your angle...';
    } else if (triangle.status === 'synthesizing') {
      promptText = 'synthesizing...';
    } else if (triangle.lastError) {
      promptText = triangle.lastError;
    }
    wrapTextBlock(undefined, lower(promptText), 16, promptY, 206, 14, 'rgba(244,239,228,0.90)', '13', 4);
  }

  function drawCardIcon(card, selected, parent) {
    if (!selected) return;
    if (recordingActive() && activeSurface() === 'home') {
      recordingDot(33, 31, 14, parent);
      return;
    }
    if (card.iconPath) {
      drawFramedIcon(card.iconPath, {
        x: 18, y: 16, width: 30, height: 30, rx: 5, ry: 5
      }, parent, { inset: 1.5 });
      return;
    }
    text(18, 40, card.iconFallback || '•', {
      fill: 'rgba(10,10,10,0.88)',
      'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '28'
    }, parent);
  }

  function drawWordmark() {
    if (currentState !== STATES.HOME && currentState !== STATES.LOG_OPEN) return;
    const project = getProjectMemory();
    drawFramedIcon(iconAsset('brand-mark', 'assets/icons/png/5.png'), {
      x: 11, y: 14, width: 24, height: 24, rx: 4, ry: 4
    }, svg, {
      inset: 1.5,
      style: 'filter: brightness(0) invert(0.96);',
      opacity: 0.96
    });
    text(40, 34, 'structa', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '32', 'letter-spacing': '0.0em'
    });
    text(14, 56, compactProjectName(projectDisplayName(project)), {
      fill: '#f8c15d',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '15'
    });
    mk('rect', { x: 14, y: 62, width: 26, height: 2, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.78)' });
    if (allowMenuFlush()) {
      const flushTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', {
        x: 180, y: 14, width: 46, height: 18, rx: 7, ry: 7,
        fill: 'rgba(255,255,255,0.05)',
        stroke: 'rgba(255,255,255,0.10)',
        'stroke-width': 1
      }, flushTap);
      text(203, 26, 'flush', {
        fill: 'rgba(244,239,228,0.76)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'middle'
      }, flushTap);
      flushTap.addEventListener('pointerup', function(event) {
        event.preventDefault();
        event.stopPropagation();
        fireFeedback('touch-commit');
        requestFlush('home');
      });
    }

  }

  function drawProjectSwitcher() {
    if (currentState !== STATES.PROJECT_SWITCHER) return;
    const projects = getProjects();
    const activeId = getActiveProjectId();
    const rows = getProjectSwitcherRows();
    const selectedIndexValue = typeof stateData.projectListIndex === 'number' ? stateData.projectListIndex : 0;
    const selected = Math.max(0, Math.min(selectedIndexValue, Math.max(rows.length - 1, 0)));
    const selectedRow = rows[selected] || rows[0];
    const selectedProject = selectedRow?.project || projects[0];
    const isFreshWorkspace = freshWorkspaceState() && !onboardingAllowsProjectSwitcher();
    const onboardingProjectLesson = onboardingActive() && getOnboardingStep() === 1;
    const activeCount = projects.filter(function(project) { return project.status !== 'archived'; }).length;

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: '#070707' });
    if (recordingActive()) recordingDot(23, 25, 10, svg);
    else drawFramedIcon(iconAsset('brand-mark', 'assets/icons/png/5.png'), {
      x: 12, y: 14, width: 22, height: 22, rx: 4, ry: 4
    }, svg, {
      inset: 1.35,
      preserveAspectRatio: 'xMidYMid slice',
      opacity: 0.92,
      style: 'filter: brightness(0) invert(0.96);'
    });
    text(40, 31, 'structa', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '22'
    });
    text(226, 54, 'projects', {
      fill: 'rgba(244,239,228,0.36)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
    if (allowMenuFlush()) {
      const flushTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', {
        x: 180, y: 14, width: 46, height: 18, rx: 7, ry: 7,
        fill: 'rgba(255,255,255,0.05)',
        stroke: 'rgba(255,255,255,0.10)',
        'stroke-width': 1
      }, flushTap);
      text(203, 26, 'flush', {
        fill: 'rgba(244,239,228,0.76)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'middle'
      }, flushTap);
      flushTap.addEventListener('pointerup', function(event) {
        event.preventDefault();
        event.stopPropagation();
        fireFeedback('touch-commit');
        flushTestingMemory();
      });
    }
    mk('rect', { x: 14, y: 60, width: 26, height: 2, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.78)' });

    if (!projects.length || isFreshWorkspace) {
      text(14, 118, isFreshWorkspace ? 'memory cleared' : 'no projects yet', {
        fill: '#f4efe4',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      text(14, 142, isFreshWorkspace ? 'fresh staging state' : 'start by naming a project', {
        fill: 'rgba(244,239,228,0.42)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      });
      text(226, 268, allowMenuFlush() ? 'flush resets onboarding' : 'ready for first project', {
        fill: 'rgba(244,239,228,0.34)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return;
    }

    const startY = 84;
    const rowH = 46;
    const visibleRows = 4;
    const offset = Math.max(0, Math.min(selected - 1, Math.max(0, rows.length - visibleRows)));
    rows.slice(offset, offset + visibleRows).forEach((row, visibleIndex) => {
      const absoluteIndex = offset + visibleIndex;
      const y = startY + (visibleIndex * rowH);
      const isSelected = absoluteIndex === selected;
      const tap = mk('g', { style: 'cursor: pointer;' });
      if (row.type === 'add') {
        mk('rect', {
          x: 10,
          y,
          width: 220,
          height: 38,
          rx: 10,
          ry: 10,
          fill: isSelected ? 'rgba(248,193,93,0.08)' : 'rgba(255,255,255,0.012)',
          stroke: isSelected ? 'rgba(248,193,93,0.58)' : 'rgba(248,193,93,0.40)',
          'stroke-width': '1'
        }, tap);
        text(18, y + 24, '+ new project', {
          fill: isSelected ? '#f8c15d' : 'rgba(244,239,228,0.88)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '14'
        }, tap);
      } else {
        const project = row.project;
        const isActive = project.project_id === activeId;
        mk('rect', {
          x: 10,
          y,
          width: 220,
          height: 38,
          rx: 10,
          ry: 10,
          fill: isSelected ? 'rgba(248,193,93,0.14)' : 'rgba(255,255,255,0.025)',
          stroke: isSelected ? 'rgba(248,193,93,0.42)' : 'rgba(255,255,255,0.05)',
          'stroke-width': '1'
        }, tap);
        text(18, y + 16, compactProjectName(project.name || 'Untitled Project'), {
          fill: isActive ? '#f8c15d' : '#f4efe4',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '14'
        }, tap);
        text(18, y + 29, project.type || 'general', {
          fill: 'rgba(244,239,228,0.40)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        }, tap);
        text(128, y + 29, project.status || 'active', {
          fill: isSelected ? 'rgba(248,193,93,0.58)' : 'rgba(244,239,228,0.28)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        }, tap);
        text(220, y + 16, recentTimeLabel(project.updated_at), {
          fill: isActive ? 'rgba(248,193,93,0.70)' : 'rgba(244,239,228,0.36)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10',
          'text-anchor': 'end'
        }, tap);
      }

      tap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        stateData.projectListIndex = absoluteIndex;
        if (isSelected) activateSelectedProject();
        else {
          fireFeedback('touch-commit');
          render();
        }
      });
    });

    if (selectedRow?.type === 'project' && projects.length > 1 && selectedProject && selectedProject.status !== 'archived') {
      const archiveTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', {
        x: 14, y: 248, width: 74, height: 20, rx: 8, ry: 8,
        fill: 'rgba(248,193,93,0.12)',
        stroke: 'rgba(248,193,93,0.36)',
        'stroke-width': 1
      }, archiveTap);
      text(28, 261, 'archive', {
        fill: 'rgba(248,193,93,0.88)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      }, archiveTap);
      archiveTap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        fireFeedback('touch-commit');
        native?.archiveProject?.(selectedProject.project_id);
        const refreshed = getProjects();
        const nextIndex = Math.max(0, Math.min(stateData.projectListIndex || 0, Math.max(refreshed.length - 1, 0)));
        transition(STATES.PROJECT_SWITCHER, { projectListIndex: nextIndex });
      });
    }

    text(226, 268, onboardingProjectLesson
      ? 'lesson 1 · click opens'
      : `${activeCount} of 3`, {
      fill: 'rgba(244,239,228,0.34)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
  }

  function drawSurfaceHeader(card, options = {}) {
    const project = getProjectMemory();
    const suppressTutorialRecordingChrome = onboardingActive() && (getOnboardingStep() === 2 || getOnboardingStep() === 4);
    if (recordingActive() && activeSurface() !== 'home' && !suppressTutorialRecordingChrome) {
      recordingDot(23, 26, 10, svg);
    } else if (card.iconPath) {
      drawFramedIcon(card.iconPath, {
        x: 11, y: 14, width: 24, height: 24, rx: 4, ry: 4
      }, svg, { inset: 1.35 });
    }
    text(42, 34, card.title, {
      fill: 'rgba(8,8,8,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '32', 'letter-spacing': '0.0em'
    });
    if (!options.hideSubtitle) {
      text(14, 58, compactProjectName(projectDisplayName(project)), {
        fill: 'rgba(8,8,8,0.52)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
    }
  }

  function drawCard(card, index) {
    const selected = index === selectedIndex;
    const layout = cardLayout(index);
    const stackLead = !selected && layout.depth === 0;
    const onboardingDim = onboardingActive() && currentState === STATES.HOME && !homeOnboardingSelectionAllowed(card.id);
    const group = mk('g', {
      transform: `translate(${layout.x},${layout.y}) scale(${layout.scale})`,
      opacity: String(onboardingDim ? Math.min(layout.opacity, 0.3) : layout.opacity), tabindex: '0', role: 'button',
      'aria-label': `${card.title} ${card.role}`,
      'data-card-index': index
    });

    mk('rect', {
      x: 0, y: 0, width: 150, height: 150, rx: 20, ry: 20,
      fill: card.color,
      stroke: selected ? 'rgba(8,8,8,0.08)' : 'rgba(255,255,255,0.04)',
      'stroke-width': selected ? 0.8 : 0.8, 'stroke-opacity': 1
    }, group);

    if (selected) {
      drawCardIcon(card, true, group);
      text(18, 80, card.title, {
        fill: 'rgba(8,8,8,0.98)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '24'
      }, group);

      let statNumber = '';
      let statLabel = '';
      const project = getProjectMemory();
      if (onboardingActive() && card.id === 'now') {
        statNumber = '0';
        statLabel = 'start here';
      } else if (card.id === 'show') {
        statNumber = String(getCaptureList().length);
        statLabel = 'frames';
      } else if (card.id === 'tell') {
        statNumber = String(getVoiceEntries().length);
        statLabel = 'spoken';
      } else if (card.id === 'know') {
        const qCount = (project?.open_questions || []).length;
        const iCount = (project?.insights || []).length;
        statNumber = qCount > 0 ? String(qCount) : String(iCount);
        statLabel = qCount > 0 ? 'asks' : 'signals';
      } else if (card.id === 'now') {
        const pCount = (project?.pending_decisions || []).length;
        const clarity = project?.clarity_score || 0;
        statNumber = pCount > 0 ? String(pCount) : (clarity > 0 ? clarity + '%' : '0');
        statLabel = pCount > 0 ? 'pending' : 'clarity';
      }

      if (statNumber && statNumber !== '0') {
        text(132, 80, statNumber, {
          fill: 'rgba(8,8,8,0.20)',
          'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '38',
          'text-anchor': 'end'
        }, group);
      }

      text(18, 112, lower(card.roleShort || card.role), {
        fill: 'rgba(8,8,8,0.70)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12'
      }, group);

      if (statLabel) {
        text(18, 132, lower(statLabel), {
          fill: 'rgba(8,8,8,0.40)',
          'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10'
        }, group);
      }

      const pendingCount = (project?.pending_decisions || []).length;
      const questionCount = (project?.open_questions || []).length;
      if (pendingCount > 0 && card.id === 'now') {
        mk('circle', { cx: 136, cy: 18, r: 4, fill: '#ff8a65', opacity: '0.86' }, group);
      }
      if (questionCount > 0 && card.id === 'know') {
        mk('circle', { cx: 136, cy: 18, r: 4, fill: '#f8c15d', opacity: '0.86' }, group);
      }
    } else if (stackLead) {
      if (card.iconPath) {
        drawFramedIcon(card.iconPath, {
          x: 18, y: 18, width: 30, height: 30, rx: 5, ry: 5
        }, group, { inset: 1.5 });
      }
      const project = getProjectMemory();
      if (card.id === 'now' && (project?.pending_decisions || []).length > 0) {
        mk('circle', { cx: 130, cy: 18, r: 4, fill: '#ff8a65', opacity: '0.8' }, group);
      }
      if (card.id === 'know' && (project?.open_questions || []).length > 0) {
        mk('circle', { cx: 130, cy: 18, r: 4, fill: '#f8c15d', opacity: '0.8' }, group);
      }
    }

    const activate = event => {
      event.preventDefault();
      if (onboardingActive() && !homeOnboardingSelectionAllowed(card.id)) {
        fireFeedback('blocked');
        return;
      }
      if (selected && isHome()) {
        if (card.id === 'show' && event.type === 'pointerup') {
          openCameraFromShow('touch');
          return;
        }
        openCard(card);
      }
      else if (isHome()) {
        fireFeedback('touch-commit');
        selectIndex(index);
      }
    };

    group.addEventListener('pointerup', activate);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });

    return { group };
  }

  function drawSectionLabel(group, x, y, label) {
    text(x, y, lower(label), {
      fill: 'rgba(8,8,8,0.56)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12', // bumped from 9 → 12 per V2 UX spec
      'letter-spacing': '0.02em'
    }, group);
  }

  function drawSquaredPill(x, y, width, height, label, active, tone = 'dark') {
    const activeFill = tone === 'dark' ? 'rgba(8,8,8,0.92)' : 'rgba(8,8,8,0.18)';
    const idleFill = tone === 'dark' ? 'rgba(8,8,8,0.12)' : 'rgba(255,255,255,0.12)';
    const activeText = tone === 'dark' ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.98)';
    const idleText = tone === 'dark' ? 'rgba(8,8,8,0.82)' : 'rgba(8,8,8,0.62)';
    mk('rect', {
      x, y, width, height, rx: 4, ry: 4,
      fill: active ? activeFill : idleFill,
      stroke: active ? 'rgba(8,8,8,0.10)' : 'rgba(8,8,8,0.05)',
      'stroke-width': 1
    });
    text(x + width / 2, y + height / 2 + 4, lower(label), {
      fill: active ? activeText : idleText,
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12', // bumped from 9 → 12 per V2 UX spec
      'text-anchor': 'middle'
    });
  }

  // L1: Cache canvas context
  const _measureCanvas = document.createElement('canvas');
  const _measureCtx = _measureCanvas.getContext('2d');

  function wrapText(parent, content, x, y, width, lineHeight, fill, fontSize = '10') {
    return wrapTextBlock(parent, content, x, y, width, lineHeight, fill, fontSize);
  }

  function wrapTextBlock(parent, content, x, y, width, lineHeight, fill, fontSize = '10', maxRows = Infinity) {
    const words = lower(content).split(/\s+/).filter(Boolean);
    let line = '';
    let row = 0;
    _measureCtx.font = `${fontSize}px PowerGrotesk-Regular`;
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      const test = line ? `${line} ${word}` : word;
      if (_measureCtx.measureText(test).width > width && line) {
        const isLastAllowedRow = row + 1 >= maxRows;
        const value = isLastAllowedRow && i < words.length
          ? truncateLine(line, width, fontSize)
          : line;
        text(x, y + row * lineHeight, value, { fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': fontSize }, parent);
        if (isLastAllowedRow) return row + 1;
        line = word;
        row += 1;
      } else {
        line = test;
      }
    }
    if (line && row < maxRows) {
      const value = row + 1 >= maxRows ? truncateLine(line, width, fontSize, false) : line;
      text(x, y + row * lineHeight, value, { fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': fontSize }, parent);
      row += 1;
    }
    return row;
  }

  function truncateLine(line, width, fontSize, forceEllipsis = true) {
    let value = line;
    const ellipsis = '…';
    _measureCtx.font = `${fontSize}px PowerGrotesk-Regular`;
    if (!forceEllipsis && _measureCtx.measureText(value).width <= width) return value;
    while (value.length > 1 && _measureCtx.measureText(value + ellipsis).width > width) {
      value = value.slice(0, -1).trimEnd();
    }
    return value + ellipsis;
  }

  function buildShowSummary() {
    const captures = getCaptureList();
    const project = getProjectMemory();
    const preferredEntryId = stateData.showCaptureEntryId || getUIState().last_capture_entry_id || '';
    const preferredIndex = preferredEntryId
      ? captures.findIndex(capture => (capture?.entry_id || capture?.id || '') === preferredEntryId)
      : -1;
    const safeIndex = captures.length
      ? Math.max(0, Math.min(preferredIndex >= 0 ? preferredIndex : (typeof stateData.showCaptureIndex === 'number' ? stateData.showCaptureIndex : captures.length - 1), captures.length - 1))
      : 0;
    stateData.showCaptureIndex = safeIndex;
    const current = captures[safeIndex] || null;
    const currentClaims = current ? getClaimsForRefs([current?.node_id || '', current?.entry_id || '', current?.id || '']) : [];
    if (!current) {
      return {
        title: project?.name || 'new project',
        captures,
        current: null,
        currentIndex: 0,
        insights: (project?.insights || []).length,
        status: stateData.showStatus || 'empty',
        summary: 'no frames',
        imageHref: '',
        analysisReady: false,
        analysisState: '',
        createdAt: null,
        claims: [],
        claimCount: 0,
        claimSummary: ''
      };
    }
    return {
      title: project?.name || 'new project',
      captures,
      current,
      currentIndex: safeIndex,
      insights: (project?.insights || []).length,
      status: stateData.showStatus || (captures.length ? 'reviewing' : 'empty'),
      summary: current ? getCaptureSummary(current) : 'no frames',
      imageHref: current ? getCaptureImageHref(current) : '',
      analysisReady: current ? captureAnalysisReady(current) : false,
      analysisState: lower(current?.meta?.analysis_status || ''),
      processingLine: current ? getCaptureProcessingLine(current) : 'ready',
      annotationPending: Number(current?.meta?.annotation_window_until || 0) > Date.now(),
      claimExtractionPending: !!current?.meta?.claim_extraction_pending,
      createdAt: current?.captured_at || current?.created_at || current?.meta?.captured_at || null,
      pendingQueueCount: getPendingCaptureQueueCount(),
      thread: cloneThread(current?.thread),
      threadDepth: typeof current?.thread_depth === 'number' ? current.thread_depth : threadDepth(current?.thread),
      threadSummary: current?.thread_summary || '',
      claims: currentClaims,
      claimCount: currentClaims.length,
      claimSummary: lower(normalizeTinyText(currentClaims[0]?.text || ''))
    };
  }

  function drawShowSurface() {
    if (!surfaceIsVisible('show') && currentState !== STATES.SHOW_PRIMED) return;
    const showCard = cards.find(c => c.id === 'show');
    const model = buildShowSummary();
    const inlineListening = recordingActive() && activeSurface() === 'show';
    const canReprompt = !!(model.current && model.analysisReady);

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: showCard.color });
    drawSurfaceHeader(showCard);
    const cameraButton = mk('g', { style: 'cursor: pointer;' });
    mk('rect', { x: 14, y: 74, width: 212, height: 28, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.90)' }, cameraButton);
    text(24, 92, 'open lens', {
      fill: 'rgba(244,239,228,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12'
    }, cameraButton);
    text(216, 92, inlineListening ? 'release reprompt' : (canReprompt ? 'hold ptt on frame' : 'hold ptt in lens'), {
      fill: 'rgba(244,239,228,0.58)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    }, cameraButton);
    cameraButton.addEventListener('pointerup', event => {
      event.preventDefault();
      event.stopPropagation();
      openCameraFromShow('touch');
    });

    mk('rect', { x: 14, y: 112, width: 212, height: 112, rx: 12, ry: 12, fill: 'rgba(8,8,8,0.12)' });
    if (currentState === STATES.SHOW_PRIMED) {
      text(20, 148, 'click to start camera', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      text(20, 172, 'then click shoots · hold ptt narrates', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    } else if (model.imageHref) {
      drawRasterFrame(model.imageHref, {
        x: 14, y: 112, width: 212, height: 112, preserveAspectRatio: 'xMidYMid slice', opacity: 1, rx: 12, ry: 12
      });
      mk('rect', { x: 14, y: 192, width: 212, height: 32, fill: 'rgba(5,5,5,0.54)' });
      text(22, 206, recentTimeLabel(model.createdAt), {
        fill: 'rgba(244,239,228,0.58)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      wrapTextBlock(undefined, model.analysisReady ? model.summary.slice(0, 52) : model.processingLine, 22, 217, 190, 11, 'rgba(244,239,228,0.92)', '10', 1);
      if (model.claimSummary) {
        wrapTextBlock(undefined, 'claim · ' + model.claimSummary.slice(0, 42), 22, 204, 172, 10, 'rgba(244,239,228,0.84)', '9', 1);
      }
      if (model.threadSummary) {
        wrapTextBlock(undefined, 'comment · ' + lower(model.threadSummary).slice(0, 42), 22, model.claimSummary ? 216 : 204, 172, 10, 'rgba(244,239,228,0.78)', '9', 1);
        drawKnowDepthGlyph(model.threadDepth || 0, 204, model.claimSummary ? 214 : 202);
      }
      if (!model.analysisReady) {
        text(210, 129, model.processingLine, {
          fill: 'rgba(244,239,228,0.88)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10',
          'text-anchor': 'end'
        });
      }
      if (inlineListening && canReprompt) {
        mk('rect', { x: 18, y: 118, width: 132, height: 18, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.78)' });
        text(28, 130, 'release to reprompt', {
          fill: 'rgba(244,239,228,0.96)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
      }
    } else if (model.captures.length) {
      text(20, 148, COPY.frameSaved, {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, lower(String(model.summary || model.processingLine || COPY.backgroundWorking)), 20, 170, 186, 13, 'rgba(8,8,8,0.76)', '12', 3);
      text(20, 206, model.analysisState === 'pending' ? model.processingLine : 'saved without preview', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    } else {
      const cameraRecoveryCue = !model.captures.length && (getUIState().onboarding_step4_skipped || getUIState().tutorial_step4_camera_denied);
      text(20, 146, 'gallery starts here', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      text(20, 168, cameraRecoveryCue ? 'camera not enabled — click shutter to allow' : 'click open lens to begin', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      text(20, 188, 'frames appear here immediately', {
        fill: 'rgba(8,8,8,0.34)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    }

    if (currentState === STATES.SHOW_PRIMED) {
      text(226, 276, 'waiting for click', {
        fill: 'rgba(8,8,8,0.34)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10',
        'text-anchor': 'end'
      });
      return;
    }

    const thumbY = 236;
    const recent = model.captures.slice().reverse().slice(0, 3);
    recent.forEach((capture, i) => {
      const x = 14 + (i * 70);
      const href = getCaptureImageHref(capture);
      const active = capture === model.current;
      mk('rect', { x, y: thumbY, width: 62, height: 42, rx: 8, ry: 8, fill: active ? 'rgba(8,8,8,0.18)' : 'rgba(8,8,8,0.10)' });
      if (href) {
        drawRasterFrame(href, { x, y: thumbY, width: 62, height: 42, preserveAspectRatio: 'xMidYMid slice', opacity: active ? 1 : 0.68, rx: 8, ry: 8 });
      } else {
        text(x + 8, thumbY + 24, `${i + 1}`, {
          fill: 'rgba(8,8,8,0.48)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '11'
        });
      }
      if (active) {
        mk('rect', { x, y: thumbY, width: 62, height: 42, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.01)', stroke: 'rgba(244,239,228,0.38)', 'stroke-width': 2 });
      }
      const thumbTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', { x, y: thumbY, width: 62, height: 42, rx: 8, ry: 8, fill: 'transparent' }, thumbTap);
      thumbTap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        fireFeedback('touch-commit');
        const absoluteIndex = model.captures.indexOf(capture);
        stateData.showCaptureIndex = absoluteIndex >= 0 ? absoluteIndex : 0;
        stateData.showCaptureEntryId = capture?.entry_id || capture?.id || '';
        stateData.showStatus = 'visual memory';
        render();
      });
    });

      const showFooter = model.annotationPending
        ? 'hold ptt · tag frame'
        : model.claimExtractionPending
          ? COPY.backgroundWorking
          : model.pendingQueueCount > 0
            ? COPY.queuedWorking(model.pendingQueueCount)
            : (model.captures.length ? (model.claimCount > 0 ? `${model.claimCount} claims · ${COPY.holdPttComment}` : COPY.holdPttComment) : COPY.readyForFrame);
    text(226, 276, showFooter, {
      fill: 'rgba(8,8,8,0.38)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
  }

  function buildTellModel() {
    const entries = getVoiceEntries();
    const project = getProjectMemory();
    const safeIndex = Math.max(0, Math.min(stateData.tellEntryIndex || 0, Math.max(entries.length - 1, 0)));
    stateData.tellEntryIndex = safeIndex;
    const current = entries[safeIndex] || null;
    return {
      title: project?.name || 'new project',
      entries,
      current,
      currentIndex: safeIndex,
      insights: (project?.insights || []).length,
      questions: (project?.open_questions || []).length,
      status: stateData.tellStatus || (entries.length ? 'ready' : 'empty'),
      thread: cloneThread(current?.meta?.thread || current?.thread),
      threadDepth: typeof current?.thread_depth === 'number' ? current.thread_depth : threadDepth(current?.meta?.thread || current?.thread),
      threadSummary: current?.meta?.thread_summary || current?.thread_summary || ''
    };
  }

  function buildTellVoiceContext() {
    const entries = getVoiceEntries();
    const idx = Math.max(0, Math.min(stateData.tellEntryIndex || 0, Math.max(entries.length - 1, 0)));
    const entry = entries[idx];
    if (!entry) return { kind: 'tell', text: '', surface: 'tell' };
    return {
      kind: 'voice-entry',
      nodeId: entry.node_id || entry.entry_id || '',
      text: entry.body || entry.title || '',
      surface: 'tell'
    };
  }

  function buildShowVoiceContext() {
    const captures = getCaptureList();
    const idx = Math.max(0, Math.min(stateData.showCaptureIndex || 0, Math.max(captures.length - 1, 0)));
    const capture = captures[idx];
    if (!capture) return { kind: 'show', text: 'visual capture context', surface: 'show' };
    const captureText = [
      capture.summary || capture.ai_analysis || '',
      capture.prompt_text || '',
      capture.voice_annotation || '',
      recentTimeLabel(capture.captured_at || capture.created_at || capture.meta?.captured_at || '')
    ].filter(Boolean).join(' · ');
    return {
      kind: 'capture',
      nodeId: capture.node_id || capture.entry_id || capture.id || '',
      text: captureText.slice(0, 220),
      surface: 'show'
    };
  }

  function buildKnowVoiceContext() {
    const model = buildKnowModel();
    const items = getKnowVisibleItems(model);
    const idx = Math.max(0, Math.min(stateData.knowItemIndex || 0, Math.max(items.length - 1, 0)));
    const item = items[idx];
    return {
      kind: item?.source || 'know',
      nodeId: item?.node_id || '',
      text: item ? ((item.title || '') + ' ' + (item.body || '')).trim() : '',
      surface: 'know'
    };
  }

  function buildNowVoiceContext() {
    const data = buildNowSummary();
    if (data.pendingDecisions && data.pendingDecisions.length) {
      const current = data.pendingDecisions[data.pendingDecisionIndex] || data.pendingDecisions[0];
      return {
        kind: 'decision',
        nodeId: current?.node_id || '',
        text: typeof current === 'string' ? current : ((current?.text || '') + ' ' + (current?.insight_body || '')).trim(),
        surface: 'now'
      };
    }
    return {
      kind: 'project',
      nodeId: data.activeQuestionNodeId || '',
      text: data.blockerQuestion || data.next || '',
      surface: 'now'
    };
  }

  function buildTellCommentContext() {
    const entries = getVoiceEntries();
    const idx = Math.max(0, Math.min(stateData.tellEntryIndex || 0, Math.max(entries.length - 1, 0)));
    const entry = entries[idx];
    if (!entry?.node_id) return null;
    return {
      kind: 'thread-comment',
      nodeId: entry.node_id,
      title: entry.title || 'voice note',
      text: entry.body || entry.title || '',
      surface: 'tell',
      createdAt: entry.created_at || '',
      commentKind: 'comment',
      projectSummary: buildNowSummary().next || ''
    };
  }

  function buildShowCommentContext() {
    const summary = buildShowSummary();
    const capture = summary.current;
    if (!capture?.node_id) return null;
    return {
      kind: 'thread-comment',
      nodeId: capture.node_id,
      title: capture.summary || 'visual note',
      text: [capture.summary || '', capture.voice_annotation || ''].filter(Boolean).join(' · '),
      surface: 'show',
      createdAt: capture.created_at || capture.captured_at || '',
      commentKind: 'comment',
      projectSummary: buildNowSummary().next || ''
    };
  }

  function buildKnowCommentContext() {
    const model = buildKnowModel();
    const items = getKnowVisibleItems(model);
    const idx = Math.max(0, Math.min(stateData.knowItemIndex || 0, Math.max(items.length - 1, 0)));
    const item = items[idx];
    if (!item?.node_id) return null;
    return {
      kind: 'thread-comment',
      nodeId: item.node_id,
      title: item.title || item.source || 'know item',
      text: [item.title || '', item.body || ''].join(' ').trim(),
      surface: 'know',
      createdAt: item.created_at || '',
      commentKind: item.source === 'question' ? 'clarification' : 'comment',
      projectSummary: buildNowSummary().next || ''
    };
  }

  function buildNowCommentContext() {
    const data = buildNowSummary();
    const currentDecision = data.activePendingDecision;
    if (currentDecision?.node_id) {
      return {
        kind: 'thread-comment',
        nodeId: currentDecision.node_id,
        title: currentDecision.text || 'decision',
        text: ((currentDecision.text || '') + ' ' + (currentDecision.insight_body || '')).trim(),
        surface: 'now',
        createdAt: currentDecision.created_at || '',
        commentKind: 'decision_note',
        projectSummary: data.next || ''
      };
    }
    if (data.activeQuestionNode?.node_id) {
      return {
        kind: 'thread-comment',
        nodeId: data.activeQuestionNode.node_id,
        title: 'guided ask',
        text: data.activeQuestionNode.body || '',
        surface: 'now',
        createdAt: data.activeQuestionNode.created_at || '',
        commentKind: 'clarification',
        projectSummary: data.next || ''
      };
    }
    return null;
  }

  function buildShowTriangleItem() {
    const summary = buildShowSummary();
    const capture = summary.current;
    if (!capture) return null;
    return {
      type: 'show',
      id: capture?.entry_id || capture?.id || capture?.node_id || '',
      nodeId: capture?.node_id || '',
      project_id: capture?.project_id || getActiveProjectId(),
      title: 'visual note',
      body: getCaptureSummary(capture),
      summary: getCaptureSummary(capture),
      timeLabel: recentTimeLabel(summary.createdAt),
      created_at: summary.createdAt,
      analysisReady: !!summary.analysisReady,
      previewData: summary.imageHref || capture?.preview_data || capture?.meta?.preview_data || '',
      cardId: 'show'
    };
  }

  function buildTellTriangleItem() {
    const model = buildTellModel();
    const entry = model.current;
    if (!entry) return null;
    return {
      type: 'tell',
      id: entry?.node_id || entry?.entry_id || '',
      nodeId: entry?.node_id || '',
      project_id: getActiveProjectId(),
      title: entry?.title || 'voice note',
      body: entry?.body || entry?.title || '',
      summary: entry?.body || entry?.title || '',
      timeLabel: recentTimeLabel(entry?.created_at),
      created_at: entry?.created_at || '',
      cardId: 'tell'
    };
  }

  function buildKnowTriangleItem() {
    const model = buildKnowModel();
    const items = getKnowVisibleItems(model);
    const item = items[Math.max(0, Math.min(stateData.knowItemIndex || 0, Math.max(items.length - 1, 0)))];
    if (!item) return null;
    return {
      type: 'know',
      id: item?.node_id || `${item.source || 'know'}:${item.title || item.body || ''}`,
      nodeId: item?.node_id || '',
      project_id: getActiveProjectId(),
      title: item?.title || 'signal',
      body: item?.body || item?.title || '',
      summary: item?.body || item?.title || '',
      timeLabel: recentTimeLabel(item?.created_at),
      created_at: item?.created_at || '',
      cardId: 'know',
      knowType: item?.source === 'question' ? 'ask' : 'signal'
    };
  }

  function buildNowTriangleItem() {
    const data = buildNowSummary();
    if (data.pendingDecisions && data.pendingDecisions.length) {
      const current = data.pendingDecisions[data.pendingDecisionIndex] || data.pendingDecisions[0];
      const textValue = typeof current === 'string' ? current : (current?.text || '');
      return {
        type: 'now',
        id: current?.node_id || `decision:${textValue}`,
        nodeId: current?.node_id || '',
        project_id: getActiveProjectId(),
        title: 'decision',
        body: textValue,
        summary: textValue,
        timeLabel: recentTimeLabel(current?.created_at),
        created_at: current?.created_at || '',
        cardId: 'now',
        nowType: 'decision'
      };
    }
    if (data.blockerQuestion) {
      return {
        type: 'now',
        id: `question:${data.blockerQuestion}`,
        nodeId: data.activeQuestionNodeId || '',
        project_id: getActiveProjectId(),
        title: 'blocker',
        body: data.blockerQuestion,
        summary: data.blockerQuestion,
        timeLabel: 'now',
        created_at: new Date().toISOString(),
        cardId: 'now',
        nowType: 'question'
      };
    }
    return {
      type: 'now',
      id: `project:${getActiveProjectId()}`,
      nodeId: '',
      project_id: getActiveProjectId(),
      title: 'project state',
      body: data.next || data.insight || data.capture || 'project context',
      summary: data.next || data.insight || data.capture || 'project context',
      timeLabel: 'now',
      created_at: new Date().toISOString(),
      cardId: 'now',
      nowType: 'project'
    };
  }

  function buildTriangleCurrentItem() {
    switch (currentState) {
      case STATES.SHOW_BROWSE:
        return buildShowTriangleItem();
      case STATES.TELL_BROWSE:
        return buildTellTriangleItem();
      case STATES.KNOW_BROWSE:
      case STATES.KNOW_DETAIL:
        return buildKnowTriangleItem();
      case STATES.NOW_BROWSE:
        return buildNowTriangleItem();
      default:
        return null;
    }
  }

  function restoreTriangleOrigin() {
    const origin = stateData.triangleOrigin || {};
    const targetState = origin.state || STATES.HOME;
    const patch = origin.data || {};
    stateData.triangleStatus = '';
    transition(targetState, patch);
  }

  function dispatchTriangleDoubleSide(item) {
    if (!triangleEngine || !item || onboardingActive()) return false;
    const triangle = getTriangleState();
    if (triangle.mode === 'empty') {
      triangleEngine.copy(item);
      return true;
    }
    if (triangle.mode === 'armed' && triangleEngine.itemMatches?.(triangle.item, item)) {
      triangleEngine.dismiss();
      return true;
    }
    const originData = {
      state: currentState,
      data: {
        showCaptureIndex: stateData.showCaptureIndex,
        showCaptureEntryId: stateData.showCaptureEntryId || '',
        tellEntryIndex: stateData.tellEntryIndex || 0,
        knowLaneIndex: stateData.knowLaneIndex || 0,
        knowItemIndex: stateData.knowItemIndex || 0,
        knowChipIndex: stateData.knowChipIndex || 0,
        knowFocusNodeId: stateData.knowFocusNodeId || '',
        decisionIndex: stateData.decisionIndex || 0,
        selectedOption: stateData.selectedOption || 0
      }
    };
    triangleEngine.complete(item, originData);
    transition(STATES.TRIANGLE_OPEN, {
      triangleOrigin: originData,
      triangleStatus: 'hold ptt to tell your angle'
    });
    return true;
  }

  function buildHomeCardVoiceContext(card) {
    if (!card) return { kind: 'project', text: '', surface: 'tell' };
    if (card.id === 'tell') return buildTellVoiceContext();
    if (card.id === 'know') return { kind: 'know', text: 'selected knowledge focus', surface: 'know' };
    if (card.id === 'now') return buildNowVoiceContext();
    if (card.id === 'show') return { kind: 'show', text: 'visual capture context', surface: 'show' };
    return { kind: card.id, text: card.role || card.title || '', surface: card.id };
  }

  function drawTellSurface() {
    if (!surfaceIsVisible('tell')) return;
    const tellCard = cards.find(c => c.id === 'tell');
    const model = buildTellModel();
    const inlineListening = recordingActive() && activeSurface() === 'tell';

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: tellCard.color });
    drawSurfaceHeader(tellCard);
    mk('rect', { x: 14, y: 76, width: 212, height: 92, rx: 10, ry: 10, fill: 'rgba(8,8,8,0.14)' });
    if (inlineListening) {
      text(20, 102, 'listening on note', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      text(20, 126, 'release to build this note', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      if (model.current) {
        wrapTextBlock(undefined, lower(model.current.body || model.current.title || 'voice saved').slice(0, 120), 20, 150, 184, 13, 'rgba(8,8,8,0.76)', '12', 3);
      }
    } else if (model.current) {
      text(20, 92, `selected note · ${stateData.tellEntryIndex + 1}/${Math.max(model.entries.length, 1)}`, {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      text(218, 92, recentTimeLabel(model.current.created_at), {
        fill: 'rgba(8,8,8,0.42)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      wrapTextBlock(undefined, lower(model.current.body || model.current.title || 'voice saved').slice(0, 180), 20, 110, 186, 13, 'rgba(8,8,8,0.96)', '13', 4);
      if (model.threadSummary) {
        text(20, 158, 'comment · ' + lower(model.threadSummary).slice(0, 30), {
          fill: 'rgba(8,8,8,0.48)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
        drawKnowDepthGlyph(model.threadDepth || 0, 206, 150);
      }
    } else {
      const project = getProjectMemory();
      const openQ = (project?.open_questions || [])[0] || '';
      const lastSignal = (project?.insights || [])[0]?.body || '';
      text(20, 96, 'ready for voice', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      text(20, 114, 'hold ptt to begin', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      if (openQ) {
        text(20, 136, 'open ask:', {
          fill: 'rgba(8,8,8,0.38)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
        wrapTextBlock(undefined, lower(openQ.slice(0, 80)), 20, 150, 186, 12, 'rgba(8,8,8,0.76)', '11', 3);
      } else if (lastSignal) {
        text(20, 136, 'latest signal:', {
          fill: 'rgba(8,8,8,0.38)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
        wrapTextBlock(undefined, lower(lastSignal.slice(0, 80)), 20, 150, 186, 12, 'rgba(8,8,8,0.76)', '11', 3);
      }
    }

    const relatedIndexes = [];
    for (let offset = 1; offset < model.entries.length && relatedIndexes.length < 4; offset += 1) {
      relatedIndexes.push((model.currentIndex + offset) % model.entries.length);
    }
    relatedIndexes.forEach((absoluteIndex, index) => {
      const entry = model.entries[absoluteIndex];
      const y = 176 + (index * 26);
      const rowTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', {
        x: 14,
        y,
        width: 212,
        height: 22,
        rx: 6,
        ry: 6,
        fill: 'rgba(8,8,8,0.10)'
      }, rowTap);
      text(22, y + 13, lower((entry.body || entry.title || 'voice entry').slice(0, 34)), {
        fill: 'rgba(8,8,8,0.92)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      }, rowTap);
      rowTap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        fireFeedback('touch-commit');
        stateData.tellEntryIndex = absoluteIndex;
        stateData.tellStatus = 'saved';
        render();
      });
    });
    text(226, 276, model.entries.length > 1 ? 'scroll notes · hold ptt' : 'hold ptt', {
      fill: 'rgba(8,8,8,0.36)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
  }

  // === NOW panel render ===
  // Clean hierarchy: project name -> latest change -> pending decision -> stats
  function drawNowPanel() {
    if (!surfaceIsVisible('project')) return;
    const nowCard = cards.find(c => c.id === 'now');
    let data;
    try {
      data = buildNowSummary();
    } catch (error) {
      console.error('structa now render failed', error);
      mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: nowCard.color });
      drawSurfaceHeader(nowCard);
      text(14, 112, 'now recovering', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, 'back out, then reopen now. if the tutorial is stuck, use flush in projects.', 14, 138, 212, 14, 'rgba(8,8,8,0.80)', '13', 5);
      text(226, 276, 'back · reopen', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return;
    }
    const inlineListening = recordingActive() && activeSurface() === 'project';
    const queueCount = getQueuePendingJobs().length;

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: nowCard.color });
    drawSurfaceHeader(nowCard);
    if (drawOnboardingNowPanel(nowCard, data)) return;
    const hasBlockers = data.pendingDecisions.length > 0 || data.openQuestions > 0;
    const chainY = 78;
    const phaseLabel = {
      blocked: 'waiting on blocker',
      observe: 'observing',
      clarify: 'clarifying',
      research: 'working in background',
      evaluate: 'evaluating',
      decision: 'deciding',
      cooldown: 'cooling down',
      idle: 'idle'
    }[data.chainPhase] || data.chainPhase;

    if (!hasBlockers && data.chainPhase !== 'idle') {
      text(14, chainY + 8, phaseLabel, {
        fill: 'rgba(8,8,8,0.56)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      });
    }

    if (!hasBlockers) {
      if (data.lastImpact) {
        wrapTextBlock(undefined, lower(String(data.lastImpact.output).slice(0, 72)), 14, chainY + 24, 212, 13, 'rgba(8,8,8,0.96)', '13', 2);
      } else if (data.storedImpacts.length > 0) {
        wrapTextBlock(undefined, lower(String(data.storedImpacts[0].output || data.storedImpacts[0].type).slice(0, 72)), 14, chainY + 24, 212, 13, 'rgba(8,8,8,0.72)', '12', 2);
      }
    }

    if (data.queueBlocker) {
      const blocker = data.queueBlocker;
      const boxY = 84;
      mk('rect', { x: 10, y: boxY, width: 220, height: 142, rx: 8, fill: 'rgba(8,8,8,0.12)' });
      text(18, boxY + 16, 'background blocker', {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      wrapTextBlock(undefined, lower(String(blocker.body || 'background work stalled').slice(0, 132)), 18, boxY + 36, 192, 13, 'rgba(8,8,8,0.96)', '13', 5);
      mk('rect', { x: 18, y: boxY + 100, width: 88, height: 20, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.90)' });
      text(28, boxY + 113, 'click retry', {
        fill: 'rgba(244,239,228,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      });
      text(18, boxY + 136, 'double side skips', {
        fill: 'rgba(8,8,8,0.40)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    } else if (data.pendingDecisions.length > 0) {
      const pd = data.pendingDecisions[data.pendingDecisionIndex] || data.pendingDecisions[0];
      const pdText = typeof pd === 'string' ? pd : (pd.text || 'unnamed decision');
      const pdOptions = typeof pd === 'string' ? [] : (pd.options || []);
      const pdCount = data.pendingDecisions.length;
      const optionTapTargets = [];
      const controlTapTargets = [];

      const attachTap = (x, y, width, height, handler) => {
        const group = mk('g', { style: 'cursor: pointer;' });
        mk('rect', { x, y, width, height, rx: 8, ry: 8, fill: 'transparent' }, group);
        group.addEventListener('pointerup', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handler();
        });
        return group;
      };

      const boxY = 84;
      const boxH = pdOptions.length >= 2 ? 162 : 126;
      mk('rect', { x: 10, y: boxY, width: 220, height: boxH, rx: 8, fill: 'rgba(8,8,8,0.12)' });

      const countLabel = pdCount > 1 ? ` ${data.pendingDecisionIndex + 1}/${pdCount}` : '';
      text(18, boxY + 16, 'blocker' + countLabel, {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });

      const displayText = String(pdText || '').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const titleRows = wrapTextBlock(undefined, lower(displayText.slice(0, 118)), 18, boxY + 34, 190, 13, 'rgba(8,8,8,0.96)', '13', 5);
      if (data.activeThreadSummary) {
        text(18, boxY + 26 + (titleRows * 13) + 6, 'comment · ' + lower(data.activeThreadSummary).slice(0, 34), {
          fill: 'rgba(8,8,8,0.44)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
        drawKnowDepthGlyph(data.activeThreadDepth || 0, 204, boxY + 20 + (titleRows * 13));
      }

      if (pdOptions.length >= 2) {
        const slabY = boxY + 26 + (titleRows * 13) + (data.activeThreadSummary ? 20 : 10);
        pdOptions.slice(0, 3).forEach((opt, i) => {
          const slabTop = slabY + (i * 22);
          const isSelected = stateData.selectedOption === i;
          mk('rect', {
            x: 18,
            y: slabTop,
            width: 204,
            height: 18,
            rx: 6,
            ry: 6,
            fill: isSelected ? 'rgba(8,8,8,0.90)' : 'rgba(8,8,8,0.14)'
          });
          text(24, slabTop + 12, lower(String(opt).slice(0, 34)), {
            fill: isSelected ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.90)',
            'font-family': 'PowerGrotesk-Regular, sans-serif',
            'font-size': '11'
          });
          optionTapTargets.push({ x: 18, y: slabTop, width: 204, height: 18, handler: () => {
            stateData.selectedOption = i;
            render();
          } });
        });
      }

      const ctrlY = boxY + boxH - 24;
      mk('rect', { x: 18, y: ctrlY, width: 96, height: 18, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.90)' });
      text(28, ctrlY + 12, 'approve', { fill: 'rgba(244,239,228,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '11' });
      mk('rect', { x: 122, y: ctrlY, width: 48, height: 18, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.16)' });
      text(132, ctrlY + 12, 'skip', { fill: 'rgba(8,8,8,0.92)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '11' });
      controlTapTargets.push({ x: 18, y: ctrlY, width: 96, height: 18, handler: approveCurrentNowDecision });
      controlTapTargets.push({ x: 122, y: ctrlY, width: 48, height: 18, handler: dismissCurrentNowDecision });
      if (pdCount > 1) {
        mk('rect', { x: 178, y: ctrlY, width: 44, height: 18, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.16)' });
        text(188, ctrlY + 12, 'next', { fill: 'rgba(8,8,8,0.92)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '11' });
        controlTapTargets.push({ x: 178, y: ctrlY, width: 44, height: 18, handler: advanceCurrentNowDecision });
      }

      optionTapTargets.forEach(target => attachTap(target.x, target.y, target.width, target.height, target.handler));
      controlTapTargets.forEach(target => attachTap(target.x, target.y, target.width, target.height, target.handler));
    } else if (data.projectCapNotice || data.openQuestions > 0) {
      const boxY = 78;
      mk('rect', { x: 10, y: boxY, width: 220, height: 178, rx: 12, fill: 'rgba(8,8,8,0.15)' });
      const reasoningLabel = lower(data.activeQuestionNode?.source || '') === 'chain' ? 'from reasoning' : 'question';
      text(18, boxY + 18, reasoningLabel, {
        fill: 'rgba(8,8,8,0.52)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      mk('rect', { x: 14, y: boxY + 28, width: 3, height: 110, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.72)' });
      const blockerText = String(data.blockerQuestion || '').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const blockerRows = wrapTextBlock(undefined, lower(blockerText.slice(0, 152)), 20, boxY + 40, 192, 14, 'rgba(8,8,8,0.96)', '14', 5);
      if (data.activeThreadSummary) {
        text(20, boxY + 46 + blockerRows * 14, 'comment · ' + lower(data.activeThreadSummary).slice(0, 36), {
          fill: 'rgba(8,8,8,0.44)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
        drawKnowDepthGlyph(data.activeThreadDepth || 0, 204, boxY + 38 + blockerRows * 14);
      }
      const ctaY = Math.min(boxY + 130, boxY + 42 + blockerRows * 14 + (data.activeThreadSummary ? 28 : 16));
      if (!data.projectCapNotice) {
        mk('rect', { x: 18, y: ctaY, width: 148, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
        text(30, ctaY + 16, inlineListening ? 'release to send answer' : 'hold ptt to answer', {
          fill: 'rgba(244,239,228,0.96)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '12'
        });
      }
      if (data.blockerCount > 1) {
        text(18, ctaY + 42, `${data.blockerCount} asks waiting`, {
          fill: 'rgba(8,8,8,0.36)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10'
        });
      }
      if (stateData.nowFeedback) {
        text(222, ctaY + 42, lower(stateData.nowFeedback), {
          fill: 'rgba(8,8,8,0.44)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10',
          'text-anchor': 'end'
        });
      }
    } else {
      const mainPrompt = lower(data.next || (projectHasMeaningfulContent() ? 'hold ptt or open show to extend the project' : 'hold ptt or open show to begin'));
      text(14, 112, COPY.boilerRoomReady, {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, mainPrompt, 14, 138, 212, 14, 'rgba(8,8,8,0.80)', '13', 4);
      if (data.chainPhase !== 'idle') {
        text(14, 214, phaseLabel, {
          fill: 'rgba(8,8,8,0.46)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '11'
        });
      }
    }

    text(226, 276, hasBlockers ? (queueCount ? COPY.queuedWorking(queueCount) : COPY.waitingAnswer) : (queueCount ? COPY.queuedWorking(queueCount) : (projectHasMeaningfulContent() ? COPY.holdPttExtend : COPY.holdPttBegin)), {
      fill: 'rgba(8,8,8,0.36)',
      'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10', 'text-anchor': 'end'
    });
  }

  // === KNOW surface ===
  function drawInsightSurface() {
    if (!surfaceIsVisible('insight')) return;
    const knowCard = cards.find(c => c.id === 'know');
    const model = buildKnowModel();
    const laneIdx = stateData.knowLaneIndex || 0;
    const chipIdx = stateData.knowChipIndex || 0;
    const itemIdx = stateData.knowItemIndex || 0;
    const lane = model.lanes[laneIdx] || model.lanes[0];
    if (!lane) return;
    const availableChipIndexes = lane.availableChipIndexes?.length ? lane.availableChipIndexes : [0];
    const safeChipIdx = availableChipIndexes.includes(chipIdx) ? chipIdx : availableChipIndexes[0];
    stateData.knowChipIndex = safeChipIdx;
    const chip = model.chips[safeChipIdx] || model.chips[0];
    const items = getKnowVisibleItems(model);
    const safeItemIdx = Math.min(itemIdx, items.length - 1);
    if (safeItemIdx !== itemIdx) stateData.knowItemIndex = safeItemIdx;
    const item = items[safeItemIdx] || lane.items[0];

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: knowCard.color });
    drawSurfaceHeader(knowCard, { hideSubtitle: true });

    if (onboardingActive() && getOnboardingStep() === 4) {
      const cameraDenied = !!getUIState().tutorial_step4_camera_denied;
      mk('rect', { x: 10, y: 84, width: 220, height: 152, rx: 12, fill: 'rgba(8,8,8,0.12)' });
      text(18, 104, 'lesson 4 · open show', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, cameraDenied
        ? 'camera needs permission first. click once to allow camera, or long-press home to skip.'
        : 'back once, then open show. add one frame to finish the tutorial.',
      18, 132, 194, 14, 'rgba(8,8,8,0.78)', '13', 6);
      text(18, 218, cameraDenied ? 'click once → allow camera' : 'back → show', {
        fill: 'rgba(8,8,8,0.54)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'show → first frame', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return;
    }
    const LAYOUT = { top: 72, tabsH: 20, branchH: 18, footerY: 282, gap: 5 };
    const detailMode = currentState === STATES.KNOW_DETAIL;
    const laneTabs = [
      { id: 'questions', label: 'asks', width: 42 },
      { id: 'signals', label: 'signals', width: 48 },
      { id: 'decisions', label: 'decided', width: 54 },
      { id: 'open loops', label: 'loops', width: 42 }
    ];
    let tabX = 14;
    laneTabs.forEach((tab, i) => {
      const isActive = lane.id === tab.id;
      const pillGroup = mk('g', { 'data-lane-index': i, style: 'cursor: pointer;' });
      mk('rect', {
        x: tabX, y: LAYOUT.top, width: tab.width, height: LAYOUT.tabsH, rx: 6, ry: 6,
        fill: isActive ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.10)',
        stroke: isActive ? 'rgba(8,8,8,0.06)' : 'rgba(8,8,8,0.04)',
        'stroke-width': 1
      }, pillGroup);
      const tabText = mk('text', {
        x: tabX + tab.width / 2, y: LAYOUT.top + 14,
        fill: isActive ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.76)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '11', 'text-anchor': 'middle'
      }, pillGroup);
      tabText.textContent = lower(tab.label);
      pillGroup.addEventListener('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fireFeedback('touch-commit');
        stateData.knowLaneIndex = i;
        stateData.knowItemIndex = 0;
        stateData.knowBodyScrollTop = 0;
        const newLane = model.lanes[i];
        const activeChip = model.chips[stateData.knowChipIndex]?.id;
        const hasChipItems = newLane?.items?.some(function(entry) { return entry.chips.includes(activeChip); });
        if (!hasChipItems) stateData.knowChipIndex = newLane?.availableChipIndexes?.[0] ?? 0;
        render();
      });
      tabX += tab.width + 6;
    });

    const activeChips = model.chips.filter((c, i) => availableChipIndexes.includes(i));
    const showChipRow = lane.id === 'signals' && activeChips.length > 1;
    let contentCursorY = LAYOUT.top + LAYOUT.tabsH + LAYOUT.gap;
    if (showChipRow) {
      let chipX = 14;
      activeChips.forEach((c) => {
        const realIndex = model.chips.indexOf(c);
        const isActive = realIndex === safeChipIdx;
        const chipWidth = Math.max(38, c.label.length * 6 + 16);
        const chipGroup = mk('g', { 'data-chip-index': realIndex, style: 'cursor: pointer;' });
        mk('rect', {
          x: chipX, y: contentCursorY, width: chipWidth, height: LAYOUT.branchH, rx: 6, ry: 6,
          fill: isActive ? 'rgba(8,8,8,0.92)' : 'rgba(8,8,8,0.10)',
          stroke: isActive ? 'rgba(8,8,8,0.10)' : 'rgba(8,8,8,0.05)', 'stroke-width': 1
        }, chipGroup);
        const chipText = mk('text', {
          x: chipX + chipWidth / 2, y: contentCursorY + 12,
          fill: isActive ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.76)',
          'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10', 'text-anchor': 'middle'
        }, chipGroup);
        chipText.textContent = lower(c.label);
        chipGroup.addEventListener('pointerup', (e) => {
          e.preventDefault();
          e.stopPropagation();
          fireFeedback('touch-commit');
          stateData.knowChipIndex = realIndex;
          stateData.knowItemIndex = 0;
          stateData.knowBodyScrollTop = 0;
          render();
        });
        chipX += chipWidth + 6;
      });
      contentCursorY += LAYOUT.branchH + LAYOUT.gap;
    }

    const frame = {
      x: 10,
      y: contentCursorY + 2,
      width: 220,
      height: Math.max(110, LAYOUT.footerY - (contentCursorY + 2) - 12)
    };
    const dotsCount = Math.min(Math.max(1, items.length || 1), 6);
    const dotsIndex = Math.min(safeItemIdx, dotsCount - 1);
    const dotsWidth = dotsCount > 1 ? ((dotsCount - 1) * 8) : 0;
    if (dotsCount > 1) {
      drawKnowItemDots(dotsCount, dotsIndex, frame.x + frame.width - dotsWidth - 10, frame.y - 6);
    }

    const nextText = lower(String(item?.next || '')).replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const html = buildKnowFrameMarkup({
      ...item,
      body: detailMode && nextText && nextText !== 'review this'
        ? ((item?.body || 'no content yet') + '\n\nnext move\n' + nextText)
        : (item?.body || 'no content yet')
    }, detailMode);
    drawKnowScrollFrame({ html: html }, frame, `${currentState}:${lane.id}:${safeChipIdx}:${safeItemIdx}:${item?.node_id || item?.created_at || ''}:${item?.threadDepth || 0}`);

    if (item?.triangulated) {
      text(frame.x + frame.width - 38, contentCursorY - 2, '▼', {
        fill: 'rgba(8,8,8,0.58)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '9'
      });
      if (item?.meta?.triangle_format !== 'claims-v1') {
        text(frame.x + frame.width - 18, contentCursorY - 2, 'legacy', {
          fill: 'rgba(8,8,8,0.42)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '7',
          'text-anchor': 'end'
        });
      }
    }
    drawKnowEvidenceGlyph(item?.evidenceStrength || 0, frame.x + frame.width - 42, frame.y + 10);
    drawKnowDepthGlyph(item?.threadDepth || 0, frame.x + frame.width - 22, frame.y + frame.height - 16);
    if (!(item?.threadDepth > 0) && !getUIState().depth_chevron_seen) {
      const chevron = text(frame.x + frame.width - 16, frame.y + frame.height - 30, '⌄', {
        fill: 'rgba(8,8,8,0.28)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      mk('animateTransform', {
        attributeName: 'transform',
        type: 'translate',
        values: '0 0;0 3;0 0',
        dur: '0.52s',
        repeatCount: '1'
      }, chevron);
    }

    if (!detailMode) {
      const frameTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 10, ry: 10, fill: 'transparent' }, frameTap);
      frameTap.addEventListener('pointerup', function(e) {
        e.preventDefault();
        e.stopPropagation();
        fireFeedback('touch-commit');
        transition(STATES.KNOW_DETAIL);
      });
    } else if (item?.triangulated && item?.meta?.triangle_format === 'claims-v1') {
      const rejectTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 10, ry: 10, fill: 'transparent' }, rejectTap);
      rejectTap.addEventListener('pointerup', function(e) {
        e.preventDefault();
        e.stopPropagation();
        fireFeedback('blocked');
        if (rejectTriangleSignal(item)) transition(STATES.KNOW_BROWSE);
      });
    }

    const footerLeft = `${Math.min(safeItemIdx + 1, Math.max(items.length, 1))} of ${Math.max(items.length, 1)}`;
    const footerRight = onboardingActive() && getOnboardingStep() === 3
      ? 'scroll once'
      : (!detailMode ? 'click · detail' : (item?.triangulated && item?.meta?.triangle_format === 'claims-v1'
        ? 'click · reject'
        : (item?.source === 'question' ? 'hold ptt · answer' : 'hold ptt · comment')));
    text(14, LAYOUT.footerY, footerLeft, {
      fill: 'rgba(8,8,8,0.44)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10'
    });
    text(226, LAYOUT.footerY, footerRight, {
      fill: 'rgba(8,8,8,0.44)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
  }

  // === Main render ===
  function renderNow() {
    const renderStartedAt = performance.now();
    renderScheduled = false;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawWordmark();

    const surface = activeSurface();

    if (surface === 'home' && currentState !== STATES.PROJECT_SWITCHER) {
      cards
        .map((card, index) => ({ card, index, layout: cardLayout(index) }))
        .sort((a, b) => {
          if (a.layout.depth === -1) return 1;
          if (b.layout.depth === -1) return -1;
          return a.layout.depth - b.layout.depth;
        })
        .forEach(({ card, index }) => drawCard(card, index));
    }

    drawProjectSwitcher();
    drawShowSurface();
    drawTellSurface();
    drawNowPanel();
    drawInsightSurface();
    drawTriangleOverlay();
    drawTriangleIndicator();
    drawAmbientQueueIndicator();

    const isContentSurface = surface === 'project' || surface === 'insight' || surface === 'show' || surface === 'tell' || surface === 'triangle' || currentState === STATES.PROJECT_SWITCHER;
    logDrawer.style.display = isContentSurface ? 'none' : '';
    lastRenderDurationMs = performance.now() - renderStartedAt;
  }

  function render() {
    scheduleRender();
  }

  // === Input handlers (all routed through state machine) ===

  function handleScrollDirection(direction) {
    clearPendingSideClick();
    if (stateData.flushRequestSource) {
      clearFlushRequest();
      scheduleRender();
      return;
    }
    switch (currentState) {
      case STATES.PROJECT_SWITCHER: {
        if (onboardingActive() && !onboardingAllowsProjectSwitcher()) break;
        const rows = getProjectSwitcherRows();
        if (!rows.length) break;
        const currentIndex = typeof stateData.projectListIndex === 'number' ? stateData.projectListIndex : 0;
        stateData.projectListIndex = Math.max(0, Math.min(currentIndex + (direction > 0 ? 1 : -1), rows.length - 1));
        stateData.projectFlushConfirm = false;
        render();
        break;
      }

      case STATES.SHOW_BROWSE: {
        const captures = getCaptureList();
        if (!captures.length) break;
        const max = captures.length;
        stateData.showCaptureIndex = ((stateData.showCaptureIndex || 0) + (direction > 0 ? 1 : -1) + max) % max;
        const capture = captures[stateData.showCaptureIndex] || null;
        stateData.showCaptureEntryId = capture?.entry_id || capture?.id || '';
        stateData.showStatus = 'reviewing';
        render();
        break;
      }

      case STATES.TELL_BROWSE: {
        const entries = getVoiceEntries();
        if (!entries.length) break;
        const max = entries.length;
        stateData.tellEntryIndex = ((stateData.tellEntryIndex || 0) + (direction > 0 ? 1 : -1) + max) % max;
        stateData.tellStatus = 'reviewing';
        render();
        break;
      }

      case STATES.SHOW_PRIMED:
        // Scroll while primed — open camera
        openCameraFromShow('touch');
        break;

      case STATES.CAMERA_OPEN:
        window.StructaCamera?.flip?.();
        break;

      case STATES.VOICE_OPEN:
        break;

      case STATES.KNOW_BROWSE: {
        const model = buildKnowModel();
        const items = getKnowVisibleItems(model);
        if (!items.length) break;
        stateData.knowItemIndex = ((stateData.knowItemIndex || 0) + (direction > 0 ? 1 : -1) + items.length) % items.length;
        render();
        break;
      }

      case STATES.KNOW_DETAIL: {
        const model = buildKnowModel();
        const items = getKnowVisibleItems(model);
        if (!items.length) break;
        const maxScroll = Math.max(0, Number(stateData.knowBodyMaxScroll || 0));
        const currentScroll = Math.max(0, Number(stateData.knowBodyScrollTop || 0));
        if (maxScroll > 6) {
          const nextScroll = Math.max(0, Math.min(maxScroll, currentScroll + (direction > 0 ? 36 : -36)));
          if (nextScroll !== currentScroll) {
            stateData.knowBodyScrollTop = nextScroll;
            render();
            break;
          }
        }
        stateData.knowItemIndex = (stateData.knowItemIndex + (direction > 0 ? 1 : -1) + items.length) % items.length;
        stateData.knowBodyScrollTop = 0;
        stateData.knowBodyMaxScroll = 0;
        render();
        break;
      }

      case STATES.NOW_BROWSE: {
        if (onboardingActive() && getOnboardingStep() === 2 && getUIState().tutorial_step2_fallback_visible) {
          const currentIndex = tutorialStep2FallbackIndex();
          const nextIndex = (currentIndex + (direction > 0 ? 1 : -1) + TUTORIAL_FALLBACK_OPTIONS.length) % TUTORIAL_FALLBACK_OPTIONS.length;
          native?.updateUIState?.({ tutorial_step2_fallback_index: nextIndex });
          render();
          break;
        }
        const project = getProjectMemory();
        const pending = project?.pending_decisions || [];
        const current = pending[stateData.decisionIndex || 0];
        const options = (typeof current !== 'string' && current?.options) || [];

        // If decision has 3 options, scroll cycles options first
        if (options.length >= 2 && stateData.selectedOption !== undefined) {
          stateData.selectedOption = (stateData.selectedOption + (direction > 0 ? 1 : -1) + options.length) % options.length;
          render();
        } else if (pending.length > 1) {
          stateData.decisionIndex = (stateData.decisionIndex + (direction > 0 ? 1 : -1) + pending.length) % pending.length;
          stateData.selectedOption = 0;
          render();
        }
        // no-op when no decisions and no options — don't eject to HOME
        break;
      }

      case STATES.LOG_OPEN: {
        const delta = direction > 0 ? 28 : -28;
        log.scrollTop += delta;
        break;
      }

      case STATES.HOME:
        if (onboardingActive()) {
          const step = getOnboardingStep();
          if (step < 3) break;
          selectNextAllowedCard(direction);
          break;
        }
        selectIndex(selectedIndex + (direction > 0 ? 1 : -1));
        break;

      default:
        break;
    }
  }

  function dispatchScrollStep(direction, source = 'native') {
    if (!direction) return;
    const normalized = direction > 0 ? 1 : -1;
    if (source === 'native') {
      const now = performance.now();
      if (normalized === lastNativeScrollDirection && now - lastNativeScrollAt < NATIVE_SCROLL_DEDUPE_MS) {
        return;
      }
      lastNativeScrollAt = now;
      lastNativeScrollDirection = normalized;
    }
    markScrollActivity();
    fireFeedback('scroll-step');
    handleScrollDirection(normalized);
  }

  function supportsDoubleSideClick() {
    switch (currentState) {
      case STATES.HOME:
      case STATES.PROJECT_SWITCHER:
      case STATES.SHOW_BROWSE:
      case STATES.TELL_BROWSE:
      case STATES.KNOW_BROWSE:
      case STATES.KNOW_DETAIL:
      case STATES.NOW_BROWSE:
      case STATES.LOG_OPEN:
        return true;
      default:
        return false;
    }
  }

  function handleDoubleSideClick() {
    if (stateData.flushRequestSource) {
      clearFlushRequest();
      scheduleRender();
      return;
    }
    switch (currentState) {
      case STATES.HOME:
      case STATES.PROJECT_SWITCHER: {
        selectedIndex = cards.findIndex(function(card) { return card.id === 'show'; });
        native?.setActiveNode?.('show');
        native?.updateUIState?.({ selected_card_id: 'show', last_surface: 'home' });
        openCameraFromShow('touch');
        break;
      }

      case STATES.SHOW_BROWSE:
      case STATES.TELL_BROWSE:
      case STATES.KNOW_BROWSE:
      case STATES.KNOW_DETAIL:
      case STATES.NOW_BROWSE: {
        if (currentState === STATES.NOW_BROWSE && buildNowSummary().queueBlocker) {
          skipCurrentQueueBlocker();
          break;
        }
        fireFeedback('touch-commit');
        dispatchTriangleDoubleSide(buildTriangleCurrentItem());
        break;
      }

      case STATES.LOG_OPEN:
        fireFeedback('touch-commit');
        window.StructaImpactChain?.stop?.();
        pushLog('chain killed by user', 'system');
        break;

      default:
        break;
    }
  }

  function handleSideClick() {
    if (getUIState().flush_undo_available_until > Date.now() && currentState === STATES.NOW_BROWSE) {
      native?.updateUIState?.({ flush_undo_available_until: 0 });
      transition(STATES.HOME);
      return;
    }
    if (stateData.flushRequestSource) {
      fireFeedback('touch-commit');
      clearFlushRequest();
      scheduleRender();
      return;
    }
    switch (currentState) {
      case STATES.PROJECT_SWITCHER:
        if (!activateSelectedProject()) fireFeedback('blocked');
        break;

      case STATES.SHOW_BROWSE:
        openCameraFromShow('touch');
        break;

      case STATES.TELL_BROWSE: {
        // Side click on TELL = open KNOW to see impact of this note
        const tellContext = buildTellVoiceContext();
        if (tellContext.text) {
          fireFeedback('touch-commit');
          const project = getProjectMemory();
          const relatedInsights = (project?.insights || []).filter(function(insight) {
            return insight?.node_id === tellContext.nodeId || (insight?.links || []).includes(tellContext.nodeId);
          });
          if (!relatedInsights.length) {
            pushLog('no impacts from note yet', 'voice');
          }
          selectedIndex = cards.findIndex(c => c.id === 'know');
          transition(STATES.KNOW_BROWSE, { knowLaneIndex: 1, knowItemIndex: 0, knowFocusNodeId: tellContext.nodeId || '' });
        } else {
          fireFeedback('blocked');
        }
        break;
      }

      case STATES.SHOW_PRIMED:
        // Side while primed — open camera
        openCameraFromShow('touch');
        break;

      case STATES.CAMERA_OPEN:
        // Side = capture
        fireFeedback('touch-commit');
        transition(STATES.CAMERA_CAPTURE);
        break;

      case STATES.VOICE_OPEN:
        if (window.StructaVoice?.listening) {
          window.StructaVoice?.stopListening?.(true);
          transition(STATES.VOICE_PROCESSING);
        } else {
          goHome();
        }
        break;

      case STATES.KNOW_BROWSE:
        // Side = open detail
        fireFeedback('touch-commit');
        transition(STATES.KNOW_DETAIL);
        break;

      case STATES.KNOW_DETAIL: {
        const model = buildKnowModel();
        const items = getKnowVisibleItems(model);
        const item = items[stateData.knowItemIndex || 0];
        if (item && item.source === 'question' && item.questionIndex !== undefined) {
          fireFeedback('touch-commit');
          transition(STATES.KNOW_ANSWER, {
            question: {
              index: item.questionIndex,
              nodeId: item.node_id || '',
              text: item.body,
              source: item.source || 'question'
            }
          });
          return;
        }
        fireFeedback('touch-commit');
        transition(STATES.KNOW_BROWSE, { preserveKnowFocus: true });
        break;
      }

      case STATES.NOW_BROWSE: {
        if (onboardingActive()) {
          const step = getOnboardingStep();
          if (step === 0) {
            fireFeedback('touch-commit');
            setOnboardingStep(1, { via: 'primary' });
            pushLog('lesson 0 complete', 'system');
            render();
            return;
          }
          if (step === 2 && getUIState().tutorial_step2_fallback_visible) {
            fireFeedback('touch-commit');
            submitTutorialWheelFallback();
            return;
          }
          fireFeedback('blocked');
          return;
        }
        if (buildNowSummary().queueBlocker) {
          retryCurrentQueueBlocker();
          return;
        }
        if (approveCurrentNowDecision()) {
          if (window.StructaAudio?.play) window.StructaAudio.play('approve');
          return;
        }
        fireFeedback('blocked');
        pushLog('hold ptt to answer blocker', 'project');
        break;
      }

      case STATES.LOG_OPEN:
        fireFeedback('touch-commit');
        if (window.StructaImpactChain?.active && !window.StructaImpactChain?.manuallyStopped) {
          window.StructaImpactChain?.pause?.('manual stop');
          pushLog('chain paused', 'system');
        } else {
          window.StructaImpactChain?.resumeManual?.();
          pushLog('chain resumed', 'system');
        }
        scheduleLogRefresh({ forceFollow: true });
        break;

      case STATES.HOME:
        if (onboardingActive() && !homeOnboardingSelectionAllowed(currentCard().id)) {
          fireFeedback('blocked');
          return;
        }
        openCard(currentCard());
        break;

      default:
        break;
    }
  }

  function triggerSideClick() {
    if (!supportsDoubleSideClick()) {
      handleSideClick();
      return;
    }
    if (sideClickTimer) {
      clearTimeout(sideClickTimer);
      sideClickTimer = null;
      handleDoubleSideClick();
      return;
    }
    sideClickTimer = setTimeout(function() {
      sideClickTimer = null;
      handleSideClick();
    }, DOUBLE_SIDE_WINDOW_MS);
  }

  function clearPendingSideClick() {
    if (!sideClickTimer) return;
    clearTimeout(sideClickTimer);
    sideClickTimer = null;
  }

  function clearTouchLogPress() {
    if (touchLogPressTimer) {
      clearTimeout(touchLogPressTimer);
      touchLogPressTimer = null;
    }
    touchLogPressPointerId = null;
    touchLogPressStart = null;
  }

  function clearTutorialSkipTouch() {
    if (tutorialSkipTimer) {
      clearTimeout(tutorialSkipTimer);
      tutorialSkipTimer = null;
    }
    tutorialSkipPointerId = null;
    tutorialSkipStart = null;
  }

  function touchLogAllowed() {
    switch (currentState) {
      case STATES.CAMERA_OPEN:
      case STATES.CAMERA_CAPTURE:
      case STATES.VOICE_OPEN:
      case STATES.VOICE_PROCESSING:
        return false;
      default:
        return true;
    }
  }

  function forceOpenDebugLogs() {
    if (!touchLogAllowed() || currentState === STATES.LOG_OPEN) return false;
    clearPendingSideClick();
    logReturnState = currentState;
    transition(STATES.LOG_OPEN);
    return true;
  }

  function onTutorialSkipPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    if (!tutorialSkipEligible()) return;
    clearTutorialSkipTouch();
    tutorialSkipTriggered = false;
    tutorialSkipPointerId = event.pointerId;
    tutorialSkipStart = { x: event.clientX, y: event.clientY };
    tutorialSkipTimer = setTimeout(function() {
      if (tutorialSkipPointerId !== event.pointerId) return;
      tutorialSkipTriggered = skipTutorialStep(getOnboardingStep(), 'long-press-home');
      if (tutorialSkipTriggered) tutorialSkipSuppressClickUntil = Date.now() + 450;
      clearTutorialSkipTouch();
    }, TUTORIAL_SKIP_LONG_PRESS_MS);
  }

  function onTutorialSkipPointerMove(event) {
    if (event.pointerType !== 'touch') return;
    if (tutorialSkipPointerId !== event.pointerId || !tutorialSkipStart) return;
    var dx = Math.abs((event.clientX || 0) - tutorialSkipStart.x);
    var dy = Math.abs((event.clientY || 0) - tutorialSkipStart.y);
    if (dx > TUTORIAL_SKIP_MOVE_TOLERANCE || dy > TUTORIAL_SKIP_MOVE_TOLERANCE) {
      clearTutorialSkipTouch();
    }
  }

  function onTutorialSkipPointerEnd(event) {
    if (event.pointerType !== 'touch') return;
    if (tutorialSkipPointerId !== null && event.pointerId === tutorialSkipPointerId) {
      clearTutorialSkipTouch();
    }
    if (!tutorialSkipTriggered) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    tutorialSkipTriggered = false;
  }

  function handleLongPressStart() {
    clearPendingSideClick();
    if (getUIState().flush_undo_available_until > Date.now() && currentState === STATES.NOW_BROWSE && native?.restoreLastFlushSnapshot) {
      clearFlushConfirmTimer();
      stateData.flushConfirmHolding = true;
      flushConfirmTimer = setTimeout(function() {
        flushConfirmTimer = null;
        native.restoreLastFlushSnapshot().then(function(result) {
          stateData.flushConfirmHolding = false;
          if (result?.ok) {
            transition(STATES.HOME);
          } else {
            native?.updateUIState?.({ flush_undo_available_until: 0 });
            transition(STATES.HOME);
          }
        }).catch(function() {
          stateData.flushConfirmHolding = false;
          native?.updateUIState?.({ flush_undo_available_until: 0 });
          transition(STATES.HOME);
        });
      }, FLUSH_CONFIRM_HOLD_MS);
      return;
    }
    if (stateData.flushRequestSource && currentState === STATES.NOW_BROWSE) {
      clearFlushConfirmTimer();
      stateData.flushConfirmHolding = true;
      flushConfirmTimer = setTimeout(function() {
        flushConfirmTimer = null;
        confirmFlushRequest();
      }, FLUSH_CONFIRM_HOLD_MS);
      return;
    }
    switch (currentState) {
      case STATES.PROJECT_SWITCHER:
        break;

      case STATES.HOME: {
        if (onboardingActive()) break;
        const card = currentCard();
        voiceReturnState = STATES.HOME;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'listening',
          inlinePTTSurface: 'home',
          buildContext: buildHomeCardVoiceContext(card)
        });
        break;
      }

      case STATES.TELL_BROWSE:
        if (!buildTellCommentContext()) break;
        voiceReturnState = STATES.TELL_BROWSE;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'commenting',
          inlinePTTSurface: 'tell',
          buildContext: buildTellCommentContext()
        });
        break;

      case STATES.SHOW_BROWSE:
        if (window.StructaCamera?.getPendingAnnotation?.()) {
          const pendingAnnotation = window.StructaCamera.beginPendingAnnotation?.();
          if (!pendingAnnotation) break;
          voiceReturnState = STATES.SHOW_BROWSE;
          transition(STATES.VOICE_OPEN, {
            fromPTT: true,
            tellStatus: 'tagging frame',
            inlinePTTSurface: 'show',
            buildContext: {
              kind: 'capture-annotation',
              nodeId: pendingAnnotation.nodeId || '',
              entryId: pendingAnnotation.entryId || '',
              surface: 'show',
              text: 'tag this frame for the project'
            }
          });
          break;
        }
        if (!buildShowCommentContext()) {
          break;
        }
        voiceReturnState = STATES.SHOW_BROWSE;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'commenting',
          inlinePTTSurface: 'show',
          buildContext: buildShowCommentContext()
        });
        break;

      case STATES.CAMERA_OPEN:
        // PTT while camera is open = SHOW+TELL voice strip
        window.StructaCamera?.startVoiceStrip?.();
        break;

      case STATES.NOW_BROWSE: {
        if (onboardingActive() && getOnboardingStep() !== 2) {
          break;
        }
        if (onboardingActive() && getOnboardingStep() === 2) {
          native?.updateUIState?.({ tutorial_step2_ptt_attempted: true });
        }
        const project = getProjectMemory();
        const openQuestionNodes = project?.open_question_nodes || [];
        voiceReturnState = STATES.NOW_BROWSE;
        if (onboardingActive() && getOnboardingStep() === 2) {
          transition(STATES.VOICE_OPEN, {
            answeringQuestion: { index: -1, text: 'what is this project about?', onboarding: true },
            fromPTT: true,
            inlinePTTSurface: 'project'
          });
        } else if (openQuestionNodes.length) {
          const openQuestion = openQuestionNodes[0] || {};
          transition(STATES.VOICE_OPEN, {
            answeringQuestion: {
              index: 0,
              nodeId: openQuestion.node_id || '',
              text: openQuestion.body || openQuestion.title || '',
              source: openQuestion.source || 'question'
            },
            fromPTT: true,
            inlinePTTSurface: 'project'
          });
        } else if (buildNowCommentContext()) {
          transition(STATES.VOICE_OPEN, {
            fromPTT: true,
            tellStatus: 'commenting',
            inlinePTTSurface: 'project',
            buildContext: buildNowCommentContext()
          });
        } else {
          transition(STATES.VOICE_OPEN, {
            fromPTT: true,
            tellStatus: 'listening',
            inlinePTTSurface: 'project',
            buildContext: buildNowVoiceContext()
          });
        }
        break;
      }

      case STATES.VOICE_OPEN:
        // PTT while voice is already open — no-op
        document.body.classList.add('input-locked');
        window.StructaVoice?.startListening?.();
        break;

      case STATES.LOG_OPEN:
        voiceReturnState = STATES.LOG_OPEN;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'log note',
          inlinePTTSurface: 'log',
          buildContext: {
            kind: 'log-note',
            text: getQueueLine(),
            surface: 'log'
          }
        });
        break;

      case STATES.KNOW_BROWSE:
        if (!buildKnowCommentContext()) break;
        voiceReturnState = STATES.KNOW_BROWSE;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'commenting',
          inlinePTTSurface: 'insight',
          buildContext: buildKnowCommentContext()
        });
        break;

      case STATES.KNOW_DETAIL: {
        const model = buildKnowModel();
        const items = getKnowVisibleItems(model);
        const item = items[stateData.knowItemIndex || 0];
        if (item && item.source === 'question' && item.questionIndex !== undefined) {
          transition(STATES.KNOW_ANSWER, {
            question: {
              index: item.questionIndex,
              nodeId: item.node_id || '',
              text: item.body,
              source: item.source || 'question'
            }
          });
        } else {
          if (!buildKnowCommentContext()) break;
          voiceReturnState = STATES.KNOW_DETAIL;
          transition(STATES.VOICE_OPEN, {
            fromPTT: true,
            tellStatus: 'commenting',
            inlinePTTSurface: 'insight',
            buildContext: buildKnowCommentContext()
          });
        }
        break;
      }

      case STATES.TRIANGLE_OPEN:
        voiceReturnState = STATES.TRIANGLE_OPEN;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          inlinePTTSurface: 'triangle',
          triangleMode: true
        });
        break;

      default:
        break;
    }
  }

  function handleLongPressEnd() {
    clearPendingSideClick();
    document.body.classList.remove('input-locked');
    if (stateData.flushConfirmHolding) {
      stateData.flushConfirmHolding = false;
      clearFlushConfirmTimer();
      scheduleRender();
      return;
    }

    switch (currentState) {
      case STATES.SHOW_PRIMED:
        stateData.pendingShowNarration = false;
        transition(STATES.SHOW_BROWSE, { showStatus: 'capture ready' });
        break;

      case STATES.SHOW_BROWSE:
        stateData.pendingShowNarration = false;
        if (stateData.showStatus && stateData.showStatus.indexOf('opening') === 0) {
          stateData.showStatus = 'lens warming';
          render();
        }
        break;

      case STATES.CAMERA_OPEN:
        // PTT released = finalize voice strip and capture with annotation
        if (window.StructaCamera?.voiceStripActive) {
          window.StructaCamera?.finalizeVoiceStripCapture?.();
          transition(STATES.CAMERA_CAPTURE);
        }
        break;

      case STATES.VOICE_OPEN:
        // PTT released on voice = stop listening
        if (stateData.inlinePTTSurface === 'triangle') {
          const heard = lower(document.getElementById('voice-transcript')?.textContent || '').trim();
          if (!heard) stateData.triangleStatus = 'no angle heard — hold ptt again';
        }
        window.StructaVoice?.stopListening?.(true);
        if (currentState === STATES.VOICE_OPEN) {
          transition(STATES.VOICE_PROCESSING);
        }
        break;

      default:
        break;
    }
  }

  function goHome() {
    if (stateData.flushRequestSource) {
      clearFlushRequest();
    }
    transition(STATES.HOME);
  }

  function handleNativeBack(event) {
    clearPendingSideClick();
    if (getUIState().flush_undo_available_until > Date.now() && currentState === STATES.NOW_BROWSE) {
      if (event) event.preventDefault?.();
      native?.updateUIState?.({ flush_undo_available_until: 0 });
      transition(STATES.HOME);
      return;
    }
    if (stateData.flushRequestSource) {
      if (event) event.preventDefault?.();
      clearFlushRequest();
      scheduleRender();
      return;
    }
    switch (currentState) {
      case STATES.PROJECT_SWITCHER:
        if (event) event.preventDefault?.();
        if (onboardingActive() && getOnboardingStep() === 1) {
          transition(STATES.NOW_BROWSE);
          return;
        }
        transition(STATES.HOME);
        return;

      case STATES.SHOW_BROWSE:
        if (event) event.preventDefault?.();
        goHome();
        return;

      case STATES.TELL_BROWSE:
        if (event) event.preventDefault?.();
        goHome();
        return;

      case STATES.NOW_BROWSE: {
        if (event) event.preventDefault?.();
        goHome();
        return;
      }

      case STATES.KNOW_DETAIL:
        if (event) event.preventDefault?.();
        transition(STATES.KNOW_BROWSE);
        return;

      case STATES.LOG_OPEN:
        if (event) event.preventDefault?.();
        transition(logReturnState || STATES.HOME);
        return;

      case STATES.TRIANGLE_OPEN:
        if (event) event.preventDefault?.();
        triangleEngine?.cancel?.();
        restoreTriangleOrigin();
        return;

      case STATES.HOME:
        // Don't preventDefault — let R1 close the app
        return;

      case STATES.SHOW_PRIMED:
      case STATES.TELL_PRIMED:
        if (event) event.preventDefault?.();
        goHome();
        return;

      default:
        if (event) event.preventDefault?.();
        goHome();
        return;
    }
  }

  function exportLogsFromHardware() {
    const result = native?.exportLatestLogs?.(33);
    pushLog(result?.ok ? 'saved 33 logs to rabbit hole' : 'could not save logs', 'logs');
    return result;
  }

  // === Event listeners ===

  function onWheel(event) {
    event.preventDefault();
    wheelDeltaAccumulator += event.deltaY || 0;
    if (Math.abs(wheelDeltaAccumulator) < WHEEL_STEP_THRESHOLD) return;
    const direction = wheelDeltaAccumulator > 0 ? 1 : -1;
    wheelDeltaAccumulator = 0;
    dispatchScrollStep(direction, 'wheel');
  }

  function onTouchDebugPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    if (!touchLogAllowed()) return;
    clearTouchLogPress();
    touchLogPressTriggered = false;
    touchLogPressPointerId = event.pointerId;
    touchLogPressStart = { x: event.clientX, y: event.clientY };
    touchLogPressTimer = setTimeout(function() {
      if (touchLogPressPointerId !== event.pointerId) return;
      touchLogPressTriggered = forceOpenDebugLogs();
      if (touchLogPressTriggered) {
        touchLogSuppressClickUntil = Date.now() + 450;
      }
    }, TOUCH_LOG_LONG_PRESS_MS);
  }

  function onTouchDebugPointerMove(event) {
    if (event.pointerType !== 'touch') return;
    if (touchLogPressPointerId !== event.pointerId || !touchLogPressStart) return;
    var dx = Math.abs((event.clientX || 0) - touchLogPressStart.x);
    var dy = Math.abs((event.clientY || 0) - touchLogPressStart.y);
    if (dx > TOUCH_LOG_MOVE_TOLERANCE || dy > TOUCH_LOG_MOVE_TOLERANCE) {
      clearTouchLogPress();
    }
  }

  function onTouchDebugPointerEnd(event) {
    if (event.pointerType !== 'touch') return;
    if (touchLogPressPointerId !== null && event.pointerId === touchLogPressPointerId) {
      clearTouchLogPress();
    }
    if (!touchLogPressTriggered) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    touchLogPressTriggered = false;
  }

  function onTouchDebugClickCapture(event) {
    const suppressUntil = Math.max(touchLogSuppressClickUntil, tutorialSkipSuppressClickUntil);
    if (Date.now() > suppressUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('pointerdown', onTutorialSkipPointerDown, { passive: true });
  svg.addEventListener('pointermove', onTutorialSkipPointerMove, { passive: true });
  svg.addEventListener('pointerdown', onTouchDebugPointerDown, { passive: true });
  svg.addEventListener('pointermove', onTouchDebugPointerMove, { passive: true });
  window.addEventListener('pointerup', onTutorialSkipPointerEnd, true);
  window.addEventListener('pointercancel', onTutorialSkipPointerEnd, true);
  window.addEventListener('pointerup', onTouchDebugPointerEnd, true);
  window.addEventListener('pointercancel', onTouchDebugPointerEnd, true);
  window.addEventListener('click', onTouchDebugClickCapture, true);

  log.addEventListener('wheel', event => {
    if (currentState !== STATES.LOG_OPEN) event.preventDefault();
  }, { passive: false });

  logHandle.addEventListener('click', event => {
    event.preventDefault();
    if (stateData.flushRequestSource) {
      clearFlushRequest();
      scheduleRender();
      return;
    }
    if (!onboardingAllowsLogs()) return;
    if (isCaptureState()) return;
    fireFeedback('touch-commit');
    if (currentState === STATES.LOG_OPEN) {
      transition(logReturnState || STATES.HOME);
    } else {
      logReturnState = currentState;
      transition(STATES.LOG_OPEN);
    }
  });

  // Camera events — transition state machine
  window.addEventListener('structa-camera-open', () => {
    if (currentState === STATES.SHOW_PRIMED || currentState === STATES.SHOW_BROWSE) {
      transition(STATES.CAMERA_OPEN);
    }
    stateData.pendingShowNarration = false;
  });

  window.addEventListener('structa-camera-close', () => {
    if (currentState === STATES.CAMERA_OPEN || currentState === STATES.CAMERA_CAPTURE) {
      const returnState = cameraReturnState;
      cameraReturnState = STATES.HOME;
      const captures = getCaptureList();
      if (captures.length) {
        const lastCapture = captures[captures.length - 1];
        stateData.showCaptureIndex = captures.length - 1;
        stateData.showCaptureEntryId = lastCapture?.entry_id || lastCapture?.id || '';
      }
      transition(returnState === STATES.SHOW_BROWSE ? STATES.SHOW_BROWSE : STATES.HOME, {
        showStatus: 'latest visual memory'
      });
    }
    scheduleLogRefresh({ forceFollow: true });
  });

  window.addEventListener('structa-capture-stored', event => {
    const entryId = event && event.detail ? event.detail.entryId : '';
    const captures = getCaptureList();
    const index = entryId ? captures.findIndex(capture => (capture?.entry_id || capture?.id || '') === entryId) : -1;
    if (index >= 0) {
      stateData.showCaptureIndex = index;
      stateData.showCaptureEntryId = entryId;
    } else if (captures.length) {
      stateData.showCaptureIndex = captures.length - 1;
      stateData.showCaptureEntryId = captures[captures.length - 1]?.entry_id || captures[captures.length - 1]?.id || '';
    }
    if (currentState === STATES.SHOW_BROWSE) {
      stateData.showStatus = 'working in background';
      render();
    }
    native?.updateUIState?.({ tutorial_step4_camera_denied: false });
    if (onboardingActive() && getOnboardingStep() === 4) {
      traceTutorial('tutorial.step', 'advance', '4', { step: 4, via: 'primary' });
      completeOnboarding();
    }
    scheduleLogRefresh({ forceFollow: true });
  });

  window.addEventListener('structa-onboarding-answer', function(event) {
    if (!onboardingActive()) return;
    const step = getOnboardingStep();
    if (step !== 2) return;
    const inferredName = event?.detail?.inferredName || '';
    if (inferredName) native?.setProjectName?.(inferredName);
    setOnboardingStep(3, { via: 'primary' });
    selectedIndex = Math.max(0, cards.findIndex(card => card.id === 'know'));
    pushLog('lesson 2 complete', 'system');
    if (currentState === STATES.VOICE_PROCESSING || currentState === STATES.VOICE_OPEN) {
      voiceReturnState = STATES.HOME;
    } else if (currentState === STATES.HOME) {
      transition(STATES.HOME);
    } else if (currentState === STATES.NOW_BROWSE) {
      transition(STATES.HOME);
    } else {
      render();
    }
  });

  window.addEventListener('structa-onboarding-stt-failed', function(event) {
    if (!onboardingActive() || getOnboardingStep() !== 2) return;
    const reason = event?.detail?.reason || 'empty';
    traceTutorial('tutorial.step', 'stt_failed', '2', { step: 2, reason: reason });
    showTutorialStep2Fallback(reason);
  });

  window.addEventListener('structa-camera-denied', function(event) {
    if (!onboardingActive() || getOnboardingStep() !== 4) return;
    native?.updateUIState?.({ tutorial_step4_camera_denied: true });
    traceTutorial('tutorial.step', 'camera_denied', '4', { step: 4 });
    stateData.showStatus = 'click once to allow camera · long-press home to skip';
    scheduleRender();
  });

  window.addEventListener('structa-voice-open', () => {
    if (currentState === STATES.TELL_PRIMED || currentState === STATES.KNOW_ANSWER) {
      currentState = STATES.VOICE_OPEN; // confirm the transition
    }
    render();
  });

  window.addEventListener('structa-voice-close', () => {
    if (currentState === STATES.VOICE_OPEN || currentState === STATES.VOICE_PROCESSING || currentState === STATES.KNOW_ANSWER) {
      // Clean up answer mode styling
      var voiceOverlay = document.getElementById('voice-overlay');
      var contextLabel = document.getElementById('voice-context-label');
      if (voiceOverlay) voiceOverlay.classList.remove('answer-mode');
      if (contextLabel) contextLabel.textContent = '';
      const returnState = voiceReturnState;
      voiceReturnState = STATES.HOME;
      transition(returnState || STATES.HOME, { tellStatus: 'voice saved' });
    }
    scheduleLogRefresh();
  });

  window.addEventListener('structa-memory-updated', () => {
    invalidateDataCaches();
    scheduleLogRefresh();
    scheduleOpsRefresh();
    scheduleRender();
    maybeStartHeartbeat();
    if (!onboardingActive() && !chainStarted && projectHasMeaningfulContent() && window.StructaImpactChain && !window.StructaImpactChain.active) {
      chainStarted = true;
      window.StructaImpactChain.start(2);
    }
  });
  window.addEventListener('structa-ui-state-updated', event => {
    const patch = event?.detail?.patch || {};
    if ('last_capture_summary' in patch || 'last_insight_summary' in patch) {
      invalidateUICaches();
    }
    scheduleRender();
  });
  window.addEventListener('structa-thread-comment-appended', function(event) {
    const detail = event?.detail || {};
    const count = Number(getUIState().depth_comment_count || 0) + 1;
    native?.updateUIState?.({
      depth_comment_count: count,
      depth_chevron_seen: count >= 3
    });
    if ((currentState === STATES.KNOW_BROWSE || currentState === STATES.KNOW_DETAIL) && detail.nodeId) {
      stateData.knowBodyScrollTop = 99999;
      render();
    } else {
      scheduleRender();
    }
  });
  window.addEventListener('structa-log-updated', () => {
    scheduleLogRefresh();
    scheduleOpsRefresh();
  });
  ['structa-queue-enqueued', 'structa-queue-started', 'structa-queue-progress', 'structa-queue-resolved', 'structa-queue-rejected', 'structa-queue-blocked'].forEach(function(name) {
    window.addEventListener(name, function() {
      syncQueueBlockers();
      scheduleLogRefresh();
      scheduleOpsRefresh();
      scheduleRender();
    });
  });
  window.addEventListener('structa-queue-blocked', function() {
    fireFeedback('blocked');
  });

  window.addEventListener('structa-triangle-copied', function(event) {
    const itemType = event?.detail?.item?.type || 'item';
    pushLog('triangle copy · ' + itemType, 'triangle');
    render();
  });

  window.addEventListener('structa-triangle-dismissed', function() {
    pushLog('triangle dismiss', 'triangle');
    render();
  });

  window.addEventListener('structa-triangle-synthesizing', function(event) {
    const pair = event?.detail?.pair || {};
    const left = pair?.a?.type || 'a';
    const right = pair?.b?.type || 'b';
    pushLog('triangle complete · ' + left + '+' + right, 'triangle');
    stateData.triangleStatus = 'hold ptt to tell your angle';
    render();
  });

  window.addEventListener('structa-triangle-submit', function(event) {
    const transcript = event?.detail?.transcript || '';
    stateData.triangleStatus = 'synthesizing...';
    render();
    Promise.resolve(triangleEngine?.submit?.(transcript)).catch(function() {
      // Error state is handled by the engine event.
    });
  });

  window.addEventListener('structa-triangle-submitting', function() {
    stateData.triangleStatus = 'synthesizing...';
    render();
  });

  window.addEventListener('structa-triangle-result', function(event) {
    const signal = lower(String(event?.detail?.title || 'triangle signal'));
    pushLog('triangle signal: ' + signal.slice(0, 40), 'triangle');
    notifyCard('know', 'urgent');
    stateData.triangleStatus = '';
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: 'triangle' }
    }));
    if (currentState === STATES.TRIANGLE_OPEN || stateData.inlinePTTSurface === 'triangle' || voiceReturnState === STATES.TRIANGLE_OPEN) {
      restoreTriangleOrigin();
      return;
    }
    render();
  });

  window.addEventListener('structa-triangle-ambiguous', function(event) {
    const question = lower(String(event?.detail?.question || 'triangle stayed ambiguous'));
    pushLog('triangle ambiguous: ' + question.slice(0, 40), 'triangle');
    notifyCard('now', 'urgent');
    stateData.triangleStatus = '';
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: 'triangle' }
    }));
    if (currentState === STATES.TRIANGLE_OPEN || stateData.inlinePTTSurface === 'triangle' || voiceReturnState === STATES.TRIANGLE_OPEN) {
      restoreTriangleOrigin();
      return;
    }
    render();
  });

  window.addEventListener('structa-triangle-failed', function(event) {
    stateData.triangleStatus = event?.detail?.message || 'synthesis failed — try again';
    if (currentState === STATES.TRIANGLE_OPEN) {
      render();
    }
  });

  window.addEventListener('structa-triangle-cleared', function() {
    pushLog('triangle slot cleared (source removed)', 'triangle');
    render();
  });

  window.addEventListener('structa-probe-event', () => { scheduleLogRefresh(); });
  window.addEventListener('structa-impact-phase', event => { scheduleOpsRefresh(event?.detail || {}); });
  window.addEventListener('structa-capture-failed', () => {
    if (currentState === STATES.CAMERA_CAPTURE || currentState === STATES.CAMERA_OPEN) {
      transition(STATES.CAMERA_OPEN);
    }
    scheduleLogRefresh();
  });

  // Hardware inputs
  window.addEventListener('scrollUp', event => { event.preventDefault?.(); dispatchScrollStep(1, 'native'); });
  window.addEventListener('scrollDown', event => { event.preventDefault?.(); dispatchScrollStep(-1, 'native'); });
  window.addEventListener('sideClick', event => { event.preventDefault?.(); triggerSideClick(); });
  window.addEventListener('longPressStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('longPressEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
  window.addEventListener('pttStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('pttEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
  window.addEventListener('backbutton', handleNativeBack);
  window.addEventListener('popstate', handleNativeBack);

  // Keyboard fallback
  document.addEventListener('keydown', event => {
    if ((event.key === 'l' || event.key === 'L') && onboardingAllowsLogs() && (currentState === STATES.HOME || currentState === STATES.LOG_OPEN)) {
      event.preventDefault();
      transition(currentState === STATES.LOG_OPEN ? STATES.HOME : STATES.LOG_OPEN);
      return;
    }
    if (currentState === STATES.HOME) {
      if (event.key === 'ArrowRight') selectIndex(selectedIndex + 1);
      if (event.key === 'ArrowLeft') selectIndex(selectedIndex - 1);
      if (event.key === 'Enter' || event.key === ' ') openCard(currentCard());
      if (event.key === 'Escape') goHome();
    } else {
      if (event.key === 'Escape') handleNativeBack(event);
    }
  });

  // Shake routing
  let lastShakeAt = 0;
  window.addEventListener('devicemotion', event => {
    const accel = event.accelerationIncludingGravity || event.acceleration;
    if (!accel) return;
    const magnitude = Math.abs(accel.x || 0) + Math.abs(accel.y || 0) + Math.abs(accel.z || 0);
    const now = Date.now();
    if (magnitude < 55) return;
    if (stateData.flushRequestSource) {
      clearFlushRequest();
      scheduleRender();
      return;
    }
    if (getUIState().flush_undo_available_until > now && currentState === STATES.NOW_BROWSE) {
      native?.updateUIState?.({ flush_undo_available_until: 0 });
      transition(STATES.HOME);
      lastShakeAt = now;
      return;
    }
    if (now - lastShakeAt < 2500) return;
    lastShakeAt = now;
    clearPendingSideClick();
    if (currentState === STATES.TRIANGLE_OPEN) {
      triangleEngine?.clearAll?.();
      transition(STATES.HOME);
      return;
    }
    if (onboardingActive()) {
      const step = getOnboardingStep();
      if (step === 1) {
        openProjectSwitcher();
      }
      return;
    }
    if (currentState === STATES.PROJECT_SWITCHER) {
      transition(STATES.HOME);
      return;
    }
    if (currentState === STATES.HOME) {
      openProjectSwitcher();
      return;
    }
    goHome();
  });

  // === Init ===
  const initialState = native?.getUIState?.() || {};
  selectedIndex = Math.max(0, cards.findIndex(card => card.id === (initialState.selected_card_id || 'now')));
  if (selectedIndex < 0) selectedIndex = 3;
  if (onboardingActive()) {
    const allowed = onboardingAllowedCardIds();
    if (!allowed.includes(currentCard()?.id)) {
      const nextIndex = cards.findIndex(card => card.id === allowed[0]);
      if (nextIndex >= 0) selectedIndex = nextIndex;
    }
  }

  native?.setActiveNode?.(currentCard().id);
  native?.updateUIState?.({ selected_card_id: currentCard().id, last_surface: 'home', resumed_at: new Date().toISOString() });
  syncQueueBlockers();
  refreshLogFromMemory();
  updateLogOps();
  startDebugFPSMeter();
  renderNow();
  maybeStartHeartbeat();

  // Probe bootstrap now lives in rabbit-adapter and stays concise.

  // Prime camera only when the user explicitly invokes SHOW
  let cameraPrimed = false;
  function primeCameraForShowIntent() {
    if (cameraPrimed && window.__STRUCTA_PRIMED_STREAM__?.active) return Promise.resolve(true);
    cameraPrimed = true;
    if (!navigator.mediaDevices?.getUserMedia) return Promise.resolve(false);
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { max: 640 }, height: { max: 480 } } })
      .then(function(stream) {
        window.__STRUCTA_PRIMED_STREAM__ = stream;
        return true;
      })
      .catch(function() {
        cameraPrimed = false;
        return false;
      });
  }

  // === Impact Chain event wiring ===

  // Update chain badge in log drawer
  function updateChainBadge() {
    const chain = window.StructaImpactChain;
    const badge = document.getElementById('log-chain-badge');
    const phaseText = document.getElementById('chain-phase-text');
    if (!badge || !phaseText) return;

    if (!chain || chain.phase === 'idle') {
      badge.className = 'idle';
      phaseText.textContent = 'idle';
      return;
    }

    badge.className = '';
    const labels = {
      observe: 'obs',
      clarify: 'clar',
      research: 'res',
      evaluate: 'eval',
      decision: 'dec',
      cooldown: 'cool'
    };
    const base = labels[chain.phase] || chain.phase;
    phaseText.textContent = chain.focusLabel ? `${base} · ${lower(chain.focusLabel)}` : base;
  }

  // Re-render NOW panel on each impact + notify relevant cards
  window.addEventListener('structa-impact', function(e) {
    scheduleOpsRefresh();
    if (currentState === STATES.NOW_BROWSE) scheduleRender();
    // Soft notification on home to show app is working
    if (currentState === STATES.HOME) {
      notifyCard('know', 'soft');
    }
  });

  // Show spring notification when decision created
  window.addEventListener('structa-decision-created', function(e) {
    scheduleOpsRefresh();
    notifyCard('now', 'urgent');
    if (currentState === STATES.NOW_BROWSE) scheduleRender();
  });

  // Start chain after first user interaction + init audio
  let chainStarted = false;
  function startChainOnInteraction() {
    if (onboardingActive() || chainStarted || !projectHasMeaningfulContent()) return;
    chainStarted = true;
    if (window.StructaImpactChain && !window.StructaImpactChain.active) {
      window.StructaImpactChain.start(2); // 2bpm = every 30s
    }
  }
  window.addEventListener('pointerup', function initAudioOnFirstTouch() {
    if (window.StructaAudio && !window.StructaAudio.initialized) {
      window.StructaAudio.init();
    }
  }, { once: true, passive: true });
  ['sideClick', 'longPressStart'].forEach(function(evt) {
    window.addEventListener(evt, startChainOnInteraction);
  });

  function pulseCardElement(cardEl, options) {
    if (!cardEl) return;
    var opts = options || {};
    var baseTransform = typeof cardEl.__structaBaseTransform === 'string'
      ? cardEl.__structaBaseTransform
      : (cardEl.getAttribute('transform') || '');
    cardEl.__structaBaseTransform = baseTransform;
    if (cardEl.__structaPulseTimer) clearTimeout(cardEl.__structaPulseTimer);
    cardEl.setAttribute('transform', (baseTransform
      + ' translate(' + (opts.x || 0) + ' ' + (opts.y || 0) + ')'
      + ' scale(' + (opts.scale || 1) + ')').trim());
    cardEl.__structaPulseTimer = setTimeout(function() {
      if (cardEl.isConnected) cardEl.setAttribute('transform', cardEl.__structaBaseTransform || '');
      cardEl.__structaPulseTimer = null;
    }, opts.duration || 120);
  }

  // === Heartbeat visual micro-pulse ===
  window.addEventListener('structa-heartbeat', function() {
    if (currentState === STATES.HOME) {
      Array.prototype.slice.call(svg.querySelectorAll('[data-card-index]')).forEach(function(cardEl, index) {
        var driftX = index === selectedIndex ? 0.32 : (index % 2 === 0 ? -0.18 : 0.18);
        var driftY = index === selectedIndex ? -0.24 : 0.14;
        pulseCardElement(cardEl, { x: driftX, y: driftY, scale: 1.006, duration: 200 });
      });
    }
  });

  window.addEventListener('structa-fast-feedback', function(e) {
    if (currentState === STATES.HOME) {
      Array.prototype.slice.call(svg.querySelectorAll('[data-card-index]')).forEach(function(cardEl, index) {
        var selected = index === selectedIndex;
        pulseCardElement(cardEl, {
          x: selected ? 0.05 : 0.02,
          y: selected ? -0.04 : -0.02,
          scale: selected ? 1.002 : 1.001,
          duration: 110
        });
      });
    }

    var source = e && e.detail ? e.detail.source : '';
    if (source === 'capture' || source === 'show-tell' || source === 'visual-insight') notifyCard('show', 'soft');
    if (source === 'voice-entry') notifyCard('tell', 'soft');
    if (source === 'visual-insight' || source === 'insight' || source === 'question-answer') notifyCard('know', 'soft');
    if (source === 'project-switch') notifyCard('now', 'soft');
    if (currentState === STATES.NOW_BROWSE && source === 'question-answer') {
      stateData.nowHideQuestionsUntil = Date.now() + 200;
      stateData.nowFeedback = 'answer queued';
      scheduleRender();
      setTimeout(function() {
        if (stateData.nowFeedback === 'answer queued') {
          stateData.nowFeedback = '';
          scheduleRender();
        }
      }, 1200);
      setTimeout(function() {
        scheduleRender();
      }, 220);
    }
  });

  // === Discovery question notification ===
  window.addEventListener('structa-discovery-question', function(e) {
    notifyCard('know', 'urgent');
    if (e && e.detail && e.detail.question) {
      pushLog('structa asks: ' + e.detail.question.slice(0, 40), 'chain');
    }
  });

  window.addEventListener('structa-chain-updated', function() {
    scheduleOpsRefresh();
    if (currentState === STATES.NOW_BROWSE) scheduleRender();
  });

  window.addEventListener('structa-model-change', function(event) {
    const detail = event && event.detail ? event.detail : {};
    const scope = detail.scope || '';
    if (scope === 'all' || scope === 'now') {
      scheduleRender();
      return;
    }
    if (scope === 'item' && (
      currentState === STATES.KNOW_BROWSE ||
      currentState === STATES.KNOW_DETAIL ||
      currentState === STATES.SHOW_BROWSE ||
      currentState === STATES.TELL_BROWSE ||
      currentState === STATES.NOW_BROWSE
    )) {
      scheduleRender();
    }
  });

  window.addEventListener('structa-diagnostics-progress', function() {
    if (!logOpen) return;
    refreshLogFromMemory({ jumpToLatest: true, forceFollow: true });
  });

  // === Voice command handler ===
  window.addEventListener('structa-voice-command', function(e) {
    if (!e || !e.detail) return;
    var cmd = e.detail;

    if (cmd.command === 'new-project') {
      if (cmd.name && native?.createProject) {
        var created = native.createProject(cmd.name);
        if (created && created.ok === false) {
          selectedIndex = cards.findIndex(function(card) { return card.id === 'now'; });
          transition(STATES.HOME);
        } else {
          pushLog('project: ' + cmd.name.slice(0, 30), 'voice');
          transition(STATES.HOME);
        }
      }
      render();
    }

    if (cmd.command === 'switch-project') {
      var switched = native?.switchProject?.(cmd.name);
      if (switched) {
        pushLog('project: ' + ((switched.name || cmd.name || '').slice(0, 30)), 'voice');
        transition(STATES.HOME);
      } else {
        pushLog('project not found: ' + (cmd.name || '').slice(0, 24), 'voice');
      }
    }

    if (cmd.command === 'archive-project') {
      var archived = native?.archiveProject?.(cmd.name);
      if (archived && archived.ok) {
        pushLog('project archived', 'voice');
        transition(STATES.HOME);
      } else {
        pushLog((archived && archived.error) || 'archive unavailable', 'voice');
      }
      render();
    }

    if (cmd.command === 'delete-project') {
      var deleted = native?.deleteProject?.(cmd.name);
      if (deleted && deleted.ok) {
        pushLog('project deleted', 'voice');
        transition(STATES.HOME);
      } else {
        pushLog((deleted && deleted.error) || 'delete unavailable', 'voice');
      }
      render();
    }
  });

  // === BPM control: detect rapid scroll ticks (HOME and LOG_OPEN only) ===
  if (probeMode) {
    let rapidScrollCount = 0;
    let rapidScrollTimer = null;
    function onRapidScrollTick(direction) {
      if (currentState !== STATES.HOME && currentState !== STATES.LOG_OPEN) return;
      rapidScrollCount++;
      clearTimeout(rapidScrollTimer);
      rapidScrollTimer = setTimeout(function() {
        if (rapidScrollCount >= 3 && window.StructaImpactChain) {
          var chain = window.StructaImpactChain;
          var newBpm = direction > 0 ? Math.min(20, chain.bpm + 2) : Math.max(1, chain.bpm - 2);
          chain.bpm = newBpm;
          if (window.StructaAudio) window.StructaAudio.play(direction > 0 ? 'bpmUp' : 'bpmDown');
          pushLog('chain speed: ' + newBpm + 'bpm', 'system');
        }
        rapidScrollCount = 0;
      }, 600);
    }
    window.addEventListener('scrollDown', function() { onRapidScrollTick(-1); });
    window.addEventListener('scrollUp', function() { onRapidScrollTick(1); });
  }

  // === Public API ===
  window.StructaUIRuntime = Object.freeze({
    fullReset: fullUIRuntimeReset,
    invalidateAllUICaches: function() {
      invalidateDataCaches();
      invalidateUICaches();
      scheduleRender();
    },
    refreshBundle: refreshBundle
  });

  window.StructaPanel = Object.freeze({
    render,
    pushLog,
    getState: () => currentState,
    goHome,
    transition,
    openCard,
    selectCard: id => {
      const index = cards.findIndex(card => card.id === id);
      if (index >= 0) selectIndex(index);
    },
    notifyCard,
    STATES
  });
})();
