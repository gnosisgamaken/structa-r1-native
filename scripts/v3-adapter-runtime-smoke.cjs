const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const dom = new JSDOM('<!doctype html><title>structa</title>', {
  url: 'https://structa.local/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
window.console = console;
window.StructaActionRouter = {
  getContext() { return null; },
  updateContext() {},
  setActiveVerb() {},
  setActiveNode() {},
  routeAction() { return { ok: false }; }
};

for (const file of ['js/contracts.js', 'js/validation.js', 'js/rabbit-adapter.js']) {
  window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
}

const native = window.StructaNative;
const fourOptions = ['prototype', 'interview', 'field test', 'campaign test'];
const created = native.addNode({
  node_id: 'decision-four-option-runtime',
  type: 'decision',
  status: 'open',
  title: 'which proof should lead?',
  body: 'choose the first validation method',
  source: 'runtime-smoke',
  decision_options: fourOptions,
  meta: { decision_id: 'decision-four-option-runtime' }
});

assert.equal(created.decision_options.length, 4, 'contracts and adapter must persist all four options');
assert.deepEqual(Array.from(created.decision_options), fourOptions);

const approved = native.approvePendingDecisionById('decision-four-option-runtime', 3, fourOptions[3]);
assert.equal(approved.ok, true);
let stored = native.getProjectMemory().nodes.find((node) => node.node_id === 'decision-four-option-runtime');
assert.equal(stored.status, 'resolved');
assert.equal(stored.selected_option, fourOptions[3]);
assert.equal(stored.decision_options.length, 4);

const reopened = native.reopenDecisionById('decision-four-option-runtime', 'compare the complete proof set');
assert.equal(reopened.ok, true);
stored = native.getProjectMemory().nodes.find((node) => node.node_id === 'decision-four-option-runtime');
assert.equal(stored.status, 'open');
assert.equal(stored.selected_option, null);
assert.deepEqual(Array.from(stored.decision_options), fourOptions);
assert.ok(stored.meta.history.some((entry) => entry.action === 'reopened'));

dom.window.close();
console.log('v3 adapter runtime smoke · 11 assertions passed');
