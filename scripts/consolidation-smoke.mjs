import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const files = [
  'js/contracts.js',
  'js/validation.js',
  'js/context-router.js',
  'js/rabbit-adapter.js',
  'js/capture-bundles.js'
];

const sandbox = {
  console,
  JSON,
  Date,
  Math,
  String,
  Number,
  Boolean,
  Array,
  Object,
  RegExp,
  Set,
  Map,
  structuredClone: globalThis.structuredClone,
  localStorage: {
    data: {},
    setItem(key, value) { this.data[key] = String(value); },
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; }
  },
  navigator: { mediaDevices: {}, vibrate: () => true },
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  window: null
};
sandbox.window = sandbox;
sandbox.window.dispatchEvent = () => true;

for (const file of files) {
  const code = fs.readFileSync(new URL(file, root), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: file });
}

const native = sandbox.window.StructaNative;
const captureBundles = sandbox.window.StructaCaptureBundles;
assert.ok(native, 'native adapter exists');
assert.ok(captureBundles, 'capture bundle helper exists');

const bundle = captureBundles.createCaptureBundle({
  image_asset: { name: 'x.png', mime_type: 'image/png', data: 'data:image/png;base64,AAA' },
  prompt_text: 'test',
  summary: 'summary'
});
const saved = native.storeCaptureBundle(bundle);
assert.equal(saved.ok, true);
assert.equal(native.getMemory().captures.length, 1);

for (let i = 0; i < 250; i += 1) native.emit('tick', { i });
assert.ok(native.getMemory().runtimeEvents.length <= 200, 'runtime events capped');

const queued = native.requestEmailWithdrawal({ title: 'Audit', body: 'Need review' });
assert.equal(queued.ok, true);
assert.equal(native.getMemory().exports.length, 1);

console.log('consolidation smoke test passed');
