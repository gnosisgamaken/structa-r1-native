/**
 * r1-llm.js -- Structa LLM client via R1 native bridge.
 *
 * Uses PluginMessageHandler.postMessage() to send messages to the R1's
 * on-device LLM. Responses come back via window.onPluginMessage().
 *
 * This is the CORRECT way to access the R1 LLM — not HTTP.
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
   * Returns a promise that resolves with { ok, text } when the response arrives.
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

        // Build payload — this is the R1 Create SDK format
        var payload = {
          message: message,
          useLLM: true,
          wantsR1Response: opts.speak || false,
          wantsJournalEntry: opts.journal || false
        };

        if (opts.pluginId) payload.pluginId = opts.pluginId;

        // Send via native bridge
        if (typeof PluginMessageHandler !== 'undefined') {
          try {
            PluginMessageHandler.postMessage(JSON.stringify(payload));
            if (native && native.appendLogEntry) {
              native.appendLogEntry({ kind: 'llm', message: 'llm: thinking...' });
            }
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
  // The R1 OS sends LLM responses back via onPluginMessage.
  // We intercept all responses and route to the correct pending callback.
  var previousHandler = window.onPluginMessage;

  window.onPluginMessage = function(data) {
    // Log all incoming messages for debugging
    var debugKeys = data ? Object.keys(data).join(',') : 'null';
    var native = window.StructaNative;
    native?.appendLogEntry?.({ kind: 'r1', message: 'r1 msg: ' + debugKeys + ' t=' + (data?.type || '?') });

    // Try to extract the LLM response text
    var responseText = '';
    var responseType = '';

    if (data) {
      responseType = data.type || '';
      responseText = data.message || data.content || data.response || data.transcript || '';
      if (!responseText && data.data) {
        try {
          var parsed = JSON.parse(data.data);
          responseText = parsed.message || parsed.content || parsed.response || parsed.transcript || '';
          responseType = responseType || parsed.type || '';
        } catch (e) {
          responseText = data.data;
        }
      }
    }

    // STT handling — match exact R1 format from timer SDK: { type: 'sttEnded', transcript: '...' }
    if (responseType === 'sttEnded' && data.transcript) {
      native?.appendLogEntry?.({ kind: 'voice', message: 'stt: ' + data.transcript.slice(0, 60) });
      if (previousHandler) {
        try { previousHandler(data); } catch (e) {}
      }
      window.dispatchEvent(new CustomEvent('structa-stt-ended', {
        detail: { transcript: data.transcript }
      }));
      return;
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
    var result = { raw: text, insight: text, next: '', conf: 'med' };
    var m = text.match(/(?:next step|suggest|recommend|you should|start by|try)[:\s]*(.{10,100})/i);
    if (m) result.next = m[1].trim();
    if (/definitely|clearly/i.test(text)) result.conf = 'high';
    if (/maybe|perhaps|might/i.test(text)) result.conf = 'low';
    return result;
  }

  // === Specialized entry points ===

  function processVoice(transcript) {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var parts = ['Project: ' + (project.name || 'untitled')];
    if (project.backlog && project.backlog.length) parts.push('Tasks: ' + project.backlog[0].title);
    if (project.decisions && project.decisions.length) parts.push('Decision: ' + project.decisions[0].title);
    parts.push('', 'Voice: "' + transcript + '"', '', 'One concrete next action.');
    return sendToLLM(parts.filter(Boolean).join('\n'));
  }

  function processImage(desc, meta) {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var parts = ['Project: ' + (project.name || 'untitled'),
      'Camera: ' + (meta && meta.facingMode || 'environment'), '',
      'Image captured: "' + (desc || 'no description') + '"', '',
      'What does this tell us? 1-2 key elements.'];
    return sendToLLM(parts.join('\n'));
  }

  function query(question) {
    var project = native && native.getProjectMemory ? native.getProjectMemory() : {};
    var parts = ['Project: ' + (project.name || 'untitled')];
    if (project.backlog && project.backlog.length) {
      parts.push('Open: ' + project.backlog.slice(0, 3).map(function(b) { return b.title; }).join(', '));
    }
    parts.push('', question);
    return sendToLLM(parts.filter(Boolean).join('\n'));
  }

  function storeAsInsight(result, sourceType) {
    if (!result || !result.ok || !result.clean) return null;
    if (!native || !native.touchProjectMemory) return null;
    return native.touchProjectMemory(function(project) {
      project.insights = Array.isArray(project.insights) ? project.insights : [];
      project.insights.unshift({
        title: (sourceType || 'llm') + ' insight',
        body: result.clean,
        next: result.structured ? result.structured.next : '',
        confidence: result.structured ? result.structured.conf : 'med',
        created_at: new Date().toISOString()
      });
      project.insights = project.insights.slice(0, 16);
    });
  }

  function resetHistory() { conversationHistory = []; }

  window.StructaLLM = Object.freeze({
    sendToLLM: sendToLLM,
    processVoice: processVoice,
    processImage: processImage,
    query: query,
    storeAsInsight: storeAsInsight,
    resetHistory: resetHistory,
    get pendingCount() { return Object.keys(pendingCallbacks).length; }
  });
})();
