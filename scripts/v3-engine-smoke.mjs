import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const project = {
  project_id: 'project-a',
  name: 'STRUCTA Studio',
  brief: 'Build a decision-ready creative project instrument.',
  type: 'software',
  user_role: 'Creative Director',
  nodes: [],
  claims: [],
  decisions: [],
  pending_decisions: [],
  open_question_nodes: [],
  derived_candidates: { decisions: [], asks: [], blockers: [], themes: [] },
  backlog: [],
  insights: []
};

const projectB = {
  project_id: 'project-b',
  name: 'Second project',
  brief: 'A separate project that must not receive late writes.',
  type: 'general',
  nodes: [],
  claims: [],
  decisions: [],
  pending_decisions: [],
  open_question_nodes: [],
  derived_candidates: { decisions: [], asks: [], blockers: [], themes: [] },
  backlog: [],
  insights: []
};
const projects = [project, projectB];
let activeProject = project;

const native = {
  getProjectMemory: () => activeProject,
  getProjectMemoryById(id) {
    return projects.find((item) => item.project_id === id) || null;
  },
  touchProjectMemory(mutator) {
    mutator(activeProject);
    return activeProject;
  },
  touchProjectMemoryById(id, mutator) {
    const target = projects.find((item) => item.project_id === id) || null;
    if (!target) return null;
    mutator(target);
    return target;
  },
  approvePendingDecisionById(id, optionIndex, option) {
    const index = activeProject.pending_decisions.findIndex((item) => (item.id || item.node_id) === id);
    if (index < 0) return null;
    const [decision] = activeProject.pending_decisions.splice(index, 1);
    activeProject.decisions.push({ ...decision, selected_option: option, selected_option_index: optionIndex });
    return activeProject;
  },
  dismissPendingDecisionById(id) {
    const index = activeProject.pending_decisions.findIndex((item) => (item.id || item.node_id) === id);
    if (index < 0) return null;
    activeProject.pending_decisions.splice(index, 1);
    return activeProject;
  },
  reopenDecisionById(id) {
    const index = activeProject.decisions.findIndex((item) => (item.id || item.node_id) === id);
    if (index < 0) return { ok: false, error: 'not found' };
    const [decision] = activeProject.decisions.splice(index, 1);
    activeProject.pending_decisions.unshift({ ...decision, selected_option: null, selected_option_index: null });
    return { ok: true, decision };
  }
};

const context = {
  console,
  Date,
  Blob,
  URL,
  setTimeout(fn) { fn(); return 1; },
  clearTimeout() {},
  document: { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild() {} } },
  window: { StructaNative: native }
};
context.window.window = context.window;
vm.createContext(context);

for (const file of ['js/domain-packs.js', 'js/project-engine.js']) {
  vm.runInContext(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, { filename: file });
}

const engine = context.window.StructaProjectEngine;
assert.equal(engine.schema, 'structa.project.v3');

engine.seedFromBrief({
  brief: 'Ship a professional AI-native project builder for vibe coders.',
  constitution: {
    outcome: 'A clear, agent-ready project map in fifteen minutes.',
    audience: 'Creative professionals and vibe coders.',
    success: 'A collaborator can continue without a second explanation.',
    constraints: ['No external STRUCTA backend']
  },
  packHints: ['build'],
  branches: [{ id: 'direction', summary: 'Use four governed project surfaces.', confidence: 0.8 }]
}, { source: 'smoke', voiceEntryId: 'voice-1' });

