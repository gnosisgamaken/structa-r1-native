// Structa R1 — UI Surfaces Figma Plugin
// Generates all 7 surfaces at 240×292 (R1 native resolution)
// with interaction annotations for designer handoff.

const W = 240;
const H = 292;
const GAP = 48;

const COLORS = {
  show:      { bg: '#77d5ff', bgDark: '#5bc0eb', label: 'SHOW' },
  tell:      { bg: '#92ff9d', bgDark: '#6bdf77', label: 'TELL' },
  know:      { bg: '#f8c15d', bgDark: '#e0a830', label: 'KNOW' },
  now:       { bg: '#ff8a65', bgDark: '#e8673d', label: 'NOW' },
  home:      { bg: '#070707', bgDark: '#111111', label: 'HOME' },
  log:       { bg: '#1a1a1a', bgDark: '#0d0d0d', label: 'LOG' },
  triangle:  { bg: '#141414', bgDark: '#0a0a0a', label: 'TRIANGLE' },
};

const TEXT_WARM    = { r: 244/255, g: 239/255, b: 228/255 };
const TEXT_MID     = { r: 138/255, g: 132/255, b: 122/255 };
const TEXT_DARK    = { r: 42/255,  g: 37/255,  b: 31/255  };
const WHITE        = { r: 1, g: 1, b: 1 };
const BLACK        = { r: 0, g: 0, b: 0 };
const DANGER       = { r: 1, g: 0.267, b: 0.267 };
const TRANSPARENT  = { r: 0, g: 0, b: 0, a: 0 };

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}

async function loadFonts() {
  try { await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); } catch(_) {}
  try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch(_) {}
  try { await figma.loadFontAsync({ family: 'Inter', style: 'Bold' }); } catch(_) {}
}

function makeFrame(name, x, y) {
  const f = figma.createFrame();
  f.name = name;
  f.resize(W, H);
  f.x = x;
  f.y = y;
  f.clipsContent = true;
  return f;
}

function rect(parent, x, y, w, h, color, opacity) {
  const r = figma.createRectangle();
  r.x = x; r.y = y;
  r.resize(w, h);
  r.fills = [{ type: 'SOLID', color, opacity: opacity !== undefined ? opacity : 1 }];
  parent.appendChild(r);
  return r;
}

function circle(parent, cx, cy, d, color, opacity) {
  const e = figma.createEllipse();
  e.resize(d, d);
  e.x = cx - d / 2;
  e.y = cy - d / 2;
  e.fills = [{ type: 'SOLID', color, opacity: opacity !== undefined ? opacity : 1 }];
  parent.appendChild(e);
  return e;
}

function text(parent, content, x, y, size, color, align, opacity) {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: size >= 20 ? 'Bold' : size >= 13 ? 'Medium' : 'Regular' };
  t.characters = content;
  t.fontSize = size;
  t.fills = [{ type: 'SOLID', color, opacity: opacity !== undefined ? opacity : 1 }];
  t.textAlignHorizontal = align || 'LEFT';
  t.x = x; t.y = y;
  parent.appendChild(t);
  return t;
}

function annotationBox(parent, content, y) {
  const bg = rect(parent, 0, y, W, 1, BLACK, 0);
  const box = figma.createFrame();
  box.name = '📝 Interaction Note';
  box.resize(W - 16, 1);
  box.x = 8; box.y = y;
  box.fills = [{ type: 'SOLID', color: { r: 0.95, g: 0.88, b: 1 }, opacity: 0.92 }];
  box.cornerRadius = 4;
  parent.appendChild(box);

  const lines = content.split('\n');
  let ty = 6;
  for (const line of lines) {
    const isHeader = line.startsWith('▶');
    const t = figma.createText();
    t.fontName = { family: 'Inter', style: isHeader ? 'Medium' : 'Regular' };
    t.characters = line;
    t.fontSize = isHeader ? 9 : 8;
    t.fills = [{ type: 'SOLID', color: { r: 0.3, g: 0.1, b: 0.5 } }];
    t.x = 6; t.y = ty;
    t.resize(W - 16 - 12, t.height);
    try { t.textAutoResize = 'HEIGHT'; } catch(_) {}
    box.appendChild(t);
    ty += isHeader ? 13 : 11;
  }
  box.resize(W - 16, ty + 6);
  return box;
}

