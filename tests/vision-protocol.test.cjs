const test = require('node:test');
const assert = require('node:assert/strict');
const vision = require('../js/vision-protocol.js');

function envelope(visionId, patch = {}) {
  return {
    schema: vision.SCHEMA,
    vision_id: visionId,
    status: 'observed',
    capture_kind: 'sketch_diagram',
    project_role: 'working_artifact',
    project_role_confidence: 0.86,
    ocr: [{ text: 'ENTRY', confidence: 0.96 }],
    observations: [
      { id: 'obs_1', text: 'Three boxes are connected by arrows.', confidence: 0.94 }
    ],
    interpretations: [
      {
        id: 'int_1',
        text: 'The drawing may represent a three-step flow.',
        observation_ids: ['obs_1'],
        confidence: 0.71
      }
    ],
    implications: [
      {
        id: 'imp_1',
        kind: 'decision_candidate',
        text: 'Confirm whether the middle box is a review gate.',
        interpretation_ids: ['int_1'],
        confidence: 0.67,
        requires_user_approval: true
      }
    ],
    uncertainties: [
      {
        id: 'unc_1',
        question: 'Is the middle label review or revise?',
        impact: 'medium',
        related_ids: ['obs_1', 'int_1']
      }
    ],
    ...patch
  };
}

test('buildRabbitPayload emits the exact silent Rabbit vision payload', () => {
  assert.deepEqual(vision.buildRabbitPayload('inspect', 'YWJj'), {
    message: 'inspect',
    payload: { imageBase64: 'YWJj' },
    useLLM: true,
    wantsR1Response: false,
    wantsJournalEntry: false
  });
});

test('raw and data URL input modes preserve the same base64 bytes', () => {
  const raw = 'YWJjZA==';
  const dataUrl = `data:image/png;base64,${raw}`;
  assert.equal(vision.formatImageInput(dataUrl, 'raw-base64'), raw);
  assert.equal(vision.formatImageInput(raw, 'data-url'), dataUrl.replace('image/png', 'image/jpeg'));
  assert.equal(vision.formatImageInput(dataUrl, 'data-url'), dataUrl);
});

test('vision prompt carries the governed project map and domain image lenses', () => {
  const prompt = vision.buildVisionPrompt({
    visionId: 'vis_context_1',
    project: {
      id: 'project-1',
      name: 'STRUCTA',
      brief: 'A decision-ready project instrument.',
      outcome: 'A clear project map in fifteen minutes.',
      constitution: { audience: 'creative professionals', success: 'handoff continues without re-interview' },
      pack_ids: ['creative-core', 'build'],
      branches: [{ id: 'direction', state: 'open', next: 'choose the core interaction' }],
      imageLenses: { working_artifact: ['screen hierarchy'], existing_condition: [], external_reference: ['adapt or avoid'] }
    }
  });
  assert.match(prompt, /A clear project map in fifteen minutes\./);
  assert.match(prompt, /screen hierarchy/);
  assert.match(prompt, /choose the core interaction/);
});

