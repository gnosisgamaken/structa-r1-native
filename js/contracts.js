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

  var uniqueCounters = {};

  function makeEntryId(kind = 'event') {
    const now = new Date();
    const base = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('') + `-${kind}`;
    if (kind !== 'claim') return base;
    uniqueCounters[base] = Number(uniqueCounters[base] || 0) + 1;
    return base + '-' + String(uniqueCounters[base]).padStart(2, '0');
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

  const focusKinds = Object.freeze([
    'branch', 'question', 'claim'
  ]);

  const focusPhases = Object.freeze([
    'observe', 'clarify', 'evaluate', 'decision'
  ]);

  const focusStates = Object.freeze([
    'active', 'resolved', 'plateau', 'dismissed', 'blocked', 'superseded'
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
      clarifications: Array.isArray(input.clarifications) ? input.clarifications.filter(Boolean) : [],
      disputedBy: Array.isArray(input.disputedBy) ? input.disputedBy.filter(Boolean) : [],
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

  function createFocus(input = {}) {
    const now = new Date().toISOString();
    return {
      id: input.id || makeEntryId('focus'),
      projectId: input.projectId || baseProjectCode,
      target: {
        kind: focusKinds.includes(input.target?.kind) ? input.target.kind : 'branch',
        id: String(input.target?.id || 'main'),
        branchId: String(input.target?.branchId || input.target?.id || 'main')
      },
      phase: focusPhases.includes(input.phase) ? input.phase : 'observe',
      state: focusStates.includes(input.state) ? input.state : 'active',
      createdAt: input.createdAt || now,
      lastStepAt: input.lastStepAt || null,
      steps: Array.isArray(input.steps) ? input.steps : [],
      plateauCount: Number.isFinite(input.plateauCount) ? Number(input.plateauCount) : 0,
      rejectCount: Number.isFinite(input.rejectCount) ? Number(input.rejectCount) : 0,
      lastUserSignalAt: input.lastUserSignalAt || now
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
      brief: typeof input.brief === 'string' ? input.brief : '',
      derived_candidates: input.derived_candidates && typeof input.derived_candidates === 'object' ? input.derived_candidates : {
        decisions: [],
        asks: [],
        blockers: [],
        themes: []
      },
      promoted_items: Array.isArray(input.promoted_items) ? input.promoted_items : [],
      nodes: Array.isArray(input.nodes) ? input.nodes : [],
      claims: Array.isArray(input.claims) ? input.claims : [],
      answers: Array.isArray(input.answers) ? input.answers : [],
      claimIndex: input.claimIndex && typeof input.claimIndex === 'object' ? input.claimIndex : {
        byItem: {},
        byBranch: {},
        byStatus: {}
      },
      focuses: Array.isArray(input.focuses) ? input.focuses : [],
      activeFocusId: input.activeFocusId || null,
      chainHistory: Array.isArray(input.chainHistory) ? input.chainHistory : [],
      impact_chain: Array.isArray(input.impact_chain) ? input.impact_chain : [],
      exports: Array.isArray(input.exports) ? input.exports : [],
      clarity_score: typeof input.clarity_score === 'number' ? input.clarity_score : 0,
      created_at: input.created_at || now,
      updated_at: now,
      meta: input.meta || {}
    };
  }

  function legalPhaseTransition(fromPhase, toPhase) {
    const phase = focusPhases.includes(fromPhase) ? fromPhase : 'observe';
    const target = focusPhases.includes(toPhase) ? toPhase : phase;
    const allowed = {
      observe: ['observe', 'clarify', 'evaluate'],
      clarify: ['clarify', 'evaluate', 'decision'],
      evaluate: ['clarify', 'evaluate', 'decision'],
      decision: ['decision', 'observe']
    };
    return (allowed[phase] || []).indexOf(target) !== -1;
  }

  function legalStateTransition(fromState, toState) {
    const state = focusStates.includes(fromState) ? fromState : 'active';
    const target = focusStates.includes(toState) ? toState : state;
    const allowed = {
      active: ['active', 'resolved', 'plateau', 'dismissed', 'blocked', 'superseded'],
      resolved: ['resolved'],
      plateau: ['plateau'],
      dismissed: ['dismissed'],
      blocked: ['blocked'],
      superseded: ['superseded']
    };
    return (allowed[state] || []).indexOf(target) !== -1;
  }

  function collectEvidenceRegistry(project = {}) {
    const registry = {};
    (project.claims || []).forEach(function(claim) {
      if (!claim?.id) return;
      registry[claim.id] = {
        kind: 'claim',
        id: claim.id,
        status: claim.status || 'active'
      };
    });
    (project.answers || []).forEach(function(answer) {
      if (!answer?.id) return;
      registry[answer.id] = {
        kind: 'answer',
        id: answer.id,
        status: 'active'
      };
    });
    (project.nodes || []).forEach(function(node) {
      if (!node?.node_id || node.type !== 'question') return;
      registry[node.node_id] = {
        kind: 'question',
        id: node.node_id,
        status: node.status || 'open'
      };
    });
    return registry;
  }

  function normalizeChainEvidence(value) {
    if (Array.isArray(value)) return value.map(function(entry) { return String(entry || '').trim(); }).filter(Boolean);
    if (typeof value === 'string') {
      return value.split(/[,\n|]/).map(function(entry) { return String(entry || '').trim(); }).filter(Boolean);
    }
    return [];
  }

  function normalizeChainOutput(output = {}) {
    const produced = output.produced && typeof output.produced === 'object' ? output.produced : {};
    const focus = output.focus && typeof output.focus === 'object' ? output.focus : {};
    const stepMetadata = output.step_metadata && typeof output.step_metadata === 'object' ? output.step_metadata : {};
    const normalizeCollection = function(items, mapper) {
      return Array.isArray(items) ? items.map(mapper).filter(Boolean) : [];
    };
    return {
      focus: {
        phase_next: focusPhases.includes(focus.phase_next) ? focus.phase_next : '',
        state_next: focusStates.includes(focus.state_next) ? focus.state_next : 'active'
      },
      produced: {
        claims: normalizeCollection(produced.claims, function(entry) {
          if (!entry || !String(entry.text || '').trim()) return null;
          return {
            ...entry,
            text: String(entry.text || '').trim(),
            branchId: String(entry.branchId || 'main'),
            evidence: normalizeChainEvidence(entry.evidence)
          };
        }),
        questions: normalizeCollection(produced.questions, function(entry) {
          if (!entry || !String(entry.body || '').trim()) return null;
          const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
          return {
            ...entry,
            id: String(entry.id || ''),
            body: String(entry.body || '').trim(),
            meta: {
              ...meta,
              evidence_claims: normalizeChainEvidence(meta.evidence_claims),
              rationale: String(meta.rationale || '').trim()
            }
          };
        }),
        decisions: normalizeCollection(produced.decisions, function(entry) {
          if (!entry || !String(entry.body || '').trim()) return null;
          return {
            ...entry,
            id: String(entry.id || ''),
            body: String(entry.body || '').trim(),
            evidence: normalizeChainEvidence(entry.evidence),
            options: Array.isArray(entry.options) ? entry.options.slice(0, 3).map(function(option) { return String(option || '').trim(); }).filter(Boolean) : [],
            recommended: entry.recommended || ''
          };
        }),
        tasks: normalizeCollection(produced.tasks, function(entry) {
          if (!entry || !String(entry.body || '').trim()) return null;
          return {
            ...entry,
            id: String(entry.id || ''),
            body: String(entry.body || '').trim(),
            evidence: normalizeChainEvidence(entry.evidence)
          };
        })
      },
      step_metadata: {
        rationale: String(stepMetadata.rationale || '').trim(),
        confidence: typeof stepMetadata.confidence === 'number' ? stepMetadata.confidence : 0.0,
        model: String(stepMetadata.model || '').trim(),
        latencyMs: Number.isFinite(stepMetadata.latencyMs) ? Number(stepMetadata.latencyMs) : 0
      },
      note: String(output.note || '').trim()
    };
  }

  function normalizeTriangleOutput(output = {}) {
    const stepMetadata = output.step_metadata && typeof output.step_metadata === 'object' ? output.step_metadata : {};
    const normalizeClaimEntry = function(entry) {
      if (!entry || !String(entry.text || '').trim()) return null;
      return {
        ...entry,
        text: String(entry.text || '').trim(),
        kind: String(entry.kind || 'fact').trim().toLowerCase(),
        branchId: String(entry.branchId || 'main').trim() || 'main',
        evidence: normalizeChainEvidence(entry.evidence)
      };
    };
    const normalizeQuestionEntry = function(entry) {
      if (!entry || !String(entry.body || '').trim()) return null;
      const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
      return {
        ...entry,
        body: String(entry.body || '').trim(),
        meta: {
          ...meta,
          evidence_claims: normalizeChainEvidence(meta.evidence_claims),
          rationale: String(meta.rationale || '').trim()
        }
      };
    };
    return {
      status: output.status === 'ambiguous' ? 'ambiguous' : 'synthesized',
      title: String(output.title || '').trim(),
      branchId: String(output.branchId || 'main').trim() || 'main',
      derived_claims: Array.isArray(output.derived_claims)
        ? output.derived_claims.map(normalizeClaimEntry).filter(Boolean)
        : [],
      unresolved_tensions: Array.isArray(output.unresolved_tensions)
        ? output.unresolved_tensions.map(function(entry) {
            const between = Array.isArray(entry?.between)
              ? entry.between.map(function(ref) { return String(ref || '').trim(); }).filter(Boolean).slice(0, 2)
              : [];
            return {
              between: between,
              note: String(entry?.note || '').trim()
            };
          }).filter(function(entry) { return entry.between.length === 2; })
        : [],
      question: normalizeQuestionEntry(output.question || null),
      step_metadata: {
        rationale: String(stepMetadata.rationale || '').trim(),
        confidence: typeof stepMetadata.confidence === 'number' ? stepMetadata.confidence : 0.0,
        model: String(stepMetadata.model || '').trim(),
        latencyMs: Number.isFinite(stepMetadata.latencyMs) ? Number(stepMetadata.latencyMs) : 0
      }
    };
  }

  function validateChainOutput(output = {}, context = {}) {
    const normalized = normalizeChainOutput(output);
    const errors = [];
    const project = context.project || {};
    const currentPhase = focusPhases.includes(context.currentPhase) ? context.currentPhase : 'observe';
    const currentState = focusStates.includes(context.currentState) ? context.currentState : 'active';
    const registry = collectEvidenceRegistry(project);
    const allowStatus = { active: true, disputed: true, open: true };

    if (!normalized.focus.phase_next) {
      errors.push({ code: 'missing_phase_next' });
    } else if (!legalPhaseTransition(currentPhase, normalized.focus.phase_next)) {
      errors.push({ code: 'illegal_phase', from: currentPhase, to: normalized.focus.phase_next });
    }

    if (!legalStateTransition(currentState, normalized.focus.state_next)) {
      errors.push({ code: 'illegal_state', from: currentState, to: normalized.focus.state_next });
    }

    function validateEvidence(entries, getEvidence, nodeKind) {
      entries.forEach(function(entry) {
        const evidence = getEvidence(entry);
        if (!evidence.length) {
          errors.push({ code: 'no_evidence', nodeKind: nodeKind, nodeId: entry.id || entry.text || entry.body || '' });
          return;
        }
        evidence.forEach(function(ref) {
          const found = registry[ref];
          if (!found) {
            errors.push({ code: 'orphan_evidence', nodeKind: nodeKind, nodeId: entry.id || entry.text || entry.body || '', missingRef: ref });
            return;
          }
          if (!allowStatus[found.status]) {
            errors.push({ code: 'inactive_evidence', nodeKind: nodeKind, nodeId: entry.id || entry.text || entry.body || '', ref: ref, status: found.status });
          }
        });
      });
    }

    validateEvidence(normalized.produced.claims, function(entry) { return entry.evidence || []; }, 'claim');
    validateEvidence(normalized.produced.decisions, function(entry) { return entry.evidence || []; }, 'decision');
    validateEvidence(normalized.produced.tasks, function(entry) { return entry.evidence || []; }, 'task');
    validateEvidence(normalized.produced.questions, function(entry) { return entry.meta?.evidence_claims || []; }, 'question');

    return {
      ok: errors.length === 0,
      errors: errors,
      value: normalized
    };
  }

  function validateTriangleOutput(output = {}, context = {}) {
    const normalized = normalizeTriangleOutput(output);
    const errors = [];
    const parentEvidenceIds = Array.isArray(context.parentEvidenceIds)
      ? context.parentEvidenceIds.map(function(ref) { return String(ref || '').trim(); }).filter(Boolean)
      : [];
    const allowedParents = new Set(parentEvidenceIds);

    if (output && typeof output === 'object' && Object.prototype.hasOwnProperty.call(output, 'body') && String(output.body || '').trim()) {
      errors.push({ code: 'unexpected_body' });
    }

    const verdict = validateChainOutput({
      focus: {
        phase_next: 'observe',
        state_next: 'active'
      },
      produced: {
        claims: normalized.status === 'synthesized' ? normalized.derived_claims : [],
        questions: normalized.status === 'ambiguous' && normalized.question ? [normalized.question] : [],
        decisions: [],
        tasks: []
      },
      step_metadata: normalized.step_metadata
    }, {
      project: context.project || {},
      currentPhase: 'observe',
      currentState: 'active'
    });

    if (!verdict.ok) errors.push.apply(errors, verdict.errors || []);

    if (normalized.status === 'synthesized') {
      if (!normalized.title) errors.push({ code: 'missing_title' });
      if (!normalized.derived_claims.length) {
        errors.push({ code: 'no_derived_claims' });
      }
      normalized.derived_claims.forEach(function(entry) {
        const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
        if (evidence.length < 2) {
          errors.push({
            code: 'weak_evidence',
            nodeKind: 'claim',
            nodeId: entry.id || entry.text || ''
          });
        }
        evidence.forEach(function(ref) {
          if (!allowedParents.has(ref)) {
            errors.push({
              code: 'parent_evidence_mismatch',
              nodeKind: 'claim',
              nodeId: entry.id || entry.text || '',
              missingRef: ref
            });
          }
        });
      });
    } else {
      if (!normalized.question) {
        errors.push({ code: 'missing_question' });
      } else {
        const evidenceClaims = normalized.question.meta?.evidence_claims || [];
        evidenceClaims.forEach(function(ref) {
          if (!allowedParents.has(ref)) {
            errors.push({
              code: 'parent_evidence_mismatch',
              nodeKind: 'question',
              nodeId: normalized.question.id || normalized.question.body || '',
              missingRef: ref
            });
          }
        });
      }
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      value: normalized
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
    focusKinds,
    focusPhases,
    focusStates,
    projectTypes,
    vocabularyMap,
    makeEntryId,
    createEnvelope,
    createCaptureBundle,
    createJournalEntry,
    createNode,
    createClaim,
    createAnswerNode,
    createFocus,
    createProject,
    createTransfer,
    getVocabulary,
    legalPhaseTransition,
    legalStateTransition,
    validateChainOutput,
    validateTriangleOutput
  });
})();
