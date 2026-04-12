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

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('failed to read blob'));
      reader.readAsDataURL(blob);
    });
  }

  function stopAudioStream() {
    if (audioStream) {
      try { audioStream.getTracks().forEach(track => track.stop()); } catch (_) {}
      audioStream = null;
    }
  }

  async function finalizeAudioCapture() {
    if (!audioChunks.length) return null;
    const blob = new Blob(audioChunks, { type: audioRecorder?.mimeType || 'audio/webm' });
    const dataUrl = await blobToDataURL(blob).catch(() => '');
    if (!dataUrl) return null;
    pendingAudioAsset = {
      kind: 'asset',
      name: `voice-${Date.now()}.webm`,
      mime_type: blob.type || 'audio/webm',
      data: dataUrl,
      meta: {
        captured_at: new Date().toISOString(),
        mode: 'ptt'
      }
    };
    native?.storeAsset?.(pendingAudioAsset);
    return pendingAudioAsset;
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

  async function stopListening(emit = true) {
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    if (audioRecorder && audioRecorder.state !== 'inactive') {
      try { audioRecorder.stop(); } catch (_) {}
    }
    stopAudioStream();
    overlay?.classList.remove('listening');
    if (wave) wave.hidden = true;
    listening = false;
    const text = (transcript?.textContent || '').trim();
    if (emit) {
      if (text) native?.stopPTT?.(text);
      if (text) {
        native?.writeJournalEntry?.({
          title: text.slice(0, 42) || 'voice note',
          body: text,
          source_type: 'voice',
          meta: { entry_mode: 'auto' }
        });
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

  async function startListening() {
    if (listening) return;
    showOverlay();
    overlay?.classList.add('listening');
    if (wave) wave.hidden = false;
    if (transcript) transcript.textContent = '';
    audioChunks = [];
    pendingAudioAsset = null;
    listening = true;
    setStatus('listening');
    native?.startPTT?.();

    if (!SR) {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setStatus('mic unavailable');
        listening = false;
        return;
      }
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const preferredMime = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg'
        ].find(type => MediaRecorder.isTypeSupported?.(type));
        audioRecorder = preferredMime ? new MediaRecorder(audioStream, { mimeType: preferredMime }) : new MediaRecorder(audioStream);
        audioRecorder.ondataavailable = event => {
          if (event.data && event.data.size) audioChunks.push(event.data);
        };
        audioRecorder.onstop = () => {
          finalizeAudioCapture().catch(() => {});
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

    if (!recognition) {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onresult = event => {
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const part = event.results[i][0]?.transcript || '';
          if (event.results[i].isFinal) finalText += part;
          else if (transcript && !transcript.textContent) transcript.textContent = part;
        }
        if (finalText && transcript) transcript.textContent = `${transcript.textContent || ''} ${finalText}`.trim();
      };
      recognition.onerror = () => {
        setStatus('mic error');
      };
      recognition.onend = () => {
        if (listening && !(transcript?.textContent || '').trim()) setStatus('ready');
      };
    }

    try {
      recognition.start();
    } catch (_) {
      setStatus('mic unavailable');
      listening = false;
      overlay?.classList.remove('listening');
      if (wave) wave.hidden = true;
    }
  }

  function open() {
    showOverlay();
    setStatus('ready');
  }

  function close() {
    if (listening) {
      stopListening(false).catch?.(() => {});
    }
    hideOverlay();
  }

  overlay?.addEventListener('pointerdown', event => {
    event.preventDefault();
    startListening().catch(() => {});
  });

  overlay?.addEventListener('pointerup', event => {
    event.preventDefault();
    if (listening) stopListening(true).catch(() => {});
  });

  overlay?.addEventListener('pointercancel', () => {
    if (listening) stopListening(false).catch(() => {});
  });

  window.StructaVoice = Object.freeze({
    open,
    close,
    startListening,
    stopListening,
    get listening() { return listening; }
  });
})();
