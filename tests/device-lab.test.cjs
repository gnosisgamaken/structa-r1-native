const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'js/device-lab.js'), 'utf8');

function boot(url = 'https://structa.test/', seed = '', options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  if (Number.isFinite(options.now)) window.Date.now = () => Number(options.now);
  const posts = [];
  const inbound = [];
  const emails = [];
  const downloadClicks = [];
  const originalPost = function(payload) {
    posts.push(JSON.parse(payload));
    return true;
  };
  window.StructaBuild = Object.freeze({
    uiBuildId: 'ui-20260812-structa-v3.8',
    expectedDiagnosticsAssetId: 'diag-20260811-structa-v3',
    assetEpoch: 'test'
  });
  window.PluginMessageHandler = { postMessage: originalPost };
  window.onPluginMessage = data => inbound.push(data);
  window.StructaLLM = {
    emailText(subject, body) {
      emails.push({ subject, body });
      return options.emailHandler
        ? Promise.resolve(options.emailHandler(subject, body, emails.length))
        : Promise.resolve({ ok: true, mode: 'native' });
    }
  };
  const serverBuildSha = options.serverBuildSha || 'abc123def456';
  window.StructaDiagnostics = {
    getState: () => ({ buildStatus: { serverBuildSha } }),
    handleAction: actionId => Promise.resolve({
      ok: actionId === 'diagnostics-build-check',
      result: {
        uiBuildId: 'ui-20260812-structa-v3.8',
        serverBuildSha,
        status: 'current'
      }
    })
  };
  window.StructaProcessingQueue = { snapshot: () => options.queueSnapshot || [] };
  window.TextEncoder = global.TextEncoder;
  if (options.compression !== false) {
    window.Blob = global.Blob;
    window.Response = global.Response;
    window.CompressionStream = global.CompressionStream;
  }
  try { Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle, configurable: true }); } catch (_) {}
  window.URL.createObjectURL = () => 'blob:device-proof';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function() {
    downloadClicks.push({ href: this.href, download: this.download });
  };
  if (seed) window.localStorage.setItem('structa.device-proof.v1.active', seed);
  window.eval(source);
  return { dom, window, posts, inbound, emails, downloadClicks, originalPost };
}

function emitTrace(window, flow, from, to, ctx = {}) {
  window.dispatchEvent(new window.CustomEvent('structa-trace', {
    detail: { flow, from, to, ctx }
  }));
}

function invariant(proof, id) {
  return proof.summary.invariants.find(entry => entry.id === id);
}

