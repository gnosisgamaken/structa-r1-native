const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createRuntime() {
  const posted = [];
  const storedNodes = [];
  const project = {
    project_id: 'prj_research',
    name: 'Material Lab',
    type: 'architecture',
    brief: 'Compare lower-carbon structural materials.',
    nodes: [],
    claims: [],
    captures: [],
    open_questions: [],
    pending_decisions: [],
    backlog: []
  };
  const native = {
    deviceId: 'research-test-device',
    probeMode: false,
    getActiveProjectId() { return project.project_id; },
    getProjectMemory() { return project; },
    getProjectMemoryById(projectId) { return projectId === project.project_id ? project : null; },
    addNodeToProject(projectId, input) {
      if (projectId !== project.project_id) return null;
      const node = Object.assign({ node_id: 'research-node-' + (storedNodes.length + 1) }, input);
      storedNodes.push(node);
      return node;
    },
    traceEvent() {},
    recordProductEvent() {},
    appendLogEntry() {},
    recordVoiceCall() {},
    getClaimsForItem() { return []; }
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
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'r1-llm.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'r1-llm.js' });
  return { window, posted, storedNodes };
}

async function waitUntil(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function respond(runtime, index, response) {
  await waitUntil(() => runtime.posted.length > index);
  const request = runtime.posted[index];
  runtime.window.onPluginMessage({ correlationId: request.correlationId, response });
}

test('research persists returned source records and withholds unsourced synthesis from evidence', async () => {
  const runtime = createRuntime();
  const pending = runtime.window.StructaLLM.research('mass timber fire guidance');

  await respond(runtime, 0, 'mass timber fire guidance 2025');
  await respond(runtime, 1, JSON.stringify({
    organic_results: [
      {
        position: 1,
        title: 'Mass timber fire design guide',
        link: 'https://example.org/guides/mass-timber-fire',
        snippet: 'A technical guide for fire-safe timber structures.',
        date: '2025-02-10'
      },
      {
        position: 2,
        title: 'Local adoption bulletin',
        link: 'https://standards.example.com/bulletins/timber',
        snippet: 'Jurisdictions adopt model guidance on different schedules.'
      }
    ]
  }));
  await respond(runtime, 2, [
    'FINDING1: Fire guidance includes encapsulation strategies',
    'SOURCE1: https://example.org/guides/mass-timber-fire',
    'FINDING2: Confirm local adoption before design freeze',
    'SOURCE2: NONE',
    'FINDING3: Adoption timing varies by jurisdiction',
    'SOURCE3: https://standards.example.com/bulletins/timber'
  ].join('\n'));

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].url, 'https://example.org/guides/mass-timber-fire');
  assert.equal(result.sources[0].title, 'Mass timber fire design guide');
  assert.equal(result.sources[0].published_at, '2025-02-10');
  assert.equal(result.sources[0].provider, 'rabbit-serp');
  assert.equal(result.findingRecords[0].epistemic_status, 'source-backed');
  assert.equal(result.findingRecords[0].source_url, result.sources[0].url);
  assert.equal(result.findingRecords[1].epistemic_status, 'hypothesis');
  assert.equal(result.findingRecords[1].truth_role, 'research_lead');
  assert.equal(result.findingRecords[1].evidence_status, 'withheld');
  assert.equal(result.findingRecords[1].source_url, '');

  const stored = runtime.storedNodes[0];
  assert.equal(stored.research_findings[1].evidence_status, 'withheld');
  assert.equal(stored.meta.research_sources.length, 2);
  assert.deepEqual(
    Array.from(stored.meta.provenance.source_urls),
    ['https://example.org/guides/mass-timber-fire', 'https://standards.example.com/bulletins/timber']
  );
});

test('research with no returned URL stores every synthesis as a hypothesis', async () => {
  const runtime = createRuntime();
  const pending = runtime.window.StructaLLM.research('experimental facade coating');

  await respond(runtime, 0, 'experimental facade coating durability');
  await respond(runtime, 1, 'Search summary returned without source records.');
  await respond(runtime, 2, [
    'FINDING1: Coating may reduce routine cleaning',
    'SOURCE1: NONE',
    'FINDING2: Weathering performance needs a mockup',
    'SOURCE2: https://invented.example/not-returned',
    'FINDING3: Maintenance assumptions need facilities review',
    'SOURCE3: NONE'
  ].join('\n'));

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, 0);
  assert.ok(result.findingRecords.every(record => record.epistemic_status === 'hypothesis'));
  assert.ok(result.findingRecords.every(record => record.evidence_status === 'withheld'));
  assert.ok(result.findingRecords.every(record => record.source_url === ''));
  assert.ok(result.findingRecords.every(record => !Object.hasOwn(record, 'evidence')));
  assert.equal(runtime.storedNodes[0].meta.provenance.source_count, 0);
});
