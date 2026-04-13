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
 */
(() => {
  const native = window.StructaNative;
  const overlay = document.getElementById('voice-overlay');
  const transcript = document.getElementById('voice-transcript');
  const status = document.getElementById('voice-status');
  const wave = document.getElementById('voice-wave');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let listening = false;
  let audioRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let pendingAudioAsset = null;
  let voiceTarget = null; // 'tell' or null

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

  // Process a transcript — send to LLM and store as insight
  function handleTranscript(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    // Log the transcript
    native?.appendLogEntry?.({ kind: 'voice', message: 'voice: ' + text.slice(0, 60) });

    // Write journal entry
    native?.writeJournalEntry?.({
      title: text.slice(0, 42) || 'voice note',
      body: text,
      source_type: 'voice',
      meta: { entry_mode: 'auto' }
    });

    // Send to LLM
    if (window.StructaLLM) {
      native?.appendLogEntry?.({ kind: 'llm', message: 'thinking...' });
      window.StructaLLM.processVoice(text).then(result => {
        if (result && result.ok) {
          window.StructaLLM.storeAsInsight(result, 'voice');
          native?.appendLogEntry?.({ kind: 'llm', message: result.clean.slice(0, 80) });
          // Trigger UI update
          window.dispatchEvent(new CustomEvent('structa-memory-updated'));
        } else {
          native?.appendLogEntry?.({ kind: 'llm', message: 'llm: ' + (result && result.error || 'no response') });
        }
      }).catch(err => {
        native?.appendLogEntry?.({ kind: 'llm', message: 'llm error: ' + (err && err.message || 'failed') });
      });
    }
  }

  function stopListening(emit) {
    emit = emit !== false;
    listening = false;
    voiceTarget = null;

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

    const text = (transcript && transcript.textContent || '').trim();

    if (emit) {
      // Tell the R1 OS we stopped talking
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

  function startListening() {
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
    if (transcript) transcript.textContent = '';
    audioChunks = [];
    pendingAudioAsset = null;
    listening = true;
    voiceTarget = 'tell';
    setStatus('listening');

    // Tell R1 OS we started talking
    native?.startPTT?.();

    // === R1 path: Use CreationVoiceHandler for native STT ===
    // The R1 OS will process audio and send sttEnded via onPluginMessage.
    // We don't need browser SpeechRecognition on R1.
    if (window.CreationVoiceHandler) {
      try {
        window.CreationVoiceHandler.postMessage('start');
        // The R1 will handle STT and send back transcript via onPluginMessage
        return;
      } catch (_) {}
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
          finalizeAudioCapture().catch(function() {});
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
          else if (transcript && !transcript.textContent) transcript.textContent = part;
        }
        if (finalText && transcript) transcript.textContent = ((transcript.textContent || '') + ' ' + finalText).trim();
      };
      recognition.onerror = function() { setStatus('mic error'); };
      recognition.onend = function() {
        if (listening && !(transcript && transcript.textContent && transcript.textContent.trim())) setStatus('ready');
      };
    }

    try { recognition.start(); } catch (_) {
      setStatus('mic unavailable');
      listening = false;
      overlay?.classList.remove('listening');
      if (wave) wave.hidden = true;
    }
  }

  // R1 native STT callback — THIS IS THE KEY
  // The R1 OS sends sttEnded when it finishes processing voice audio.
  window.onPluginMessage = function(data) {
    if (data && data.type === 'sttEnded' && data.transcript) {
      if (transcript) transcript.textContent = data.transcript;
      handleTranscript(data.transcript);
      stopListening(false);
    }
  };

  // Also listen via addEventListener in case onPluginMessage isn't the right hook
  window.addEventListener('pluginmessage', function(event) {
    var data = event && event.detail;
    if (data && data.type === 'sttEnded' && data.transcript) {
      if (transcript) transcript.textContent = data.transcript;
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
    get listening() { return listening; }
  });
})();
