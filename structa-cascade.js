(() => {
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const hint = document.getElementById('hint');

  const layers = {
    primary: [
      { id: 'core', label: 'CORE', x: 14,  y: 14,  w: 222, h: 140, color: 'var(--core)' },
      { id: 'memory', label: 'MEMORY', x: 244, y: 14,  w: 222, h: 140, color: 'var(--memory)' },
      { id: 'output', label: 'OUTPUT', x: 14,  y: 168, w: 222, h: 140, color: 'var(--output)' },
      { id: 'support', label: 'SUPPORT', x: 244, y: 168, w: 222, h: 140, color: 'var(--support)' }
    ],
    hidden: [
      { id: 'contract', label: 'CONTRACT', x: 356, y: 56, w: 110, h: 92, color: 'var(--contract)' },
      { id: 'validator', label: 'VALIDATOR', x: 356, y: 198, w: 110, h: 92, color: 'var(--validator)' }
    ]
  };

  const focusOrder = ['core', 'memory', 'output', 'support'];
  const allOrder = ['core', 'memory', 'output', 'support', 'contract', 'validator'];
  const els = { tiles: {}, labels: {}, hidden: {}, touchStart: null };
  let active = 0;
  let busy = false;
  let revealLayer = false;
  let holdTimer = null;

  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pushLog = (text, strong = '') => {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `<span class="muted">[${stamp()}]</span> ${strong ? `<span class="accent">${strong}</span> ` : ''}${text}`;
    log.appendChild(row);
    while (log.children.length > 5) log.removeChild(log.firstChild);
    log.scrollTop = 9999;
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

  const center = t => ({ cx: t.x + t.w / 2, cy: t.y + t.h / 2 });

  function addBackdrop() {
    mk('rect', { x: 8, y: 8, width: 464, height: 306, fill: 'none', stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1 });
    // subtle modular echoes, not clutter
    [[78, 74], [402, 74], [78, 228], [402, 228]].forEach(([x, y]) => {
      mk('circle', { cx: x, cy: y, r: 22, fill: 'none', stroke: 'rgba(255,255,255,0.05)', 'stroke-width': 1 });
    });
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
    const g = mk('g', { class: `tile ${isHidden ? 'hidden' : 'primary'}`, 'data-node': t.id, transform: `translate(${t.x},${t.y})`, tabindex: '0' });
    const c = center(t);
    const ink = (t.id === 'validator' || t.id === 'support') ? 'rgba(24,24,24,0.9)' : 'rgba(245,243,236,0.96)';

    mk('rect', { x: 0, y: 0, width: t.w, height: t.h, fill: t.color, class: 'tile-rect' }, g);
    mk('rect', { x: 0.5, y: 0.5, width: t.w - 1, height: t.h - 1, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, g);

    // deliberately sparse composition: big form, one secondary accent, tiny label
    const motif = mk('g', { class: 'motif' }, g);
    if (t.id === 'core') shapeCore(motif, c.cx, c.cy, ink);
    if (t.id === 'memory') shapeMemory(motif, c.cx, c.cy, ink);
    if (t.id === 'output') shapeOutput(motif, c.cx, c.cy, ink);
    if (t.id === 'support') shapeSupport(motif, c.cx, c.cy, ink);
    if (t.id === 'contract') shapeContract(motif, c.cx, c.cy, ink);
    if (t.id === 'validator') shapeValidator(motif, c.cx, c.cy, ink);

    // tiny panel note; hidden nodes carry no label by default on the first state
    const label = text(c.cx, t.h - 14, isHidden ? '' : t.label, { class: 'tile-title' }, g);
    els.labels[t.id] = label;

    const noteText = isHidden ? '' : (t.id === 'core' ? 'press / hold' : t.id === 'memory' ? 'tap / hold' : '');
    text(c.cx, 16, noteText, { class: 'tile-note' }, g);

    g.addEventListener('pointerdown', e => {
      e.preventDefault();
      selectTile(t.id);
      holdTimer = setTimeout(() => {
        if (t.id === 'core' || t.id === 'memory') {
          toggleHiddenLayer();
          pushLog(`${t.id.toUpperCase()} layer opened.`, 'HOLD');
        }
      }, 520);
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
    });
  }

  function addHiddenTile(t) {
    const g = mk('g', { class: 'tile hidden', 'data-node': t.id, transform: `translate(${t.x},${t.y})`, opacity: '0', tabindex: '0' });
    const c = center(t);
    const ink = t.id === 'validator' ? 'rgba(24,24,24,0.9)' : 'rgba(245,243,236,0.96)';
    mk('rect', { x: 0, y: 0, width: t.w, height: t.h, fill: t.color, class: 'tile-rect' }, g);
    mk('rect', { x: 0.5, y: 0.5, width: t.w - 1, height: t.h - 1, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, g);
    const motif = mk('g', {}, g);
    if (t.id === 'contract') shapeContract(motif, c.cx, c.cy, ink);
    if (t.id === 'validator') shapeValidator(motif, c.cx, c.cy, ink);
    text(c.cx, t.h - 14, t.label, { class: 'tile-title' }, g);
    g.style.pointerEvents = 'none';
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') triggerFrom(t.id); });
    els.hidden[t.id] = g;
  }

  function selectTile(id) {
    active = focusOrder.indexOf(id) >= 0 ? focusOrder.indexOf(id) : active;
    Object.entries(els.tiles).forEach(([key, el]) => el.classList.toggle('selected', key === id));
    hint.textContent = id === 'core' || id === 'memory'
      ? 'tap / swipe / keys • hold to reveal deeper layer'
      : 'tap / swipe / keys';
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
  pushLog('Panel initialized.');
  pushLog('Four primary nodes loaded.');
  pushLog('Hold core or memory to reveal deeper layer.');

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextTile(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); nextTile(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerFrom(focusOrder[active]); }
    else if (e.key === 'Escape' || e.key === 'Backspace') { pushLog('Back action received.'); }
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
})();
