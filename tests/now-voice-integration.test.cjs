const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');

const repo = path.resolve(__dirname, '..');

function evaluate(window, file) {
  window.eval(fs.readFileSync(path.join(repo, file), 'utf8'));
}

test('physical-shaped NOW audience answer advances the real durable project map', async () => {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', error => errors.push(error));
  virtualConsole.on('error', error => errors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), {
    url: 'https://structa.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  const bridgeMessages = [];
  const queuedJobs = [];

  window.console = console;
  window.HTMLCanvasElement.prototype.getContext = function() {
    return { font: '', measureText(value) { return { width: String(value || '').length * 5.5 }; } };
  };
  window.requestAnimationFrame = callback => { callback(window.performance.now()); return 1; };
  window.cancelAnimationFrame = () => {};
  window.URL.createObjectURL = () => 'blob:integration';
  window.URL.revokeObjectURL = () => {};
  window.CreationVoiceHandler = {
    postMessage(message) { bridgeMessages.push(message); }
  };
  window.StructaActionRouter = {
    getContext() { return null; },
    updateContext() {},
    setActiveVerb() {},
    setActiveNode() {},
    routeAction() { return { ok: false }; }
  };
  window.StructaProcessingQueue = {
    registerHandler() {},
    enqueue(job) { queuedJobs.push(job); }
  };
  window.StructaAudio = { mute() {}, unmute() {}, init() {} };
  window.StructaFeedback = { fire() {} };
  window.StructaLLM = { speakMilestone() {} };
  window.StructaCamera = {
    openFromGesture() {}, close() {}, capture() {}, flip() {}, startVoiceStrip() {},
    get voiceStripActive() { return false; }
  };

  for (const file of [
    'js/contracts.js',
    'js/validation.js',
    'js/rabbit-adapter.js',
    'js/domain-packs.js',
    'js/project-engine.js'
  ]) evaluate(window, file);

  const native = window.StructaNative;
  native.touchProjectMemory(project => {
    project.name = 'Early Tester Campaign';
    project.brief = 'Plan an early tester campaign for STRUCTA.';
    project.type = 'general creative';
    project.user_role = '';
    project.nodes = [];
    project.answers = [];
    project.claims = [];
    project.decisions = [];
    project.pending_decisions = [];
    project.open_question_nodes = [];
    project.open_questions = [];
    project.insights = [];
    project.backlog = [];
    project.derived_candidates = { decisions: [], asks: [], blockers: [], themes: [] };
    delete project.structa_v3;
  });
  native.updateUIState({
    onboarding_step: 'complete',
    onboarding_complete: true,
    selected_card_id: 'now',
    queue_blockers: []
  });
  native.touchProjectMemory(project => window.StructaProjectEngine.ensure(project));

  evaluate(window, 'js/voice-capture.js');
  evaluate(window, 'structa-cascade.js');

  const panel = window.StructaPanel;
  const scene = window.document.getElementById('scene');
  const textContent = () => scene.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
  panel.transition(panel.STATES.NOW_BROWSE);
  assert.match(textContent(), /people · 0%/);
  assert.match(textContent(), /who must this work for/);

  window.dispatchEvent(new window.CustomEvent('longPressStart'));
  window.dispatchEvent(new window.CustomEvent('pttStart'));
  assert.equal(panel.getState(), panel.STATES.VOICE_OPEN);
  assert.equal(window.StructaVoice.listening, true);
  assert.deepEqual(bridgeMessages, ['start']);

  window.dispatchEvent(new window.CustomEvent('longPressEnd'));
  window.dispatchEvent(new window.CustomEvent('pttEnd'));
  assert.deepEqual(bridgeMessages, ['start', 'stop']);

  const answer = 'Creative professionals who use AI to build real projects.';
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: answer }
  }));

  const stored = native.getProjectMemory();
  const audience = stored.structa_v3.branches.find(branch => branch.id === 'audience');
  const answerEntries = stored.nodes.filter(node => node.meta?.entry_mode === 'map-gap-answer');
  assert.equal(stored.structa_v3.constitution.audience, answer);
  assert.ok(audience.completeness > 0);
  assert.equal(answerEntries.length, 1);
  assert.equal(answerEntries[0].body, answer);
  assert.equal(answerEntries[0].meta.branch_id, 'audience');
  assert.equal(stored.answers.length, 1);
  assert.equal(stored.answers[0].body, answer);
  assert.equal(stored.nodes.filter(node => node.source === 'voice' && node.meta?.entry_mode === 'auto').length, 0);
  assert.notEqual(window.StructaProjectEngine.getNowView(stored).branch_id, 'audience');
  assert.equal(queuedJobs.length, 1, 'background extraction follows the synchronous durable answer');
  assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));

  dom.window.close();
});
