(() => {
  const allowedVerbs = Object.freeze([
    'build', 'patch', 'delete', 'solve', 'inspect', 'consolidate', 'decide', 'research', 'withdraw',
    'approve', 'rollback', 'capture', 'export', 'journal', 'email'
  ]);

  const allowedTargets = Object.freeze([
    'project', 'node', 'issue', 'decision', 'asset', 'capture', 'journal', 'export', 'camera', 'voice', 'context', 'drawer', 'insight', 'structure'
  ]);

  const baseProjectCode = 'prj-structa-r1';

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function makeEntryId(kind = 'event') {
    const now = new Date();
    return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('') + `-${kind}`;
  }

  function createEnvelope(input = {}) {
    const now = new Date().toISOString();
    return {
      project_code: input.project_code || baseProjectCode,
      entry_id: input.entry_id || makeEntryId(input.kind || 'event'),
      source_type: input.source_type || 'r1-native',
      input_type: input.input_type || input.kind || 'event',
      target: input.target || 'context',
      verb: input.verb || 'inspect',
      intent: input.intent || `${input.verb || 'inspect'} ${input.target || 'context'}`,
      goal: input.goal || '',
      constraints: Array.isArray(input.constraints) ? input.constraints : [],
      success_criteria: Array.isArray(input.success_criteria) ? input.success_criteria : [],
      approval_mode: input.approval_mode || 'human_required',
      fallback: input.fallback || 'log-only',
      created_at: input.created_at || now,
      updated_at: now,
      payload: input.payload || null,
      meta: input.meta || {}
    };
  }

  function createCaptureBundle(input = {}) {
    const now = new Date().toISOString();
    return {
      project_code: input.project_code || baseProjectCode,
      entry_id: input.entry_id || makeEntryId('capture'),
      source_type: input.source_type || 'camera',
      input_type: input.input_type || 'image',
      captured_at: input.captured_at || now,
      image_asset: input.image_asset || null,
      audio_asset: input.audio_asset || null,
      prompt_text: input.prompt_text || '',
      ai_response: input.ai_response || '',
      summary: input.summary || '',
      approval_state: input.approval_state || 'draft',
      tags: Array.isArray(input.tags) ? input.tags : [],
      links: Array.isArray(input.links) ? input.links : [],
      meta: input.meta || {}
    };
  }

  function createJournalEntry(input = {}) {
    const now = new Date().toISOString();
    return {
      project_code: input.project_code || baseProjectCode,
      entry_id: input.entry_id || makeEntryId('journal'),
      source_type: input.source_type || 'voice',
      title: (input.title || 'untitled entry').toLowerCase(),
      body: (input.body || '').toLowerCase(),
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      created_at: input.created_at || now,
      meta: input.meta || {}
    };
  }

  window.StructaContracts = Object.freeze({
    allowedVerbs,
    allowedTargets,
    baseProjectCode,
    makeEntryId,
    createEnvelope,
    createCaptureBundle,
    createJournalEntry
  });
})();