test('validates separated evidence layers, OCR, references, and approval gate', () => {
  const result = vision.validateVisionEnvelope(envelope('vis_exact_1'), 'vis_exact_1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.ocr, [{ text: 'ENTRY', confidence: 0.96 }]);
  assert.equal(result.value.observations.length, 1);
  assert.equal(result.value.project_role, 'working_artifact');
  assert.equal(result.value.project_role_confidence, 0.86);
  assert.equal(result.value.interpretations[0].observation_ids[0], 'obs_1');
  assert.equal(result.value.implications[0].requires_user_approval, true);
  assert.equal(result.value.uncertainties[0].impact, 'medium');
});

test('keeps visual class independent from project role and gates unknown intent', () => {
  const reference = vision.validateVisionEnvelope(envelope('vis_role_1', {
    capture_kind: 'space',
    project_role: 'external_reference',
    project_role_confidence: 0.9
  }), 'vis_role_1');
  assert.equal(reference.ok, true);
  assert.equal(reference.value.capture_kind, 'space');
  assert.equal(reference.value.project_role, 'external_reference');

  const conflated = envelope('vis_role_conflated', {
    capture_kind: 'external_reference',
    project_role: 'external_reference',
    project_role_confidence: 0.9
  });
  assert.equal(vision.validateVisionEnvelope(conflated, 'vis_role_conflated').code, 'vision-kind-invalid');

  const overconfident = envelope('vis_role_2', {
    project_role: 'unknown',
    project_role_confidence: 0.8
  });
  assert.equal(vision.validateVisionEnvelope(overconfident, 'vis_role_2').code, 'vision-project-role-invalid');

  const unknown = envelope('vis_role_3', {
    project_role: 'unknown',
    project_role_confidence: 0.35
  });
  assert.equal(vision.validateVisionEnvelope(unknown, 'vis_role_3').ok, true);
});

test('rejects a decision candidate that bypasses human approval', () => {
  const value = envelope('vis_gate_1');
  value.implications[0].requires_user_approval = false;
  assert.equal(vision.validateVisionEnvelope(value, 'vis_gate_1').code, 'vision-implications-invalid');
});

test('requires the exact outstanding vision_id without normalization aliases', () => {
  assert.equal(vision.validateVisionEnvelope(envelope('VIS_EXACT_1'), 'vis_exact_1').code, 'vision-id-mismatch');
  assert.equal(vision.validateVisionEnvelope(envelope('vis exact 1'), 'vis_exact_1').code, 'vision-id-mismatch');
  assert.equal(vision.validateVisionEnvelope(envelope('vis_exact_1 '), 'vis_exact_1').ok, true);
  assert.equal(vision.validateVisionEnvelope(envelope('vis_other_1'), 'vis_exact_1').code, 'vision-id-mismatch');
});

test('rejects missing or oversized OCR arrays', () => {
  const missing = envelope('vis_ocr_1');
  delete missing.ocr;
  assert.equal(vision.validateVisionEnvelope(missing, 'vis_ocr_1').code, 'vision-ocr-invalid');
  const oversized = envelope('vis_ocr_2', {
    ocr: Array.from({ length: 13 }, (_, index) => ({ text: `label ${index}`, confidence: 0.8 }))
  });
  assert.equal(vision.validateVisionEnvelope(oversized, 'vis_ocr_2').code, 'vision-ocr-invalid');
  const exactText = envelope('vis_ocr_3', {
    ocr: [{ text: 'ENTRY →\nREVIEW?', confidence: 0.91 }]
  });
  assert.equal(
    vision.validateVisionEnvelope(exactText, 'vis_ocr_3').value.ocr[0].text,
    'ENTRY →\nREVIEW?'
  );
});

test('collector ignores status, filler, and wrong-id responses until exact match', () => {
  const collector = vision.createCollector('vis_target_1');
  assert.equal(collector.feed({ status: 'processing' }).done, false);
  assert.equal(collector.feed({ text: 'Taking a look.' }).done, false);
  assert.equal(collector.feed({ response: JSON.stringify(envelope('vis_wrong_1')) }).done, false);
  const matched = collector.feed({ data: { result: JSON.stringify(envelope('vis_target_1')) } });
  assert.equal(matched.done, true);
  assert.equal(matched.envelope.vision_id, 'vis_target_1');
  assert.deepEqual(collector.snapshot().statusHistory, ['processing']);
});

test('collector joins a schema envelope split across callback messages', () => {
  const serialized = JSON.stringify(envelope('vis_chunks_1'));
  const splitAt = Math.floor(serialized.length / 2);
  const collector = vision.createCollector('vis_chunks_1');
  assert.equal(collector.feed({ text: serialized.slice(0, splitAt) }).done, false);
  const matched = collector.feed({ text: serialized.slice(splitAt) });
  assert.equal(matched.done, true);
  assert.equal(matched.envelope.vision_id, 'vis_chunks_1');
});

test('collector can assemble target chunks after an unrelated complete response', () => {
  const serialized = JSON.stringify(envelope('vis_chunks_2'));
  const splitAt = Math.floor(serialized.length / 2);
  const collector = vision.createCollector('vis_chunks_2');
  assert.equal(collector.feed({ text: JSON.stringify(envelope('vis_stale_1')) }).done, false);
  assert.equal(collector.feed({ text: serialized.slice(0, splitAt) }).done, false);
  const matched = collector.feed({ text: serialized.slice(splitAt) });
  assert.equal(matched.done, true);
  assert.equal(matched.envelope.vision_id, 'vis_chunks_2');
});

test('uncertainties become durable batched review items', () => {
  const validated = vision.validateVisionEnvelope(envelope('vis_unc_1'), 'vis_unc_1');
  const items = vision.toUncertaintyItems(validated.value, {
    captureId: 'cap_1',
    nodeId: 'node_1',
    createdAt: '2026-08-11T00:00:00.000Z'
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'open');
  assert.equal(items[0].source.visionId, 'vis_unc_1');
  assert.equal(items[0].source.captureId, 'cap_1');
});
