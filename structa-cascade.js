(() => {
  const svg = document.getElementById('ui');
  const log = document.getElementById('log');
  const runBtn = document.getElementById('runBtn');

  const nodes = [
    { id: 'core', label: 'CORE', icon: '⬢', cls: 'core', x: 210, y: 116 },
    { id: 'memory', label: 'MEMORY', icon: '◫', cls: 'memory', x: 118, y: 245 },
    { id: 'contract', label: 'CONTRACT', icon: '△', cls: 'contract', x: 302, y: 245 },
    { id: 'validator', label: 'VALIDATOR', icon: '✕', cls: 'validator', x: 118, y: 386 },
    { id: 'output', label: 'OUTPUT', icon: '◆', cls: 'output', x: 302, y: 386 },
    { id: 'support', label: 'SUPPORT', icon: '◯', cls: 'support', x: 210, y: 525 }
  ];

  const edges = [
    ['core', 'memory'],
    ['core', 'contract'],
    ['memory', 'validator'],
    ['contract', 'output'],
    ['validator', 'support'],
    ['output', 'support']
  ];

  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const els = { nodes: {}, edges: [] };

  const timestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const pushLog = (text, strong = '') => {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `<span class="muted">[${timestamp()}]</span> ${strong ? `<strong>${strong}</strong> ` : ''}${text}`;
    log.appendChild(row);
    while (log.children.length > 5) log.removeChild(log.firstChild);
  };

  const mk = (name, attrs = {}, parent = svg) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.appendChild(el);
    return el;
  };

  const hexPoints = (x, y, r = 34) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      pts.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  const connectPoint = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    return {
      x1: from.x + nx * 35,
      y1: from.y + ny * 35,
      x2: to.x - nx * 35,
      y2: to.y - ny * 35
    };
  };

  const build = () => {
    // faint hex grid backdrop inside SVG to feel structural, not busy
    for (let y = 40; y <= 580; y += 92) {
      for (let x = 56; x <= 364; x += 92) {
        mk('polygon', {
          points: hexPoints(x + ((y / 92) % 2 ? 46 : 0), y, 18),
          fill: 'none',
          stroke: 'rgba(255,255,255,0.05)',
          'stroke-width': '1'
        });
      }
    }

    edges.forEach(([a, b]) => {
      const p = connectPoint(nodeById[a], nodeById[b]);
      const line = mk('line', {
        x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2,
        class: 'connector'
      });
      els.edges.push({ id: `${a}-${b}`, el: line, a, b });
    });

    nodes.forEach(node => {
      const g = mk('g', { class: `node-shell`, 'data-node': node.id, transform: `translate(${node.x},${node.y})` });
      const hex = mk('use', { href: '#hex', class: `node-hex ${node.cls}` }, g);
      const icon = mk('text', { x: 0, y: 8, class: 'icon', fill: 'currentColor' }, g);
      icon.textContent = node.icon;
      const label = mk('text', { x: 0, y: 60, class: 'label', fill: 'currentColor' }, g);
      label.textContent = node.label;
      g.style.color = getComputedStyle(document.documentElement).getPropertyValue(`--${node.cls}`) || '#fff';
      els.nodes[node.id] = g;
    });

    pushLog('System initialized.', 'Structa');
    pushLog('Six-node lattice loaded.');
    pushLog('No canvas. SVG only.');
  };

  const flash = (id) => {
    const el = els.nodes[id];
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 520);
  };

  const edgeFlash = (a, b) => {
    const edge = els.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    if (!edge) return;
    edge.el.classList.add('active');
    setTimeout(() => edge.el.classList.remove('active'), 520);
  };

  const runCascade = () => {
    pushLog('Card received. Executing impact chain...', 'TRIGGER');
    const chain = ['core', 'memory', 'contract', 'validator', 'output', 'support'];
    chain.forEach((id, i) => {
      setTimeout(() => {
        flash(id);
        if (i > 0) edgeFlash(chain[i - 1], id);
        pushLog(`${id.toUpperCase()} activated.`);
      }, i * 220);
    });
    setTimeout(() => {
      pushLog('Validator passed. Output stabilized.');
      pushLog('Cascade complete.');
    }, 1450);
  };

  runBtn.addEventListener('click', runCascade);
  build();
})();
