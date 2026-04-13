/**
 * camera-capture.js — Camera for R1 with user-gesture acquisition.
 *
 * getUserMedia MUST be called synchronously from within a trusted event handler.
 * All previous attempts failed because getUserMedia was called from async callbacks.
 *
 * Strategy:
 * - expose openFromGesture() — called directly from pointerup/pttStart handler.
 *   This calls getUserMedia SYNCHRONOUSLY (no await before it).
 * - If stream is already live, openFromGesture() just shows the overlay.
 * - Stream is never stopped between opens (persistent).
 */
(() => {
  const native = window.StructaNative;
  const overlay = document.getElementById('camera-overlay');
  const preview = document.getElementById('camera-preview');
  const canvas = document.getElementById('camera-canvas');
  const status = document.getElementById('camera-status');

  let stream = null;
  let facingMode = 'environment';
  let lastBundle = null;
  let flipLocked = false;
  let streamReady = false;

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function showOverlay() {
    document.getElementById('app')?.classList.add('overlay-active');
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
    window.dispatchEvent(new CustomEvent('structa-camera-open'));
  }

  function hideOverlay() {
    overlay?.classList.remove('open');
    overlay?.setAttribute('aria-hidden', 'true');
    document.getElementById('app')?.classList.remove('overlay-active');
    window.dispatchEvent(new CustomEvent('structa-camera-close'));
  }

  function killStream() {
    streamReady = false;
    if (stream) {
      try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      stream = null;
    }
    if (preview) preview.srcObject = null;
    setStatus('idle');
  }

  async function attachPreview() {
    if (!preview) return true;
    preview.srcObject = stream;
    await preview.play().catch(() => {});
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (preview.readyState >= 2 && preview.videoWidth > 0) return true;
      if (!preview.paused) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    return preview.videoWidth > 0 || preview.readyState >= 2;
  }

  /**
   * openFromGesture — MUST be called synchronously from a pointerup handler.
   * This is the entry point. getUserMedia is called here, not in any callback.
   *
   * Returns: nothing. The overlay is shown when the stream becomes ready.
   */
  function openFromGesture(mode) {
    const target = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';

    // Show overlay IMMEDIATELY — prevents black flash on PTT cold start
    showOverlay();

    // 1. Stream already live — just attach
    if (streamReady && stream) {
      if (target !== facingMode) {
        flip();
        return;
      }
      return;
    }

    // 2. Check if cascade already primed a stream for us
    const primed = window.__STRUCTA_PRIMED_STREAM__;
    if (primed && primed.active) {
      stream = primed;
      facingMode = target;
      streamReady = true;
      if (preview) preview.srcObject = stream;
      native?.setCameraFacing?.(facingMode);
      setStatus('ready');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('no getUserMedia');
      return;
    }

    facingMode = target;
    setStatus('acquiring');

    // 3. getUserMedia called NOW — still inside the synchronous event handler chain.
    navigator.mediaDevices.getUserMedia({ video: { facingMode } })
      .then(async (mediaStream) => {
        stream = mediaStream;
        window.__STRUCTA_PRIMED_STREAM__ = stream;
        const ready = await attachPreview();
        if (!ready) {
          killStream();
          setStatus('preview not ready');
          return;
        }
        streamReady = true;
        native?.setCameraFacing?.(facingMode);
        setStatus('ready');
      })
      .catch(err => {
        killStream();
        setStatus(`gm: ${err?.name || err?.message || 'denied'}`);
      });
  }

  async function flip() {
    if (flipLocked || !streamReady) return;
    flipLocked = true;
    try {
      const nextMode = facingMode === 'user' ? 'environment' : 'user';
      killStream();
      // Flip is triggered from scroll which is a trusted gesture
      navigator.mediaDevices.getUserMedia({ video: { facingMode: nextMode } })
        .then(async (mediaStream) => {
          stream = mediaStream;
          facingMode = nextMode;
          await attachPreview();
          streamReady = true;
          native?.setCameraFacing?.(facingMode);
          setStatus('ready');
        })
        .catch(() => { killStream(); setStatus('flip failed'); });
    } finally {
      setTimeout(() => { flipLocked = false; }, 200);
    }
  }

  async function capture() {
    if (!preview || !stream) return null;
    const w = preview.videoWidth || 720;
    const h = preview.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(preview, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/png');
    const imageAsset = {
      kind: 'capture',
      name: `camera-${Date.now()}.png`,
      mime_type: 'image/png',
      data: dataUrl,
      meta: { facingMode, width: w, height: h, captured_at: new Date().toISOString() }
    };
    const bundle = window.StructaCaptureBundles?.createCaptureBundle?.({
      source_type: 'camera',
      input_type: 'image',
      image_asset: imageAsset,
      prompt_text: facingMode === 'user' ? 'selfie capture' : 'camera capture',
      summary: facingMode === 'user' ? 'selfie captured' : 'camera frame captured',
      approval_state: 'draft',
      tags: [facingMode, 'capture'],
      links: [],
      meta: { facingMode, width: w, height: h }
    });
    lastBundle = bundle;
    native?.storeCaptureBundle?.(bundle);
    native?.sendStructuredMessage?.({
      verb: 'capture',
      target: 'capture',
      input_type: 'capture-bundle',
      source_type: 'camera',
      intent: `capture ${facingMode} image`,
      goal: 'store visual context bundle',
      approval_mode: 'human_required',
      fallback: 'store-only',
      payload: bundle
    });
    // Send capture context to LLM for structured insight
    // Magic Kamera pattern: send imageBase64 via PluginMessageHandler
    var imageDesc = `User captured a ${facingMode} photo (${w}x${h})`;
    native?.appendLogEntry?.({ kind: 'camera', message: 'image stored: ' + w + 'x' + h + ' ' + facingMode });

    // Send image to R1 LLM for analysis
    // Official SDK format: { message, imageBase64, useLLM, wantsR1Response }
    var analysisPrompt = 'what do you see? 5 words max.';
    if (typeof PluginMessageHandler !== 'undefined') {
      try {
        PluginMessageHandler.postMessage(JSON.stringify({
          message: analysisPrompt,
          imageBase64: dataUrl,
          useLLM: true,
          wantsR1Response: false
        }));
        native?.appendLogEntry?.({ kind: 'llm', message: 'image sent to r1 llm' });
      } catch (err) {
        native?.appendLogEntry?.({ kind: 'llm', message: 'image send err: ' + (err?.message || 'failed') });
      }
    }

    // R1 LLM handles the analysis above — no local LLM path needed
    hideOverlay();
    return bundle;
  }

  function close() {
    hideOverlay();
  }

  // Overlay interactions — scroll=flip, tap=capture
  overlay?.addEventListener('wheel', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    flip();
  }, { passive: false });

  overlay?.addEventListener('pointerup', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    event.stopPropagation();
    // Touch activation mode: PTT pressed on "show" card, camera needs trusted touch
    if (overlay.classList.contains('touch-activate')) {
      overlay.classList.remove('touch-activate');
      openFromGesture();
      return;
    }
    // Normal mode: capture image
    capture();
  });

  window.addEventListener('pagehide', killStream);

  window.StructaCamera = Object.freeze({
    openFromGesture,
    capture,
    flip,
    close,
    stop: close,
    teardown: killStream,
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return streamReady; }
  });
})();
