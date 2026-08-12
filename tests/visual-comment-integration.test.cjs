const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');

const repo = path.resolve(__dirname, '..');

function evaluate(window, file) {
  window.eval(fs.readFileSync(path.join(repo, file), 'utf8'));
}

function baseDom(html) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', error => errors.push(error));
  virtualConsole.on('error', error => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://structa.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  dom.window.console = console;
  return { dom, window: dom.window, errors };
}

function installRouter(window) {
  window.StructaActionRouter = {
    getContext() { return null; },
    updateContext() {},
    setActiveVerb() {},
    setActiveNode() {},
    routeAction() { return { ok: false }; }
  };
}

function prepareCapture(native, entryId, nodeId, text) {
  const projectId = native.getActiveProjectId();
  native.storeCaptureBundle({
    project_code: projectId,
    entry_id: entryId,
    source_type: 'camera',
    input_type: 'image',
    image_asset: { entry_id: 'asset-' + entryId, name: entryId + '.jpg' },
    summary: text || 'stored reference',
    meta: { preview_data: 'data:image/jpeg;base64,Y2FtZXJh', analysis_status: 'saved' }
  });
  native.addNode({
    node_id: nodeId,
    project_id: projectId,
    type: 'capture',
    status: 'open',
    title: text || 'stored reference',
    body: text || 'stored reference',
    source: 'camera',
    capture_image: entryId,
    meta: { bundle_id: entryId, preview_data: 'data:image/jpeg;base64,Y2FtZXJh' }
  });
  native.touchProjectMemory(project => {
    const capture = project.captures.find(item => item.id === entryId || item.entry_id === entryId);
    if (capture) capture.node_id = nodeId;
  });
}

test('selected SHOW delayed STT stores exact project-bound context once and projects it into SHOW and TELL', async t => {
  const runtime = baseDom(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'));
  const { dom, window, errors } = runtime;
  t.after(() => dom.window.close());
  const bridge = [];
  const jobs = [];
  window.HTMLCanvasElement.prototype.getContext = function() {
    return { font: '', measureText(value) { return { width: String(value || '').length * 5.5 }; } };
  };
  window.requestAnimationFrame = callback => { callback(window.performance.now()); return 1; };
  window.cancelAnimationFrame = () => {};
  window.CreationVoiceHandler = { postMessage(message) { bridge.push(message); } };
  window.StructaProcessingQueue = {
    registerHandler() {},
    enqueue(job) { jobs.push(job); },
    snapshot() { return jobs; }
  };
  window.StructaAudio = { mute() {}, unmute() {}, init() {} };
  window.StructaFeedback = { fire() {} };
  window.StructaLLM = { speakMilestone() {} };
  window.StructaCamera = {
    openFromGesture() {}, close() {}, capture() {}, flip() {}, startVoiceStrip() {},
    get voiceStripActive() { return false; }
  };
  installRouter(window);
  for (const file of ['js/contracts.js', 'js/validation.js', 'js/rabbit-adapter.js']) evaluate(window, file);
  const native = window.StructaNative;
  native.touchProjectMemory(project => {
    project.name = 'Origin project';
    project.brief = 'Collect exact visual context.';
    project.nodes = [];
    project.captures = [];
  });
  const originId = native.getActiveProjectId();
  prepareCapture(native, 'cap-selected', 'node-selected', 'A red roof junction.');
  native.updateUIState({ onboarding_complete: true, onboarding_step: 'complete', selected_card_id: 'show' });

  evaluate(window, 'js/voice-capture.js');
  evaluate(window, 'structa-cascade.js');
  const panel = window.StructaPanel;
  panel.transition(panel.STATES.SHOW_BROWSE);
  window.dispatchEvent(new window.CustomEvent('longPressStart'));
  window.dispatchEvent(new window.CustomEvent('pttStart'));
  window.dispatchEvent(new window.CustomEvent('longPressEnd'));
  window.dispatchEvent(new window.CustomEvent('pttEnd'));
  assert.deepEqual(bridge, ['start', 'stop']);

  const created = native.createProject('Other project');
  native.switchProject(created.project_id);
  const exact = 'Research the Red Roof joint, preserve THIS detail.';
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: exact } }));
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: exact } }));

  const origin = native.getProjectMemoryById(originId);
  const other = native.getProjectMemoryById(created.project_id);
  const capture = origin.captures.find(item => item.node_id === 'node-selected');
  const captureNode = origin.nodes.find(item => item.node_id === 'node-selected');
  const visualNotes = origin.nodes.filter(item => item.type === 'voice-entry' && item.meta?.entry_mode === 'visual-comment');
  assert.equal(capture.latest_comment_text, exact);
  assert.equal(captureNode.meta.latest_comment_text, exact);
  assert.equal(captureNode.meta.thread.filter(item => item.body === exact).length, 1);
  assert.equal(visualNotes.length, 1);
  assert.equal(visualNotes[0].body, exact, 'TELL source retains exact capitalization and punctuation');
  assert.deepEqual(Array.from(visualNotes[0].links), ['node-selected']);
  assert.equal(other.nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(jobs.filter(job => job.kind === 'thread-refine').length, 1);
  assert.equal(jobs.find(job => job.kind === 'thread-refine').payload.projectId, originId);

  native.switchProject(originId);
  panel.transition(panel.STATES.SHOW_BROWSE);
  let surface = window.document.getElementById('scene').textContent.replace(/\s+/g, ' ').trim().toLowerCase();
  assert.match(surface, /your context/);
  assert.match(surface, /research the red roof joint/);
  panel.transition(panel.STATES.TELL_BROWSE);
  surface = window.document.getElementById('scene').textContent.replace(/\s+/g, ' ').trim().toLowerCase();
  assert.match(surface, /research the red roof joint/);
  assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
});

