import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const files = [
  new URL('./js/contracts.js', root),
  new URL('./js/context-router.js', root)
];

const sandbox = {
  console,
  structuredClone: globalThis.structuredClone,
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
  window: null
};
sandbox.window = sandbox;

for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(code, sandbox, { filename: file.pathname });
}

const router = sandbox.window.StructaActionRouter;
assert.ok(router, 'router should be defined');
assert.equal(router.canonicalizeVerb('please fix this'), 'patch');
assert.equal(router.canonicalizeVerb('build a new screen'), 'build');
assert.equal(router.canonicalizeVerb('research the doc'), 'research');
assert.equal(router.inferTarget('send the email now', 'withdraw'), 'export');

const routed = router.routeAction({ intent: 'Please build the project board', source_type: 'voice' });
assert.equal(routed.ok, true);
assert.equal(routed.route.verb, 'build');
assert.equal(routed.route.requires_approval, true);
assert.equal(routed.route.action_family, 'approval-gated');
assert.equal(routed.route.target, 'context');

const advisory = router.routeAction({ verb: 'solve', intent: 'solve the routing issue', target: 'issue' });
assert.equal(advisory.route.requires_approval, false);
assert.equal(advisory.route.action_family, 'advisory');
assert.equal(advisory.context_snapshot.active_verb, 'solve');

console.log('context-router smoke test passed');
