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
  let recognition = null;
  let listening = false;

  function setStatus(text) {
    if (status) status.textContent = text;
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
    if (captureHint) captureHint.textContent = 'PTT first. Camera is preview-driven. Back closes.';
  }

  function setPanel(panel) {
    document.querySelectorAll('#capture-tray .capture-panel').forEach(el => {
      el.classList.toggle('active', el.dataset.panel === panel);
    });
    openTray();
    if (captureTitle) captureTitle.textContent = panel === 'camera' ? 'Camera' : 'Voice';
    if (captureHint) {
      captureHint.textContent = panel === 'camera'
        ? 'Tap preview to flip. Back closes.'
        : 'PTT first. Camera is preview-driven. Back closes.';
    }
    if (panel === 'camera') {
      window.StructaCamera?.open?.(window.StructaCamera?.facingMode || 'environment');
    } else {
      window.StructaCamera?.pause?.();
    }
  }

  function stopListening(emit = true) {
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
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
    }
  }

  function startListening() {
    openTray();
    setPanel('voice');
    if (btnStart) btnStart.textContent = 'Stop';
    setStatus('Listening...');
    if (transcript) transcript.textContent = 'Listening…';
    native?.startPTT?.();

    if (!SR) {
      listening = false;
      if (btnStart) btnStart.textContent = 'PTT';
      setStatus('Mic unavailable');
      return;
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
          else if (!transcript.textContent || transcript.textContent === 'Tap PTT to capture speech.') transcript.textContent = part;
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

  btnStart?.addEventListener('click', () => {
    if (listening) stopListening(true);
    else startListening();
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
    setTranscript: text => { if (transcript) transcript.textContent = String(text || 'Tap PTT to capture speech.'); },
    get listening() { return listening; }
  });
})();