function cameraHarness(options = {}) {
  const runtime = baseDom(`<!doctype html><main id="app">
    <section id="camera-overlay" aria-hidden="true">
      <video id="camera-preview"></video><canvas id="camera-canvas"></canvas>
      <div id="camera-transition" aria-hidden="true"><span id="camera-transition-label"></span></div>
      <button id="camera-status"></button><button id="camera-cancel"></button>
      <div id="camera-voice-strip"><span class="strip-text"></span></div>
    </section></main>`);
  const { window } = runtime;
  if (options.sttTimeoutMs) window.__STRUCTA_CAMERA_STT_TIMEOUT_MS__ = options.sttTimeoutMs;
  const bridge = [];
  const jobs = [];
  const handlers = {};
  const media = { active: true };
  const track = { stop() { media.active = false; } };
  media.getTracks = () => [track];
  window.HTMLCanvasElement.prototype.getContext = function() { return { drawImage() {} }; };
  window.HTMLCanvasElement.prototype.toDataURL = function() { return 'data:image/jpeg;base64,Y2FtZXJh'; };
  const preview = window.document.getElementById('camera-preview');
  Object.defineProperties(preview, {
    readyState: { configurable: true, get() { return 2; } },
    videoWidth: { configurable: true, get() { return 640; } },
    videoHeight: { configurable: true, get() { return 480; } },
    paused: { configurable: true, get() { return false; } }
  });
  preview.play = () => Promise.resolve();
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve(media) }
  });
  window.CreationVoiceHandler = { postMessage(message) { bridge.push(message); } };
  window.StructaProcessingQueue = {
    registerHandler(kind, handler) { handlers[kind] = handler; },
    enqueue(job) { jobs.push(job); },
    snapshot() { return jobs; }
  };
  window.StructaAudio = { mute() {}, unmute() {}, init() {} };
  window.StructaFeedback = { fire() {} };
  installRouter(window);
  for (const file of ['js/contracts.js', 'js/validation.js', 'js/rabbit-adapter.js']) evaluate(window, file);
  evaluate(window, 'js/camera-capture.js');
  return { ...runtime, bridge, jobs, handlers, media, preview };
}