// ─── HOME ──────────────────────────────────────────────────────────────
function buildHome(x) {
  const f = makeFrame('HOME — Card Stack', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#070707'));

  const cards = [
    { id: 'show', color: '#77d5ff', icon: '◉', label: 'show', role: 'capture image', y: 32, scale: 'hero' },
    { id: 'tell', color: '#92ff9d', icon: '◎', label: 'tell', role: 'voice capture', y: 12, scale: 'stack-1' },
    { id: 'know', color: '#f8c15d', icon: '◈', label: 'know', role: 'signals & asks', y: 24, scale: 'stack-2', dot: true, dotColor: '#f8c15d' },
    { id: 'now',  color: '#ff8a65', icon: '◆', label: 'now',  role: 'act & decide',  y: 36, scale: 'stack-3', dot: true, dotColor: '#ff4444' },
  ];

  // stack cards (rendered back to front)
  for (let i = 3; i >= 1; i--) {
    const card = cards[i];
    const scale = 1 - i * 0.12;
    const cw = Math.round(W * scale);
    const ch = Math.round(72 * scale);
    const cx = Math.round((W - cw) / 2);
    const cy = 190 + (i - 1) * 8;
    const cr = figma.createFrame();
    cr.name = `Stack Card — ${card.label.toUpperCase()}`;
    cr.resize(cw, ch);
    cr.x = cx; cr.y = cy;
    cr.fills = [{ type: 'SOLID', color: hexToRgb(card.color) }];
    cr.cornerRadius = 10;
    f.appendChild(cr);
    text(cr, card.icon, 8, ch / 2 - 8, 14, TEXT_DARK);
    text(cr, card.label, 28, ch / 2 - 7, 12, TEXT_DARK);
    if (card.dot) {
      const dot = figma.createEllipse();
      dot.resize(8, 8);
      dot.x = cw - 14; dot.y = 4;
      dot.fills = [{ type: 'SOLID', color: hexToRgb(card.dotColor) }];
      cr.appendChild(dot);
    }
  }

  // hero card
  const hero = figma.createFrame();
  hero.name = 'Hero Card — SHOW';
  hero.resize(150, 150);
  hero.x = (W - 150) / 2;
  hero.y = 28;
  hero.fills = [{ type: 'SOLID', color: hexToRgb('#77d5ff') }];
  hero.cornerRadius = 14;
  f.appendChild(hero);
  text(hero, '◉', 18, 20, 30, TEXT_DARK);
  text(hero, 'show', 18, 68, 22, TEXT_DARK);
  text(hero, 'capture image', 18, 96, 11, TEXT_DARK, 'LEFT', 0.6);

  // log preview strip
  const logStrip = figma.createFrame();
  logStrip.name = 'Log Preview Strip';
  logStrip.resize(W, 24);
  logStrip.x = 0; logStrip.y = H - 24;
  logStrip.fills = [{ type: 'SOLID', color: hexToRgb('#070707'), opacity: 0.9 }];
  f.appendChild(logStrip);
  text(logStrip, '— voice interpreted · 2s ago', 8, 6, 9, TEXT_MID);

  // annotations
  const ann = annotationBox(f,
    '▶ GESTURES\nScroll ↕  cycle hero card (HOME loops through all 4)\nTap hero  open that surface (instant fill)\nTap stack  select + make hero\nPTT down  jump to SHOW or TELL immediately\nPTT up  execute capture, return here\nDouble side-click  open Project Switcher\n▶ LOGIC\nNotification dots pulse: gold = KNOW (new insight), red = NOW (blocker)\nLog strip always shows last activity\nCards maintain order: SHOW → TELL → KNOW → NOW', H - 148);
  ann.y = H - ann.height;

  return f;
}

// ─── SHOW ──────────────────────────────────────────────────────────────
function buildShow(x) {
  const f = makeFrame('SHOW — Camera Surface', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#000000'));
  rect(f, 0, 0, W, H, hexToRgb('#77d5ff'), 0.08);

  // camera feed placeholder
  const cam = figma.createRectangle();
  cam.name = 'Camera Feed (live)';
  cam.resize(W, H);
  cam.x = 0; cam.y = 0;
  cam.fills = [{ type: 'SOLID', color: hexToRgb('#0a1a24') }];
  cam.cornerRadius = 0;
  f.appendChild(cam);
  text(f, '[ camera feed ]', W/2 - 44, H/2 - 7, 11, TEXT_MID, 'CENTER', 0.4);

  // crosshair
  rect(f, W/2 - 15, H/2 - 1, 30, 2, WHITE, 0.25);
  rect(f, W/2 - 1, H/2 - 15, 2, 30, WHITE, 0.25);

  // top chrome
  rect(f, 0, 0, W, 32, hexToRgb('#000000'), 0.5);
  text(f, '← back', 10, 10, 11, WHITE, 'LEFT', 0.7);
  text(f, 'SHOW', W/2 - 16, 10, 11, hexToRgb('#77d5ff'), 'LEFT', 0.9);
  text(f, '⇄ flip', W - 46, 10, 11, WHITE, 'LEFT', 0.7);

  // capture button
  const capBtn = figma.createEllipse();
  capBtn.name = 'Capture Button';
  capBtn.resize(44, 44);
  capBtn.x = W/2 - 22; capBtn.y = H - 60;
  capBtn.fills = [{ type: 'SOLID', color: WHITE }];
  f.appendChild(capBtn);
  const capInner = figma.createEllipse();
  capInner.resize(36, 36);
  capInner.x = W/2 - 18; capInner.y = H - 56;
  capInner.fills = [{ type: 'SOLID', color: hexToRgb('#77d5ff') }];
  f.appendChild(capInner);

  const ann = annotationBox(f,
    '▶ GESTURES\nTap anywhere / PTT release  capture frame\nScroll  flip camera (environment ↔ selfie)\nBack  return to HOME (no capture)\n▶ LOGIC\nCapture is instant — image stored locally first\nAI analysis queued async (never blocks gesture path)\nFailed analysis → surfaced as blocker in NOW\nVoice annotation: hold PTT while framing to attach note', H - 112);
  ann.y = H - ann.height;

  return f;
}

// ─── TELL ──────────────────────────────────────────────────────────────
function buildTell(x) {
  const f = makeFrame('TELL — Voice Surface', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#92ff9d'));

  // mic glyph
  const micOuter = figma.createEllipse();
  micOuter.resize(64, 64);
  micOuter.x = W/2 - 32; micOuter.y = 80;
  micOuter.fills = [{ type: 'SOLID', color: hexToRgb('#2a3d2e'), opacity: 0.18 }];
  f.appendChild(micOuter);
  text(f, '🎤', W/2 - 16, 93, 28, TEXT_DARK, 'LEFT');

  text(f, 'listening', W/2, 162, 13, TEXT_DARK, 'CENTER', 0.7);

  // waveform bars
  const barHeights = [6, 10, 18, 28, 18, 10, 6, 10, 18, 14, 8];
  const barW = 4;
  const totalW = barHeights.length * (barW + 3) - 3;
  let bx = W/2 - totalW/2;
  for (const bh of barHeights) {
    rect(f, bx, 190 - bh/2, barW, bh, TEXT_DARK, 0.35);
    bx += barW + 3;
  }

  // transcript placeholder
  const tp = figma.createFrame();
  tp.name = 'Transcript Preview';
  tp.resize(W - 32, 36);
  tp.x = 16; tp.y = 216;
  tp.fills = [{ type: 'SOLID', color: hexToRgb('#2a3d2e'), opacity: 0.12 }];
  tp.cornerRadius = 8;
  f.appendChild(tp);
  text(tp, '"voice transcript appears here…"', 8, 10, 9, TEXT_DARK, 'LEFT', 0.4);

  // back affordance
  text(f, '← back (cancel)', 10, 10, 11, TEXT_DARK, 'LEFT', 0.5);

  const ann = annotationBox(f,
    '▶ GESTURES\nPTT release  stop listening → queue interpretation\nBack  cancel recording, return HOME (no save)\n▶ LOGIC\nTranscript shown live as STT produces it\nOn release: transcript stored immediately\nLLM interpretation queued async\nResult appears in KNOW (signal/question/decision)\nProject title generation triggered if first capture\nAuto-returns HOME after queue entry confirmed', H - 112);
  ann.y = H - ann.height;

  return f;
}

// ─── KNOW ──────────────────────────────────────────────────────────────
function buildKnow(x) {
  const f = makeFrame('KNOW — Insights Browser', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#f8c15d'));

  text(f, 'know', 12, 10, 22, TEXT_DARK, 'LEFT', 0.9);

  // lane tabs
  const lanes = ['asks', 'signals', 'loop', 'decided'];
  const tabW = (W - 16) / 4;
  lanes.forEach((lane, i) => {
    const active = i === 0;
    const tb = figma.createFrame();
    tb.name = `Tab — ${lane}`;
    tb.resize(tabW - 2, 22);
    tb.x = 8 + i * tabW; tb.y = 38;
    tb.fills = [{ type: 'SOLID', color: active ? hexToRgb('#e0a830') : hexToRgb('#f8c15d'), opacity: active ? 1 : 0.4 }];
    tb.cornerRadius = 4;
    f.appendChild(tb);
    text(tb, lane, (tabW - 2) / 2 - lane.length * 3, 5, 9, TEXT_DARK, 'LEFT', active ? 1 : 0.6);
  });

  // filter chip
  const chip = figma.createFrame();
  chip.name = 'Filter Chip';
  chip.resize(48, 16);
  chip.x = 8; chip.y = 66;
  chip.fills = [{ type: 'SOLID', color: hexToRgb('#e0a830'), opacity: 0.5 }];
  chip.cornerRadius = 8;
  f.appendChild(chip);
  text(chip, 'latest', 4, 3, 8, TEXT_DARK, 'LEFT', 0.8);

  // items list
  const items = [
    { kind: '?', body: 'What is the deployment target?', status: 'open' },
    { kind: '?', body: 'Do we need auth on the NOW surface?', status: 'open' },
    { kind: '?', body: 'Should triangle synthesis auto-post?', status: 'open' },
  ];
  items.forEach((item, i) => {
    const iy = 90 + i * 54;
    const card = figma.createFrame();
    card.name = `Ask — ${i + 1}`;
    card.resize(W - 16, 46);
    card.x = 8; card.y = iy;
    card.fills = [{ type: 'SOLID', color: hexToRgb('#2a1a00'), opacity: 0.07 }];
    card.cornerRadius = 8;
    f.appendChild(card);
    text(card, item.kind, 6, 8, 11, TEXT_DARK, 'LEFT', 0.5);
    text(card, item.body, 20, 8, 10, TEXT_DARK, 'LEFT', 0.85);
    text(card, item.status, 20, 28, 8, TEXT_DARK, 'LEFT', 0.4);
  });

  // detail affordance
  text(f, '→ tap to expand · scroll to browse lanes', 8, 260, 8, TEXT_DARK, 'LEFT', 0.4);

  const ann = annotationBox(f,
    '▶ GESTURES\nScroll ↕  switch lanes (asks / signals / loop / decided)\nTap item  open Detail view (full body, answer button)\nLong-press  cycle filter (latest / priority / source)\nBack from detail  return to Browse\nBack from browse  return HOME\nSide click  speak answer to focused question\n▶ LOGIC\n4 lanes: asks = open questions, signals = insights,\nloop = things stuck, decided = locked decisions\nPulsing gold dot on HOME when new ask arrives\nAll items from async queue enrichment', H - 136);
  ann.y = H - ann.height;

  return f;
}

// ─── NOW ───────────────────────────────────────────────────────────────
function buildNow(x) {
  const f = makeFrame('NOW — Action Surface', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#ff8a65'));

  text(f, 'now', 12, 10, 22, TEXT_DARK, 'LEFT', 0.9);

  // project header
  text(f, 'My Project', 12, 40, 11, TEXT_DARK, 'LEFT', 0.6);

  // "since last time" section
  const since = figma.createFrame();
  since.name = 'Since Last Time';
  since.resize(W - 16, 36);
  since.x = 8; since.y = 56;
  since.fills = [{ type: 'SOLID', color: hexToRgb('#2a1000'), opacity: 0.08 }];
  since.cornerRadius = 8;
  f.appendChild(since);
  text(since, 'since last time', 8, 4, 8, TEXT_DARK, 'LEFT', 0.45);
  text(since, '3 new signals · 1 question answered · 1 blocker', 8, 18, 9, TEXT_DARK, 'LEFT', 0.7);

  // decision box
  const decBox = figma.createFrame();
  decBox.name = 'Decision Box';
  decBox.resize(W - 16, 72);
  decBox.x = 8; decBox.y = 100;
  decBox.fills = [{ type: 'SOLID', color: hexToRgb('#1a0800'), opacity: 0.88 }];
  decBox.cornerRadius = 10;
  f.appendChild(decBox);
  text(decBox, 'pending decision', 10, 8, 8, hexToRgb('#ff8a65'), 'LEFT', 0.7);
  text(decBox, 'Deploy to autoscale\nor keep static?', 10, 22, 12, WHITE, 'LEFT', 0.92);

  // 3 option buttons
  const options = ['autoscale (recommended)', 'keep static', 'research more'];
  options.forEach((opt, i) => {
    const btn = figma.createFrame();
    btn.name = `Option ${i + 1}`;
    btn.resize(W - 16, 20);
    btn.x = 8; btn.y = 182 + i * 26;
    btn.fills = [{ type: 'SOLID', color: i === 0 ? hexToRgb('#1a0800') : hexToRgb('#ff8a65'), opacity: i === 0 ? 0.75 : 0.3 }];
    btn.cornerRadius = 6;
    f.appendChild(btn);
    text(btn, opt, 8, 4, 9, i === 0 ? WHITE : TEXT_DARK, 'LEFT', i === 0 ? 1 : 0.7);
  });

  // next move
  text(f, 'next move', 8, 262, 8, TEXT_DARK, 'LEFT', 0.45);
  text(f, 'check server logs before deploy', 8, 273, 9, TEXT_DARK, 'LEFT', 0.75);

  // footer stats
  text(f, '12 caps  ·  8 signals  ·  3 asks', 8, H - 14, 8, TEXT_DARK, 'LEFT', 0.35);

  const ann = annotationBox(f,
    '▶ GESTURES\nTap option  execute decision (lock to decided, update KNOW)\nSide click  confirm first/highlighted option\nBack  skip decision, return HOME\nDouble side-click  open Project Switcher\n▶ LOGIC\nDecisions sourced from async impact-chain reasoning\nOrange pulse dot on HOME = pending decision or blocker\nRed dot = urgent blocker (danger state)\nNext move is always 1 action, never a list\nFooter: caps = total captures, signals = processed items', H - 124);
  ann.y = H - ann.height;

  return f;
}

// ─── LOG ───────────────────────────────────────────────────────────────
function buildLog(x) {
  const f = makeFrame('LOG — Activity Drawer', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#0d0d0d'));

  // home peek behind
  rect(f, 0, 0, W, 100, hexToRgb('#070707'));
  text(f, '[ home peek — above drawer ]', W/2 - 60, 42, 9, TEXT_MID, 'LEFT', 0.3);

  // drawer handle
  const handle = figma.createFrame();
  handle.name = 'Drawer Handle';
  handle.resize(W, 24);
  handle.x = 0; handle.y = 100;
  handle.fills = [{ type: 'SOLID', color: hexToRgb('#1a1a1a') }];
  f.appendChild(handle);
  rect(handle, W/2 - 16, 10, 32, 3, hexToRgb('#555555'), 0.7);
  text(handle, 'log', W/2 - 6, 6, 9, TEXT_MID, 'LEFT', 0.6);

  // drawer body
  rect(f, 0, 124, W, H - 124, hexToRgb('#141414'));

  // queue / phase stats row
  const statsRow = figma.createFrame();
  statsRow.name = 'Queue / Phase Stats';
  statsRow.resize(W, 20);
  statsRow.x = 0; statsRow.y = 126;
  statsRow.fills = [];
  f.appendChild(statsRow);
  text(statsRow, 'queue 2', 8, 4, 8, hexToRgb('#f8c15d'), 'LEFT', 0.8);
  text(statsRow, 'phase: enrich', 64, 4, 8, TEXT_MID, 'LEFT', 0.6);
  text(statsRow, 'ok: 14  fail: 1', W - 70, 4, 8, TEXT_MID, 'LEFT', 0.5);

  // activity list
  const entries = [
    { time: '15:03', kind: 'voice', body: 'voice interpreted · "deploy this weekend"' },
    { time: '15:01', kind: 'image', body: 'image analyzed · server diagram captured' },
    { time: '14:58', kind: 'chain', body: 'impact chain · 2 signals merged' },
    { time: '14:52', kind: 'voice', body: 'voice interpreted · "check the logs first"' },
    { time: '14:48', kind: 'fail',  body: 'analysis stalled · added to NOW blockers' },
  ];
  const kindColors = { voice: '#92ff9d', image: '#77d5ff', chain: '#f8c15d', fail: '#ff4444' };
  entries.forEach((entry, i) => {
    const ey = 152 + i * 22;
    text(f, entry.time, 8, ey, 8, TEXT_MID, 'LEFT', 0.45);
    const dot = figma.createEllipse();
    dot.resize(5, 5);
    dot.x = 36; dot.y = ey + 3;
    dot.fills = [{ type: 'SOLID', color: hexToRgb(kindColors[entry.kind] || '#888'), opacity: 0.8 }];
    f.appendChild(dot);
    text(f, entry.body, 46, ey, 8, TEXT_WARM, 'LEFT', entry.kind === 'fail' ? 0.5 : 0.75);
  });

  const ann = annotationBox(f,
    '▶ GESTURES\nTap handle  toggle open / closed (60% height open)\nScroll  scroll through history when open\n▶ LOGIC\nLog strip always visible on HOME (single line preview)\nFull drawer shows queue depth, phase, ok/fail counts\nEntries: voice / image / chain / blocker\nFailed jobs appear in red → escalated to NOW surface\nDrawer does not block underlying HOME interaction', H - 90);
  ann.y = H - ann.height;

  return f;
}

// ─── TRIANGLE ──────────────────────────────────────────────────────────
function buildTriangle(x) {
  const f = makeFrame('TRIANGLE — Synthesis Surface', x, 0);
  rect(f, 0, 0, W, H, hexToRgb('#141414'));

  text(f, 'triangle', 12, 10, 18, TEXT_WARM, 'LEFT', 0.9);
  text(f, 'synthesis', 12, 32, 11, TEXT_MID, 'LEFT', 0.5);

  // point A
  const ptA = figma.createFrame();
  ptA.name = 'Point A (Armed)';
  ptA.resize(W - 16, 56);
  ptA.x = 8; ptA.y = 56;
  ptA.fills = [{ type: 'SOLID', color: hexToRgb('#77d5ff'), opacity: 0.14 }];
  ptA.cornerRadius = 8;
  ptA.strokes = [{ type: 'SOLID', color: hexToRgb('#77d5ff'), opacity: 0.4 }];
  ptA.strokeWeight = 1;
  f.appendChild(ptA);
  text(ptA, 'A', 8, 6, 10, hexToRgb('#77d5ff'), 'LEFT', 0.7);
  text(ptA, '"server diagram captured"', 22, 6, 10, TEXT_WARM, 'LEFT', 0.8);
  text(ptA, 'signal · from SHOW · 14:58', 22, 22, 8, TEXT_MID, 'LEFT', 0.5);
  text(ptA, 'deploy to autoscale before friday', 22, 36, 9, TEXT_WARM, 'LEFT', 0.65);

  // point B
  const ptB = figma.createFrame();
  ptB.name = 'Point B (Armed)';
  ptB.resize(W - 16, 56);
  ptB.x = 8; ptB.y = 122;
  ptB.fills = [{ type: 'SOLID', color: hexToRgb('#f8c15d'), opacity: 0.14 }];
  ptB.cornerRadius = 8;
  ptB.strokes = [{ type: 'SOLID', color: hexToRgb('#f8c15d'), opacity: 0.4 }];
  ptB.strokeWeight = 1;
  f.appendChild(ptB);
  text(ptB, 'B', 8, 6, 10, hexToRgb('#f8c15d'), 'LEFT', 0.7);
  text(ptB, '"check server logs first"', 22, 6, 10, TEXT_WARM, 'LEFT', 0.8);
  text(ptB, 'signal · from TELL · 14:52', 22, 22, 8, TEXT_MID, 'LEFT', 0.5);
  text(ptB, 'pre-deploy checklist exists in KNOW', 22, 36, 9, TEXT_WARM, 'LEFT', 0.65);

  // angle (voice input area)
  const angle = figma.createFrame();
  angle.name = 'Angle — Voice Input';
  angle.resize(W - 16, 36);
  angle.x = 8; angle.y = 190;
  angle.fills = [{ type: 'SOLID', color: hexToRgb('#92ff9d'), opacity: 0.1 }];
  angle.cornerRadius = 8;
  angle.strokeDashes = [4, 3];
  angle.strokes = [{ type: 'SOLID', color: hexToRgb('#92ff9d'), opacity: 0.35 }];
  angle.strokeWeight = 1;
  f.appendChild(angle);
  text(angle, '◎ hold PTT to speak your angle…', 8, 10, 10, hexToRgb('#92ff9d'), 'LEFT', 0.6);

  // synthesis output preview
  const output = figma.createFrame();
  output.name = 'Synthesis Output Preview';
  output.resize(W - 16, 36);
  output.x = 8; output.y = 238;
  output.fills = [{ type: 'SOLID', color: hexToRgb('#ffffff'), opacity: 0.05 }];
  output.cornerRadius = 8;
  f.appendChild(output);
  text(output, '→ new signal written to KNOW', 8, 10, 9, TEXT_WARM, 'LEFT', 0.35);

  // triangle indicator (bottom-left, shown on other screens too)
  const tri = figma.createPolygon();
  tri.pointCount = 3;
  tri.resize(12, 12);
  tri.x = 8; tri.y = H - 20;
  tri.fills = [{ type: 'SOLID', color: hexToRgb('#f8c15d'), opacity: 0.6 }];
  f.appendChild(tri);
  text(f, '△ armed', 24, H - 19, 8, TEXT_MID, 'LEFT', 0.45);

  const ann = annotationBox(f,
    '▶ GESTURES\nDouble side-click (item A)  arm first point\nDouble side-click (item B)  arm second → open TRIANGLE\nHold PTT  speak the angle (context / intent)\nPTT release  trigger synthesis → new signal to KNOW\nShake  clear triangle state, return HOME\n▶ LOGIC\nTriangle indicator (△) shown on all screens when armed\nAngle is optional — synthesis works without voice\nOutput is a merged signal with both sources cited\nSynthesis queued async (never blocks gesture path)', H - 124);
  ann.y = H - ann.height;

  return f;
}

// ─── INTERACTION LEGEND ────────────────────────────────────────────────
function buildLegend(x) {
  const f = makeFrame('LEGEND — Controls & Interaction Model', x, 0);
  f.resize(W + 80, H);
  rect(f, 0, 0, W + 80, H, hexToRgb('#0d0d0d'));

  text(f, 'STRUCTA R1', 12, 10, 16, TEXT_WARM, 'LEFT', 0.9);
  text(f, 'Interaction Model · Native Controls', 12, 30, 10, TEXT_MID, 'LEFT', 0.6);

  const controls = [
    ['PTT (Push-to-Talk)', 'Hold = listen/arm  ·  Release = execute'],
    ['Scroll ↕', 'Cycle cards (HOME) or items (KNOW/NOW)'],
    ['Tap', 'Open / select / confirm'],
    ['Long-press', 'Cycle filter or secondary option'],
    ['Side Click', 'Confirm / speak answer (hardware button)'],
    ['Double Side-Click', 'Arm triangle point A or B · open switcher'],
    ['Back', 'One level up or cancel (no destructive loss)'],
    ['Shake', 'Reset triangle state'],
  ];

  text(f, 'HARDWARE CONTROLS', 12, 52, 8, hexToRgb('#f8c15d'), 'LEFT', 0.7);
  controls.forEach(([ctrl, desc], i) => {
    const cy = 66 + i * 20;
    text(f, ctrl, 12, cy, 9, TEXT_WARM, 'LEFT', 0.85);
    text(f, desc, 12, cy + 10, 8, TEXT_MID, 'LEFT', 0.55);
  });

  text(f, 'SURFACE COLORS', 12, 240, 8, hexToRgb('#f8c15d'), 'LEFT', 0.7);
  const surfColors = [
    ['#77d5ff', 'SHOW — See. Capture. Evidence.'],
    ['#92ff9d', 'TELL — Speak. Dictate. Voice.'],
    ['#f8c15d', 'KNOW — Understand. Process. Questions.'],
    ['#ff8a65', 'NOW — Act. Decide. Urgent.'],
    ['#070707', 'HOME — Navigator. All four visible.'],
  ];
  surfColors.forEach(([color, label], i) => {
    const sy = 254 + i * 16;
    circle(f, 18, sy + 6, 10, hexToRgb(color));
    text(f, label, 28, sy, 8, TEXT_WARM, 'LEFT', 0.7);
  });

  return f;
}

// ─── MAIN ──────────────────────────────────────────────────────────────
(async function main() {
  await loadFonts();

  const page = figma.currentPage;
  page.name = 'Structa R1 — UI Surfaces';

  const surfaces = [
    buildHome(0),
    buildShow((W + GAP) * 1),
    buildTell((W + GAP) * 2),
    buildKnow((W + GAP) * 3),
    buildNow((W + GAP) * 4),
    buildLog((W + GAP) * 5),
    buildTriangle((W + GAP) * 6),
    buildLegend((W + GAP) * 7),
  ];

  // Label strip above each frame
  surfaces.forEach((frame, i) => {
    const label = figma.createText();
    label.fontName = { family: 'Inter', style: 'Medium' };
    label.characters = frame.name;
    label.fontSize = 10;
    label.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }];
    label.x = frame.x;
    label.y = -20;
    page.appendChild(label);
  });

  figma.viewport.scrollAndZoomIntoView(surfaces);
  figma.closePlugin('✅ Structa R1 surfaces created — 7 frames + legend + interaction annotations');
})();
