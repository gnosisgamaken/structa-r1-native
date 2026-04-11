(() => {
  const svg = document.getElementById('ui');
  const log = document.getElementById('log');
  const runBtn = document.getElementById('runBtn');

  const nodes = [
    {
      id: 'core', label: 'CORE', cls: 'core', x: 40, y: 20, w: 132, h: 132,
      fill: 'var(--core)', symbol: 'circle-ring', motif: 'circle'
    },
    {
      id: 'memory', label: 'MEMORY', cls: 'memory', x: 164, y: 20, w: 132, h: 132,
      fill: 'var(--memory)', symbol: 'square-within', motif: 'square'
    },
    {
      id: 'contract', label: 'CONTRACT', cls: 'contract', x: 288, y: 20, w: 132, h: 132,
      fill: 'var(--contract)', symbol: 'triangle-slice', motif: 'triangle'
    },
    {
      id: 'validator', label: 'VALIDATOR', cls: 'validator', x: 40, y: 184, w: 132, h: 132,
      fill: 'var(--validator)', symbol: 'x-form', motif: 'x'
    },
    {
      id: 'output', label: 'OUTPUT', cls: 'output', x: 164, y: 184, w: 132, h: 132,
      fill: 'var(--output)', symbol: 'diamond-ring', motif: 'diamond'
    },
    {
      id: 'support', label: 'SUPPORT', cls: 'support', x: 288, y: 184, w: 132, h: 132,
      fill: 'var(--support)', symbol: 'dot-grid', motif: 'dot'
    }
  ];

  const order = ['core', 'memory', 'contract', 'validator', 'output', 'support'];
  const edges = [
    ['core', 'memory'],
    ['memory', 'contract'],
    ['core', 'validator'],
    ['contract', 'output'],
    ['validator', 'support'],
    ['output', 'support']
  ];

  const els = { nodes: {}, edges: [] };
  let running = false;

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

  const tileShape = (x, y, w, h) => `${x},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}`;
  const center = n => ({ cx: n.x + n.w / 2, cy: n.y + n.h / 2 });

  const createBackdrop = () => {
    for (let y = 12; y <= 344; y += 56) {
      for (let x = 14; x <= 466; x += 56) {
        const hex = mk('polygon', { points: hexPoints(x, y, 12), class: 'grid' });
      }
    }
  };

  function hexPoints(x, y, r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      pts.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  }

  const connect = (a, b) => {
    const p = center(a);
    const q = center(b);
    const dx = q.cx - p.cx;
    const dy = q.cy - p.cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return {
      x1: p.cx + ux * (a.w * 0.38),
      y1: p.cy + uy * (a.h * 0.38),
      x2: q.cx - ux * (b.w * 0.38),
      y2: q.cy - uy * (b.h * 0.38)
    };
  };

  const addTile = n => {
    const g = mk('g', { class: 'tile', 'data-node': n.id, transform: `translate(${n.x},${n.y})` });

    mk('rect', {
      x: 0, y: 0, width: n.w, height: n.h,
      fill: `var(--${n.cls})`,
      class: 'tile-rect'
    }, g);

    // geometric motif: solid, modular, poster-like
    const c = center(n);
    const cx = n.w / 2;
    const cy = n.h / 2;
    const palette = {
      core: 'rgba(245,243,236,0.95)',
      memory: 'rgba(36,30,20,0.9)',
      contract: 'rgba(245,243,236,0.9)',
      validator: 'rgba(36,30,20,0.88)',
      output: 'rgba(245,243,236,0.9)',
      support: 'rgba(36,30,20,0.9)'
    };
    const ink = palette[n.cls];

    if (n.motif === 'circle') {
      mk('circle', { cx, cy, r: 36, fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
      mk('circle', { cx, cy, r: 12, fill: ink }, g);
      mk('path', { d: `M ${cx - 24} ${cy + 22} A 30 30 0 0 1 ${cx + 24} ${cy + 22}`, fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
    }

    if (n.motif === 'square') {
      mk('rect', { x: 32, y: 32, width: 68, height: 68, fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
      mk('rect', { x: 52, y: 52, width: 28, height: 28, fill: ink }, g);
      mk('path', { d: 'M34 94 H98', fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
    }

    if (n.motif === 'triangle') {
      mk('path', { d: `M ${cx} ${cy - 40} L ${cx + 36} ${cy + 28} L ${cx - 36} ${cy + 28} Z`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linejoin': 'round' }, g);
      mk('path', { d: `M ${cx - 18} ${cy + 10} L ${cx + 18} ${cy + 10}`, fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
      mk('circle', { cx, cy - 2, r: 9, fill: ink }, g);
    }

    if (n.motif === 'x') {
      mk('path', { d: `M ${cx - 32} ${cy - 32} L ${cx + 32} ${cy + 32}`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
      mk('path', { d: `M ${cx + 32} ${cy - 32} L ${cx - 32} ${cy + 32}`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linecap': 'round' }, g);
      mk('circle', { cx, cy, r: 10, fill: ink }, g);
    }

    if (n.motif === 'diamond') {
      mk('path', { d: `M ${cx} ${cy - 40} L ${cx + 40} ${cy} L ${cx} ${cy + 40} L ${cx - 40} ${cy} Z`, fill: 'none', stroke: ink, 'stroke-width': 12, 'stroke-linejoin': 'round' }, g);
      mk('path', { d: `M ${cx - 26} ${cy + 10} A 30 30 0 0 1 ${cx + 26} ${cy + 10}`, fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
      mk('circle', { cx, cy - 2, r: 8, fill: ink }, g);
    }

    if (n.motif === 'dot') {
      mk('circle', { cx, cy, r: 36, fill: 'none', stroke: ink, 'stroke-width': 12 }, g);
      mk('circle', { cx, cy, r: 10, fill: ink }, g);
      mk('circle', { cx: cx - 18, cy: cy - 18, r: 4, fill: ink }, g);
      mk('circle', { cx: cx + 18, cy: cy + 18, r: 4, fill: ink }, g);
    }

    mk('text', { x: cx, y: n.h - 14, class: 'tile-label' }, g).textContent = n.label;
    els.nodes[n.id] = g;
  };

  const createEdges = () => {
    edges.forEach(([a, b]) => {
      const line = connect(nodes.find(n => n.id === a), nodes.find(n => n.id === b));
      const l = mk('line', { ...line, class: 'connector', 'data-edge': `${a}-${b}` });
      els.edges.push({ id: `${a}-${b}`, el: l, a, b });
    });
  };

  const flashNode = id => {
    const el = els.nodes[id];
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 240);
  };

  const flashEdge = (a, b) => {
    const edge = els.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    if (!edge) return;
    edge.el.classList.add('active');
    setTimeout(() => edge.el.classList.remove('active'), 240);
  };

  const runCascade = () => {
    if (running) return;
    running = true;
    pushLog('Card received. Starting modular cascade...', 'TRIGGER');

    const seq = [
      ['core'],
      ['memory'],
      ['contract'],
      ['validator'],
      ['output'],
      ['support']
    ];

    seq.forEach((group, i) => {
      setTimeout(() => {
        if (i > 0) flashEdge(seq[i - 1][0], group[0]);
        group.forEach(id => {
          flashNode(id);
          pushLog(`${id.toUpperCase()} activated.`);
        });
      }, i * 180);
    });

    setTimeout(() => {
      pushLog('Validator passed. Output stabilized.');
      pushLog('Compact cascade complete.');
      running = false;
    }, 1220);
  };

  runBtn.addEventListener('click', runCascade);

  createBackdrop();
  createEdges();
  nodes.forEach(addTile);

  pushLog('Tile matrix loaded.');
  pushLog('R1 screen profile active.');
  pushLog('One-action flow only.');
})();
