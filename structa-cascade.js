(() => {
  const svg = document.getElementById('ui');
  const log = document.getElementById('log');
  const runBtn = document.getElementById('runBtn');

  const N = {
    core:      { id: 'core',      label: 'CORE',      icon: '⬢', cls: 'core',      x: 240, y: 104, r: 30, primary: true },
    memory:    { id: 'memory',    label: 'MEMORY',    icon: '▣', cls: 'memory',    x: 158, y: 196, r: 24 },
    contract:  { id: 'contract',  label: 'CONTRACT',  icon: '△', cls: 'contract',  x: 322, y: 196, r: 24 },
    validator: { id: 'validator', label: 'VALIDATOR', icon: '✕', cls: 'validator', x: 158, y: 306, r: 24 },
    output:    { id: 'output',    label: 'OUTPUT',    icon: '◆', cls: 'output',    x: 322, y: 306, r: 24 },
    support:   { id: 'support',   label: 'SUPPORT',   icon: '●', cls: 'support',   x: 240, y: 404, r: 22 }
  };

  const order = ['core', 'memory', 'contract', 'validator', 'output', 'support'];
  const edges = [
    ['core', 'memory'],
    ['core', 'contract'],
    ['memory', 'validator'],
    ['contract', 'output'],
    ['validator', 'support'],
    ['output', 'support']
  ];

  const els = { nodes: {}, edges: [] };
  let busy = false;
  let cascadeTimer = null;

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

  const hexPoints = (x, y, r) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      pts.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  const connect = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return {
      x1: a.x + ux * a.r,
      y1: a.y + uy * a.r,
      x2: b.x - ux * b.r,
      y2: b.y - uy * b.r
    };
  };

  const buildBackdrop = () => {
    for (let y = 36; y <= 444; y += 86) {
      for (let x = 40; x <= 440; x += 86) {
        const shift = ((y / 86) | 0) % 2 ? 43 : 0;
        mk('polygon', {
          points: hexPoints(x + shift, y, 17),
          class: 'grid-hex'
        });
      }
    }
  };

  const buildEdges = () => {
    edges.forEach(([a, b], idx) => {
      const p = connect(N[a], N[b]);
      const line = mk('line', {
        x1: p.x1,
        y1: p.y1,
        x2: p.x2,
        y2: p.y2,
        class: 'connector',
        'data-edge': `${a}-${b}`,
        style: `stroke-dasharray:${Math.max(8, Math.hypot(p.x2-p.x1, p.y2-p.y1) / 1.6)}; stroke-dashoffset:0;`
      });
      els.edges.push({ id: `${a}-${b}`, el: line, a, b });
    });
  };

  const buildNodes = () => {
    Object.values(N).forEach(node => {
      const g = mk('g', { class: 'node', 'data-node': node.id, transform: `translate(${node.x},${node.y})` });
      const shell = mk('polygon', { points: hexPoints(0, 0, node.r), class: `shell ${node.cls}` }, g);
      const icon = mk('text', { x: 0, y: 4, class: 'icon', fill: 'currentColor' }, g);
      icon.textContent = node.icon;
      const label = mk('text', { x: 0, y: node.r + 26, class: 'label', fill: 'currentColor' }, g);
      label.textContent = node.label;
      g.style.color = getComputedStyle(document.documentElement).getPropertyValue(`--${node.cls}`) || '#fff';
      els.nodes[node.id] = g;
    });
  };

  const flashNode = (id) => {
    const el = els.nodes[id];
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 230);
  };

  const flashEdge = (a, b) => {
    const edge = els.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    if (!edge) return;
    edge.el.classList.add('active');
    edge.el.style.strokeDashoffset = '0';
    setTimeout(() => edge.el.classList.remove('active'), 230);
  };

  const runCascade = () => {
    if (busy) return;
    busy = true;
    pushLog('Card received. Starting compact impact chain...', 'TRIGGER');

    const wave = [
      ['core'],
      ['memory', 'contract'],
      ['validator', 'output'],
      ['support']
    ];

    wave.forEach((group, i) => {
      setTimeout(() => {
        if (i > 0) {
          const from = i === 1 ? 'core' : i === 2 ? 'memory' : 'validator';
          const to = i === 1 ? 'memory' : i === 2 ? 'validator' : 'support';
          flashEdge(from, to);
        }
        group.forEach(id => {
          flashNode(id);
          pushLog(`${id.toUpperCase()} activated.`);
        });
      }, i * 220);
    });

    setTimeout(() => {
      flashEdge('core', 'contract');
      flashEdge('contract', 'output');
    }, 480);

    setTimeout(() => {
      pushLog('Validator passed. Output stabilized.');
      pushLog('Compact cascade complete.');
      busy = false;
    }, 1180);
  };

  runBtn.addEventListener('click', runCascade);

  buildBackdrop();
  buildEdges();
  buildNodes();

  pushLog('R1-native layout loaded.');
  pushLog('Compact screen mode active.');
  pushLog('One-action interaction only.');
})();
