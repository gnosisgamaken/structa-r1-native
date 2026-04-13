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

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function showOverlay() {
    document.getElementById('app')?.classList.add('overlay-active');
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
    window.dispatchEvent(new CustomEvent('structa-voice-open'));
  }

  function hideOverlay() {
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

  /**
   * handleTranscript — processes a voice transcript.
   * Routes to:
   * 1. Question answering (if activeQuestion is set)
   * 2. Normal voice input (project context via StructaLLM)
   */
  function handleTranscript(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    // Clean up STT artifacts — spoken punctuation → actual punctuation
    text = text.replace(/\bquestion mark\b/gi, '?');
    text = text.replace(/\bperiod\b/gi, '.');
    text = text.replace(/\bcomma\b/gi, ',');
    text = text.replace(/\bexclamation mark\b/gi, '!');
    text = text.replace(/\bexclamation point\b/gi, '!');
    text = text.replace(/\s+/g, ' ').trim();

    // === Question answering mode ===
    if (activeQuestion) {
      var question = activeQuestion;
      activeQuestion = null;
      voiceTarget = null;

      native?.appendLogEntry?.({ kind: 'voice', message: 'answered: ' + text.slice(0, 40) });

      // Store the answer in project memory
      native?.resolveQuestion?.(question.index, text);

      // Send to LLM for structured extraction (answer mode)
      if (window.StructaLLM) {
        window.StructaLLM.processVoice(text, {
          answeringQuestion: true,
          questionText: question.text
        }).then(function(result) {
          if (result && result.ok && result.clean) {
            // Store the extracted answer as insight
            window.StructaLLM.storeAsInsight(result, 'answer');
            native?.updateUIState?.({ last_insight_summary: result.clean.slice(0, 60) });
          }
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        }).catch(function() {
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        });
      } else {
        window.dispatchEvent(new CustomEvent('structa-memory-updated'));
      }
      return;
    }

    // === Normal voice input ===
    native?.appendLogEntry?.({ kind: 'voice', message: 'voice: ' + text.slice(0, 60) });

    // Write journal entry
    native?.writeJournalEntry?.({
      title: text.slice(0, 42) || 'voice note',
      body: text,
      source_type: 'voice',
      meta: { entry_mode: 'auto' }
    });

    // Try to detect project name from first meaningful voice input
    if (text.length > 3 && text.length < 50) {
      var project = native?.getProjectMemory?.();
      if (project && project.name === 'untitled project') {
        native?.setProjectName?.(text);
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

    // Send to LLM for insight extraction
    if (window.StructaLLM) {
      window.StructaLLM.processVoice(text).then(function(result) {
        if (result && result.ok) {
          window.StructaLLM.storeAsInsight(result, 'voice');
          native?.appendLogEntry?.({ kind: 'llm', message: result.clean.slice(0, 80) });
          native?.updateUIState?.({ last_insight_summary: result.clean.slice(0, 60) });
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        } else {
          native?.appendLogEntry?.({ kind: 'llm', message: 'llm: ' + (result && result.error || 'no response') });
        }
      }).catch(function(err) {
        native?.appendLogEntry?.({ kind: 'llm', message: 'llm error: ' + (err && err.message || 'failed') });
      });
    }
  }

  function stopListening(emit) {
    emit = emit !== false;
    listening = false;
    voiceTarget = null;
    activeQuestion = null;

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
        handleTranscript(text);
      } else if (pendingAudioAsset) {
        native?.writeJournalEntry?.({
          title: 'voice note',
          body: 'audio note captured',
          source_type: 'voice',
          meta: { entry_mode: 'audio-fallback' }
        });
      }
    }

    setStatus('idle');
    close();
  }

  /**
   * setQuestionContext — called from cascade when user wants to answer a question.
   * Stores the question so handleTranscript knows to route it as an answer.
   */
  function setQuestionContext(index, questionText) {
    activeQuestion = { index: index, text: questionText };
    voiceTarget = 'question-answer';
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
    overlay?.classList.add('listening');
    if (wave) wave.hidden = false;
    if (transcriptEl) transcriptEl.textContent = '';
    audioChunks = [];
    pendingAudioAsset = null;
    listening = true;
    voiceTarget = activeQuestion ? 'question-answer' : 'tell';
    setStatus('listening');

    // Show context-specific status
    if (activeQuestion) {
      setStatus('answer mode');
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
    get listening() { return listening; },
    get activeQuestion() { return activeQuestion; }
  });
})();
