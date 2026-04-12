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
    { id: 'show', title: 'show', icon: '◉', role: 'capture image', color: 'var(--show)', surface: 'camera' },
    { id: 'tell', title: 'tell', icon: '⌇', role: 'capture commands', color: 'var(--tell)', surface: 'voice' },
    { id: 'know', title: 'know', icon: '◈', role: 'generate insights', color: 'var(--know)', surface: 'insight' },
    { id: 'now', title: 'now', icon: '▣', role: 'project structure', color: 'var(--now)', surface: 'project' }
  ];

  const initialState = native?.getUIState?.() || {};
  let selectedIndex = Math.max(0, cards.findIndex(card => card.id === (initialState.selected_card_id || 'now')));
  if (selectedIndex < 0) selectedIndex = 3;
  let logOpen = false;
  let activeSurface = 'home';
  let insightIndex = 0;
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
    if (queuedIndex !== null) return `queued ${cards[queuedIndex].title}`;
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
    const entries = (native?.getRecentLogEntries?.(5, { visible_only: true }) || []).slice(-5);
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
      insightIndex = 0;
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
    if (activeSurface === 'insight') {
      const insights = buildInsights();
      insightIndex = (insightIndex + (direction > 0 ? 1 : -1) + insights.length) % insights.length;
      render();
      return;
    }
    if (activeSurface === 'project') {
      return;
    }
    if (logOpen) {
      const delta = direction > 0 ? 28 : -28;
      log.scrollTop += delta;
      return;
    }
    const target = (selectedIndex + (direction > 0 ? 1 : -1) + cards.length) % cards.length;
    if (queuedIndex === target && queuedDirection === direction) {
      queuedIndex = null;
      queuedDirection = 0;
      selectIndex(target);
      return;
    }
    queuedIndex = target;
    queuedDirection = direction;
    native?.updateUIState?.({ selected_card_id: cards[target].id, last_surface: 'queue-preview' });
    render();
  }

  function handleSideClick() {
    queuedIndex = null;
    queuedDirection = 0;
    if (activeSurface === 'camera') {
      window.StructaCamera?.capture?.();
      return;
    }
    if (activeSurface === 'voice') {
      return;
    }
    if (logOpen) {
      setLogDrawer(false);
      return;
    }
    const card = currentCard();
    if (card.id === 'tell') {
      return;
    }
    openCard(card);
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
    queuedIndex = null;
    queuedDirection = 0;
    if (activeSurface === 'camera') {
      window.StructaCamera?.close?.();
    }
    if (activeSurface === 'voice') {
      window.StructaVoice?.close?.();
    }
    setLogDrawer(false);
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

  function buildInsights() {
    const project = getProjectMemory();
    const captures = project?.captures || [];
    const backlog = project?.backlog || [];
    const decisions = project?.decisions || [];
    const openQuestions = project?.open_questions || [];
    const ui = getUIState();
    return [
      { title: 'signal', why: 'latest useful change', next: backlog[0]?.title || 'capture the next concrete task with tell', body: ui.last_capture_summary || `${captures.length} captures are linked to this project` },
      { title: 'gap', why: 'what is still unresolved', next: openQuestions[0] ? 'answer the open question' : 'record the missing context with tell', body: openQuestions[0] || 'no open question has been recorded yet' },
      { title: 'decision', why: 'what is already clear', next: decisions[0]?.title ? 'act on the locked decision' : 'make one decision explicit', body: decisions[0]?.title || 'no decision has been locked yet' },
      { title: 'next', why: 'best immediate move', next: backlog[0]?.title || 'use show or tell to move the project forward', body: backlog[0]?.title || 'capture the next concrete task with tell' }
    ];
  }

  function cardLayout(index) {
    const displayIndex = queuedIndex !== null ? queuedIndex : selectedIndex;
    const distance = index - displayIndex;
    const normalized = ((distance % cards.length) + cards.length) % cards.length;
    const previewing = queuedIndex !== null;
    if (distance === 0) return { x: 54, y: previewing ? 48 : 42, scale: previewing ? 0.94 : 1, opacity: 1 };
    if (normalized === 1 || distance === 1) return { x: previewing ? 148 : 158, y: 56, scale: previewing ? 0.72 : 0.62, opacity: previewing ? 0.54 : 0.34 };
    if (normalized === cards.length - 1 || distance === -1) return { x: previewing ? -12 : -22, y: 56, scale: previewing ? 0.72 : 0.62, opacity: previewing ? 0.54 : 0.34 };
    if (normalized === 2 || distance === 2) return { x: 194, y: 70, scale: 0.46, opacity: 0.12 };
    return { x: -52, y: 70, scale: 0.46, opacity: 0.12 };
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

  function drawWordmark() {
    if (activeSurface !== 'home' && activeSurface !== 'project' && activeSurface !== 'insight') return;
    text(12, 26, 'structa', {
      fill: 'rgba(244,239,228,0.94)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '15',
      'letter-spacing': '0.02em'
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
      width: 136,
      height: 136,
      rx: 12,
      ry: 12,
      fill: selected ? card.color : 'rgba(255,255,255,0.04)',
      stroke: selected ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.08)',
      'stroke-width': selected ? 1.3 : 1
    }, group);

    text(18, 40, card.icon, {
      fill: selected ? 'rgba(10,10,10,0.88)' : card.color,
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '28'
    }, group);

    text(18, 74, card.title, {
      fill: selected ? 'rgba(10,10,10,0.94)' : 'rgba(244,239,228,0.94)',
      'font-family': 'PowerGrotesk-Regular, sans-serif',
      'font-size': '18'
    }, group);

    if (selected) {
      text(18, 96, card.role, {
        fill: 'rgba(10,10,10,0.70)',
        'font-family': 'PowerGrotesk-Regular, sans-serif',
        'font-size': '10'
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

  function drawNowPanel() {
    if (activeSurface !== 'project') return;
    const data = buildNowSummary();
    const group = mk('g', { transform: 'translate(10, 38)' });
    mk('rect', { x: 0, y: 0, width: 220, height: 164, rx: 16, ry: 16, fill: 'rgba(255,138,101,0.12)', stroke: 'rgba(255,138,101,0.26)', 'stroke-width': 1.2 }, group);
    text(14, 24, 'now', { fill: 'rgba(255,138,101,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '16' }, group);
    text(14, 46, lower(data.title), { fill: 'rgba(244,239,228,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12' }, group);
    text(14, 64, 'since last time', { fill: 'rgba(244,239,228,0.52)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
    wrapText(group, lower(data.changed), 14, 80, 188, 11, 'rgba(244,239,228,0.86)');
    text(14, 104, 'latest useful capture', { fill: 'rgba(244,239,228,0.52)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
    wrapText(group, lower(data.capture), 14, 120, 188, 10, 'rgba(244,239,228,0.72)');
    text(14, 140, 'next move', { fill: 'rgba(244,239,228,0.52)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
    wrapText(group, lower(data.next), 14, 154, 188, 10, 'rgba(244,239,228,0.88)');
    text(14, 152 + 20, `${data.captures} captures · ${data.insights} insights · ${data.openQuestions} open`, { fill: 'rgba(244,239,228,0.50)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
  }

  function drawInsightSurface() {
    if (activeSurface !== 'insight') return;
    const insights = buildInsights();
    const item = insights[insightIndex % insights.length];
    const group = mk('g', { transform: 'translate(10, 38)' });
    mk('rect', {
      x: 0, y: 0, width: 220, height: 164, rx: 16, ry: 16,
      fill: 'rgba(248,193,93,0.14)', stroke: 'rgba(248,193,93,0.34)', 'stroke-width': 1.2
    }, group);
    text(14, 24, 'know', { fill: 'rgba(248,193,93,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '16' }, group);
    text(14, 46, lower(item.title), { fill: 'rgba(244,239,228,0.96)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '12' }, group);
    text(14, 64, 'why it matters', { fill: 'rgba(244,239,228,0.52)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
    wrapText(group, lower(item.body), 14, 80, 188, 10, 'rgba(244,239,228,0.82)');
    text(14, 124, 'next step', { fill: 'rgba(244,239,228,0.52)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
    wrapText(group, lower(item.next), 14, 140, 188, 10, 'rgba(244,239,228,0.92)');
    text(14, 152 + 20, `item ${insightIndex + 1} of ${insights.length}`, { fill: 'rgba(244,239,228,0.50)', 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '9' }, group);
  }

  function wrapText(parent, content, x, y, width, lineHeight, fill) {
    const words = lower(content).split(/\s+/);
    let line = '';
    let row = 0;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '10px PowerGrotesk-Regular';
    words.forEach(word => {
      const test = line ? `${line} ${word}` : word;
      if (measure.measureText(test).width > width && line) {
        text(x, y + row * lineHeight, line, { fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10' }, parent);
        line = word;
        row += 1;
      } else {
        line = test;
      }
    });
    if (line) text(x, y + row * lineHeight, line, { fill, 'font-family': 'PowerGrotesk-Regular, sans-serif', 'font-size': '10' }, parent);
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
