(() => {
  const contracts = window.StructaContracts;

  const CORE_VERBS = Object.freeze(['build', 'patch', 'delete', 'solve', 'consolidate', 'decide', 'research', 'withdraw']);
  const EXTENDED_VERBS = Object.freeze(['inspect', 'capture', 'approve', 'rollback', 'export', 'journal', 'email']);
  const ALL_VERBS = Object.freeze([...(contracts?.allowedVerbs || []), ...CORE_VERBS, ...EXTENDED_VERBS]);
  const MUTATING_VERBS = new Set(['build', 'patch', 'delete', 'withdraw', 'export']);
  const ADVISORY_VERBS = new Set(['solve', 'research', 'decide', 'consolidate']);
  const CAPTURE_VERBS = new Set(['inspect', 'capture', 'journal', 'approve', 'rollback', 'email']);

  const VERB_SYNONYMS = [
    ['build', ['build', 'create', 'add', 'make', 'construct', 'draft', 'compose', 'assemble']],
    ['patch', ['patch', 'fix', 'edit', 'update', 'modify', 'change', 'refine', 'tune', 'adjust']],
    ['delete', ['delete', 'remove', 'erase', 'clear', 'drop', 'discard', 'prune']],
    ['solve', ['solve', 'resolve', 'debug', 'troubleshoot', 'untangle', 'repair', 'figure out']],
    ['consolidate', ['consolidate', 'merge', 'combine', 'compress', 'summarize', 'group', 'fold']],
    ['decide', ['decide', 'choose', 'pick', 'select', 'settle on', 'commit to']],
    ['research', ['research', 'search', 'scan', 'explore', 'lookup', 'look up', 'inspect', 'investigate']],
    ['withdraw', ['withdraw', 'export', 'send out', 'share', 'publish', 'deliver', 'export email']],
    ['inspect', ['inspect', 'review', 'check', 'observe', 'open', 'read']],
    ['capture', ['capture', 'record', 'snapshot', 'grab', 'photo', 'image', 'voice', 'transcribe']],
    ['journal', ['journal', 'log', 'note', 'write down']],
    ['approve', ['approve', 'allow', 'confirm', 'okay', 'ok', 'accept']],
    ['rollback', ['rollback', 'undo', 'revert', 'restore']],
    ['email', ['email', 'mail', 'send email', 'withdraw email']],
    ['export', ['export', 'download', 'save out', 'send out']]
  ];

  const TARGET_HINTS = [
    ['journal', ['journal', 'note', 'log', 'entry']],
    ['camera', ['camera', 'photo', 'image', 'selfie', 'picture', 'shot']],
    ['voice', ['voice', 'mic', 'microphone', 'speech', 'transcript', 'ptt']],
    ['export', ['export', 'withdraw', 'send', 'share', 'email']],
    ['context', ['context', 'project', 'panel', 'surface', 'state']],
    ['decision', ['decision', 'decide', 'choice']],
    ['issue', ['issue', 'bug', 'problem', 'task', 'ticket']],
    ['asset', ['asset', 'file', 'image', 'bundle']],
    ['drawer', ['drawer', 'log', 'tray']]
  ];

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function cleanText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[_/]+/g, ' ')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchesAny(text, list) {
    return list.some(term => text.includes(term));
  }

  function canonicalizeVerb(raw) {
    const seed = cleanText(raw);
    if (!seed) return 'inspect';

    if (ALL_VERBS.includes(seed)) return seed;
    for (const [verb, synonyms] of VERB_SYNONYMS) {
      if (seed === verb || matchesAny(seed, synonyms)) return verb;
    }
    return 'inspect';
  }

  function inferTarget(raw, verb = '') {
    const seed = cleanText(raw);
    if (!seed) return 'context';
    for (const [target, hints] of TARGET_HINTS) {
      if (matchesAny(seed, hints)) return target;
    }
    if (verb === 'capture') return 'capture';
    if (verb === 'withdraw' || verb === 'export') return 'export';
    if (verb === 'journal') return 'journal';
    return 'context';
  }

  function inferIntent(raw, verb, target) {
    const seed = typeof raw === 'string' ? raw.trim() : '';
    if (seed) return seed;
    return `${verb} ${target}`.trim();
  }

  function createContextModel(input = {}) {
    const now = new Date().toISOString();
    return {
      project_code: input.project_code || contracts?.baseProjectCode || 'PRJ-STRUCTA-R1',
      domain: input.domain || 'rabbit-r1-native',
      surface: input.surface || 'hexagon-engine',
      active_node: input.active_node || 'core',
      active_layer: input.active_layer || 'primary',
      active_verb: input.active_verb || 'inspect',
      active_target: input.active_target || 'context',
      approved_verbs: Array.isArray(input.approved_verbs) ? input.approved_verbs : [...CORE_VERBS],
      allowed_verbs: Array.isArray(input.allowed_verbs) ? input.allowed_verbs : [...(contracts?.allowedVerbs || ALL_VERBS)],
      allowed_targets: Array.isArray(input.allowed_targets) ? input.allowed_targets : [...(contracts?.allowedTargets || ['project', 'node', 'issue', 'decision', 'asset', 'capture', 'journal', 'export', 'camera', 'voice', 'context', 'drawer'])],
      response_mode: input.response_mode || 'silent',
      approval_mode: input.approval_mode || 'human_required',
      journal_policy: input.journal_policy || 'approval-gated',
      recent_routes: Array.isArray(input.recent_routes) ? input.recent_routes : [],
      last_route: input.last_route || null,
      nodes: Array.isArray(input.nodes) ? input.nodes : ['core', 'memory', 'output', 'support', 'contract', 'validator'],
      created_at: input.created_at || now,
      updated_at: input.updated_at || now
    };
  }

  const context = createContextModel();

  function updateContext(patch = {}) {
    Object.assign(context, patch, { updated_at: new Date().toISOString() });
    return snapshot();
  }

  function setActiveVerb(verb = 'inspect', target = 'context') {
    const canonicalVerb = canonicalizeVerb(verb);
    const nextTarget = inferTarget(target || canonicalVerb, canonicalVerb);
    return updateContext({ active_verb: canonicalVerb, active_target: nextTarget });
  }

  function setActiveNode(node = 'core') {
    return updateContext({ active_node: node || 'core', active_layer: ['contract', 'validator'].includes(node) ? 'hidden' : 'primary' });
  }

  function getContext() {
    return snapshot();
  }

  function snapshot() {
    return clone(context);
  }

  function getRouteFamily(verb, requiresApproval) {
    if (requiresApproval) return 'approval-gated';
    if (ADVISORY_VERBS.has(verb)) return 'advisory';
    if (CAPTURE_VERBS.has(verb)) return 'capture';
    return 'inspect';
  }

  function routeAction(raw = {}, options = {}) {
    const contextSeed = options.context || context;
    const text = raw.intent || raw.text || raw.transcript || raw.goal || raw.prompt || '';
    const verb = canonicalizeVerb(raw.verb || text || contextSeed.active_verb);
    const target = raw.target || inferTarget(text || raw.payload?.note || '', verb) || contextSeed.active_target || 'context';
    const intent = raw.intent || inferIntent(text, verb, target);
    const requiresApproval = raw.approval_mode === 'human_required' || MUTATING_VERBS.has(verb);
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
      confidence: typeof raw.confidence === 'number' ? raw.confidence : (raw.verb ? 0.95 : 0.72),
      payload_preview: raw.payload ? (typeof raw.payload === 'string' ? raw.payload : clone(raw.payload)) : null
    };

    const nextContext = {
      active_verb: CORE_VERBS.includes(verb) || MUTATING_VERBS.has(verb) || ADVISORY_VERBS.has(verb) ? verb : contextSeed.active_verb,
      active_target: target,
      active_node: contextSeed.active_node,
      last_route: route,
      recent_routes: [route, ...(contextSeed.recent_routes || [])].slice(0, 8),
      response_mode: route.response_mode,
      approval_mode: route.approval_mode
    };
    updateContext(nextContext);

    return {
      ok: true,
      route,
      context_snapshot: snapshot()
    };
  }

  function summarizeContext(state = context) {
    return [
      `project=${state.project_code}`,
      `domain=${state.domain}`,
      `node=${state.active_node}`,
      `verb=${state.active_verb}`,
      `target=${state.active_target}`,
      `mode=${state.response_mode}`
    ].join(' · ');
  }

  function describeRoute(route = {}) {
    const pieces = [route.verb, route.target].filter(Boolean).join(' › ');
    return `${pieces}${route.requires_approval ? ' (approval)' : ''}`.trim();
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
    describeRoute,
    canonicalizeVerb,
    inferTarget,
    inferIntent
  });

  window.StructaContext = context;
})();