function emitDirectTouch(window, pointerId = 1) {
  const pointer = new window.Event('pointerdown');
  Object.defineProperties(pointer, {
    pointerId: { value: pointerId },
    pointerType: { value: 'touch' },
    isPrimary: { value: true }
  });
  window.dispatchEvent(pointer);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('device lab is inert outside explicit lab routes', () => {
  const runtime = boot();
  assert.equal(runtime.window.StructaDeviceLab.enabled, false);
  assert.equal(runtime.window.StructaDeviceLab.routeEnabled, false);
  assert.equal(runtime.window.StructaDeviceLab.getProof(), null);
  assert.equal(runtime.window.PluginMessageHandler.postMessage, runtime.originalPost);
  assert.equal(runtime.window.document.getElementById('structa-device-proof-control'), null);
  runtime.window.dispatchEvent(new runtime.window.CustomEvent('sideClick'));
  assert.equal(runtime.window.StructaDeviceLab.getProof(), null);
  runtime.dom.window.close();
});

test('all supported device lab routes activate a persistent proof session', () => {
  for (const url of [
    'https://structa.test/?lab=1',
    'https://structa.test/#lab',
    'https://structa.test/?debug=1#probe'
  ]) {
    const runtime = boot(url);
    const proof = runtime.window.StructaDeviceLab.getProof();
    assert.equal(runtime.window.StructaDeviceLab.enabled, true, url);
    assert.equal(proof.schema, 'structa.device-proof.v1');
    assert.match(proof.session_id, /^ST-\d{8}-[A-Za-z0-9]{8}$/);
    assert.equal(proof.build.ui_build_id, 'ui-20260812-structa-v3.8');
    assert.equal(proof.step_id, 'B00');
    assert.equal(proof.events[0].type, 'session.start');
    assert.equal(Date.parse(proof.expires_at) - Date.parse(proof.started_at), 12 * 60 * 60 * 1000);
    assert.ok(runtime.window.localStorage.getItem('structa.device-proof.v1.active'));
    const control = runtime.window.document.getElementById('structa-device-proof-control');
    assert.ok(control, 'lab-only physical control is installed');
    control.click();
    assert.equal(runtime.window.document.getElementById('structa-device-proof-panel').getAttribute('aria-hidden'), 'false');
    assert.ok(runtime.window.document.getElementById('structa-device-proof-send'));
    assert.ok(runtime.window.document.getElementById('structa-device-proof-journal'));
    assert.ok(runtime.window.document.getElementById('structa-device-proof-reset'));
    assert.ok(runtime.window.document.getElementById('structa-device-proof-build-check'));
    const step = runtime.window.document.getElementById('structa-device-proof-step');
    assert.equal(step.textContent, 'step · B00');
    step.click();
    const steppedProof = runtime.window.StructaDeviceLab.getProof();
    assert.equal(steppedProof.step_id, 'B01');
    assert.equal(step.textContent, 'step · B01');
    assert.match(runtime.window.document.querySelector('#structa-device-proof-panel [aria-live="polite"]').textContent, /system back exits/);
    assert.ok(steppedProof.events.some(event => event.type === 'step.change' && event.step_id === 'B01'));
    for (let index = 0; index < 7; index += 1) step.click();
    assert.equal(runtime.window.StructaDeviceLab.getProof().step_id, 'B00', 'step control wraps after B07');
    runtime.dom.window.close();
  }
});

test('proof records hardware, lifecycle, camera, trace, and bridge facts without content', async () => {
  const runtime = boot('https://structa.test/?lab=1');
  const { window } = runtime;
  const lab = window.StructaDeviceLab;

  lab.setStep('B01');
  window.dispatchEvent(new window.CustomEvent('scrollUp'));
  window.dispatchEvent(new window.CustomEvent('sideClick'));
  const pointer = new window.Event('pointerdown');
  Object.defineProperties(pointer, {
    pointerId: { value: 7 },
    pointerType: { value: 'touch' },
    isPrimary: { value: true }
  });
  window.dispatchEvent(pointer);
  const touch = new window.Event('touchstart');
  Object.defineProperty(touch, 'touches', { value: [{ identifier: 1 }] });
  window.dispatchEvent(touch);
  const motion = new window.Event('devicemotion');
  Object.defineProperties(motion, {
    acceleration: { value: { x: 18, y: 2, z: 1 } },
    interval: { value: 16 }
  });
  window.dispatchEvent(motion);

  lab.setStep('B02');
  window.dispatchEvent(new window.CustomEvent('pttStart'));
  window.dispatchEvent(new window.CustomEvent('pttEnd'));

  lab.setStep('B03');
  emitDirectTouch(window, 8);
  window.dispatchEvent(new window.CustomEvent('structa-camera-open'));
  window.dispatchEvent(new window.CustomEvent('structa-camera-close'));
  emitDirectTouch(window, 9);
  window.dispatchEvent(new window.CustomEvent('structa-camera-open'));
  for (let index = 1; index <= 20; index += 1) {
    window.dispatchEvent(new window.CustomEvent('structa-capture-stored', {
      detail: { entryId: `capture-${index}`, summary: 'SECRET CAMERA SUMMARY' }
    }));
  }

  lab.setStep('B04');
  for (let index = 1; index <= 20; index += 1) {
    const captureId = `capture-${index}`;
    const visionId = `vision-${index}`;
    emitTrace(window, 'vision.analysis', 'saved', 'requested', { captureId, visionId });
    window.PluginMessageHandler.postMessage(JSON.stringify({
      payload: {
        message: 'SECRET OUTBOUND PROMPT',
        imageBase64: 'SECRET_IMAGE_BYTES',
        useLLM: true,
        useSerpAPI: false,
        wantsR1Response: false,
        wantsJournalEntry: false
      }
    }));
    emitTrace(window, 'vision.bridge', 'prepare', 'posted', { visionId, silent: true, journal: false });
    window.onPluginMessage({ visionId, response: 'SECRET PROVIDER RESPONSE' });
    emitTrace(window, 'plugin.message.parsed', 'in', 'vision', {
      visionId,
      text: 'SECRET PARSED RESPONSE',
      observationCount: 2
    });
    emitTrace(window, 'vision.analysis', 'requested', 'stored', { captureId, visionId });
  }

  lab.setStep('B05');
  lab.markManual('camera_visible', true, {
    mode: 'physical',
    frameCount: 1,
    notes: 'SECRET TESTER NOTE'
  });
  lab.setStep('B06');
  lab.setStep('B07');

  lab.finish(true);
  const exported = await lab.exportProof();
  assert.equal(exported.local.ok, true);
  assert.equal(exported.email.ok, true);
  assert.equal(exported.journal.attempted, false);
  assert.equal(runtime.emails.length, exported.email.total);
  assert.equal(exported.email.sent, exported.email.total);
  assert.ok(['gzip+base64', 'base64'].includes(exported.email.encoding));
  assert.ok(runtime.emails.every(email => email.body.length <= 2700));
  assert.ok(runtime.emails.every(email => email.body.startsWith('STRUCTA_DEVICE_PROOF_TRANSPORT_V1\n')));
  assert.equal(runtime.posts.some(payload => payload.wantsJournalEntry === true), false);

  const proof = lab.getProof();
  const serialized = JSON.stringify(proof);
  for (const secret of [
    'SECRET CAMERA SUMMARY',
    'SECRET TRACE PROMPT',
    'SECRET RAW DUMP',
    'SECRET OUTBOUND PROMPT',
    'SECRET_IMAGE_BYTES',
    'SECRET PROVIDER RESPONSE',
    'SECRET PARSED RESPONSE',
    'SECRET TESTER NOTE'
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
    assert.ok(runtime.emails.every(email => !email.body.includes(secret)), secret);
  }
  assert.equal(runtime.inbound.length, 20, 'the original inbound handler is preserved');
  assert.equal(proof.summary.provider.observed_max_in_flight, 1);
  assert.equal(proof.summary.provider.overlap_violations, 0);
  assert.equal(proof.summary.provider.outstanding, 0);
  assert.equal(proof.build.server_build_sha, 'abc123def456');
  assert.equal(proof.summary.invariants.find(item => item.id === 'provider.single_inflight').pass, true);
  assert.equal(proof.summary.invariants.find(item => item.id === 'provider.settled_at_finish').pass, true);
  assert.equal(proof.summary.invariants.find(item => item.id === 'build.server_sha_available').pass, true);
  assert.equal(invariant(proof, 'coverage.phase_sequence').pass, true);
  assert.equal(invariant(proof, 'transport.no_speaker_request').pass, true);
  assert.equal(invariant(proof, 'transport.no_journal_request').pass, true);
  assert.equal(invariant(proof, 'vision.capture_precedes_request').pass, true);
  assert.equal(invariant(proof, 'vision.single_parse_per_id').pass, true);
  assert.equal(invariant(proof, 'vision.id_chain_matches').pass, true);
  assert.equal(invariant(proof, 'vision.b04_matrix').pass, true);
  assert.equal(invariant(proof, 'vision.b04_matrix').success, 20);
  assert.equal(invariant(proof, 'input.b02_press_pairs').pass, true);
  assert.equal(invariant(proof, 'input.b03_touch_camera_open').pass, true);
  assert.equal(invariant(proof, 'camera.b03_cancel_without_capture').pass, true);
  assert.equal(invariant(proof, 'queue.settled_at_finish').pass, true);
  assert.ok(proof.events.some(event => event.type === 'hardware.pointer'));
  assert.ok(proof.events.some(event => event.type === 'hardware.touch'));
  assert.ok(proof.events.some(event => event.type === 'hardware.motion' && event.flags.shake_detected === true));
  assert.ok(proof.events.every(event => event.session_id === proof.session_id));
  assert.ok(proof.events.every(event => event.build === 'ui-20260812-structa-v3.8'));
  assert.ok(proof.events.every((event, index) => event.seq === index + 1));

  const { validateDeviceProof, decodeDeviceProofTransport } = await import('../scripts/validate-device-proof.mjs');
  const verdict = validateDeviceProof(proof);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, 'passed');
  const transportedProof = decodeDeviceProofTransport(runtime.emails.map(email => email.body));
  assert.equal(transportedProof.session_id, proof.session_id);
  assert.equal(validateDeviceProof(transportedProof).verdict, 'passed');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structa-proof-'));
  const proofPath = path.join(tempDir, 'proof.json');
  try {
    fs.writeFileSync(proofPath, JSON.stringify(proof));
    const cli = spawnSync(process.execPath, [path.join(repo, 'scripts/validate-device-proof.mjs'), proofPath], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /device proof valid · verdict passed/);
    const transportPaths = runtime.emails.map((email, index) => {
      const target = path.join(tempDir, `transport-${index + 1}.txt`);
      fs.writeFileSync(target, email.body);
      return target;
    });
    const transportCli = spawnSync(process.execPath, [path.join(repo, 'scripts/validate-device-proof.mjs'), ...transportPaths.reverse()], { encoding: 'utf8' });
    assert.equal(transportCli.status, 0, transportCli.stderr);
    assert.match(transportCli.stdout, /device proof valid · verdict passed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  runtime.dom.window.close();
});

test('journal export is used only as an explicit fallback', async () => {
  const runtime = boot('https://structa.test/?lab=1');
  runtime.window.StructaLLM.emailText = () => Promise.resolve({ ok: false, mode: 'unavailable' });

  const first = await runtime.window.StructaDeviceLab.exportProof();
  assert.equal(first.email.attempted, true);
  assert.equal(first.journal.attempted, false);
  assert.equal(runtime.posts.some(payload => payload.wantsJournalEntry === true), false);

  const second = await runtime.window.StructaDeviceLab.exportProof({ journalFallback: true });
  assert.equal(second.journal.attempted, true);
  assert.equal(second.journal.ok, true);
  const journalPosts = runtime.posts.filter(payload => payload.wantsJournalEntry === true);
  assert.equal(journalPosts.length, 1);
  assert.equal(journalPosts[0].useLLM, false);
  assert.equal(journalPosts[0].wantsR1Response, false);
  runtime.dom.window.close();
});

test('lab panel can finish, email, and reset a proof entirely on-device', async () => {
  const runtime = boot('https://structa.test/?lab=1');
  const firstSessionId = runtime.window.StructaDeviceLab.getProof().session_id;
  runtime.window.document.getElementById('structa-device-proof-control').click();
  runtime.window.document.getElementById('structa-device-proof-send').click();
  await waitFor(() => runtime.window.document.getElementById('structa-device-proof-send').disabled === false);

  assert.equal(runtime.window.StructaDeviceLab.getProof().status, 'complete');
  assert.ok(runtime.emails.length >= 1);
  assert.ok(runtime.emails.every(email => email.body.length <= 2700));
  assert.equal(runtime.downloadClicks.length, 0, 'finish + send must not navigate the R1 WebView to a blob URL');
  assert.equal(runtime.window.document.querySelector('#structa-device-proof-panel [aria-live="polite"]').textContent, 'proof emailed');

  const reset = runtime.window.document.getElementById('structa-device-proof-reset');
  reset.click();
  assert.equal(reset.textContent, 'tap again: reset');
  reset.click();
  const resetProof = runtime.window.StructaDeviceLab.getProof();
  assert.equal(resetProof.status, 'running');
  assert.equal(resetProof.step_id, 'B00');
  assert.notEqual(resetProof.session_id, firstSessionId);
  runtime.dom.window.close();
});

test('completed proof survives reload until the explicit two-tap reset', () => {
  const first = boot('https://structa.test/?lab=1');
  const completed = first.window.StructaDeviceLab.finish();
  const stored = first.window.localStorage.getItem('structa.device-proof.v1.active');
  first.dom.window.close();

  const second = boot('https://structa.test/?lab=1', stored);
  const restored = second.window.StructaDeviceLab.getProof();
  assert.equal(restored.session_id, completed.session_id);
  assert.equal(restored.status, 'complete');
  assert.equal(restored.events.filter(event => event.type === 'session.start').length, 1);

  second.window.document.getElementById('structa-device-proof-control').click();
  const reset = second.window.document.getElementById('structa-device-proof-reset');
  reset.click();
  reset.click();
  assert.notEqual(second.window.StructaDeviceLab.getProof().session_id, completed.session_id);
  second.dom.window.close();
});

test('expiry is an honest release invariant while post-finish export retries remain recoverable', async () => {
  const startedAt = Date.parse('2026-08-12T10:00:00.000Z');
  const first = boot('https://structa.test/?lab=1', '', { now: startedAt });
  const completed = first.window.StructaDeviceLab.finish();
  assert.equal(invariant(completed, 'session.within_expiry').pass, true);
  const stored = first.window.localStorage.getItem('structa.device-proof.v1.active');
  first.dom.window.close();

  const afterExpiry = boot('https://structa.test/?lab=1', stored, {
    now: startedAt + (13 * 60 * 60 * 1000)
  });
  const retried = await afterExpiry.window.StructaDeviceLab.exportProof();
  assert.equal(retried.session_id, completed.session_id);
  assert.equal(invariant(retried.proof, 'session.within_expiry').pass, true, 'post-finish export events do not rewrite test validity');
  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  assert.notEqual(validateDeviceProof(retried.proof).verdict, 'failed');

  const legacyTwoHour = JSON.parse(JSON.stringify(completed));
  legacyTwoHour.expires_at = new Date(startedAt + (2 * 60 * 60 * 1000)).toISOString();
  assert.deepEqual(validateDeviceProof(legacyTwoHour).errors, [], 'completed v3.7 two-hour proofs remain recoverable and structurally valid');
  afterExpiry.dom.window.close();

  const late = boot('https://structa.test/?lab=1', '', { now: startedAt });
  late.window.Date.now = () => startedAt + (12 * 60 * 60 * 1000) + 1;
  const lateProof = late.window.StructaDeviceLab.finish();
  assert.equal(invariant(lateProof, 'session.within_expiry').pass, false);
  const lateVerdict = validateDeviceProof(lateProof);
  assert.equal(lateVerdict.ok, true);
  assert.equal(lateVerdict.verdict, 'failed');
  assert.ok(lateVerdict.failed_invariants.includes('session.within_expiry'));
  late.dom.window.close();
});

test('expired running proof is terminalized without replacing its session or evidence', async () => {
  const startedAt = Date.parse('2026-08-12T10:00:00.000Z');
  const first = boot('https://structa.test/?lab=1', '', { now: startedAt });
  first.window.StructaDeviceLab.setStep('B04');
  first.window.StructaDeviceLab.markManual('retained-check', true);
  const sessionId = first.window.StructaDeviceLab.getProof().session_id;
  const stored = first.window.localStorage.getItem('structa.device-proof.v1.active');
  first.dom.window.close();

  const second = boot('https://structa.test/?lab=1', stored, {
    now: startedAt + (12 * 60 * 60 * 1000) + 1
  });
  const expired = second.window.StructaDeviceLab.getProof();
  assert.equal(expired.session_id, sessionId);
  assert.equal(expired.status, 'failed');
  assert.equal(expired.step_id, 'B04');
  assert.ok(expired.events.some(event => event.type === 'manual.check'));
  assert.ok(expired.events.some(event => event.type === 'session.expired'));
  assert.equal(invariant(expired, 'session.within_expiry').pass, false);
  second.window.document.getElementById('structa-device-proof-control').click();
  assert.equal(second.window.document.getElementById('structa-device-proof-step').disabled, true);
  assert.match(second.window.document.querySelector('#structa-device-proof-panel [aria-live="polite"]').textContent, /proof expired/);
  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  const verdict = validateDeviceProof(expired);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, 'failed');
  second.dom.window.close();
});

test('failed email retains the completed proof without navigation and can retry after relaunch', async () => {
  const first = boot('https://structa.test/?lab=1', '', {
    emailHandler: () => ({ ok: false, mode: 'unavailable' })
  });
  first.window.StructaDeviceLab.setStep('B04');
  const sessionId = first.window.StructaDeviceLab.getProof().session_id;
  first.window.document.getElementById('structa-device-proof-control').click();
  first.window.document.getElementById('structa-device-proof-send').click();
  await waitFor(() => first.window.document.getElementById('structa-device-proof-send').disabled === false);

  const stored = first.window.localStorage.getItem('structa.device-proof.v1.active');
  const retained = JSON.parse(stored);
  assert.equal(retained.session_id, sessionId);
  assert.equal(retained.status, 'complete');
  assert.equal(first.downloadClicks.length, 0);
  assert.equal(first.posts.some(payload => payload.wantsJournalEntry === true), false);
  assert.equal(first.window.document.querySelector('#structa-device-proof-panel [aria-live="polite"]').textContent, 'email unavailable · proof retained');
  assert.equal(first.window.document.getElementById('structa-device-proof-send').textContent, 'retry send');
  first.dom.window.close();

  const second = boot('https://structa.test/?lab=1', stored);
  assert.equal(second.window.StructaDeviceLab.getProof().session_id, sessionId);
  assert.equal(second.window.StructaDeviceLab.getProof().status, 'complete');
  second.window.document.getElementById('structa-device-proof-control').click();
  second.window.document.getElementById('structa-device-proof-send').click();
  await waitFor(() => second.window.document.getElementById('structa-device-proof-send').disabled === false);

  assert.ok(second.emails.length >= 1);
  assert.equal(second.downloadClicks.length, 0);
  assert.equal(second.posts.some(payload => payload.wantsJournalEntry === true), false);
  assert.equal(second.window.StructaDeviceLab.getProof().session_id, sessionId);
  assert.equal(second.window.document.querySelector('#structa-device-proof-panel [aria-live="polite"]').textContent, 'proof emailed');
  second.dom.window.close();
});

test('mismatched completion cannot remove an active request and reload abandonment fails settlement', () => {
  const mismatch = boot('https://structa.test/?lab=1');
  mismatch.window.PluginMessageHandler.postMessage(JSON.stringify({
    correlationId: 'corr-good',
    message: 'not retained',
    useLLM: true
  }));
  mismatch.window.onPluginMessage({ correlationId: 'corr-wrong', response: 'not retained' });
  let proof = mismatch.window.StructaDeviceLab.getProof();
  assert.equal(proof.summary.provider.outstanding, 1);
  assert.ok(proof.events.some(event => event.type === 'provider.mismatch' && event.ids.completion_id === 'corr-wrong'));
  mismatch.window.StructaDeviceLab.finish();
  proof = mismatch.window.StructaDeviceLab.getProof();
  assert.equal(invariant(proof, 'provider.settled_at_finish').pass, false);
  assert.equal(invariant(proof, 'provider.settled_at_finish').outstanding, 1);
  mismatch.dom.window.close();

  const first = boot('https://structa.test/?lab=1');
  first.window.PluginMessageHandler.postMessage(JSON.stringify({
    correlationId: 'corr-abandoned',
    message: 'not retained',
    useLLM: true
  }));
  const stored = first.window.localStorage.getItem('structa.device-proof.v1.active');
  first.dom.window.close();
  const resumed = boot('https://structa.test/?lab=1', stored);
  proof = resumed.window.StructaDeviceLab.getProof();
  assert.equal(proof.summary.provider.outstanding, 0);
  assert.equal(proof.summary.provider.abandoned, 1);
  resumed.window.StructaDeviceLab.finish();
  proof = resumed.window.StructaDeviceLab.getProof();
  assert.equal(invariant(proof, 'provider.settled_at_finish').pass, false);
  assert.equal(invariant(proof, 'provider.settled_at_finish').abandoned, 1);
  resumed.dom.window.close();
});

test('build control reports workspace as mismatch and records the safe result', async () => {
  const runtime = boot('https://structa.test/?lab=1', '', { serverBuildSha: 'workspace' });
  assert.equal(invariant(runtime.window.StructaDeviceLab.getProof(), 'build.server_sha_available').pass, false);
  runtime.window.document.getElementById('structa-device-proof-control').click();
  const button = runtime.window.document.getElementById('structa-device-proof-build-check');
  assert.match(button.style.cssText, /min-height:\s*44px/);
  button.click();
  await waitFor(() => button.disabled === false);
  const status = runtime.window.document.querySelector('#structa-device-proof-panel [aria-live="polite"]').textContent;
  assert.match(status, /ui-20260812-structa-v3\.8 · server workspace · mismatch/);
  const event = runtime.window.StructaDeviceLab.getProof().events.filter(entry => entry.type === 'proof.control').at(-1);
  assert.equal(event.flags.current, false);
  assert.equal(event.flags.ok, false);
  runtime.dom.window.close();
});

test('semantic allowlist drops adversarial IDs and detects nested production image payloads', async () => {
  const runtime = boot('https://structa.test/?lab=1');
  runtime.window.StructaDeviceLab.markManual('security-check', true, {
    authTokenId: 'LEAK_AUTH_ID',
    secret_id: 'LEAK_SECRET_ID',
    apiKey: 12345,
    credentialFlag: true,
    safeFlag: true
  });
  emitTrace(runtime.window, 'vision.dispatch', 'prepare', 'queued', {
    visionId: 'vision-safe',
    cookieId: 'LEAK_COOKIE_ID',
    authorizationKey: 'LEAK_AUTH_KEY'
  });
  runtime.window.PluginMessageHandler.postMessage(JSON.stringify({
    payload: {
      correlationId: 'corr-nested',
      imageBase64: 'LEAK_NESTED_IMAGE',
      message: 'LEAK_NESTED_PROMPT',
      useLLM: true,
      wantsR1Response: false,
      wantsJournalEntry: false
    }
  }));
  runtime.window.onPluginMessage({ correlationId: 'corr-nested', response: 'LEAK_NESTED_RESPONSE' });
  const proof = runtime.window.StructaDeviceLab.getProof();
  const serialized = JSON.stringify(proof);
  for (const value of ['LEAK_AUTH_ID', 'LEAK_SECRET_ID', 'LEAK_COOKIE_ID', 'LEAK_AUTH_KEY', 'LEAK_NESTED_IMAGE', 'LEAK_NESTED_PROMPT', 'LEAK_NESTED_RESPONSE']) {
    assert.equal(serialized.includes(value), false, value);
  }
  const outbound = proof.events.find(event => event.type === 'bridge.outbound');
  assert.equal(outbound.flags.has_image, true);
  assert.equal(outbound.ids.correlation_id, 'corr-nested');

  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  const tampered = JSON.parse(JSON.stringify(proof));
  tampered.events[0].ids = { auth_token_id: 'should-reject' };
  const verdict = validateDeviceProof(tampered);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(error => error.includes('forbidden') || error.includes('semantic identifier')));
  runtime.dom.window.close();
});

test('vision traces retain only allowlisted categorical wire facts', async () => {
  const runtime = boot('https://structa.test/?lab=1');
  emitTrace(runtime.window, 'vision.bridge', 'prepare', 'posted', {
    visionId: 'vision-wire-safe',
    imagePlacement: 'top-level',
    imageMode: 'raw-base64',
    imageMimeType: 'image/jpeg',
    imageChars: 4321
  });
  emitTrace(runtime.window, 'plugin.message.parsed', 'in', 'vision', {
    visionId: 'vision-wire-safe',
    status: 'insufficient',
    captureKind: 'sketch_diagram',
    projectRole: 'external_reference'
  });
  emitTrace(runtime.window, 'vision.bridge', 'prepare', 'posted', {
    visionId: 'vision-wire-redacted',
    imagePlacement: 'top-level plus private caption',
    imageMode: 'RAW SECRET MODE',
    imageMimeType: 'data:image/png;base64,LEAK_IMAGE',
    status: 'user supplied private status',
    captureKind: 'private project description',
    projectRole: 'client name'
  });

  const proof = runtime.window.StructaDeviceLab.getProof();
  const safePosted = proof.events.find(event => event.type === 'structa.trace' && event.ids?.vision_id === 'vision-wire-safe' && event.ids?.to_id === 'posted');
  const safeParsed = proof.events.find(event => event.type === 'structa.trace' && event.ids?.vision_id === 'vision-wire-safe' && event.ids?.flow_id === 'plugin.message.parsed');
  assert.equal(safePosted.ids.image_placement_id, 'top-level');
  assert.equal(safePosted.ids.image_mode_id, 'raw-base64');
  assert.equal(safePosted.ids.image_mime_type_id, 'image.jpeg');
  assert.equal(safePosted.metrics.image_chars, 4321);
  assert.equal(safeParsed.ids.status_id, 'insufficient');
  assert.equal(safeParsed.ids.capture_kind_id, 'sketch_diagram');
  assert.equal(safeParsed.ids.project_role_id, 'external_reference');
  const serialized = JSON.stringify(proof);
  for (const value of ['private caption', 'RAW SECRET MODE', 'LEAK_IMAGE', 'private project description', 'client name']) {
    assert.equal(serialized.includes(value), false, value);
  }
  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  assert.deepEqual(validateDeviceProof(proof).errors, []);
  runtime.dom.window.close();
});

test('base64 transport reassembles with checksum and digest email is explicit only', async () => {
  const runtime = boot('https://structa.test/?lab=1', '', { compression: false });
  runtime.window.StructaDeviceLab.finish();
  const result = await runtime.window.StructaDeviceLab.exportProof();
  assert.equal(result.email.encoding, 'base64');
  assert.equal(runtime.emails.length, result.email.total);
  const { decodeDeviceProofTransport } = await import('../scripts/validate-device-proof.mjs');
  const decoded = decodeDeviceProofTransport(runtime.emails.map(email => email.body));
  assert.equal(decoded.session_id, result.session_id);
  const tampered = runtime.emails.map(email => email.body);
  const lastPart = tampered.at(-1);
  const dataAt = lastPart.indexOf('data=\n') + 'data=\n'.length;
  const data = lastPart.slice(dataAt);
  const changeAt = Math.max(0, data.search(/[A-Za-z0-9]/));
  const changed = data[changeAt] === 'A' ? 'B' : 'A';
  tampered[tampered.length - 1] = lastPart.slice(0, dataAt) + data.slice(0, changeAt) + changed + data.slice(changeAt + 1);
  assert.throws(() => decodeDeviceProofTransport(tampered), /checksum|decode|base64/);
  runtime.dom.window.close();

  const failed = boot('https://structa.test/?lab=1', '', {
    emailHandler: () => ({ ok: false, mode: 'unavailable' })
  });
  const failedResult = await failed.window.StructaDeviceLab.exportProof({ emailDigest: true });
  assert.equal(failedResult.email.sent, 0);
  assert.equal(failedResult.digest_email.attempted, true);
  assert.equal(failed.emails.length, 2, 'one transport attempt plus one explicitly requested digest; no retry');
  assert.match(failed.emails[0].body, /^STRUCTA_DEVICE_PROOF_TRANSPORT_V1/);
  assert.match(failed.emails[1].body, /^STRUCTA DEVICE PROOF/);
  failed.dom.window.close();
});

test('staged phase evidence stays incomplete instead of being reported as a failure', async () => {
  const runtime = boot('https://structa.test/?lab=1');
  const lab = runtime.window.StructaDeviceLab;
  lab.setStep('B01');
  lab.setStep('B02');
  lab.setStep('B03');
  lab.finish();
  const proof = lab.getProof();
  assert.equal(invariant(proof, 'coverage.phase_sequence').pass, null);
  assert.equal(invariant(proof, 'input.b02_press_pairs').pass, null);
  assert.equal(invariant(proof, 'input.b03_touch_camera_open').pass, null);
  assert.equal(invariant(proof, 'camera.b03_cancel_without_capture').pass, null);
  assert.equal(invariant(proof, 'transport.no_speaker_request').pass, null);
  assert.equal(invariant(proof, 'transport.no_journal_request').pass, null);

  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  const result = validateDeviceProof(proof);
  assert.deepEqual(result.errors, []);
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.incomplete_invariants.includes('coverage.phase_sequence'));
  runtime.dom.window.close();
});

