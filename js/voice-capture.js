(() => {
  const native = window.StructaNative;
  const transcript = document.getElementById('voice-transcript');
  const status = document.getElementById('voice-status');
  const btnStart = document.getElementById('voice-start');
  const tray = document.getElementById('capture-tray');
  const captureLauncher = document.getElementById('capture-launcher');
  const captureTitle = document.getElementById('capture-title');
  const captureHint = document.getElementById('capture-hint');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voicePanel = document.querySelector('#capture-tray .capture-panel[data-panel="voice"]');
  const cameraPanel = document.querySelector('#capture-tray .capture-panel[data-panel="camera"]');
  let recognition = null;
  let listening = false;
  let audioRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let pendingAudioAsset = null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
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
    if (!audioChunks.length) return;
    const blob = new Blob(audioChunks, { type: audioRecorder?.mimeType || 'audio/webm' });
    const dataUrl = await blobToDataURL(blob).catch(() => '');
    if (!dataUrl) return;

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
    const bundle = window.StructaCaptureBundles?.saveCaptureBundle?.({
      source_type: 'microphone',
      input_type: 'audio',
      audio_asset: pendingAudioAsset,
      prompt_text: 'voice capture',
      summary: 'Audio note captured',
      approval_state: 'draft',
      tags: ['voice', 'audio'],
      links: [],
      meta: { entry_mode: 'ptt-fallback' }
    });
    if (bundle?.ok) {
      setStatus('Saved');
      if (captureTitle) captureTitle.textContent = 'Voice';
      if (transcript) transcript.textContent = '';
    }
  }

  function openTray() {
    tray?.classList.add('open');
    tray?.setAttribute('aria-hidden', 'false');
    if (captureLauncher) captureLauncher.hidden = true;
  }

  function closeTray() {
    tray?.classList.remove('open');
    tray?.setAttribute('aria-hidden', 'true');
    if (captureLauncher) captureLauncher.hidden = false;
    stopListening(false);
    window.StructaCamera?.teardown?.();
    if (captureTitle) captureTitle.textContent = 'Voice';
  }

  function setPanel(panel) {
    document.querySelectorAll('#capture-tray .capture-panel').forEach(el => {
      el.classList.toggle('active', el.dataset.panel === panel);
    });
    openTray();
    if (captureTitle) captureTitle.textContent = panel === 'camera' ? 'Camera' : 'Voice';
    if (panel === 'camera') {
      window.StructaCamera?.open?.(window.StructaCamera?.facingMode || 'environment');
    } else {
      window.StructaCamera?.pause?.();
    }
  }

  async function stopListening(emit = true) {
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    if (audioRecorder && audioRecorder.state !== 'inactive') {
      try { audioRecorder.stop(); } catch (_) {}
    }
    stopAudioStream();
    listening = false;
    if (btnStart) btnStart.textContent = 'PTT';
    setStatus('Idle');
    if (emit) {
      const text = transcript?.textContent?.trim() || '';
      if (text && native?.stopPTT) native.stopPTT(text);
      if (text && native?.writeJournalEntry) {
        native.writeJournalEntry({
          title: deriveTitle(text),
          body: text,
          source_type: 'voice',
          meta: { entry_mode: 'auto' }
        });
        setStatus('Saved');
      }
      if (!text && pendingAudioAsset) {
        native?.writeJournalEntry?.({
          title: 'Voice note',
          body: 'Audio note captured.',
          source_type: 'voice',
          meta: { entry_mode: 'audio-fallback' }
        });
      }
    }
  }

  async function startListening() {
    openTray();
    setPanel('voice');
    if (btnStart) btnStart.textContent = 'Stop';
    setStatus('Listening...');
    if (transcript) transcript.textContent = '';
    native?.startPTT?.();

    if (!SR) {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        listening = false;
        if (btnStart) btnStart.textContent = 'PTT';
        setStatus('Mic unavailable');
        return;
      }

      try {
        audioChunks = [];
        pendingAudioAsset = null;
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
          stopAudioStream();
        };
        audioRecorder.start();
        listening = true;
        setStatus('Recording audio...');
        if (transcript) transcript.textContent = '';
        native?.startPTT?.();
        return;
      } catch (_) {
        listening = false;
        if (btnStart) btnStart.textContent = 'PTT';
        setStatus('Mic unavailable');
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
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const part = event.results[i][0]?.transcript || '';
          if (event.results[i].isFinal) finalText += part;
          else if (!transcript.textContent) transcript.textContent = part;
        }
        if (finalText) transcript.textContent = (transcript.textContent + ' ' + finalText).trim();
      };
      recognition.onerror = () => {
        if (btnStart) btnStart.textContent = 'PTT';
        setStatus('Mic error');
      };
      recognition.onend = () => {
        listening = false;
        if (btnStart) btnStart.textContent = 'PTT';
        setStatus('Ready');
      };
    }

    try {
      listening = true;
      recognition.start();
    } catch (_) {
      setStatus('Mic unavailable');
    }
  }

  function deriveTitle(text) {
    const head = String(text || '').trim().split(/\n+/)[0].slice(0, 42).trim();
    return head || 'Voice note';
  }

  function saveJournal() {
    const text = transcript?.textContent?.trim() || '';
    if (!text) {
      setStatus('Need transcript');
      return;
    }
    native?.writeJournalEntry?.({
      title: deriveTitle(text),
      body: text,
      source_type: 'voice',
      meta: { entry_mode: 'manual' }
    });
    setStatus('Journal saved');
  }

  function withdrawEmail() {
    const text = transcript?.textContent?.trim() || '';
    if (!text) {
      setStatus('Need transcript');
      return;
    }
    native?.requestEmailWithdrawal?.({
      title: deriveTitle(text),
      body: text,
      source_type: 'voice',
      meta: { entry_mode: 'withdrawal', approval_state: 'pending' }
    });
    setStatus('Withdrawal queued');
  }

  voicePanel?.addEventListener('pointerdown', event => {
    if (!voicePanel.classList.contains('active')) return;
    event.preventDefault();
    if (!listening) startListening();
  });
  voicePanel?.addEventListener('pointerup', event => {
    if (!listening) return;
    event.preventDefault();
    stopListening(true);
  });
  voicePanel?.addEventListener('pointercancel', () => {
    if (listening) stopListening(true);
  });
  cameraPanel?.addEventListener('pointerdown', event => {
    if (!cameraPanel.classList.contains('active')) return;
    event.preventDefault();
  });
  cameraPanel?.addEventListener('pointerup', async event => {
    if (!cameraPanel.classList.contains('active')) return;
    event.preventDefault();
    await window.StructaCamera?.capture?.();
  });
  tray?.addEventListener('click', event => {
    if (event.target === tray) closeTray();
  });

  window.StructaVoice = Object.freeze({
    open: startListening,
    stop: stopListening,
    setPanel,
    openTray,
    closeTray,
    saveJournal,
    withdrawEmail,
    setStatus,
    setTranscript: text => { if (transcript) transcript.textContent = String(text || 'Awaiting PTT.'); },
    get listening() { return listening; }
  });
})();
