// Focused P0 state-invariant tests for js/impact-chain-engine.js (node:test, no deps).
//   - R2: a successful chain step stays success/progress, emits structa-impact
//         with accurate produced counts, and never hits the rejected path.
//   - R4: no unattended beat creates a decision/task node; outputs are advisory
//         proposals; nodes are created only via approveChainProposal; dismiss cancels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const ENGINE = fs.readFileSync(new URL('js/impact-chain-engine.js', root), 'utf8');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSandbox() {
  const listeners = new Map();
  const events = [];
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const project = {
    name: 'test project',
    project_id: 'p1',
    nodes: [],
    claims: [],
    impact_chain: [],
    focuses: [{
      id: 'f1', phase: 'observe', state: 'active',
      target: { kind: 'branch', id: 'main', branchId: 'main' },
      steps: [], plateauCount: 0, rejectCount: 0, lastStepAt: ''
    }],
    activeFocusId: 'f1'
  };
  const state = {
    project,
    focus: project.focuses[0],
    traces: [],
    deleteCalls: [],
    addNodeCalls: [],
    nextNodeId: 1,
    nextClaimId: 1,
    nextResult: null
  };
  const sandbox = {
    console, JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval, CustomEvent,
    document: { addEventListener() {} },
    window: null,
    __events: events
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  sandbox.dispatchEvent = (event) => {
    events.push(event);
    const fns = listeners.get(event.type) || [];
    for (const fn of fns.slice()) fn(event);
    return true;
  };
  sandbox.StructaNative = {
    getProjectMemory: () => state.project,
    getActiveFocus: () => state.focus,
    activateNextFocus: () => null,
    updateActiveFocus: (patch) => Object.assign(state.focus, patch),
    completeActiveFocus: (outcome) => { state.focus.state = outcome; },
    touchProjectMemory: (fn) => { fn(state.project); },
    addNode: (input) => {
      state.addNodeCalls.push(input);
      const node = { node_id: 'n' + (state.nextNodeId++), ...input };
      state.project.nodes.unshift(node);
      return node;
    },
    ingestClaims: (payload) => {
      const out = [];
      for (const claim of payload) {
        const dup = state.project.claims.find((existing) => existing.text === claim.text);
        if (dup) { out.push(dup); continue; }
        const fresh = { id: 'c' + (state.nextClaimId++), ...claim };
        state.project.claims.push(fresh);
        out.push(fresh);
      }
      return out;
    },
    traceEvent: (...args) => { state.traces.push(args); },
    validateEvidenceIntegrity: () => true,
    storage: { plain: { read: () => Promise.resolve({ value: null }) } }
  };
  sandbox.StructaLLM = { executePreparedLLM: () => {} };
  sandbox.StructaOrchestrator = {
    runChainStep: () => Promise.resolve({ ok: true, jobId: 'j1', ...state.nextResult })
  };
  sandbox.StructaContracts = {
    validateChainOutput: (result) => ({ ok: true, value: result })
  };
  vm.runInNewContext(ENGINE, sandbox, { filename: 'js/impact-chain-engine.js' });
  return { sandbox, state, events };
}