test('B03 distinguishes touch activation and in-app no-capture cancel from host or capture paths', async () => {
  const sideOnly = boot('https://structa.test/?lab=1');
  sideOnly.window.StructaDeviceLab.setStep('B03');
  sideOnly.window.dispatchEvent(new sideOnly.window.CustomEvent('sideClick'));
  sideOnly.window.dispatchEvent(new sideOnly.window.CustomEvent('structa-camera-open'));
  let proof = sideOnly.window.StructaDeviceLab.getProof();
  assert.equal(invariant(proof, 'input.b03_touch_camera_open').pass, false);
  assert.equal(invariant(proof, 'camera.b03_cancel_without_capture').pass, null);
  sideOnly.dom.window.close();

  const capturedThenClosed = boot('https://structa.test/?lab=1');
  capturedThenClosed.window.StructaDeviceLab.setStep('B03');
  emitDirectTouch(capturedThenClosed.window, 31);
  capturedThenClosed.window.dispatchEvent(new capturedThenClosed.window.CustomEvent('structa-camera-open'));
  capturedThenClosed.window.dispatchEvent(new capturedThenClosed.window.CustomEvent('structa-capture-stored', {
    detail: { entryId: 'capture-before-close' }
  }));
  capturedThenClosed.window.dispatchEvent(new capturedThenClosed.window.CustomEvent('structa-camera-close'));
  proof = capturedThenClosed.window.StructaDeviceLab.getProof();
  assert.equal(invariant(proof, 'input.b03_touch_camera_open').pass, true);
  assert.equal(invariant(proof, 'camera.b03_cancel_without_capture').pass, null);

  emitDirectTouch(capturedThenClosed.window, 32);
  capturedThenClosed.window.dispatchEvent(new capturedThenClosed.window.CustomEvent('structa-camera-open'));
  capturedThenClosed.window.dispatchEvent(new capturedThenClosed.window.CustomEvent('structa-camera-close'));
  proof = capturedThenClosed.window.StructaDeviceLab.getProof();
  assert.equal(invariant(proof, 'camera.b03_cancel_without_capture').pass, true);

  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  assert.deepEqual(validateDeviceProof(proof).errors, []);
  capturedThenClosed.dom.window.close();
});

