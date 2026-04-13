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
  let warmupPromise = null;

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

  async function warmup(mode = facingMode) {
    if (cameraPrimed) return { ok: true, primed: true, facingMode };
    if (warmupPromise) return warmupPromise;
    const nextMode = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false };
    warmupPromise = (async () => {
      facingMode = nextMode;
      stopStream();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
        if (preview) {
          preview.srcObject = stream;
          await preview.play().catch(() => {});
        }
        cameraPrimed = true;
        native?.setCameraFacing?.(facingMode);
        stopStream();
        return { ok: true, primed: true, facingMode };
      } catch (error) {
        stopStream();
        return { ok: false, error };
      } finally {
        warmupPromise = null;
      }
    })();
    return warmupPromise;
  }

  async function waitForPreviewReady(timeout = 900) {
    if (!preview) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if ((preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0) || !preview.paused) {
        return true;
      }
      await preview.play().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return preview.readyState >= 2 || preview.videoWidth > 0;
  }

  async function open(mode = facingMode) {
    showOverlay();
    const nextMode = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';
    if (stream && nextMode === facingMode) return { ok: true, facingMode };
    facingMode = nextMode;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('camera unavailable');
      return { ok: false };
    }
    if (!cameraPrimed) await warmup(facingMode);
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
      if (preview) {
        preview.srcObject = stream;
        await preview.play().catch(() => {});
      }
      const ready = await waitForPreviewReady();
      if (!ready) {
        setStatus('warming');
        return { ok: false, error: new Error('camera preview not ready') };
      }
      cameraPrimed = true;
      native?.setCameraFacing?.(facingMode);
      setStatus('ready');
      return { ok: true, facingMode };
    } catch (error) {
      setStatus('blocked');
      return { ok: false, error };
    }
  }

  async function flip() {
    if (flipLocked) return { ok: false, locked: true, facingMode };
    flipLocked = true;
    try {
      return await open(facingMode === 'user' ? 'environment' : 'user');
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
    hideOverlay();
  }

  overlay?.addEventListener('wheel', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    flip();
  }, { passive: false });

  overlay?.addEventListener('pointerup', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    close();
  });

  const cleanupOnHide = () => {
    if (document.hidden || overlay?.classList.contains('open')) close();
  };

  window.addEventListener('pagehide', cleanupOnHide);
  document.addEventListener('visibilitychange', cleanupOnHide);

  window.StructaCamera = Object.freeze({
    open,
    warmup,
    capture,
    flip,
    close,
    stop: close,
    teardown: close,
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return cameraPrimed; }
  });

  setTimeout(() => {
    void warmup().catch(() => {});
  }, 180);
})();