const map = engine.getMapView(project);
assert.equal(map.branches.length, 6);
assert.equal(map.outcome, 'A clear, agent-ready project map in fifteen minutes.');
assert.ok(map.pack_ids.includes('build'));
assert.equal(map.branches.find((branch) => branch.id === 'direction').state, 'open');
assert.equal(engine.applyOperation({
  type: 'decision.propose', actor: 'structa', project_id: 'project-b', text: 'stale', options: ['a', 'b']
}).stale, true);
assert.equal(engine.applyOperation({ type: 'decision.propose', actor: 'structa', text: 'False choice?', options: ['Only'] }).ok, false);
assert.equal(engine.applyOperation({ type: 'branch.close', actor: 'structa', branch_id: 'direction' }).code, 'closure-gate');
assert.equal(engine.applyOperation({ type: 'branch.update', actor: 'structa', branch_id: 'direction', summary: 'stale update', expected_revision: -1 }).code, 'revision-conflict');
const originalDirectionSummary = project.structa_v3.branches.find((branch) => branch.id === 'direction').summary;
assert.equal(engine.applyOperation({ type: 'branch.update', actor: 'structa', branch_id: 'direction', summary: 'A reversible structural refinement.' }).ok, true);
const structuralEventId = project.structa_v3.events.at(-1).id;
assert.equal(engine.applyOperation({ type: 'event.revert', actor: 'human', event_id: structuralEventId }).ok, true);
assert.equal(project.structa_v3.branches.find((branch) => branch.id === 'direction').summary, originalDirectionSummary);

const proposal = engine.applyOperation({
  type: 'decision.propose',
  actor: 'structa',
  id: 'decision-stable',
  text: 'Which project map should lead the first release?',
  options: ['Creative core', 'Software checklist'],
  branch_id: 'direction'
});
assert.equal(proposal.ok, true);
assert.equal(engine.applyOperation({ type: 'decision.approve', actor: 'structa', decision_id: 'decision-stable' }).ok, false);
assert.equal(engine.getNowView(project).id, 'decision-stable');
assert.equal(engine.approveDecision('decision-stable', 0, 'Creative core').ok, true);
assert.equal(engine.approveDecision('decision-stable', 0, 'Creative core').ok, false);
assert.equal(project.decisions.length, 1);
assert.equal(engine.applyOperation({ type: 'decision.reopen', actor: 'structa', decision_id: 'decision-stable' }).code, 'human-gate');
assert.equal(engine.applyOperation({ type: 'decision.reopen', actor: 'human', decision_id: 'decision-stable', reason: 'New evidence changed the trade-off.' }).ok, true);
assert.equal(project.pending_decisions.length, 1);
assert.equal(engine.approveDecision('decision-stable', 1, 'Software checklist').ok, true);
assert.equal(project.decisions.length, 1);

activeProject = projectB;
engine.seedFromBrief({
  brief: 'Turn a second creative brief into a governed map.',
  constitution: { outcome: 'A second project remains isolated.' },
  candidates: {
    decisions: [{
      id: 'decision-four-options',
      text: 'Which proof should lead?',
      why: 'The choice determines the first validation loop.',
      options: ['Prototype', 'Interview', 'Field test', 'Campaign test'],
      branch_id: 'validation',
      requires_user_approval: true
    }]
  }
}, { source: 'project-brief', projectId: 'project-b' });
assert.equal(projectB.pending_decisions.length, 1);
assert.equal(engine.getNowView(projectB).id, 'decision-four-options');
assert.equal(engine.getNowView(projectB).options.length, 4);
assert.equal(engine.approveDecision('decision-four-options', 3, 'Campaign test').ok, true);
assert.equal(projectB.decisions[0].selected_option, 'Campaign test');
assert.equal(engine.reopenDecision('decision-four-options', 'Compare all proofs again.').ok, true);
assert.equal(engine.getNowView(projectB).options.length, 4);

const lateDecision = engine.ingestDecisionCandidates([{
  id: 'decision-late-a',
  text: 'Which device experiment should run next?',
  options: ['Vision relay', 'Voice loop']
}], { projectId: 'project-a', source: 'late-voice', voiceEntryId: 'voice-late-a' });
assert.equal(lateDecision.ok, true);
assert.ok(project.pending_decisions.some((item) => item.id === 'decision-late-a'));
assert.equal(projectB.pending_decisions.some((item) => item.id === 'decision-late-a'), false);
activeProject = project;

