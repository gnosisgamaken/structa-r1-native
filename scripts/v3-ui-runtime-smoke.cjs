const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const repo = path.resolve(__dirname, '..');
const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('jsdomError', error => errors.push(error));
virtualConsole.on('error', error => errors.push(error));

const dom = new JSDOM(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole
});
const { window } = dom;

window.HTMLCanvasElement.prototype.getContext = function() {
  return {
    font: '',
    measureText(value) { return { width: String(value || '').length * 5.5 }; }
  };
};
window.requestAnimationFrame = callback => { callback(window.performance.now()); return 1; };
window.cancelAnimationFrame = () => {};
window.URL.createObjectURL = () => 'blob:smoke';
window.URL.revokeObjectURL = () => {};

const uiState = {
  onboarding_step: 'complete',
  onboarding_complete: true,
  selected_card_id: 'now',
  queue_blockers: []
};
const project = {
  project_id: 'p1',
  name: 'launch room',
  project_mark: 'lr',
  brief: 'build a clear campaign system for a shared urban space',
  type: 'general creative',
  pending_decisions: [{
    id: 'd1',
    text: 'which invitation should lead the campaign?',
    why: 'the lead changes the reference and channel plan',
    options: ['lead with participation', 'lead with the place'],
    branch_id: 'direction'
  }],
  decisions: [],
  open_question_nodes: [],
  nodes: [],
  claims: [],
  insights: [],
  backlog: [],
  captures: [{
    entry_id: 'cap1',
    node_id: 'cap-node-1',
    summary: 'a hand sketch linking the room, threshold, and shared table',
    preview_data: 'data:image/png;base64,iVBORw0KGgo=',
    created_at: new Date().toISOString()
  }],
  derived_candidates: { themes: [{ text: 'shared threshold' }], blockers: [] }
};
const memory = {
  projectMemory: project,
  captures: project.captures,
  journals: [
    { entry_id: 'voice-1', source_type: 'voice', project_id: 'p1', body: 'begin with the shared threshold as the invitation', created_at: '2026-08-11T09:00:00.000Z' },
    { entry_id: 'voice-2', source_type: 'voice', project_id: 'p1', body: 'the room should feel useful before it feels branded', created_at: '2026-08-11T09:05:00.000Z' },
    { entry_id: 'voice-3', source_type: 'voice', project_id: 'p1', body: 'test the table with neighbours before fixing the campaign', created_at: '2026-08-11T09:10:00.000Z' }
  ],
  uiState,
  logs: [],
  messages: []
};

window.StructaNative = {
  getMemory: () => memory,
  getProjectMemory: () => project,
  getActiveProjectId: () => project.project_id,
  getProjects: () => [project],
  getUIState: () => uiState,
  updateUIState: patch => Object.assign(uiState, patch || {}),
  setActiveNode() {},
  getRecentLogEntries: () => [],
  getClaimsForItem: () => [],
  appendLogEntry() {},
  traceEvent() {},
  touchProjectMemory(mutator) { mutator(project); return project; },
  approvePendingDecisionById(id, optionIndex, option) {
    const index = project.pending_decisions.findIndex(item => item.id === id);
    if (index < 0) return { ok: false, error: 'not found' };
    const [decision] = project.pending_decisions.splice(index, 1);
    project.decisions.push({ ...decision, selected_option_index: optionIndex, selected_option: option });
    return { ok: true, decision };
  }
};

let cameraOpened = 0;
window.StructaCamera = {
  openFromGesture() { cameraOpened += 1; },
  close() {},
  capture() {},
  flip() {},
  startVoiceStrip() {},
  get voiceStripActive() { return false; }
};

let voiceStarted = 0;
window.StructaVoice = {
  listening: false,
  open() {},
  close() {},
  startListening() { voiceStarted += 1; },
  stopListening() {},
  setQuestionContext() {},
  setBuildContext() {},
  setTriangleContext() {},
  setContextLabel() {}
};
window.StructaFeedback = { fire() {} };
window.StructaLLM = { speakMilestone() {} };

function evaluate(file) {
  window.eval(fs.readFileSync(path.join(repo, file), 'utf8'));
}

evaluate('js/domain-packs.js');
evaluate('js/project-engine.js');
evaluate('structa-cascade.js');

const panel = window.StructaPanel;
assert.ok(panel, 'public panel API exists');
const states = panel.STATES;
const scene = window.document.getElementById('scene');
const textContent = () => scene.textContent.replace(/\s+/g, ' ').trim().toLowerCase();

