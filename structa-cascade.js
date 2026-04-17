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
  const native = window.StructaNative;
  const router = window.StructaActionRouter;
  const projectCode = window.StructaContracts?.baseProjectCode || 'prj-structa-r1';

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
    LOG_OPEN: 'log_open'
  });

  const IC = window.StructaIcons || {};
  const cards = [
    { id: 'show', title: 'show', iconPath: IC['4'] || 'assets/icons/png/4.png', iconFallback: '▣', role: 'visual capture', roleShort: 'see it', color: 'var(--show)', surface: 'camera' },
    { id: 'tell', title: 'tell', iconPath: IC['3'] || 'assets/icons/png/3.png', iconFallback: '◉', role: 'voice capture', roleShort: 'voice in', color: 'var(--tell)', surface: 'voice' },
    { id: 'know', title: 'know', iconPath: IC['7'] || 'assets/icons/png/7.png', iconFallback: '◈', role: 'signal extraction', roleShort: 'find signal', color: 'var(--know)', surface: 'insight' },
    { id: 'now', title: 'now', iconPath: IC['6'] || 'assets/icons/png/6.png', iconFallback: '▣', role: 'decision surface', roleShort: 'act on it', color: 'var(--now)', surface: 'project' }
  ];

  // === State machine ===
  let currentState = STATES.HOME;
  let stateData = {}; // per-state context
  let selectedIndex = 0;
  let logOpen = false;
  let cameraReturnState = STATES.HOME;
  let voiceReturnState = STATES.HOME;
  let transitionTargetState = null;

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

  function normalizeTinyText(text = '') {
    return String(text || '')
      .replace(/[#*_`>\[\]\{\}]/g, ' ')
      .replace(/\b(decision|insight|next|signal)\s*:\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
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

  function allowStagingFlush() {
    const host = lower(window.location.hostname || '');
    const search = lower(window.location.search || '');
    const hash = lower(window.location.hash || '');
    return !!native?.probeMode ||
      host.includes('replit') ||
      host.includes('localhost') ||
      host.startsWith('127.') ||
      search.includes('staging') ||
      hash.includes('staging');
  }

  function currentCard() {
    return cards[selectedIndex];
  }

  function getMemory() {
    return native?.getMemory?.() || { captures: [], runtimeEvents: [], projectMemory: null };
  }

  function getProjectMemory() {
    return native?.getProjectMemory?.() || getMemory().projectMemory || null;
  }

  function getProjects() {
    return native?.getProjects?.() || [];
  }

  function getActiveProjectId() {
    return native?.getActiveProjectId?.() || getProjectMemory()?.project_id || '';
  }

  function getUIState() {
    return native?.getUIState?.() || getMemory().uiState || {};
  }

  function getCaptureList() {
    const activeProjectId = getActiveProjectId();
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
    return Array.from(merged.values()).sort((a, b) => {
      const aTime = new Date(a?.captured_at || a?.created_at || a?.meta?.captured_at || 0).getTime();
      const bTime = new Date(b?.captured_at || b?.created_at || b?.meta?.captured_at || 0).getTime();
      return aTime - bTime;
    });
  }

  function getVoiceEntries() {
    const activeProjectId = getActiveProjectId();
    const nodes = (getProjectMemory()?.nodes || []).filter(Boolean);
    const voiceNodes = nodes
      .filter(entry => entry.type === 'voice-entry' && entry.status !== 'archived' && (!entry.project_id || entry.project_id === activeProjectId))
      .slice()
      .sort(function(a, b) {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      });
    if (voiceNodes.length) return voiceNodes;
    const journals = (getMemory().journals || []).filter(Boolean);
    return journals
      .filter(entry => lower(entry?.source_type || '') === 'voice' && (!entry.project_id || entry.project_id === activeProjectId))
      .slice()
      .reverse();
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
    if (ui?.onboarded) return 'complete';
    if (ui?.onboarding_step === 'complete') return 'complete';
    if (typeof ui?.onboarding_step === 'number') return ui.onboarding_step;
    return freshWorkspaceState() ? 0 : 'complete';
  }

  function onboardingActive() {
    return getOnboardingStep() !== 'complete';
  }

  function onboardingAllowedCardIds(step = getOnboardingStep()) {
    if (step === 'complete') return cards.map(card => card.id);
    if (step >= 4) return ['now', 'know', 'show'];
    if (step >= 3) return ['now', 'know'];
    return ['now'];
  }

  function onboardingAllowsLogs() {
    return !onboardingActive();
  }

  function onboardingAllowsProjectSwitcher() {
    return getOnboardingStep() === 1;
  }

  function setOnboardingStep(step) {
    native?.updateUIState?.({
      onboarding_step: step,
      onboarded: step === 'complete'
    });
  }

  function completeOnboarding() {
    setOnboardingStep('complete');
    pushLog('onboarding complete', 'system');
    if (window.StructaHeartbeat && window.StructaHeartbeat.bpm === 0 && projectHasMeaningfulContent()) {
      window.StructaHeartbeat.start(3);
    }
    if (projectHasMeaningfulContent()) {
      chainStarted = true;
      window.StructaImpactChain?.start?.(2);
    }
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
    const raw = String(capture?.ai_analysis || capture?.ai_response || capture?.summary || capture?.prompt_text || 'untitled capture');
    const signalMatch = raw.match(/signal:\s*(.+)/i);
    if (signalMatch && signalMatch[1]) return lower(signalMatch[1].trim());
    return lower(raw);
  }

  function latestLogText() {
    const entries = native?.getRecentLogEntries?.(1, { visible_only: true }) || [];
    const latest = entries[entries.length - 1];
    return lower(latest?.visible_message || latest?.message || '—');
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

  function getQueueLine() {
    const pending = window.StructaLLM?.pendingCount || 0;
    const priority = window.StructaLLM?.pendingHighPriorityCount || 0;
    const phase = lower(window.StructaImpactChain?.phase || 'idle');
    if (!pending) return `queue clear · ${phase}`;
    if (priority && priority !== pending) return `${pending} queued · ${priority} priority · ${phase}`;
    return `${pending} queued · ${phase}`;
  }

  function renderLogRows(entries, options = {}) {
    log.innerHTML = '';
    if (options.includeStats) {
      const queueRow = document.createElement('div');
      queueRow.className = 'entry';
      const queueLabel = document.createElement('span');
      queueLabel.className = 'muted';
      queueLabel.textContent = '[queue]';
      queueRow.appendChild(queueLabel);
      const queueMessage = document.createElement('span');
      queueMessage.textContent = getQueueLine();
      queueRow.appendChild(queueMessage);
      log.appendChild(queueRow);
      getStatsLines().forEach(function(line, index) {
        const statsRow = document.createElement('div');
        statsRow.className = 'entry';
        const label = document.createElement('span');
        label.className = 'muted';
        label.textContent = index === 0 ? '[stats]' : '[—]';
        statsRow.appendChild(label);
        const message = document.createElement('span');
        message.textContent = line;
        statsRow.appendChild(message);
        log.appendChild(statsRow);
      });
    }
    entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'entry';
      const time = document.createElement('span');
      time.className = 'muted';
      time.textContent = `[${formatLogTime(entry.created_at)}]`;
      row.appendChild(time);
      const message = document.createElement('span');
      message.textContent = lower(entry.message || 'event');
      row.appendChild(message);
      log.appendChild(row);
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

    // Render
    render();
  }

  // === Log management ===
  function pushLog(text, strong = '') {
    native?.appendLogEntry?.({ kind: lower(strong || 'ui'), message: lower(text) });
    refreshLogFromMemory();
  }

  function refreshLogFromMemory() {
    const limit = logOpen ? 33 : 5;
    const previousScroll = log.scrollTop;
    const entries = (native?.getRecentLogEntries?.(limit, { visible_only: true }) || []).slice(-limit);
    if (!entries.length) {
      if (logOpen) {
        renderLogRows([], { includeStats: true });
      } else {
        log.innerHTML = '';
      }
      logPreview.textContent = getQueueLine();
      return;
    }
    renderLogRows(entries, { includeStats: logOpen });
    logPreview.textContent = latestLogText();
    if (logOpen) log.scrollTop = previousScroll;
  }

  function setLogDrawer(open) {
    logOpen = !!open;
    logDrawer.classList.toggle('open', logOpen);
    logDrawer.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
    if (logOpen) {
      const entries = native?.getRecentLogEntries?.(33, { visible_only: true }) || [];
      renderLogRows(entries, { includeStats: true });
      log.scrollTop = 0;
    } else {
      refreshLogFromMemory();
    }
  }

  // === State enter/exit handlers ===
  const stateEnterHandlers = {};
  const stateExitHandlers = {};

  // --- HOME ---
  stateEnterHandlers[STATES.HOME] = function(data) {
    document.title = 'structa';
    window.__STRUCTA_PTT_TARGET__ = null;
    document.body.classList.remove('input-locked');
    if (onboardingActive()) {
      const allowed = onboardingAllowedCardIds();
      if (!allowed.includes(currentCard()?.id)) {
        const nextIndex = cards.findIndex(function(card) { return card.id === allowed[0]; });
        if (nextIndex >= 0) selectedIndex = nextIndex;
      }
    }
    maybeStartHeartbeat();
  };

  stateExitHandlers[STATES.HOME] = function(data) {
    // nothing specific
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
  };

  stateExitHandlers[STATES.PROJECT_SWITCHER] = function() {
    // no-op
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
    if (data.answeringQuestion) {
      if (window.StructaVoice?.setQuestionContext) {
        window.StructaVoice.setQuestionContext(data.answeringQuestion.index, data.answeringQuestion.text);
      }
      native?.appendLogEntry?.({ kind: 'voice', message: 'answering: ' + data.answeringQuestion.text.slice(0, 40) });
    } else if (data.buildContext && window.StructaVoice?.setBuildContext) {
      window.StructaVoice.setBuildContext(data.buildContext);
    }

    // Show context label on voice overlay for all voice opens
    const voiceContextLabel = document.getElementById('voice-context-label');
    if (voiceContextLabel) {
      const surfaceMap = { home: 'project context', tell: 'on note', show: 'on frame', know: 'on signal', insight: 'on signal', project: 'on decision', now: 'on decision' };
      const surface = data.inlinePTTSurface || data.buildContext?.surface || '';
      if (data.answeringQuestion) {
        voiceContextLabel.textContent = 'answering ask';
        voiceContextLabel.style.display = 'block';
      } else if (surface && surfaceMap[surface]) {
        voiceContextLabel.textContent = surfaceMap[surface];
        voiceContextLabel.style.display = 'block';
      } else {
        voiceContextLabel.style.display = 'none';
      }
    }

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
    if (transitionTargetState !== STATES.VOICE_PROCESSING) {
      stateData.inlinePTTSurface = '';
    }
    const voiceContextLabel = document.getElementById('voice-context-label');
    if (voiceContextLabel) voiceContextLabel.style.display = 'none';
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
    if (getOnboardingStep() === 3) {
      setOnboardingStep(4);
      pushLog('lesson 3 complete', 'system');
    }
  };

  // --- KNOW_DETAIL ---
  stateEnterHandlers[STATES.KNOW_DETAIL] = function(data) {
    stateData.knowItemIndex = data.itemIndex || 0;
  };

  // --- KNOW_ANSWER ---
  stateEnterHandlers[STATES.KNOW_ANSWER] = function(data) {
    // Reuses VOICE_OPEN but with question context
    voiceReturnState = STATES.KNOW_BROWSE;
    transition(STATES.VOICE_OPEN, {
      answeringQuestion: data.question,
      fromPTT: false
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
  };

  // --- LOG_OPEN ---
  stateEnterHandlers[STATES.LOG_OPEN] = function(data) {
    setLogDrawer(true);
  };

  stateExitHandlers[STATES.LOG_OPEN] = function(data) {
    setLogDrawer(false);
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
      return;
    }
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
      stateData.showStatus = 'touch to start camera';
      stateData.pendingShowNarration = false;
      render();
      return false;
    }
    window.StructaCamera?.openFromGesture?.('environment');
    return true;
  }

  function openTellSurface(extra = {}) {
    voiceReturnState = extra.returnState || STATES.TELL_BROWSE;
    transition(STATES.VOICE_OPEN, { fromPTT: false, ...extra });
  }

  function openNowNextMove() {
    const project = getProjectMemory();
    const openQuestions = project?.open_questions || [];
    if (openQuestions.length) {
      voiceReturnState = STATES.NOW_BROWSE;
      transition(STATES.VOICE_OPEN, {
        answeringQuestion: { index: 0, text: openQuestions[0] },
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
    pushLog(selectedOption ? `decision approved: ${selectedOption}` : 'decision approved', 'decision');
    stateData.decisionIndex = 0;
    stateData.selectedOption = 0;
    stateData.nowFeedback = 'decision queued';
    setTimeout(function() {
      if (stateData.nowFeedback === 'decision queued') {
        stateData.nowFeedback = '';
        render();
      }
    }, 1200);
    render();
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
    render();
    return true;
  }

  function advanceCurrentNowDecision() {
    const project = getProjectMemory();
    const pending = project?.pending_decisions || [];
    if (pending.length <= 1) return false;
    stateData.decisionIndex = ((stateData.decisionIndex || 0) + 1) % pending.length;
    stateData.selectedOption = 0;
    render();
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

  function activateSelectedProject() {
    const projects = getProjects();
    if (!projects.length) return false;
    if (onboardingActive() && getOnboardingStep() === 1) {
      setOnboardingStep(2);
      pushLog('lesson 1 complete', 'system');
      transition(STATES.NOW_BROWSE);
      return true;
    }
    const selectedIndexValue = typeof stateData.projectListIndex === 'number' ? stateData.projectListIndex : 0;
    const index = Math.max(0, Math.min(selectedIndexValue, projects.length - 1));
    const project = projects[index];
    if (!project) return false;
    native?.switchProject?.(project.project_id);
    pushLog(`project: ${project.name}`, 'voice');
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: 'project-switch' }
    }));
    transition(STATES.HOME);
    return true;
  }

  function flushTestingMemory() {
    if (!allowStagingFlush() || !native?.flushMemory) return false;
    native.flushMemory().then(function() {
      stateData.projectFlushConfirm = false;
      stateData.showCaptureEntryId = '';
      stateData.showCaptureIndex = 0;
      if (window.StructaHeartbeat?.stop) {
        try { window.StructaHeartbeat.stop(); } catch (_) {}
      }
      if (window.StructaImpactChain?.pause) {
        try { window.StructaImpactChain.pause('memory flush'); } catch (_) {}
      }
      chainStarted = false;
      selectedIndex = cards.findIndex(function(card) { return card.id === 'now'; });
      transition(STATES.HOME);
    }).catch(function() {
      stateData.projectFlushConfirm = false;
      render();
    });
    return true;
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
    const captures = getCaptureList();
    const insights = project?.insights || [];
    const openQuestions = project?.open_questions || [];
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
    const blockerQuestion = openQuestions[0] || '';
    const blockerCount = pendingDecisions.length + openQuestions.length;

    return {
      title: project?.name || 'new project',
      changed: ui.last_event_summary || '',
      capture: ui.last_capture_summary || (captures[captures.length - 1]?.summary || ''),
      insight: ui.last_insight_summary || (insights[0]?.body || ''),
      next: backlog[0]?.title || (openQuestions[0] ? `answer: ${openQuestions[0].slice(0, 30)}` : ''),
      openQuestions: openQuestions.length,
      captures: captures.length,
      insights: insights.length,
      decisions: decisions.length,
      pendingDecisions: pendingDecisions,
      pendingDecisionText: pendingDecisions.length ? (typeof pendingDecisions[0] === 'string' ? pendingDecisions[0] : pendingDecisions[0].text) : null,
      pendingDecisionIndex: decIdx,
      pendingDecisionOptions: pendingDecisions.length ? (typeof pendingDecisions[0] === 'string' ? [] : (pendingDecisions[0].options || [])) : [],
      blockerCount,
      blockerQuestion,
      chainPhase,
      chainActive,
      chainImpacts,
      chainBpm,
      chainBeatCount,
      lastImpact,
      totalImpacts,
      totalDecisions,
      cooldownRemaining,
      storedImpacts: storedImpacts.slice(0, 5)
    };
  }

  function drawOnboardingNowPanel(nowCard, data) {
    const step = getOnboardingStep();
    const inlineListening = recordingActive() && activeSurface() === 'project';
    const cardY = 84;
    mk('rect', { x: 10, y: cardY, width: 220, height: 158, rx: 12, fill: 'rgba(8,8,8,0.13)' });

    if (step === 0) {
      text(18, cardY + 18, 'welcome to structa', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, 'this is your project surface. everything starts here.', 18, cardY + 46, 194, 14, 'rgba(8,8,8,0.78)', '13', 4);
      mk('rect', { x: 18, y: cardY + 116, width: 116, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
      text(30, cardY + 132, 'ptt click → begin', {
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
      mk('rect', { x: 10, y: cardY + 30, width: 3, height: 108, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.76)' });
      wrapTextBlock(undefined, 'what is this project about?', 20, cardY + 50, 190, 15, 'rgba(8,8,8,0.96)', '16', 4);
      mk('rect', { x: 18, y: cardY + 118, width: 148, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
      text(30, cardY + 134, inlineListening ? 'release to answer' : 'hold ptt → answer', {
        fill: 'rgba(244,239,228,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'lesson 3 unlocks after answer', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return true;
    }

    if (step === 3) {
      text(18, cardY + 18, 'lesson 3 · scroll to know', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, 'your answer created project meaning. scroll home to know and open it.', 18, cardY + 46, 194, 14, 'rgba(8,8,8,0.78)', '13', 5);
      text(18, cardY + 132, 'scroll → know', {
        fill: 'rgba(8,8,8,0.54)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'lesson 4 starts in know', {
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
    const memory = getMemory();
    const project = getProjectMemory();
    const ui = getUIState();
    const chips = [
      { id: 'latest', label: 'latest' },
      { id: 'next', label: 'next' },
      { id: 'asks', label: 'asks' },
      { id: 'assets', label: 'assets' }
    ];

    const classify = item => {
      const text = lower(`${item.title} ${item.body} ${item.next}`);
      const bucket = new Set(item.chips || []);
      if (item.source === 'question') bucket.add('asks');
      if (item.source === 'asset' || item.source === 'capture-image') bucket.add('assets');
      if (item.next && textHasAny(item.next, ['next', 'capture', 'answer', 'send', 'review', 'fix', 'act'])) bucket.add('next');
      item.chips = Array.from(bucket);
      return item;
    };

    const focusNodeId = stateData.knowFocusNodeId || '';

    const makeItem = ({ lane, title, body, next, created_at, source, chips: chipHints = [], questionIndex, node_id, links = [] }) => classify({
      lane,
      title: lower(normalizeTinyText(title || lane)),
      body: lower(normalizeTinyText(body || '')),
      next: lower(normalizeTinyText(next || '')),
      created_at: created_at || new Date().toISOString(),
      source: source || lane,
      chips: chipHints.slice(),
      questionIndex,
      node_id: node_id || '',
      links: Array.isArray(links) ? links.slice() : []
    });

    const questions = [];
    const signals = [];
    const decisionsLane = [];
    const loops = [];

    const insights = project?.insights || [];
    const captures = project?.captures || [];
    const backlog = project?.backlog || [];
    const decisions = project?.decisions || [];
    const openQuestions = project?.open_questions || [];

    // Questions lane
    openQuestions.slice(0, 5).forEach((question, index) => {
      questions.push(makeItem({
        lane: 'questions', title: `ask ${index + 1}`, body: question,
        next: 'ptt button to answer', created_at: new Date().toISOString(),
        source: 'question', chips: ['asks'], questionIndex: index
      }));
    });

    if (!questions.length) {
      questions.push(makeItem({
        lane: 'questions', title: 'all clear', body: 'no open asks',
        next: '',
        created_at: new Date().toISOString(), source: 'empty', chips: ['latest']
      }));
    }

    // Signals
    if (ui.last_insight_summary || ui.last_capture_summary) {
      signals.push(makeItem({
        lane: 'signals', title: 'latest signal',
        body: ui.last_insight_summary || ui.last_capture_summary,
        next: backlog[0]?.title || '',
        created_at: new Date().toISOString(), source: 'ui', chips: ['latest', 'next']
      }));
    }

    insights.slice(0, 4).forEach((insight, index) => {
      signals.push(makeItem({
        lane: 'signals', title: insight.title || `signal ${index + 1}`,
        body: insight.body || 'extracted',
        next: backlog[0]?.title || '',
        created_at: insight.created_at, source: 'insight', chips: index < 2 ? ['latest'] : [],
        node_id: insight.node_id, links: insight.links
      }));
    });

    captures.slice(-4).reverse().forEach((capture, index) => {
      signals.push(makeItem({
        lane: 'signals', title: capture.type === 'image' ? 'frame' : 'capture',
        body: capture.summary || 'stored',
        next: backlog[0]?.title || '',
        created_at: capture.created_at,
        source: capture.type === 'image' ? 'capture-image' : 'capture', chips: index < 2 ? ['latest'] : [],
        node_id: capture.node_id, links: capture.links
      }));
    });

    // Decisions
    decisions.slice(0, 5).forEach((decision, index) => {
      const decisionTitle = typeof decision === 'string' ? decision : (decision.title || `decision ${index + 1}`);
      const decisionBody = typeof decision === 'string' ? decision : (decision.body || decision.reason || 'locked');
      decisionsLane.push(makeItem({
        lane: 'decisions', title: decisionTitle, body: decisionBody,
        next: backlog[0]?.title || '',
        created_at: decision.created_at, source: 'decision', chips: index === 0 ? ['latest'] : [],
        node_id: decision.node_id, links: decision.links
      }));
    });

    if (!decisionsLane.length) {
      decisionsLane.push(makeItem({
        lane: 'decisions', title: 'no decisions locked',
        body: 'no locked decisions yet',
        next: '',
        created_at: new Date().toISOString(), source: 'decision-gap', chips: []
      }));
    }

    // Loops
    backlog.slice(0, 5).forEach((item, index) => {
      loops.push(makeItem({
        lane: 'open loops', title: item.title || `loop ${index + 1}`,
        body: item.body || item.state || 'open',
        next: item.title || '',
        created_at: item.created_at, source: 'backlog', chips: ['next']
      }));
    });

    const lanes = [
      { id: 'questions', label: 'asks', summary: 'open asks', items: questions },
      { id: 'signals', label: 'signals', summary: 'extracted signals', items: signals.length ? signals : [makeItem({ lane: 'signals', title: 'no signals', body: 'no signal extracted yet', next: '', created_at: new Date().toISOString(), source: 'empty', chips: ['latest'] })] },
      { id: 'decisions', label: 'decided', summary: 'locked decisions', items: decisionsLane },
      { id: 'open loops', label: 'loops', summary: 'open loops', items: loops.length ? loops : [makeItem({ lane: 'open loops', title: 'clear', body: 'no open loops', next: '', created_at: new Date().toISOString(), source: 'empty', chips: [] })] }
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

    return { chips, lanes };
  }

  function getKnowVisibleItems(model = buildKnowModel()) {
    const lane = model.lanes[stateData.knowLaneIndex || 0] || model.lanes[0];
    if (!lane) return [];
    const chipId = model.chips[stateData.knowChipIndex || 0]?.id || model.chips[0]?.id;
    const filtered = lane.items.filter(item => item.chips.includes(chipId));
    return filtered.length ? filtered : lane.items;
  }

  function getKnowHintText(item, lane, itemsCount) {
    if (!item) return itemsCount > 1 ? 'scroll items · ptt detail' : 'ptt detail';
    if (item.source === 'question') return itemsCount > 1 ? 'scroll items · ptt answer' : 'ptt answer';
    return itemsCount > 1 ? 'scroll items · ptt detail' : 'ptt know';
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
    drawFramedIcon(IC['5'] || 'assets/icons/png/5.png', {
      x: 11, y: 14, width: 24, height: 24, rx: 4, ry: 4
    }, svg, {
      inset: 1.5,
      style: 'filter: brightness(0) invert(0.96);',
      opacity: 0.96
    });
    text(40, 34, 'structa', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '34', 'letter-spacing': '0.0em'
    });
    text(14, 56, compactProjectName(projectDisplayName(project)), {
      fill: '#f8c15d',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '15'
    });
    mk('rect', { x: 14, y: 62, width: 26, height: 2, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.78)' });
  }

  function drawProjectSwitcher() {
    if (currentState !== STATES.PROJECT_SWITCHER) return;
    const projects = getProjects();
    const activeId = getActiveProjectId();
    const selectedIndexValue = typeof stateData.projectListIndex === 'number' ? stateData.projectListIndex : 0;
    const selected = Math.max(0, Math.min(selectedIndexValue, Math.max(projects.length - 1, 0)));
    const selectedProject = projects[selected] || projects[0];
    const isFreshWorkspace = freshWorkspaceState() && !onboardingAllowsProjectSwitcher();
    const headerTitle = isFreshWorkspace ? 'fresh start' : compactProjectName(selectedProject?.name || 'Untitled Project');

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: '#070707' });
    if (recordingActive()) recordingDot(23, 25, 10, svg);
    else drawFramedIcon(IC['5'] || 'assets/icons/png/5.png', {
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
    text(14, 54, headerTitle, {
      fill: '#f8c15d',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '15'
    });
    text(226, 54, 'projects', {
      fill: 'rgba(244,239,228,0.36)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
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
      text(226, 268, allowStagingFlush() ? 'flush resets onboarding' : 'ready for first project', {
        fill: 'rgba(244,239,228,0.34)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return;
    }

    const startY = 84;
    const rowH = 54;
    const visibleRows = 3;
    const offset = Math.max(0, Math.min(selected - 1, Math.max(0, projects.length - visibleRows)));
    projects.slice(offset, offset + visibleRows).forEach((project, visibleIndex) => {
      const absoluteIndex = offset + visibleIndex;
      const y = startY + (visibleIndex * rowH);
      const isSelected = absoluteIndex === selected;
      const isActive = project.project_id === activeId;
      const tap = mk('g', { style: 'cursor: pointer;' });

      mk('rect', {
        x: 10,
        y,
        width: 220,
        height: 42,
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

      text(18, y + 30, project.type || 'general', {
        fill: 'rgba(244,239,228,0.40)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      }, tap);

      text(128, y + 30, project.status || 'active', {
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

      const compactCount = [project.counts?.captures || 0, project.counts?.insights || 0].reduce((a, b) => a + b, 0);
      text(220, y + 30, compactCount ? `${compactCount} items` : 'quiet', {
        fill: 'rgba(244,239,228,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      }, tap);

      if (isActive) {
        mk('rect', { x: 18, y: y + 36, width: 20, height: 2, rx: 1, ry: 1, fill: '#f8c15d' }, tap);
      }

      tap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        stateData.projectListIndex = absoluteIndex;
        if (isSelected) activateSelectedProject();
        else render();
      });
    });

    const canFlush = allowStagingFlush();
    const flushConfirm = !!stateData.projectFlushConfirm;

    if (projects.length > 1 && selectedProject && selectedProject.status !== 'archived') {
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
        native?.archiveProject?.(selectedProject.project_id);
        const refreshed = getProjects();
        const nextIndex = Math.max(0, Math.min(stateData.projectListIndex || 0, Math.max(refreshed.length - 1, 0)));
        transition(STATES.PROJECT_SWITCHER, { projectListIndex: nextIndex });
      });
    }

    if (canFlush) {
      const flushTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', {
        x: 144, y: 248, width: 82, height: 20, rx: 8, ry: 8,
        fill: flushConfirm ? 'rgba(181,18,18,0.18)' : 'rgba(255,255,255,0.05)',
        stroke: flushConfirm ? 'rgba(181,18,18,0.62)' : 'rgba(255,255,255,0.12)',
        'stroke-width': 1
      }, flushTap);
      text(185, 261, flushConfirm ? 'confirm wipe' : 'flush memory', {
        fill: flushConfirm ? 'rgba(255,199,199,0.96)' : 'rgba(244,239,228,0.76)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'middle'
      }, flushTap);
      flushTap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        if (stateData.projectFlushConfirm) {
          flushTestingMemory();
          return;
        }
        stateData.projectFlushConfirm = true;
        render();
      });
    }

    text(226, 268, canFlush
      ? (flushConfirm ? 'tap flush again · resets onboarding' : (onboardingAllowsProjectSwitcher() ? 'lesson 1 · click returns' : 'staging tools · click opens'))
      : (projects.length > 1 ? `${projects.length} loaded · click opens` : '1 project loaded'), {
      fill: 'rgba(244,239,228,0.34)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
  }

  function drawSurfaceHeader(card) {
    const project = getProjectMemory();
    if (recordingActive() && activeSurface() !== 'home') {
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
    text(14, 58, compactProjectName(projectDisplayName(project)), {
      fill: 'rgba(8,8,8,0.52)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12'
    });
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
      if (onboardingActive() && !homeOnboardingSelectionAllowed(card.id)) return;
      if (selected && isHome()) {
        if (card.id === 'show' && event.type === 'pointerup') {
          openCameraFromShow('touch');
          return;
        }
        openCard(card);
      }
      else if (isHome()) selectIndex(index);
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
      createdAt: current?.captured_at || current?.created_at || current?.meta?.captured_at || null
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
    text(216, 92, inlineListening ? 'release reprompt' : (canReprompt ? 'ptt on frame' : 'ptt in lens'), {
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
      text(20, 148, 'touch to start camera', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      text(20, 172, 'then click shoots · hold narrates', {
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
      wrapTextBlock(undefined, model.analysisReady ? model.summary.slice(0, 52) : 'processing visual note', 22, 217, 190, 11, 'rgba(244,239,228,0.92)', '10', 1);
      if (!model.analysisReady) {
        text(210, 129, 'processing', {
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
      text(20, 148, 'frame saved', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, lower(String(model.summary || 'processing visual note')), 20, 170, 186, 13, 'rgba(8,8,8,0.76)', '12', 3);
      text(20, 206, model.analysisState === 'pending' ? 'processing visual note' : 'saved without preview', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    } else {
      text(20, 146, 'gallery starts here', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      text(20, 168, 'touch open lens to begin', {
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
      text(226, 276, 'waiting for touch', {
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
        const absoluteIndex = model.captures.indexOf(capture);
        stateData.showCaptureIndex = absoluteIndex >= 0 ? absoluteIndex : 0;
        stateData.showCaptureEntryId = capture?.entry_id || capture?.id || '';
        stateData.showStatus = 'visual memory';
        render();
      });
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
      status: stateData.tellStatus || (entries.length ? 'ready' : 'empty')
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
      text: data.blockerQuestion || data.next || '',
      surface: 'now'
    };
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
        stateData.tellEntryIndex = absoluteIndex;
        stateData.tellStatus = 'saved';
        render();
      });
    });
    text(226, 276, model.entries.length > 1 ? 'scroll notes · hold ptt builds' : 'hold ptt builds', {
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
    const data = buildNowSummary();
    const nowCard = cards.find(c => c.id === 'now');
    const inlineListening = recordingActive() && activeSurface() === 'project';
    const queueCount = window.StructaLLM?.pendingCount || 0;

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: nowCard.color });
    drawSurfaceHeader(nowCard);
    if (drawOnboardingNowPanel(nowCard, data)) return;
    const hasBlockers = data.pendingDecisions.length > 0 || data.openQuestions > 0;
    const chainY = 78;
    const phaseLabel = {
      blocked: 'waiting on blocker',
      observe: 'observing',
      clarify: 'clarifying',
      research: 'researching',
      evaluate: 'evaluating',
      decision: 'deciding',
      cooldown: 'cooling down',
      idle: 'idle'
    }[data.chainPhase] || data.chainPhase;

    if (!hasBlockers) {
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

    if (data.pendingDecisions.length > 0) {
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

      if (pdOptions.length >= 2) {
        const slabY = boxY + 26 + (titleRows * 13) + 10;
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
    } else if (data.openQuestions > 0) {
      const boxY = 78;
      mk('rect', { x: 10, y: boxY, width: 220, height: 170, rx: 12, fill: 'rgba(8,8,8,0.15)' });
      text(18, boxY + 18, 'answer to continue', {
        fill: 'rgba(8,8,8,0.52)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      if (queueCount > 0) {
        text(222, boxY + 18, `${queueCount} queued`, {
          fill: 'rgba(8,8,8,0.42)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10',
          'text-anchor': 'end'
        });
      }
      // Gold accent bar — signals this is Structa speaking
      mk('rect', { x: 10, y: boxY + 28, width: 3, height: 110, rx: 1, ry: 1, fill: 'rgba(248,193,93,0.72)' });
      const blockerText = String(data.blockerQuestion || '').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const blockerRows = wrapTextBlock(undefined, lower(blockerText.slice(0, 152)), 20, boxY + 40, 192, 14, 'rgba(8,8,8,0.96)', '14', 6);
      const ctaY = Math.min(boxY + 126, boxY + 42 + blockerRows * 14 + 16);
      mk('rect', { x: 18, y: ctaY, width: 160, height: 24, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.92)' });
      text(30, ctaY + 16, inlineListening ? 'release to send answer' : 'hold ptt to answer', {
        fill: 'rgba(244,239,228,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      if (data.blockerCount > 1) {
        text(18, ctaY + 42, `${data.blockerCount} blockers waiting to clear`, {
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
      text(14, 112, 'boiler room ready', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '17'
      });
      wrapTextBlock(undefined, lower(data.next || 'capture or tell to build project structure'), 14, 138, 212, 14, 'rgba(8,8,8,0.80)', '13', 5);
      text(14, 222, data.chainActive || data.chainPhase !== 'idle' ? phaseLabel : 'waiting for your next move', {
        fill: 'rgba(8,8,8,0.46)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      });
      if (queueCount > 0) {
        text(226, 222, `${queueCount} queued`, {
          fill: 'rgba(8,8,8,0.36)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '10',
          'text-anchor': 'end'
        });
      }
    }

    text(226, 276, hasBlockers ? (queueCount ? `${queueCount} queued · waits` : 'chain waits for answer') : 'hold ptt on project', {
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
    drawSurfaceHeader(knowCard);

    if (onboardingActive() && getOnboardingStep() === 4) {
      mk('rect', { x: 10, y: 84, width: 220, height: 152, rx: 12, fill: 'rgba(8,8,8,0.12)' });
      text(18, 104, 'lesson 4 · show structa', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });
      wrapTextBlock(undefined, 'go home, scroll to show, and capture your first frame. the first capture unlocks the full app.', 18, 132, 194, 14, 'rgba(8,8,8,0.78)', '13', 6);
      text(18, 218, 'back → home', {
        fill: 'rgba(8,8,8,0.54)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      text(226, 276, 'capture completes onboarding', {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });
      return;
    }

    // Touchable lane tabs
    const laneTabs = [
      { id: 'questions', label: 'asks', width: 44 },
      { id: 'signals', label: 'signal', width: 48 },
      { id: 'decisions', label: 'decided', width: 52 },
      { id: 'open loops', label: 'loops', width: 42 }
    ];
    let tabX = 14;
    laneTabs.forEach((tab, i) => {
      const isActive = lane.id === tab.id;
      const pillGroup = mk('g', { 'data-lane-index': i, style: 'cursor: pointer;' });
      mk('rect', {
        x: tabX, y: 74, width: tab.width, height: 22, rx: 6, ry: 6,
        fill: isActive ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.10)',
        stroke: isActive ? 'rgba(8,8,8,0.06)' : 'rgba(8,8,8,0.04)',
        'stroke-width': 1
      }, pillGroup);
      const tabText = mk('text', {
        x: tabX + tab.width / 2, y: 74 + 22 / 2 + 4,
        fill: isActive ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.76)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12', 'text-anchor': 'middle'
      }, pillGroup);
      tabText.textContent = lower(tab.label);

      pillGroup.addEventListener('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        stateData.knowLaneIndex = i;
        stateData.knowItemIndex = 0;
        const newLane = model.lanes[i];
        const activeChip = model.chips[stateData.knowChipIndex]?.id;
        const hasChipItems = newLane?.items?.some(item => item.chips.includes(activeChip));
        if (!hasChipItems) stateData.knowChipIndex = newLane?.availableChipIndexes?.[0] ?? 0;
        render();
      });

      tabX += tab.width + 4;
    });

    // Filter chips row - touchable
    const activeChips = model.chips.filter((c, i) => availableChipIndexes.includes(i));
    const showChipRow = activeChips.length > 1;
    const chipY = 102;
    if (showChipRow) {
      let chipX = 14;
      activeChips.forEach((c) => {
        const realIndex = model.chips.indexOf(c);
        const isActive = realIndex === safeChipIdx;
        const chipWidth = Math.max(40, c.label.length * 7 + 16);
        const chipGroup = mk('g', { 'data-chip-index': realIndex, style: 'cursor: pointer;' });
        mk('rect', {
          x: chipX, y: chipY, width: chipWidth, height: 18, rx: 5, ry: 5,
          fill: isActive ? 'rgba(8,8,8,0.92)' : 'rgba(8,8,8,0.12)',
          stroke: isActive ? 'rgba(8,8,8,0.10)' : 'rgba(8,8,8,0.05)', 'stroke-width': 1
        }, chipGroup);
        const chipText = mk('text', {
          x: chipX + chipWidth / 2, y: chipY + 13,
          fill: isActive ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.76)',
          'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10', 'text-anchor': 'middle'
        }, chipGroup);
        chipText.textContent = lower(c.label);

        chipGroup.addEventListener('pointerup', (e) => {
          e.preventDefault();
          e.stopPropagation();
          stateData.knowChipIndex = realIndex;
          stateData.knowItemIndex = 0;
          render();
        });

        chipX += chipWidth + 4;
      });
    }

    // Content area - directly below chips
    const contentY = showChipRow ? 130 : 112;

    if (currentState === STATES.KNOW_BROWSE) {
      const titleText = String(item.title || lane.label || 'untitled').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const titleRows = wrapTextBlock(undefined, lower(titleText), 14, contentY, 168, 14, 'rgba(8,8,8,0.96)', '16', 3);

      text(226, contentY + 1, formatTimeLabel(item.created_at), {
        fill: 'rgba(8,8,8,0.40)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10', 'text-anchor': 'end'
      });

      // Context label - source type
      const contextLabel = item.source === 'question' ? 'open ask'
        : item.source === 'insight' ? 'insight'
        : item.source === 'capture-image' ? 'visual capture'
        : item.source === 'decision' ? 'locked decision'
        : item.source === 'backlog' ? 'open loop'
        : lane.label;
      const metaY = contentY + (titleRows * 14) + 6;
      text(14, metaY, contextLabel, {
        fill: 'rgba(8,8,8,0.40)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });

      const bodyY = metaY + 18;
      const bodyText = String(item.body || 'no content yet').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const bodyRows = wrapTextBlock(undefined, lower(bodyText), 14, bodyY, 212, 13, 'rgba(8,8,8,0.85)', '12', 7);

      const nextText = lower(String(item.next || '')).replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      if (nextText && nextText !== 'review this') {
        const actionY = Math.min(238, bodyY + (bodyRows * 13) + 16);
        text(14, actionY, '→', {
          fill: 'rgba(8,8,8,0.50)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '12'
        });
        wrapTextBlock(undefined, nextText, 26, actionY, 196, 12, 'rgba(8,8,8,0.70)', '11', 2);
      }

      // Scroll hint
      text(226, 276, `${recordingActive() && activeSurface() === 'insight' ? 'release to build context' : getKnowHintText(item, lane, items.length)}${items.length > 1 ? ' · ' + (itemIdx + 1) + '/' + items.length : ''}`, {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10',
        'text-anchor': 'end'
      });

      // Touchable content area - tap opens detail
      const contentGroup = mk('g', { style: 'cursor: pointer;' });
      mk('rect', { x: 0, y: contentY - 16, width: 240, height: 206, fill: 'transparent' }, contentGroup);
      contentGroup.addEventListener('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        transition(STATES.KNOW_DETAIL);
      });
      return;
    }

    // KNOW_DETAIL - expanded view
    const detailTitle = String(item.title || lane.label || 'untitled').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const detailTitleRows = wrapTextBlock(undefined, lower(detailTitle), 14, contentY, 168, 14, 'rgba(8,8,8,0.96)', '16', 3);
    text(226, contentY + 1, formatTimeLabel(item.created_at), {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10', 'text-anchor': 'end'
    });

    const detailSection = item.source === 'question' ? 'open ask' : 'detail';
    const detailMetaY = contentY + (detailTitleRows * 14) + 8;
    drawSectionLabel(undefined, 14, detailMetaY, detailSection);
    const detailBodyY = detailMetaY + 16;
    const detailBodyText = String(item.body || 'no detail yet').replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const detailRows = wrapTextBlock(undefined, lower(detailBodyText), 14, detailBodyY, 212, 13, 'rgba(8,8,8,0.90)', '13', 9);

    if (item.source === 'question') {
      const actionY = Math.min(234, detailBodyY + (detailRows * 13) + 16);
      mk('rect', { x: 10, y: actionY - 6, width: 220, height: 26, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.12)' });
      drawSquaredPill(18, actionY, 96, 14, 'ptt → answer', true, 'light');
      text(136, actionY + 11, 'voice answer', {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    } else {
      const nextText = lower(String(item.next || '')).replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      if (nextText && nextText !== 'review this') {
        const nextY = Math.min(236, detailBodyY + (detailRows * 13) + 18);
        drawSectionLabel(undefined, 14, nextY, 'next move');
        wrapTextBlock(undefined, nextText, 14, nextY + 16, 212, 12, 'rgba(8,8,8,0.96)', '12', 2);
      }
    }

    text(226, 276, `${recordingActive() && activeSurface() === 'insight' ? 'release to build context' : getKnowHintText(item, lane, items.length)}${items.length > 1 ? ' · ' + (safeItemIdx + 1) + '/' + items.length : ''}`, {
      fill: 'rgba(8,8,8,0.34)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    });
  }

  // === Main render ===
  function render() {
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

    const isContentSurface = surface === 'project' || surface === 'insight' || surface === 'show' || surface === 'tell' || currentState === STATES.PROJECT_SWITCHER;
    logDrawer.style.display = isContentSurface ? 'none' : '';
  }

  // === Input handlers (all routed through state machine) ===

  function handleScrollDirection(direction) {
    switch (currentState) {
      case STATES.PROJECT_SWITCHER: {
        if (onboardingActive() && !onboardingAllowsProjectSwitcher()) break;
        const projects = getProjects();
        if (!projects.length) break;
        const currentIndex = typeof stateData.projectListIndex === 'number' ? stateData.projectListIndex : 0;
        stateData.projectListIndex = Math.max(0, Math.min(currentIndex + (direction > 0 ? 1 : -1), projects.length - 1));
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
        if (!window.StructaVoice?.listening) {
          document.body.classList.add('input-locked');
          window.StructaVoice?.startListening?.();
        }
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
        stateData.knowItemIndex = (stateData.knowItemIndex + (direction > 0 ? 1 : -1) + items.length) % items.length;
        render();
        break;
      }

      case STATES.NOW_BROWSE: {
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

  function handleSideClick() {
    switch (currentState) {
      case STATES.PROJECT_SWITCHER:
        activateSelectedProject();
        break;

      case STATES.SHOW_BROWSE:
        openCameraFromShow('touch');
        break;

      case STATES.TELL_BROWSE: {
        // Side click on TELL = open KNOW to see impact of this note
        const tellContext = buildTellVoiceContext();
        if (tellContext.text) {
          const project = getProjectMemory();
          const relatedInsights = (project?.insights || []).filter(function(insight) {
            return insight?.node_id === tellContext.nodeId || (insight?.links || []).includes(tellContext.nodeId);
          });
          if (!relatedInsights.length) {
            pushLog('no impacts from note yet', 'voice');
          }
          selectedIndex = cards.findIndex(c => c.id === 'know');
          transition(STATES.KNOW_BROWSE, { knowLaneIndex: 1, knowItemIndex: 0, knowFocusNodeId: tellContext.nodeId || '' });
        }
        break;
      }

      case STATES.SHOW_PRIMED:
        // Side while primed — open camera
        openCameraFromShow('touch');
        break;

      case STATES.CAMERA_OPEN:
        // Side = capture
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
        transition(STATES.KNOW_DETAIL);
        break;

      case STATES.KNOW_DETAIL: {
        const model = buildKnowModel();
        const items = getKnowVisibleItems(model);
        const item = items[stateData.knowItemIndex || 0];
        if (item && item.source === 'question' && item.questionIndex !== undefined) {
          transition(STATES.KNOW_ANSWER, { question: { index: item.questionIndex, text: item.body } });
          return;
        }
        transition(STATES.KNOW_BROWSE, { preserveKnowFocus: true });
        break;
      }

      case STATES.NOW_BROWSE: {
        if (onboardingActive()) {
          const step = getOnboardingStep();
          if (step === 0) {
            setOnboardingStep(1);
            pushLog('lesson 0 complete', 'system');
            render();
            return;
          }
          return;
        }
        if (approveCurrentNowDecision()) {
          if (window.StructaAudio?.play) window.StructaAudio.play('approve');
          return;
        }
        pushLog('hold ptt to answer blocker', 'project');
        break;
      }

      case STATES.LOG_OPEN:
        transition(STATES.HOME);
        break;

      case STATES.HOME:
        if (onboardingActive() && !homeOnboardingSelectionAllowed(currentCard().id)) return;
        openCard(currentCard());
        break;

      default:
        break;
    }
  }

  function handleLongPressStart() {
    switch (currentState) {
      case STATES.PROJECT_SWITCHER:
        break;
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
        voiceReturnState = STATES.TELL_BROWSE;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'listening',
          inlinePTTSurface: 'tell',
          buildContext: buildTellVoiceContext()
        });
        break;

      case STATES.SHOW_BROWSE:
        if (!captureAnalysisReady(buildShowSummary().current)) {
          pushLog('wait for visual note', 'camera');
          break;
        }
        voiceReturnState = STATES.SHOW_BROWSE;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'reprompt frame',
          inlinePTTSurface: 'show',
          buildContext: buildShowVoiceContext()
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
        const project = getProjectMemory();
        const openQuestions = project?.open_questions || [];
        voiceReturnState = STATES.NOW_BROWSE;
        if (onboardingActive() && getOnboardingStep() === 2) {
          transition(STATES.VOICE_OPEN, {
            answeringQuestion: { index: -1, text: 'what is this project about?', onboarding: true },
            fromPTT: true,
            inlinePTTSurface: 'project'
          });
        } else if (openQuestions.length) {
          transition(STATES.VOICE_OPEN, {
            answeringQuestion: { index: 0, text: openQuestions[0] },
            fromPTT: true,
            inlinePTTSurface: 'project'
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
        // Long press in log = export
        exportLogsFromHardware();
        break;

      case STATES.KNOW_BROWSE:
        voiceReturnState = STATES.KNOW_BROWSE;
        transition(STATES.VOICE_OPEN, {
          fromPTT: true,
          tellStatus: 'ask know',
          inlinePTTSurface: 'insight',
          buildContext: buildKnowVoiceContext()
        });
        break;

      case STATES.KNOW_DETAIL: {
        const model = buildKnowModel();
        const items = getKnowVisibleItems(model);
        const item = items[stateData.knowItemIndex || 0];
        if (item && item.source === 'question' && item.questionIndex !== undefined) {
          transition(STATES.KNOW_ANSWER, { question: { index: item.questionIndex, text: item.body } });
        } else {
          voiceReturnState = STATES.KNOW_DETAIL;
          transition(STATES.VOICE_OPEN, {
            fromPTT: true,
            tellStatus: 'ask know',
            inlinePTTSurface: 'insight',
            buildContext: buildKnowVoiceContext()
          });
        }
        break;
      }

      default:
        break;
    }
  }

  function handleLongPressEnd() {
    document.body.classList.remove('input-locked');

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
        window.StructaVoice?.stopListening?.(true);
        transition(STATES.VOICE_PROCESSING);
        break;

      default:
        break;
    }
  }

  function goHome() {
    transition(STATES.HOME);
  }

  function handleNativeBack(event) {
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
        transition(STATES.HOME);
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
    handleScrollDirection(event.deltaY > 0 ? 1 : -1);
  }

  svg.addEventListener('wheel', onWheel, { passive: false });

  log.addEventListener('wheel', event => {
    if (currentState !== STATES.LOG_OPEN) event.preventDefault();
  }, { passive: false });

  logHandle.addEventListener('click', event => {
    event.preventDefault();
    if (!onboardingAllowsLogs()) return;
    if (isCaptureState()) return;
    if (currentState === STATES.LOG_OPEN) {
      transition(STATES.HOME);
    } else if (currentState === STATES.HOME) {
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
    refreshLogFromMemory();
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
      stateData.showStatus = 'processing visual note';
      render();
    }
    if (onboardingActive() && getOnboardingStep() === 4) {
      completeOnboarding();
    }
    refreshLogFromMemory();
  });

  window.addEventListener('structa-onboarding-answer', function(event) {
    if (!onboardingActive() || getOnboardingStep() !== 2) return;
    const inferredName = event?.detail?.inferredName || '';
    if (inferredName) native?.setProjectName?.(inferredName);
    setOnboardingStep(3);
    pushLog('lesson 2 complete', 'system');
    if (currentState === STATES.VOICE_PROCESSING || currentState === STATES.VOICE_OPEN) {
      voiceReturnState = STATES.NOW_BROWSE;
    } else if (currentState === STATES.NOW_BROWSE) {
      render();
    }
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
    refreshLogFromMemory();
  });

  window.addEventListener('structa-memory-updated', () => {
    refreshLogFromMemory();
    render();
    maybeStartHeartbeat();
    if (!onboardingActive() && !chainStarted && projectHasMeaningfulContent() && window.StructaImpactChain && !window.StructaImpactChain.active) {
      chainStarted = true;
      window.StructaImpactChain.start(2);
    }
  });

  window.addEventListener('structa-probe-event', () => { refreshLogFromMemory(); });

  // Hardware inputs
  window.addEventListener('scrollUp', event => { event.preventDefault?.(); handleScrollDirection(1); });
  window.addEventListener('scrollDown', event => { event.preventDefault?.(); handleScrollDirection(-1); });
  window.addEventListener('sideClick', event => { event.preventDefault?.(); handleSideClick(); });
  window.addEventListener('longPressStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('longPressEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
  window.addEventListener('pttStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('pttEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
  window.addEventListener('backbutton', handleNativeBack);
  window.addEventListener('popstate', handleNativeBack);

  // Keyboard fallback
  document.addEventListener('keydown', event => {
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
    if (magnitude < 55 || now - lastShakeAt < 2500) return;
    lastShakeAt = now;
    if (onboardingActive()) {
      if (getOnboardingStep() === 1) {
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
  refreshLogFromMemory();
  render();
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
    phaseText.textContent = labels[chain.phase] || chain.phase;
  }

  // Re-render NOW panel on each impact + notify relevant cards
  window.addEventListener('structa-impact', function(e) {
    updateChainBadge();
    if (currentState === STATES.NOW_BROWSE) render();
    // Soft notification on home to show app is working
    if (currentState === STATES.HOME) {
      notifyCard('know', 'soft');
    }
  });

  // Show spring notification when decision created
  window.addEventListener('structa-decision-created', function(e) {
    updateChainBadge();
    notifyCard('now', 'urgent');
    if (currentState === STATES.NOW_BROWSE) render();
  });

  // Start chain after first user interaction + init audio
  let chainStarted = false;
  function startChainOnInteraction() {
    // Init audio engine on first user gesture (required by browsers)
    if (window.StructaAudio) window.StructaAudio.init();
    if (onboardingActive() || chainStarted || !projectHasMeaningfulContent()) return;
    chainStarted = true;
    if (window.StructaImpactChain && !window.StructaImpactChain.active) {
      window.StructaImpactChain.start(2); // 2bpm = every 30s
    }
  }
  ['sideClick', 'pointerup', 'scrollUp', 'scrollDown'].forEach(function(evt) {
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
      stateData.nowFeedback = 'answer queued';
      render();
      setTimeout(function() {
        if (stateData.nowFeedback === 'answer queued') {
          stateData.nowFeedback = '';
          render();
        }
      }, 1200);
    }
  });

  // === Discovery question notification ===
  window.addEventListener('structa-discovery-question', function(e) {
    notifyCard('know', 'urgent');
    if (e && e.detail && e.detail.question) {
      pushLog('structa asks: ' + e.detail.question.slice(0, 40), 'chain');
    }
  });

  // === Voice command handler ===
  window.addEventListener('structa-voice-command', function(e) {
    if (!e || !e.detail) return;
    var cmd = e.detail;

    if (cmd.command === 'new-project') {
      if (cmd.name && native?.createProject) {
        native.createProject(cmd.name);
        pushLog('project: ' + cmd.name.slice(0, 30), 'voice');
        transition(STATES.HOME);
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

  // === Public API ===
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
