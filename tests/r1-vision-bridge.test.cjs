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

function createRuntime() {
  const posted = [];
  const dispatched = [];
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
    traceEvent() {},
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
    r1: {}
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
    PluginMessageHandler: {
      postMessage(payload) { posted.push(JSON.parse(payload)); }
    },
    setTimeout,
    clearTimeout,
    console
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'r1-llm.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'r1-llm.js' });
  return { window, posted, dispatched };
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
    payload: { imageBase64: 'YWJj' },
    useLLM: true,
    wantsR1Response: false,
    wantsJournalEntry: false
  });
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
});

test('r1 bridge forwards an empty sttEnded as a terminal capture event', () => {
  const runtime = createRuntime();

  runtime.window.onPluginMessage({ type: 'sttEnded', transcript: '' });

  assert.equal(runtime.dispatched.length, 1);
  assert.equal(runtime.dispatched[0].type, 'structa-stt-ended');
  assert.equal(runtime.dispatched[0].detail.transcript, '');
  assert.equal(runtime.posted.length, 0);
});
