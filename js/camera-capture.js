/**
 * camera-capture.js — Camera for R1 with user-gesture acquisition.
 *
 * Changes (2026-04-16):
 * - SHOW+TELL: PTT during camera opens a voice strip at bottom
 * - Voice annotation is captured alongside the image
 * - Image + voice go to LLM together via processImage({ voiceAnnotation })
 * - Audio engine: play capture sound on frame grab
 * - capture() now uses StructaLLM.processImage() for analysis
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
  let overlayVisible = false;
  let streamAcquiring = false;

  // === SHOW+TELL voice strip state ===
  let voiceStripActive = false;
  let voiceStripTranscript = '';
  let voiceStripRecognition = null;
  let voiceStripStopping = false;
  let pendingVoiceCapture = false;
  let pendingVoiceCaptureTimer = null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  async function readyOverlay(targetMode) {
    const ready = await attachPreview();
    if (!ready) {
      killStream();
      setStatus('preview unavailable');
      return false;
    }
    if (targetMode && targetMode !== facingMode) {
      facingMode = targetMode;
      native?.setCameraFacing?.(facingMode);
    }
    streamReady = true;
    setStatus('side click shoots');
    showOverlay();
    showOverlayReady();
    return true;
  }

  function showOverlay() {
    if (overlayVisible) return;
    overlayVisible = true;
    document.getElementById('app')?.classList.add('overlay-active');
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
  }

  function showOverlayReady() {
    window.dispatchEvent(new CustomEvent('structa-camera-open'));
  }

  function hideOverlay() {
    if (!overlayVisible) return;
    overlayVisible = false;
    stopVoiceStrip();
    overlay?.classList.remove('open');
    overlay?.setAttribute('aria-hidden', 'true');
    document.getElementById('app')?.classList.remove('overlay-active');
    window.dispatchEvent(new CustomEvent('structa-camera-close'));
  }

  function killStream() {
    streamReady = false;
    streamAcquiring = false;
    stopVoiceStrip();
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

  function openFromGesture(mode) {
    const target = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';

    if (streamReady && stream) {
      setStatus('opening');
      void readyOverlay(target).then(() => {
        if (target !== facingMode) flip();
      });
      return;
    }

    const primed = window.__STRUCTA_PRIMED_STREAM__;
    if (primed && primed.active) {
      stream = primed;
      facingMode = target;
      if (preview) preview.srcObject = stream;
      native?.setCameraFacing?.(facingMode);
      setStatus('opening');
      void readyOverlay(target);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('camera unavailable');
      return;
    }

    if (streamAcquiring) return;
    streamAcquiring = true;
    facingMode = target;
    setStatus('opening');

    navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { max: 640 }, height: { max: 480 } } })
      .then(async (mediaStream) => {
        streamAcquiring = false;
        stream = mediaStream;
        window.__STRUCTA_PRIMED_STREAM__ = stream;
        if (preview) preview.srcObject = stream;
        native?.setCameraFacing?.(facingMode);
        const ok = await readyOverlay(target);
        if (!ok) return;
      })
      .catch(err => {
        streamAcquiring = false;
        killStream();
        setStatus('camera blocked');
      });
  }

  async function flip() {
    if (flipLocked || !streamReady) return;
    flipLocked = true;
    try {
      const nextMode = facingMode === 'user' ? 'environment' : 'user';
      killStream();
      navigator.mediaDevices.getUserMedia({ video: { facingMode: nextMode, width: { max: 640 }, height: { max: 480 } } })
        .then(async (mediaStream) => {
          stream = mediaStream;
          facingMode = nextMode;
          await attachPreview();
          streamReady = true;
          native?.setCameraFacing?.(facingMode);
      setStatus('side click shoots');
        })
        .catch(() => { killStream(); setStatus('flip failed'); });
    } finally {
      setTimeout(() => { flipLocked = false; }, 200);
    }
  }

  // === SHOW+TELL voice strip ===

  function startVoiceStrip() {
    if (voiceStripActive) return;
    voiceStripActive = true;
    voiceStripStopping = false;
    pendingVoiceCapture = false;
    if (pendingVoiceCaptureTimer) {
      clearTimeout(pendingVoiceCaptureTimer);
      pendingVoiceCaptureTimer = null;
    }
    voiceStripTranscript = '';

    // Mute heartbeat audio during capture
    if (window.StructaAudio) window.StructaAudio.mute();

    // Show voice strip UI
    var strip = document.getElementById('camera-voice-strip');
    if (strip) {
      strip.classList.add('active');
      strip.querySelector('.strip-text').textContent = 'recording narration...';
    }
    setStatus('release to capture with narration');

    // Start R1 native STT if available
    if (typeof CreationVoiceHandler !== 'undefined') {
      try {
        window.__STRUCTA_PTT_TARGET__ = 'camera';
        CreationVoiceHandler.postMessage('start');
        return;
      } catch (e) {}
    }

    // Browser fallback: SpeechRecognition
    if (SR && !voiceStripRecognition) {
      voiceStripRecognition = new SR();
      voiceStripRecognition.lang = 'en-US';
      voiceStripRecognition.interimResults = true;
      voiceStripRecognition.continuous = true;
      voiceStripRecognition.onresult = function(event) {
        var text = '';
        for (var i = 0; i < event.results.length; i++) {
          text += (event.results[i][0] && event.results[i][0].transcript) || '';
        }
        voiceStripTranscript = text.trim();
        var stripEl = document.getElementById('camera-voice-strip');
        if (stripEl) {
          var textEl = stripEl.querySelector('.strip-text');
          if (textEl) textEl.textContent = voiceStripTranscript.slice(-40) || 'recording narration...';
        }
      };
      voiceStripRecognition.onerror = function() {};
      voiceStripRecognition.onend = function() {};
    }
    if (voiceStripRecognition) {
      try { voiceStripRecognition.start(); } catch (e) {}
    }
  }

  function stopVoiceStrip() {
    if (!voiceStripActive && !voiceStripStopping) return;
    voiceStripActive = false;
    voiceStripStopping = false;
    pendingVoiceCapture = false;
    if (pendingVoiceCaptureTimer) {
      clearTimeout(pendingVoiceCaptureTimer);
      pendingVoiceCaptureTimer = null;
    }
    window.__STRUCTA_PTT_TARGET__ = null;

    // Unmute audio
    if (window.StructaAudio) window.StructaAudio.unmute();

    // Stop recognition
    if (voiceStripRecognition) {
      try { voiceStripRecognition.stop(); } catch (e) {}
    }
    // Stop R1 STT
    if (typeof CreationVoiceHandler !== 'undefined') {
      try { CreationVoiceHandler.postMessage('stop'); } catch (e) {}
    }

    // Hide voice strip UI
    var strip = document.getElementById('camera-voice-strip');
    if (strip) {
      strip.classList.remove('active');
      var textEl = strip.querySelector('.strip-text');
      if (textEl) textEl.textContent = 'recording narration...';
    }
    setStatus('side click shoots');
  }

  function finalizeVoiceStripCapture() {
    if (!voiceStripActive && !voiceStripStopping) {
      capture();
      return;
    }
    voiceStripStopping = true;
    pendingVoiceCapture = true;
    window.__STRUCTA_PTT_TARGET__ = 'camera';
    setStatus('capturing...');

    if (voiceStripRecognition) {
      try { voiceStripRecognition.stop(); } catch (e) {}
    }
    if (typeof CreationVoiceHandler !== 'undefined') {
      try { CreationVoiceHandler.postMessage('stop'); } catch (e) {}
    }

    if (pendingVoiceCaptureTimer) clearTimeout(pendingVoiceCaptureTimer);
    pendingVoiceCaptureTimer = setTimeout(function() {
      pendingVoiceCaptureTimer = null;
      capture();
    }, 420);
  }

  // Listen for R1 STT results during voice strip
  window.addEventListener('structa-stt-ended', function(event) {
    if ((voiceStripActive || voiceStripStopping) && event && event.detail && event.detail.transcript) {
      voiceStripTranscript = event.detail.transcript;
      var strip = document.getElementById('camera-voice-strip');
      if (strip) {
        var textEl = strip.querySelector('.strip-text');
        if (textEl) textEl.textContent = voiceStripTranscript.slice(-40);
      }
      if (pendingVoiceCapture) {
        if (pendingVoiceCaptureTimer) {
          clearTimeout(pendingVoiceCaptureTimer);
          pendingVoiceCaptureTimer = null;
        }
        capture();
      }
    }
  });

  async function capture() {
    if (!preview || !stream) return null;
    const w = preview.videoWidth || 720;
    const h = preview.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(preview, 0, 0, w, h);
    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (_) {
      dataUrl = '';
    }
    if (!dataUrl) {
      native?.appendLogEntry?.({ kind: 'camera', message: 'frame capture failed — try again' });
      window.StructaAudio?.play?.('error');
      window.dispatchEvent(new CustomEvent('structa-capture-failed'));
      return null;
    }
    const rawBase64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

    if (pendingVoiceCaptureTimer) {
      clearTimeout(pendingVoiceCaptureTimer);
      pendingVoiceCaptureTimer = null;
    }

    // Grab voice annotation before stopping strip
    var annotation = voiceStripTranscript || '';
    stopVoiceStrip();

    // Play capture sound
    if (window.StructaAudio) {
      window.StructaAudio.init();
      window.StructaAudio.play('capture');
    }

    const imageAsset = {
      kind: 'capture',
      name: 'camera-' + Date.now() + '.png',
      mime_type: 'image/png',
      data: dataUrl,
      meta: { facingMode, width: w, height: h, captured_at: new Date().toISOString() }
    };
    const storedAsset = native?.storeAsset?.(imageAsset);
    const resolvedAsset = storedAsset && storedAsset.ok && storedAsset.payload
      ? { ...imageAsset, ...storedAsset.payload, meta: { ...(imageAsset.meta || {}), ...(storedAsset.payload.meta || {}) } }
      : imageAsset;

    const bundle = window.StructaCaptureBundles?.createCaptureBundle?.({
      source_type: 'camera',
      input_type: annotation ? 'image+voice' : 'image',
      image_asset: resolvedAsset,
      prompt_text: annotation || (facingMode === 'user' ? 'selfie capture' : 'camera capture'),
      summary: annotation ? 'show+tell captured' : 'image captured',
      approval_state: 'draft',
      tags: annotation ? [facingMode, 'capture', 'show-tell'] : [facingMode, 'capture'],
      links: [],
      meta: {
        facingMode, width: w, height: h, voiceAnnotation: annotation,
        image_asset_id: resolvedAsset.entry_id || '',
        image_asset_name: resolvedAsset.name || '',
        preview_data: dataUrl,
        analysis_status: 'pending'
      }
    });

    lastBundle = bundle;
    native?.storeCaptureBundle?.(bundle);
    native?.updateUIState?.({
      last_capture_entry_id: bundle?.entry_id || '',
      last_capture_summary: annotation ? 'show+tell captured' : 'image captured'
    });
    window.dispatchEvent(new CustomEvent('structa-capture-stored', {
      detail: { entryId: bundle?.entry_id || '', summary: bundle?.summary || '' }
    }));

    native?.appendLogEntry?.({ kind: 'camera', message: annotation ? 'show+tell captured' : 'image captured' });
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: annotation ? 'show-tell' : 'capture' }
    }));

    // Also store as node if available
    var captureNode = null;
    if (native?.addNode) {
      captureNode = native.addNode({
        type: 'capture',
        title: annotation ? 'show+tell: ' + annotation.slice(0, 40) : 'visual capture',
        body: annotation || 'visual capture',
        source: 'camera',
        capture_image: bundle?.entry_id || null,
        voice_annotation: annotation || null,
        tags: annotation ? ['show-tell', facingMode] : [facingMode],
        meta: { bundle_id: bundle?.entry_id || null, facingMode: facingMode, analysis_status: 'pending', preview_data: dataUrl }
      });
    }

    hideOverlay();

    const projectBefore = native?.getProjectMemory?.() || {};
    const hadAnalyzedCaptures = (projectBefore.captures || []).some(function(cap) {
      return lower(cap?.meta?.analysis_status || '') === 'ready';
    });

    function runAnalysis() {
      return Promise.race([
        window.StructaLLM.processImage(rawBase64, desc, {
          facingMode: facingMode,
          voiceAnnotation: annotation
        }),
        new Promise(function(resolve) {
          setTimeout(function() {
            resolve({ ok: false, reason: 'timeout' });
          }, 40000);
        })
      ]);
    }

    // Send to LLM with voice annotation context
    if (window.StructaLLM) {
      native?.appendLogEntry?.({ kind: 'camera', message: 'visual analysis queued' });
      var desc = 'User captured a ' + facingMode + ' photo (' + w + 'x' + h + ')';
      var analyze = function(attempt) {
        return runAnalysis().then(function(result) {
          if (result && result.ok && result.clean) {
            var insightNode = window.StructaLLM.storeAsInsight(result, annotation ? 'show-tell' : 'capture');
            native?.appendLogEntry?.({ kind: 'llm', message: annotation ? 'show+tell insight ready' : 'visual insight ready' });
            native?.touchProjectMemory?.(function(project) {
              var cap = (project.captures || []).find(function(c) { return c.id === bundle.entry_id; });
              if (cap) {
                cap.summary = result.clean;
                cap.ai_analysis = result.clean;
                cap.prompt_text = annotation || cap.prompt_text || '';
                cap.preview_data = cap.preview_data || dataUrl;
                cap.data = cap.data || dataUrl;
                cap.meta = { ...(cap.meta || {}), analysis_status: 'ready', preview_data: cap.preview_data || dataUrl };
              }
              var nodes = project.nodes || [];
              var node = captureNode ? nodes.find(function(n) { return n.node_id === captureNode.node_id; }) : nodes.find(function(n) {
                return n.type === 'capture' && (n.capture_image === bundle.entry_id || n.meta?.bundle_id === bundle.entry_id);
              });
              if (node) {
                node.body = result.clean;
                node.tags = Array.isArray(node.tags) ? node.tags : [];
                if (annotation && node.tags.indexOf('show-tell') === -1) node.tags.push('show-tell');
                node.meta = { ...(node.meta || {}), analysis_status: 'ready', preview_data: node.meta?.preview_data || dataUrl };
                if (insightNode && insightNode.node_id) {
                  node.links = Array.isArray(node.links) ? node.links : [];
                  if (node.links.indexOf(insightNode.node_id) === -1) node.links.push(insightNode.node_id);
                  var linkedInsight = nodes.find(function(n) { return n.node_id === insightNode.node_id; });
                  if (linkedInsight) {
                    linkedInsight.links = Array.isArray(linkedInsight.links) ? linkedInsight.links : [];
                    if (linkedInsight.links.indexOf(node.node_id) === -1) linkedInsight.links.push(node.node_id);
                  }
                }
              }
              native?.updateUIState?.({
                last_capture_summary: result.clean,
                last_insight_summary: result.clean
              });
            });
            if (!hadAnalyzedCaptures) {
              window.StructaLLM?.speakMilestone?.('first_capture');
            }
            window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
              detail: { source: 'visual-insight' }
            }));
            window.dispatchEvent(new CustomEvent('structa-memory-updated'));
          } else {
            if (result && result.reason === 'timeout') {
              native?.appendLogEntry?.({ kind: 'camera', message: 'visual analysis timed out' });
            }
            if (attempt === 0) return analyze(1);
            native?.touchProjectMemory?.(function(project) {
              var cap = (project.captures || []).find(function(c) { return c.id === bundle.entry_id; });
              if (cap) {
                cap.summary = annotation ? 'show+tell captured' : 'frame saved';
                cap.ai_analysis = '';
                cap.preview_data = cap.preview_data || dataUrl;
                cap.data = cap.data || dataUrl;
                cap.meta = { ...(cap.meta || {}), analysis_status: 'unavailable', preview_data: cap.preview_data || dataUrl };
              }
              var nodes = project.nodes || [];
              var node = captureNode ? nodes.find(function(n) { return n.node_id === captureNode.node_id; }) : nodes.find(function(n) {
                return n.type === 'capture' && (n.capture_image === bundle.entry_id || n.meta?.bundle_id === bundle.entry_id);
              });
              if (node) {
                node.body = annotation || 'frame saved';
                node.meta = { ...(node.meta || {}), analysis_status: 'unavailable', preview_data: node.meta?.preview_data || dataUrl };
              }
            });
            native?.appendLogEntry?.({ kind: 'camera', message: 'visual insight unavailable' });
          }
        })
        .catch(function() {
          if (attempt === 0) return analyze(1);
          native?.touchProjectMemory?.(function(project) {
            var cap = (project.captures || []).find(function(c) { return c.id === bundle.entry_id; });
            if (cap) {
              cap.summary = annotation ? 'show+tell captured' : 'frame saved';
              cap.ai_analysis = '';
              cap.preview_data = cap.preview_data || dataUrl;
              cap.data = cap.data || dataUrl;
              cap.meta = { ...(cap.meta || {}), analysis_status: 'unavailable', preview_data: cap.preview_data || dataUrl };
            }
            var nodes = project.nodes || [];
            var node = captureNode ? nodes.find(function(n) { return n.node_id === captureNode.node_id; }) : nodes.find(function(n) {
              return n.type === 'capture' && (n.capture_image === bundle.entry_id || n.meta?.bundle_id === bundle.entry_id);
            });
            if (node) {
              node.body = annotation || 'frame saved';
              node.meta = { ...(node.meta || {}), analysis_status: 'unavailable', preview_data: node.meta?.preview_data || dataUrl };
            }
          });
          native?.appendLogEntry?.({ kind: 'camera', message: 'visual insight failed' });
        });
      };
      analyze(0);
    }

    return bundle;
  }

  function close() {
    voiceStripActive = false;
    voiceStripTranscript = '';
    voiceStripStopping = false;
    pendingVoiceCapture = false;
    clearTimeout(pendingVoiceCaptureTimer);
    pendingVoiceCaptureTimer = null;
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
    // Don't capture if tapping inside voice strip
    if (event.target.closest && event.target.closest('#camera-voice-strip')) return;
    event.preventDefault();
    event.stopPropagation();
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
    startVoiceStrip,
    finalizeVoiceStripCapture,
    stopVoiceStrip,
    get voiceStripActive() { return voiceStripActive; },
    get voiceStripTranscript() { return voiceStripTranscript; },
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return streamReady; }
  });
})();
