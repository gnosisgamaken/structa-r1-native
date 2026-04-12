(() => {
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const logDrawer = document.getElementById('log-drawer');
  const logHandle = document.getElementById('log-handle');
  const logCount = document.getElementById('log-count');
  const actionRail = document.getElementById('action-rail');
  const actionVerbButtons = actionRail ? Array.from(actionRail.querySelectorAll('[data-action-verb]')) : [];
  const captureLauncher = document.getElementById('capture-launcher');

  const native = window.StructaNative;
  const contracts = window.StructaContracts;
  const router = window.StructaActionRouter;
  const projectCode = contracts?.baseProjectCode || 'PRJ-STRUCTA-R1';

  const cards = [
    {
      id: 'core',
      title: 'Core',
      summary: 'Command loop',
      verb: 'inspect',
      surface: 'log',
      color: 'var(--core)',
      glyph: 'core',
      pill: 'Inspect'
    },
    {
      id: 'memory',
      title: 'Memory',
      summary: 'State + assets',
      verb: 'journal',
      surface: 'voice',
      color: 'var(--memory)',
      glyph: 'memory',
      pill: 'Journal'
    },
    {
      id: 'output',
      title: 'Output',
      summary: 'Response surface',
      verb: 'export',
      surface: 'log',
      color: 'var(--output)',
      glyph: 'output',
      pill: 'Export'
    },
    {
      id: 'support',
      title: 'Support',
      summary: 'Voice + camera',
      verb: 'capture',
      surface: 'camera',
      color: 'var(--support)',
      glyph: 'support',
      pill: 'Capture'
    }
  ];

  let selectedIndex = 0;
  let logOpen = false;
  let activeVerb = router?.getContext?.().active_verb || 'inspect';
  let touch = null;
  let logSwipe = null;

  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const syncLogCount = () => {
    if (logCount) logCount.textContent = `${log.children.length}`;
  };

  const pushLog = (text, strong = '') => {
    const row = document.createElement('div');
    row.className = 'entry';
    const time = document.createElement('span');
    time.className = 'muted';
    time.textContent = `[${stamp()}]`;
    row.appendChild(time);
    row.appendChild(document.createTextNode(' '));
    if (strong) {
      const accent = document.createElement('span');
      accent.className = 'accent';
      accent.textContent = strong;
      row.appendChild(accent);
      row.appendChild(document.createTextNode(' '));
    }
    const message = document.createElement('span');
    message.textContent = text;
    row.appendChild(message);
    log.appendChild(row);
    while (log.children.length > 5) log.removeChild(log.firstChild);
    log.scrollTop = 9999;
    syncLogCount();
    native?.emit?.('ui_log', { text, strong, project_code: projectCode });
  };

  const mk = (name, attrs = {}, parent = svg) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.appendChild(el);
    return el;
  };

  const text = (x, y, value, attrs = {}, parent = svg) => {
    const t = mk('text', { x, y, ...attrs }, parent);
    t.textContent = value;
    return t;
  };

  const clearSvg = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  };

  const addTopBand = () => {
    mk('rect', {
      x: 8,
      y: 8,
      width: 224,
      height: 18,
      rx: 9,
      fill: 'rgba(255,255,255,0.035)',
      stroke: 'rgba(255,255,255,0.05)',
      'stroke-width': 1
    });
    text(14, 21, 'STRUCTA', {
      class: 'tile-title',
      fill: 'var(--support)',
      'letter-spacing': '0.16em'
    });
    const card = cards[selectedIndex];
    mk('rect', {
      x: 164,
      y: 10,
      width: 60,
      height: 14,
      rx: 7,
      fill: 'rgba(255,255,255,0.06)',
      stroke: 'rgba(255,255,255,0.06)',
      'stroke-width': 1
    });
    text(194, 20, card.pill.toUpperCase(), {
      class: 'tile-note',
      fill: 'rgba(246,240,230,0.88)',
      'text-anchor': 'middle',
      'letter-spacing': '0.10em'
    });
  };

  const drawCore = (g, cx, cy, ink) => {
    mk('circle', { cx, cy, r: 18, fill: 'none', stroke: ink, 'stroke-width': 7, 'stroke-linecap': 'round' }, g);
    mk('circle', { cx, cy, r: 6, fill: ink }, g);
    mk('path', { d: `M ${cx - 11} ${cy + 11} A 12 12 0 0 1 ${cx + 11} ${cy + 11}`, fill: 'none', stroke: ink, 'stroke-width': 6, 'stroke-linecap': 'round' }, g);
  };

  const drawMemory = (g, cx, cy, ink) => {
    mk('rect', { x: cx - 18, y: cy - 18, width: 36, height: 36, fill: 'none', stroke: ink, 'stroke-width': 7 }, g);
    mk('rect', { x: cx - 7, y: cy - 7, width: 14, height: 14, fill: ink }, g);
    mk('path', { d: `M ${cx - 18} ${cy + 15} H ${cx + 18}`, fill: 'none', stroke: ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, g);
  };

  const drawOutput = (g, cx, cy, ink) => {
    mk('path', { d: `M ${cx} ${cy - 17} L ${cx + 17} ${cy} L ${cx} ${cy + 17} L ${cx - 17} ${cy} Z`, fill: 'none', stroke: ink, 'stroke-width': 7, 'stroke-linejoin': 'round' }, g);
    mk('path', { d: `M ${cx - 11} ${cy + 5} A 13 13 0 0 1 ${cx + 11} ${cy + 5}`, fill: 'none', stroke: ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, g);
    mk('circle', { cx, cy: cy - 1, r: 4, fill: ink }, g);
  };

  const drawSupport = (g, cx, cy, ink) => {
    mk('circle', { cx, cy, r: 18, fill: 'none', stroke: ink, 'stroke-width': 7 }, g);
    mk('circle', { cx, cy, r: 6, fill: ink }, g);
    mk('circle', { cx: cx - 8, cy: cy - 7, r: 3, fill: ink }, g);
    mk('circle', { cx: cx + 8, cy: cy + 7, r: 3, fill: ink }, g);
  };

  const glyphMap = {
    core: drawCore,
    memory: drawMemory,
    output: drawOutput,
    support: drawSupport
  };

  const currentCard = () => cards[selectedIndex];

  const selectIndex = (index, note = 'FOCUS') => {
    selectedIndex = (index + cards.length) % cards.length;
    const card = currentCard();
    native?.setActiveNode?.(card.id);
    native?.emit?.('card_focus', { project_code: projectCode, node_id: card.id, verb: card.verb });
    pushLog(`Selected ${card.title}.`, note);
    render();
  };

  const setLogDrawer = open => {
    logOpen = open;
    logDrawer.classList.toggle('open', open);
    logDrawer.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  const syncActionRail = () => {
    actionVerbButtons.forEach(btn => {
      const isActive = btn.dataset.actionVerb === activeVerb;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  };

  const setActiveVerb = (verb, source = 'mode') => {
    activeVerb = router?.canonicalizeVerb?.(verb) || verb || 'inspect';
    native?.setActiveVerb?.(activeVerb, source);
    syncActionRail();
    pushLog(`Mode ${activeVerb.toUpperCase()}.`, 'MODE');
  };

  const openVoiceSurface = panel => {
    if (window.StructaVoice?.setPanel) window.StructaVoice.setPanel(panel || 'voice');
    window.StructaVoice?.open?.();
    pushLog(`${panel === 'camera' ? 'Camera' : 'Voice'} surface opened.`, 'CAPTURE');
  };

  const openCameraSurface = mode => {
    window.StructaCamera?.open?.(mode || 'environment');
    window.StructaVoice?.setPanel?.('camera');
    pushLog('Camera capture opened.', 'CAPTURE');
  };

  const routeCurrentCard = () => {
    const card = currentCard();
    const route = native?.routeAction?.({
      project_code: projectCode,
      target: card.id,
      verb: card.verb,
      intent: `${card.verb} ${card.id}`,
      goal: `${card.verb} ${card.title}`,
      source_type: 'touch',
      input_type: 'card-activate',
      approval_mode: 'optional',
      payload: { card_id: card.id, surface: card.surface }
    });

    pushLog(`${card.verb.toUpperCase()} → ${card.title.toUpperCase()}`, 'ROUTE');
    if (route?.route?.requires_approval) pushLog('Approval required before mutation.', 'CHECK');

    if (card.surface === 'log') {
      setLogDrawer(true);
      return;
    }

    if (card.surface === 'voice') {
      openVoiceSurface('voice');
      return;
    }

    if (card.surface === 'camera') {
      openCameraSurface('environment');
      return;
    }
  };


  const cardLayoutFor = (slot) => {
    if (slot === 'selected') return { x: 47, y: 34, scale: 1, opacity: 1 };
    if (slot === 'prev') return { x: 52, y: -18, scale: 0.86, opacity: 0.42 };
    return { x: 52, y: 86, scale: 0.86, opacity: 0.42 };
  };

  const drawCard = (card, slot, index) => {
    const selected = slot === 'selected';
    const layout = cardLayoutFor(slot);
    const ink = (card.id === 'support' || card.id === 'output') ? 'rgba(18,18,18,0.92)' : 'rgba(246,240,230,0.96)';
    const group = mk('g', {
      class: `card card-${card.id}`,
      tabindex: '0',
      role: 'button',
      'aria-pressed': selected ? 'true' : 'false',
      'aria-label': `${card.title} card. ${card.summary}. ${card.pill}.`,
      transform: `translate(${layout.x},${layout.y}) scale(${layout.scale})`
    });
    group.style.opacity = `${layout.opacity}`;
    group.style.transformOrigin = 'center';
    group.style.transition = 'transform 140ms ease, opacity 140ms ease, filter 140ms ease';
    if (selected) group.style.filter = `drop-shadow(0 10px 18px rgba(0,0,0,0.18))`;

    mk('rect', {
      x: 0,
      y: 0,
      width: 138,
      height: 138,
      rx: 24,
      ry: 24,
      fill: card.color,
      stroke: 'rgba(255,255,255,0.10)',
      'stroke-width': 1
    }, group);
    mk('rect', {
      x: 1,
      y: 1,
      width: 136,
      height: 136,
      rx: 23,
      ry: 23,
      fill: 'none',
      stroke: 'rgba(255,255,255,0.08)',
      'stroke-width': 1
    }, group);

    text(12, 20, card.title, {
      class: 'tile-title',
      fill: ink,
      'letter-spacing': '0.08em'
    }, group);

    const motif = mk('g', { transform: 'translate(69,76)' }, group);
    glyphMap[card.glyph](motif, 0, 0, ink);

    mk('rect', {
      x: 12,
      y: 108,
      width: 70,
      height: 20,
      rx: 10,
      fill: 'rgba(255,255,255,0.12)',
      stroke: 'rgba(255,255,255,0.12)',
      'stroke-width': 1
    }, group);
    text(47, 122, card.pill.toUpperCase(), {
      class: 'tile-note',
      fill: ink,
      'text-anchor': 'middle',
      'letter-spacing': '0.12em'
    }, group);

    let pointerStart = null;
    group.addEventListener('pointerdown', e => {
      e.preventDefault();
      pointerStart = { x: e.clientX, y: e.clientY, index, wasSelected: selectedIndex === index };
    });
    group.addEventListener('pointerup', e => {
      const start = pointerStart;
      pointerStart = null;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (Math.max(adx, ady) > 16) {
        if (ady > adx) {
          selectIndex(start.index + (dy > 0 ? 1 : -1), 'SWIPE');
        } else {
          selectIndex(start.index + (dx > 0 ? 1 : -1), 'SWIPE');
        }
        return;
      }
      if (start.wasSelected) {
        routeCurrentCard();
      } else {
        selectIndex(start.index, 'FOCUS');
      }
    });
    group.addEventListener('pointercancel', () => {
      pointerStart = null;
    });
    group.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (selectedIndex === index) routeCurrentCard();
        else selectIndex(index, 'FOCUS');
      }
    });
  };

  const render = () => {
    clearSvg();
    addTopBand();

    const total = cards.length;
    const prev = (selectedIndex - 1 + total) % total;
    const next = (selectedIndex + 1) % total;

    drawCard(cards[prev], 'prev', prev);
    drawCard(cards[next], 'next', next);
    drawCard(cards[selectedIndex], 'selected', selectedIndex);
  };

  const openCoreTrace = () => {
    setLogDrawer(true);
    pushLog('Trace surface opened.', 'TRACE');
  };

  const handleRouteByCard = () => {
    const card = currentCard();
    if (card.id === 'core') {
      openCoreTrace();
      return;
    }
    if (card.id === 'memory') {
      openVoiceSurface('voice');
      return;
    }
    if (card.id === 'output') {
      openCoreTrace();
      return;
    }
    if (card.id === 'support') {
      openCameraSurface('environment');
      return;
    }
  };

  // Replace the generic route with the native surface mapping when a selected card is activated.
  const routeSelectedCard = () => {
    const card = currentCard();
    native?.routeAction?.({
      project_code: projectCode,
      target: card.id,
      verb: card.verb,
      intent: `${card.verb} ${card.id}`,
      goal: `${card.title} surface`,
      source_type: 'touch',
      input_type: 'card-activate',
      approval_mode: 'optional',
      payload: { card_id: card.id, surface: card.surface }
    });
    pushLog(`${card.verb.toUpperCase()} → ${card.title.toUpperCase()}`, 'ROUTE');
    handleRouteByCard();
  };

  const selectNext = delta => {
    selectIndex(selectedIndex + delta, 'FOCUS');
  };

  const routeCurrent = () => {
    routeSelectedCard();
  };

  // Home / setup
  render();
  native?.emit?.('panel_boot', {
    project_code: projectCode,
    capabilities: native?.getCapabilities?.() || {},
    context: native?.getContext?.() || {}
  });
  syncLogCount();
  setLogDrawer(false);
  syncActionRail();

  actionVerbButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveVerb(btn.dataset.actionVerb || 'inspect', 'action');
    });
  });

  captureLauncher?.addEventListener('click', () => {
    openVoiceSurface('voice');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectNext(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectNext(-1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      routeCurrent();
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      openVoiceSurface('voice');
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      openCameraSurface('environment');
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      setActiveVerb('build');
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      setActiveVerb('patch');
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      setActiveVerb('delete');
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      setActiveVerb('solve');
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      setActiveVerb('research');
    } else if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      setActiveVerb('withdraw');
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      setActiveVerb('consolidate');
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      setActiveVerb('decide');
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      if (window.StructaVoice?.closeTray) window.StructaVoice.closeTray();
      if (window.StructaCamera?.stop) window.StructaCamera.stop();
      if (logOpen) setLogDrawer(false);
      else pushLog('Back action received.', 'BACK');
    }
  });

  if (logHandle) {
    logHandle.addEventListener('click', () => setLogDrawer(!logOpen));
    logHandle.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setLogDrawer(!logOpen);
      }
    });
    logHandle.addEventListener('pointerdown', e => {
      logSwipe = { x: e.clientX, y: e.clientY };
    });
    logHandle.addEventListener('pointerup', e => {
      if (!logSwipe) return;
      const dy = e.clientY - logSwipe.y;
      logSwipe = null;
      if (dy < -18) setLogDrawer(true);
      else if (dy > 18) setLogDrawer(false);
    });
    logHandle.addEventListener('pointercancel', () => {
      logSwipe = null;
    });
  }

  // expose a tiny internal control surface for other modules.
  window.StructaPanel = Object.freeze({
    selectIndex,
    routeCurrent,
    setActiveVerb,
    setLogDrawer,
    openVoiceSurface,
    openCameraSurface
  });
})();
