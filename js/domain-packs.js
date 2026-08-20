/**
 * domain-packs.js — declarative reasoning lenses for Structa V3.
 *
 * Projects always use the universal creative-core map. Packs refine the
 * questions, evidence rules, image lenses, gates, and exports without
 * introducing a second project model or a custom agent per profession.
 */
(() => {
  'use strict';

  const CORE_BRANCHES = Object.freeze([
    {
      id: 'outcome',
      title: 'outcome',
      drivingQuestion: 'what must exist when this project succeeds?',
      closureCondition: 'outcome and success test are explicit'
    },
    {
      id: 'audience',
      title: 'people',
      drivingQuestion: 'who must this work for?',
      closureCondition: 'primary audience and stakeholders are named'
    },
    {
      id: 'direction',
      title: 'direction',
      drivingQuestion: 'which direction best serves the outcome?',
      closureCondition: 'a direction is chosen with reasons'
    },
    {
      id: 'constraints',
      title: 'reality',
      drivingQuestion: 'what limits or enables the project?',
      closureCondition: 'material constraints and dependencies are known'
    },
    {
      id: 'validation',
      title: 'proof',
      drivingQuestion: 'how will we know this works?',
      closureCondition: 'validation method and acceptance criteria exist'
    },
    {
      id: 'delivery',
      title: 'delivery',
      drivingQuestion: 'what has to happen next to make it real?',
      closureCondition: 'next actions, owner, and handoff are clear'
    }
  ]);

  const PACKS = {
    'creative-core': {
      id: 'creative-core',
      version: 1,
      label: 'creative project',
      description: 'universal project framing, evidence, decisions, validation, and delivery',
      branchLenses: {
        outcome: ['intent', 'desired change', 'success'],
        audience: ['audience', 'stakeholders', 'owner'],
        direction: ['concepts', 'alternatives', 'criteria'],
        constraints: ['scope', 'resources', 'dependencies', 'risks'],
        validation: ['tests', 'proof', 'acceptance'],
        delivery: ['tasks', 'sequence', 'handoff']
      },
      gates: [
        { id: 'frame', requires: ['outcome', 'audience'], label: 'frame the project' },
        { id: 'ground', requires: ['evidence', 'constraints'], label: 'ground the project' },
        { id: 'explore', requires: ['options', 'criteria'], label: 'compare directions' },
        { id: 'decide', requires: ['human_approval'], label: 'lock the decision' },
        { id: 'validate', requires: ['test'], label: 'prove the direction' },
        { id: 'deliver', requires: ['next_action', 'handoff'], label: 'move into delivery' }
      ],
      imageLenses: {
        working_artifact: ['structure', 'hierarchy', 'relationships', 'annotations', 'missing connections'],
        existing_condition: ['visible condition', 'layout', 'interfaces', 'constraints', 'uncertainty'],
        external_reference: ['attributes to adapt', 'attributes to avoid', 'comparison value', 'source and rights']
      },
      exportSections: ['project map', 'evidence', 'decisions', 'unknowns', 'next move']
    },

    build: {
      id: 'build',
      version: 1,
      label: 'digital product',
      description: 'vibe coding, software, interactive products, and AI-native builds',
      keywords: ['app', 'website', 'software', 'platform', 'code', 'coding', 'developer', 'api', 'agent', 'saas', 'prototype'],
      branchLenses: {
        outcome: ['user problem', 'desired behavior', 'non-goals'],
        audience: ['primary user', 'job to be done', 'access needs'],
        direction: ['core flow', 'interface model', 'scope boundary'],
        constraints: ['repository', 'stack', 'data', 'integrations', 'security assumptions'],
        validation: ['acceptance criteria', 'prototype test', 'QA', 'rollback'],
        delivery: ['implementation slices', 'backlog', 'deployment', 'agent handoff']
      },
      decisionArchetypes: ['MVP boundary', 'core interaction', 'source of truth', 'technical approach', 'launch gate'],
      imageLenses: {
        working_artifact: ['screen hierarchy', 'components', 'states', 'flow arrows', 'visible labels'],
        existing_condition: ['current-build behavior', 'visible defect', 'state', 'content hierarchy'],
        external_reference: ['interaction principle', 'information hierarchy', 'visual rhythm', 'adapt or avoid']
      },
      exportSections: ['agent context', 'product brief', 'user flows', 'architecture decisions', 'backlog', 'acceptance tests', 'release checklist']
    },

    campaign: {
      id: 'campaign',
      version: 1,
      label: 'communication campaign',
      description: 'advertising, launches, brand communication, and behavior-change campaigns',
      keywords: ['campaign', 'advertising', 'communication', 'brand', 'launch', 'audience', 'message', 'creative', 'content', 'marketing'],
      branchLenses: {
        outcome: ['business objective', 'behavior objective', 'success measure'],
        audience: ['priority audience', 'insight', 'barrier', 'context'],
        direction: ['single-minded proposition', 'proof', 'creative territories', 'tone'],
        constraints: ['brand', 'claims', 'channels', 'budget', 'legal', 'production'],
        validation: ['concept test', 'KPI', 'learning plan'],
        delivery: ['asset matrix', 'owners', 'approvals', 'production sequence']
      },
      decisionArchetypes: ['audience priority', 'core proposition', 'creative territory', 'channel role', 'call to action'],
      imageLenses: {
        working_artifact: ['message hierarchy', 'composition', 'claim prominence', 'brand fit'],
        existing_condition: ['placement', 'context', 'legibility', 'competing signals'],
        external_reference: ['visual codes', 'tone', 'distinctive assets', 'adapt or avoid', 'source and rights']
      },
      exportSections: ['campaign brief', 'message architecture', 'creative territories', 'channel and asset matrix', 'approval log', 'measurement plan']
    },

    space: {
      id: 'space',
      version: 1,
      label: 'spatial project',
      description: 'architecture, renovation, rebuilding, interiors, and physical environments',
      keywords: ['architecture', 'architect', 'renovation', 'rebuild', 'building', 'space', 'room', 'site', 'interior', 'material', 'contractor'],
      branchLenses: {
        outcome: ['use', 'program', 'experience', 'scope'],
        audience: ['occupants', 'client', 'operators', 'neighbors', 'experts'],
        direction: ['zones', 'adjacencies', 'circulation', 'options'],
        constraints: ['existing conditions', 'measurements', 'budget', 'schedule', 'regulation', 'specialists'],
        validation: ['survey', 'expert verification', 'mock-up', 'inspection'],
        delivery: ['phasing', 'procurement', 'RFI list', 'contractor handoff']
      },
      decisionArchetypes: ['scope', 'layout option', 'material system', 'phasing', 'procurement'],
      imageLenses: {
        working_artifact: ['zones', 'adjacencies', 'circulation', 'annotations', 'scale uncertainty'],
        existing_condition: ['visible condition', 'location', 'viewpoint', 'material cues', 'interfaces', 'damage cues'],
        external_reference: ['spatial quality', 'material language', 'detail principle', 'adapt or avoid']
      },
      expertOnly: ['structural safety', 'fire safety', 'electrical safety', 'code compliance', 'exact measurement', 'load bearing'],
      exportSections: ['project brief', 'existing conditions', 'assumptions', 'adjacency requirements', 'option matrix', 'RFI list', 'materials', 'phased work plan']
    }
  };

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function(key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function get(id) {
    return PACKS[id] || PACKS['creative-core'];
  }

  function infer(text) {
    const haystack = String(text || '').toLowerCase();
    const scored = Object.keys(PACKS)
      .filter(function(id) { return id !== 'creative-core'; })
      .map(function(id) {
        const pack = PACKS[id];
        const score = (pack.keywords || []).reduce(function(total, keyword) {
          return total + (haystack.indexOf(keyword) !== -1 ? 1 : 0);
        }, 0);
        return { id: id, score: score };
      })
      .filter(function(entry) { return entry.score > 0; })
      .sort(function(a, b) { return b.score - a.score; });
    return ['creative-core'].concat(scored.slice(0, 2).map(function(entry) { return entry.id; }));
  }

  function compose(ids) {
    const normalized = ['creative-core'].concat(Array.isArray(ids) ? ids : [])
      .filter(function(id, index, list) { return !!PACKS[id] && list.indexOf(id) === index; });
    const lenses = {};
    CORE_BRANCHES.forEach(function(branch) { lenses[branch.id] = []; });
    const imageLenses = {
      working_artifact: [],
      existing_condition: [],
      external_reference: []
    };
    const exportSections = [];
    const expertOnly = [];

    normalized.forEach(function(id) {
      const pack = get(id);
      Object.keys(pack.branchLenses || {}).forEach(function(branchId) {
        lenses[branchId] = (lenses[branchId] || []).concat(pack.branchLenses[branchId] || []);
      });
      Object.keys(pack.imageLenses || {}).forEach(function(kind) {
        imageLenses[kind] = (imageLenses[kind] || []).concat(pack.imageLenses[kind] || []);
      });
      (pack.exportSections || []).forEach(function(section) {
        if (exportSections.indexOf(section) === -1) exportSections.push(section);
      });
      (pack.expertOnly || []).forEach(function(rule) {
        if (expertOnly.indexOf(rule) === -1) expertOnly.push(rule);
      });
    });

    Object.keys(lenses).forEach(function(key) {
      lenses[key] = lenses[key].filter(function(value, index, list) { return list.indexOf(value) === index; });
    });
    Object.keys(imageLenses).forEach(function(key) {
      imageLenses[key] = imageLenses[key].filter(function(value, index, list) { return list.indexOf(value) === index; });
    });

    return {
      ids: normalized,
      branches: CORE_BRANCHES.map(function(branch) {
        return Object.assign({}, branch, { lenses: lenses[branch.id] || [] });
      }),
      imageLenses: imageLenses,
      exportSections: exportSections,
      expertOnly: expertOnly
    };
  }

  deepFreeze(PACKS);

  window.StructaDomainPacks = Object.freeze({
    coreBranches: CORE_BRANCHES,
    packs: PACKS,
    get: get,
    infer: infer,
    compose: compose
  });
})();
