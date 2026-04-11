(() => {
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const statusTitle = document.getElementById('statusTitle');
  const clock = document.getElementById('clock');
  const backBtn = document.getElementById('backBtn');

  const tiles = [
    { id: 'core',      x: 14,  y: 12,  w: 148, h: 148, cls: 'tile-core',      fill: 'var(--core)' },
    { id: 'memory',    x: 166, y: 12,  w: 148, h: 148, cls: 'tile-memory',    fill: 'var(--memory)' },
    { id: 'contract',  x: 318, y: 12,  w: 148, h: 148, cls: 'tile-contract',  fill: 'var(--contract)' },
    { id: 'validator', x: 14,  y: 172, w: 148, h: 148, cls: 'tile-validator', fill: 'var(--validator)' },
    { id: 'output',    x: 166, y: 172, w: 148, h: 148, cls: 'tile-output',    fill: 'var(--output)' },
    { id: 'support',   x: 318, y: 172, w: 148, h: 148, cls: 'tile-support',   fill: 'var(--support)' }
  ];

  const ids = tiles.map(t => t.id);
  const els = { tiles: {}, centers: {}, shapes: {}, labels: {} };
  let activeIndex = 0;
  let busy = false;
  let touchStart = null;

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

  const centers = t => ({ cx: t.x + t.w / 2, cy: t.y + t.h / 2 });

  function updateClock() {
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(name) {
    statusTitle.textContent = name.toUpperCase();
  }

  function addBackdrop() {
    // very faint framing lines to give a printed-panel feel without clutter
    mk('rect', { x: 8, y: 8, width: 464, height: 372, fill: 'none', stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1 });
  }

  function addTile(tile) {
    const g = mk('g', { class: `tile ${tile.cls}`, 'data-node': tile.id, transform: `translate(${tile.x},${tile.y})`, tabindex: '0' });
    const c = centers(tile);
    els.centers[tile.id] = c;
    els.tiles[tile.id] = g;

    mk('rect', { x: 0, y: 0, width: tile.w, height: tile.h, fill: tile.fill, class: 'tile-rect' }, g);
    mk('rect', { x: 0.5, y: 0.5, width: tile.w - 1, height: tile.h - 1, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, g);

    const cx = tile.w / 2;
    const cy = tile.h / 2;
    const left = cx - 36;
    const right = cx + 36;
    const top = cy - 36;
    const bottom = cy + 36;
    const ink = tile.id === 'validator' || tile.id === 'support' ? 'rgba(30,24,20,0.92)' : 'rgba(245,243,236,0.96)';

    // motif group is intentionally large and bold—more poster than UI icon.
    const motif = mk('g', { class: 'motif' }, g);

    if (tile.id === 'core') {
      mk('circle', { cx, cy, r: 34, class: 'tile-ring', stroke: ink }, motif);
      mk('circle', { cx, cy, r: 11, class: 'ring-dot', fill: ink }, motif);
      mk('path', { d: `M ${cx - 22} ${cy + 18} A 26 26 0 0 1 ${cx + 22} ${cy + 18}`, class: 'crescent', stroke: ink }, motif);
      mk('circle', { cx: cx - 13, cy: cy - 12, r: 3.5, class: 'arc', fill: ink }, motif);
    }

    if (tile.id === 'memory') {
      mk('rect', { x: cx - 34, y: cy - 34, width: 68, height: 68, class: 'outer', stroke: ink }, motif);
      mk('rect', { x: cx - 14, y: cy - 14, width: 28, height: 28, class: 'inner', fill: ink }, motif);
      mk('path', { d: `M ${left} ${cy + 26} H ${right}`, class: 'bar', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, motif);
    }

    if (tile.id === 'contract') {
      mk('path', { d: `M ${cx} ${top} L ${right} ${cy + 28} L ${left} ${cy + 28} Z`, class: 'triangle', stroke: ink }, motif);
      mk('path', { d: `M ${cx - 16} ${cy + 8} H ${cx + 16}`, class: 'bar', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, motif);
      mk('circle', { cx: cx, cy: cy - 1, r: 8, class: 'dot', fill: ink }, motif);
    }

    if (tile.id === 'validator') {
      mk('path', { d: `M ${left} ${top} L ${right} ${bottom}`, class: 'xline', stroke: ink }, motif);
      mk('path', { d: `M ${right} ${top} L ${left} ${bottom}`, class: 'xline', stroke: ink }, motif);
      mk('circle', { cx, cy, r: 10, class: 'dot', fill: ink }, motif);
    }

    if (tile.id === 'output') {
      mk('path', { d: `M ${cx} ${top} L ${right} ${cy} L ${cx} ${bottom} L ${left} ${cy} Z`, class: 'diamond', stroke: ink }, motif);
      mk('path', { d: `M ${cx - 24} ${cy + 10} A 28 28 0 0 1 ${cx + 24} ${cy + 10}`, class: 'crescent', stroke: ink }, motif);
      mk('circle', { cx: cx, cy: cy - 2, r: 8, class: 'dot', fill: ink }, motif);
    }

    if (tile.id === 'support') {
      mk('circle', { cx, cy, r: 34, class: 'orbit', stroke: ink }, motif);
      mk('circle', { cx, cy, r: 10, class: 'dot', fill: ink }, motif);
      mk('circle', { cx: cx - 17, cy: cy - 16, r: 4, class: 'dot', fill: ink }, motif);
      mk('circle', { cx: cx + 17, cy: cy + 16, r: 4, class: 'dot', fill: ink }, motif);
    }

    const label = text(cx, tile.h - 14, tile.id.toUpperCase(), { class: 'tile-name' }, g);
    els.labels[tile.id] = label;

    const activate = () => triggerFrom(tile.id);
    g.addEventListener('pointerdown', e => {
      e.preventDefault();
      selectTile(tile.id);
      activate();
    });
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectTile(tile.id);
        activate();
      }
    });
  }

  function selectTile(id) {
    activeIndex = ids.indexOf(id);
    Object.entries(els.tiles).forEach(([key, el]) => {
      el.classList.toggle('selected', key === id);
    });
    setStatus(id);
  }

  function flash(id) {
    const el = els.tiles[id];
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 240);
  }

  function runSequence(startId) {
    if (busy) return;
    busy = true;
    const start = ids.indexOf(startId);
    const seq = [...ids.slice(start), ...ids.slice(0, start)];
    pushLog(`Composition start: ${startId.toUpperCase()}`, 'TRIGGER');

    seq.forEach((id, i) => {
      setTimeout(() => {
        flash(id);
        pushLog(`${id.toUpperCase()} active.`);
      }, i * 160);
    });

    setTimeout(() => {
      pushLog('Composition stabilized.');
      pushLog('Panel state complete.');
      busy = false;
    }, seq.length * 160 + 140);
  }

  function triggerFrom(id) {
    selectTile(id);
    runSequence(id);
  }

  function nextTile(dir) {
    activeIndex = (activeIndex + dir + ids.length) % ids.length;
    selectTile(ids[activeIndex]);
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextTile(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextTile(-1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      triggerFrom(ids[activeIndex]);
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      pushLog('Back action received.');
    }
  });

  backBtn.addEventListener('click', () => {
    pushLog('Back action received.');
    if (history.length > 1) history.back();
  });

  svg.addEventListener('pointerdown', e => {
    touchStart = { x: e.clientX, y: e.clientY };
  });
  svg.addEventListener('pointerup', e => {
    if (!touchStart) return;
    const dx = e.clientX - touchStart.x;
    const dy = e.clientY - touchStart.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    touchStart = null;
    if (Math.max(adx, ady) < 12) return;
    if (adx > ady) nextTile(dx > 0 ? 1 : -1);
    else if (dy < 0) triggerFrom(ids[activeIndex]);
  });

  function init() {
    addBackdrop();
    tiles.forEach(addTile);
    selectTile(ids[0]);
    updateClock();
    setInterval(updateClock, 1000);
    pushLog('Panel initialized.');
    pushLog('Touch, swipe, and key input enabled.');
    pushLog('One action, full-screen composition.');
  }

  init();
})();
