/**
 * project-engine.js — governed project ledger and creative-core map for V3.
 *
 * The model may propose structure and research. Only an explicit human action
 * can approve a decision. Every meaningful change is recorded as an event and
 * all generated structure remains reversible.
 */
(() => {
  'use strict';

  const SCHEMA = 'structa.project.v3';
  const VERSION = 1;
  const MAX_EVENTS = 1000;
  const MAX_REFERENCES = 200;
  const MAX_UNCERTAINTIES = 300;
  const VALID_BRANCH_STATES = ['seed', 'open', 'blocked', 'decision_ready', 'decided', 'validate', 'closed'];
  const OPERATION_TYPES = Object.freeze([
    'branch.update', 'branch.open', 'branch.close',
    'uncertainty.queue', 'decision.propose', 'decision.approve', 'decision.dismiss', 'decision.reopen', 'event.revert'
  ]);
  let sequence = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    sequence += 1;
    return String(prefix || 'item') + '-' + Date.now().toString(36) + '-' + sequence.toString(36);
  }

  function clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }

  function compact(value, limit) {
    const max = Number(limit || 160);
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  function lower(value) {
    return String(value || '').toLowerCase();
  }

  function uniqueStrings(values, limit) {
    const output = [];
    (Array.isArray(values) ? values : []).forEach(function(value) {
      const text = compact(value, 180);
      if (!text || output.some(function(entry) { return lower(entry) === lower(text); })) return;
      output.push(text);
    });
    return output.slice(0, Number(limit || output.length || 1));
  }

  function normalizePackIds(project, state) {
    const packs = window.StructaDomainPacks;
    const explicit = Array.isArray(state?.pack_ids) ? state.pack_ids : [];
    const sourceText = [
      project?.name,
      project?.brief,
      project?.type,
      project?.user_role,
      (project?.voice_entries || []).slice(-3).map(function(entry) { return entry?.body || entry?.text || ''; }).join(' ')
    ].filter(Boolean).join(' ');
    const inferred = packs?.infer ? packs.infer(sourceText) : ['creative-core'];
    return ['creative-core'].concat(explicit, inferred)
      .filter(function(id, index, list) {
        return !!id && list.indexOf(id) === index && (!packs?.get || !!packs.packs?.[id]);
      });
  }

  function createBranch(template, existing) {
    const current = existing && typeof existing === 'object' ? existing : {};
    return {
      id: template.id,
      title: compact(current.title || template.title || template.id, 32),
      status: VALID_BRANCH_STATES.indexOf(current.status) !== -1 ? current.status : 'seed',
      summary: compact(current.summary || '', 180),
      driving_question: compact(current.driving_question || template.drivingQuestion || '', 160),
      closure_condition: compact(current.closure_condition || template.closureCondition || '', 160),
      lenses: uniqueStrings(current.lenses || template.lenses || [], 16),
      completeness: Math.max(0, Math.min(100, Number(current.completeness || 0))),
      confidence: Math.max(0, Math.min(1, Number(current.confidence || 0))),
      evidence_ids: uniqueStrings(current.evidence_ids || [], 40),
      reference_ids: uniqueStrings(current.reference_ids || [], 60),
      question_ids: uniqueStrings(current.question_ids || [], 30),
      decision_ids: uniqueStrings(current.decision_ids || [], 30),
      task_ids: uniqueStrings(current.task_ids || [], 30),
      blocker_count: Math.max(0, Number(current.blocker_count || 0)),
      updated_at: current.updated_at || nowIso(),
      closed_at: current.closed_at || null
    };
  }

  function ensure(project) {
    if (!project || typeof project !== 'object') return project;
    if (Array.isArray(project.pending_decisions)) {
      project.pending_decisions = project.pending_decisions.map(function(decision) {
        if (typeof decision === 'string') {
          return { id: makeId('decision'), text: decision, options: [], source: 'migration' };
        }
        if (!decision || typeof decision !== 'object' || decision.id || decision.node_id) return decision;
        return Object.assign({}, decision, { id: makeId('decision') });
      });
    }
    const existing = project.structa_v3 && typeof project.structa_v3 === 'object' ? project.structa_v3 : {};
    const packIds = normalizePackIds(project, existing);
    const composed = window.StructaDomainPacks?.compose?.(packIds) || {
      ids: packIds,
      branches: [
        { id: 'outcome', title: 'outcome', drivingQuestion: 'what must exist when this succeeds?' },
        { id: 'audience', title: 'people', drivingQuestion: 'who must this work for?' },
        { id: 'direction', title: 'direction', drivingQuestion: 'which direction should lead?' },
        { id: 'constraints', title: 'reality', drivingQuestion: 'what limits the project?' },
        { id: 'validation', title: 'proof', drivingQuestion: 'how will this be tested?' },
        { id: 'delivery', title: 'delivery', drivingQuestion: 'what should happen next?' }
      ]
    };
    const branchIndex = {};
    (Array.isArray(existing.branches) ? existing.branches : []).forEach(function(branch) {
      if (branch?.id) branchIndex[branch.id] = branch;
    });

    project.structa_v3 = {
      schema: SCHEMA,
      version: VERSION,
      revision: Math.max(0, Number(existing.revision || 0)),
      pack_ids: composed.ids || packIds,
      constitution: {
        outcome: compact(existing.constitution?.outcome || project.brief || '', 320),
        audience: compact(existing.constitution?.audience || project.user_role || '', 180),
        success: compact(existing.constitution?.success || '', 220),
        non_goals: uniqueStrings(existing.constitution?.non_goals || [], 12),
        constraints: uniqueStrings(existing.constitution?.constraints || [], 20),
        guardrails: uniqueStrings(existing.constitution?.guardrails || [
          'structure and research may advance automatically',
          'decisions require explicit human approval'
        ], 12),
        updated_at: existing.constitution?.updated_at || project.updated_at || nowIso()
      },
      branches: (composed.branches || []).map(function(template) {
        return createBranch(template, branchIndex[template.id]);
      }),
      references: Array.isArray(existing.references) ? existing.references.slice(-MAX_REFERENCES) : [],
      uncertainties: Array.isArray(existing.uncertainties) ? existing.uncertainties.slice(-MAX_UNCERTAINTIES) : [],
      events: Array.isArray(existing.events) ? existing.events.slice(-MAX_EVENTS) : [],
      exports: Array.isArray(existing.exports) ? existing.exports.slice(-50) : [],
      sessions: Array.isArray(existing.sessions) ? existing.sessions.slice(-30) : [],
      review_requested: !!existing.review_requested,
      map_ready_at: existing.map_ready_at || null,
      last_advanced_at: existing.last_advanced_at || null,
      last_exported_at: existing.last_exported_at || null,
      created_at: existing.created_at || project.created_at || nowIso(),
      updated_at: existing.updated_at || project.updated_at || nowIso()
    };
    return project;
  }

  function recordEvent(project, type, payload, actor) {
    ensure(project);
    const event = {
      id: makeId('evt'),
      type: compact(type || 'project.updated', 64),
      actor: actor === 'human' ? 'human' : (actor === 'system' ? 'system' : 'structa'),
      at: nowIso(),
      payload: clone(payload || {})
    };
    project.structa_v3.events.push(event);
    if (project.structa_v3.events.length > MAX_EVENTS) {
      project.structa_v3.events.splice(0, project.structa_v3.events.length - MAX_EVENTS);
    }
    project.structa_v3.updated_at = event.at;
    project.structa_v3.revision = Math.max(0, Number(project.structa_v3.revision || 0)) + 1;
    return event;
  }

  function pendingDecisionList(project) {
    return Array.isArray(project?.pending_decisions) ? project.pending_decisions : [];
  }

  function openQuestionList(project) {
    if (Array.isArray(project?.open_question_nodes)) return project.open_question_nodes;
    return (project?.nodes || []).filter(function(node) { return node?.type === 'question' && node?.status === 'open'; });
  }

  function relevantCount(project, kind) {
    const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
    return nodes.filter(function(node) {
      if (!node || node.status === 'archived') return false;
      return node.type === kind;
    }).length;
  }

  function calculateCompleteness(project, branch) {
    const state = project.structa_v3;
    const constitution = state.constitution;
    const derived = project.derived_candidates || {};
    const decisions = Array.isArray(project.decisions) ? project.decisions.length : 0;
    const pending = pendingDecisionList(project).length;
    const backlog = Array.isArray(project.backlog) ? project.backlog.length : 0;
    const claims = Array.isArray(project.claims) ? project.claims : [];
    const constraintClaims = claims.filter(function(claim) { return claim?.kind === 'constraint' && claim?.status !== 'archived'; }).length;
    const score = {
      outcome: (constitution.outcome ? 65 : 0) + (constitution.success ? 35 : 0),
      audience: (constitution.audience ? 70 : 0) + (relevantCount(project, 'answer') > 0 ? 15 : 0) + (claims.length > 1 ? 15 : 0),
      direction: Math.min(100, ((project.insights || []).length * 18) + ((derived.themes || []).length * 14) + ((decisions + pending) * 20)),
      constraints: Math.min(100, (constitution.constraints.length * 18) + (constraintClaims * 20) + ((derived.blockers || []).length * 20)),
      validation: Math.min(100, (constitution.success ? 35 : 0) + (relevantCount(project, 'research') * 15) + (backlog * 8) + (decisions * 12)),
      delivery: Math.min(100, (backlog * 18) + (decisions * 16) + (project.exports?.length ? 18 : 0))
    };
    return Math.max(branch.completeness || 0, branch.summary ? 35 : 0, Math.round(score[branch.id] || 0));
  }

  function reconcile(project) {
    ensure(project);
    const pending = pendingDecisionList(project);
    const questions = openQuestionList(project);
    const blockers = project.derived_candidates?.blockers || [];
    const decisions = Array.isArray(project.decisions) ? project.decisions : [];

    project.structa_v3.branches.forEach(function(branch) {
      branch.completeness = calculateCompleteness(project, branch);
      branch.blocker_count = branch.id === 'constraints' ? blockers.length : 0;
      branch.question_ids = questions
        .filter(function(question) { return (question?.branch_id || question?.meta?.branch_id || 'outcome') === branch.id; })
        .map(function(question) { return question.node_id || question.id || ''; })
        .filter(Boolean);
      branch.decision_ids = pending.concat(decisions)
        .filter(function(decision) { return (decision?.branch_id || decision?.meta?.branch_id || 'direction') === branch.id; })
        .map(function(decision) { return decision?.id || decision?.node_id || compact(decision?.text || decision?.title || decision, 48); })
        .filter(Boolean);

      if (branch.closed_at) branch.status = 'closed';
      else if (branch.blocker_count > 0) branch.status = 'blocked';
      else if (pending.some(function(decision) { return (decision?.branch_id || decision?.meta?.branch_id || 'direction') === branch.id; })) branch.status = 'decision_ready';
      else if (decisions.some(function(decision) { return (decision?.branch_id || decision?.meta?.branch_id || 'direction') === branch.id; })) branch.status = branch.completeness >= 80 ? 'validate' : 'decided';
      else if (branch.completeness > 0) branch.status = 'open';
      else branch.status = 'seed';
      branch.confidence = Math.min(0.95, Math.max(branch.confidence || 0, branch.completeness / 125));
    });

    const avg = project.structa_v3.branches.reduce(function(total, branch) { return total + branch.completeness; }, 0) / Math.max(1, project.structa_v3.branches.length);
    if (!project.structa_v3.map_ready_at && project.structa_v3.constitution.outcome && avg >= 18) {
      project.structa_v3.map_ready_at = nowIso();
    }
    return project;
  }

  function getMapView(projectInput) {
    const project = reconcile(clone(projectInput || window.StructaNative?.getProjectMemory?.() || {}));
    const state = project.structa_v3;
    const completeness = Math.round(state.branches.reduce(function(total, branch) {
      return total + branch.completeness;
    }, 0) / Math.max(1, state.branches.length));
    return {
      schema: state.schema,
      revision: state.revision,
      project_id: project.project_id || project.id || '',
      title: project.name || 'untitled project',
      brief: project.brief || '',
      pack_ids: state.pack_ids.slice(),
      constitution: clone(state.constitution),
      outcome: state.constitution.outcome,
      branches: state.branches.map(function(branch) {
        const next = branch.summary || branch.driving_question || branch.closure_condition || '';
        return Object.assign(clone(branch), {
          state: branch.status,
          outcome: branch.closure_condition,
          evidenceCount: branch.evidence_ids.length,
          referenceCount: branch.reference_ids.length,
          unknownCount: branch.question_ids.length + branch.blocker_count,
          decisionCount: branch.decision_ids.length,
          next: compact(next, 110)
        });
      }),
      currentBranchId: project.active_focus?.branch_id || project.ui_state?.current_branch_id || '',
      completeness: completeness,
      open_decisions: pendingDecisionList(project).length,
      open_questions: openQuestionList(project).length,
      uncertainty_count: state.uncertainties.filter(function(item) { return item.status === 'queued'; }).length,
      reference_count: state.references.length,
      map_ready_at: state.map_ready_at
    };
  }

  function normalizeDecision(decision, index) {
    const raw = typeof decision === 'string' ? { text: decision } : (decision || {});
    const options = uniqueStrings(raw.options || raw.decision_options || [], 4);
    return {
      id: raw.id || raw.node_id || 'decision-' + index,
      type: 'decision',
      label: 'decision ready',
      text: compact(raw.text || raw.title || raw.body || 'decision awaiting review', 180),
      why: compact(raw.why || raw.rationale || raw.insight_body || 'this choice changes the project direction', 160),
      options: options.length >= 2 ? options : ['lock this direction', 'shape another answer'],
      recommended: compact(raw.recommended || '', 80),
      branch_id: raw.branch_id || raw.meta?.branch_id || 'direction',
      confidence: raw.confidence || 'med',
      index: index
    };
  }

  function appendDecisionCandidates(project, candidates, meta) {
    const rows = Array.isArray(candidates) ? candidates : [];
    if (!rows.length) return [];
    const details = meta && typeof meta === 'object' ? meta : {};
    const pending = pendingDecisionList(project);
    const resolved = Array.isArray(project.decisions) ? project.decisions : [];
    const knownIds = new Set();
    const knownText = new Set();
    pending.concat(resolved).forEach(function(entry, index) {
      const normalized = normalizeDecision(entry, index);
      if (normalized.id) knownIds.add(normalized.id);
      if (normalized.text) knownText.add(lower(normalized.text));
    });
    const added = [];
    rows.slice(0, 6).forEach(function(candidate, index) {
      const raw = typeof candidate === 'string' ? { text: candidate } : (candidate || {});
      const text = compact(raw.text || raw.title || raw.body || '', 180);
      if (!text) return;
      const id = compact(raw.id || raw.decision_id || '', 80) || makeId('decision');
      if (knownIds.has(id) || knownText.has(lower(text))) return;
      const suppliedOptions = uniqueStrings(raw.options || raw.decision_options || [], 4);
      const decision = {
        id: id,
        text: text,
        why: compact(raw.why || raw.rationale || details.why || 'this choice changes the project direction', 160),
        options: suppliedOptions.length >= 2 ? suppliedOptions : ['lock this direction', 'shape another answer'],
        recommended: compact(raw.recommended || '', 80),
        branch_id: raw.branch_id || raw.branchId || details.branchId || 'direction',
        confidence: raw.confidence || 'med',
        source: raw.source || details.source || 'structa',
        source_ref: clone(raw.sourceRef || details.sourceRef || {}),
        requires_user_approval: true,
        created_at: raw.created_at || nowIso()
      };
      knownIds.add(decision.id);
      knownText.add(lower(decision.text));
      added.push(decision);
    });
    if (!added.length) return [];
    project.pending_decisions = added.concat(pending);
    added.forEach(function(decision) {
      recordEvent(project, 'decision.proposed', {
        decision_id: decision.id,
        branch_id: decision.branch_id,
        source: decision.source
      }, 'structa');
    });
    return added;
  }

  function queuedUncertainties(project) {
    ensure(project);
    return project.structa_v3.uncertainties.filter(function(item) { return item?.status === 'queued'; });
  }

  function getNowView(projectInput) {
    const project = reconcile(clone(projectInput || window.StructaNative?.getProjectMemory?.() || {}));
    const state = project.structa_v3;
    const pending = pendingDecisionList(project);
    const uncertainties = queuedUncertainties(project);
    const blocksDecision = pending.length && uncertainties.some(function(item) {
      return item.impact === 'high' || item.related_ids?.indexOf(pending[0]?.id || pending[0]?.node_id || '') >= 0;
    });
    if (uncertainties.length && (state.review_requested || uncertainties.length >= 3 || blocksDecision)) {
      const item = uncertainties[0];
      return {
        id: item.id,
        type: 'uncertainty_review',
        label: 'review batch',
        text: compact(item.statement || 'visual observation needs review', 180),
        why: compact(item.why || 'confirm before this influences a consequential decision', 160),
        options: ['confirm', 'correct', 'dismiss'],
        batch_count: uncertainties.length,
        branch_id: item.branch_id || 'direction',
        capture_id: item.capture_id || ''
      };
    }
    if (pending.length) return normalizeDecision(pending[0], 0);

    const questions = openQuestionList(project);
    if (questions.length) {
      const question = questions[0];
      return {
        id: question.node_id || question.id || 'question-0',
        type: 'question',
        label: 'one useful question',
        text: compact(question.body || question.title || question, 180),
        why: compact(question.meta?.rationale || 'your answer will advance the project map', 160),
        branch_id: question.branch_id || question.meta?.branch_id || 'outcome'
      };
    }

    const candidates = state.branches
      .filter(function(branch) { return branch.status !== 'closed'; })
      .sort(function(a, b) {
        const aPenalty = a.id === 'outcome' && !state.constitution.outcome ? -100 : 0;
        const bPenalty = b.id === 'outcome' && !state.constitution.outcome ? -100 : 0;
        return (a.completeness + aPenalty) - (b.completeness + bPenalty);
      });
    const branch = candidates[0];
    if (branch && branch.completeness < 100) {
      return {
        id: branch.id,
        type: 'map_gap',
        label: branch.title + ' · ' + branch.completeness + '%',
        text: branch.driving_question,
        why: compact('this is the least resolved part of the project map', 160),
        branch_id: branch.id
      };
    }

    return {
      id: 'ready',
      type: 'ready',
      label: 'map coherent',
      text: 'choose the next delivery move',
      why: 'the current project map has no blocking gaps',
      branch_id: 'delivery'
    };
  }

  function projectIdOf(project) {
    return String(project?.project_id || project?.id || '');
  }

  function mutateActive(mutator, expectedProjectId) {
    const native = window.StructaNative;
    if (!native?.touchProjectMemory) return null;
    let output = null;
    let stale = false;
    const targetProjectId = String(expectedProjectId || '').trim();
    const canAddressProject = !!(targetProjectId && native.touchProjectMemoryById);
    const touch = canAddressProject
      ? function(callback) { return native.touchProjectMemoryById(targetProjectId, callback); }
      : function(callback) { return native.touchProjectMemory(callback); };
    const touched = touch(function(project) {
      if (expectedProjectId && projectIdOf(project) !== String(expectedProjectId)) {
        stale = true;
        return;
      }
      ensure(project);
      output = mutator(project) || project;
      reconcile(project);
      project.structa_v3.updated_at = nowIso();
    });
    if (canAddressProject && !touched) stale = true;
    if (stale) return { ok: false, stale: true, error: 'active project changed' };
    return clone(output);
  }

  function seedFromBrief(result, meta) {
    const payload = result && typeof result === 'object' ? result : {};
    const details = meta && typeof meta === 'object' ? meta : {};
    return mutateActive(function(project) {
      const state = project.structa_v3;
      const proposed = payload.map || payload.project_map || {};
      const constitution = payload.constitution || proposed.constitution || {};
      state.pack_ids = normalizePackIds(project, {
        pack_ids: ['creative-core'].concat(payload.packHints || payload.pack_hints || proposed.pack_ids || state.pack_ids || [])
      });
      const composed = window.StructaDomainPacks?.compose?.(state.pack_ids);
      (composed?.branches || []).forEach(function(template) {
        const branch = state.branches.find(function(entry) { return entry.id === template.id; });
        if (branch) branch.lenses = uniqueStrings((branch.lenses || []).concat(template.lenses || []), 16);
      });
      state.constitution.outcome = compact(constitution.outcome || payload.brief || project.brief || state.constitution.outcome, 320);
      state.constitution.audience = compact(constitution.audience || state.constitution.audience || project.user_role || '', 180);
      state.constitution.success = compact(constitution.success || state.constitution.success || '', 220);
      state.constitution.constraints = uniqueStrings((state.constitution.constraints || []).concat(constitution.constraints || []), 20);
      state.constitution.non_goals = uniqueStrings((state.constitution.non_goals || []).concat(constitution.non_goals || constitution.nonGoals || []), 12);
      state.constitution.updated_at = nowIso();

      const proposedBranches = Array.isArray(payload.branches) ? payload.branches : (Array.isArray(proposed.branches) ? proposed.branches : []);
      proposedBranches.forEach(function(proposal) {
        const branch = state.branches.find(function(entry) { return entry.id === proposal.id; });
        if (!branch) return;
        branch.summary = compact(proposal.summary || proposal.body || branch.summary, 180);
        if (VALID_BRANCH_STATES.indexOf(proposal.status) !== -1) branch.status = proposal.status;
        branch.confidence = Math.max(branch.confidence || 0, Number(proposal.confidence || 0.55));
        branch.updated_at = nowIso();
      });
      appendDecisionCandidates(project, payload.candidates?.decisions || payload.decisions || [], {
        source: details.source || 'project-brief',
        sourceRef: details.voiceEntryId ? { itemId: details.voiceEntryId } : {}
      });
      state.map_ready_at = state.map_ready_at || nowIso();
      state.last_advanced_at = nowIso();
      recordEvent(project, 'map.seeded', {
        source: details.source || 'project-brief',
        pack_ids: state.pack_ids,
        voice_entry_id: details.voiceEntryId || ''
      }, 'structa');
      return getMapView(project);
    }, details.projectId || details.project_id || '');
  }

  function ingestDecisionCandidates(candidates, meta) {
    const details = meta && typeof meta === 'object' ? meta : {};
    let added = [];
    const result = mutateActive(function(project) {
      added = appendDecisionCandidates(project, candidates, {
        source: details.source || 'structa',
        sourceRef: details.sourceRef || (details.voiceEntryId ? { itemId: details.voiceEntryId } : {}),
        branchId: details.branchId || 'direction',
        why: details.why || ''
      });
      return { ok: true, added: clone(added), count: added.length };
    }, details.projectId || details.project_id || '');
    if (result?.stale) return result;
    return { ok: true, added: clone(added), count: added.length };
  }

  function normalizeObservation(raw, index) {
    if (typeof raw === 'string') {
      return { id: 'obs-' + (index + 1), text: compact(raw, 180), confidence: 0.65 };
    }
    return {
      id: raw?.id || 'obs-' + (index + 1),
      text: compact(raw?.text || raw?.observation || '', 180),
      confidence: Math.max(0, Math.min(1, Number(raw?.confidence || 0.65)))
    };
  }

  function normalizeUncertainty(raw, index, captureId) {
    if (typeof raw === 'string') {
      return {
        id: makeId('unc'),
        capture_id: captureId,
        statement: compact(raw, 180),
        why: 'visual meaning is not fully resolved',
        impact: 'medium',
        status: 'queued',
        branch_id: 'direction',
        kind: 'visual',
        reference_id: '',
        proposed_role: '',
        created_at: nowIso()
      };
    }
    return {
      id: raw?.id || makeId('unc'),
      capture_id: captureId,
      statement: compact(raw?.text || raw?.statement || raw?.question || ('uncertainty ' + (index + 1)), 180),
      why: compact(raw?.why || raw?.reason || 'visual meaning is not fully resolved', 160),
      impact: ['low', 'medium', 'high'].indexOf(raw?.impact) !== -1 ? raw.impact : 'medium',
      status: 'queued',
      branch_id: raw?.branch_id || raw?.branchId || 'direction',
      kind: compact(raw?.kind || 'visual', 40),
      reference_id: compact(raw?.reference_id || raw?.referenceId || '', 80),
      proposed_role: compact(raw?.proposed_role || raw?.proposedRole || '', 40),
      related_ids: uniqueStrings(raw?.related_ids || raw?.relatedIds || [], 8),
      created_at: nowIso()
    };
  }

  function truthRoleFor(projectRole) {
    if (projectRole === 'existing_condition') return 'project_evidence';
    if (projectRole === 'working_artifact') return 'proposal';
    if (projectRole === 'external_reference') return 'attribute_source';
    return 'unclassified';
  }

  function inferCorrectedProjectRole(value) {
    const text = lower(value);
    if (/\b(existing|current|as[- ]?is|site condition|on site|this room|this building|field condition)\b/.test(text)) return 'existing_condition';
    if (/\b(working artifact|our (?:sketch|diagram|draft|proposal|concept|wireframe|design)|my (?:sketch|diagram|draft|proposal|concept|wireframe|design)|sketch|diagram|draft|proposal|wireframe)\b/.test(text)) return 'working_artifact';
    if (/\b(reference|inspiration|precedent|example|competitor|moodboard|found image)\b/.test(text)) return 'external_reference';
    return '';
  }

  function applyReferenceRole(project, uncertainty, projectRole, correction) {
    const state = project.structa_v3;
    const reference = state.references.find(function(item) {
      return (uncertainty.reference_id && item.id === uncertainty.reference_id)
        || (uncertainty.capture_id && item.capture_id === uncertainty.capture_id);
    });
    if (!reference || ['existing_condition', 'working_artifact', 'external_reference'].indexOf(projectRole) === -1) return null;
    reference.kind = projectRole;
    reference.project_role = projectRole;
    reference.role_confidence = 1;
    reference.role_confirmed_by = 'human';
    reference.role_confirmed_at = nowIso();
    reference.role_note = compact(correction || '', 220);
    reference.truth_role = truthRoleFor(projectRole);
    reference.evidence_status = projectRole === 'existing_condition' && reference.status === 'observed'
      ? 'eligible'
      : 'withheld';
    state.branches.forEach(function(branch) {
      if (branch.reference_ids.indexOf(reference.id) === -1) return;
      const evidenceIndex = branch.evidence_ids.indexOf(reference.id);
      if (reference.evidence_status === 'eligible' && evidenceIndex === -1) branch.evidence_ids.push(reference.id);
      if (reference.evidence_status !== 'eligible' && evidenceIndex >= 0) branch.evidence_ids.splice(evidenceIndex, 1);
      branch.updated_at = nowIso();
    });
    return reference;
  }

  function ingestVisualEnvelope(captureId, envelope, meta) {
    const visual = envelope && typeof envelope === 'object' ? envelope : {};
    const details = meta && typeof meta === 'object' ? meta : {};
    return mutateActive(function(project) {
      const state = project.structa_v3;
      const semanticKinds = ['existing_condition', 'working_artifact', 'external_reference'];
      const requestedRole = compact(visual.project_role || visual.semantic_kind || '', 40);
      const roleUnknown = semanticKinds.indexOf(requestedRole) === -1;
      const kind = roleUnknown ? 'external_reference' : requestedRole;
      const observations = (visual.observations || []).map(normalizeObservation).filter(function(item) { return !!item.text; }).slice(0, 8);
      const interpretations = (visual.interpretations || []).slice(0, 8).map(function(item, index) {
        if (typeof item === 'string') return { id: 'int-' + (index + 1), text: compact(item, 180), confidence: 0.6, observation_ids: [] };
        return {
          id: item?.id || 'int-' + (index + 1),
          text: compact(item?.text || item?.interpretation || '', 180),
          confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0.6))),
          observation_ids: uniqueStrings(item?.observation_ids || [], 8)
        };
      }).filter(function(item) { return !!item.text; });
      const implicationRows = Array.isArray(visual.relevance) ? visual.relevance : (Array.isArray(visual.implications) ? visual.implications : []);
      const relevance = implicationRows.slice(0, 6).map(function(item) {
        if (typeof item === 'string') return { branch_id: 'direction', text: compact(item, 180), confidence: 0.6 };
        const implicationKind = item?.kind || '';
        return {
          branch_id: item?.branch_id || item?.branchId || (implicationKind === 'risk' ? 'constraints' : (implicationKind === 'research' ? 'validation' : 'direction')),
          text: compact(item?.text || item?.implication || item?.rationale || '', 180),
          confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0.6))),
          kind: implicationKind,
          requires_user_approval: item?.requires_user_approval === true
        };
      }).filter(function(item) { return !!item.text; });
      const observationConfidence = observations.length
        ? observations.reduce(function(total, item) { return total + item.confidence; }, 0) / observations.length
        : 0;
      const roleConfidenceInput = visual.project_role_confidence !== undefined
        ? visual.project_role_confidence
        : visual.classification_confidence;
      const roleConfidence = Math.max(0, Math.min(1, Number(roleConfidenceInput || 0)));
      const evidenceEligible = !roleUnknown
        && kind === 'existing_condition'
        && visual.status !== 'insufficient'
        && roleConfidence >= 0.7;
      const reference = {
        id: visual.vision_id || makeId('ref'),
        capture_id: captureId || details.captureId || '',
        kind: kind,
        project_role: roleUnknown ? 'unknown' : kind,
        capture_class: visual.capture_kind || 'unknown',
        truth_role: roleUnknown ? 'unclassified' : truthRoleFor(kind),
        evidence_status: evidenceEligible ? 'eligible' : 'withheld',
        source: details.source || 'rabbit-vision',
        source_rights: details.sourceRights || 'unknown',
        observations: observations,
        interpretations: interpretations,
        ocr: (visual.ocr || []).slice(0, 12).map(function(item) {
          if (typeof item === 'string') return { text: compact(item, 180), confidence: 0.65 };
          return {
            text: compact(item?.text || '', 180),
            confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0.65)))
          };
        }).filter(function(item) { return !!item.text; }),
        relevance: relevance,
        confidence: roleConfidence,
        role_confidence: roleConfidence,
        observation_confidence: observationConfidence,
        status: visual.status === 'insufficient' ? 'insufficient' : 'observed',
        created_at: nowIso()
      };
      const previousIndex = state.references.findIndex(function(item) {
        return item.capture_id && item.capture_id === reference.capture_id;
      });
      if (previousIndex >= 0) state.references.splice(previousIndex, 1, reference);
      else state.references.push(reference);
      if (state.references.length > MAX_REFERENCES) state.references.splice(0, state.references.length - MAX_REFERENCES);

      const uncertainties = (visual.uncertainties || []).map(function(item, index) {
        return normalizeUncertainty(item, index, reference.capture_id);
      });
      if (roleUnknown || reference.role_confidence < 0.7) {
        const existingRoleQuestion = uncertainties.find(function(item) {
          return /\b(reference|inspiration|existing|condition|artifact|sketch|proposal|belongs)\b/.test(lower(item.statement));
        });
        if (existingRoleQuestion) {
          existingRoleQuestion.kind = 'project_role';
          existingRoleQuestion.reference_id = reference.id;
          existingRoleQuestion.proposed_role = kind;
          existingRoleQuestion.why = 'capture type changes how the image may support the project';
          existingRoleQuestion.branch_id = kind === 'existing_condition' ? 'constraints' : 'direction';
        } else {
          uncertainties.unshift(normalizeUncertainty({
            text: roleUnknown
              ? 'treat this as external reference unless corrected'
              : 'confirm whether this is ' + kind.replace(/_/g, ' '),
            why: 'capture type changes how the image may support the project',
            impact: 'medium',
            branch_id: kind === 'existing_condition' ? 'constraints' : 'direction',
            kind: 'project_role',
            reference_id: reference.id,
            proposed_role: kind
          }, 0, reference.capture_id));
        }
      }
      if (reference.status === 'insufficient' && !uncertainties.length) {
        uncertainties.unshift(normalizeUncertainty({
          text: 'this capture could not be read reliably',
          why: 'the original remains available, but it must not guide a decision yet',
          impact: 'medium',
          branch_id: kind === 'existing_condition' ? 'constraints' : 'direction'
        }, 0, reference.capture_id));
      }
      uncertainties.forEach(function(item) {
        const duplicate = state.uncertainties.some(function(existing) {
          return existing.status === 'queued' && existing.capture_id === item.capture_id && lower(existing.statement) === lower(item.statement);
        });
        if (!duplicate) state.uncertainties.push(item);
      });
      if (state.uncertainties.length > MAX_UNCERTAINTIES) {
        state.uncertainties.splice(0, state.uncertainties.length - MAX_UNCERTAINTIES);
      }

      const linkedBranchIds = uniqueStrings(relevance.map(function(item) { return item.branch_id; }), 6);
      if (!linkedBranchIds.length) linkedBranchIds.push(kind === 'existing_condition' ? 'constraints' : 'direction');
      linkedBranchIds.forEach(function(branchId) {
        const branch = state.branches.find(function(item) { return item.id === branchId; });
        if (!branch) return;
        if (reference.id && branch.reference_ids.indexOf(reference.id) === -1) branch.reference_ids.push(reference.id);
        if (reference.evidence_status === 'eligible' && reference.id && branch.evidence_ids.indexOf(reference.id) === -1) {
          branch.evidence_ids.push(reference.id);
        }
        if (!branch.summary && relevance[0]?.text) branch.summary = relevance[0].text;
        branch.updated_at = nowIso();
      });
      state.last_advanced_at = nowIso();
      recordEvent(project, 'visual.observed', {
        reference_id: reference.id,
        capture_id: reference.capture_id,
        kind: kind,
        truth_role: reference.truth_role,
        evidence_status: reference.evidence_status,
        observation_count: observations.length,
        uncertainty_count: uncertainties.length
      }, 'structa');
      return reference;
    }, details.projectId || details.project_id || '');
  }

  function reviewUncertainty(id, action, correction) {
    const allowed = ['confirm', 'correct', 'dismiss'];
    if (allowed.indexOf(action) === -1) return { ok: false, error: 'invalid review action' };
    if (action === 'correct' && !compact(correction || '', 220)) {
      return { ok: false, error: 'correction required' };
    }
    let result = { ok: false, error: 'uncertainty not found' };
    mutateActive(function(project) {
      const item = project.structa_v3.uncertainties.find(function(entry) { return entry.id === id; });
      if (!item) return project;
      let roleResolution = null;
      if (item.kind === 'project_role') {
        const role = action === 'confirm'
          ? item.proposed_role
          : (action === 'correct' ? inferCorrectedProjectRole(correction) : '');
        if (action === 'correct' && !role) {
          result = {
            ok: false,
            error: 'say existing condition, working artifact, or external reference',
            code: 'project-role-correction-required'
          };
          return project;
        }
        if (role) roleResolution = applyReferenceRole(project, item, role, correction || 'confirmed');
      }
      item.status = action === 'confirm' ? 'confirmed' : (action === 'correct' ? 'corrected' : 'dismissed');
      item.reviewed_at = nowIso();
      if (action === 'correct') item.correction = compact(correction || '', 220);
      item.reviewed_by = 'human';
      recordEvent(project, 'uncertainty.' + item.status, {
        uncertainty_id: item.id,
        capture_id: item.capture_id || '',
        correction: item.correction || '',
        project_role: roleResolution?.project_role || ''
      }, 'human');
      const remaining = queuedUncertainties(project);
      project.structa_v3.review_requested = remaining.length > 0 && project.structa_v3.review_requested;
      result = { ok: true, item: clone(item), reference: clone(roleResolution), remaining: remaining.length };
      return project;
    });
    return result;
  }

  function requestUncertaintyReview() {
    return mutateActive(function(project) {
      project.structa_v3.review_requested = queuedUncertainties(project).length > 0;
      recordEvent(project, 'uncertainty.review_requested', {
        count: queuedUncertainties(project).length
      }, 'human');
      return { ok: true, count: queuedUncertainties(project).length };
    });
  }

  function decisionIdOf(decision, index) {
    if (!decision || typeof decision === 'string') return 'decision-' + index;
    return decision.id || decision.node_id || 'decision-' + index;
  }

  function approveDecision(decisionId, selectedOptionIndex, selectedOption) {
    const native = window.StructaNative;
    const project = native?.getProjectMemory?.();
    const pending = pendingDecisionList(project);
    const index = pending.findIndex(function(decision, candidateIndex) {
      return decisionIdOf(decision, candidateIndex) === decisionId;
    });
    if (index < 0) return { ok: false, error: 'decision not found or already resolved' };
    const decision = pending[index];
    const options = Array.isArray(decision?.options) ? decision.options : [];
    const optionIndex = Number.isInteger(selectedOptionIndex) ? selectedOptionIndex : 0;
    const option = String(selectedOption || options[optionIndex] || '').trim();
    const result = native?.approvePendingDecisionById
      ? native.approvePendingDecisionById(decisionId, optionIndex, option)
      : native?.approvePendingDecision?.(index, optionIndex, option);
    if (!result || result.ok === false) {
      return result || { ok: false, error: 'decision could not be resolved' };
    }
    native?.touchProjectMemory?.(function(active) {
      ensure(active);
      recordEvent(active, 'decision.approved', {
        decision_id: decisionId,
        selected_option: option,
        selected_option_index: optionIndex
      }, 'human');
    });
    return { ok: true, decision_id: decisionId, selected_option: option };
  }

  function dismissDecision(decisionId) {
    const native = window.StructaNative;
    const project = native?.getProjectMemory?.();
    const pending = pendingDecisionList(project);
    const index = pending.findIndex(function(decision, candidateIndex) {
      return decisionIdOf(decision, candidateIndex) === decisionId;
    });
    if (index < 0) return { ok: false, error: 'decision not found or already resolved' };
    const result = native?.dismissPendingDecisionById
      ? native.dismissPendingDecisionById(decisionId)
      : native?.dismissPendingDecision?.(index);
    if (!result || result.ok === false) {
      return result || { ok: false, error: 'decision could not be dismissed' };
    }
    native?.touchProjectMemory?.(function(active) {
      ensure(active);
      recordEvent(active, 'decision.dismissed', { decision_id: decisionId }, 'human');
    });
    return { ok: true, decision_id: decisionId };
  }

  function reopenDecision(decisionId, reason) {
    const native = window.StructaNative;
    if (!native?.reopenDecisionById) return { ok: false, error: 'decision reversal unavailable' };
    const result = native.reopenDecisionById(decisionId, compact(reason || 'Human requested reconsideration', 180));
    if (!result?.ok) return result || { ok: false, error: 'decision could not be reopened' };
    native?.touchProjectMemory?.(function(active) {
      ensure(active);
      recordEvent(active, 'decision.reopened', {
        decision_id: decisionId,
        reason: compact(reason || 'Human requested reconsideration', 180)
      }, 'human');
    });
    return { ok: true, decision_id: decisionId, decision: clone(result.decision) };
  }

  function revertEvent(eventId) {
    let response = { ok: false, error: 'reversible event not found' };
    mutateActive(function(project) {
      const event = project.structa_v3.events.find(function(item) { return item.id === eventId; });
      if (!event || event.type.indexOf('branch.') !== 0 || !event.payload?.before || !event.payload?.after) return project;
      const branch = project.structa_v3.branches.find(function(item) { return item.id === event.payload.branch_id; });
      if (!branch) return project;
      const after = event.payload.after;
      const changedFields = Array.isArray(event.payload.changed_fields) ? event.payload.changed_fields : ['status', 'summary', 'closed_at'];
      const conflicts = changedFields.some(function(field) { return branch[field] !== after[field]; });
      if (conflicts) {
        response = { ok: false, error: 'branch changed after this event', code: 'revert-conflict', event_id: eventId };
        return project;
      }
      const before = event.payload.before;
      changedFields.forEach(function(field) { branch[field] = before[field]; });
      branch.updated_at = nowIso();
      recordEvent(project, 'event.reverted', {
        reverted_event_id: eventId,
        branch_id: branch.id,
        restored: { status: branch.status, summary: branch.summary, closed_at: branch.closed_at }
      }, 'human');
      response = { ok: true, event_id: eventId, branch: clone(branch) };
      return project;
    });
    return response;
  }

  function validateOperation(operation) {
    const op = operation && typeof operation === 'object' ? operation : {};
    if (OPERATION_TYPES.indexOf(op.type) === -1) return { ok: false, error: 'unsupported operation', code: 'operation-type' };
    if (op.type.indexOf('branch.') === 0 && !compact(op.branch_id || '', 64)) {
      return { ok: false, error: 'branch_id required', code: 'operation-shape' };
    }
    if (op.type === 'branch.update' && !compact(op.summary || '', 180) && VALID_BRANCH_STATES.indexOf(op.status) === -1) {
      return { ok: false, error: 'branch update needs summary or status', code: 'operation-shape' };
    }
    if (op.type === 'decision.propose') {
      if (!compact(op.text || op.body || '', 180)) return { ok: false, error: 'decision text required', code: 'operation-shape' };
      if (uniqueStrings(op.options || [], 4).length < 2) {
        return { ok: false, error: 'a decision needs at least two real options', code: 'decision-options' };
      }
    }
    if ((op.type === 'decision.approve' || op.type === 'decision.dismiss' || op.type === 'decision.reopen') && !compact(op.decision_id || op.id || '', 80)) {
      return { ok: false, error: 'decision_id required', code: 'operation-shape' };
    }
    if (op.type === 'event.revert' && !compact(op.event_id || op.id || '', 80)) {
      return { ok: false, error: 'event_id required', code: 'operation-shape' };
    }
    if (op.type === 'uncertainty.queue' && !compact(op.text || op.statement || op.question || '', 180)) {
      return { ok: false, error: 'uncertainty statement required', code: 'operation-shape' };
    }
    return { ok: true, operation: clone(op) };
  }

  function applyOperation(operation) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const validation = validateOperation(op);
    if (!validation.ok) return validation;
    const actor = op.actor === 'human' ? 'human' : 'structa';
    const activeProjectId = projectIdOf(window.StructaNative?.getProjectMemory?.());
    if (op.project_id && String(op.project_id) !== activeProjectId) {
      return { ok: false, stale: true, error: 'operation belongs to another project' };
    }
    const currentRevision = Number(window.StructaNative?.getProjectMemory?.()?.structa_v3?.revision || 0);
    if (op.expected_revision !== undefined && op.expected_revision !== null && op.expected_revision !== '' && Number.isFinite(Number(op.expected_revision)) && Number(op.expected_revision) !== currentRevision) {
      return { ok: false, stale: true, code: 'revision-conflict', expected_revision: Number(op.expected_revision), current_revision: currentRevision };
    }
    if (op.type === 'decision.approve' && actor !== 'human') {
      return { ok: false, error: 'human approval required', code: 'human-gate' };
    }
    if (op.type === 'decision.approve') {
      return approveDecision(op.decision_id || op.id, op.selected_option_index, op.selected_option);
    }
    if (op.type === 'decision.dismiss') {
      if (actor !== 'human') return { ok: false, error: 'human action required', code: 'human-gate' };
      return dismissDecision(op.decision_id || op.id);
    }
    if (op.type === 'decision.reopen') {
      if (actor !== 'human') return { ok: false, error: 'human action required', code: 'human-gate' };
      return reopenDecision(op.decision_id || op.id, op.reason || '');
    }
    if (op.type === 'event.revert') {
      if (actor !== 'human') return { ok: false, error: 'human action required', code: 'human-gate' };
      return revertEvent(op.event_id || op.id);
    }
    let response = { ok: false, error: 'unsupported operation' };
    mutateActive(function(project) {
      const state = project.structa_v3;
      if (op.type === 'branch.update' || op.type === 'branch.open' || op.type === 'branch.close') {
        const branch = state.branches.find(function(item) { return item.id === op.branch_id; });
        if (!branch) {
          response = { ok: false, error: 'branch not found', code: 'branch-not-found', branch_id: op.branch_id };
          return project;
        }
        const intendsClose = op.type === 'branch.close' || op.status === 'closed';
        if (intendsClose && actor !== 'human' && (branch.completeness < 80 || branch.question_ids.length > 0 || branch.blocker_count > 0)) {
          response = { ok: false, error: 'branch closure gate is not satisfied', code: 'closure-gate', branch_id: branch.id };
          return project;
        }
        const before = clone(branch);
        const changedFields = [];
        if (intendsClose) {
          branch.status = 'closed';
          branch.closed_at = nowIso();
          changedFields.push('status', 'closed_at');
        } else {
          branch.status = op.type === 'branch.open' ? 'open' : (VALID_BRANCH_STATES.indexOf(op.status) !== -1 ? op.status : branch.status);
          branch.closed_at = null;
          if (op.type === 'branch.open' || op.status) changedFields.push('status');
          if (before.closed_at !== branch.closed_at) changedFields.push('closed_at');
        }
        if (op.summary) {
          branch.summary = compact(op.summary, 180);
          changedFields.push('summary');
        }
        branch.updated_at = nowIso();
        recordEvent(project, op.type, {
          branch_id: branch.id,
          changed_fields: uniqueStrings(changedFields, 4),
          before: before,
          after: clone(branch)
        }, actor);
        response = { ok: true, branch: clone(branch) };
      } else if (op.type === 'uncertainty.queue') {
        const item = normalizeUncertainty(op, 0, op.capture_id || '');
        state.uncertainties.push(item);
        recordEvent(project, op.type, { uncertainty_id: item.id }, actor);
        response = { ok: true, uncertainty: clone(item) };
      } else if (op.type === 'decision.propose') {
        project.pending_decisions = pendingDecisionList(project);
        const decision = {
          id: op.id || makeId('decision'),
          text: compact(op.text || op.body || '', 180),
          why: compact(op.why || op.rationale || '', 160),
          options: uniqueStrings(op.options || [], 4),
          recommended: compact(op.recommended || '', 80),
          branch_id: op.branch_id || 'direction',
          confidence: op.confidence || 'med',
          source: 'project-engine',
          created_at: nowIso()
        };
        if (decision.text) project.pending_decisions.unshift(decision);
        recordEvent(project, op.type, { decision_id: decision.id, branch_id: decision.branch_id }, actor);
        response = { ok: !!decision.text, decision: clone(decision) };
      }
      return project;
    });
    return response;
  }

  function exportMarkdown(project, exportMeta) {
    const map = getMapView(project);
    const state = project.structa_v3;
    const exportedAt = exportMeta?.exported_at || nowIso();
    const exportVersion = exportMeta?.version || (state.exports.length + 1);
    const lines = [
      '# ' + map.title,
      '',
      '> STRUCTA project context · v' + exportVersion + ' · ' + exportedAt,
      '',
      '## Outcome',
      '',
      state.constitution.outcome || project.brief || 'Not yet defined.',
      '',
      '## Audience and stakeholders',
      '',
      state.constitution.audience || 'Not yet defined.',
      project.user_role ? ('\nProject owner / role: ' + project.user_role) : '',
      '',
      '## Success',
      '',
      state.constitution.success || 'Validation criteria remain open.',
      '',
      '## Project map',
      ''
    ];
    state.branches.forEach(function(branch) {
      lines.push('### ' + branch.title + ' · ' + branch.status + ' · ' + branch.completeness + '%');
      lines.push('');
      lines.push(branch.summary || branch.driving_question || 'Open.');
      lines.push('');
    });

    lines.push('## Evidence, claims, and hypotheses');
    lines.push('');
    const claims = Array.isArray(project.claims) ? project.claims.filter(function(claim) {
      return claim && claim.status !== 'archived';
    }) : [];
    if (claims.length) claims.forEach(function(claim) {
      const status = compact(claim.truth_status || claim.status || claim.kind || 'unverified', 28);
      const source = compact(claim.source || claim.provenance?.source || 'source not recorded', 80);
      lines.push('- **' + status + '** — ' + compact(claim.text || claim.body || claim.title || '', 240) + ' _(source: ' + source + ')_');
    });
    else lines.push('- No explicit claims recorded.');
    lines.push('');

    lines.push('## Constraints');
    lines.push('');
    if (state.constitution.constraints.length) state.constitution.constraints.forEach(function(item) { lines.push('- ' + item); });
    else lines.push('- No explicit constraints recorded.');
    lines.push('');
    lines.push('## Human-approved decisions');
    lines.push('');
    if ((project.decisions || []).length) {
      project.decisions.forEach(function(decision) {
        const text = typeof decision === 'string' ? decision : (decision.selected_option || decision.title || decision.text || decision.body || 'decision');
        lines.push('- ' + compact(text, 240));
      });
    } else lines.push('- No decisions approved yet.');
    lines.push('');
    lines.push('## Decisions awaiting approval');
    lines.push('');
    if (pendingDecisionList(project).length) pendingDecisionList(project).forEach(function(decision) {
      lines.push('- ' + compact(typeof decision === 'string' ? decision : (decision.text || decision.title || decision.body || ''), 240));
    });
    else lines.push('- None.');
    lines.push('');
    lines.push('## Open questions');
    lines.push('');
    if (openQuestionList(project).length) openQuestionList(project).forEach(function(question) {
      lines.push('- ' + compact(question.body || question.title || question, 240));
    });
    else lines.push('- None.');
    lines.push('');
    lines.push('## Visual references and field captures');
    lines.push('');
    if (state.references.length) state.references.forEach(function(reference) {
      const observation = reference.observations?.[0]?.text || 'capture stored';
      lines.push('- **' + String(reference.kind || 'reference').replace(/_/g, ' ') + '** · ' + String(reference.truth_role || 'reference').replace(/_/g, ' ') + ' — ' + compact(observation, 220) + ' _(source: ' + compact(reference.source || 'unknown', 60) + ')_');
    });
    else lines.push('- None.');
    lines.push('');
    lines.push('## Uncertainty review');
    lines.push('');
    const queued = queuedUncertainties(project);
    if (queued.length) queued.forEach(function(item) { lines.push('- [ ] ' + item.statement); });
    else lines.push('- No unresolved visual uncertainties.');
    lines.push('');
    lines.push('## Next actions and validation');
    lines.push('');
    const tasks = Array.isArray(project.backlog) ? project.backlog : [];
    if (tasks.length) tasks.forEach(function(task) {
      lines.push('- [ ] ' + compact(typeof task === 'string' ? task : (task.title || task.body || ''), 240));
    });
    else lines.push('- No delivery actions recorded yet.');
    lines.push('');
    lines.push('## Next move');
    lines.push('');
    const next = getNowView(project);
    lines.push(next.text || 'Choose the next delivery move.');
    lines.push('');
    lines.push('## Instructions for the next agent or collaborator');
    lines.push('');
    lines.push('- Preserve the outcome, original user statements, evidence provenance, and human-approved decisions.');
    lines.push('- Treat AI observations and unsourced research as inference until verified.');
    lines.push('- Ask before making consequential decisions; reversible structure may advance automatically.');
    lines.push('- Continue from the open questions and next move without asking the user to restate this project.');
    return lines.join('\n');
  }

  function createExport(format) {
    const project = clone(window.StructaNative?.getProjectMemory?.() || {});
    reconcile(project);
    const exportMeta = {
      id: makeId('export'),
      version: (project.structa_v3.exports?.length || 0) + 1,
      format: format === 'json' ? 'json' : 'markdown',
      exported_at: nowIso()
    };
    const slug = lower(project.name || 'structa-project').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'structa-project';
    const json = JSON.stringify({
      schema: SCHEMA,
      export: exportMeta,
      project: project,
      map: getMapView(project),
      now: getNowView(project)
    }, null, 2);
    const markdown = exportMarkdown(project, exportMeta);
    mutateActive(function(active) {
      active.structa_v3.last_exported_at = exportMeta.exported_at;
      active.structa_v3.exports.push(clone(exportMeta));
      if (active.structa_v3.exports.length > 50) active.structa_v3.exports.splice(0, active.structa_v3.exports.length - 50);
      recordEvent(active, 'project.exported', clone(exportMeta), 'human');
      return active;
    });
    return {
      ok: true,
      id: exportMeta.id,
      version: exportMeta.version,
      exported_at: exportMeta.exported_at,
      filename: slug + '-v' + exportMeta.version + (format === 'json' ? '.structa.json' : '.md'),
      mime: format === 'json' ? 'application/json' : 'text/markdown',
      content: format === 'json' ? json : markdown,
      markdown: markdown,
      json: json
    };
  }

  function downloadExport(format) {
    const artifact = createExport(format);
    try {
      const blob = new Blob([artifact.content], { type: artifact.mime + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.filename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      return artifact;
    } catch (error) {
      return Object.assign(artifact, { ok: false, error: error?.message || 'download unavailable' });
    }
  }

  function initializeActiveProject() {
    const native = window.StructaNative;
    if (!native?.touchProjectMemory) return;
    native.touchProjectMemory(function(project) {
      const wasMissing = !project.structa_v3;
      ensure(project);
      appendDecisionCandidates(project, project.derived_candidates?.decisions || [], {
        source: 'candidate-migration'
      });
      reconcile(project);
      if (wasMissing) recordEvent(project, 'v3.initialized', { pack_ids: project.structa_v3.pack_ids }, 'system');
    });
  }

  window.StructaProjectEngine = Object.freeze({
    schema: SCHEMA,
    ensure: ensure,
    reconcile: reconcile,
    getMapView: getMapView,
    getNowView: getNowView,
    seedFromBrief: seedFromBrief,
    ingestDecisionCandidates: ingestDecisionCandidates,
    ingestVisualEnvelope: ingestVisualEnvelope,
    reviewUncertainty: reviewUncertainty,
    requestUncertaintyReview: requestUncertaintyReview,
    validateOperation: validateOperation,
    approveDecision: approveDecision,
    dismissDecision: dismissDecision,
    reopenDecision: reopenDecision,
    revertEvent: revertEvent,
    applyOperation: applyOperation,
    createExport: createExport,
    downloadExport: downloadExport,
    initialize: initializeActiveProject
  });

  setTimeout(initializeActiveProject, 0);
})();
