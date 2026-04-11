(() => {
  const native = window.StructaNative;
  const transcript = document.getElementById('voice-transcript');
  const status = document.getElementById('voice-status');
  const btnStart = document.getElementById('voice-start');
  const btnStop = document.getElementById('voice-stop');
  const btnSubmit = document.getElementById('voice-submit');
  const tray = document.getElementById('capture-tray');
  const tabVoice = document.getElementById('tab-voice');
  const tabCamera = document.getElementById('tab-camera');
  const closeBtn = document.getElementById('capture-close');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function openTray() {
    tray?.classList.add('open');
    tray?.setAttribute('aria-hidden', 'false');
  }

  function closeTray() {
    tray?.classList.remove('open');
    tray?.setAttribute('aria-hidden', 'true');
    stopListening(false);
  }

  function setPanel(panel) {
    document.querySelectorAll('#capture-tray .capture-panel').forEach(el => {
      el.classList.toggle('active', el.dataset.panel === panel);
    });
    tabVoice?.classList.toggle('active', panel === 'voice');
    tabCamera?.classList.toggle('active', panel === 'camera');
    openTray();
  }

  function stopListening(emit = true) {
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    listening = false;
    setStatus('Idle');
    if (emit) {
      const text = transcript?.value?.trim() || '';
      if (text && native?.stopPTT) native.stopPTT(text);
    }
  }

  function startListening() {
    openTray();
    setPanel('voice');
    setStatus('Listening...');
    native?.startPTT?.();

    if (!SR) {
      listening = false;
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
          else if (!transcript.value) transcript.value = part;
        }
        if (finalText) transcript.value = (transcript.value + ' ' + finalText).trim();
      };
      recognition.onerror = () => setStatus('Mic error');
      recognition.onend = () => {
        listening = false;
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

  function submitTranscript() {
    const text = transcript?.value?.trim() || '';
    if (!text) {
      setStatus('Need transcript');
      return;
    }
    native?.stopPTT?.(text);
    setStatus('Submitted');
  }

  btnStart?.addEventListener('click', startListening);
  btnStop?.addEventListener('click', () => stopListening(true));
  btnSubmit?.addEventListener('click', submitTranscript);
  tabVoice?.addEventListener('click', () => setPanel('voice'));
  tabCamera?.addEventListener('click', () => setPanel('camera'));
  closeBtn?.addEventListener('click', closeTray);

  window.StructaVoice = Object.freeze({
    open: startListening,
    stop: stopListening,
    setPanel,
    openTray,
    closeTray,
    submitTranscript,
    setStatus,
    get listening() { return listening; }
  });
})();
