(() => {
  const native = window.StructaNative;
  const tray = document.getElementById('capture-tray');
  const preview = document.getElementById('camera-preview');
  const canvas = document.getElementById('camera-canvas');
  const status = document.getElementById('camera-status');


  let stream = null;
  let facingMode = 'environment';
  let lastBundle = null;
  let captureArmed = false;

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
  }

  function pause() {
    stopStream();
  }

  function teardown() {
    stopStream();
    closeTray();
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    if (preview) preview.srcObject = null;
    setStatus('Camera idle');
  }

  async function openCamera(mode = facingMode) {
    openTray();
    const nextMode = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';
    if (stream && nextMode === facingMode) return { ok: true, facingMode };
    facingMode = nextMode;

    const safeBrowser = !navigator.webdriver && window.isSecureContext !== false;
    if (!safeBrowser || !navigator.mediaDevices?.getUserMedia) {
      setStatus('Camera unavailable');
      native?.openCamera?.(facingMode);
      return { ok: false };
    }

    stopStream();
    try {
      native?.openCamera?.(facingMode);
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
      if (preview) {
        preview.srcObject = stream;
        await preview.play().catch(() => {});
      }
      setStatus(facingMode === 'user' ? 'Selfie ready' : 'Camera ready');
      return { ok: true };
    } catch (error) {
      setStatus('Camera blocked');
      return { ok: false, error };
    }
  }

  async function captureFrame() {
    if (!preview || !stream) {
      setStatus('Open camera first');
      return null;
    }

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

    const bundle = {
      project_code: window.StructaContracts?.baseProjectCode || 'PRJ-STRUCTA-R1',
      entry_id: window.StructaContracts?.makeEntryId?.('capture') || `capture-${Date.now()}`,
      source_type: 'camera',
      input_type: 'image',
      captured_at: new Date().toISOString(),
      image_asset: imageAsset,
      prompt_text: facingMode === 'user' ? 'selfie capture' : 'camera capture',
      ai_response: '',
      summary: facingMode === 'user' ? 'Selfie captured' : 'Camera frame captured',
      approval_state: 'draft',
      tags: [facingMode, 'capture'],
      links: [],
      meta: { facingMode, width: w, height: h }
    };

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

    setStatus('Saved');
    window.StructaPanel?.showCapture?.(bundle);
    return bundle;
  }

  function setSelfieMode() {
    return openCamera('user');
  }

  function flipFacing() {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    return openCamera(nextMode);
  }

  preview?.addEventListener('click', event => {
    event.preventDefault();
  });
  tray?.addEventListener('wheel', event => {
    if (!stream) return;
    event.preventDefault();
    const wheelUp = event.deltaY < 0;
    return openCamera(wheelUp ? 'user' : 'environment');
  }, { passive: false });
  const cameraPanel = tray?.querySelector('.capture-panel[data-panel="camera"]');
  cameraPanel?.addEventListener('pointerdown', event => {
    if (!stream || !cameraPanel.classList.contains('active')) return;
    event.preventDefault();
    captureArmed = true;
  });
  cameraPanel?.addEventListener('pointerup', async event => {
    if (!captureArmed) return;
    event.preventDefault();
    captureArmed = false;
    await captureFrame().catch(() => {});
  });
  cameraPanel?.addEventListener('pointercancel', () => {
    captureArmed = false;
  });
  window.StructaCamera = Object.freeze({
    open: openCamera,
    capture: captureFrame,
    selfie: setSelfieMode,
    flip: flipFacing,
    stop: teardown,
    pause,
    teardown,
    setStatus,
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; }
  });
})();
