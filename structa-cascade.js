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
    { id: 'know', title: 'know', iconPath: 'assets/icons/png/5.png', iconFallback: '◈', role: 'generate insights', roleShort: 'find signal', color: 'var(--know)', surface: 'insight' },
    { id: 'now', title: 'now', iconPath: 'assets/icons/png/6.png', iconFallback: '▣', role: 'project structure', roleShort: 'catch up fast', color: 'var(--now)', surface: 'project' }
  ];

  const initialState = native?.getUIState?.() || {};
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

  function lastCapture() {
    const captures = getMemory().captures || [];
    return captures[captures.length - 1] || null;
  }

  function latestLogText() {
    const row = log.lastElementChild;
    return row ? lower(row.textContent || '') : 'no logs yet';
  }

  function pushLog(text, strong = '') {
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
    if (surface !== 'log') setLogDrawer(false);
  }

  function openCard(card) {
    queuedIndex = null;
    queuedDirection = 0;
    native?.setActiveNode?.(card.id);
    native?.updateUIState?.({ selected_card_id: card.id, last_surface: card.surface || 'home' });
    pushLog(`${card.title} ready`, 'focus');
    if (card.surface === 'camera') {
      activeSurface = 'camera';
      window.StructaCamera?.open?.();
      render();
      return;
    }
    if (card.surface === 'voice') {
      activeSurface = 'voice';
      window.StructaVoice?.open?.();
      render();
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
    activeSurface = 'project';
    render();
  }

  function exportLogsFromHardware() {
    const result = native?.exportLatestLogs?.(33);
    pushLog(result?.ok ? 'saved 33 logs to rabbit hole' : 'could not save logs', 'logs');
    return result;
  }

  function handleScrollDirection(direction) {
    if (activeSurface === 'camera') {
      window.StructaCamera?.flip?.();
      pushLog('camera angle changed', 'show');
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
      backHome();
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
    if (activeSurface === 'project') {
      backHome();
      return;
    }
    if (activeSurface === 'insight') {
      const model = buildKnowModel();
      if (!model.lanes.length) return;
      if (knowDetail) {
        knowDetail = false;
      } else {
        knowDetail = true;
        knowItemIndex = 0;
      }
      render();
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
    if (activeSurface === 'camera') {
      window.StructaCamera?.capture?.();
      return;
    }
    if (activeSurface === 'voice') {
      window.StructaVoice?.startListening?.();
      return;
    }
    if (activeSurface === 'insight') {
      const model = buildKnowModel();
      if (!model.chips.length) return;
      const lane = model.lanes[knowLaneIndex] || model.lanes[0];
      const available = lane?.availableChipIndexes?.length ? lane.availableChipIndexes : [0];
      const currentPos = Math.max(0, available.indexOf(knowChipIndex));
      knowChipIndex = available[(currentPos + 1) % available.length];
      knowItemIndex = 0;
      render();
      return;
    }
    const card = currentCard();
    if (card.id === 'tell') {
      activeSurface = 'voice';
      window.StructaVoice?.startListening?.();
      render();
      return;
    }
    if (card.id === 'show') {
      activeSurface = 'camera';
      window.StructaCamera?.open?.();
      render();
    }
  }

  function handleLongPressEnd() {
    if (logOpen) {
      exportLogsFromHardware();
      return;
    }
    if (activeSurface === 'voice' && window.StructaVoice?.listening) {
      window.StructaVoice?.stopListening?.(true);
      return;
    }
  }

  function backHome() {
    const leavingSurface = activeSurface;
    queuedIndex = null;
    queuedDirection = 0;
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

  function buildNowSummary() {
    const memory = getMemory();
    const project = getProjectMemory();
    const ui = getUIState();
    const captures = memory.captures || [];
    const insights = project?.insights || [];
    const openQuestions = project?.open_questions || [];
    const backlog = project?.backlog || [];
    return {
      title: project?.name || 'untitled project',
      changed: ui.last_event_summary || 'ready to resume',
      capture: ui.last_capture_summary || (captures[captures.length - 1]?.summary || 'no capture yet'),
      insight: ui.last_insight_summary || (insights[0]?.body || 'no insight yet'),
      next: backlog[0]?.title || (openQuestions[0] ? `answer ${openQuestions[0]}` : 'capture the next concrete update'),
      openQuestions: openQuestions.length,
      captures: captures.length,
      insights: insights.length
    };
  }

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
      { id: 'blocked', label: 'blocked' },
      { id: 'asks', label: 'asks' },
      { id: 'assets', label: 'assets' }
    ];

    const classify = item => {
      const text = lower(`${item.title} ${item.body} ${item.next}`);
      const bucket = new Set(item.chips || []);
      if (item.source === 'question') bucket.add('asks');
      if (item.source === 'asset' || item.source === 'capture-image' || item.source === 'capture-vision') bucket.add('assets');
      if (item.next && textHasAny(item.next, ['next', 'capture', 'answer', 'send', 'review', 'fix', 'act', 'follow', 'move'])) bucket.add('next');
      if (text.includes('?') || textHasAny(text, ['blocked', 'waiting', 'stuck', 'missing', 'need', 'pending', 'unknown'])) bucket.add('blocked');
      item.chips = Array.from(bucket);
      return item;
    };

    const makeItem = ({ lane, title, body, next, created_at, source, chips: chipHints = [] }) => classify({
      lane,
      title: lower(title || lane),
      body: lower(body || 'no detail yet'),
      next: lower(next || 'capture the next useful update'),
      created_at: created_at || new Date().toISOString(),
      source: source || lane,
      chips: chipHints.slice()
    });

    const signals = [];
    const decisionsLane = [];
    const loops = [];

    const insights = project?.insights || [];
    const captures = project?.captures || [];
    const backlog = project?.backlog || [];
    const decisions = project?.decisions || [];
    const openQuestions = project?.open_questions || [];
    const assets = memory?.assets || [];
    const logs = native?.getRecentLogEntries?.(8, { visible_only: true }) || [];

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

    logs.slice(-3).reverse().forEach(entry => {
      signals.push(makeItem({
        lane: 'signals',
        title: 'recent event',
        body: entry.message || 'recent activity',
        next: 'open the matching surface if this changed the plan',
        created_at: entry.created_at,
        source: 'log',
        chips: ['latest']
      }));
    });

    decisions.slice(0, 5).forEach((decision, index) => {
      const decisionTitle = typeof decision === 'string' ? decision : (decision.title || decision.summary || `decision ${index + 1}`);
      const decisionBody = typeof decision === 'string' ? decision : (decision.body || decision.reason || decision.summary || 'decision recorded');
      const decisionNext = typeof decision === 'string' ? backlog[0]?.title || 'act on the decision' : (decision.next || backlog[0]?.title || 'act on the decision');
      decisionsLane.push(makeItem({
        lane: 'decisions',
        title: decisionTitle,
        body: decisionBody,
        next: decisionNext,
        created_at: decision.created_at,
        source: 'decision',
        chips: index === 0 ? ['latest', 'next'] : []
      }));
    });

    if (!decisionsLane.length) {
      decisionsLane.push(makeItem({
        lane: 'decisions',
        title: 'no locked decision',
        body: ui.last_event_summary || 'the project still needs one explicit choice',
        next: backlog[0]?.title || 'use tell to lock the next decision',
        created_at: new Date().toISOString(),
        source: 'decision-gap',
        chips: ['next', 'blocked']
      }));
    }

    backlog.slice(0, 5).forEach((item, index) => {
      loops.push(makeItem({
        lane: 'open loops',
        title: item.title || `open loop ${index + 1}`,
        body: item.body || item.state || 'still open',
        next: item.title || 'move this loop forward with tell',
        created_at: item.created_at,
        source: 'backlog',
        chips: ['next', item.state === 'blocked' ? 'blocked' : '']
      }));
    });

    openQuestions.slice(0, 5).forEach((question, index) => {
      loops.push(makeItem({
        lane: 'open loops',
        title: `question ${index + 1}`,
        body: question,
        next: 'answer this with tell or capture evidence with show',
        created_at: new Date().toISOString(),
        source: 'question',
        chips: ['asks', 'blocked']
      }));
    });

    assets.slice(-4).reverse().forEach((asset, index) => {
      loops.push(makeItem({
        lane: 'open loops',
        title: asset.title || asset.name || `asset ${index + 1}`,
        body: asset.body || asset.summary || asset.kind || 'saved asset',
        next: 'open the related work and decide if this asset matters now',
        created_at: asset.created_at,
        source: 'asset',
        chips: ['assets', index === 0 ? 'latest' : '']
      }));
    });

    const lanes = [
      {
        id: 'signals',
        label: 'signals',
        summary: 'what changed and why it matters',
        emptyTitle: 'no signals yet',
        emptyBody: 'capture something with show or tell to create signal',
        emptyNext: 'use tell to add one concrete update',
        items: signals
      },
      {
        id: 'decisions',
        label: 'decisions',
        summary: 'what is decided and ready to act on',
        emptyTitle: 'no decisions yet',
        emptyBody: 'nothing has been locked in this project yet',
        emptyNext: 'use tell to make one decision explicit',
        items: decisionsLane
      },
      {
        id: 'open loops',
        label: 'open loops',
        summary: 'what is unresolved or waiting',
        emptyTitle: 'no open loops',
        emptyBody: 'this project has no open loops right now',
        emptyNext: 'capture the next question or task when it appears',
        items: loops
      }
    ].map(lane => {
      const laneItems = lane.items.length ? lane.items : [makeItem({
        lane: lane.id,
        title: lane.emptyTitle,
        body: lane.emptyBody,
        next: lane.emptyNext,
        created_at: new Date().toISOString(),
        source: 'empty',
        chips: ['latest']
      })];
      laneItems
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
        .forEach((item, index) => {
          if (index < 2 && !item.chips.includes('latest')) item.chips.push('latest');
        });
      const availableChipIndexes = chips
        .map((chip, index) => laneItems.some(item => item.chips.includes(chip.id)) ? index : -1)
        .filter(index => index >= 0);
      return { ...lane, items: laneItems, availableChipIndexes: availableChipIndexes.length ? availableChipIndexes : [0] };
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

  function cardLayout(index) {
    const distance = index - selectedIndex;
    const normalized = ((distance % cards.length) + cards.length) % cards.length;
    if (distance === 0) return { x: 40, y: 24, scale: 1.10, opacity: 1 };
    if (normalized === 1 || distance === 1) return { x: 170, y: 38, scale: 0.68, opacity: 0.52 };
    if (normalized === cards.length - 1 || distance === -1) return { x: -42, y: 38, scale: 0.68, opacity: 0.52 };
    if (normalized === 2 || distance === 2) return { x: 212, y: 56, scale: 0.50, opacity: 0.12 };
    return { x: -76, y: 56, scale: 0.50, opacity: 0.12 };
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
        x: 18,
        y: 16,
        width: 30,
        height: 30,
        preserveAspectRatio: 'xMidYMid meet',
        opacity: 0.92,
        style: 'filter: brightness(0) saturate(100%);'
      }, parent);
      return;
    }
    text(18, 40, card.iconFallback || '•', {
      fill: 'rgba(10,10,10,0.88)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '28'
    }, parent);
  }

  function drawWordmark() {
    if (activeSurface !== 'home' && activeSurface !== 'project' && activeSurface !== 'insight') return;
    text(16, 18, 'structa', {
      fill: '#f4efe4',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '20',
      'letter-spacing': '0.00em'
    });
  }

  function drawCard(card, index) {
    const selected = index === selectedIndex;
    const layout = cardLayout(index);
    const group = mk('g', {
      transform: `translate(${layout.x},${layout.y}) scale(${layout.scale})`,
      opacity: String(layout.opacity),
      tabindex: '0',
      role: 'button',
      'aria-label': `${card.title} ${card.role}`
    });

    const rect = mk('rect', {
      x: 0,
      y: 0,
      width: 150,
      height: 150,
      rx: 20,
      ry: 20,
      fill: selected ? card.color : 'rgba(18,18,18,0.96)',
      stroke: selected ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.10)',
      'stroke-width': selected ? 1.0 : 1.1
    }, group);

    drawCardIcon(card, selected, group);

    text(18, 78, card.title, {
      fill: selected ? 'rgba(8,8,8,0.98)' : 'rgba(244,239,228,0.96)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': selected ? '21' : '17'
    }, group);

    if (selected) {
      text(18, 102, lower(card.roleShort || card.role), {
        fill: 'rgba(8,8,8,0.74)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '12'
      }, group);
    }

    const activate = event => {
      event.preventDefault();
      if (selected) openCard(card);
      else selectIndex(index);
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
      'font-size': '9',
      'letter-spacing': '0.02em'
    }, group);
  }

  function drawNowPanel() {
    if (activeSurface !== 'project') return;
    const data = buildNowSummary();
    const group = mk('g', { transform: 'translate(8, 34)' });
    mk('rect', { x: 0, y: 0, width: 224, height: 170, rx: 18, ry: 18, fill: '#ff8a65', stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 1.1 }, group);
    text(14, 24, 'now', { fill: 'rgba(8,8,8,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '18' }, group);
    text(14, 44, lower(data.title), { fill: 'rgba(8,8,8,0.72)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12' }, group);
    drawSectionLabel(group, 14, 63, 'since last time');
    wrapText(group, lower(data.changed), 14, 80, 194, 12, 'rgba(8,8,8,0.92)', '12');
    drawSectionLabel(group, 14, 106, 'latest useful capture');
    wrapText(group, lower(data.capture), 14, 123, 194, 11, 'rgba(8,8,8,0.76)', '11');
    drawSectionLabel(group, 14, 149, 'next move');
    wrapText(group, lower(data.next), 14, 166, 194, 11, 'rgba(8,8,8,0.96)', '11');
    text(14, 158, `${data.captures} captures · ${data.insights} insights · ${data.openQuestions} open`, { fill: 'rgba(8,8,8,0.54)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
  }

  function drawPill(group, x, y, width, height, label, active, tone = 'dark') {
    const activeFill = tone === 'dark' ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.18)';
    const idleFill = tone === 'dark' ? 'rgba(8,8,8,0.10)' : 'rgba(255,255,255,0.12)';
    const activeText = tone === 'dark' ? 'rgba(244,239,228,0.96)' : 'rgba(8,8,8,0.98)';
    const idleText = tone === 'dark' ? 'rgba(8,8,8,0.76)' : 'rgba(8,8,8,0.62)';
    mk('rect', {
      x, y, width, height, rx: height / 2, ry: height / 2,
      fill: active ? activeFill : idleFill,
      stroke: active ? 'rgba(8,8,8,0.06)' : 'rgba(8,8,8,0.04)',
      'stroke-width': 1
    }, group);
    text(x + width / 2, y + height / 2 + 3, lower(label), {
      fill: active ? activeText : idleText,
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'text-anchor': 'middle'
    }, group);
  }

  function drawInsightSurface() {
    if (activeSurface !== 'insight') return;
    const model = buildKnowModel();
    const lane = model.lanes[knowLaneIndex] || model.lanes[0];
    if (!lane) return;
    const availableChipIndexes = lane.availableChipIndexes?.length ? lane.availableChipIndexes : [0];
    if (!availableChipIndexes.includes(knowChipIndex)) knowChipIndex = availableChipIndexes[0];
    const chip = model.chips[knowChipIndex] || model.chips[0];
    const items = getKnowVisibleItems(model);
    if (knowItemIndex >= items.length) knowItemIndex = 0;
    const item = items[knowItemIndex] || lane.items[0];
    const group = mk('g', { transform: 'translate(8, 34)' });
    mk('rect', {
      x: 0, y: 0, width: 224, height: 170, rx: 18, ry: 18,
      fill: '#f8c15d', stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 1.1
    }, group);

    text(14, 24, 'know', { fill: 'rgba(8,8,8,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '18' }, group);

    drawPill(group, 14, 34, 60, 20, 'signals', lane.id === 'signals', 'light');
    drawPill(group, 79, 34, 64, 20, 'decide', lane.id === 'decisions', 'light');
    drawPill(group, 148, 34, 62, 20, 'loops', lane.id === 'open loops', 'light');

    text(14, 67, 'filter', {
      fill: 'rgba(8,8,8,0.56)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9'
    }, group);
    drawPill(group, 46, 57, Math.max(44, chip.label.length * 7 + 18), 18, chip.label, true, 'dark');
    text(206, 69, `${items.length} results`, {
      fill: 'rgba(8,8,8,0.56)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'text-anchor': 'end'
    }, group);

    if (!knowDetail) {
      text(14, 96, lower(lane.label), { fill: 'rgba(8,8,8,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '18' }, group);
      wrapText(group, lower(lane.summary), 14, 114, 194, 12, 'rgba(8,8,8,0.72)', '12');
      drawSectionLabel(group, 14, 140, 'best match now');
      wrapText(group, lower(item.title), 14, 156, 194, 12, 'rgba(8,8,8,0.96)', '12');
      return;
    }

    text(14, 94, lower(item.title), { fill: 'rgba(8,8,8,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '15' }, group);
    text(206, 94, formatTimeLabel(item.created_at), {
      fill: 'rgba(8,8,8,0.56)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '9',
      'text-anchor': 'end'
    }, group);
    drawSectionLabel(group, 14, 111, item.source === 'question' ? 'open ask' : 'what it says');
    wrapText(group, lower(item.body), 14, 127, 194, 11, 'rgba(8,8,8,0.90)', '11');
    drawSectionLabel(group, 14, 149, 'next move');
    wrapText(group, lower(item.next), 14, 163, 194, 10, 'rgba(8,8,8,0.96)', '10');
  }

  function wrapText(parent, content, x, y, width, lineHeight, fill, fontSize = '10') {
    const words = lower(content).split(/\s+/);
    let line = '';
    let row = 0;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${fontSize}px PowerGrotesk-Regular`;
    words.forEach(word => {
      const test = line ? `${line} ${word}` : word;
      if (measure.measureText(test).width > width && line) {
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
      cards.forEach((card, index) => drawCard(card, index));
    }
    drawNowPanel();
    drawInsightSurface();
  }

  function onWheel(event) {
    event.preventDefault();
    handleScrollDirection(event.deltaY > 0 ? 1 : -1);
  }

  function handleNativeBack(event) {
    if (activeSurface !== 'home' || logOpen) {
      if (event) event.preventDefault?.();
      backHome();
    }
  }

  svg.addEventListener('wheel', onWheel, { passive: false });
  log.addEventListener('wheel', event => {
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
  window.addEventListener('structa-voice-close', () => { activeSurface = 'home'; render(); refreshLogFromMemory(); });
  window.addEventListener('structa-memory-updated', () => { refreshLogFromMemory(); render(); });
  window.addEventListener('structa-probe-event', () => { refreshLogFromMemory(); });
  window.addEventListener('scrollUp', event => { event.preventDefault?.(); handleScrollDirection(-1); });
  window.addEventListener('scrollDown', event => { event.preventDefault?.(); handleScrollDirection(1); });
  window.addEventListener('sideClick', event => { event.preventDefault?.(); handleSideClick(); });
  window.addEventListener('longPressStart', event => { event.preventDefault?.(); handleLongPressStart(); });
  window.addEventListener('longPressEnd', event => { event.preventDefault?.(); handleLongPressEnd(); });
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
  if (native?.getCapabilities?.().probeMode) {
    pushLog('probe mode active', 'probe');
  }
  render();

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