test('observed transport, correlation, press-pair, and blocked-queue violations fail honestly', async () => {
  const runtime = boot('https://structa.test/?lab=1', '', {
    queueSnapshot: [{ id: 'job-blocked', status: 'blocked' }]
  });
  const { window } = runtime;
  const lab = window.StructaDeviceLab;

  lab.setStep('B02');
  window.dispatchEvent(new window.CustomEvent('pttStart'));
  window.dispatchEvent(new window.CustomEvent('longPressEnd'));
  lab.setStep('B03');
  window.dispatchEvent(new window.CustomEvent('structa-capture-stored', {
    detail: { entryId: 'capture-duplicate' }
  }));
  lab.setStep('B04');
  emitTrace(window, 'vision.analysis', 'saved', 'requested', {
    captureId: 'capture-duplicate',
    visionId: 'vision-duplicate'
  });
  emitTrace(window, 'vision.bridge', 'prepare', 'posted', { visionId: 'vision-duplicate' });
  emitTrace(window, 'vision.bridge', 'prepare', 'posted', { visionId: 'vision-duplicate' });
  emitTrace(window, 'plugin.message.parsed', 'in', 'vision', { visionId: 'vision-duplicate' });
  emitTrace(window, 'vision.analysis', 'requested', 'stored', {
    captureId: 'capture-duplicate',
    visionId: 'vision-duplicate'
  });
  window.PluginMessageHandler.postMessage(JSON.stringify({
    correlationId: 'transport-violation',
    wantsR1Response: true,
    wantsJournalEntry: false,
    useLLM: false
  }));
  lab.setStep('B06');
  lab.finish();

  const proof = lab.getProof();
  assert.equal(invariant(proof, 'transport.no_speaker_request').pass, false);
  assert.equal(invariant(proof, 'transport.no_journal_request').pass, true);
  assert.equal(invariant(proof, 'vision.id_chain_matches').pass, false);
  assert.equal(invariant(proof, 'vision.b04_matrix').pass, false);
  assert.ok(invariant(proof, 'vision.b04_matrix').invalid > 0);
  assert.equal(invariant(proof, 'input.b02_press_pairs').pass, false);
  assert.equal(invariant(proof, 'queue.settled_at_finish').pass, false);
  assert.equal(invariant(proof, 'queue.settled_at_finish').blocked, 1);

  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  const result = validateDeviceProof(proof);
  assert.deepEqual(result.errors, []);
  assert.equal(result.verdict, 'failed');
  for (const id of [
    'transport.no_speaker_request',
    'vision.id_chain_matches',
    'vision.b04_matrix',
    'input.b02_press_pairs',
    'queue.settled_at_finish'
  ]) assert.ok(result.failed_invariants.includes(id), id);
  runtime.dom.window.close();
});

test('an unfinished session resumes within the twelve-hour lab window and validator rejects sensitive fields', async () => {
  const first = boot('https://structa.test/?lab=1');
  first.window.StructaDeviceLab.setStep('now_decision');
  first.window.StructaDeviceLab.markManual('decision_visible', true);
  const stored = first.window.localStorage.getItem('structa.device-proof.v1.active');
  const sessionId = first.window.StructaDeviceLab.getProof().session_id;
  first.dom.window.close();

  const second = boot('https://structa.test/?lab=1', stored);
  const resumed = second.window.StructaDeviceLab.getProof();
  assert.equal(resumed.session_id, sessionId);
  assert.equal(resumed.step_id, 'now_decision');
  assert.ok(resumed.events.some(event => event.type === 'session.resume'));

  const { validateDeviceProof } = await import('../scripts/validate-device-proof.mjs');
  const tampered = JSON.parse(JSON.stringify(resumed));
  tampered.events[0].payload = { transcript: 'must never be present' };
  const verdict = validateDeviceProof(tampered);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(error => error.includes('forbidden')));
  second.dom.window.close();
});
