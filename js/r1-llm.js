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
  var pendingCallbacks = {};
  var requestId = 0;
  var conversationHistory = [];
  var MAX_HISTORY = 10;
  var lastCallTime = 0;
  var MIN_GAP_MS = 5000;

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
      // Rate limit
      var now = Date.now();
      var elapsed = now - lastCallTime;
      var delay = elapsed < MIN_GAP_MS ? MIN_GAP_MS - elapsed : 0;

      setTimeout(function() {
        lastCallTime = Date.now();

        // Store callback for when response arrives
        pendingCallbacks[id] = {
          resolve: resolve,
          timeout: setTimeout(function() {
            delete pendingCallbacks[id];
            resolve({ ok: false, error: 'timeout' });
          }, opts.timeout || 30000)
        };

        // Build payload — R1 Create SDK format
        var payload = {
          message: message,
          useLLM: true,
          wantsR1Response: opts.speak || false,
          wantsJournalEntry: opts.journal || false
        };

        // Multimodal: attach raw base64 image
        if (opts.imageBase64) payload.imageBase64 = opts.imageBase64;
        if (opts.pluginId) payload.pluginId = opts.pluginId;

        // Send via native bridge
        if (typeof PluginMessageHandler !== 'undefined') {
          try {
            PluginMessageHandler.postMessage(JSON.stringify(payload));
          } catch (err) {
            delete pendingCallbacks[id];
            resolve({ ok: false, error: 'postMessage failed: ' + err.message });
          }
        } else {
          delete pendingCallbacks[id];
          resolve({ ok: false, error: 'PluginMessageHandler not available' });
        }
      }, delay);
    });
  }

  // === Response handler ===
  var previousHandler = window.onPluginMessage;

  window.onPluginMessage = function(data) {
    // STT handling — match exact R1 format: { type: 'sttEnded', transcript: '...' }
    if (data && data.type === 'sttEnded' && data.transcript) {
      native?.appendLogEntry?.({ kind: 'voice', message: 'stt: ' + data.transcript.slice(0, 60) });
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

    // Route LLM response to the most recent pending callback
    var callbackIds = Object.keys(pendingCallbacks);
    if (callbackIds.length > 0 && responseText) {
      var oldestId = callbackIds[0];
      var cb = pendingCallbacks[oldestId];
      if (cb) {
        clearTimeout(cb.timeout);
        delete pendingCallbacks[oldestId];
        var clean = sanitizeResponse(responseText);
        cb.resolve({
          ok: true,
          text: responseText,
          clean: clean,
          structured: extractFields(clean)
        });
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
    /I can.t help/gi
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

  function buildProjectContext() {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var parts = [];
    if (project.name && project.name !== 'untitled project') {
      parts.push('Project: ' + project.name);
    }
    var backlog = project.backlog || [];
    if (backlog.length) {
      parts.push('Backlog (' + backlog.length + '): ' + backlog.slice(0, 3).map(function(b) { return b.title; }).join(', '));
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
    var context = buildProjectContext();
    var historyCtx = buildHistoryContext();

    var prompt;
    if (opts.answeringQuestion) {
      // Answering a specific question from the know card
      prompt = 'Context:\n' + (context || 'no project context') + '\n\n' +
        'Question: "' + (opts.questionText || '') + '"\n' +
        'Answer: "' + transcript + '"\n\n' +
        'Extract the answer in 5 words max. No preamble.';
    } else {
      // Normal voice input with full project context
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
   * processImage -- sends image to R1 LLM with project context.
   * Returns a promise with { ok, clean, structured }.
   */
  function processImage(rawBase64, description, meta) {
    var context = buildProjectContext();
    var prompt = (context ? context + '\n\n' : '') +
      'Image: ' + (description || 'camera capture') + '\n' +
      'Camera: ' + (meta && meta.facingMode || 'environment') + '\n\n' +
      'What does this tell us? 1-2 key elements. 8 words max.';

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
    if (!native || !native.touchProjectMemory) return null;

    var insight = {
      title: (sourceType || 'llm') + ' insight',
      body: result.clean,
      next: result.structured ? result.structured.next : '',
      confidence: result.structured ? result.structured.conf : 'med',
      created_at: new Date().toISOString()
    };

    var decisionText = result.structured && result.structured.decision;

    native.touchProjectMemory(function(project) {
      project.insights = Array.isArray(project.insights) ? project.insights : [];
      project.insights.unshift(insight);
      project.insights = project.insights.slice(0, 16);

      // Auto-create pending decision if LLM identified one
      if (decisionText) {
        project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
        // Dedup: don't add if same text already exists
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

    return insight;
  }

  function resetHistory() { conversationHistory = []; }

  window.StructaLLM = Object.freeze({
    sendToLLM: sendToLLM,
    processVoice: processVoice,
    processImage: processImage,
    query: query,
    storeAsInsight: storeAsInsight,
    resetHistory: resetHistory,
    get pendingCount() { return Object.keys(pendingCallbacks).length; },
    get historyLength() { return conversationHistory.length; }
  });
})();
