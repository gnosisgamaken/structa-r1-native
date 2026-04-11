(() => {
  const svg = document.getElementById('ui');
  const log = document.getElementById('log');
  const runBtn = document.getElementById('runBtn');

  const tiles = [
    { id: 'core',      label: 'CORE',      x: 14,  y: 12,  w: 148, h: 148, color: 'var(--core)' },
    { id: 'memory',    label: 'MEMORY',    x: 166, y: 12,  w: 148, h: 148, color: 'var(--memory)' },
    { id: 'contract',  label: 'CONTRACT',  x: 318, y: 12,  w: 148, h: 148, color: 'var(--contract)' },
    { id: 'validator', label: 'VALIDATOR', x: 14,  y: 172, w: 148, h: 148, color: 'var(--validator)' },
    { id: 'output',    label: 'OUTPUT',    x: 166, y: 172, w: 148, h: 148, color: 'var(--output)' },
    { id: 'support',   label: 'SUPPORT',   x: 318, y: 172, w: 148, h: 148, color: 'var(--support)' }
  ];

  const els = { tiles: {}, edges: [] };
  let busy = false;

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

  const line = (x1, y1, x2, y2, cls = 'outline') => mk('line', { x1, y1, x2, y2, class: cls });
  const rect = (x, y, w, h, attrs = {}, parent = svg) => mk('rect', { x, y, width: w, height: h, ...attrs }, parent);
  const circle = (cx, cy, r, attrs = {}, parent = svg) => mk('circle', { cx, cy, r, ...attrs }, parent);
  const path = (d, attrs = {}, parent = svg) => mk('path', { d, ...attrs }, parent);
  const text = (x, y, content, attrs = {}, parent = svg) => { const t = mk('text', { x, y, ...attrs }, parent); t.textContent = content; return t; };

  const addBackdrop = () => {
    for (let y = 16; y <= 352; y += 56) {
      for (let x = 16; x <= 464; x += 56) {
        const r = 13;
        const pts = [];
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 3 * i + Math.PI / 6;
          pts.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
        }
        mk('polygon', { points: pts.join(' '), class: 'outline' });
      }
    }
  };

  const addTile = t => {
    const g = mk('g', { class: 'tile', 'data-node': t.id, transform: `translate(${t.x},${t.y})` });
    rect(0, 0, t.w, t.h, { fill: t.color }, g);
    rect(0.5, 0.5, t.w - 1, t.h - 1, { fill: 'none', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': 1 }, g);

    const cx = t.w / 2;
    const cy = t.h / 2;
    const ink = t.id === 'validator' || t.id === 'support' ? 'rgba(24,24,24,0.9)' : 'rgba(246,243,236,0.92)';

    if (t.id === 'core') {
      circle(cx, cy, 34, { fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
      circle(cx, cy, 10, { fill: ink }, g);
      path(`M ${cx - 20} ${cy + 18} A 24 24 0 0 1 ${cx + 20} ${cy + 18}`, { fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
    }

    if (t.id === 'memory') {
      rect(cx - 34, cy - 34, 68, 68, { fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
      rect(cx - 14, cy - 14, 28, 28, { fill: ink }, g);
      path(`M ${cx - 36} ${cy + 28} H ${cx + 36}`, { fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
    }

    if (t.id === 'contract') {
      path(`M ${cx} ${cy - 34} L ${cx + 34} ${cy + 28} L ${cx - 34} ${cy + 28} Z`, { fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linejoin': 'round' }, g);
      path(`M ${cx - 16} ${cy + 8} H ${cx + 16}`, { fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
      circle(cx, cy - 1, 8, { fill: ink }, g);
    }

    if (t.id === 'validator') {
      path(`M ${cx - 34} ${cy - 34} L ${cx + 34} ${cy + 34}`, { fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
      path(`M ${cx + 34} ${cy - 34} L ${cx - 34} ${cy + 34}`, { fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
      circle(cx, cy, 10, { fill: ink }, g);
    }

    if (t.id === 'output') {
      path(`M ${cx} ${cy - 34} L ${cx + 34} ${cy} L ${cx} ${cy + 34} L ${cx - 34} ${cy} Z`, { fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linejoin': 'round' }, g);
      path(`M ${cx - 24} ${cy + 10} A 28 28 0 0 1 ${cx + 24} ${cy + 10}`, { fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
      circle(cx, cy - 2, 8, { fill: ink }, g);
    }

    if (t.id === 'support') {
      circle(cx, cy, 34, { fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
      circle(cx, cy, 10, { fill: ink }, g);
      circle(cx - 17, cy - 16, 4, { fill: ink }, g);
      circle(cx + 17, cy + 16, 4, { fill: ink }, g);
    }

    text(cx, t.h - 14, t.label, { class: 'label' }, g);
    els.tiles[t.id] = g;
  };

  const addEdges = () => {
    const e = [
      ['core', 'memory'],
      ['memory', 'contract'],
      ['core', 'validator'],
      ['contract', 'output'],
      ['validator', 'support'],
      ['output', 'support']
    ];
    const centers = id => {
      const t = tiles.find(x => x.id === id);
      return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    };
    e.forEach(([a, b]) => {
      const A = centers(a), B = centers(b);
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const startR = 56, endR = 56;
      const l = line(A.x + ux * startR, A.y + uy * startR, B.x - ux * endR, B.y - uy * endR, 'connector');
      els.edges.push({ a, b, el: l });
    });
  };

  const flash = id => {
    const el = els.tiles[id];
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 220);
  };

  const flashEdge = (a, b) => {
    const edge = els.edges.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!edge) return;
    edge.el.classList.add('active');
    setTimeout(() => edge.el.classList.remove('active'), 220);
  };

  const runComposition = () => {
    if (busy) return;
    busy = true;
    pushLog('Composition received. Activating matrix...', 'TRIGGER');

    const chain = ['core', 'memory', 'contract', 'validator', 'output', 'support'];
    chain.forEach((id, i) => {
      setTimeout(() => {
        flash(id);
        if (i > 0) flashEdge(chain[i - 1], id);
        pushLog(`${id.toUpperCase()} activated.`);
      }, i * 170);
    });

    setTimeout(() => {
      pushLog('Validator passed. Composition stabilized.');
      pushLog('Poster state complete.');
      busy = false;
    }, 1180);
  };

  runBtn.addEventListener('click', runComposition);

  addBackdrop();
  addEdges();
  tiles.forEach(addTile);

  pushLog('Tile matrix loaded.');
  pushLog('Square composition active.');
  pushLog('One-action flow only.');
})();
