const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const vision = require('../js/vision-protocol.js');

function validEnvelope(visionId) {
  return {
    schema: vision.SCHEMA,
    vision_id: visionId,
    status: 'observed',
    capture_kind: 'space',
    project_role: 'external_reference',
    project_role_confidence: 0.9,
    ocr: [],
    observations: [{ id: 'obs_1', text: 'A narrow room has two visible openings.', confidence: 0.93 }],
    interpretations: [{
      id: 'int_1',
      text: 'The openings may connect adjacent circulation areas.',
      observation_ids: ['obs_1'],
      confidence: 0.66
    }],
    implications: [{
      id: 'imp_1',
      kind: 'question',
      text: 'Confirm which opening is the primary route.',
      interpretation_ids: ['int_1'],
      confidence: 0.62,
      requires_user_approval: false
    }],
    uncertainties: [{
      id: 'unc_1',
      question: 'The destination of each opening is not visible.',
      impact: 'medium',
      related_ids: ['obs_1']
    }]
  };
}

function insufficientEnvelope(visionId) {
  return {
    schema: vision.SCHEMA,
    vision_id: visionId,
    status: 'insufficient',
    capture_kind: 'unknown',
    project_role: 'unknown',
    project_role_confidence: 0.2,
    ocr: [],
    observations: [],
    interpretations: [],
    implications: [],
    uncertainties: [{
      id: 'unc_1',
      question: 'The image could not be read.',
      impact: 'high',
      related_ids: []
    }]
  };
}

function createRuntime(options = {}) {
  const posted = [];
  const dispatched = [];
  const traces = [];
  const emailCalls = [];
  const native = {
    deviceId: 'test-device',
    probeMode: false,
    getProjectMemory() {
      return {
        project_id: 'prj_test',
        name: 'Test project',
        type: 'general',
        brief: 'A bridge test',
        claims: [],
        nodes: [],
        captures: [],
        open_question_nodes: []
      };
    },
    getClaimsForItem() { return []; },
    traceEvent(flow, from, to, context) { traces.push({ flow, from, to, context }); },
    recordProductEvent() {},
    appendLogEntry() {},
    recordVoiceCall() {}
  };
  const window = {
    StructaNative: native,
    StructaVisionProtocol: vision,
    StructaAudio: {},
    __structaCaps: { hasBridge: true, hasVoiceBridge: false, hasNativeCamera: false, hasTone: false },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) { dispatched.push(event); },
    r1: options.nativeEmail === false ? {} : {
      messaging: {
        emailUser(content, emailOptions) {
          emailCalls.push({ content, options: emailOptions });
          return options.emailResult === undefined ? { ok: true } : options.emailResult;
        }
      }
    }
  };
  const context = vm.createContext({
    window,
    document: { createElement() { return {}; } },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    PluginMessageHandler: options.bridge === false ? undefined : {
      postMessage(payload) { posted.push(JSON.parse(payload)); }
    },
    setTimeout,
    clearTimeout,
    console
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'r1-llm.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'r1-llm.js' });
  return { window, posted, dispatched, traces, emailCalls };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('r1 image bridge posts exact payload and resolves only exact schema/id response', async () => {
  const runtime = createRuntime();
  const pending = runtime.window.StructaLLM.sendBridgeImage(
    'data:image/png;base64,YWJj',
    'Inspect this material reference.',
    { captureId: 'cap_test', timeout: 2000, imageInputMode: 'raw-base64' }
  );

  await waitUntil(() => runtime.posted.length === 1);
  const outbound = runtime.posted[0];
  const visionId = vision.extractVisionIdFromPrompt(outbound.message);
  assert.ok(visionId);
  assert.deepEqual(outbound, {
    message: outbound.message,
    imageBase64: 'YWJj',
    useLLM: true,
    wantsR1Response: false,
    wantsJournalEntry: false
  });
  assert.equal(Object.hasOwn(outbound, 'payload'), false);
  assert.equal(Object.hasOwn(outbound, 'pluginId'), false);
  assert.equal(Object.hasOwn(outbound, 'correlationId'), false);

  let settled = false;
  pending.then(() => { settled = true; });
  runtime.window.onPluginMessage({ status: 'processing' });
  runtime.window.onPluginMessage({ response: JSON.stringify(validEnvelope('vis_wrong_id')) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);

  const serialized = JSON.stringify(validEnvelope(visionId));
  const splitAt = Math.floor(serialized.length / 2);
  runtime.window.onPluginMessage({ data: { text: serialized.slice(0, splitAt) } });
  assert.equal(settled, false);
  runtime.window.onPluginMessage({ data: { text: serialized.slice(splitAt) } });

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.visionId, visionId);
  assert.equal(result.envelope.vision_id, visionId);
  assert.equal(result.observations.length, 1);
  assert.equal(result.interpretations.length, 1);
  assert.equal(result.implications.length, 1);
  assert.equal(result.uncertainties.length, 1);

  const postedTrace = runtime.traces.find(entry =>
    entry.flow === 'vision.bridge' && entry.from === 'prepare' && entry.to === 'posted'
  );
  assert.equal(postedTrace.context.imagePlacement, 'top-level');
  assert.equal(postedTrace.context.imageMode, 'raw-base64');
  assert.equal(postedTrace.context.imageChars, 4);
  assert.equal(postedTrace.context.imageMimeType, 'image/png');
  assert.deepEqual(Array.from(postedTrace.context.payloadKeys), [
    'message',
    'imageBase64',
    'useLLM',
    'wantsR1Response',
    'wantsJournalEntry'
  ]);

  const parsedTrace = runtime.traces.find(entry =>
    entry.flow === 'plugin.message.parsed' && entry.from === 'in' && entry.to === 'vision'
  );
  assert.equal(parsedTrace.context.status, 'observed');
  assert.equal(parsedTrace.context.captureKind, 'space');
  assert.equal(parsedTrace.context.projectRole, 'external_reference');
});

test('plain native-vision probe returns the device text before STRUCTA schema parsing', async () => {
  const runtime = createRuntime();
  const pending = runtime.window.StructaLLM.probeNativeImage(
    'data:image/jpeg;base64,YWJj',
    'Inspect the attached image. Return one factual sentence.',
    { captureId: 'cap_probe', timeout: 2000, imageInputMode: 'raw-base64' }
  );

  await waitUntil(() => runtime.posted.length === 1);
  const outbound = runtime.posted[0];
  assert.deepEqual(outbound, {
    message: 'Inspect the attached image. Return one factual sentence.',
    imageBase64: 'YWJj',
    useLLM: true,
    wantsR1Response: false,
    wantsJournalEntry: false
  });
  assert.doesNotMatch(outbound.message, /REQUIRED_SHAPE|structa\.vision\.v1/);

  runtime.window.onPluginMessage({ status: 'processing' });
  runtime.window.onPluginMessage({ response: 'A framed artwork shows white line drawings of camels on a dark background.' });
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.clean, 'A framed artwork shows white line drawings of camels on a dark background.');
  assert.ok(runtime.traces.some(entry =>
    entry.flow === 'vision.probe' && entry.from === 'bridge' && entry.to === 'stored' && entry.context.silent === true && entry.context.journal === false
  ));
});

test('r1 bridge forwards an empty sttEnded as a terminal capture event', () => {
  const runtime = createRuntime();

  runtime.window.onPluginMessage({ type: 'sttEnded', transcript: '' });

  assert.equal(runtime.dispatched.length, 1);
  assert.equal(runtime.dispatched[0].type, 'structa-stt-ended');
  assert.equal(runtime.dispatched[0].detail.transcript, '');
  assert.equal(runtime.posted.length, 0);
});

test('schema-valid insufficient remains transport success and is explicit in proof traces', async () => {
  const runtime = createRuntime();
  const pending = runtime.window.StructaLLM.sendBridgeImage(
    'YWJj',
    'Inspect this clear fixture.',
    { captureId: 'cap_insufficient', timeout: 2000, imageInputMode: 'raw-base64' }
  );

  await waitUntil(() => runtime.posted.length === 1);
  const visionId = vision.extractVisionIdFromPrompt(runtime.posted[0].message);
  runtime.window.onPluginMessage({ response: JSON.stringify(insufficientEnvelope(visionId)) });

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.envelope.status, 'insufficient');
  assert.equal(result.clean, 'visual signal insufficient');

  const parsedTrace = runtime.traces.find(entry =>
    entry.flow === 'plugin.message.parsed' && entry.from === 'in' && entry.to === 'vision'
  );
  assert.equal(parsedTrace.context.status, 'insufficient');
  assert.equal(parsedTrace.context.observationCount, 0);
  assert.equal(parsedTrace.context.uncertaintyCount, 1);
});

