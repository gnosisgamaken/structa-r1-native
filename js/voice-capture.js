/**
 * voice-capture.js — Voice capture for Structa on R1.
 *
 * Two paths:
 * 1. R1 native STT: PTT starts capture via CreationVoiceHandler.postMessage("start"),
 *    R1 OS processes audio, sends back sttEnded via onPluginMessage.
 *    This is the PRIMARY path on R1 hardware.
 *
 * 2. Browser fallback: SpeechRecognition or MediaRecorder.
 *    Only used if on desktop/browser (not on R1).
 *
 * Changes (2026-04-13):
 * - handleTranscript() now checks for answeringQuestion context
 * - Question answers route through StructaLLM.processVoice() with questionText
 * - Resolved questions are stored via native.resolveQuestion()
 * - Removed noisy debug logs (thinking..., r1 stt: start)
 * - Voice status text shown on overlay for question-answering context
 */
(() => {
  const native = window.StructaNative;
  const overlay = document.getElementById('voice-overlay');
  const transcriptEl = document.getElementById('voice-transcript');
  const status = document.getElementById('voice-status');
  const wave = document.getElementById('voice-wave');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let listening = false;
  let audioRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let pendingAudioAsset = null;
  let voiceTarget = null; // 'tell' | 'question-answer' | null
  let activeQuestion = null; // { index, text } when answering a question
  let activeBuildContext = null; // { kind, nodeId, text, surface }
  let activeTriangleContext = null; // { label }

  function inlineMode() {
    return !!window.__STRUCTA_INLINE_PTT__;
  }

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function setContextLabel(text) {
    const label = document.getElementById('voice-context-label');
    if (!label) return;
    if (text) {
      label.textContent = String(text);
      label.style.display = 'block';
      return;
    }
    label.textContent = '';
    label.style.display = 'none';
  }

  function showOverlay() {
    if (inlineMode()) {
      window.dispatchEvent(new CustomEvent('structa-voice-open'));
      return;
    }
    document.getElementById('app')?.classList.add('overlay-active');
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
    window.dispatchEvent(new CustomEvent('structa-voice-open'));
  }

  function hideOverlay() {
    if (inlineMode()) {
      window.dispatchEvent(new CustomEvent('structa-voice-close'));
      return;
    }
    overlay?.classList.remove('open', 'listening');
    overlay?.setAttribute('aria-hidden', 'true');
    document.getElementById('app')?.classList.remove('overlay-active');
    if (wave) wave.hidden = true;
    window.dispatchEvent(new CustomEvent('structa-voice-close'));
  }

  function stopAudioStream() {
    if (audioStream) {
      try { audioStream.getTracks().forEach(track => track.stop()); } catch (_) {}
      audioStream = null;
    }
  }

  // === Voice command patterns ===
  var VOICE_COMMANDS = [
    { pattern: /^(?:research|look up|search for|find out about)\s+(.+)/i, type: 'research' },
    { pattern: /^export\s+(brief|decisions|research|summary)/i, type: 'export' },
    { pattern: /^(?:new project|create project|start project)\s+(.+)/i, type: 'new-project' },
    { pattern: /^(?:switch to|open project|go to project)\s+(.+)/i, type: 'switch-project' },
    { pattern: /^(?:archive project|park project)\s*(.*)/i, type: 'archive-project' },
    { pattern: /^(?:delete project|remove project)\s*(.*)/i, type: 'delete-project' },
    { pattern: /^(?:set type|project type)\s+(architecture|software|design|film|music|writing|research|general)/i, type: 'set-type' },
    { pattern: /^(?:i am a|my role is|i'm a)\s+(.+)/i, type: 'set-role' }
  ];

  function tryVoiceCommand(text) {
    var lower = text.toLowerCase().trim();
    for (var i = 0; i < VOICE_COMMANDS.length; i++) {
      var cmd = VOICE_COMMANDS[i];
      var match = lower.match(cmd.pattern);
      if (!match) continue;
      var arg = (match[1] || '').trim();

      switch (cmd.type) {
        case 'research':
          native?.appendLogEntry?.({ kind: 'voice', message: 'researching: ' + arg.slice(0, 40) });
          if (window.StructaLLM && window.StructaLLM.research) {
            window.StructaLLM.research(arg).then(function(result) {
              if (result && result.ok) {
                native?.appendLogEntry?.({ kind: 'llm', message: 'research: ' + result.findings.slice(0, 2).join('; ').slice(0, 50) });
                native?.updateUIState?.({ last_insight_summary: 'research: ' + arg.slice(0, 30) });
              }
              window.dispatchEvent(new CustomEvent('structa-memory-updated'));
            });
          }
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'research-command' }
          }));
          return true;

        case 'export':
          native?.appendLogEntry?.({ kind: 'voice', message: 'exporting ' + arg });
          if (window.StructaLLM && window.StructaLLM.generateExport) {
            window.StructaLLM.generateExport(arg).then(function(result) {
              if (result && result.ok) {
                native?.appendLogEntry?.({ kind: 'export', message: arg + ' sent to email' });
              }
              window.dispatchEvent(new CustomEvent('structa-memory-updated'));
            });
          }
          return true;

        case 'new-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'new project: ' + arg.slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'new-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'new-project-command' }
          }));
          return true;

        case 'switch-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'switch to: ' + arg.slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'switch-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'switch-project-command' }
          }));
          return true;

        case 'archive-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'archive project: ' + (arg || 'active').slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'archive-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'archive-project-command' }
          }));
          return true;

        case 'delete-project':
          native?.appendLogEntry?.({ kind: 'voice', message: 'delete project: ' + (arg || 'active').slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-voice-command', {
            detail: { command: 'delete-project', name: arg }
          }));
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'delete-project-command' }
          }));
          return true;

        case 'set-type':
          if (native?.setProjectType) native.setProjectType(arg);
          native?.appendLogEntry?.({ kind: 'voice', message: 'project type: ' + arg });
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
          return true;

        case 'set-role':
          if (native?.setUserRole) native.setUserRole(arg);
          native?.appendLogEntry?.({ kind: 'voice', message: 'role set: ' + arg.slice(0, 30) });
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
          return true;
      }
    }
    return false;
  }

  function inferProjectName(rawText) {
    var value = String(rawText || '').trim();
    if (!value) return '';
    value = value
      .replace(/^(?:this project is about|this project is|we are building|we're building|we are making|we're making|i am building|i'm building|i want to build|i want to make|this is about)\s+/i, '')
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(/[.?!]+$/g, '')
      .trim();
    if (!value) return '';
    var phrase = value.split(/[,:;\n]/)[0].trim();
    if (!phrase) return '';
    var words = phrase.split(/\s+/).filter(Boolean).slice(0, 4);
    if (!words.length) return '';
    var title = words.join(' ').slice(0, 24).trim().toLowerCase();
    return title.length >= 3 ? title : '';
  }

  function resolveProjectTitle(rawText, project) {
    var heuristic = inferProjectName(rawText);
    if (!window.StructaLLM?.titleProject || !project) {
      return Promise.resolve(heuristic);
    }
    return window.StructaLLM.titleProject(rawText, project).then(function(result) {
      return (result && result.title) || heuristic;
    }).catch(function() {
      return heuristic;
    });
  }

  /**
   * handleTranscript — processes a voice transcript.
   * Routes to:
   * 1. Voice commands (research, export, new project, switch, set type/role)
   * 2. Question answering (if activeQuestion is set)
   * 3. Normal voice input (project context via StructaLLM)
   */
  function handleTranscript(text, overrides) {
    if (!text || !text.trim()) return;
    text = text.trim();
    var questionContext = overrides && overrides.activeQuestion ? overrides.activeQuestion : activeQuestion;
    var buildContext = overrides && overrides.activeBuildContext ? overrides.activeBuildContext : activeBuildContext;
    var triangleContext = overrides && overrides.activeTriangleContext ? overrides.activeTriangleContext : activeTriangleContext;

    // Clean up STT artifacts — spoken punctuation → actual punctuation
    text = text.replace(/\bquestion mark\b/gi, '?');
    text = text.replace(/\bperiod\b/gi, '.');
    text = text.replace(/\bcomma\b/gi, ',');
    text = text.replace(/\bexclamation mark\b/gi, '!');
    text = text.replace(/\bexclamation point\b/gi, '!');
    text = text.replace(/\s+/g, ' ').trim();

    // === Voice commands — intercept before normal processing ===
    var commandHandled = tryVoiceCommand(text);
    if (commandHandled) return;

    if (triangleContext) {
      activeTriangleContext = null;
      voiceTarget = null;
      native?.appendLogEntry?.({ kind: 'triangle', message: 'triangle synthesizing' });
      window.dispatchEvent(new CustomEvent('structa-triangle-submit', {
        detail: {
          transcript: text,
          label: triangleContext.label || 'your angle'
        }
      }));
      return;
    }

    // === Question answering mode ===
    if (questionContext) {
      var question = questionContext;
      voiceTarget = null;
      var onboardingFinalized = false;

      function finalizeOnboardingAnswer() {
        if (!question.onboarding || onboardingFinalized) return;
        onboardingFinalized = true;
        var currentProject = native?.getProjectMemory?.();
        var heuristicName = inferProjectName(text);
        native?.updateUIState?.({
          onboarding_step: 3,
          onboarded: false
        });
        window.dispatchEvent(new CustomEvent('structa-onboarding-answer', {
          detail: {
            answer: text,
            inferredName: heuristicName || ''
          }
        }));
        resolveProjectTitle(text, currentProject).then(function(finalName) {
          if (finalName) native?.setProjectName?.(finalName);
        }).catch(function() {
          if (heuristicName) native?.setProjectName?.(heuristicName);
        });
      }

      native?.appendLogEntry?.({ kind: 'voice', message: 'question answered' });

      // Store the answer in project memory
      if (question.onboarding) {
        native?.addVoiceEntry?.({
          title: text.slice(0, 42) || 'project foundation',
          body: text,
          source: 'onboarding',
          entry_mode: 'onboarding'
        });
      } else {
        native?.resolveQuestion?.(question.index, text);
      }
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'question-answer' }
      }));
      if (question.onboarding) {
        finalizeOnboardingAnswer();
      }

      // Send to LLM for structured extraction (answer mode)
      if (window.StructaLLM) {
        window.StructaLLM.processVoice(text, {
          answeringQuestion: true,
          questionText: question.text
        }).then(function(result) {
          if (result && result.ok && result.clean) {
            // Store the extracted answer as insight
            var answerInsight = window.StructaLLM.storeAsInsight(result, 'answer');
            native?.updateUIState?.({ last_insight_summary: result.clean.slice(0, 60) });
            finalizeOnboardingAnswer();
            window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
              detail: { source: 'question-answer' }
            }));
          } else {
            finalizeOnboardingAnswer();
          }
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        }).catch(function() {
          finalizeOnboardingAnswer();
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        });
      } else {
        finalizeOnboardingAnswer();
        window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      }
      return;
    }

    if (buildContext && buildContext.kind === 'log-note') {
      voiceTarget = null;
      native?.appendLogEntry?.({
        kind: 'voice',
        message: 'log note · ' + text.slice(0, 72)
      });
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'log-note' }
      }));
      window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      return;
    }

    // === Normal voice input ===
    native?.appendLogEntry?.({ kind: 'voice', message: 'voice saved' });
    if (buildContext && buildContext.kind === 'voice-entry' && buildContext.nodeId && native?.appendToVoiceEntry) {
      native.appendToVoiceEntry(buildContext.nodeId, text, {
        entry_mode: 'contextual-build',
        surface: buildContext.surface || 'tell'
      });
    } else {
      native?.addVoiceEntry?.({
        title: text.slice(0, 42) || 'voice note',
        body: text,
        source: 'voice',
        entry_mode: buildContext ? 'contextual' : 'auto',
        meta: buildContext ? { build_surface: buildContext.surface || 'tell' } : {}
      });
    }
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: 'voice-entry' }
    }));

    // Try to detect project name from first meaningful voice input
    if (text.length > 3 && text.length < 50) {
      var project = native?.getProjectMemory?.();
      if (project && project.name === 'untitled project') {
        resolveProjectTitle(text, project).then(function(inferredName) {
          if (inferredName && inferredName !== 'untitled project') native?.setProjectName?.(inferredName);
        });
      }
    }

    // Try to detect a decision and add it as pending
    var decisionMatch = text.match(/^(?:we |i |let.s |i.ll |we.ve )?(decided|agreed|chose|will|plan to|going to|should)\b(.{5,80})/i);
    if (decisionMatch) {
      var decisionText = text.slice(0, 120).trim();
      var decisionNorm = decisionText.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      native?.touchProjectMemory?.(function(project) {
        project.pending_decisions = Array.isArray(project.pending_decisions) ? project.pending_decisions : [];
        // Fuzzy dedup: normalize and compare first 30 chars
        var exists = project.pending_decisions.some(function(d) {
          var existing = ((d.text || d) || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
          return existing === decisionNorm || (existing.length > 20 && decisionNorm.length > 20 && (existing.startsWith(decisionNorm.slice(0, 30)) || decisionNorm.startsWith(existing.slice(0, 30))));
        });
        if (!exists) {
          project.pending_decisions.unshift({
            text: decisionText,
            source: 'voice-direct',
            insight_body: '',
            created_at: new Date().toISOString()
          });
          project.pending_decisions = project.pending_decisions.slice(0, 8);
        }
      });
    }

    // Try to detect a task and add to backlog
    var taskMatch = text.match(/^(?:need to|must|have to|gotta|remember to|don't forget to)\b(.{5,80})/i);
    if (taskMatch) {
      native?.addBacklogItem?.(text.slice(0, 60), text);
    }

    var isQuestion = /\?$/.test(text) || /^(?:what|why|how|when|who|which|where|is|are|can|could|should|would|do|does)\b/i.test(text);
    if (isQuestion && native?.addNode) {
      native.addNode({
        type: 'question',
        status: 'open',
        title: text.slice(0, 72),
        body: text,
        source: buildContext ? (buildContext.surface || 'voice') : 'voice'
      });
      window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
        detail: { source: 'question' }
      }));
    }

    // Send to LLM for insight extraction
    if (window.StructaLLM) {
      window.StructaLLM.processVoice(text, buildContext ? { buildContext: buildContext } : {}).then(function(result) {
        if (result && result.ok) {
          var createdInsight = window.StructaLLM.storeAsInsight(result, 'voice');
          if (createdInsight?.node_id && buildContext?.nodeId && native?.touchProjectMemory) {
            native.touchProjectMemory(function(project) {
              var nodes = project.nodes || [];
              var sourceNode = nodes.find(function(entry) { return entry.node_id === buildContext.nodeId; });
              var insightNode = nodes.find(function(entry) { return entry.node_id === createdInsight.node_id; });
              if (sourceNode && insightNode) {
                sourceNode.links = Array.isArray(sourceNode.links) ? sourceNode.links : [];
                insightNode.links = Array.isArray(insightNode.links) ? insightNode.links : [];
                if (sourceNode.links.indexOf(insightNode.node_id) === -1) sourceNode.links.push(insightNode.node_id);
                if (insightNode.links.indexOf(sourceNode.node_id) === -1) insightNode.links.push(sourceNode.node_id);
              }
            });
          }
          native?.appendLogEntry?.({ kind: 'llm', message: 'insight extracted' });
          native?.updateUIState?.({ last_insight_summary: result.clean.slice(0, 60) });
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'insight' }
          }));
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        } else {
          native?.appendLogEntry?.({ kind: 'llm', message: 'insight unavailable' });
        }
      }).catch(function(err) {
        native?.appendLogEntry?.({ kind: 'llm', message: 'insight failed' });
      });
    }
  }

  function stopListening(emit) {
    emit = emit !== false;
    var pendingQuestion = activeQuestion;
    var pendingBuildContext = activeBuildContext;
    var pendingTriangleContext = activeTriangleContext;
    listening = false;
    voiceTarget = null;
    activeQuestion = null;
    activeBuildContext = null;
    activeTriangleContext = null;

    // Stop browser recognition
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    if (audioRecorder && audioRecorder.state !== 'inactive') {
      try { audioRecorder.stop(); } catch (_) {}
    }
    stopAudioStream();
    overlay?.classList.remove('listening');
    if (wave) wave.hidden = true;

    const text = (transcriptEl && transcriptEl.textContent || '').trim();

    if (emit) {
      // Tell R1 OS we stopped talking
      if (typeof CreationVoiceHandler !== 'undefined') {
        try { CreationVoiceHandler.postMessage('stop'); } catch (_) {}
      }
      native?.stopPTT?.(text || '');
      // Process the transcript
      if (text) {
        handleTranscript(text, {
          activeQuestion: pendingQuestion,
          activeBuildContext: pendingBuildContext,
          activeTriangleContext: pendingTriangleContext
        });
      } else if (pendingAudioAsset) {
        native?.addVoiceEntry?.({
          title: 'voice note',
          body: 'audio note captured',
          source: 'voice',
          entry_mode: 'audio-fallback'
        });
      }
    }

    // Unmute heartbeat after capture
    if (window.StructaAudio) window.StructaAudio.unmute();

    setStatus('idle');
    close();
  }

  /**
   * setQuestionContext — called from cascade when user wants to answer a question.
   * Stores the question so handleTranscript knows to route it as an answer.
   */
  function setQuestionContext(index, questionText, meta) {
    if (typeof index === 'object' && index) {
      activeQuestion = {
        index: typeof index.index === 'number' ? index.index : -1,
        text: index.text || '',
        onboarding: !!index.onboarding
      };
      voiceTarget = 'question-answer';
      return;
    }
    activeQuestion = {
      index: index,
      text: questionText,
      onboarding: !!(meta && meta.onboarding)
    };
    voiceTarget = 'question-answer';
  }

  function setBuildContext(context) {
    activeBuildContext = context ? {
      kind: context.kind || 'context',
      nodeId: context.nodeId || '',
      text: String(context.text || '').trim(),
      surface: context.surface || 'tell'
    } : null;
    if (activeBuildContext && !activeQuestion) voiceTarget = 'tell';
  }

  function setTriangleContext(context) {
    activeTriangleContext = context ? {
      label: String(context.label || 'your angle')
    } : null;
    if (activeTriangleContext) voiceTarget = 'triangle';
  }

  async function startListening() {
    if (listening) return;

    // Don't interfere with camera PTT
    if (window.__STRUCTA_PTT_TARGET__ === 'camera') {
      hideOverlay();
      setStatus('idle');
      return;
    }

    showOverlay();
    if (!inlineMode()) {
      overlay?.classList.add('listening');
      if (wave) wave.hidden = false;
    }
    if (transcriptEl) transcriptEl.textContent = '';
    audioChunks = [];
    pendingAudioAsset = null;
    listening = true;
    voiceTarget = activeQuestion ? 'question-answer' : (activeTriangleContext ? 'triangle' : 'tell');
    setStatus('listening');

    // Mute heartbeat and play voice start sound
    if (window.StructaAudio) {
      window.StructaAudio.mute();
      window.StructaAudio.init();
      window.StructaAudio.unmute(); // briefly unmute for the sound
      window.StructaAudio.play('voice');
      window.StructaAudio.mute();
    }

    // Show context-specific status
    if (activeQuestion) {
      setStatus('answer mode');
    } else if (activeTriangleContext) {
      setStatus('triangle angle');
    } else if (activeBuildContext && activeBuildContext.text) {
      setStatus('building ' + (activeBuildContext.surface || 'context'));
    }

    // Tell R1 OS we started talking
    native?.startPTT?.();

    // === R1 path: Use CreationVoiceHandler for native STT ===
    if (typeof CreationVoiceHandler !== 'undefined') {
      try {
        CreationVoiceHandler.postMessage('start');
        return;
      } catch (err) {
        native?.appendLogEntry?.({ kind: 'voice', message: 'stt err: ' + (err?.message || 'failed') });
      }
    }

    // === Browser fallback path ===
    if (!SR) {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setStatus('mic unavailable');
        listening = false;
        return;
      }
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var preferredMime = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg'
        ].find(function(type) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type); });
        audioRecorder = preferredMime ? new MediaRecorder(audioStream, { mimeType: preferredMime }) : new MediaRecorder(audioStream);
        audioRecorder.ondataavailable = function(event) {
          if (event.data && event.data.size) audioChunks.push(event.data);
        };
        audioRecorder.onstop = function() {
          // Audio fallback — store raw audio as asset
          if (audioChunks.length && native?.storeAsset) {
            var blob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
            var reader = new FileReader();
            reader.onload = function() {
              native?.storeAsset({
                kind: 'audio',
                name: 'voice-' + Date.now() + '.webm',
                mime_type: audioRecorder.mimeType || 'audio/webm',
                data: reader.result
              });
            };
            reader.readAsDataURL(blob);
          }
          audioRecorder = null;
        };
        audioRecorder.start();
        return;
      } catch (_) {
        setStatus('mic unavailable');
        listening = false;
        overlay?.classList.remove('listening');
        if (wave) wave.hidden = true;
        return;
      }
    }

    // === Desktop browser: SpeechRecognition ===
    if (!recognition) {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onresult = function(event) {
        var finalText = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var part = (event.results[i][0] && event.results[i][0].transcript) || '';
          if (event.results[i].isFinal) finalText += part;
          else if (transcriptEl && !transcriptEl.textContent) transcriptEl.textContent = part;
        }
        if (finalText && transcriptEl) transcriptEl.textContent = ((transcriptEl.textContent || '') + ' ' + finalText).trim();
      };
      recognition.onerror = function() { setStatus('mic error'); };
      recognition.onend = function() {
        if (listening && !(transcriptEl && transcriptEl.textContent && transcriptEl.textContent.trim())) setStatus('ready');
      };
    }

    try { recognition.start(); } catch (_) {
      setStatus('mic unavailable');
      listening = false;
      overlay?.classList.remove('listening');
      if (wave) wave.hidden = true;
    }
  }

  // Listen for STT transcript from R1 native bridge.
  window.addEventListener('structa-stt-ended', function(event) {
    var data = event && event.detail;
    if (data && data.transcript) {
      if (transcriptEl) transcriptEl.textContent = data.transcript;
      handleTranscript(data.transcript);
      stopListening(false);
    }
  });

  function open() {
    showOverlay();
    setStatus('ready');
  }

  function close() {
    if (listening) {
      stopListening(false);
    }
    activeTriangleContext = null;
    setContextLabel('');
    hideOverlay();
  }

  overlay?.addEventListener('pointerup', function(event) {
    event.preventDefault();
    if (listening) {
      stopListening(true);
      return;
    }
    close();
  });

  overlay?.addEventListener('pointercancel', function() {
    if (listening) stopListening(false);
  });

  var cleanupOnHide = function() {
    if (document.hidden || overlay?.classList.contains('open')) close();
  };

  window.addEventListener('pagehide', cleanupOnHide);
  document.addEventListener('visibilitychange', cleanupOnHide);

  window.StructaVoice = Object.freeze({
    open: open,
    close: close,
    startListening: startListening,
    stopListening: stopListening,
    setQuestionContext: setQuestionContext,
    setBuildContext: setBuildContext,
    setTriangleContext: setTriangleContext,
    setContextLabel: setContextLabel,
    get listening() { return listening; },
    get activeQuestion() { return activeQuestion; }
  });
})();
