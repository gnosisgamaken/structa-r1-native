(() => {
  const svg = document.getElementById('scene');
  const log = document.getElementById('log');
  const logDrawer = document.getElementById('log-drawer');
  const logHandle = document.getElementById('log-handle');
  const logCount = document.getElementById('log-count');
  const capturePreview = document.getElementById('capture-preview');
  const captureThumb = document.getElementById('capture-thumb');
  const capturePreviewCopy = document.getElementById('capture-preview-copy');
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
  let lastCapture = native?.getMemory?.().captures?.slice(-1)[0] || null;
  let wheelLockAt = 0;
  let tiltLockAt = 0;
  let motionArmed = false;

  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const syncLogCount = () => {
    if (logCount) logCount.textContent = `${log.children.length}`;
  };

  const syncCapturePreview = () => {
    const capture = lastCapture || native?.getMemory?.().captures?.slice(-1)[0] || null;
    if (!capturePreview || !capturePreviewCopy || !captureThumb) return;
    if (!capture) {
      captureThumb.hidden = true;
      captureThumb.removeAttribute('src');
      capturePreviewCopy.textContent = 'No capture yet';
      return;
    }
    const img = capture.image_asset?.data || capture.image_asset?.url || '';
    const audio = capture.audio_asset?.data || capture.audio_asset?.url || '';
    if (img) {
      captureThumb.hidden = false;
      captureThumb.src = img;
    } else {
      captureThumb.hidden = true;
      captureThumb.removeAttribute('src');
    }
    capturePreviewCopy.textContent = capture.summary || capture.prompt_text || (audio ? 'Saved voice capture' : 'Saved capture');
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

  const TOP_SAFE_PX = 23;

  const addTopBand = () => {
    mk('rect', {
      x: 8,
      y: TOP_SAFE_PX,
      width: 224,
      height: 18,
      rx: 9,
      fill: 'rgba(255,255,255,0.035)',
      stroke: 'rgba(255,255,255,0.05)',
      'stroke-width': 1
    });
    text(14, TOP_SAFE_PX + 13, 'STRUCTA', {
      class: 'tile-title',
      fill: 'var(--support)',
      'letter-spacing': '0.16em'
    });
    const card = cards[selectedIndex];
    mk('rect', {
      x: 166,
      y: TOP_SAFE_PX + 2,
      width: 58,
      height: 14,
      rx: 6,
      fill: 'rgba(255,255,255,0.07)',
      stroke: 'rgba(255,255,255,0.07)',
      'stroke-width': 1
    });
    text(195, TOP_SAFE_PX + 12, card.title.toUpperCase(), {
      class: 'tile-note',
      fill: 'rgba(246,240,230,0.88)',
      'text-anchor': 'middle',
      'letter-spacing': '0.06em'
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
    syncCapturePreview();
  };

  const setLogDrawer = open => {
    logOpen = open;
    logDrawer.classList.toggle('open', open);
    logDrawer.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  const setActiveVerb = (verb, source = 'mode') => {
    activeVerb = router?.canonicalizeVerb?.(verb) || verb || 'inspect';
    native?.setActiveVerb?.(activeVerb, source);
    pushLog(`Mode ${activeVerb.toUpperCase()}.`, 'MODE');
  };

  const openVoiceSurface = panel => {
    if (window.StructaVoice?.setPanel) window.StructaVoice.setPanel(panel || 'voice');
    window.StructaVoice?.open?.();
    pushLog(`${panel === 'camera' ? 'Camera' : 'Voice'} surface opened.`, 'CAPTURE');
  };

  const openCameraSurface = mode => {
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
    if (slot === 'selected') return { x: 46, y: 34, scale: 1, opacity: 1 };
    if (slot === 'prev') return { x: -12, y: -34, scale: 0.72, opacity: 0.32 };
    return { x: 100, y: 132, scale: 0.72, opacity: 0.32 };
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
    if (selected) group.style.filter = `drop-shadow(0 12px 20px rgba(0,0,0,0.18))`;

    mk('rect', {
      x: 0,
      y: 0,
      width: 150,
      height: 150,
      rx: 14,
      ry: 14,
      fill: card.color,
      stroke: 'rgba(255,255,255,0.12)',
      'stroke-width': 1
    }, group);
    mk('rect', {
      x: 1,
      y: 1,
      width: 148,
      height: 148,
      rx: 12,
      ry: 12,
      fill: 'none',
      stroke: 'rgba(255,255,255,0.08)',
      'stroke-width': 1
    }, group);
    mk('path', {
      d: 'M 12 12 H 138',
      fill: 'none',
      stroke: 'rgba(255,255,255,0.18)',
      'stroke-width': 2,
      'stroke-linecap': 'round'
    }, group);

    text(75, 24, card.title, {
      class: 'tile-title',
      fill: ink,
      'text-anchor': 'middle',
      'letter-spacing': '0.03em'
    }, group);

    const motif = mk('g', { transform: 'translate(75,82)' }, group);
    glyphMap[card.glyph](motif, 0, 0, ink);

    mk('rect', {
      x: 34,
      y: 118,
      width: 82,
      height: 22,
      rx: 7,
      fill: 'rgba(255,255,255,0.10)',
      stroke: 'rgba(255,255,255,0.14)',
      'stroke-width': 1
    }, group);
    text(75, 132, card.pill.toUpperCase(), {
      class: 'tile-note',
      fill: ink,
      'text-anchor': 'middle',
      'letter-spacing': '0.02em'
    }, group);

    group.style.pointerEvents = 'none';
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

  const svgPointFromEvent = event => {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const scaleX = viewBox.width / rect.width;
    const scaleY = viewBox.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  };

  const pickVisibleCard = point => {
    const total = cards.length;
    const prev = (selectedIndex - 1 + total) % total;
    const next = (selectedIndex + 1) % total;
    const visible = [
      { index: prev, slot: 'prev' },
      { index: next, slot: 'next' },
      { index: selectedIndex, slot: 'selected' }
    ];

    const hits = visible
      .map(item => ({
        ...item,
        layout: cardLayoutFor(item.slot),
      }))
      .filter(item => {
        const w = 150 * item.layout.scale;
        const h = 150 * item.layout.scale;
        return point.x >= item.layout.x && point.x <= item.layout.x + w && point.y >= item.layout.y && point.y <= item.layout.y + h;
      })
      .map(item => {
        const centerX = item.layout.x + 75 * item.layout.scale;
        const centerY = item.layout.y + 75 * item.layout.scale;
        const distance = Math.hypot(point.x - centerX, point.y - centerY);
        return { ...item, distance };
      })
      .sort((a, b) => a.distance - b.distance);

    return hits[0] || null;
  };

  svg.addEventListener('pointerup', e => {
    const point = svgPointFromEvent(e);
    const hit = pickVisibleCard(point);
    if (!hit) return;
    if (hit.index === selectedIndex) routeCurrentCard();
    else selectIndex(hit.index, 'FOCUS');
  });

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

  const showCapture = bundle => {
    if (bundle) {
      lastCapture = bundle;
      syncCapturePreview();
      pushLog('Capture stored.', 'MEMORY');
    }
  };

  const selectByWheel = delta => {
    const now = Date.now();
    if (now - wheelLockAt < 220) return;
    wheelLockAt = now;
    if (Math.abs(delta) < 8) return;
    selectNext(delta > 0 ? 1 : -1);
  };

  const onOrientation = event => {
    const gamma = Number(event.gamma || 0);
    const beta = Number(event.beta || 0);
    const now = Date.now();
    if (now - tiltLockAt < 420) return;
    if (Math.abs(gamma) > 18) {
      tiltLockAt = now;
      selectNext(gamma > 0 ? 1 : -1);
      return;
    }
    if (Math.abs(beta) > 28) {
      tiltLockAt = now;
      if (beta > 0) setLogDrawer(true);
      else setLogDrawer(false);
    }
  };

  const armMotion = async () => {
    if (motionArmed) return;
    motionArmed = true;
    try {
      if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function') {
        const granted = await window.DeviceOrientationEvent.requestPermission().catch(() => 'denied');
        if (granted !== 'granted') return;
      }
    } catch (_) {
      return;
    }
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    pushLog('Tilt control ready.', 'MOTION');
  };

  window.addEventListener('wheel', e => {
    if (logOpen) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    selectByWheel(e.deltaY);
  }, { passive: false });

  window.addEventListener('pointerdown', armMotion, { once: true, passive: true });
  window.addEventListener('touchstart', armMotion, { once: true, passive: true });
  window.addEventListener('structa-native-event', event => {
    const detail = event.detail || {};
    if (detail.event_type === 'capture_bundle_stored') {
      showCapture(detail.payload);
    }
  });

  // Home / setup
  render();
  syncCapturePreview();
  native?.emit?.('panel_boot', {
    project_code: projectCode,
    capabilities: native?.getCapabilities?.() || {},
    context: native?.getContext?.() || {}
  });
  syncLogCount();
  setLogDrawer(false);

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
    openCameraSurface,
    showCapture
  });
})();
