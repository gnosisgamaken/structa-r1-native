const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createVoiceRuntime() {
  const handlers = {};
  const events = {};
  const projects = {
    A: {
      project_id: 'A',
      name: 'untitled project',
      brief: '',
      nodes: [{ node_id: 'voice-a', type: 'voice-entry', status: 'open', body: 'origin note', meta: {} }],
      derived_candidates: { decisions: [], asks: [], blockers: [], themes: [] },
      claims: [],
      answers: [],
      open_questions: []
    },
    B: {
      project_id: 'B',
      name: 'project b',
      brief: 'keep b clean',
      nodes: [],
      derived_candidates: { decisions: [], asks: [], blockers: [], themes: [] },
      claims: [],
      answers: [],
      open_questions: []
    }
  };
  let activeId = 'A';
  const uiWrites = [];
  const decisionIngests = [];

  function touch(projectId, mutator) {
    const project = projects[projectId];
    if (!project) return null;
    mutator(project);
    return project;
  }

  const native = {
    getActiveProjectId: () => activeId,
    getProjectMemory: () => clone(projects[activeId]),
    getProjectMemoryById: id => projects[id] ? clone(projects[id]) : null,
    touchProjectMemory: mutator => touch(activeId, mutator),
    touchProjectMemoryById: (id, mutator) => touch(id, mutator),
    addNodeToProject(id, input) {
      const node = { node_id: input.node_id || `node-${projects[id].nodes.length + 1}`, links: [], ...clone(input) };
      projects[id].nodes.unshift(node);
      return clone(node);
    },
    ingestClaimsForProject(id, claims) {
      const stored = (claims || []).map((claim, index) => ({ id: claim.id || `claim-${id}-${index}`, ...clone(claim) }));
      projects[id].claims.unshift(...stored);
      return clone(stored);
    },
    saveDerivedCandidates(candidates, options = {}) {
      const id = options.projectId || activeId;
      const project = projects[id];
      for (const key of ['decisions', 'asks', 'blockers', 'themes']) {
        project.derived_candidates[key] = clone(candidates[key] || []);
      }
      return clone(candidates);
    },
    setProjectName(name, id = activeId) {
      if (projects[id].name === 'untitled project') projects[id].name = name;
      return projects[id];
    },
    setProjectMark(mark, id = activeId) {
      projects[id].project_mark = mark;
      return mark;
    },
    setProjectBrief(brief, options = {}) {
      projects[options.projectId || activeId].brief = brief;
      return brief;
    },
    updateUIState(patch) { uiWrites.push(clone(patch)); },
    recordOperationWrite() { return { ok: true }; },
    finishOperation() {},
    traceEvent() {},
    appendLogEntry() {},
    emitModelChange() {},
    getClaimsForItem() { return []; }
  };

  const queue = {
    registerHandler(kind, handler) { handlers[kind] = handler; },
    enqueue() {},
    snapshot() { return []; }
  };
  const element = () => ({
    textContent: '',
    hidden: false,
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {}
  });
  const document = {
    hidden: false,
    getElementById() { return element(); },
    addEventListener(type, listener) { (events[`document:${type}`] ||= []).push(listener); }
  };
  const window = {
    StructaNative: native,
    StructaProcessingQueue: queue,
    StructaProjectEngine: {
      ingestDecisionCandidates(candidates, meta) {
        decisionIngests.push({ candidates: clone(candidates), meta: clone(meta) });
      },
      seedFromBrief(result, meta) {
        touch(meta.projectId, project => { project.structa_v3_seed = clone(result); });
      },
      applyOperation(operation) {
        if (operation.project_id !== activeId) return { ok: false, stale: true };
        touch(operation.project_id, project => {
          project.approved_decision = {
            id: operation.decision_id,
            selected_option: operation.selected_option
          };
        });
        return { ok: true };
      }
    },
    StructaLLM: {},
    StructaFeedback: { fire() {} },
    addEventListener(type, listener) { (events[type] ||= []).push(listener); },
    dispatchEvent(event) {
      for (const listener of events[event.type] || []) listener(event);
      return true;
    }
  };
  window.window = window;
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  const context = vm.createContext({
    window,
    document,
    CustomEvent,
    navigator: {},
    setTimeout() { return 1; },
    clearTimeout() {},
    console
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'voice-capture.js'), 'utf8'),
    context,
    { filename: 'voice-capture.js' }
  );
  return {
    window,
    native,
    handlers,
    projects,
    uiWrites,
    decisionIngests,
    setActive(id) { activeId = id; }
  };
}

test('late voice interpretation writes to project A after switching to B', async () => {
  const runtime = createVoiceRuntime();
  const pending = deferred();
  runtime.window.StructaLLM.processVoice = () => pending.promise;

  const handled = runtime.handlers['voice-interpret']({
    id: 'voice-job',
    payload: {
      mode: 'voice',
      projectId: 'A',
      transcript: 'choose the calm direction',
      voiceEntryId: 'voice-a',
      operationId: 'op-a'
    }
  });
  runtime.setActive('B');
  pending.resolve({
    ok: true,
    clean: 'calm direction framed',
    structured: { decision: 'Which calm direction should lead?', type: 'decision' }
  });
  await handled;

  assert.equal(runtime.projects.A.nodes[0].meta.transformed_text, 'calm direction framed');
  assert.equal(runtime.projects.A.derived_candidates.decisions.length, 1);
  assert.equal(runtime.projects.B.nodes.length, 0);
  assert.equal(runtime.projects.B.derived_candidates.decisions.length, 0);
  assert.equal(runtime.uiWrites.length, 0, 'late A work must not repaint B');
  assert.equal(runtime.decisionIngests[0].meta.projectId, 'A');
});

