(() => {
  const contracts = window.StructaContracts;
  const coreVerbs = Object.freeze(['build', 'patch', 'delete', 'solve', 'consolidate', 'decide', 'research', 'withdraw']);
  const extendedVerbs = Object.freeze(['inspect', 'capture', 'approve', 'rollback', 'export', 'journal', 'email']);
  const allVerbs = Object.freeze([...(contracts?.allowedVerbs || []), ...coreVerbs, ...extendedVerbs]);
  const mutatingVerbs = new Set(['build', 'patch', 'delete', 'withdraw', 'export']);
  const advisoryVerbs = new Set(['solve', 'research', 'decide', 'consolidate']);

  const verbSynonyms = [
    ['build', ['build', 'create', 'make', 'draft']],
    ['patch', ['patch', 'fix', 'edit', 'update', 'change']],
    ['delete', ['delete', 'remove', 'clear']],
    ['solve', ['solve', 'debug', 'resolve']],
    ['consolidate', ['consolidate', 'summarize', 'merge']],
    ['decide', ['decide', 'choose', 'pick']],
    ['research', ['research', 'inspect', 'explore', 'look up']],
    ['withdraw', ['withdraw', 'share', 'send out']],
    ['inspect', ['inspect', 'review', 'check', 'open']],
    ['capture', ['capture', 'record', 'photo', 'voice']],
    ['journal', ['journal', 'log', 'note']],
    ['approve', ['approve', 'confirm']],
    ['rollback', ['rollback', 'undo', 'revert']],
    ['email', ['email', 'mail']],
    ['export', ['export', 'save out', 'download']]
  ];

  const targetHints = [
    ['camera', ['camera', 'photo', 'image', 'selfie', 'show']],
    ['voice', ['voice', 'mic', 'microphone', 'speech', 'tell']],
    ['insight', ['insight', 'know']],
    ['structure', ['structure', 'state', 'now', 'project']],
    ['export', ['export', 'withdraw', 'share', 'save']],
    ['journal', ['journal', 'log', 'entry']],
    ['context', ['context', 'surface']]
  ];

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function cleanText(value) {
    return String(value || '').toLowerCase().replace(/[_/]+/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function matchesAny(text, list) {
    return list.some(term => text.includes(term));
  }

  function canonicalizeVerb(raw) {
    const seed = cleanText(raw);
    if (!seed) return 'inspect';
    if (allVerbs.includes(seed)) return seed;
    for (const [verb, synonyms] of verbSynonyms) {
      if (seed === verb || matchesAny(seed, synonyms)) return verb;
    }
    return 'inspect';
  }

  function inferTarget(raw, verb = '') {
    const seed = cleanText(raw);
    if (!seed) return 'context';
    for (const [target, hints] of targetHints) {
      if (matchesAny(seed, hints)) return target;
    }
    if (verb === 'capture') return 'capture';
    if (verb === 'withdraw' || verb === 'export') return 'export';
    return 'context';
  }

  function createContextModel(input = {}) {
    const now = new Date().toISOString();
    return {
      project_code: input.project_code || contracts?.baseProjectCode || 'prj-structa-r1',
      domain: input.domain || 'rabbit-r1-native',
      surface: input.surface || 'home',
      active_node: input.active_node || 'now',
      active_layer: input.active_layer || 'primary',
      active_verb: input.active_verb || 'inspect',
      active_target: input.active_target || 'context',
      approved_verbs: Array.isArray(input.approved_verbs) ? input.approved_verbs : [...coreVerbs],
      allowed_verbs: Array.isArray(input.allowed_verbs) ? input.allowed_verbs : [...(contracts?.allowedVerbs || allVerbs)],
      allowed_targets: Array.isArray(input.allowed_targets) ? input.allowed_targets : [...(contracts?.allowedTargets || ['project', 'capture', 'journal', 'export', 'camera', 'voice', 'context', 'insight', 'structure'])],
      response_mode: input.response_mode || 'silent',
      approval_mode: input.approval_mode || 'human_required',
      recent_routes: Array.isArray(input.recent_routes) ? input.recent_routes : [],
      last_route: input.last_route || null,
      nodes: Array.isArray(input.nodes) ? input.nodes : ['show', 'tell', 'know', 'now'],
      created_at: input.created_at || now,
      updated_at: input.updated_at || now
    };
  }

  const context = createContextModel();

  function snapshot() {
    return clone(context);
  }

  function updateContext(patch = {}) {
    Object.assign(context, patch, { updated_at: new Date().toISOString() });
    return snapshot();
  }

  function setActiveVerb(verb = 'inspect', target = 'context') {
    const canonicalVerb = canonicalizeVerb(verb);
    const nextTarget = inferTarget(target || canonicalVerb, canonicalVerb);
    return updateContext({ active_verb: canonicalVerb, active_target: nextTarget });
  }

  function setActiveNode(node = 'now') {
    return updateContext({ active_node: node || 'now', active_layer: 'primary' });
  }

  function getContext() {
    return snapshot();
  }

  function getRouteFamily(verb, requiresApproval) {
    if (requiresApproval) return 'approval-gated';
    if (advisoryVerbs.has(verb)) return 'advisory';
    if (verb === 'capture' || verb === 'journal') return 'capture';
    return 'inspect';
  }

  function routeAction(raw = {}, options = {}) {
    const contextSeed = options.context || context;
    const text = raw.intent || raw.text || raw.transcript || raw.goal || raw.prompt || '';
    const verb = canonicalizeVerb(raw.verb || text || contextSeed.active_verb);
    const target = raw.target || inferTarget(text || raw.payload?.note || '', verb) || contextSeed.active_target || 'context';
    const intent = raw.intent || `${verb} ${target}`.trim();
    const requiresApproval = raw.approval_mode === 'human_required' || mutatingVerbs.has(verb);
    const route = {
      route_id: contracts?.makeEntryId?.('route') || `route-${Date.now()}`,
      project_code: raw.project_code || contextSeed.project_code,
      verb,
      target,
      intent,
      source_type: raw.source_type || 'r1-native',
      input_type: raw.input_type || raw.kind || 'event',
      source: raw.source || 'native',
      approval_mode: requiresApproval ? 'human_required' : (raw.approval_mode || 'optional'),
      requires_approval: requiresApproval,
      response_mode: raw.response_mode || getRouteFamily(verb, requiresApproval),
      action_family: getRouteFamily(verb, requiresApproval),
      summary: `${verb} ${target}`.trim(),
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.86,
      payload_preview: raw.payload ? (typeof raw.payload === 'string' ? raw.payload : clone(raw.payload)) : null
    };
    updateContext({
      active_verb: verb,
      active_target: target,
      last_route: route,
      recent_routes: [route, ...(contextSeed.recent_routes || [])].slice(0, 8),
      response_mode: route.response_mode,
      approval_mode: route.approval_mode
    });
    return { ok: true, route, context_snapshot: snapshot() };
  }

  function summarizeContext(state = context) {
    return [
      `project=${state.project_code}`,
      `node=${state.active_node}`,
      `verb=${state.active_verb}`,
      `target=${state.active_target}`,
      `mode=${state.response_mode}`
    ].join(' · ');
  }

  window.StructaActionRouter = Object.freeze({
    createContextModel,
    getContext,
    snapshot,
    updateContext,
    setActiveVerb,
    setActiveNode,
    routeAction,
    summarizeContext,
    canonicalizeVerb,
    inferTarget
  });

  window.StructaContext = context;
})();