engine.ingestVisualEnvelope('capture-reference', {
  schema: 'structa.vision.v1',
  vision_id: 'vision-reference',
  status: 'observed',
  capture_kind: 'space',
  project_role: 'external_reference',
  project_role_confidence: 0.94,
  observations: [{ text: 'A calm four-plane interface is visible.', confidence: 0.91 }],
  interpretations: [{ id: 'int-1', text: 'The planes may encode navigation hierarchy.', confidence: 0.72, observation_ids: ['obs-1'] }],
  implications: [{ kind: 'reference_attribute', text: 'Consider compressed navigation rails.', confidence: 0.68 }],
  uncertainties: []
});
let direction = project.structa_v3.branches.find((branch) => branch.id === 'direction');
assert.ok(direction.reference_ids.includes('vision-reference'));
assert.ok(!direction.evidence_ids.includes('vision-reference'));
assert.equal(project.structa_v3.references.find((item) => item.id === 'vision-reference').truth_role, 'attribute_source');

engine.ingestVisualEnvelope('capture-space', {
  schema: 'structa.vision.v1',
  vision_id: 'vision-space',
  status: 'observed',
  capture_kind: 'space',
  project_role: 'existing_condition',
  project_role_confidence: 0.9,
  observations: [{ text: 'The doorway is visibly narrower than the adjacent opening.', confidence: 0.83 }],
  relevance: [{ branch_id: 'constraints', text: 'Verify circulation dimensions.' }],
  uncertainties: ['Exact width cannot be established from the image.']
});
const constraints = project.structa_v3.branches.find((branch) => branch.id === 'constraints');
assert.ok(constraints.evidence_ids.includes('vision-space'));
assert.equal(project.structa_v3.references.find((item) => item.id === 'vision-space').evidence_status, 'eligible');

engine.ingestVisualEnvelope('capture-unknown-role', {
  schema: 'structa.vision.v1',
  vision_id: 'vision-unknown-role',
  status: 'observed',
  capture_kind: 'material_object',
  project_role: 'unknown',
  project_role_confidence: 0.35,
  observations: [{ text: 'A pale, textured panel is visible.', confidence: 0.82 }],
  interpretations: [],
  implications: [],
  uncertainties: [{ question: 'Is this from the project or a reference?', impact: 'medium' }]
});
const unknownReference = project.structa_v3.references.find((item) => item.id === 'vision-unknown-role');
assert.equal(unknownReference.truth_role, 'unclassified');
assert.equal(unknownReference.evidence_status, 'withheld');
const roleUncertainty = project.structa_v3.uncertainties.find((item) => item.reference_id === 'vision-unknown-role');
assert.equal(roleUncertainty.kind, 'project_role');
assert.equal(engine.reviewUncertainty(roleUncertainty.id, 'correct', 'this is an existing site condition').ok, true);
assert.equal(unknownReference.truth_role, 'project_evidence');
assert.equal(unknownReference.evidence_status, 'eligible');

activeProject = projectB;
const lateVisual = engine.ingestVisualEnvelope('capture-late', {
  schema: 'structa.vision.v1',
  vision_id: 'vision-late-a',
  status: 'observed',
  capture_kind: 'space',
  project_role: 'external_reference',
  project_role_confidence: 0.91,
  observations: [{ text: 'A late reference callback is visible.', confidence: 0.9 }],
  interpretations: [],
  implications: [],
  uncertainties: []
}, { projectId: 'project-a' });
assert.equal(lateVisual.id, 'vision-late-a');
assert.ok(project.structa_v3.references.some((item) => item.id === 'vision-late-a'));
assert.equal(projectB.structa_v3?.references?.some((item) => item.id === 'vision-late-a') || false, false);
activeProject = project;

engine.applyOperation({ type: 'uncertainty.queue', actor: 'structa', text: 'Confirm diagram orientation.', capture_id: 'c2' });
engine.applyOperation({ type: 'uncertainty.queue', actor: 'structa', text: 'Confirm material finish.', capture_id: 'c3' });
assert.equal(engine.getNowView(project).type, 'uncertainty_review');

const queued = project.structa_v3.uncertainties.find((item) => item.status === 'queued');
assert.equal(engine.reviewUncertainty(queued.id, 'confirm').ok, true);
assert.equal(project.structa_v3.uncertainties.find((item) => item.id === queued.id).reviewed_by, 'human');

const exported = engine.createExport('markdown');
assert.ok(exported.content.includes('STRUCTA Studio'));
assert.ok(exported.content.includes('Creative Director'));
assert.ok(exported.content.includes('Human-approved decisions'));

console.log('v3 engine smoke · 54 assertions passed');