test('late project brief writes to project A after switching to B', async () => {
  const runtime = createVoiceRuntime();
  const pending = deferred();
  runtime.window.StructaLLM.buildProjectBrief = () => pending.promise;

  const handled = runtime.handlers['project-brief']({
    id: 'brief-job',
    payload: {
      projectId: 'A',
      transcript: 'build a quiet project instrument',
      voiceEntryId: 'voice-a',
      operationId: 'op-brief-a'
    }
  });
  runtime.setActive('B');
  pending.resolve({
    ok: true,
    title: 'quiet instrument',
    brief: 'A governed project instrument.',
    candidates: { decisions: [{ text: 'Which workflow leads?' }], asks: [], blockers: [], themes: [] },
    constitution: { outcome: 'A clear map.' },
    branches: []
  });
  await handled;

  assert.equal(runtime.projects.A.name, 'quiet instrument');
  assert.equal(runtime.projects.A.brief, 'A governed project instrument.');
  assert.equal(runtime.projects.A.nodes[0].meta.onboarding_brief, 'A governed project instrument.');
  assert.equal(runtime.projects.B.name, 'project b');
  assert.equal(runtime.projects.B.brief, 'keep b clean');
  assert.equal(runtime.projects.B.derived_candidates.decisions.length, 0);
  assert.equal(runtime.uiWrites.length, 0, 'late A brief must not repaint B');
});

test('decision-answer preserves speech and approves the stable id in its origin project', () => {
  const runtime = createVoiceRuntime();
  runtime.projects.A.pending_decisions = [{ id: 'decision-a' }];
  runtime.window.StructaVoice.setBuildContext({
    kind: 'decision-answer',
    projectId: 'A',
    decisionId: 'decision-a'
  });
  runtime.window.dispatchEvent(new (class {
    constructor() {
      this.type = 'structa-stt-ended';
      this.detail = { transcript: 'lead with the working prototype' };
    }
  })());

  const voice = runtime.projects.A.nodes.find(node => node.source === 'decision-answer');
  assert.equal(voice.body, 'lead with the working prototype');
  assert.deepEqual(runtime.projects.A.approved_decision, {
    id: 'decision-a',
    selected_option: 'lead with the working prototype'
  });
  assert.equal(runtime.projects.B.nodes.length, 0);
});

function createResearchRuntime() {
  const posted = [];
  const projects = {
    A: { project_id: 'A', name: 'project a', brief: 'origin', nodes: [], claims: [], open_question_nodes: [] },
    B: { project_id: 'B', name: 'project b', brief: 'clean', nodes: [], claims: [], open_question_nodes: [] }
  };
  let activeId = 'A';
  const native = {
    deviceId: 'device-test',
    probeMode: false,
    getActiveProjectId: () => activeId,
    getProjectMemory: () => clone(projects[activeId]),
    getProjectMemoryById: id => projects[id] ? clone(projects[id]) : null,
    getClaimsForItem() { return []; },
    addNodeToProject(id, input) {
      const node = { node_id: `research-${projects[id].nodes.length + 1}`, ...clone(input) };
      projects[id].nodes.unshift(node);
      return clone(node);
    },
    traceEvent() {},
    recordProductEvent() {},
    appendLogEntry() {},
    recordVoiceCall() {}
  };
  const window = {
    StructaNative: native,
    StructaAudio: {},
    __structaCaps: { hasBridge: true, hasVoiceBridge: false, hasNativeCamera: false, hasTone: false },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    r1: {}
  };
  const context = vm.createContext({
    window,
    document: { createElement() { return {}; } },
    PluginMessageHandler: {
      postMessage(payload) { posted.push(JSON.parse(payload)); }
    },
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'r1-llm.js'), 'utf8'),
    context,
    { filename: 'r1-llm.js' }
  );
  return { window, projects, posted, setActive(id) { activeId = id; } };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('late research writes to project A after switching to B', async () => {
  const runtime = createResearchRuntime();
  const pending = runtime.window.StructaLLM.research('quiet interfaces', { projectId: 'A' });

  await waitUntil(() => runtime.posted.length === 1);
  runtime.setActive('B');
  runtime.window.onPluginMessage({
    correlationId: runtime.posted[0].correlationId,
    response: 'quiet professional interface patterns'
  });
  await waitUntil(() => runtime.posted.length === 2);
  runtime.window.onPluginMessage({
    correlationId: runtime.posted[1].correlationId,
    response: 'source result one; source result two'
  });
  await waitUntil(() => runtime.posted.length === 3);
  runtime.window.onPluginMessage({
    correlationId: runtime.posted[2].correlationId,
    response: '1. one useful finding\n2. another useful finding\n3. a final useful finding'
  });

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.projectId, 'A');
  assert.equal(runtime.projects.A.nodes.length, 1);
  assert.equal(runtime.projects.A.nodes[0].source, 'serp');
  assert.equal(runtime.projects.B.nodes.length, 0);
});
