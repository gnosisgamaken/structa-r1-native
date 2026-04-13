/**
 * camera-capture.js
 *
 * Strategy:
 * - On app load, acquire the camera stream immediately via getUserMedia
 *   (this is inside the page load, which counts as a trusted context on Rabbit).
 * - Keep the stream ALIVE in the background. Never stop it between opens.
 * - When PTT fires, just show the overlay on top of the already-live preview.
 *   No getUserMedia call needed at PTT time — the stream is already there.
 * - On close, hide the overlay but keep the stream running.
 * - Only stop the stream on page hide / app teardown.
 *
 * This eliminates the getUserMedia-on-PTT race entirely.
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
  let streamReady = false;    // stream is live and preview is playing
  let streamPending = null;   // promise while acquiring

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

  // Hard stop — only call on app teardown or page hide.
  function killStream() {
    streamReady = false;
    streamPending = null;
    if (stream) {
      try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      stream = null;
    }
    if (preview) preview.srcObject = null;
    setStatus('idle');
  }

  async function waitForPreviewReady(timeout = 2000) {
    if (!preview) return true;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (preview.readyState >= 2 && preview.videoWidth > 0) return true;
      if (!preview.paused) return true;
      await preview.play().catch(() => {});
      await new Promise(r => setTimeout(r, 60));
    }
    return preview.videoWidth > 0 || preview.readyState >= 2;
  }

  // Acquire stream and attach to preview. Returns promise<bool>.
  // Safe to call multiple times — deduped via streamPending.
  function ensureStream(mode) {
    const targetMode = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';

    // Already live on right mode
    if (streamReady && stream && facingMode === targetMode && preview?.srcObject) {
      return Promise.resolve(true);
    }

    // Acquisition already in flight
    if (streamPending) return streamPending;

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('camera unavailable');
      return Promise.resolve(false);
    }

    streamPending = (async () => {
      try {
        // Stop old stream if switching modes
        if (stream && facingMode !== targetMode) {
          stream.getTracks().forEach(t => t.stop());
          stream = null;
          if (preview) preview.srcObject = null;
        }
        facingMode = targetMode;
        setStatus('starting');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        if (preview) {
          preview.srcObject = stream;
          await preview.play().catch(() => {});
        }
        const ready = await waitForPreviewReady();
        if (!ready) {
          killStream();
          setStatus('not ready');
          return false;
        }
        streamReady = true;
        native?.setCameraFacing?.(facingMode);
        setStatus('ready');
        return true;
      } catch (err) {
        killStream();
        setStatus('blocked');
        return false;
      } finally {
        streamPending = null;
      }
    })();

    return streamPending;
  }

  // open() — show camera overlay.
  // If stream is already live, shows instantly (zero latency on PTT).
  // If not yet acquired, acquires first then shows.
  async function open(mode = facingMode) {
    const ok = await ensureStream(mode);
    if (!ok) {
      setStatus('blocked');
      return { ok: false };
    }
    showOverlay();
    return { ok: true, facingMode };
  }

  async function flip() {
    if (flipLocked) return { ok: false, locked: true };
    flipLocked = true;
    try {
      const nextMode = facingMode === 'user' ? 'environment' : 'user';
      // Kill current stream so ensureStream acquires fresh one
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
        streamReady = false;
        if (preview) preview.srcObject = null;
      }
      const ok = await ensureStream(nextMode);
      return { ok, facingMode };
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
    // Hide overlay but KEEP stream alive for next open
    hideOverlay();
    return bundle;
  }

  // close() — hides overlay, keeps stream alive for instant re-open on next PTT.
  function close() {
    hideOverlay();
    // Do NOT kill stream — keep it ready for next PTT press.
  }

  // Overlay scroll = flip
  overlay?.addEventListener('wheel', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    flip();
  }, { passive: false });

  // Overlay tap = capture
  overlay?.addEventListener('pointerup', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    event.stopPropagation();
    capture();
  });

  // Kill stream only on actual app hide
  window.addEventListener('pagehide', killStream);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideOverlay();
      // Keep stream alive — R1 often hides/shows quickly
    }
  });

  window.StructaCamera = Object.freeze({
    open,
    capture,
    flip,
    close,
    stop: close,
    teardown: killStream,
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return streamReady; }
  });

  // CRITICAL: Acquire stream immediately on page load while we still have
  // a trusted browser context. This is the ONLY place we call getUserMedia.
  // PTT presses later just call showOverlay() on the already-live stream.
  const startupAcquire = () => {
    ensureStream('environment').then(ok => {
      if (ok) {
        // Stream is live and hidden in background — PTT will be instant
        setStatus('ready');
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startupAcquire);
  } else {
    // Already loaded
    setTimeout(startupAcquire, 0);
  }
})();
