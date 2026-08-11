import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = { console, Promise, window: {} };
context.window.window = context.window;
vm.createContext(context);
for (const file of ['js/domain-packs.js', 'js/orchestrator.js']) {
  vm.runInContext(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, { filename: file });
}

const orchestrator = context.window.StructaOrchestrator;
let preparedPrompt = '';
const result = await orchestrator.buildProjectBrief({
  transcript: 'I want to build STRUCTA, an AI-native project map for vibe coders.',
  project: { project_id: 'p1', name: 'STRUCTA', type: 'software', user_role: 'Creative Director' },
  policy: { priority: 'high', allowSearch: false, allowSpeech: false }
}, async (prepared) => {
  preparedPrompt = prepared.llm.prompt;
  return {
    ok: true,
    clean: [
      'TITLE: STRUCTA Studio',
      'BRIEF: STRUCTA turns project conversations into an agent-ready map.',
      'OUTCOME: A clear project map exists within fifteen minutes.',
      'AUDIENCE: Vibe coders and creative professionals',
      'SUCCESS: Another agent can continue without a second explanation.',
      'DIRECTION: A four-surface project instrument',
      'VALIDATION: Test nine stuck projects',
      'DELIVERY: Ship a dogfoodable R1 build',
      'CONSTRAINT1: No external STRUCTA backend',
      'NON_GOAL1: Generic chat assistant',
      'DECISION1: Which implementation slice should lead? || Project map || Silent vision || Export compiler || Research loop',
      'ASK1: Which workflow should lead?',
      'THEME1: Governed advancement',
      'NEXT: Test the first-session map'
    ].join('\n')
  };
});

assert.equal(result.ok, true);
assert.equal(result.title, 'STRUCTA Studio');
assert.equal(result.constitution.outcome, 'A clear project map exists within fifteen minutes.');
assert.equal(result.constitution.constraints[0], 'No external STRUCTA backend');
assert.ok(result.packHints.includes('build'));
assert.equal(result.branches.length, 6);
assert.equal(result.candidates.decisions[0].text, 'Which implementation slice should lead?');
assert.deepEqual(Array.from(result.candidates.decisions[0].options), ['Project map', 'Silent vision', 'Export compiler', 'Research loop']);
assert.equal(result.candidates.decisions[0].requires_user_approval, true);
assert.ok(preparedPrompt.includes('OUTCOME:'));
assert.ok(preparedPrompt.includes('NON_GOAL1:'));
assert.ok(preparedPrompt.includes('<option D>'));

const fallback = await orchestrator.buildProjectBrief({
  transcript: 'Create a communication campaign for a museum opening.',
  project: { project_id: 'p2', name: 'Museum launch', type: 'general' }
});
assert.equal(fallback.ok, true);
assert.ok(fallback.packHints.includes('campaign'));
assert.equal(fallback.meta.deterministicFallback, true);

const source = fs.readFileSync(new URL('../js/orchestrator.js', import.meta.url), 'utf8');
assert.equal(/\bfetch\s*\(/.test(source), false);
assert.equal(/['"]\/v1\//.test(source), false);

console.log('v3 orchestrator smoke · 16 assertions passed');