async function waitFor(predicate, timeoutMs = 500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('CAMERA_OPEN release stores one frame immediately and attaches a >420ms native transcript to that exact frame once', async t => {
  const runtime = cameraHarness();
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  const originId = native.getActiveProjectId();
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  assert.equal(window.StructaCamera.startVoiceStrip(), true);
  const capturePromise = window.StructaCamera.finalizeVoiceStripCapture();
  const bundle = await capturePromise;
  assert.ok(bundle?.entry_id);
  let project = native.getProjectMemory();
  let capture = project.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  assert.equal(project.captures.length, 1, 'release owns exactly one shutter');
  assert.equal(capture.meta.analysis_status, 'awaiting-comment');
  assert.equal(project.nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, 'camera');

  const otherProject = native.createProject('Camera callback isolation');
  const otherId = otherProject.project_id;

  await new Promise(resolve => setTimeout(resolve, 500));
  const exact = 'Keep the Brass hinge and 12 mm shadow gap.';
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: exact } }));
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: exact } }));
  await waitFor(() => native.getProjectMemoryById(originId).nodes.some(item => item.meta?.entry_mode === 'visual-comment'));
  project = native.getProjectMemoryById(originId);
  capture = project.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  const captureNode = project.nodes.find(item => item.node_id === capture.node_id);
  const visualNotes = project.nodes.filter(item => item.meta?.entry_mode === 'visual-comment');
  assert.equal(visualNotes.length, 1);
  assert.equal(visualNotes[0].body, exact);
  assert.equal(visualNotes[0].meta.capture_id, bundle.entry_id);
  assert.equal(capture.latest_comment_text, exact);
  assert.equal(capture.input_type, 'image+voice');
  assert.equal(captureNode.meta.thread.filter(item => item.body === exact).length, 1);
  assert.equal(capture.meta.analysis_status, 'pending', 'terminal releases the exact frame for analysis');
  assert.equal(runtime.jobs.filter(job => job.kind === 'thread-refine').length, 1);
  assert.equal(native.getProjectMemoryById(otherId).nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, null);
  assert.deepEqual(runtime.bridge, ['start', 'stop']);
});

test('camera transcript may arrive before its storage target and still attaches once', async t => {
  const runtime = cameraHarness();
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  const originalStore = native.storeCaptureBundle;
  let injected = false;
  const exact = 'Callback before storage keeps this exact note.';
  // StructaNative is frozen, so inject at the stable asset write immediately
  // before bundle persistence by dispatching from the canvas serialization.
  const canvas = window.document.getElementById('camera-canvas');
  canvas.toDataURL = function() {
    if (!injected) {
      injected = true;
      window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: exact } }));
    }
    return 'data:image/jpeg;base64,Y2FtZXJh';
  };
  assert.equal(typeof originalStore, 'function');
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  window.StructaCamera.startVoiceStrip();
  const bundle = await window.StructaCamera.finalizeVoiceStripCapture();
  assert.ok(bundle?.entry_id);
  const project = native.getProjectMemory();
  const capture = project.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  const visualNotes = project.nodes.filter(item => item.meta?.entry_mode === 'visual-comment');
  assert.equal(visualNotes.length, 1);
  assert.equal(visualNotes[0].body, exact);
  assert.equal(capture.latest_comment_text, exact);
  assert.equal(capture.meta.analysis_status, 'pending');
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, null);
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: 'orphan duplicate' } }));
  assert.equal(native.getProjectMemory().nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 1);
});

test('an empty native camera terminal releases analysis without inventing a visual note', async t => {
  const runtime = cameraHarness();
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  window.StructaCamera.startVoiceStrip();
  const bundle = await window.StructaCamera.finalizeVoiceStripCapture();
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: '' } }));
  const project = native.getProjectMemory();
  const capture = project.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  assert.equal(project.nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(capture.meta.analysis_status, 'pending');
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, null);
});

