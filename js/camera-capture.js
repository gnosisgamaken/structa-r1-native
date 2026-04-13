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
  let cameraPrimed = false;
  let openInFlight = false;

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

  function stopStream() {
    if (stream) {
      try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
      stream = null;
    }
    if (preview) preview.srcObject = null;
    setStatus('idle');
  }

  async function waitForPreviewReady(timeout = 1200) {
    if (!preview) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0) return true;
      if (!preview.paused) return true;
      await preview.play().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    // Last chance: accept if paused but has dimensions
    return preview.videoWidth > 0 || preview.readyState >= 2;
  }

  // Core getUserMedia acquisition — called only when we have a user-gesture budget.
  async function acquireStream(mode) {
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, error: new Error('no getUserMedia') };
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode }, audio: false });
      if (preview) {
        preview.srcObject = stream;
        await preview.play().catch(() => {});
      }
      const ready = await waitForPreviewReady();
      if (!ready) {
        stopStream();
        return { ok: false, error: new Error('preview not ready') };
      }
      return { ok: true };
    } catch (error) {
      stopStream();
      return { ok: false, error };
    }
  }

  // open() — always called from a user-gesture context (touch or rAF from PTT handler).
  // Does NOT show overlay until stream is confirmed live.
  async function open(mode = facingMode) {
    if (openInFlight) return { ok: false, busy: true };
    openInFlight = true;
    try {
      const nextMode = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';

      // Already have a live stream on the right facing mode — just show overlay.
      if (stream && nextMode === facingMode && preview?.srcObject) {
        await preview.play().catch(() => {});
        showOverlay();
        cameraPrimed = true;
        native?.setCameraFacing?.(facingMode);
        setStatus('ready');
        return { ok: true, facingMode };
      }

      facingMode = nextMode;
      setStatus('starting');

      const result = await acquireStream(facingMode);
      if (!result.ok) {
        setStatus('blocked');
        return { ok: false, error: result.error };
      }

      cameraPrimed = true;
      native?.setCameraFacing?.(facingMode);
      setStatus('ready');
      // Only show overlay once stream is confirmed live — eliminates grey screen.
      showOverlay();
      return { ok: true, facingMode };
    } finally {
      openInFlight = false;
    }
  }

  async function flip() {
    if (flipLocked) return { ok: false, locked: true, facingMode };
    flipLocked = true;
    try {
      const nextMode = facingMode === 'user' ? 'environment' : 'user';
      facingMode = nextMode;
      const result = await acquireStream(facingMode);
      if (result.ok) {
        native?.setCameraFacing?.(facingMode);
        setStatus('ready');
      }
      return result.ok ? { ok: true, facingMode } : result;
    } finally {
      setTimeout(() => { flipLocked = false; }, 180);
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
    close();
    return bundle;
  }

  function close() {
    stopStream();
    cameraPrimed = false;
    openInFlight = false;
    hideOverlay();
  }

  // Overlay scroll = flip camera.
  overlay?.addEventListener('wheel', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    flip();
  }, { passive: false });

  // Overlay tap = capture (not close).
  // PTT is handled by sideClick / longPressStart at the app level.
  // Tapping the live overlay should capture, not dismiss.
  overlay?.addEventListener('pointerup', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    event.stopPropagation();
    capture();
  });

  const cleanupOnHide = () => {
    if (document.hidden) close();
  };

  window.addEventListener('pagehide', cleanupOnHide);
  document.addEventListener('visibilitychange', cleanupOnHide);

  window.StructaCamera = Object.freeze({
    open,
    capture,
    flip,
    close,
    stop: close,
    teardown: close,
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return cameraPrimed; }
  });

  // Pre-warm: silently acquire + immediately release stream on app load.
  // This grants getUserMedia permission context so PTT can reuse it instantly.
  window.addEventListener('load', () => {
    setTimeout(async () => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        s.getTracks().forEach(t => t.stop());
        cameraPrimed = true;
      } catch (_) {}
    }, 120);
  });
})();
