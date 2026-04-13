(() => {
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const logDrawer = document.getElementById('log-drawer');
  const logHandle = document.getElementById('log-handle');
  const logPreview = document.getElementById('log-preview');
  const native = window.StructaNative;
  const router = window.StructaActionRouter;
  const projectCode = window.StructaContracts?.baseProjectCode || 'prj-structa-r1';

  const cards = [
    { id: 'show', title: 'show', iconPath: 'assets/icons/png/4.png', iconFallback: '▣', role: 'capture image', roleShort: 'capture image', color: 'var(--show)', surface: 'camera' },
    { id: 'tell', title: 'tell', iconPath: 'assets/icons/png/3.png', iconFallback: '◉', role: 'capture commands', roleShort: 'speak update', color: 'var(--tell)', surface: 'voice' },
    { id: 'know', title: 'know', iconPath: 'assets/icons/png/7.png', iconFallback: '◈', role: 'generate insights', roleShort: 'find signal', color: 'var(--know)', surface: 'insight' },
    { id: 'now', title: 'now', iconPath: 'assets/icons/png/6.png', iconFallback: '▣', role: 'project structure', roleShort: 'catch up fast', color: 'var(--now)', surface: 'project' }
  ];

  const initialState = native?.getUIState?.() || {};
  window.__STRUCTA_PTT_TARGET__ = window.__STRUCTA_PTT_TARGET__ || null;
  let selectedIndex = Math.max(0, cards.findIndex(card => card.id === (initialState.selected_card_id || 'now')));
  if (selectedIndex < 0) selectedIndex = 3;
  let logOpen = false;
  let activeSurface = 'home';
  let knowLaneIndex = 0;
  let knowItemIndex = 0;
  let knowChipIndex = 0;
  let knowDetail = false;
  let queuedIndex = null;
  let queuedDirection = 0;

  // Hint mode state for instant PTT activation
  let hintMode = false;
  let hintTarget = null;
  let pttActive = false;

  // Decision navigation in NOW card
  let decisionIndex = 0;

  // Question answering mode (from KNOW card)
  let answeringQuestion = null; // { index, text } when actively answering

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
  }

  function lower(text = '') {
    return String(text || '').toLowerCase();
  }

  // Hint mode management
  function enterHintMode(target) {
    hintMode = true;
    hintTarget = target;
    render();
  }

  function exitHintMode() {
    if (!hintMode) return;
    if (hintTarget === 'show' && window.StructaCamera?.primed) {
      window.StructaCamera?.close?.();
    }
    hintMode = false;
    hintTarget = null;
    pttActive = false;
    window.__STRUCTA_PTT_TARGET__ = null;
    document.body.classList.remove('input-locked');
    render();
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

  function latestLogText() {
    const row = log.lastElementChild;
    return row ? lower(row.textContent || '') : 'no logs yet';
  }

  function pushLog(text, strong = '') {
    // Check if this would be visible — skip DOM noise
    const wouldBeVisible = native?.isVisibleLogEntry?.({ kind: lower(strong || 'ui'), message: lower(`${strong ? `${strong} ` : ''}${text}`) });
    if (wouldBeVisible === false) {
      // Store in memory but don't show in DOM
      native?.appendLogEntry?.({ kind: 'ui', message: lower(`${strong ? `${strong} ` : ''}${text}`) });
      return;
    }
    const row = document.createElement('div');
    row.className = 'entry';
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

  function enterSurface(surface) {
    activeSurface = surface;
    setLogDrawer(false);
    if (surface === 'home') {
      document.title = 'structa';
    } else if (surface === 'project') {
      document.title = 'stack';
    } else if (surface === 'insight') {
      document.title = 'stack';
    } else if (surface === 'camera') {
      document.title = 'show';
    } else if (surface === 'voice') {
      document.title = 'tell';
    }
  }

  function openCameraSurface(source = 'touch') {
    queuedIndex = null;
    queuedDirection = 0;
    window.__STRUCTA_PTT_TARGET__ = source === 'ptt' ? 'camera' : null;
    native?.setActiveNode?.('show');
    native?.updateUIState?.({ selected_card_id: 'show', last_surface: 'camera' });
    window.StructaVoice?.close?.();

    if (source === 'ptt') {
      document.getElementById('app')?.classList.add('overlay-active');
      var overlay = document.getElementById('camera-overlay');
      overlay?.classList.add('open');
      overlay?.setAttribute('aria-hidden', 'false');
      overlay?.classList.add('touch-activate');
      return;
    }

    window.StructaCamera?.openFromGesture?.();
  }

  function openVoiceSurface(source = 'touch', questionContext) {
    queuedIndex = null;
    queuedDirection = 0;
    window.__STRUCTA_PTT_TARGET__ = 'voice';
    native?.setActiveNode?.('tell');
    native?.updateUIState?.({ selected_card_id: 'tell', last_surface: 'voice' });
    activeSurface = 'voice';
    render();
    if (source === 'ptt') window.StructaVoice?.startListening?.();
    else window.StructaVoice?.open?.();
  }

  /**
   * openVoiceForAnswer -- opens voice to answer a specific question from KNOW card.
   * Uses the SAME green tell overlay as normal voice — no special yellow mode.
   * PTT hold/release works identical to tell card.
   */
  function openVoiceForAnswer(questionIndex, questionText) {
    answeringQuestion = { index: questionIndex, text: questionText };
    // Set answer context on voice module so handleTranscript routes correctly
    if (window.StructaVoice?.setQuestionContext) {
      window.StructaVoice.setQuestionContext(questionIndex, questionText);
    }
    native?.appendLogEntry?.({ kind: 'voice', message: 'answering: ' + questionText.slice(0, 40) });
    // Use the same voice surface as tell card — same overlay, same PTT flow
    openVoiceSurface('touch');
  }

  function openCard(card) {
    queuedIndex = null;
    queuedDirection = 0;

    if (hintMode && !(card.id === 'show' || card.id === 'tell')) {
      exitHintMode();
    }

    if (activeSurface === 'home' && (card.id === 'show' || card.id === 'tell')) {
      enterHintMode(card.id);
      return;
    }

    native?.setActiveNode?.(card.id);
    native?.updateUIState?.({ selected_card_id: card.id, last_surface: card.surface || 'home' });
    pushLog(`${card.title} ready`, 'focus');
    if (card.surface === 'camera') {
      openCameraSurface('touch');
      return;
    }
    if (card.surface === 'voice') {
      openVoiceSurface('touch');
      return;
    }
    if (card.surface === 'insight') {
      activeSurface = 'insight';
      knowLaneIndex = 0;
      knowItemIndex = 0;
      knowChipIndex = 0;
      knowDetail = false;
      render();
      return;
    }
    if (card.surface === 'project') {
      activeSurface = 'project';
      decisionIndex = 0;
      render();
      return;
    }
  }

  function exportLogsFromHardware() {
    const result = native?.exportLatestLogs?.(33);
    pushLog(result?.ok ? 'saved 33 logs to rabbit hole' : 'could not save logs', 'logs');
    return result;
  }

  function handleScrollDirection(direction) {
    if (activeSurface === 'camera') {
      window.StructaCamera?.flip?.();
      return;
    }
    if (activeSurface === 'voice') {
      if (!window.StructaVoice?.listening) backHome();
      return;
    }
    if (activeSurface === 'insight') {
      const model = buildKnowModel();
      if (!model.lanes.length) return;
      if (knowDetail) {
        const items = getKnowVisibleItems(model);
        if (!items.length) return;
        knowItemIndex = (knowItemIndex + (direction > 0 ? 1 : -1) + items.length) % items.length;
      } else {
        knowLaneIndex = (knowLaneIndex + (direction > 0 ? 1 : -1) + model.lanes.length) % model.lanes.length;
        knowItemIndex = 0;
        const lane = model.lanes[knowLaneIndex];
        const activeChip = model.chips[knowChipIndex]?.id;
        const hasChipItems = lane?.items?.some(item => item.chips.includes(activeChip));
        if (!hasChipItems) knowChipIndex = lane?.availableChipIndexes?.[0] ?? 0;
      }
      render();
      return;
    }
    if (activeSurface === 'project') {
      // Cycle through pending decisions on NOW card
      const project = getProjectMemory();
      const pending = project?.pending_decisions || [];
      if (pending.length > 1) {
        decisionIndex = (decisionIndex + (direction > 0 ? 1 : -1) + pending.length) % pending.length;
        render();
      } else {
        backHome();
      }
      return;
    }
    if (logOpen) {
      const delta = direction > 0 ? 28 : -28;
      log.scrollTop += delta;
      return;
    }
    selectIndex(selectedIndex + (direction > 0 ? 1 : -1));
  }

  function handleSideClick() {
    if (pttActive && hintMode) {
      return;
    }
    queuedIndex = null;
    queuedDirection = 0;
    if (activeSurface === 'camera') {
      window.StructaCamera?.capture?.();
      return;
    }
    if (activeSurface === 'voice') {
      if (!window.StructaVoice?.listening) backHome();
      return;
    }
    if (activeSurface === 'insight') {
      const model = buildKnowModel();
      if (!model.lanes.length) return;

      // If viewing a question, side button = answer it
      if (knowDetail) {
        const items = getKnowVisibleItems(model);
        const item = items[knowItemIndex];
        if (item && item.source === 'question') {
          openVoiceForAnswer(item.questionIndex, item.body);
          return;
        }
        knowDetail = false;
      } else {
        knowDetail = true;
        knowItemIndex = 0;
      }
      render();
      return;
    }
    if (activeSurface === 'project') {
      // Side button on NOW card = approve pending decision
      const project = getProjectMemory();
      const pending = project?.pending_decisions || [];
      if (pending.length && decisionIndex < pending.length) {
        native?.approvePendingDecision?.(decisionIndex);
        pushLog('decision approved', 'decision');
        decisionIndex = 0;
        render();
        return;
      }
      backHome();
      return;
    }
    if (logOpen) {
      setLogDrawer(false);
      return;
    }
    openCard(currentCard());
  }

  function handleLongPressStart() {
    if (logOpen) return;

    if (hintMode) {
      if (hintTarget === 'show') {
        window.__STRUCTA_PTT_TARGET__ = 'camera';
        window.StructaCamera?.openFromGesture?.('environment');
        pttActive = true;
        render();
        return;
      }
      if (hintTarget === 'tell') {
        window.__STRUCTA_PTT_TARGET__ = 'voice';
        document.body.classList.add('input-locked');
        window.StructaVoice?.startListening?.();
        pttActive = true;
        render();
        return;
      }
    }

    if (activeSurface === 'camera') {
      window.StructaCamera?.capture?.();
      return;
    }
    if (activeSurface === 'voice') {
      document.body.classList.add('input-locked');
      window.StructaVoice?.startListening?.();
      return;
    }
    // KNOW card long press = cycle filter chips, NOT open voice
    // This prevents the confusing auto-voice overlay on the insight surface
    const card = currentCard();
    if (card.id === 'tell') {
      openVoiceSurface('ptt');
      return;
    }
    if (card.id === 'show') {
      openCameraSurface('ptt');
      return;
    }
  }

  function handleLongPressEnd() {
    if (logOpen) {
      exportLogsFromHardware();
      return;
    }

    document.body.classList.remove('input-locked');

    if (pttActive && hintMode) {
      pttActive = false;
      if (hintTarget === 'show') {
        // Camera stays open for aiming
        return;
      }
      if (hintTarget === 'tell') {
        window.StructaVoice?.stopListening?.(true);
      }
      exitHintMode();
      window.__STRUCTA_PTT_TARGET__ = null;
      return;
    }

    window.__STRUCTA_PTT_TARGET__ = null;
    if (activeSurface === 'voice' && window.StructaVoice?.listening) {
      window.StructaVoice?.stopListening?.(true);
      return;
    }
  }

  function backHome() {
    const leavingSurface = activeSurface;
    queuedIndex = null;
    queuedDirection = 0;
    answeringQuestion = null;
    if (logOpen) {
      setLogDrawer(false);
      if (leavingSurface === 'home') return;
    }
    if (leavingSurface === 'camera') {
      window.StructaCamera?.close?.();
    }
    if (leavingSurface === 'voice') {
      window.StructaVoice?.close?.();
    }
    activeSurface = 'home';
    native?.returnHome?.();
    render();
  }

  function selectIndex(next) {
    selectedIndex = (next + cards.length) % cards.length;
    native?.setActiveNode?.(currentCard().id);
    native?.updateUIState?.({ selected_card_id: currentCard().id, last_surface: activeSurface });
    render();
  }

  // === NOW card builder (project surface) ===

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
      pendingDecisionIndex: decisionIndex
    };
  }

  // === KNOW card builder (insight surface) ===

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
      questionIndex: questionIndex
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

    // Questions lane — PROMINENT, always first
    openQuestions.slice(0, 5).forEach((question, index) => {
      questions.push(makeItem({
        lane: 'questions',
        title: `question ${index + 1}`,
        body: question,
        next: 'side = answer this now',
        created_at: new Date().toISOString(),
        source: 'question',
        chips: ['asks'],
        questionIndex: index
      }));
    });

    if (!questions.length) {
      questions.push(makeItem({
        lane: 'questions',
        title: 'all clear',
        body: 'no open questions right now',
        next: 'use tell to add something that needs an answer',
        created_at: new Date().toISOString(),
        source: 'empty',
        chips: ['latest']
      }));
    }

    // Signals
    if (ui.last_insight_summary || ui.last_capture_summary) {
      signals.push(makeItem({
        lane: 'signals',
        title: 'latest signal',
        body: ui.last_insight_summary || ui.last_capture_summary,
        next: backlog[0]?.title || 'open now or tell to keep momentum',
        created_at: new Date().toISOString(),
        source: 'ui',
        chips: ['latest', 'next']
      }));
    }

    insights.slice(0, 4).forEach((insight, index) => {
      signals.push(makeItem({
        lane: 'signals',
        title: insight.title || `signal ${index + 1}`,
        body: insight.body || 'captured insight',
        next: backlog[0]?.title || 'capture the next concrete task with tell',
        created_at: insight.created_at,
        source: 'insight',
        chips: index < 2 ? ['latest'] : []
      }));
    });

    captures.slice(-4).reverse().forEach((capture, index) => {
      signals.push(makeItem({
        lane: 'signals',
        title: capture.type === 'image' ? 'visual capture' : 'recent capture',
        body: capture.summary || 'capture stored',
        next: backlog[0]?.title || 'review the capture and decide the next move',
        created_at: capture.created_at,
        source: capture.type === 'image' ? 'capture-image' : 'capture',
        chips: index < 2 ? ['latest'] : []
      }));
    });

    // Decisions
    decisions.slice(0, 5).forEach((decision, index) => {
      const decisionTitle = typeof decision === 'string' ? decision : (decision.title || `decision ${index + 1}`);
      const decisionBody = typeof decision === 'string' ? decision : (decision.body || decision.reason || 'decision recorded');
      decisionsLane.push(makeItem({
        lane: 'decisions',
        title: decisionTitle,
        body: decisionBody,
        next: backlog[0]?.title || 'act on the decision',
        created_at: decision.created_at,
        source: 'decision',
        chips: index === 0 ? ['latest'] : []
      }));
    });

    if (!decisionsLane.length) {
      decisionsLane.push(makeItem({
        lane: 'decisions',
        title: 'no locked decisions',
        body: 'use tell to state a decision — it will appear here once approved',
        next: backlog[0]?.title || 'speak a clear decision with tell',
        created_at: new Date().toISOString(),
        source: 'decision-gap',
        chips: []
      }));
    }

    // Loops (backlog only — questions moved to their own lane)
    backlog.slice(0, 5).forEach((item, index) => {
      loops.push(makeItem({
        lane: 'open loops',
        title: item.title || `open loop ${index + 1}`,
        body: item.body || item.state || 'still open',
        next: item.title || 'move this loop forward with tell',
        created_at: item.created_at,
        source: 'backlog',
        chips: ['next']
      }));
    });

    const lanes = [
      {
        id: 'questions',
        label: 'asks',
        summary: 'questions waiting for an answer',
        emptyTitle: 'all clear',
        emptyBody: 'no open questions',
        emptyNext: 'use tell to add something that needs an answer',
        items: questions
      },
      {
        id: 'signals',
        label: 'signals',
        summary: 'what changed and why it matters',
        emptyTitle: 'no signals yet',
        emptyBody: 'capture something with show or tell',
        emptyNext: 'use tell to add one update',
        items: signals.length ? signals : [makeItem({
          lane: 'signals', title: 'no signals yet', body: 'capture something with show or tell',
          next: 'use tell to add one update', created_at: new Date().toISOString(), source: 'empty', chips: ['latest']
        })]
      },
      {
        id: 'decisions',
        label: 'decided',
        summary: 'what is locked and ready to act on',
        emptyTitle: 'no decisions yet',
        emptyBody: 'speak a decision with tell — approve it in now',
        emptyNext: 'use tell to state a decision',
        items: decisionsLane
      },
      {
        id: 'open loops',
        label: 'loops',
        summary: 'unresolved tasks and items',
        emptyTitle: 'no open loops',
        emptyBody: 'this project has no open loops',
        emptyNext: 'capture the next question or task',
        items: loops.length ? loops : [makeItem({
          lane: 'open loops', title: 'no open loops', body: 'clean slate',
          next: 'capture the next task', created_at: new Date().toISOString(), source: 'empty', chips: []
        })]
      }
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
    const lane = model.lanes[knowLaneIndex] || model.lanes[0];
    if (!lane) return [];
    const chipId = model.chips[knowChipIndex]?.id || model.chips[0]?.id;
    const filtered = lane.items.filter(item => item.chips.includes(chipId));
    return filtered.length ? filtered : lane.items;
  }

  // === SVG rendering ===

  function cardLayout(index) {
    if (index === selectedIndex) return { x: 120, y: 48, scale: 1.5, opacity: 1, depth: -1 };
    const depth = ((selectedIndex - index - 1 + cards.length) % cards.length);
    var heroCenterY = 48 + (150 * 1.5) / 2;
    var scales = [0.50, 0.69, 0.92];
    var xPositions = [0, 40, 80];
    var stack = scales.map(function(s, i) {
      var cardH = 150 * s;
      return {
        x: xPositions[i],
        y: heroCenterY - cardH / 2,
        scale: s,
        opacity: 1,
        depth: i
      };
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

  function drawCardIcon(card, selected, parent, hintState = null) {
    if (!selected) return;
    if (card.iconPath) {
      let style = 'filter: brightness(0) saturate(100%);';
      if (hintState === 'active') {
        style = 'filter: brightness(0) saturate(100%) hue-rotate(0deg) brightness(1.2);';
      } else if (hintState === 'hint') {
        style = 'filter: brightness(0) saturate(150%) hue-rotate(300deg);';
      }

      image(card.iconPath, {
        x: 18, y: 16, width: 30, height: 30,
        preserveAspectRatio: 'xMidYMid meet', opacity: 1, style
      }, parent);

      if (hintState === 'hint' || hintState === 'active') {
        const pulseCircle = mk('circle', {
          cx: 42, cy: 18,
          r: hintState === 'active' ? 8 : 6,
          fill: card.id === 'show' ? 'rgba(119,213,255,0.9)' : 'rgba(146,255,157,0.9)'
        }, parent);
        if (hintState === 'hint') {
          mk('animate', { attributeName: 'r', values: '6;10;6', dur: '0.8s', repeatCount: 'indefinite' }, pulseCircle);
          mk('animate', { attributeName: 'opacity', values: '0.5;1;0.5', dur: '0.8s', repeatCount: 'indefinite' }, pulseCircle);
        }
      }
      return;
    }
    let fill = 'rgba(10,10,10,0.88)';
    if (hintState === 'active') fill = 'rgba(255,0,0,0.9)';
    else if (hintState === 'hint') fill = 'rgba(255,105,180,0.9)';
    text(18, 40, card.iconFallback || '•', {
      fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '28'
    }, parent);

    if (hintState === 'hint' || hintState === 'active') {
      const pulseCircle = mk('circle', {
        cx: 42, cy: 18,
        r: hintState === 'active' ? 8 : 6,
        fill: card.id === 'show' ? 'rgba(119,213,255,0.9)' : 'rgba(146,255,157,0.9)'
      }, parent);
      if (hintState === 'hint') {
        mk('animate', { attributeName: 'r', values: '6;10;6', dur: '0.8s', repeatCount: 'indefinite' }, pulseCircle);
        mk('animate', { attributeName: 'opacity', values: '0.5;1;0.5', dur: '0.8s', repeatCount: 'indefinite' }, pulseCircle);
      }
    }
  }

  function drawWordmark() {
    if (activeSurface !== 'home') return;
    image('assets/icons/png/5.png', {
      x: 11, y: 14, width: 24, height: 24,
      preserveAspectRatio: 'xMidYMid meet', opacity: 0.96,
      style: 'filter: brightness(0) invert(0.96);'
    });
    text(42, 40, 'structa', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '35',
      'letter-spacing': '0.0em'
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
      'font-size': '40',
      'letter-spacing': '0.0em'
    });
  }

  function drawCard(card, index) {
    const selected = index === selectedIndex;
    const layout = cardLayout(index);
    const showStackIcon = !selected;
    const group = mk('g', {
      transform: `translate(${layout.x},${layout.y}) scale(${layout.scale})`,
      opacity: String(layout.opacity),
      tabindex: '0',
      role: 'button',
      'aria-label': `${card.title} ${card.role}`
    });

    const rect = mk('rect', {
      x: 0, y: 0, width: 150, height: 150, rx: 20, ry: 20,
      fill: selected ? card.color : card.color,
      stroke: selected ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)',
      'stroke-width': selected ? 1 : 0.8,
      'stroke-opacity': selected ? 1 : 1
    }, group);

    if (selected) {
      let hintState = null;
      if (hintMode && hintTarget === card.id) {
        hintState = pttActive ? 'active' : 'hint';
      }
      drawCardIcon(card, true, group, hintState);
      text(18, 78, card.title, {
        fill: 'rgba(8,8,8,0.98)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '22'
      }, group);
      const displayRole = (hintMode && hintTarget === card.id)
        ? (card.id === 'show' ? 'hold to shoot' : 'hold to say')
        : lower(card.roleShort || card.role);
      const words = displayRole.split(/\s+/);
      const firstLine = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      const secondLine = words.slice(Math.ceil(words.length / 2)).join(' ');
      text(18, 101, firstLine, {
        fill: 'rgba(8,8,0,0.74)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      }, group);
      if (secondLine) {
        text(18, 116, secondLine, {
          fill: 'rgba(8,8,8,0.74)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '12'
        }, group);
      }

      // Pulsing dot indicator for pending decisions and open questions
      // Subtle, discreet — not a bold badge
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
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '28'
        }, group);
      }

      // Pulsing dots on stack cards too
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
      if (pttActive && hintMode) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (selected) openCard(card);
      else selectIndex(index);
    };

    group.addEventListener('pointerup', activate);
    group.addEventListener('keydown', event => {
      if (pttActive && hintMode) { event.preventDefault(); return; }
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });

    return { group, rect };
  }

  function drawSectionLabel(group, x, y, label) {
    text(x, y, lower(label), {
      fill: 'rgba(8,8,8,0.56)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'letter-spacing': '0.02em'
    }, group);
  }

  /**
   * drawNowPanel -- rebuilt NOW card.
   * Shows: project name, last event, capture, PENDING DECISION (with approve/dismiss),
   * next move, footer stats.
   */
  function drawNowPanel() {
    if (activeSurface !== 'project') return;
    const data = buildNowSummary();
    const nowCard = cards.find(c => c.id === 'now');

    // Full-screen card color background
    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: nowCard.color });
    drawSurfaceHeader(nowCard);

    // Project subtitle
    text(14, 60, lower(data.title), { fill: 'rgba(8,8,8,0.50)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '11' });

    // Since last time
    drawSectionLabel(undefined, 14, 74, 'since last time');
    wrapText(undefined, lower(data.changed), 14, 84, 212, 14, 'rgba(8,8,8,0.92)', '14');

    // Pending decision — the star of the NOW card
    if (data.pendingDecisions.length > 0) {
      const pd = data.pendingDecisions[data.pendingDecisionIndex] || data.pendingDecisions[0];
      const pdText = typeof pd === 'string' ? pd : (pd.text || 'unnamed decision');
      const pdCount = data.pendingDecisions.length;

      // Decision box with dark background
      const boxY = 108;
      const boxH = 72;
      mk('rect', {
        x: 10, y: boxY, width: 220, height: boxH,
        rx: 8, ry: 8,
        fill: 'rgba(8,8,8,0.12)'
      });

      // Section label with count
      drawSectionLabel(undefined, 18, boxY + 12, 'pending decision' + (pdCount > 1 ? ` (${data.pendingDecisionIndex + 1}/${pdCount})` : ''));

      // Decision text (truncated to fit)
      const maxChars = 58;
      const displayText = pdText.length > maxChars ? pdText.slice(0, maxChars - 1) + '…' : pdText;
      wrapText(undefined, lower(displayText), 18, boxY + 28, 195, 14, 'rgba(8,8,8,0.96)', '14');

      // Action pills: ✓ approve  |  ✗ skip
      const pillY = boxY + boxH - 18;
      drawSquaredPill(18, pillY, 76, 14, 'side ✓ approve', true, 'light');
      drawSquaredPill(146, pillY, 76, 14, 'back ✗ skip', false, 'light');

      // Scroll hint for multiple decisions
      if (pdCount > 1) {
        text(120, pillY + 11, 'scroll', {
          fill: 'rgba(8,8,8,0.40)',
          'font-family': 'PowerGrotesk-Regular, sans-serif',
          'font-size': '8',
          'text-anchor': 'middle'
        });
      }

      // Next move (below decision box)
      drawSectionLabel(undefined, 14, boxY + boxH + 12, 'next move');
      wrapText(undefined, lower(data.next), 14, boxY + boxH + 22, 212, 14, 'rgba(8,8,8,0.72)', '13');

      // Footer
      text(14, 282, `${data.captures} captures · ${data.insights} insights · ${data.openQuestions} asks · ${data.decisions} decided`, {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '9'
      });
    } else {
      // No pending decisions — compact layout
      drawSectionLabel(undefined, 14, 108, 'latest capture');
      wrapText(undefined, lower(data.capture), 14, 118, 212, 14, 'rgba(8,8,8,0.72)', '13');

      drawSectionLabel(undefined, 14, 172, 'next move');
      wrapText(undefined, lower(data.next), 14, 182, 212, 14, 'rgba(8,8,8,0.96)', '14');

      // Footer
      text(14, 282, `${data.captures} captures · ${data.insights} insights · ${data.openQuestions} asks · ${data.decisions} decided`, {
        fill: 'rgba(8,8,8,0.36)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '9'
      });
    }
  }

  function drawSquaredPill(x, y, width, height, label, active, tone = 'dark') {
    const activeFill = tone === 'dark' ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.18)';
    const idleFill = tone === 'dark' ? 'rgba(8,8,8,0.10)' : 'rgba(255,255,255,0.12)';
    const activeText = tone === 'dark' ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.98)';
    const idleText = tone === 'dark' ? 'rgba(8,8,8,0.76)' : 'rgba(8,8,8,0.62)';
    mk('rect', {
      x, y, width, height, rx: 4, ry: 4,
      fill: active ? activeFill : idleFill,
      stroke: active ? 'rgba(8,8,8,0.06)' : 'rgba(8,8,8,0.04)',
      'stroke-width': 1
    });
    text(x + width / 2, y + height / 2 + 3, lower(label), {
      fill: active ? activeText : idleText,
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'text-anchor': 'middle'
    });
  }

  /**
   * drawInsightSurface -- rebuilt KNOW card.
   * 4 lanes: asks (questions), signals, decided, loops.
   * Questions have "side = answer" action in detail view.
   */
  function drawInsightSurface() {
    if (activeSurface !== 'insight') return;
    const knowCard = cards.find(c => c.id === 'know');
    const model = buildKnowModel();
    const lane = model.lanes[knowLaneIndex] || model.lanes[0];
    if (!lane) return;
    const availableChipIndexes = lane.availableChipIndexes?.length ? lane.availableChipIndexes : [0];
    if (!availableChipIndexes.includes(knowChipIndex)) knowChipIndex = availableChipIndexes[0];
    const chip = model.chips[knowChipIndex] || model.chips[0];
    const items = getKnowVisibleItems(model);
    if (knowItemIndex >= items.length) knowItemIndex = 0;
    const item = items[knowItemIndex] || lane.items[0];

    // Full-screen card color background
    mk('rect', { x: 0, y: 0, width: 240, height: 292, fill: knowCard.color });
    drawSurfaceHeader(knowCard);

    // Lane tabs — 4 lanes for the new layout
    const laneTabs = [
      { id: 'questions', label: 'asks', width: 44 },
      { id: 'signals', label: 'signals', width: 52 },
      { id: 'decisions', label: 'decided', width: 52 },
      { id: 'open loops', label: 'loops', width: 42 }
    ];
    let tabX = 14;
    laneTabs.forEach(tab => {
      const isActive = lane.id === tab.id;
      drawSquaredPill(tabX, 58, tab.width, 20, tab.label, isActive, 'dark');
      tabX += tab.width + 4;
    });

    // Filter row
    text(14, 91, 'filter', {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9'
    });
    drawSquaredPill(46, 81, Math.max(44, chip.label.length * 7 + 18), 18, chip.label, true, 'dark');
    text(220, 93, `${items.length} results`, {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'text-anchor': 'end'
    });

    if (!knowDetail) {
      text(14, 116, lower(lane.label), { fill: 'rgba(8,8,8,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '18' });
      wrapText(undefined, lower(lane.summary), 14, 134, 212, 14, 'rgba(8,8,8,0.64)', '13');
      drawSectionLabel(undefined, 14, 200, 'best match now');
      wrapText(undefined, lower(item.title), 14, 216, 212, 14, 'rgba(8,8,8,0.96)', '14');
      return;
    }

    text(14, 116, lower(item.title), { fill: 'rgba(8,8,8,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '16' });
    text(220, 116, formatTimeLabel(item.created_at), {
      fill: 'rgba(8,8,8,0.50)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'text-anchor': 'end'
    });

    const sectionLabel = item.source === 'question' ? 'open ask' : 'what it says';
    drawSectionLabel(undefined, 14, 136, sectionLabel);
    wrapText(undefined, lower(item.body), 14, 152, 212, 14, 'rgba(8,8,8,0.90)', '13');

    // Question action: "side = answer this"
    if (item.source === 'question') {
      const actionY = 242;
      mk('rect', {
        x: 10, y: actionY - 6, width: 220, height: 26,
        rx: 6, ry: 6,
        fill: 'rgba(8,8,8,0.12)'
      });
      drawSquaredPill(18, actionY, 92, 14, 'side → answer', true, 'light');
      text(132, actionY + 11, 'speak your answer', {
        fill: 'rgba(8,8,8,0.50)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '9'
      });
    } else {
      drawSectionLabel(undefined, 14, 246, 'next move');
      wrapText(undefined, lower(item.next), 14, 262, 212, 13, 'rgba(8,8,8,0.96)', '13');
    }
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

  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawWordmark();
    if (activeSurface === 'home') {
      cards
        .map((card, index) => ({ card, index, layout: cardLayout(index) }))
        .sort((a, b) => {
          if (a.layout.depth === -1) return 1;
          if (b.layout.depth === -1) return -1;
          return a.layout.depth - b.layout.depth;
        })
        .forEach(({ card, index }) => drawCard(card, index));
    }
    drawNowPanel();
    drawInsightSurface();
    const isContentSurface = activeSurface === 'project' || activeSurface === 'insight';
    logDrawer.style.display = isContentSurface ? 'none' : '';
  }

  function onWheel(event) {
    if (pttActive && hintMode) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    handleScrollDirection(event.deltaY > 0 ? 1 : -1);
  }

  function handleNativeBack(event) {
    // Back button on NOW card = dismiss pending decision first, then go home
    if (activeSurface === 'project') {
      const project = getProjectMemory();
      const pending = project?.pending_decisions || [];
      if (pending.length && decisionIndex < pending.length) {
        native?.dismissPendingDecision?.(decisionIndex);
        pushLog('decision skipped', 'decision');
        decisionIndex = 0;
        render();
        if (event) event.preventDefault?.();
        return;
      }
      // No more decisions — go home, NOT close app
      if (event) event.preventDefault?.();
      backHome();
      return;
    }

    // Back button in hint mode
    if (hintMode) {
      exitHintMode();
      render();
      if (event) event.preventDefault?.();
      return;
    }

    // Back button on insight surface = go home
    if (activeSurface === 'insight') {
      if (event) event.preventDefault?.();
      backHome();
      return;
    }

    // Back button on home with log open = close log
    if (activeSurface === 'home' && logOpen) {
      if (event) event.preventDefault?.();
      setLogDrawer(false);
      return;
    }

    // Back button on home without log = let it pass through (close app)
    if (activeSurface === 'home') {
      return; // Don't preventDefault — let R1 close the app
    }

    // Any other surface = go home
    if (event) event.preventDefault?.();
    backHome();
  }

  // === Heartbeat auto-start ===
  function maybeStartHeartbeat() {
    if (window.StructaHeartbeat && window.StructaHeartbeat.bpm === 0) {
      const project = getProjectMemory();
      const hasContent = (project?.backlog?.length || 0) + (project?.insights?.length || 0) + (project?.captures?.length || 0) + (project?.open_questions?.length || 0);
      if (hasContent > 0) {
        window.StructaHeartbeat.start(10); // 10 BPH = every 6 minutes, gentle
        pushLog('heartbeat started', 'system');
      }
    }
  }

  let lastShakeAt = 0;
  window.addEventListener('devicemotion', event => {
    const accel = event.accelerationIncludingGravity || event.acceleration;
    if (!accel) return;
    const magnitude = Math.abs(accel.x || 0) + Math.abs(accel.y || 0) + Math.abs(accel.z || 0);
    const now = Date.now();
    if (magnitude < 42 || now - lastShakeAt < 1400) return;
    lastShakeAt = now;
    if (activeSurface !== 'home' || logOpen) backHome();
  });

  svg.addEventListener('wheel', onWheel, { passive: false });
  log.addEventListener('wheel', event => {
    if (pttActive && hintMode) { event.preventDefault(); return; }
    if (!logOpen) event.preventDefault();
  }, { passive: false });
  logHandle.addEventListener('click', event => {
    event.preventDefault();
    if (activeSurface === 'camera' || activeSurface === 'voice') return;
    setLogDrawer(!logOpen);
  });

  window.addEventListener('structa-camera-open', () => { activeSurface = 'camera'; render(); });
  window.addEventListener('structa-camera-close', () => { activeSurface = 'home'; render(); refreshLogFromMemory(); });
  window.addEventListener('structa-voice-open', () => { activeSurface = 'voice'; render(); });
  window.addEventListener('structa-voice-close', () => {
    activeSurface = 'home';
    // Clean up answer mode styling
    var voiceOverlay = document.getElementById('voice-overlay');
    var contextLabel = document.getElementById('voice-context-label');
    if (voiceOverlay) voiceOverlay.classList.remove('answer-mode');
    if (contextLabel) contextLabel.textContent = '';
    answeringQuestion = null;
    render();
    refreshLogFromMemory();
  });
  window.addEventListener('structa-memory-updated', () => {
    refreshLogFromMemory();
    render();
    maybeStartHeartbeat();
  });
  window.addEventListener('structa-probe-event', () => { refreshLogFromMemory(); });
  window.addEventListener('scrollUp', event => { event.preventDefault?.(); handleScrollDirection(-1); });
  window.addEventListener('scrollDown', event => { event.preventDefault?.(); handleScrollDirection(1); });
  window.addEventListener('sideClick', event => { event.preventDefault?.(); handleSideClick(); });
  window.addEventListener('longPressStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('longPressEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
  window.addEventListener('pttStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('pttEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
  window.addEventListener('backbutton', handleNativeBack);
  window.addEventListener('popstate', handleNativeBack);
  document.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') selectIndex(selectedIndex + 1);
    if (event.key === 'ArrowLeft') selectIndex(selectedIndex - 1);
    if (event.key === 'Enter' || event.key === ' ') openCard(currentCard());
    if (event.key === 'Escape') backHome();
  });

  native?.setActiveNode?.(currentCard().id);
  native?.updateUIState?.({ selected_card_id: currentCard().id, last_surface: 'home', resumed_at: new Date().toISOString() });
  refreshLogFromMemory();
  render();

  // Auto-start heartbeat if project already has content
  maybeStartHeartbeat();

  // === R1 API REVERSE ENGINEERING PROBE (silent — does not log to user) ===
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
        // Store silently — no pushLog, goes to memory only
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
        .then(stream => {
          window.__STRUCTA_PRIMED_STREAM__ = stream;
        })
        .catch(() => {});
    }
  }
  svg.addEventListener('pointerup', () => primeCameraOnFirstTouch(), { once: true });

  window.StructaPanel = Object.freeze({
    render,
    pushLog,
    setSurface: surface => { activeSurface = surface; render(); },
    backHome,
    selectCard: id => {
      const index = cards.findIndex(card => card.id === id);
      if (index >= 0) selectIndex(index);
    }
  });
})();
