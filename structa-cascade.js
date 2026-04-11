(() => {
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const logDrawer = document.getElementById('log-drawer');
  const logHandle = document.getElementById('log-handle');
  const native = window.StructaNative;
  const contracts = window.StructaContracts;
  const router = window.StructaActionRouter;
  const actionRail = document.getElementById('action-rail');
  const actionVerbButtons = actionRail ? Array.from(actionRail.querySelectorAll('[data-action-verb]')) : [];
  const logCount = document.getElementById('log-count');
  const welcomeTip = document.getElementById('welcome-tip');
  const welcomeDismiss = document.getElementById('welcome-dismiss');
  const projectCode = contracts?.baseProjectCode || 'PRJ-STRUCTA-R1';
  let activeVerb = router?.getContext?.().active_verb || 'inspect';

  const layers = {
    primary: [
      { id: 'core', label: 'CORE', x: 10,  y: 10,  w: 230, h: 148, color: 'var(--core)' },
      { id: 'memory', label: 'MEMORY', x: 240, y: 10,  w: 230, h: 148, color: 'var(--memory)' },
      { id: 'output', label: 'OUTPUT', x: 10,  y: 164, w: 230, h: 148, color: 'var(--output)' },
      { id: 'support', label: 'SUPPORT', x: 240, y: 164, w: 230, h: 148, color: 'var(--support)' }
    ],
    hidden: [
      { id: 'contract', label: 'CONTRACT', x: 362, y: 58, w: 94, h: 84, color: 'var(--contract)' },
      { id: 'validator', label: 'VALIDATOR', x: 362, y: 182, w: 94, h: 84, color: 'var(--validator)' }
    ]
  };

  const tileCopy = {
    core: { note: 'Command loop', hint: 'route · inspect' },
    memory: { note: 'State + assets', hint: 'journal · recall' },
    output: { note: 'Response surface', hint: 'render · export' },
    support: { note: 'Voice + camera', hint: 'capture · submit' },
    contract: { note: 'Rules + gates', hint: 'strict envelope' },
    validator: { note: 'Sanity check', hint: 'reject drift' }
  };

  const focusOrder = ['core', 'memory', 'output', 'support'];
  const allOrder = ['core', 'memory', 'output', 'support', 'contract', 'validator'];
  const els = { tiles: {}, labels: {}, hidden: {}, touchStart: null, drawerTouch: null, drawerSwipeBlock: false };
  let active = 0;
  let busy = false;
  let revealLayer = false;
  let holdTimer = null;
  let logOpen = false;

  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const syncLogCount = () => {
    if (logCount) logCount.textContent = `${log.children.length} ITEMS`;
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
    syncLogCount();
    log.scrollTop = 9999;
    native?.emit('ui_log', { text, strong, project_code: projectCode });
  };

  const setLogDrawer = open => {
    logOpen = open;
    logDrawer.classList.toggle('open', open);
    logDrawer.setAttribute('aria-expanded', open ? 'true' : 'false');
    const state = logHandle?.querySelector('.state');
    if (state) state.textContent = open ? `SWIPE ↓ · ${activeVerb.toUpperCase()}` : `SWIPE ↑ · ${activeVerb.toUpperCase()}`;
  };

  const toggleLogDrawer = () => setLogDrawer(!logOpen);

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

  const center = t => ({ cx: t.x + t.w / 2, cy: t.y + t.h / 2 });

  function addBackdrop() {
    mk('rect', { x: 6, y: 6, width: 468, height: 310, fill: 'none', stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1 });
    mk('rect', { x: 14, y: 14, width: 452, height: 294, fill: 'none', stroke: 'rgba(255,255,255,0.028)', 'stroke-width': 1 });
  }

  function shapeCore(g, cx, cy, ink) {
    mk('circle', { cx, cy, r: 31, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
    mk('circle', { cx, cy, r: 11, fill: ink }, g);
    mk('path', { d: `M ${cx - 20} ${cy + 17} A 24 24 0 0 1 ${cx + 20} ${cy + 17}`, fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
  }

  function shapeMemory(g, cx, cy, ink) {
    mk('rect', { x: cx - 31, y: cy - 31, width: 62, height: 62, fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
    mk('rect', { x: cx - 13, y: cy - 13, width: 26, height: 26, fill: ink }, g);
    mk('path', { d: `M ${cx - 32} ${cy + 24} H ${cx + 32}`, fill: 'none', stroke: ink, 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
  }

  function shapeOutput(g, cx, cy, ink) {
    mk('path', { d: `M ${cx} ${cy - 31} L ${cx + 31} ${cy} L ${cx} ${cy + 31} L ${cx - 31} ${cy} Z`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linejoin': 'round' }, g);
    mk('path', { d: `M ${cx - 22} ${cy + 8} A 26 26 0 0 1 ${cx + 22} ${cy + 8}`, fill: 'none', stroke: ink, 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
    mk('circle', { cx: cx, cy: cy - 2, r: 7, fill: ink }, g);
  }

  function shapeSupport(g, cx, cy, ink) {
    mk('circle', { cx, cy, r: 31, fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
    mk('circle', { cx, cy, r: 10, fill: ink }, g);
    mk('circle', { cx: cx - 15, cy: cy - 14, r: 4, fill: ink }, g);
    mk('circle', { cx: cx + 15, cy: cy + 14, r: 4, fill: ink }, g);
  }

  function shapeContract(g, cx, cy, ink) {
    mk('path', { d: `M ${cx} ${cy - 28} L ${cx + 29} ${cy + 22} L ${cx - 29} ${cy + 22} Z`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linejoin': 'round' }, g);
    mk('path', { d: `M ${cx - 15} ${cy + 5} H ${cx + 15}`, fill: 'none', stroke: ink, 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
    mk('circle', { cx: cx, cy: cy - 2, r: 7, fill: ink }, g);
  }

  function shapeValidator(g, cx, cy, ink) {
    mk('path', { d: `M ${cx - 29} ${cy - 29} L ${cx + 29} ${cy + 29}`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
    mk('path', { d: `M ${cx + 29} ${cy - 29} L ${cx - 29} ${cy + 29}`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
    mk('circle', { cx, cy, r: 9, fill: ink }, g);
  }

  const drawTile = (t, isHidden = false) => {
    const copy = tileCopy[t.id] || { note: t.label, hint: '' };
    const labelFill = (t.id === 'core' || t.id === 'output' || t.id === 'contract')
      ? 'rgba(248,244,235,0.96)'
      : 'rgba(18,18,18,0.90)';
    const g = mk('g', {
      class: `tile ${isHidden ? 'hidden' : 'primary'} tile-${t.id}`,
      'data-node': t.id,
      transform: `translate(${t.x},${t.y})`,
      tabindex: '0',
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `${t.label} node. ${copy.note}. ${copy.hint}.`
    });
    const c = center(t);
    const ink = (t.id === 'validator' || t.id === 'support') ? 'rgba(24,24,24,0.9)' : 'rgba(245,243,236,0.96)';

    mk('rect', { x: 0, y: 0, width: t.w, height: t.h, rx: 18, ry: 18, fill: t.color, class: 'tile-rect' }, g);
    mk('rect', { x: 0.5, y: 0.5, width: t.w - 1, height: t.h - 1, rx: 17, ry: 17, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, g);

    // deliberately sparse composition: big form, one secondary accent, small label system
    const motif = mk('g', { class: 'motif' }, g);
    if (t.id === 'core') shapeCore(motif, c.cx, c.cy + 8, ink);
    if (t.id === 'memory') shapeMemory(motif, c.cx, c.cy + 8, ink);
    if (t.id === 'output') shapeOutput(motif, c.cx, c.cy + 8, ink);
    if (t.id === 'support') shapeSupport(motif, c.cx, c.cy + 8, ink);
    if (t.id === 'contract') shapeContract(motif, c.cx, c.cy + 8, ink);
    if (t.id === 'validator') shapeValidator(motif, c.cx, c.cy + 8, ink);

    text(16, 22, t.label, { class: 'tile-title', fill: labelFill }, g);
    text(16, t.h - 28, copy.note.toUpperCase(), { class: 'tile-note', fill: labelFill, opacity: '0.92' }, g);
    text(16, t.h - 13, copy.hint.toUpperCase(), { class: 'tile-note', fill: labelFill, opacity: '0.54' }, g);

    g.addEventListener('pointerdown', e => {
      e.preventDefault();
      selectTile(t.id);
      holdTimer = setTimeout(() => {
        if (t.id === 'core' || t.id === 'memory') {
          toggleHiddenLayer();
          pushLog(`${t.id.toUpperCase()} layer opened.`, 'HOLD');
        }
      }, 420);
      els.touchStart = { x: e.clientX, y: e.clientY, id: t.id };
    });
    g.addEventListener('pointerup', e => {
      clearTimeout(holdTimer);
      holdTimer = null;
      const start = els.touchStart;
      els.touchStart = null;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) triggerFrom(start.id);
    });
    g.addEventListener('pointercancel', () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      els.touchStart = null;
    });
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerFrom(t.id);
      }
    });

    els.tiles[t.id] = g;
  };

  function toggleHiddenLayer() {
    revealLayer = !revealLayer;
    layers.hidden.forEach(t => {
      const node = els.hidden[t.id];
      if (node) node.style.opacity = revealLayer ? '1' : '0';
      if (node) node.style.pointerEvents = revealLayer ? 'auto' : 'none';
      if (node) node.setAttribute('aria-hidden', revealLayer ? 'false' : 'true');
    });
  }

  function addHiddenTile(t) {
    const copy = tileCopy[t.id] || { note: t.label, hint: '' };
    const labelFill = t.id === 'validator' ? 'rgba(18,18,18,0.90)' : 'rgba(248,244,235,0.96)';
    const g = mk('g', {
      class: `tile hidden tile-${t.id}`,
      'data-node': t.id,
      transform: `translate(${t.x},${t.y})`,
      opacity: '0',
      tabindex: '0',
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `${t.label} node. ${copy.note}. ${copy.hint}.`
    });
    const c = center(t);
    const ink = t.id === 'validator' ? 'rgba(24,24,24,0.9)' : 'rgba(245,243,236,0.96)';
    mk('rect', { x: 0, y: 0, width: t.w, height: t.h, rx: 14, ry: 14, fill: t.color, class: 'tile-rect' }, g);
    mk('rect', { x: 0.5, y: 0.5, width: t.w - 1, height: t.h - 1, rx: 13, ry: 13, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, g);
    const motif = mk('g', {}, g);
    if (t.id === 'contract') shapeContract(motif, c.cx, c.cy + 4, ink);
    if (t.id === 'validator') shapeValidator(motif, c.cx, c.cy + 4, ink);
    text(10, 18, t.label, { class: 'tile-title', fill: labelFill }, g);
    text(10, t.h - 12, copy.note.toUpperCase(), { class: 'tile-note', fill: labelFill, opacity: '0.88' }, g);
    g.style.pointerEvents = 'none';
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') triggerFrom(t.id); });
    els.hidden[t.id] = g;
  }

  function attachDrawerGestures() {
    if (!logHandle) return;

    const toggleIfAllowed = e => {
      if (els.drawerSwipeBlock) {
        e.preventDefault();
        return;
      }
      toggleLogDrawer();
    };

    logHandle.addEventListener('click', toggleIfAllowed);
    logHandle.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleIfAllowed(e);
      }
    });
    logHandle.addEventListener('pointerdown', e => {
      els.drawerSwipeBlock = false;
      els.drawerTouch = { x: e.clientX, y: e.clientY };
    });
    logHandle.addEventListener('pointerup', e => {
      if (!els.drawerTouch) return;
      const dy = e.clientY - els.drawerTouch.y;
      els.drawerTouch = null;
      if (dy < -20) { els.drawerSwipeBlock = true; setLogDrawer(true); setTimeout(() => { els.drawerSwipeBlock = false; }, 0); }
      else if (dy > 20) { els.drawerSwipeBlock = true; setLogDrawer(false); setTimeout(() => { els.drawerSwipeBlock = false; }, 0); }
    });
    logHandle.addEventListener('pointercancel', () => { els.drawerTouch = null; });
  }

  function syncActionRail() {
    actionVerbButtons.forEach(btn => {
      const isActive = btn.dataset.actionVerb === activeVerb;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function setActiveVerb(verb, note = '') {
    activeVerb = router?.canonicalizeVerb?.(verb) || verb || 'inspect';
    native?.setActiveVerb?.(activeVerb, note || 'context');
    syncActionRail();
    const state = logHandle?.querySelector('.state');
    if (state) state.textContent = logOpen ? `SWIPE ↓ · ${activeVerb.toUpperCase()}` : `SWIPE ↑ · ${activeVerb.toUpperCase()}`;
    if (note) pushLog(`Action primed: ${activeVerb.toUpperCase()}`, note.toUpperCase());
  }

  function selectTile(id) {
    active = focusOrder.indexOf(id) >= 0 ? focusOrder.indexOf(id) : active;
    Object.entries(els.tiles).forEach(([key, el]) => {
      const selected = key === id;
      el.classList.toggle('selected', selected);
      el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    Object.entries(els.hidden).forEach(([key, el]) => {
      const selected = key === id;
      el.classList.toggle('selected', selected);
      el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    native?.setActiveNode?.(id);
  }

  function flash(id) {
    const el = els.tiles[id] || els.hidden[id];
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 220);
  }

  function showHiddenFor(activeId) {
    const show = activeId === 'core' || activeId === 'memory';
    revealLayer = show;
    layers.hidden.forEach(t => {
      const node = els.hidden[t.id];
      if (!node) return;
      node.style.opacity = show ? '1' : '0';
      node.style.pointerEvents = show ? 'auto' : 'none';
      node.setAttribute('aria-hidden', show ? 'false' : 'true');
    });
  }

  function runSequence(startId) {
    if (busy) return;
    busy = true;
    const base = [startId];
    if (startId === 'core') base.push('memory', 'output', 'support');
    if (startId === 'memory') base.push('output', 'support');
    if (startId === 'output') base.push('support');
    if (startId === 'support') base.push('core');
    pushLog(`Composition start: ${startId.toUpperCase()}`, 'TRIGGER');
    base.forEach((id, i) => {
      setTimeout(() => {
        flash(id);
        pushLog(`${id.toUpperCase()} active.`);
      }, i * 150);
    });
    setTimeout(() => {
      pushLog('Composition stabilized.');
      pushLog('Panel state complete.');
      busy = false;
    }, base.length * 150 + 120);
  }

  function triggerFrom(id) {
    selectTile(id);
    showHiddenFor(id);
    const routeVerb = activeVerb || 'inspect';
    native?.sendStructuredMessage({
      project_code: projectCode,
      entry_id: contracts?.makeEntryId('node') || `node-${Date.now()}`,
      source_type: 'touch',
      input_type: 'node-trigger',
      target: id,
      verb: routeVerb,
      intent: `${routeVerb} ${id}`,
      goal: `${routeVerb} ${id} node`,
      approval_mode: ['build', 'patch', 'delete', 'withdraw', 'export'].includes(routeVerb) ? 'human_required' : 'optional',
      fallback: 'panel-sequence',
      payload: { node_id: id, active_verb: routeVerb }
    });
    pushLog(`${routeVerb.toUpperCase()} → ${id.toUpperCase()}`, 'ROUTE');
    runSequence(id);
  }

  function nextTile(dir) {
    active = (active + dir + focusOrder.length) % focusOrder.length;
    const id = focusOrder[active];
    selectTile(id);
    showHiddenFor(id);
  }

  addBackdrop();
  layers.primary.forEach(t => drawTile(t, false));
  layers.hidden.forEach(t => addHiddenTile(t));

  selectTile('core');
  showHiddenFor('core');
  native?.emit('panel_boot', {
    project_code: projectCode,
    capabilities: native?.getCapabilities?.() || {},
    context: native?.getContext?.() || {}
  });
  syncActionRail();
  pushLog('Panel initialized.');
  pushLog('Four primary nodes loaded.');
  pushLog('Hold core or memory to reveal deeper layer.');
  syncLogCount();

  const onboardingKey = 'structa-onboarding-dismissed-v1';
  const shouldShowWelcome = !window.localStorage || !window.localStorage.getItem(onboardingKey);
  if (welcomeTip && shouldShowWelcome) welcomeTip.classList.add('show');
  welcomeDismiss?.addEventListener('click', () => {
    welcomeTip?.classList.remove('show');
    try {
      window.localStorage?.setItem(onboardingKey, '1');
    } catch (_) {}
  });

  actionVerbButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveVerb(btn.dataset.actionVerb || 'inspect', 'action');
      pushLog(`Verb selected: ${activeVerb.toUpperCase()}`, 'MODE');
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextTile(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); nextTile(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerFrom(focusOrder[active]); }
    else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); window.StructaVoice?.open?.(); }
    else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); window.StructaCamera?.open?.(); }
    else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setActiveVerb('build'); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setActiveVerb('patch'); }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); setActiveVerb('delete'); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); setActiveVerb('solve'); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setActiveVerb('research'); }
    else if (e.key === 'w' || e.key === 'W') { e.preventDefault(); setActiveVerb('withdraw'); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); setActiveVerb('consolidate'); }
    else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setActiveVerb('decide'); }
    else if (e.key === 'Escape' || e.key === 'Backspace') {
      if (window.StructaVoice?.closeTray) window.StructaVoice.closeTray();
      if (window.StructaCamera?.stop) window.StructaCamera.stop();
      if (logOpen) setLogDrawer(false);
      else pushLog('Back action received.');
    }
  });

  svg.addEventListener('pointerup', e => {
    if (els.touchStart) {
      const dx = e.clientX - els.touchStart.x;
      const dy = e.clientY - els.touchStart.y;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      const started = els.touchStart.id;
      els.touchStart = null;
      if (Math.max(adx, ady) < 10) return;
      if (adx > ady) nextTile(dx > 0 ? 1 : -1);
      else if (dy < 0) triggerFrom(started);
    }
  });

  attachDrawerGestures();
  setLogDrawer(false);
})();
