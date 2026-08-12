const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'js/voice-capture.js'), 'utf8');

function boot() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <main id="app"></main>
    <section id="voice-overlay" aria-hidden="true">
      <div id="voice-transcript"></div>
      <div id="voice-status"></div>
      <div id="voice-wave"></div>
      <div id="voice-context-label"></div>
    </section>
  </body></html>`, {
    url: 'https://structa.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const bridgeMessages = [];
  const resolveCalls = [];
  const mapGapCalls = [];
  const genericVoiceEntries = [];
  const queuedJobs = [];
  const project = {
    project_id: 'prj_voice_test',
    name: 'Voice test',
    brief: 'A project with an existing brief',
    nodes: [],
    open_questions: []
  };

  window.StructaNative = {
    getActiveProjectId: () => project.project_id,
    getProjectMemory: () => project,
    traceEvent() {},
    appendLogEntry() {},
    startPTT() {},
    stopPTT() {},
    resolveQuestion(question, answer) {
      resolveCalls.push({ question, answer });
      return { answerNode: { id: `answer-${resolveCalls.length}` } };
    },
    addVoiceEntry(entry) {
      genericVoiceEntries.push(entry);
      return { node_id: `voice-${genericVoiceEntries.length}` };
    },
    beginOperation: () => 'op_voice_test',
    recordOperationWrite() {}
  };
  window.StructaProcessingQueue = {
    registerHandler() {},
    enqueue(job) { queuedJobs.push(job); }
  };
  window.StructaAudio = {
    mute() {},
    unmute() {},
    init() {}
  };
  window.StructaFeedback = { fire() {} };
  window.StructaProjectEngine = {
    answerMapGap(branchId, answer, options) {
      mapGapCalls.push({ branchId, answer, options });
      return {
        ok: true,
        answerNode: { node_id: `map-gap-answer-${mapGapCalls.length}` },
        voiceEntry: { node_id: `map-gap-voice-${mapGapCalls.length}` }
      };
    }
  };
  window.CreationVoiceHandler = {
    postMessage(message) { bridgeMessages.push(message); }
  };

  window.eval(source);
  return {
    dom,
    window,
    bridgeMessages,
    resolveCalls,
    mapGapCalls,
    genericVoiceEntries,
    queuedJobs
  };
}

test('delayed native STT end resolves the question captured before PTT release exactly once', async () => {
  const runtime = boot();
  const { window } = runtime;
  const question = {
    index: 3,
    nodeId: 'question-people',
    text: 'Who must this work for?',
    source: 'now',
    projectId: 'prj_voice_test'
  };
  const answer = 'Independent designers who need a clear project map.';

  window.StructaVoice.setQuestionContext(question);
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(true);

  assert.deepEqual(runtime.bridgeMessages, ['start', 'stop']);
  assert.equal(runtime.resolveCalls.length, 0, 'an empty release waits for native STT');
  assert.equal(runtime.genericVoiceEntries.length, 0);

  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: answer }
  }));
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: answer }
  }));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.resolveCalls)), [{
    question: {
      index: question.index,
      nodeId: question.nodeId,
      text: question.text,
      source: question.source
    },
    answer
  }]);
  assert.equal(runtime.genericVoiceEntries.length, 0, 'the delayed answer is not routed as a generic note');
  assert.equal(runtime.queuedJobs.length, 1);
  assert.equal(runtime.queuedJobs[0].payload.mode, 'question');
  assert.equal(runtime.queuedJobs[0].payload.questionText, question.text);
  runtime.dom.window.close();
});

test('native STT end does not duplicate a transcript already processed on PTT release', async () => {
  const runtime = boot();
  const { window } = runtime;
  const question = {
    index: 1,
    nodeId: 'question-audience',
    text: 'Who is the first audience?',
    source: 'now',
    projectId: 'prj_voice_test'
  };
  const answer = 'Independent designers.';

  window.StructaVoice.setQuestionContext(question);
  await window.StructaVoice.startListening();
  window.document.getElementById('voice-transcript').textContent = answer;
  window.StructaVoice.stopListening(true);

  assert.equal(runtime.resolveCalls.length, 1);
  assert.equal(runtime.queuedJobs.length, 1);

  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: answer }
  }));

  assert.equal(runtime.resolveCalls.length, 1, 'the native callback is consumed without reprocessing');
  assert.equal(runtime.queuedJobs.length, 1);
  assert.equal(runtime.genericVoiceEntries.length, 0);
  runtime.dom.window.close();
});

test('delayed native STT end answers the original NOW map gap instead of storing a generic note', async () => {
  const runtime = boot();
  const { window } = runtime;
  const answer = 'Independent vibe coders and designers.';

  window.StructaVoice.setQuestionContext({
    index: -1,
    text: 'Who must this work for?',
    source: 'now',
    projectId: 'prj_voice_test',
    mapGap: true,
    branchId: 'audience'
  });
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(true);
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: answer }
  }));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.mapGapCalls)), [{
    branchId: 'audience',
    answer,
    options: {
      projectId: 'prj_voice_test',
      questionText: 'Who must this work for?'
    }
  }]);
  assert.equal(runtime.resolveCalls.length, 0, 'a map gap does not use stored-question resolution');
  assert.equal(runtime.genericVoiceEntries.length, 0);
  assert.equal(runtime.queuedJobs.length, 1);
  assert.equal(runtime.queuedJobs[0].payload.mode, 'question');
  assert.equal(runtime.queuedJobs[0].payload.answerNodeId, 'map-gap-answer-1');
  runtime.dom.window.close();
});

test('cancelling native STT stops the bridge and discards its late callback', async () => {
  const runtime = boot();
  const { window } = runtime;

  window.StructaVoice.setQuestionContext({
    index: 2,
    nodeId: 'question-cancelled',
    text: 'Which answer should be discarded?',
    source: 'now',
    projectId: 'prj_voice_test'
  });
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(false);

  assert.deepEqual(runtime.bridgeMessages, ['start', 'stop']);
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: 'This cancelled answer must not be stored.' }
  }));

  assert.equal(runtime.resolveCalls.length, 0);
  assert.equal(runtime.queuedJobs.length, 0);
  assert.equal(runtime.genericVoiceEntries.length, 0);
  runtime.dom.window.close();
});

test('empty native terminal clears the capture before the next question', async () => {
  const runtime = boot();
  const { window } = runtime;

  window.StructaVoice.setQuestionContext({
    index: 0,
    nodeId: 'question-empty',
    text: 'This first question receives no answer.',
    projectId: 'prj_voice_test'
  });
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(true);
  window.dispatchEvent(new window.Event('pagehide'));

  window.StructaVoice.setQuestionContext({
    index: 1,
    nodeId: 'question-next',
    text: 'Who should test this next?',
    projectId: 'prj_voice_test'
  });
  await window.StructaVoice.startListening();
  assert.deepEqual(runtime.bridgeMessages, ['start', 'stop'],
    'a new capture cannot overwrite an unresolved native callback context');

  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: '' }
  }));

  window.StructaVoice.setQuestionContext({
    index: 1,
    nodeId: 'question-next',
    text: 'Who should test this next?',
    projectId: 'prj_voice_test'
  });
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(true);
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: 'Ten independent designers.' }
  }));

  assert.deepEqual(runtime.bridgeMessages, ['start', 'stop', 'start', 'stop']);
  assert.equal(runtime.resolveCalls.length, 1);
  assert.equal(runtime.resolveCalls[0].question.nodeId, 'question-next');
  assert.equal(runtime.resolveCalls[0].answer, 'Ten independent designers.');
  assert.equal(runtime.genericVoiceEntries.length, 0);
  runtime.dom.window.close();
});

test('a rejected map-gap write is not reported or queued as a resolved answer', async () => {
  const runtime = boot();
  const { window } = runtime;
  window.StructaProjectEngine.answerMapGap = () => ({ ok: false, code: 'branch-not-found' });

  window.StructaVoice.setQuestionContext({
    index: -1,
    text: 'Who must this work for?',
    projectId: 'prj_voice_test',
    mapGap: true,
    branchId: 'unknown-branch'
  });
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(true);
  window.dispatchEvent(new window.CustomEvent('structa-stt-ended', {
    detail: { transcript: 'This answer must not be silently accepted.' }
  }));

  assert.equal(runtime.queuedJobs.length, 0);
  assert.equal(runtime.resolveCalls.length, 0);
  assert.equal(runtime.genericVoiceEntries.length, 0);
  runtime.dom.window.close();
});

test('a dropped native terminal blocks unsafe in-page retry across lifecycle events', async () => {
  const runtime = boot();
  const { window } = runtime;

  window.StructaVoice.setQuestionContext({
    index: 0,
    nodeId: 'question-dropped',
    text: 'This callback will be dropped.',
    projectId: 'prj_voice_test'
  });
  await window.StructaVoice.startListening();
  window.StructaVoice.stopListening(true);

  window.StructaVoice.setQuestionContext({
    index: 1,
    nodeId: 'question-retry',
    text: 'Who should receive the retry?',
    projectId: 'prj_voice_test'
  });
  await window.StructaVoice.startListening();
  assert.deepEqual(runtime.bridgeMessages, ['start', 'stop'],
    'without native correlation, an unresolved capture may not be replaced in-page');
  assert.equal(runtime.resolveCalls.length, 0);
  assert.equal(runtime.genericVoiceEntries.length, 0);
  runtime.dom.window.close();
});
