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

  // === Unified Node Model ===
  const nodeTypes = Object.freeze([
    'insight', 'decision', 'question', 'task', 'capture', 'research', 'voice-entry'
  ]);

  const nodeStatuses = Object.freeze([
    'open', 'resolved', 'archived'
  ]);

  const claimKinds = Object.freeze([
    'fact', 'constraint', 'preference', 'intent', 'question'
  ]);

  const claimStatuses = Object.freeze([
    'active', 'superseded', 'disputed', 'stale'
  ]);

  function createNode(input = {}) {
    const now = new Date().toISOString();
    return {
      node_id: input.node_id || makeEntryId(input.type || 'node'),
      project_id: input.project_id || baseProjectCode,
      type: nodeTypes.includes(input.type) ? input.type : 'insight',
      status: nodeStatuses.includes(input.status) ? input.status : 'open',
      title: (input.title || '').toLowerCase(),
      body: (input.body || '').toLowerCase(),
      source: input.source || 'voice',
      links: Array.isArray(input.links) ? input.links : [],
      tags: Array.isArray(input.tags) ? input.tags : [],
      decision_options: Array.isArray(input.decision_options) ? input.decision_options.slice(0, 3) : [],
      selected_option: input.selected_option || null,
      question_answer: input.question_answer || null,
      capture_image: input.capture_image || null,
      voice_annotation: input.voice_annotation || null,
      research_findings: Array.isArray(input.research_findings) ? input.research_findings : [],
      confidence: input.confidence || 'med',
      next_action: (input.next_action || '').toLowerCase(),
      created_at: input.created_at || now,
      resolved_at: input.resolved_at || null,
      meta: input.meta || {}
    };
  }

  function createClaim(input = {}) {
    const now = new Date().toISOString();
    return {
      id: input.id || makeEntryId('claim'),
      projectId: input.projectId || baseProjectCode,
      branchId: input.branchId || 'main',
      text: String(input.text || '').trim().toLowerCase(),
      kind: claimKinds.includes(input.kind) ? input.kind : 'fact',
      source: input.source || 'voice',
      sourceRef: input.sourceRef && typeof input.sourceRef === 'object' ? input.sourceRef : {},
      evidence: Array.isArray(input.evidence) ? input.evidence.filter(Boolean) : [],
      confidence: typeof input.confidence === 'number' ? input.confidence : 0.68,
      sttConfidence: typeof input.sttConfidence === 'number' ? input.sttConfidence : null,
      status: claimStatuses.includes(input.status) ? input.status : 'active',
      supersededBy: input.supersededBy || null,
      createdAt: input.createdAt || now,
      expiresAt: input.expiresAt || null
    };
  }

  function createAnswerNode(input = {}) {
    const now = new Date().toISOString();
    return {
      id: input.id || makeEntryId('answer'),
      questionId: input.questionId || '',
      body: String(input.body || '').trim().toLowerCase(),
      claims: Array.isArray(input.claims) ? input.claims.filter(Boolean) : [],
      sttConfidence: typeof input.sttConfidence === 'number' ? input.sttConfidence : null,
      at: input.at || now
    };
  }

  // === Project Schema ===
  const projectTypes = Object.freeze([
    'architecture', 'software', 'design', 'film', 'music', 'writing', 'research', 'general'
  ]);

  function createProject(input = {}) {
    const now = new Date().toISOString();
    return {
      project_id: input.project_id || makeEntryId('project'),
      name: (input.name || 'untitled project').toLowerCase(),
      type: projectTypes.includes(input.type) ? input.type : 'general',
      user_role: (input.user_role || '').toLowerCase(),
      device_scope_key: input.device_scope_key || '',
      nodes: Array.isArray(input.nodes) ? input.nodes : [],
      claims: Array.isArray(input.claims) ? input.claims : [],
      answers: Array.isArray(input.answers) ? input.answers : [],
      claimIndex: input.claimIndex && typeof input.claimIndex === 'object' ? input.claimIndex : {
        byItem: {},
        byBranch: {},
        byStatus: {}
      },
      chainHistory: Array.isArray(input.chainHistory) ? input.chainHistory : [],
      impact_chain: Array.isArray(input.impact_chain) ? input.impact_chain : [],
      exports: Array.isArray(input.exports) ? input.exports : [],
      clarity_score: typeof input.clarity_score === 'number' ? input.clarity_score : 0,
      created_at: input.created_at || now,
      updated_at: now,
      meta: input.meta || {}
    };
  }

  // === Knowledge Transfer Schema ===
  function createTransfer(input = {}) {
    const now = new Date().toISOString();
    return {
      transfer_id: input.transfer_id || makeEntryId('transfer'),
      source_project_id: input.source_project_id || '',
      target_project_id: input.target_project_id || '',
      node_ids: Array.isArray(input.node_ids) ? input.node_ids : [],
      status: input.status || 'pending',
      created_at: input.created_at || now,
      meta: input.meta || {}
    };
  }

  // === Adaptive Vocabulary ===
  const vocabularyMap = Object.freeze({
    architecture: { capture: 'site photo', insight: 'design note', decision: 'design call', task: 'action item', question: 'open brief' },
    software:     { capture: 'screenshot', insight: 'finding', decision: 'tech decision', task: 'ticket', question: 'blocker' },
    design:       { capture: 'reference', insight: 'direction', decision: 'design lock', task: 'deliverable', question: 'review ask' },
    film:         { capture: 'frame ref', insight: 'note', decision: 'creative call', task: 'shot task', question: 'coverage gap' },
    music:        { capture: 'sample', insight: 'arrangement note', decision: 'mix call', task: 'track task', question: 'sound question' },
    writing:      { capture: 'reference', insight: 'theme note', decision: 'editorial call', task: 'draft task', question: 'research gap' },
    research:     { capture: 'data point', insight: 'finding', decision: 'methodology call', task: 'study task', question: 'hypothesis' },
    general:      { capture: 'capture', insight: 'insight', decision: 'decision', task: 'task', question: 'question' }
  });

  function getVocabulary(projectType) {
    return vocabularyMap[projectType] || vocabularyMap.general;
  }

  window.StructaContracts = Object.freeze({
    allowedVerbs,
    allowedTargets,
    baseProjectCode,
    nodeTypes,
    nodeStatuses,
    claimKinds,
    claimStatuses,
    projectTypes,
    vocabularyMap,
    makeEntryId,
    createEnvelope,
    createCaptureBundle,
    createJournalEntry,
    createNode,
    createClaim,
    createAnswerNode,
    createProject,
    createTransfer,
    getVocabulary
  });
})();