function assertHitTargets(kind, expectedCount) {
  const targets = Array.from(scene.querySelectorAll(`rect[data-hit-target="${kind}"]`));
  const frames = targets.map(target => ({
    key: target.getAttribute('data-hit-key') || '',
    x: Number(target.getAttribute('x')),
    y: Number(target.getAttribute('y')),
    width: Number(target.getAttribute('width')),
    height: Number(target.getAttribute('height'))
  }));
  assert.equal(targets.length, expectedCount, `${kind} renders the expected direct-touch targets`);
  assert.ok(frames.every(frame => (
    frame.width >= 44 && frame.height >= 44 &&
    frame.x >= 0 && frame.y >= 0 &&
    frame.x + frame.width <= 240 && frame.y + frame.height <= 282
  )), `${kind} targets are at least 44x44 and stay on the r1 surface`);
  const uniqueKeys = new Set(frames.map(frame => frame.key));
  const noOverlap = frames.every((frame, index) => frames.slice(index + 1).every(other => (
    frame.x + frame.width <= other.x || other.x + other.width <= frame.x ||
    frame.y + frame.height <= other.y || other.y + other.height <= frame.y
  )));
  assert.ok(uniqueKeys.size === frames.length && !frames.some(frame => !frame.key) && noOverlap,
    `${kind} targets have unique actions and do not overlap`);
}

panel.transition(states.SHOW_BROWSE);
assert.match(textContent(), /project reading|visual note/, 'SHOW renders the selected reference');
window.dispatchEvent(new window.CustomEvent('sideClick'));
assert.equal(cameraOpened, 1, 'SHOW side click opens the camera');

panel.transition(states.KNOW_BROWSE);
assert.match(textContent(), /branches/, 'KNOW renders the project map');
assert.match(textContent(), /outcome/, 'KNOW includes the outcome branch');

panel.transition(states.TELL_BROWSE);
assertHitTargets('tell-row', 2);

panel.transition(states.NOW_BROWSE);
assert.match(textContent(), /which invitation should lead/, 'NOW renders the highest-leverage decision');
assert.match(textContent(), /human approval required/, 'NOW exposes the human gate');
assertHitTargets('now-option', 2);
project.pending_decisions[0].options = ['lead with participation', 'lead with the place', 'lead with a useful ritual'];
panel.transition(states.HOME);
panel.transition(states.NOW_BROWSE);
assertHitTargets('now-option', 3);
project.pending_decisions[0].options = ['lead with participation', 'lead with the place', 'lead with a useful ritual', 'lead with the shared table'];
panel.transition(states.HOME);
panel.transition(states.NOW_BROWSE);
assertHitTargets('now-option', 4);
project.pending_decisions[0].options = ['lead with participation', 'lead with the place'];
panel.transition(states.HOME);
panel.transition(states.NOW_BROWSE);
window.dispatchEvent(new window.CustomEvent('sideClick'));
assert.equal(project.pending_decisions.length, 0, 'NOW side click approves by stable ID');
assert.equal(project.decisions.length, 1, 'approved decision is durable');

window.StructaProjectEngine.ensure(project);
project.structa_v3.references.push({
  id: 'ref1',
  capture_id: 'cap1',
  capture_class: 'sketch_diagram',
  project_role: 'working_artifact',
  observations: [{ text: 'threshold and shared table are linked' }]
});
project.structa_v3.uncertainties.push(
  { id: 'u1', capture_id: 'cap1', statement: 'confirm that the arrows describe circulation', why: 'this affects the spatial reading', status: 'queued', branch_id: 'direction' },
  { id: 'u2', capture_id: 'cap1', statement: 'confirm that the table is shared', why: 'this affects the use case', status: 'queued', branch_id: 'audience' },
  { id: 'u3', capture_id: 'cap1', statement: 'confirm that the threshold is public', why: 'this affects constraints', status: 'queued', branch_id: 'constraints' }
);
panel.transition(states.HOME);
panel.transition(states.NOW_BROWSE);
assert.match(textContent(), /review 3 observations/, 'NOW offers one batched uncertainty intervention');
panel.transition(states.UNCERTAINTY_REVIEW, { uncertaintyId: 'u1' });
assert.match(textContent(), /visual uncertainty review/, 'uncertainty review renders');
assert.ok(textContent().includes('confirm') && textContent().includes('correct') && textContent().includes('dismiss'), 'all review actions render');
assertHitTargets('uncertainty-action', 3);
window.dispatchEvent(new window.CustomEvent('scrollUp'));
window.dispatchEvent(new window.CustomEvent('sideClick'));
assert.equal(panel.getState(), states.VOICE_OPEN, 'correct opens focused voice capture');
assert.equal(voiceStarted, 1, 'correction capture starts listening');

panel.transition(states.UNCERTAINTY_REVIEW, { uncertaintyId: 'u1' });
const oversized = Array.from(scene.querySelectorAll('[y],[cy],[height]')).filter(element => {
  return ['y', 'cy', 'height'].some(name => Number(element.getAttribute(name)) > 282);
});
assert.equal(oversized.length, 0, 'rendered SVG stays within the 282px surface');
assert.equal(window.document.getElementById('log-drawer').style.display, 'none', 'production log drawer stays hidden');
assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));

console.log('v3 ui runtime smoke · 33 assertions passed');