test('R2+R4: successful chain step stays progress, no decision/task nodes, accurate counts', async () => {
  const { sandbox, state, events } = makeSandbox();
  state.nextResult = {
    focus: { phase_next: 'observe', state_next: 'active' },
    produced: {
      claims: [{ text: 'the bridge spans', kind: 'fact', branchId: 'main', evidence: ['c0'] }],
      questions: [{ body: 'what load?', meta: { evidence_claims: ['c0'], rationale: 'r' } }],
      decisions: [{ body: 'use steel', evidence: ['c0', 'c1'], options: ['steel', 'wood'], recommended: 'steel' }],
      tasks: [{ body: 'order steel', evidence: ['c0'] }]
    },
    step_metadata: { rationale: 'reasoning', confidence: 0.8 }
  };
  sandbox.StructaImpactChain.start(2);
  await sleep(450);

  // R2: success path — no rejected traces, step outcome is progress
  const rejected = state.traces.filter((t) => String(t[0]).indexOf('reject') !== -1 || String(t[0]) === 'focus.step.rejected');
  assert.equal(rejected.length, 0, 'no rejected traces on success');
  const step = state.project.focuses[0].steps[state.project.focuses[0].steps.length - 1];
  assert.ok(step, 'a focus step was written');
  assert.equal(step.outcome, 'progress');
  assert.equal(state.project.focuses[0].rejectCount, 0, 'focus reject counter untouched');

  // R4: no decision/task node created by the beat
  const mutated = state.project.nodes.filter((n) => n.type === 'decision' || n.type === 'task');
  assert.equal(mutated.length, 0, 'beat must not create decision/task nodes');

  // Advisory proposals exist with accurate counts
  const pending = sandbox.StructaImpactChain.getPendingChainOutputs();
  assert.equal(pending.length, 2);
  const decisionProposal = pending.find((p) => p.kind === 'decision');
  const taskProposal = pending.find((p) => p.kind === 'task');
  assert.ok(decisionProposal && taskProposal, 'decision and task proposals present');

  // structa-impact event carries correct produced counts
  const impact = events.find((e) => e.type === 'structa-impact');
  assert.ok(impact, 'structa-impact emitted');
  assert.equal(impact.detail.produced.decisionProposals.length, 1);
  assert.equal(impact.detail.produced.taskProposals.length, 1);
  assert.equal(impact.detail.produced.claimIds.length, 1);
  assert.equal(impact.detail.produced.questionIds.length, 1);
  assert.equal(impact.detail.produced.count, 4);

  // Explicit approval materializes nodes (the deliberate path)
  const approved = sandbox.StructaImpactChain.approveChainProposal(decisionProposal.proposal_id, 0, null);
  assert.equal(approved.ok, true);
  const decisionNode = state.project.nodes.find((n) => n.type === 'decision');
  assert.ok(decisionNode, 'decision node created only after approval');
  assert.equal(decisionNode.status, 'resolved');
  assert.equal(decisionNode.selected_option, 'steel');
  assert.equal(decisionNode.meta.approved_by, 'user');
  assert.equal(sandbox.StructaImpactChain.totalDecisions, 1);
  assert.ok(events.some((e) => e.type === 'structa-decision-created'), 'decision-created event on approval');

  const approvedTask = sandbox.StructaImpactChain.approveChainProposal(taskProposal.proposal_id);
  assert.equal(approvedTask.ok, true);
  const taskNode = state.project.nodes.find((n) => n.type === 'task');
  assert.ok(taskNode, 'task node created only after approval');
  assert.equal(taskNode.status, 'open');

  // Proposals consumed after approval
  assert.equal(sandbox.StructaImpactChain.getPendingChainOutputs().length, 0);
  sandbox.StructaImpactChain.stop(); // clear beat timers so the process can exit
});

test('R4: dismiss cancels a proposal without creating any node', async () => {
  const { sandbox, state } = makeSandbox();
  state.nextResult = {
    focus: { phase_next: 'observe', state_next: 'active' },
    produced: {
      claims: [], questions: [],
      decisions: [{ body: 'ship monday', evidence: ['c0', 'c1'], options: ['monday', 'friday'], recommended: 'monday' }],
      tasks: []
    },
    step_metadata: { rationale: 'r', confidence: 0.7 }
  };
  sandbox.StructaImpactChain.start(2);
  await sleep(450);

  const pending = sandbox.StructaImpactChain.getPendingChainOutputs();
  assert.equal(pending.length, 1);
  const proposalId = pending[0].proposal_id;

  const dismissed = sandbox.StructaImpactChain.dismissChainProposal(proposalId);
  assert.equal(dismissed.ok, true);
  assert.equal(sandbox.StructaImpactChain.getPendingChainOutputs().length, 0);
  const mutated = state.project.nodes.filter((n) => n.type === 'decision' || n.type === 'task');
  assert.equal(mutated.length, 0, 'dismiss must not create nodes');

  // Duplicate proposals dedupe: same decision proposed again adds nothing
  const again = sandbox.StructaImpactChain.approveChainProposal('missing-proposal-id');
  assert.equal(again.ok, false, 'unknown proposal id rejected');
  sandbox.StructaImpactChain.stop(); // clear beat timers so the process can exit
});
