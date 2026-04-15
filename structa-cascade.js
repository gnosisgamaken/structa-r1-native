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

  const cards = [
    { id: 'show', title: 'show', iconPath: 'assets/icons/png/4.png', iconFallback: '▣', role: 'capture image', roleShort: 'visual memory', color: 'var(--show)', surface: 'camera' },
    { id: 'tell', title: 'tell', iconPath: 'assets/icons/png/3.png', iconFallback: '◉', role: 'capture commands', roleShort: 'speak update', color: 'var(--tell)', surface: 'voice' },
    { id: 'know', title: 'know', iconPath: 'assets/icons/png/7.png', iconFallback: '◈', role: 'generate insights', roleShort: 'find signal', color: 'var(--know)', surface: 'insight' },
    { id: 'now', title: 'now', iconPath: 'assets/icons/png/6.png', iconFallback: '▣', role: 'project structure', roleShort: 'catch up fast', color: 'var(--now)', surface: 'project' }
  ];

  // === State machine ===
  let currentState = STATES.HOME;
  let stateData = {}; // per-state context
  let selectedIndex = 0;
  let logOpen = false;
  let cameraReturnState = STATES.HOME;
  let voiceReturnState = STATES.HOME;

  // Derived from stateData (shorthand accessors)
  function isHome() { return currentState === STATES.HOME; }
  function isCaptureState() { return currentState === STATES.CAMERA_OPEN || currentState === STATES.VOICE_OPEN; }

  // === Utility ===
  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
  }

  function lower(text = '') {
    return String(text || '').toLowerCase();
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

  function getUIState() {
    return native?.getUIState?.() || getMemory().uiState || {};
  }

  function getCaptureList() {
    return (getMemory().captures || []).filter(Boolean);
  }

  function getVoiceEntries() {
    const journals = (getMemory().journals || []).filter(Boolean);
    return journals
      .filter(entry => lower(entry?.source_type || '') === 'voice')
      .slice()
      .reverse();
  }

  function getCaptureImageHref(capture) {
    return capture?.image_asset?.data || capture?.image_asset?.url || capture?.asset?.data || capture?.data || '';
  }

  function getCaptureSummary(capture) {
    return lower(capture?.ai_analysis || capture?.ai_response || capture?.summary || capture?.prompt_text || 'untitled capture');
  }

  function latestLogText() {
    const row = log.lastElementChild;
    return row ? lower(row.textContent || '') : 'no logs yet';
  }

  // === Transition ===
  function transition(newState, data = {}) {
    const prev = currentState;
    const prevStateData = { ...stateData };

    // Exit previous state
    stateExitHandlers[prev]?.(prevStateData);

    currentState = newState;
    stateData = { ...stateData, ...data };

    // Enter new state
    stateEnterHandlers[newState]?.(stateData);

    // Render
    render();
  }

  // === Log management ===
  function pushLog(text, strong = '') {
    const wouldBeVisible = native?.isVisibleLogEntry?.({ kind: lower(strong || 'ui'), message: lower(`${strong ? `${strong} ` : ''}${text}`) });
    if (wouldBeVisible === false) {
      native?.appendLogEntry?.({ kind: 'ui', message: lower(`${strong ? `${strong} ` : ''}${text}`) });
      return;
    }
    const row = document.createElement('div');
    row.className = 'entry';
    // Tag chain/decision entries for styling
    if (strong === 'chain' || strong === 'decision') {
      row.setAttribute('data-kind', strong);
    }
    const time = document.createElement('span');
    time.className = 'muted';
    time.textContent = `[${stamp()}]`;
    row.appendChild(time);
    if (strong) {
      const accent = document.createElement('span');
      accent.className = 'accent';
      accent.textContent = lower(strong);
      row.appendChild(accent);
    }
    const message = document.createElement('span');
    message.textContent = lower(text);
    row.appendChild(message);
    log.appendChild(row);
    while (log.children.length > 5 && !logOpen) log.removeChild(log.firstChild);
    if (!logOpen && log.children.length > 5) {
      while (log.children.length > 5) log.removeChild(log.firstChild);
    }
    logPreview.textContent = latestLogText();
    native?.appendLogEntry?.({ kind: 'ui', message: lower(`${strong ? `${strong} ` : ''}${text}`) });
  }

  function refreshLogFromMemory() {
    const limit = logOpen ? 33 : 5;
    const previousScroll = log.scrollTop;
    const entries = (native?.getRecentLogEntries?.(limit, { visible_only: true }) || []).slice(-limit);
    log.innerHTML = '';
    if (!entries.length) {
      logPreview.textContent = 'no logs yet';
      return;
    }
    entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'entry';
      const time = document.createElement('span');
      time.className = 'muted';
      time.textContent = `[${lower(new Date(entry.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}]`;
      row.appendChild(time);
      const message = document.createElement('span');
      message.textContent = lower(entry.message || 'event');
      row.appendChild(message);
      log.appendChild(row);
    });
    logPreview.textContent = latestLogText();
    if (logOpen) log.scrollTop = previousScroll;
  }

  function setLogDrawer(open) {
    logOpen = !!open;
    logDrawer.classList.toggle('open', logOpen);
    logDrawer.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
    if (logOpen) {
      const entries = native?.getRecentLogEntries?.(33, { visible_only: true }) || [];
      log.innerHTML = '';
      entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'entry';
        const time = document.createElement('span');
        time.className = 'muted';
        time.textContent = `[${lower(new Date(entry.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}]`;
        row.appendChild(time);
        const message = document.createElement('span');
        message.textContent = lower(entry.message || 'event');
        row.appendChild(message);
        log.appendChild(row);
      });
      log.scrollTop = log.scrollHeight;
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
    maybeStartHeartbeat();
  };

  stateExitHandlers[STATES.HOME] = function(data) {
    // nothing specific
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
      stateData.tellStatus = entries.length ? 'hold to speak' : 'hold to record';
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
      stateData.showStatus = captures.length ? 'ready for another frame' : 'tap to start';
    }
  };

  // --- SHOW_PRIMED (legacy invisible warm state) ---
  stateEnterHandlers[STATES.SHOW_PRIMED] = function(data) {
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
    window.StructaCamera?.close?.();
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
          showStatus: 'latest visual memory'
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

    // If answering a question, set context before starting
    if (data.answeringQuestion) {
      if (window.StructaVoice?.setQuestionContext) {
        window.StructaVoice.setQuestionContext(data.answeringQuestion.index, data.answeringQuestion.text);
      }
      native?.appendLogEntry?.({ kind: 'voice', message: 'answering: ' + data.answeringQuestion.text.slice(0, 40) });
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
  };

  // --- VOICE_PROCESSING ---
  stateEnterHandlers[STATES.VOICE_PROCESSING] = function(data) {
    // Brief processing state — return to the prior surface
    setTimeout(() => {
      if (currentState === STATES.VOICE_PROCESSING) {
        const returnState = voiceReturnState;
        voiceReturnState = STATES.HOME;
        transition(returnState || STATES.HOME, {
          tellStatus: 'voice saved'
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
    stateData.knowLaneIndex = 0;
    stateData.knowItemIndex = 0;
    stateData.knowChipIndex = 0;
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
    if (card.surface === 'camera') {
      transition(STATES.SHOW_BROWSE, { showStatus: 'tap to start' });
      return;
    }
    if (card.surface === 'voice') {
      transition(STATES.TELL_BROWSE, { tellStatus: 'hold to speak' });
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

  function openCameraFromShow(source = 'touch') {
    cameraReturnState = STATES.SHOW_BROWSE;
    stateData.showStatus = source === 'touch'
      ? 'opening lens'
      : 'opening lens';
    render();

    if (source !== 'touch' && !window.StructaCamera?.primed && !window.__STRUCTA_PRIMED_STREAM__?.active) {
      stateData.showStatus = 'tap camera to enable lens';
      pushLog('tap camera to enable lens', 'show');
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

  // === Surface identification (backward compat for render) ===
  function activeSurface() {
    switch (currentState) {
      case STATES.HOME:
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
        return 'voice';
      case STATES.KNOW_BROWSE:
      case STATES.KNOW_DETAIL:
        return 'insight';
      case STATES.NOW_BROWSE:
        return 'project';
      default:
        return 'home';
    }
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
    if (window.StructaHeartbeat && window.StructaHeartbeat.bpm === 0) {
      const project = getProjectMemory();
      const hasContent = (project?.backlog?.length || 0) + (project?.insights?.length || 0) + (project?.captures?.length || 0) + (project?.open_questions?.length || 0);
      if (hasContent > 0) {
        window.StructaHeartbeat.start(10);
        pushLog('heartbeat started', 'system');
      }
    }
  }

  // === NOW card builder ===
  function buildNowSummary() {
    const memory = getMemory();
    const project = getProjectMemory();
    const ui = getUIState();
    const captures = memory.captures || [];
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

    return {
      title: project?.name || 'untitled project',
      changed: ui.last_event_summary || 'ready to resume',
      capture: ui.last_capture_summary || (captures[captures.length - 1]?.summary || 'no capture yet'),
      insight: ui.last_insight_summary || (insights[0]?.body || 'no insight yet'),
      next: backlog[0]?.title || (openQuestions[0] ? `answer: ${openQuestions[0].slice(0, 30)}` : 'use tell to add the next update'),
      openQuestions: openQuestions.length,
      captures: captures.length,
      insights: insights.length,
      decisions: decisions.length,
      pendingDecisions: pendingDecisions,
      pendingDecisionText: pendingDecisions.length ? (typeof pendingDecisions[0] === 'string' ? pendingDecisions[0] : pendingDecisions[0].text) : null,
      pendingDecisionIndex: decIdx,
      pendingDecisionOptions: pendingDecisions.length ? (typeof pendingDecisions[0] === 'string' ? [] : (pendingDecisions[0].options || [])) : [],
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

    const makeItem = ({ lane, title, body, next, created_at, source, chips: chipHints = [], questionIndex }) => classify({
      lane,
      title: lower(title || lane),
      body: lower(body || 'no detail yet'),
      next: lower(next || 'capture the next useful update'),
      created_at: created_at || new Date().toISOString(),
      source: source || lane,
      chips: chipHints.slice(),
      questionIndex
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
        lane: 'questions', title: `question ${index + 1}`, body: question,
        next: 'side = answer this now', created_at: new Date().toISOString(),
        source: 'question', chips: ['asks'], questionIndex: index
      }));
    });

    if (!questions.length) {
      questions.push(makeItem({
        lane: 'questions', title: 'all clear', body: 'no open questions right now',
        next: 'use tell to add something that needs an answer',
        created_at: new Date().toISOString(), source: 'empty', chips: ['latest']
      }));
    }

    // Signals
    if (ui.last_insight_summary || ui.last_capture_summary) {
      signals.push(makeItem({
        lane: 'signals', title: 'latest signal',
        body: ui.last_insight_summary || ui.last_capture_summary,
        next: backlog[0]?.title || 'open now or tell to keep momentum',
        created_at: new Date().toISOString(), source: 'ui', chips: ['latest', 'next']
      }));
    }

    insights.slice(0, 4).forEach((insight, index) => {
      signals.push(makeItem({
        lane: 'signals', title: insight.title || `signal ${index + 1}`,
        body: insight.body || 'captured insight',
        next: backlog[0]?.title || 'capture the next concrete task with tell',
        created_at: insight.created_at, source: 'insight', chips: index < 2 ? ['latest'] : []
      }));
    });

    captures.slice(-4).reverse().forEach((capture, index) => {
      signals.push(makeItem({
        lane: 'signals', title: capture.type === 'image' ? 'visual capture' : 'recent capture',
        body: capture.summary || 'capture stored',
        next: backlog[0]?.title || 'review the capture and decide the next move',
        created_at: capture.created_at,
        source: capture.type === 'image' ? 'capture-image' : 'capture', chips: index < 2 ? ['latest'] : []
      }));
    });

    // Decisions
    decisions.slice(0, 5).forEach((decision, index) => {
      const decisionTitle = typeof decision === 'string' ? decision : (decision.title || `decision ${index + 1}`);
      const decisionBody = typeof decision === 'string' ? decision : (decision.body || decision.reason || 'decision recorded');
      decisionsLane.push(makeItem({
        lane: 'decisions', title: decisionTitle, body: decisionBody,
        next: backlog[0]?.title || 'act on the decision',
        created_at: decision.created_at, source: 'decision', chips: index === 0 ? ['latest'] : []
      }));
    });

    if (!decisionsLane.length) {
      decisionsLane.push(makeItem({
        lane: 'decisions', title: 'no locked decisions',
        body: 'use tell to state a decision — it will appear here once approved',
        next: backlog[0]?.title || 'speak a clear decision with tell',
        created_at: new Date().toISOString(), source: 'decision-gap', chips: []
      }));
    }

    // Loops
    backlog.slice(0, 5).forEach((item, index) => {
      loops.push(makeItem({
        lane: 'open loops', title: item.title || `open loop ${index + 1}`,
        body: item.body || item.state || 'still open',
        next: item.title || 'move this loop forward with tell',
        created_at: item.created_at, source: 'backlog', chips: ['next']
      }));
    });

    const lanes = [
      { id: 'questions', label: 'asks', summary: 'questions waiting for an answer', emptyTitle: 'all clear', emptyBody: 'no open questions', emptyNext: 'use tell to add something that needs an answer', items: questions },
      { id: 'signals', label: 'signals', summary: 'what changed and why it matters', emptyTitle: 'no signals yet', emptyBody: 'capture something with show or tell', emptyNext: 'use tell to add one update', items: signals.length ? signals : [makeItem({ lane: 'signals', title: 'no signals yet', body: 'capture something with show or tell', next: 'use tell to add one update', created_at: new Date().toISOString(), source: 'empty', chips: ['latest'] })] },
      { id: 'decisions', label: 'decided', summary: 'what is locked and ready to act on', emptyTitle: 'no decisions yet', emptyBody: 'speak a decision with tell — approve it in now', emptyNext: 'use tell to state a decision', items: decisionsLane },
      { id: 'open loops', label: 'loops', summary: 'unresolved tasks and items', emptyTitle: 'no open loops', emptyBody: 'this project has no open loops', emptyNext: 'capture the next question or task', items: loops.length ? loops : [makeItem({ lane: 'open loops', title: 'no open loops', body: 'clean slate', next: 'capture the next task', created_at: new Date().toISOString(), source: 'empty', chips: [] })] }
    ].map(lane => {
      lane.items
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
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

  // === SVG rendering helpers ===
  function cardLayout(index) {
    if (index === selectedIndex) return { x: 120, y: 48, scale: 1.5, opacity: 1, depth: -1 };
    const depth = ((selectedIndex - index - 1 + cards.length) % cards.length);
    var heroCenterY = 48 + (150 * 1.5) / 2;
    var scales = [0.50, 0.69, 0.92];
    var xPositions = [0, 40, 80];
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
    return mk('image', { href, ...attrs }, parent);
  }

  function drawCardIcon(card, selected, parent) {
    if (!selected) return;
    if (card.iconPath) {
      image(card.iconPath, {
        x: 18, y: 16, width: 30, height: 30,
        preserveAspectRatio: 'xMidYMid meet', opacity: 1,
        style: 'filter: brightness(0) saturate(100%);'
      }, parent);
      return;
    }
    text(18, 40, card.iconFallback || '•', {
      fill: 'rgba(10,10,10,0.88)',
      'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '28'
    }, parent);
  }

  function drawWordmark() {
    if (currentState !== STATES.HOME && currentState !== STATES.LOG_OPEN) return;
    image('assets/icons/png/5.png', {
      x: 11, y: 14, width: 24, height: 24,
      preserveAspectRatio: 'xMidYMid meet', opacity: 0.96,
      style: 'filter: brightness(0) invert(0.96);'
    });
    text(42, 40, 'structa', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '35', 'letter-spacing': '0.0em'
    });
  }

  function drawSurfaceHeader(card) {
    if (card.iconPath) {
      image(card.iconPath, {
        x: 11, y: 14, width: 24, height: 24,
        preserveAspectRatio: 'xMidYMid meet', opacity: 1,
        style: 'filter: brightness(0) saturate(100%);'
      });
    }
    text(42, 40, card.title, {
      fill: 'rgba(8,8,8,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '40', 'letter-spacing': '0.0em'
    });
  }

  function drawCard(card, index) {
    const selected = index === selectedIndex;
    const layout = cardLayout(index);
    const showStackIcon = !selected;
    const group = mk('g', {
      transform: `translate(${layout.x},${layout.y}) scale(${layout.scale})`,
      opacity: String(layout.opacity), tabindex: '0', role: 'button',
      'aria-label': `${card.title} ${card.role}`,
      'data-card-index': index
    });

    const rect = mk('rect', {
      x: 0, y: 0, width: 150, height: 150, rx: 20, ry: 20,
      fill: card.color,
      stroke: selected ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)',
      'stroke-width': selected ? 1 : 0.8, 'stroke-opacity': 1
    }, group);

    if (selected) {
      drawCardIcon(card, true, group);
      text(18, 78, card.title, {
        fill: 'rgba(8,8,8,0.98)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '22'
      }, group);
      // Role text — NO hint text anymore
      const displayRole = lower(card.roleShort || card.role);
      const words = displayRole.split(/\s+/);
      const firstLine = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      const secondLine = words.slice(Math.ceil(words.length / 2)).join(' ');
      text(18, 101, firstLine, {
        fill: 'rgba(8,8,0,0.74)',
        'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12'
      }, group);
      if (secondLine) {
        text(18, 116, secondLine, {
          fill: 'rgba(8,8,8,0.74)',
          'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12'
        }, group);
      }

      // Notification dots
      const project = getProjectMemory();
      const pendingCount = (project?.pending_decisions || []).length;
      const questionCount = (project?.open_questions || []).length;
      if (pendingCount > 0 && card.id === 'now') {
        const dot = mk('circle', { cx: 138, cy: 18, r: 5, fill: '#ff8a65', opacity: '0.9' }, group);
        mk('animate', { attributeName: 'r', values: '4;7;4', dur: '1.2s', repeatCount: 'indefinite' }, dot);
        mk('animate', { attributeName: 'opacity', values: '0.5;1;0.5', dur: '1.2s', repeatCount: 'indefinite' }, dot);
      }
      if (questionCount > 0 && card.id === 'know') {
        const dot = mk('circle', { cx: 138, cy: 18, r: 5, fill: '#f8c15d', opacity: '0.9' }, group);
        mk('animate', { attributeName: 'r', values: '4;7;4', dur: '1.2s', repeatCount: 'indefinite' }, dot);
        mk('animate', { attributeName: 'opacity', values: '0.5;1;0.5', dur: '1.2s', repeatCount: 'indefinite' }, dot);
      }
    } else if (showStackIcon) {
      if (card.iconPath) {
        image(card.iconPath, {
          x: 18, y: 18, width: 30, height: 30,
          preserveAspectRatio: 'xMidYMid meet', opacity: 1,
          style: 'filter: brightness(0) saturate(100%);'
        }, group);
      } else {
        text(18, 42, card.iconFallback || '•', {
          fill: 'rgba(8,8,8,0.96)',
          'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '28'
        }, group);
      }
      // Stack notification dots
      const project = getProjectMemory();
      if (card.id === 'now' && (project?.pending_decisions || []).length > 0) {
        const dot = mk('circle', { cx: 130, cy: 18, r: 4, fill: '#ff8a65', opacity: '0.8' }, group);
        mk('animate', { attributeName: 'opacity', values: '0.4;0.9;0.4', dur: '1.2s', repeatCount: 'indefinite' }, dot);
      }
      if (card.id === 'know' && (project?.open_questions || []).length > 0) {
        const dot = mk('circle', { cx: 130, cy: 18, r: 4, fill: '#f8c15d', opacity: '0.8' }, group);
        mk('animate', { attributeName: 'opacity', values: '0.4;0.9;0.4', dur: '1.2s', repeatCount: 'indefinite' }, dot);
      }
    }

    const activate = event => {
      event.preventDefault();
      if (selected && isHome()) openCard(card);
      else if (isHome()) selectIndex(index);
    };

    group.addEventListener('pointerup', activate);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });

    return { group, rect };
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
    const words = lower(content).split(/\s+/);
    let line = '';
    let row = 0;
    _measureCtx.font = `${fontSize}px PowerGrotesk-Regular`;
    words.forEach(word => {
      const test = line ? `${line} ${word}` : word;
      if (_measureCtx.measureText(test).width > width && line) {
        text(x, y + row * lineHeight, line, { fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': fontSize }, parent);
        line = word;
        row += 1;
      } else {
        line = test;
      }
    });
    if (line) text(x, y + row * lineHeight, line, { fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': fontSize }, parent);
  }

  function buildShowSummary() {
    const captures = getCaptureList();
    const project = getProjectMemory();
    const safeIndex = captures.length
      ? Math.max(0, Math.min(typeof stateData.showCaptureIndex === 'number' ? stateData.showCaptureIndex : captures.length - 1, captures.length - 1))
      : 0;
    stateData.showCaptureIndex = safeIndex;
    const current = captures[safeIndex] || null;
    return {
      title: project?.name || 'untitled project',
      captures,
      current,
      currentIndex: safeIndex,
      insights: (project?.insights || []).length,
      status: stateData.showStatus || (captures.length ? 'ready for another frame' : 'tap to start'),
      summary: current ? getCaptureSummary(current) : 'no captures yet',
      imageHref: current ? getCaptureImageHref(current) : '',
      createdAt: current?.captured_at || current?.created_at || current?.meta?.captured_at || null
    };
  }

  function drawShowSurface() {
    if (currentState !== STATES.SHOW_BROWSE) return;
    const showCard = cards.find(c => c.id === 'show');
    const model = buildShowSummary();

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: showCard.color });
    drawSurfaceHeader(showCard);
    text(14, 60, lower(model.title), {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12'
    });

    const cameraButton = mk('g', { style: 'cursor: pointer;' });
    mk('rect', { x: 14, y: 72, width: 212, height: 26, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.90)' }, cameraButton);
    text(24, 89, 'open camera', {
      fill: 'rgba(244,239,228,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12'
    }, cameraButton);
    text(216, 89, model.captures.length ? `${model.captures.length} saved` : 'start', {
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

    mk('rect', { x: 14, y: 106, width: 212, height: 100, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.14)' });
    if (model.imageHref) {
      image(model.imageHref, {
        x: 14, y: 106, width: 212, height: 100, preserveAspectRatio: 'xMidYMid slice', opacity: 1
      });
      mk('rect', { x: 14, y: 174, width: 212, height: 32, fill: 'rgba(5,5,5,0.54)' });
      text(22, 188, 'latest frame', {
        fill: 'rgba(244,239,228,0.58)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      wrapText(undefined, model.summary.slice(0, 52), 22, 200, 190, 11, 'rgba(244,239,228,0.92)', '10');
    } else {
      text(14, 142, 'no captures yet', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '18'
      });
      wrapText(undefined, 'open camera to capture the first visual reference for this project', 14, 162, 196, 14, 'rgba(8,8,8,0.62)', '12');
    }

    const thumbY = 212;
    const recent = model.captures.slice().reverse().slice(0, 3);
    recent.forEach((capture, i) => {
      const x = i * 80;
      const href = getCaptureImageHref(capture);
      const active = capture === model.current;
      mk('rect', { x, y: thumbY, width: 80, height: 80, fill: active ? 'rgba(8,8,8,0.18)' : 'rgba(8,8,8,0.10)' });
      if (href) {
        image(href, { x, y: thumbY, width: 80, height: 80, preserveAspectRatio: 'xMidYMid slice', opacity: active ? 1 : 0.68 });
      }
      if (active) {
        mk('rect', { x, y: thumbY, width: 80, height: 80, fill: 'rgba(8,8,8,0.01)', stroke: 'rgba(244,239,228,0.38)', 'stroke-width': 2 });
      }
      const thumbTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', { x, y: thumbY, width: 80, height: 80, fill: 'transparent' }, thumbTap);
      thumbTap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        const absoluteIndex = model.captures.indexOf(capture);
        stateData.showCaptureIndex = absoluteIndex >= 0 ? absoluteIndex : 0;
        stateData.showStatus = 'latest visual memory';
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
      title: project?.name || 'untitled project',
      entries,
      current,
      currentIndex: safeIndex,
      insights: (project?.insights || []).length,
      questions: (project?.open_questions || []).length,
      status: stateData.tellStatus || (entries.length ? 'hold to speak' : 'hold to record')
    };
  }

  function drawTellSurface() {
    if (currentState !== STATES.TELL_BROWSE) return;
    const tellCard = cards.find(c => c.id === 'tell');
    const model = buildTellModel();

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: tellCard.color });
    drawSurfaceHeader(tellCard);
    text(14, 60, lower(model.title), {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12'
    });

    const actionBar = mk('g', { style: 'cursor: pointer;' });
    mk('rect', { x: 14, y: 72, width: 212, height: 26, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.90)' }, actionBar);
    text(24, 89, 'hold to speak', {
      fill: 'rgba(244,239,228,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '12'
    }, actionBar);
    text(216, 89, model.entries.length ? `${model.entries.length} saved` : 'new', {
      fill: 'rgba(244,239,228,0.58)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10',
      'text-anchor': 'end'
    }, actionBar);
    actionBar.addEventListener('pointerup', event => {
      event.preventDefault();
      event.stopPropagation();
      openTellSurface({ returnState: STATES.TELL_BROWSE, tellStatus: 'ready to listen' });
    });

    mk('rect', { x: 14, y: 106, width: 212, height: 78, rx: 8, ry: 8, fill: 'rgba(8,8,8,0.14)' });
    if (model.current) {
      text(20, 122, 'latest voice', {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
      wrapText(undefined, lower(model.current.body || model.current.title || 'voice saved').slice(0, 118), 20, 140, 184, 13, 'rgba(8,8,8,0.96)', '13');
    } else {
      text(20, 136, 'no voice yet', {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '18'
      });
      wrapText(undefined, 'hold the side button to save the first spoken update for this project', 20, 154, 184, 13, 'rgba(8,8,8,0.60)', '11');
    }

    const visible = model.entries.slice(0, 3);
    visible.forEach((entry, index) => {
      const y = 192 + (index * 30);
      const selected = index === model.currentIndex;
      const rowTap = mk('g', { style: 'cursor: pointer;' });
      mk('rect', {
        x: 14,
        y,
        width: 212,
        height: 24,
        rx: 6,
        ry: 6,
        fill: selected ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.12)'
      }, rowTap);
      text(22, y + 14, lower((entry.body || entry.title || 'voice entry').slice(0, 34)), {
        fill: selected ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.92)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '11'
      }, rowTap);
      text(216, y + 14, lower(new Date(entry.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), {
        fill: selected ? 'rgba(244,239,228,0.60)' : 'rgba(8,8,8,0.52)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '9',
        'text-anchor': 'end'
      }, rowTap);
      rowTap.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        stateData.tellEntryIndex = index;
        stateData.tellStatus = 'latest voice saved';
        render();
      });
    });

    text(14, 284, `${model.entries.length} voice · ${model.insights} insights · ${model.questions} asks · ${lower(model.status)}`, {
      fill: 'rgba(8,8,8,0.42)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10'
    });
  }

  // === NOW panel render ===
  // Clean hierarchy: project name -> latest change -> pending decision -> stats
  function drawNowPanel() {
    if (currentState !== STATES.NOW_BROWSE) return;
    const data = buildNowSummary();
    const nowCard = cards.find(c => c.id === 'now');

    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: nowCard.color });
    drawSurfaceHeader(nowCard);
    text(14, 60, lower(data.title), { fill: 'rgba(8,8,8,0.50)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12' });

    const chainY = 78;
    const phaseLabel = {
      observe: 'observing',
      research: 'researching',
      evaluate: 'evaluating',
      decision: 'deciding',
      cooldown: 'cooling down',
      idle: 'idle'
    }[data.chainPhase] || data.chainPhase;

    text(14, chainY + 8, phaseLabel, {
      fill: 'rgba(8,8,8,0.56)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '11'
    });

    if (data.lastImpact) {
      wrapText(undefined, lower(String(data.lastImpact.output).slice(0, 54)), 14, chainY + 24, 212, 14, 'rgba(8,8,8,0.96)', '13');
    } else if (data.storedImpacts.length > 0) {
      wrapText(undefined, lower(String(data.storedImpacts[0].output || data.storedImpacts[0].type).slice(0, 54)), 14, chainY + 24, 212, 14, 'rgba(8,8,8,0.72)', '12');
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

      const boxY = 136;
      const boxH = pdOptions.length >= 2 ? 132 : 96;
      mk('rect', { x: 10, y: boxY, width: 220, height: boxH, rx: 8, fill: 'rgba(8,8,8,0.12)' });

      const countLabel = pdCount > 1 ? ` (${data.pendingDecisionIndex + 1}/${pdCount})` : '';
      text(18, boxY + 16, 'decision arena' + countLabel, {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });

      const displayText = pdText.length > 52 ? pdText.slice(0, 51) + '…' : pdText;
      wrapText(undefined, lower(displayText), 18, boxY + 34, 190, 14, 'rgba(8,8,8,0.96)', '14');

      if (pdOptions.length >= 2) {
        const slabY = boxY + 56;
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

      const ctrlY = boxY + boxH - 26;
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
    } else {
      drawSectionLabel(undefined, 14, 146, 'next move');
      wrapText(undefined, lower(data.next), 14, 162, 212, 14, 'rgba(8,8,8,0.96)', '14');
      if (data.totalImpacts > 0) {
        text(14, 184, `${data.totalImpacts} impacts · ${data.totalDecisions} chain decisions`, {
          fill: 'rgba(8,8,8,0.36)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '9'
        });
      }
    }

    text(14, 282, `${data.captures} caps · ${data.insights} insights · ${data.openQuestions} asks · ${data.decisions} done`, {
      fill: 'rgba(8,8,8,0.36)',
      'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10'
    });
  }

  // === KNOW insight surface render ===
  // === KNOW insight surface render ===
  // Redesigned: touchable lane tabs + filter chips, content directly visible below,
  // scrollable with wheel. No PTT needed to browse content.
  function drawInsightSurface() {
    if (currentState !== STATES.KNOW_BROWSE && currentState !== STATES.KNOW_DETAIL) return;
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

    // Touchable lane tabs
    const laneTabs = [
      { id: 'questions', label: 'asks', width: 44 },
      { id: 'signals', label: 'signals', width: 52 },
      { id: 'decisions', label: 'decided', width: 52 },
      { id: 'open loops', label: 'loops', width: 42 }
    ];
    let tabX = 14;
    laneTabs.forEach((tab, i) => {
      const isActive = lane.id === tab.id;
      const pillGroup = mk('g', { 'data-lane-index': i, style: 'cursor: pointer;' });
      mk('rect', {
        x: tabX, y: 52, width: tab.width, height: 22, rx: 6, ry: 6,
        fill: isActive ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.10)',
        stroke: isActive ? 'rgba(8,8,8,0.06)' : 'rgba(8,8,8,0.04)',
        'stroke-width': 1
      }, pillGroup);
      const tabText = mk('text', {
        x: tabX + tab.width / 2, y: 52 + 22 / 2 + 4,
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
    const chipY = 80;
    let chipX = 14;
    const activeChips = model.chips.filter((c, i) => availableChipIndexes.includes(i));
    activeChips.forEach((c) => {
      const realIndex = model.chips.indexOf(c);
      const isActive = realIndex === safeChipIdx;
      const chipWidth = Math.max(40, c.label.length * 7 + 16);
      const chipGroup = mk('g', { 'data-chip-index': realIndex, style: 'cursor: pointer;' });
      mk('rect', {
        x: chipX, y: chipY, width: chipWidth, height: 18, rx: 4, ry: 4,
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

    // Result count
    text(226, chipY + 13, String(items.length), {
      fill: 'rgba(8,8,8,0.40)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10', 'text-anchor': 'end'
    });

    // Content area - directly below chips, no PTT needed
    const contentY = 108;

    if (currentState === STATES.KNOW_BROWSE) {
      // Item title
      text(14, contentY, lower(item.title), {
        fill: 'rgba(8,8,8,0.96)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '16'
      });

      // Date
      text(226, contentY - 1, formatTimeLabel(item.created_at), {
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
      text(14, contentY + 14, contextLabel, {
        fill: 'rgba(8,8,8,0.40)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });

      // Item body
      wrapText(undefined, lower(item.body), 14, contentY + 32, 212, 13, 'rgba(8,8,8,0.85)', '12');

      // Next move bar
      const actionY = 240;
      mk('rect', { x: 0, y: actionY - 8, width: 240, height: 44, fill: 'rgba(8,8,8,0.04)' });
      text(14, actionY, '→', {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      });
      wrapText(undefined, lower(item.next), 26, actionY, 200, 13, 'rgba(8,8,8,0.70)', '11');

      // Scroll hint
      if (items.length > 1) {
        text(14, 280, (itemIdx + 1) + '/' + items.length + ' · scroll or tap detail', {
          fill: 'rgba(8,8,8,0.32)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '9'
        });
      }

      // Touchable content area - tap opens detail
      const contentGroup = mk('g', { style: 'cursor: pointer;' });
      mk('rect', { x: 0, y: contentY - 16, width: 240, height: 220, fill: 'transparent' }, contentGroup);
      contentGroup.addEventListener('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        transition(STATES.KNOW_DETAIL);
      });
      return;
    }

    // KNOW_DETAIL - expanded view
    text(14, contentY, lower(item.title), {
      fill: 'rgba(8,8,8,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '16'
    });
    text(226, contentY - 1, formatTimeLabel(item.created_at), {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '10', 'text-anchor': 'end'
    });

    const detailSection = item.source === 'question' ? 'the question' : 'detail';
    drawSectionLabel(undefined, 14, contentY + 16, detailSection);
    wrapText(undefined, lower(item.body), 14, contentY + 32, 212, 14, 'rgba(8,8,8,0.90)', '13');

    if (item.source === 'question') {
      const actionY = 242;
      mk('rect', { x: 10, y: actionY - 6, width: 220, height: 26, rx: 6, ry: 6, fill: 'rgba(8,8,8,0.12)' });
      drawSquaredPill(18, actionY, 96, 14, 'side → answer', true, 'light');
      text(136, actionY + 11, 'speak your answer', {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
      });
    } else {
      drawSectionLabel(undefined, 14, 246, 'next move');
      wrapText(undefined, lower(item.next), 14, 262, 212, 13, 'rgba(8,8,8,0.96)', '13');
    }
  }

  // === Main render ===
  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawWordmark();

    const surface = activeSurface();

    if (surface === 'home') {
      cards
        .map((card, index) => ({ card, index, layout: cardLayout(index) }))
        .sort((a, b) => {
          if (a.layout.depth === -1) return 1;
          if (b.layout.depth === -1) return -1;
          return a.layout.depth - b.layout.depth;
        })
        .forEach(({ card, index }) => drawCard(card, index));
    }

    drawShowSurface();
    drawTellSurface();
    drawNowPanel();
    drawInsightSurface();

    const isContentSurface = surface === 'project' || surface === 'insight' || surface === 'show' || surface === 'tell';
    logDrawer.style.display = isContentSurface ? 'none' : '';
  }

  // === Input handlers (all routed through state machine) ===

  function handleScrollDirection(direction) {
    switch (currentState) {
      case STATES.SHOW_BROWSE: {
        const captures = getCaptureList();
        if (!captures.length) break;
        const max = captures.length;
        stateData.showCaptureIndex = ((stateData.showCaptureIndex || 0) + (direction > 0 ? 1 : -1) + max) % max;
        stateData.showStatus = 'scroll to review captures';
        render();
        break;
      }

      case STATES.TELL_BROWSE: {
        const entries = getVoiceEntries();
        if (!entries.length) break;
        const max = entries.length;
        stateData.tellEntryIndex = ((stateData.tellEntryIndex || 0) + (direction > 0 ? 1 : -1) + max) % max;
        stateData.tellStatus = 'scroll to review voice';
        render();
        break;
      }

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
        if (!model.lanes.length) break;
        stateData.knowLaneIndex = (stateData.knowLaneIndex + (direction > 0 ? 1 : -1) + model.lanes.length) % model.lanes.length;
        stateData.knowItemIndex = 0;
        const lane = model.lanes[stateData.knowLaneIndex];
        const activeChip = model.chips[stateData.knowChipIndex]?.id;
        const hasChipItems = lane?.items?.some(item => item.chips.includes(activeChip));
        if (!hasChipItems) stateData.knowChipIndex = lane?.availableChipIndexes?.[0] ?? 0;
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
        } else {
          goHome();
        }
        break;
      }

      case STATES.LOG_OPEN: {
        const delta = direction > 0 ? 28 : -28;
        log.scrollTop += delta;
        break;
      }

      case STATES.HOME:
      case STATES.LOG_OPEN:
        if (currentState === STATES.HOME) {
          selectIndex(selectedIndex + (direction > 0 ? 1 : -1));
        } else if (currentState === STATES.LOG_OPEN) {
          const delta = direction > 0 ? 28 : -28;
          log.scrollTop += delta;
        }
        break;

      default:
        break;
    }
  }

  function handleSideClick() {
    switch (currentState) {
      case STATES.SHOW_BROWSE:
        openCameraFromShow('hardware');
        break;

      case STATES.TELL_BROWSE:
        openTellSurface({ returnState: STATES.TELL_BROWSE, tellStatus: 'ready to listen' });
        break;

      case STATES.CAMERA_OPEN:
        // Side = capture
        transition(STATES.CAMERA_CAPTURE);
        break;

      case STATES.VOICE_OPEN:
        if (!window.StructaVoice?.listening) goHome();
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
        transition(STATES.KNOW_BROWSE);
        break;
      }

      case STATES.NOW_BROWSE: {
        if (approveCurrentNowDecision()) return;
        openNowNextMove();
        break;
      }

      case STATES.LOG_OPEN:
        transition(STATES.HOME);
        break;

      case STATES.HOME:
        openCard(currentCard());
        break;

      default:
        break;
    }
  }

  function handleLongPressStart() {
    switch (currentState) {
      case STATES.HOME: {
        const card = currentCard();
        if (card.id === 'show') {
          transition(STATES.SHOW_BROWSE, { showStatus: 'tap to start' });
        } else if (card.id === 'tell') {
          // PTT on TELL = direct voice open
          voiceReturnState = STATES.TELL_BROWSE;
          transition(STATES.VOICE_OPEN, { fromPTT: true, tellStatus: 'listening' });
        }
        break;
      }

      case STATES.TELL_BROWSE:
        voiceReturnState = STATES.TELL_BROWSE;
        transition(STATES.VOICE_OPEN, { fromPTT: true, tellStatus: 'listening' });
        break;

      case STATES.CAMERA_OPEN:
        // PTT while camera is open = capture
        transition(STATES.CAMERA_CAPTURE);
        break;

      case STATES.VOICE_OPEN:
        // PTT while voice is already open — no-op
        document.body.classList.add('input-locked');
        window.StructaVoice?.startListening?.();
        break;

      case STATES.LOG_OPEN:
        // Long press in log = export
        exportLogsFromHardware();
        break;

      default:
        break;
    }
  }

  function handleLongPressEnd() {
    document.body.classList.remove('input-locked');

    switch (currentState) {
      case STATES.CAMERA_OPEN:
        // PTT released on camera open = capture (handled by state entry)
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
    const prev = currentState;
    transition(STATES.HOME);
  }

  function handleNativeBack(event) {
    switch (currentState) {
      case STATES.SHOW_BROWSE:
        if (event) event.preventDefault?.();
        goHome();
        return;

      case STATES.TELL_BROWSE:
        if (event) event.preventDefault?.();
        goHome();
        return;

      case STATES.NOW_BROWSE: {
        const project = getProjectMemory();
        const pending = project?.pending_decisions || [];
        if (pending.length && stateData.decisionIndex < pending.length) {
          native?.dismissPendingDecision?.(stateData.decisionIndex);
          pushLog('decision skipped', 'decision');
          stateData.decisionIndex = 0;
          render();
          if (event) event.preventDefault?.();
          return;
        }
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
  });

  window.addEventListener('structa-camera-close', () => {
    if (currentState === STATES.CAMERA_OPEN || currentState === STATES.CAMERA_CAPTURE) {
      const returnState = cameraReturnState;
      cameraReturnState = STATES.HOME;
      transition(returnState === STATES.SHOW_BROWSE ? STATES.SHOW_BROWSE : STATES.HOME, {
        showStatus: 'latest visual memory'
      });
    }
    refreshLogFromMemory();
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
  });

  window.addEventListener('structa-probe-event', () => { refreshLogFromMemory(); });

  // Hardware inputs
  window.addEventListener('scrollUp', event => { event.preventDefault?.(); handleScrollDirection(-1); });
  window.addEventListener('scrollDown', event => { event.preventDefault?.(); handleScrollDirection(1); });
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

  // Shake to go home
  let lastShakeAt = 0;
  window.addEventListener('devicemotion', event => {
    const accel = event.accelerationIncludingGravity || event.acceleration;
    if (!accel) return;
    const magnitude = Math.abs(accel.x || 0) + Math.abs(accel.y || 0) + Math.abs(accel.z || 0);
    const now = Date.now();
    if (magnitude < 42 || now - lastShakeAt < 1400) return;
    lastShakeAt = now;
    if (currentState !== STATES.HOME) goHome();
  });

  // === Init ===
  const initialState = native?.getUIState?.() || {};
  selectedIndex = Math.max(0, cards.findIndex(card => card.id === (initialState.selected_card_id || 'now')));
  if (selectedIndex < 0) selectedIndex = 3;

  native?.setActiveNode?.(currentCard().id);
  native?.updateUIState?.({ selected_card_id: currentCard().id, last_surface: 'home', resumed_at: new Date().toISOString() });
  refreshLogFromMemory();
  render();
  maybeStartHeartbeat();

  // === R1 API probe (silent) ===
  (function probeR1APIs() {
    const bridges = ['PluginMessageHandler', 'onPluginMessage', 'Android', 'rabbit', 'Rabbit',
      'creationStorage', '__RABBIT_DEVICE_ID__'];
    bridges.forEach(name => {
      const val = window[name];
      if (val === undefined) return;
      if (typeof val === 'object' && val !== null) {
        const methods = [];
        const props = [];
        try { Object.getOwnPropertyNames(val).forEach(k => {
          try { (typeof val[k] === 'function' ? methods : props).push(k); } catch(e) {}
        }); } catch(e) {}
        native?.appendLogEntry?.({ kind: 'probe', message: `${name}: m=[${methods.slice(0,6).join(',')}] p=[${props.slice(0,4).join(',')}]` });
      } else {
        native?.appendLogEntry?.({ kind: 'probe', message: `${name}: ${typeof val}` });
      }
    });
    native?.appendLogEntry?.({ kind: 'probe', message: `viewport: ${window.innerWidth}x${window.innerHeight}` });
    native?.appendLogEntry?.({ kind: 'probe', message: `screen: ${screen.width}x${screen.height}` });
  })();

  // Prime camera on first touch
  let cameraPrimed = false;
  function primeCameraOnFirstTouch() {
    if (cameraPrimed) return;
    cameraPrimed = true;
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { max: 640 }, height: { max: 480 } } })
        .then(stream => { window.__STRUCTA_PRIMED_STREAM__ = stream; })
        .catch(() => {});
    }
  }
  svg.addEventListener('pointerup', () => primeCameraOnFirstTouch(), { once: true });

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
      research: 'res',
      evaluate: 'eval',
      decision: 'dec',
      cooldown: 'cool'
    };
    phaseText.textContent = labels[chain.phase] || chain.phase;
  }

  // Re-render NOW panel on each impact
  window.addEventListener('structa-impact', function() {
    updateChainBadge();
    if (currentState === STATES.NOW_BROWSE) render();
  });

  // Show spring notification when decision created
  window.addEventListener('structa-decision-created', function(e) {
    updateChainBadge();
    notifyCard('now', 'urgent');
    if (currentState === STATES.NOW_BROWSE) render();
  });

  // Start chain after first user interaction
  let chainStarted = false;
  function startChainOnInteraction() {
    if (chainStarted) return;
    chainStarted = true;
    if (window.StructaImpactChain && !window.StructaImpactChain.active) {
      window.StructaImpactChain.start(4); // 4bpm = every 15s
    }
  }
  ['sideClick', 'pointerup', 'scrollUp', 'scrollDown'].forEach(function(evt) {
    window.addEventListener(evt, startChainOnInteraction, { once: true });
  });

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