test('proof email requests use the direct R1 bridge without an injected window.r1 facade', async () => {
  const runtime = createRuntime({ nativeEmail: false });
  const result = await runtime.window.StructaLLM.emailText(
    'STRUCTA proof ST-20260812-test [1/2]',
    'STRUCTA_DEVICE_PROOF_TRANSPORT_V1\nPART 1/2'
  );

  assert.deepEqual(
    { ok: result.ok, requested: result.requested, confirmed: result.confirmed, mode: result.mode },
    { ok: true, requested: true, confirmed: false, mode: 'bridge-requested' }
  );
  assert.equal(runtime.emailCalls.length, 0);
  assert.equal(runtime.posted.length, 1);
  assert.equal(
    runtime.posted[0].message,
    'Please email this to the user: STRUCTA proof ST-20260812-test [1/2]\n\nSTRUCTA_DEVICE_PROOF_TRANSPORT_V1\nPART 1/2'
  );
  assert.equal(runtime.posted[0].useLLM, true);
  assert.equal(runtime.posted[0].useSerpAPI, false);
  assert.equal(runtime.posted[0].wantsR1Response, false);
  assert.equal(runtime.posted[0].wantsJournalEntry, false);
});

test('proof email retains the optional native facade fallback when no direct bridge exists', async () => {
  const runtime = createRuntime({ bridge: false });
  const result = await runtime.window.StructaLLM.emailText('STRUCTA proof', 'PART');

  assert.equal(result.ok, true);
  assert.equal(result.requested, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.mode, 'native-requested');
  assert.equal(runtime.emailCalls.length, 1);
  assert.equal(runtime.emailCalls[0].content, 'STRUCTA proof\n\nPART');
  assert.equal(runtime.posted.length, 0);
});