test('missing native terminal releases image analysis but quarantines later uncorrelated camera speech', async t => {
  const runtime = cameraHarness({ sttTimeoutMs: 50 });
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  window.StructaCamera.startVoiceStrip();
  const bundle = await window.StructaCamera.finalizeVoiceStripCapture();
  await new Promise(resolve => setTimeout(resolve, 80));
  const project = native.getProjectMemory();
  const capture = project.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  assert.equal(capture.meta.analysis_status, 'pending');
  assert.equal(project.nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, 'camera-timeout');
  assert.equal(window.StructaCamera.startVoiceStrip(), false, 'uncorrelated retry stays blocked until page relaunch');
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: 'late orphan' } }));
  assert.equal(native.getProjectMemory().nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
});

test('cancelling camera narration before a frame discards its terminal and clears bridge ownership', async t => {
  const runtime = cameraHarness({ sttTimeoutMs: 50 });
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  window.StructaCamera.startVoiceStrip();
  window.StructaCamera.close({ reason: 'cancel' });
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: 'This cancelled narration must be discarded.' }
  }));
  assert.equal(native.getProjectMemory().captures.length, 0);
  assert.equal(native.getProjectMemory().nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, null);
});

test('a failed narrated frame cannot strand or later misroute its native transcript', async t => {
  const runtime = cameraHarness({ sttTimeoutMs: 50 });
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  window.HTMLCanvasElement.prototype.toDataURL = function() { return ''; };
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  window.StructaCamera.startVoiceStrip();
  const bundle = await window.StructaCamera.finalizeVoiceStripCapture();
  assert.equal(bundle, null);
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: 'This belongs to the failed frame only.' }
  }));
  assert.equal(native.getProjectMemory().captures.length, 0);
  assert.equal(native.getProjectMemory().nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 0);
  assert.equal(window.__STRUCTA_NATIVE_STT_OWNER__, null);
});

test('vision completion preserves the exact human comment while storing AI description separately', async t => {
  const runtime = cameraHarness();
  const { dom, window } = runtime;
  t.after(() => dom.window.close());
  const native = window.StructaNative;
  window.StructaCamera.openFromGesture('environment');
  await waitFor(() => window.document.getElementById('camera-overlay').classList.contains('open'));
  window.StructaCamera.startVoiceStrip();
  const bundle = await window.StructaCamera.finalizeVoiceStripCapture();
  const exact = 'Preserve My Exact CASE and punctuation!';
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', { detail: { transcript: exact } }));
  const projectBefore = native.getProjectMemory();
  const captureBefore = projectBefore.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  const newer = 'A newer human comment must remain latest.';
  native.appendCaptureComment(bundle.entry_id, captureBefore.node_id, newer, {
    projectId: projectBefore.project_id,
    requestId: 'later-human-comment',
    origin: 'ptt'
  });
  window.StructaLLM = {
    processImage() {
      return Promise.resolve({
        ok: true,
        clean: 'AI sees a brass hinge beside a dark reveal.',
        envelope: { schema: 'test', vision_id: 'vision-1', status: 'observed', observations: [] }
      });
    }
  };
  const result = await runtime.handlers['image-analyze']({
    id: 'analysis-1',
    payload: {
      entryId: bundle.entry_id,
      nodeId: captureBefore.node_id,
      projectId: projectBefore.project_id,
      assetId: captureBefore.meta.image_asset_id,
      annotation: exact,
      operationId: captureBefore.meta.operation_id,
      facingMode: 'environment'
    }
  });
  assert.equal(result.ok, true);
  const projectAfter = native.getProjectMemory();
  const captureAfter = projectAfter.captures.find(item => item.entry_id === bundle.entry_id || item.id === bundle.entry_id);
  assert.equal(captureAfter.latest_comment_text, newer);
  assert.equal(captureAfter.meta.latest_comment_text, newer);
  assert.equal(captureAfter.description_text, 'AI sees a brass hinge beside a dark reveal.');
  assert.equal(projectAfter.nodes.filter(item => item.meta?.entry_mode === 'visual-comment').length, 2);
});
