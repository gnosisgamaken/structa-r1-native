const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const CAMERA_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'camera-capture.js'),
  'utf8'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function(resolvePromise, rejectPromise) {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const stream = { active: true };
  const track = {
    readyState: 'live',
    stops: 0,
    stop: function() {
      this.stops += 1;
      this.readyState = 'ended';
      stream.active = false;
    }
  };
  stream.getTracks = function() { return [track]; };
  return { stream, track };
}

function createHarness(getUserMedia, previewState) {
  const dom = new JSDOM(`<!doctype html>
    <div id="app">
      <section id="camera-overlay" aria-hidden="true">
        <video id="camera-preview"></video>
        <canvas id="camera-canvas"></canvas>
        <button id="camera-status"></button>
        <div id="camera-voice-strip"><span class="strip-text"></span></div>
      </section>
    </div>`, {
    runScripts: 'outside-only',
    url: 'https://structa.test/'
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function() {
    return { drawImage: function() {} };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function() {
    return 'data:image/jpeg;base64,Y2FtZXJh';
  };
  const preview = window.document.getElementById('camera-preview');
  const state = Object.assign({ readyState: 2, videoWidth: 640, paused: false }, previewState || {});
  Object.defineProperties(preview, {
    readyState: { configurable: true, get: function() { return state.readyState; } },
    videoWidth: { configurable: true, get: function() { return state.videoWidth; } },
    paused: { configurable: true, get: function() { return state.paused; } }
  });
  preview.play = function() { return Promise.resolve(); };
  preview.srcObject = null;
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  });
  window.StructaNative = {
    getMemory: function() { return { assets: [] }; },
    getProjectMemory: function() { return { project_id: 'project-1', captures: [], nodes: [] }; },
    getActiveProjectId: function() { return 'project-1'; },
    setCameraFacing: function() {}
  };
  window.eval(CAMERA_SOURCE);
  return {
    dom,
    window,
    overlay: window.document.getElementById('camera-overlay'),
    preview,
    status: window.document.getElementById('camera-status')
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(function(resolve) { setTimeout(resolve, 0); });
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > (timeoutMs || 200)) throw new Error('condition timed out');
    await new Promise(function(resolve) { setTimeout(resolve, 5); });
  }
}

test('close invalidates pending acquisition and stops its late stream', async function(t) {
  const acquisition = deferred();
  const media = fakeStream();
  const harness = createHarness(function() { return acquisition.promise; });
  t.after(function() { harness.dom.window.close(); });
  let opened = 0;
  harness.window.addEventListener('structa-camera-open', function() { opened += 1; });

  harness.window.StructaCamera.openFromGesture('environment');
  assert.equal(harness.status.textContent, 'opening');
  harness.window.StructaCamera.close();
  acquisition.resolve(media.stream);
  await flushAsync();

  assert.equal(media.track.stops, 1);
  assert.equal(media.stream.active, false);
  assert.equal(opened, 0);
  assert.equal(harness.overlay.classList.contains('open'), false);
  assert.equal(harness.preview.srcObject, null);
  assert.equal(harness.window.__STRUCTA_PRIMED_STREAM__, undefined);
  assert.equal(harness.status.textContent, 'camera closed');
});

test('close stops an active camera and clears the primed stream', async function(t) {
  const media = fakeStream();
  const harness = createHarness(function() { return Promise.resolve(media.stream); });
  t.after(function() { harness.dom.window.close(); });

  harness.window.StructaCamera.openFromGesture('environment');
  await waitFor(function() { return harness.overlay.classList.contains('open'); });
  assert.equal(harness.window.__STRUCTA_PRIMED_STREAM__, media.stream);

  harness.window.StructaCamera.close();

  assert.equal(media.track.stops, 1);
  assert.equal(media.stream.active, false);
  assert.equal(harness.window.__STRUCTA_PRIMED_STREAM__, null);
  assert.equal(harness.preview.srcObject, null);
  assert.equal(harness.overlay.classList.contains('open'), false);
  assert.equal(harness.window.StructaCamera.primed, false);
});

test('close during preview attachment cannot reopen the overlay', async function(t) {
  const media = fakeStream();
  const harness = createHarness(
    function() { return Promise.resolve(media.stream); },
    { readyState: 0, videoWidth: 0, paused: true }
  );
  t.after(function() { harness.dom.window.close(); });
  let opened = 0;
  harness.window.addEventListener('structa-camera-open', function() { opened += 1; });

  harness.window.StructaCamera.openFromGesture('environment');
  await waitFor(function() { return harness.preview.srcObject === media.stream; });
  harness.window.StructaCamera.close();
  await new Promise(function(resolve) { setTimeout(resolve, 80); });

  assert.equal(media.track.stops, 1);
  assert.equal(opened, 0);
  assert.equal(harness.overlay.classList.contains('open'), false);
  assert.equal(harness.preview.srcObject, null);
  assert.equal(harness.status.textContent, 'camera closed');
});

test('a successful capture releases the camera instead of keeping a hidden stream live', async function(t) {
  const media = fakeStream();
  const harness = createHarness(function() { return Promise.resolve(media.stream); });
  t.after(function() { harness.dom.window.close(); });

  harness.window.StructaCamera.openFromGesture('environment');
  await waitFor(function() { return harness.overlay.classList.contains('open'); });
  await harness.window.StructaCamera.capture();

  assert.equal(media.track.stops, 1);
  assert.equal(media.stream.active, false);
  assert.equal(harness.window.__STRUCTA_PRIMED_STREAM__, null);
  assert.equal(harness.preview.srcObject, null);
  assert.equal(harness.overlay.classList.contains('open'), false);
  assert.equal(harness.window.StructaCamera.primed, false);
});
