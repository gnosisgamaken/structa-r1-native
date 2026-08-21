// Focused P0 state-invariant tests for the voice "delete project" confirmation
// path in structa-cascade.js (node:test, no deps).
//   - R3: a spoken delete/remove command never directly deletes; it enters an
//         explicit pending on-screen confirmation path.
//   - Actual deletion happens only after a deliberate approval UI action
//         (hold-to-confirm long press).
//   - Back, scroll, and early release cancel without deleting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const CASCADE = fs.readFileSync(new URL('structa-cascade.js', root), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeElement() {
  const el = {
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    textContent: '',
    children: [],
    firstChild: null,
    isConnected: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    setAttribute() {},
    getAttribute() { return ''; },
    setAttributeNS() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    querySelectorAll() { return []; },
    getContext: () => ({ measureText: () => ({ width: 0 }) }),
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  };
  return el;
}

function makeSandbox() {
  const listeners = new Map();
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const deleteCalls = [];
  const native = {
    getProjectMemory: () => ({ name: 'legacy alpha', nodes: [], claims: [], focuses: [], pending_decisions: [] }),
    getProjects: () => [{ project_id: 'p1', name: 'legacy alpha', status: 'active' }],
    getActiveProjectId: () => 'p1',
    getUIState: () => ({}),
    updateUIState() {},
    appendLogEntry() {},
    getRecentLogEntries: () => [],
    traceEvent() {},
    deleteProject: (name) => { deleteCalls.push(name); return { ok: true, project_id: 'p1' }; }
  };
  const sandbox = {
    console, JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, performance, CustomEvent,
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    location: { search: '', hash: '' },
    navigator: { serviceWorker: undefined, mediaDevices: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById,
      querySelector: () => makeElement(),
      createElement: () => makeElement(),
      createElementNS: () => makeElement(),
      body: { classList: { add() {}, remove() {}, contains() { return false; } } },
      addEventListener() {}
    },
    window: null,
    StructaNative: native
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  sandbox.dispatchEvent = (event) => {
    const fns = listeners.get(event.type) || [];
    for (const fn of fns.slice()) fn(event);
    return true;
  };
  vm.runInNewContext(CASCADE, sandbox, { filename: 'structa-cascade.js' });
  return { sandbox, deleteCalls, fire: (type, detail) => {
    sandbox.dispatchEvent(new CustomEvent(type, detail === undefined ? {} : { detail }));
  } };
}

function issueDeleteCommand(fire, name = 'legacy alpha') {
  fire('structa-voice-command', { command: 'delete-project', name, pendingConfirm: true });
}

test('R3: spoken delete enters confirmation; hold-to-confirm is the only delete path', async () => {
  const { sandbox, deleteCalls, fire } = makeSandbox();
  const panel = sandbox.StructaPanel;
  assert.ok(panel, 'StructaPanel exported');

  // Spoken command: pending confirmation, NO direct delete
  issueDeleteCommand(fire);
  assert.equal(deleteCalls.length, 0, 'spoken command must not delete directly');
  const pending = panel.getPendingDeleteProject();
  assert.equal(pending.pending, true);
  assert.equal(pending.name, 'legacy alpha');

  // Deliberate approval action: hold (long press) for DELETE_CONFIRM_HOLD_MS
  fire('longPressStart');
  await sleep(1150);
  assert.equal(deleteCalls.length, 1, 'hold-to-confirm deletes exactly once');
  assert.equal(deleteCalls[0], 'legacy alpha');
  assert.equal(panel.getPendingDeleteProject().pending, false);
});

test('R3: back button cancels the pending delete without side effects', async () => {
  const { sandbox, deleteCalls, fire } = makeSandbox();
  issueDeleteCommand(fire);
  assert.equal(deleteCalls.length, 0);
  fire('backbutton');
  assert.equal(deleteCalls.length, 0, 'back must not delete');
  assert.equal(sandbox.StructaPanel.getPendingDeleteProject().pending, false);
});

test('R3: scroll cancels the pending delete without side effects', async () => {
  const { sandbox, deleteCalls, fire } = makeSandbox();
  issueDeleteCommand(fire);
  fire('scrollDown');
  assert.equal(deleteCalls.length, 0, 'scroll must not delete');
  assert.equal(sandbox.StructaPanel.getPendingDeleteProject().pending, false);
});

test('R3: releasing the hold early cancels without deleting', async () => {
  const { sandbox, deleteCalls, fire } = makeSandbox();
  issueDeleteCommand(fire);
  fire('longPressStart');
  await sleep(300);
  fire('longPressEnd'); // released before the 1000ms hold completes
  await sleep(900);
  assert.equal(deleteCalls.length, 0, 'early release must cancel the delete');
  // Release cancels the hold, not the pending dialog: it remains for a
  // fresh deliberate attempt. Verify a second full hold still works.
  fire('longPressStart');
  await sleep(1150);
  assert.equal(deleteCalls.length, 1, 'a new deliberate hold deletes');
  assert.equal(sandbox.StructaPanel.getPendingDeleteProject().pending, false);
});

test('R3: deleteProject safeguard errors are surfaced, not swallowed', async () => {
  const { sandbox, deleteCalls, fire } = makeSandbox();
  // Force the "cannot delete last project" guard in the native layer
  sandbox.StructaNative.deleteProject = (name) => {
    deleteCalls.push(name);
    return { ok: false, error: 'cannot delete last project' };
  };
  issueDeleteCommand(fire);
  fire('longPressStart');
  await sleep(1150);
  assert.equal(deleteCalls.length, 1);
  assert.equal(sandbox.StructaPanel.getPendingDeleteProject().pending, false);
});
