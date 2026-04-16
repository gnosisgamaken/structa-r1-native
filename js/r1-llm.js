/**
 * r1-llm.js -- Structa LLM client via R1 native bridge.
 *
 * Uses PluginMessageHandler.postMessage() to send messages to the R1's
 * on-device LLM. Responses come back via window.onPluginMessage().
 *
 * Changes (2026-04-13):
 * - processVoice() now injects project context + conversation history
 * - conversationHistory[] is populated on every exchange
 * - sendToLLM() supports imageBase64 for camera analysis
 * - extractFields() now pulls out decision text
 * - storeAsInsight() auto-creates pending_decisions from LLM decisions
 * - Removed noisy debug logging (thinking..., r1 msg...)
 */
(function() {
  var native = window.StructaNative;
  var requestQueue = [];
  var activeRequest = null;
  var requestId = 0;
  var conversationHistory = [];
  var MAX_HISTORY = 10;
  var lastCallTime = 0;
  var MIN_GAP_MS = 800;
  var dispatchTimer = null;

  function getNextId() {
    requestId++;
    return 'structa-' + Date.now() + '-' + requestId;
  }

  /**
   * sendToLLM -- core function.
   * Sends a message to the R1's on-device LLM via PluginMessageHandler.
   * Returns a promise that resolves with { ok, text, clean, structured }.
   * Supports optional imageBase64 for multimodal queries.
   */
  function sendToLLM(message, options) {
    var opts = options || {};
    var id = getNextId();

    return new Promise(function(resolve) {
      var request = {
        id: id,
        message: message,
        opts: opts,
        resolve: resolve
      };

      if (opts.priority === 'low') {
        requestQueue.push(request);
      } else {
        var firstLowIndex = requestQueue.findIndex(function(entry) { return entry.opts && entry.opts.priority === 'low'; });
        if (firstLowIndex === -1) requestQueue.push(request);
        else requestQueue.splice(firstLowIndex, 0, request);
      }

      processQueue();
    });
  }

  function processQueue() {
    if (activeRequest || !requestQueue.length || dispatchTimer) return;

    var now = Date.now();
    var elapsed = now - lastCallTime;
    var delay = elapsed < MIN_GAP_MS ? MIN_GAP_MS - elapsed : 0;

    dispatchTimer = setTimeout(function() {
      dispatchTimer = null;
      if (activeRequest || !requestQueue.length) return;

      var request = requestQueue.shift();
      if (!request) return;

      lastCallTime = Date.now();
      activeRequest = request;
      activeRequest.timeout = setTimeout(function() {
        if (!activeRequest || activeRequest.id !== request.id) return;
        var timedOut = activeRequest;
        activeRequest = null;
        timedOut.resolve({ ok: false, error: 'timeout' });
        processQueue();
      }, request.opts.timeout || 30000);

      var payload = {
        message: request.message,
        useLLM: true,
        wantsR1Response: request.opts.speak || false,
        wantsJournalEntry: request.opts.journal || false
      };

      if (request.opts.imageBase64) payload.imageBase64 = request.opts.imageBase64;
      if (request.opts.pluginId) payload.pluginId = request.opts.pluginId;

      if (typeof PluginMessageHandler !== 'undefined') {
        try {
          PluginMessageHandler.postMessage(JSON.stringify(payload));
        } catch (err) {
          clearTimeout(activeRequest.timeout);
          activeRequest = null;
          request.resolve({ ok: false, error: 'postMessage failed: ' + err.message });
          processQueue();
        }
      } else {
        clearTimeout(activeRequest.timeout);
        activeRequest = null;
        request.resolve({ ok: false, error: 'PluginMessageHandler not available' });
        processQueue();
      }
    }, delay);
  }

  // === Response handler ===
  var previousHandler = window.onPluginMessage;

  window.onPluginMessage = function(data) {
    // STT handling — match exact R1 format: { type: 'sttEnded', transcript: '...' }
    if (data && data.type === 'sttEnded' && data.transcript) {
      if (previousHandler) {
        try { previousHandler(data); } catch (e) {}
      }
      window.dispatchEvent(new CustomEvent('structa-stt-ended', {
        detail: { transcript: data.transcript }
      }));
      return;
    }

    // Try to extract the LLM response text
    var responseText = '';
    if (data) {
      responseText = data.message || data.content || data.response || data.transcript || '';
      if (!responseText && data.data) {
        try {
          var parsed = JSON.parse(data.data);
          responseText = parsed.message || parsed.content || parsed.response || parsed.transcript || '';
        } catch (e) {
          responseText = data.data;
        }
      }
    }

    if (activeRequest && responseText) {
      var cb = activeRequest;
      if (cb) {
        clearTimeout(cb.timeout);
        activeRequest = null;
        if (native && native.probeMode && native.appendProbeEvent) {
          native.appendProbeEvent({
            source: 'bridge-in',
            name: ('onPluginMessage ' + String(responseText).slice(0, 60)).replace(/\s+/g, ' ').trim()
          });
        }
        var clean = sanitizeResponse(responseText);
        cb.resolve({
          ok: true,
          text: responseText,
          clean: clean,
          structured: extractFields(clean)
        });
        processQueue();
        return;
      }
    }

    // Pass to previous handler if any
    if (previousHandler) {
      try { previousHandler(data); } catch (e) {}
    }
  };

  // === Sanitization ===
  var DRIFT = [
    /github|repository/gi,
    /can.t access.*web|unable to.*web/gi,
    /dlam|rabbit\.tech/gi,
    /web search|look up online/gi,
    /I can.t help/gi,
    /let'?s calculate(?:\s+what\s+is|\s+what's)?\s+\d+/gi,
    /\bone plus one\b|\btwo plus two\b|\bthree plus three\b/gi
  ];

  function sanitizeResponse(text) {
    if (!text) return '';
    var clean = text.trim();
    var sentences = clean.split(/(?<=[.!?])\s+/);
    var filtered = sentences.filter(function(s) {
      return !DRIFT.some(function(d) { return d.test(s); });
    });
    return filtered.join(' ').trim() || '';
  }

  function extractFields(text) {
    var result = { raw: text, insight: text, next: '', decision: '', conf: 'med' };

    // Extract decision — LLM prefixes decisions with "DECISION:"
    var dMatch = text.match(/(?:^|\s)DECISION:\s*(.{10,120})/i);
    if (dMatch) {
      result.decision = dMatch[1].trim().replace(/^["']|["']$/g, '');
    } else {
      // Also detect decision language
      var dm = text.match(/(?:we (?:decided|agreed|chose|should|will|plan to))[:\s]*(.{10,100})/i);
      if (dm) result.decision = dm[0].trim();
    }

    // Extract next step
    var m = text.match(/(?:next step|suggest|recommend|you should|start by|try)[:\s]*(.{10,100})/i);
    if (m) result.next = m[1].trim();

    if (/definitely|clearly/i.test(text)) result.conf = 'high';
    if (/maybe|perhaps|might/i.test(text)) result.conf = 'low';

    return result;
  }

  // === Context builder ===

  function buildProjectContext(opts) {
    var options = opts || {};
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var parts = [];

    if (project.name && project.name !== 'untitled project') {
      parts.push('Project: ' + project.name);
    }
    if (project.type && project.type !== 'general') {
      parts.push('Type: ' + project.type);
    }
    if (project.user_role) {
      parts.push('Role: ' + project.user_role);
    }

    // Include recent decisions for deep context (image analysis needs this)
    var decisions = project.decisions || [];
    if (decisions.length && options.deep) {
      parts.push('Recent decisions: ' + decisions.slice(0, 3).map(function(d) {
        return (typeof d === 'string' ? d : (d.text || '')).slice(0, 40);
      }).join('; '));
    }

    // Include recent insights for deep context
    var insights = project.insights || [];
    if (insights.length && options.deep) {
      parts.push('Recent insights: ' + insights.slice(0, 3).map(function(ins) {
        return (ins.body || ins.title || '').slice(0, 40);
      }).join('; '));
    }

    var backlog = project.backlog || [];
    if (backlog.length) {
      parts.push('Backlog (' + backlog.length + '): ' + backlog.slice(0, 3).map(function(b) { return b.title; }).join(', '));
      parts.push('Current focus: ' + (backlog[0].title || '').slice(0, 60));
    }
    var questions = project.open_questions || [];
    if (questions.length) {
      parts.push('Open questions (' + questions.length + '): ' + questions.slice(0, 2).map(function(q) {
        return q.length > 40 ? q.slice(0, 40) + '...' : q;
      }).join('; '));
    }
    var pending = project.pending_decisions || [];
    if (pending.length) {
      var pd = typeof pending[0] === 'string' ? pending[0] : pending[0].text;
      parts.push('Pending decision: ' + (pd || '').slice(0, 60));
    }

    // Clarity score
    if (project.clarity_score > 0) {
      parts.push('Clarity: ' + project.clarity_score + '%');
    }

    return parts.join('\n');
  }

  function buildHistoryContext() {
    if (!conversationHistory.length) return '';
    return '\nRecent:\n' + conversationHistory.slice(-4).map(function(h) {
      return (h.role === 'user' ? 'User: ' : 'AI: ') + h.text.slice(0, 60);
    }).join('\n');
  }

  // === Specialized entry points ===

  /**
   * processVoice -- main voice handler.
   * Now injects project context and conversation history for grounded responses.
   * options.answeringQuestion + options.questionText = answer mode (for know card)
   */
  function processVoice(transcript, options) {
    var opts = options || {};
    var context = buildProjectContext({ deep: true });
    var historyCtx = buildHistoryContext();

    var prompt;
    if (opts.answeringQuestion) {
      prompt = 'Context:\n' + (context || 'no project context') + '\n\n' +
        'Question: "' + (opts.questionText || '') + '"\n' +
        'Answer: "' + transcript + '"\n\n' +
        'Extract the answer in 5 words max. No preamble.';
    } else {
      prompt = '🚫 DO NOT SEARCH. DO NOT SAVE NOTES. DO NOT CREATE REMINDERS.\n';
      if (context) prompt += 'Context:\n' + context + '\n\n';
      if (historyCtx) prompt += historyCtx + '\n\n';
      prompt += 'User said: "' + transcript + '"\n\n' +
        'Respond with:\n' +
        '- Insight: 3 words max about what this means\n' +
        '- Next: 1 suggested action (5 words max)\n' +
        '- If this is a decision, prefix with DECISION:';
    }

    // Track in conversation history
    conversationHistory.push({ role: 'user', text: transcript, time: Date.now() });
    if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();

    return sendToLLM(prompt, { speak: false, journal: false }).then(function(result) {
      // Track LLM response in history
      if (result && result.ok && result.clean) {
        conversationHistory.push({ role: 'bot', text: result.clean, time: Date.now() });
        if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
      }
      return result;
    });
  }

  /**
   * processImage -- sends image to R1 LLM with FULL project context.
   * Project type fundamentally changes how to interpret an image:
   * - Architecture: materials, spatial relationships, structure
   * - Software: UI patterns, error states, code
   * - Design: composition, color, typography
   * - Film: framing, lighting, narrative
   * Returns a promise with { ok, clean, structured }.
   */
  function processImage(rawBase64, description, meta) {
    var context = buildProjectContext({ deep: true });
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var projectType = project.type || 'general';
    var vocab = window.StructaContracts && window.StructaContracts.getVocabulary
      ? window.StructaContracts.getVocabulary(projectType) : {};

    var voiceAnnotation = meta && meta.voiceAnnotation ? meta.voiceAnnotation : '';

    var prompt = '🚫 DO NOT SEARCH. DO NOT SAVE NOTES.\n';
    if (context) prompt += '[PROJECT CONTEXT]\n' + context + '\n\n';

    if (voiceAnnotation) {
      prompt += '[VOICE ANNOTATION]\n"' + voiceAnnotation + '"\n\n';
      prompt += '[IMAGE]\n' + (description || 'camera capture') + '\n';
      prompt += 'Camera: ' + (meta && meta.facingMode || 'environment') + '\n\n';
      prompt += 'The user described this image while capturing it. ' +
        'Combine the voice context with what you see. ' +
        'What is the key ' + (vocab.insight || 'insight') + '? 10 words max.';
    } else {
      prompt += '[IMAGE]\n' + (description || 'camera capture') + '\n';
      prompt += 'Camera: ' + (meta && meta.facingMode || 'environment') + '\n\n';

      // Project-type-specific analysis framing
      var analysisFrame = {
        architecture: 'Analyze as architectural documentation. Note materials, spatial relationships, structural elements.',
        software: 'Analyze as software/technical capture. Note UI patterns, error states, data flows.',
        design: 'Analyze as design reference. Note composition, color palette, typography, spatial hierarchy.',
        film: 'Analyze as production reference. Note framing, lighting, mood, narrative potential.',
        music: 'Analyze as studio/performance reference. Note equipment, setup, acoustic context.',
        writing: 'Analyze as research reference. Note subject matter, textual content, context clues.',
        research: 'Analyze as research data. Note observable patterns, measurements, conditions.',
        general: 'What does this tell us about the project?'
      }[projectType] || 'What does this tell us?';

      prompt += analysisFrame + ' 1-2 key elements. 8 words max.';
    }

    return sendToLLM(prompt, { imageBase64: rawBase64, speak: false, journal: false });
  }

  function query(question) {
    var context = buildProjectContext();
    var parts = context ? [context, '', question] : [question];
    return sendToLLM(parts.join('\n'));
  }

  /**
   * storeAsInsight -- stores LLM result as project insight.
   * Auto-extracts decisions and creates pending_decisions.
   */
  function storeAsInsight(result, sourceType) {
    if (!result || !result.ok || !result.clean) return null;
    if (!native) return null;

    var insight = {
      title: (sourceType || 'llm') + ' insight',
      body: result.clean,
      next: result.structured ? result.structured.next : '',
      confidence: result.structured ? result.structured.conf : 'med',
      created_at: new Date().toISOString()
    };

    var decisionText = result.structured && result.structured.decision;
    var createdNode = null;

    if (native.addNode) {
      createdNode = native.addNode({
        type: 'insight',
        status: 'open',
        title: insight.title,
        body: insight.body,
        source: sourceType || 'voice',
        confidence: insight.confidence,
        next_action: insight.next,
        tags: sourceType ? [sourceType] : []
      });

      if (decisionText) {
        var project = native.getProjectMemory ? native.getProjectMemory() : {};
        var pending = project.pending_decisions || [];
        var exists = pending.some(function(d) { return (d.text || d) === decisionText; });
        if (!exists) {
          native.addNode({
            type: 'decision',
            status: 'open',
            title: decisionText,
            body: result.clean,
            source: sourceType || 'voice',
            decision_options: []
          });
        }
      }

      if (createdNode && window.StructaLLM && window.StructaLLM.linkNode) {
        window.StructaLLM.linkNode(createdNode.node_id);
      }
      return createdNode;
    }

    if (native.touchProjectMemory) {
      native.touchProjectMemory(function(project) {
        project.insights = Array.isArray(project.insights) ? project.insights : [];
        project.insights.unshift(insight);
        project.insights = project.insights.slice(0, 16);

        if (decisionText) {
          project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
          var exists = project.pending_decisions.some(function(d) {
            return (d.text || d) === decisionText;
          });
          if (!exists) {
            project.pending_decisions.unshift({
              text: decisionText,
              source: sourceType || 'voice',
              insight_body: result.clean,
              created_at: new Date().toISOString()
            });
            project.pending_decisions = project.pending_decisions.slice(0, 8);
          }
        }
      });
    }

    return insight;
  }

  function resetHistory() { conversationHistory = []; }

  // === Auto-linking ===
  /**
   * linkNode — finds related existing nodes and creates bidirectional links.
   * Called after every new node creation.
   */
  function linkNode(newNodeId) {
    if (!native || !native.getProjectMemory) return Promise.resolve([]);
    var project = native.getProjectMemory();
    var nodes = project.nodes || [];
    var newNode = nodes.find(function(n) { return n.node_id === newNodeId; });
    if (!newNode || nodes.length < 2) return Promise.resolve([]);

    var existing = nodes.filter(function(n) { return n.node_id !== newNodeId && n.status !== 'archived'; }).slice(0, 8);
    if (!existing.length) return Promise.resolve([]);

    var prompt = '🚫 DO NOT SEARCH.\n' +
      'New item: "' + (newNode.title + ' ' + newNode.body).slice(0, 80) + '" (type: ' + newNode.type + ')\n\n' +
      'Existing items:\n' +
      existing.map(function(n, i) { return (i + 1) + '. "' + (n.title + ' ' + n.body).slice(0, 50) + '" (' + n.type + ')'; }).join('\n') +
      '\n\nWhich items (by number) are related? Return ONLY comma-separated numbers, or "none".';

    return sendToLLM(prompt, { speak: false, journal: false, timeout: 15000, priority: 'low' }).then(function(result) {
      if (!result || !result.ok || !result.clean) return [];
      var matches = result.clean.match(/\d+/g);
      if (!matches) return [];
      var linkedIds = [];
      matches.forEach(function(m) {
        var idx = parseInt(m, 10) - 1;
        if (idx >= 0 && idx < existing.length) {
          linkedIds.push(existing[idx].node_id);
        }
      });
      // Create bidirectional links
      if (linkedIds.length && native.touchProjectMemory) {
        native.touchProjectMemory(function(proj) {
          var target = proj.nodes.find(function(n) { return n.node_id === newNodeId; });
          if (!target) return;
          linkedIds.forEach(function(lid) {
            if (!target.links.includes(lid)) target.links.push(lid);
            var other = proj.nodes.find(function(n) { return n.node_id === lid; });
            if (other && !other.links.includes(newNodeId)) other.links.push(newNodeId);
          });
        });
      }
      return linkedIds;
    }).catch(function() { return []; });
  }

  // === SERP Research ===
  /**
   * research — performs web search via R1 SERP API + LLM synthesis.
   * Returns 3 compressed findings.
   */
  function research(query) {
    var context = buildProjectContext({ deep: false });
    var prompt = 'Search the web for: "' + query + '"\n\n' +
      (context ? 'Project context: ' + context.slice(0, 120) + '\n\n' : '') +
      'Return exactly 3 key findings. Each finding: 1 sentence, 10 words max. Number them 1-3.';

    return sendToLLM(prompt, { speak: false, journal: false, timeout: 25000, priority: 'low' }).then(function(result) {
      if (!result || !result.ok) return { ok: false, findings: [] };
      var lines = (result.clean || '').split(/\n/).filter(function(l) { return l.trim(); });
      var findings = lines.slice(0, 3).map(function(l) { return l.replace(/^\d+[\.\)]\s*/, '').trim(); });
      // Store as research node
      if (native && native.addNode && findings.length) {
        native.addNode({
          type: 'research', title: 'research: ' + query.slice(0, 40),
          body: findings.join(' | '), source: 'serp',
          research_findings: findings,
          tags: query.toLowerCase().split(/\s+/).slice(0, 3)
        });
      }
      return { ok: true, query: query, findings: findings, raw: result.clean };
    });
  }

  // === Export generation ===
  /**
   * generateExport — creates a project brief, decision log, or research report.
   * Sends result via email through R1's LLM bridge.
   */
  function generateExport(type) {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var exportType = type || 'brief';

    var prompt;
    if (exportType === 'brief') {
      prompt = 'Create a project brief for "' + (project.name || 'untitled') + '".\n' +
        'Type: ' + (project.type || 'general') + '\n' +
        'Decisions: ' + (project.decisions || []).length + '\n' +
        'Insights: ' + (project.insights || []).length + '\n' +
        'Open questions: ' + (project.open_questions || []).length + '\n\n' +
        'Write a 5-sentence executive summary. Then list top 3 decisions and top 3 open items.';
    } else if (exportType === 'decisions') {
      var decs = (project.decisions || []).slice(0, 10);
      prompt = 'Format these project decisions as a clean decision log:\n' +
        decs.map(function(d, i) {
          return (i + 1) + '. ' + (typeof d === 'string' ? d : (d.text || ''));
        }).join('\n') + '\n\nAdd date headers and status for each.';
    } else {
      var research = (project.nodes || []).filter(function(n) { return n.type === 'research'; });
      prompt = 'Compile research findings for "' + (project.name || 'untitled') + '":\n' +
        research.slice(0, 5).map(function(r) { return '- ' + r.title + ': ' + r.body; }).join('\n') +
        '\n\nSummarize key themes and implications in 3 paragraphs.';
    }

    return sendToLLM(prompt, { speak: false, journal: false }).then(function(result) {
      if (!result || !result.ok) return { ok: false };
      // Send via email through R1
      if (typeof PluginMessageHandler !== 'undefined') {
        try {
          PluginMessageHandler.postMessage(JSON.stringify({
            message: 'email this to me:\n\nStructa ' + exportType + ' — ' + (project.name || 'project') + '\n\n' + result.clean,
            useLLM: true,
            wantsR1Response: true
          }));
        } catch (e) {}
      }
      return { ok: true, type: exportType, content: result.clean };
    });
  }

  window.StructaLLM = Object.freeze({
    sendToLLM: sendToLLM,
    processVoice: processVoice,
    processImage: processImage,
    query: query,
    storeAsInsight: storeAsInsight,
    linkNode: linkNode,
    research: research,
    generateExport: generateExport,
    resetHistory: resetHistory,
    get pendingCount() { return requestQueue.length + (activeRequest ? 1 : 0); },
    get pendingHighPriorityCount() {
      var queued = requestQueue.filter(function(entry) { return !entry.opts || entry.opts.priority !== 'low'; }).length;
      var active = activeRequest && (!activeRequest.opts || activeRequest.opts.priority !== 'low') ? 1 : 0;
      return queued + active;
    },
    get historyLength() { return conversationHistory.length; }
  });
})();
