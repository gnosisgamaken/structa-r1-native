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
  const queue = window.StructaProcessingQueue;
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
  let analysisQueueTimer = null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function captureEntryId(capture) {
    return capture?.entry_id || capture?.id || capture?.node_id || capture?.capture_image || capture?.meta?.bundle_id || '';
  }

  function capturePreviewData(capture) {
    return capture?.preview_data || capture?.data || capture?.image_asset?.data || capture?.meta?.preview_data || '';
  }

  function findCaptureRefs(project, entryId, nodeId) {
    const captures = project.captures || [];
    const nodes = project.nodes || [];
    const capture = captures.find(function(item) {
      return captureEntryId(item) === entryId || (nodeId && item.node_id === nodeId);
    }) || null;
    const node = nodes.find(function(item) {
      return item.node_id === nodeId || item.capture_image === entryId || item.meta?.bundle_id === entryId;
    }) || null;
    return { capture: capture, node: node, nodes: nodes };
  }

  function pendingAnalysisCount() {
    const project = native?.getProjectMemory?.() || {};
    return (project.captures || []).filter(function(capture) {
      return lower(capture?.meta?.analysis_status || '') === 'pending' && capturePreviewData(capture);
    }).length;
  }

  function getPendingAnalysisJobs() {
    const project = native?.getProjectMemory?.() || {};
    return (project.captures || [])
      .filter(function(capture) {
        return lower(capture?.meta?.analysis_status || '') === 'pending' && capturePreviewData(capture);
      })
      .map(function(capture) {
        const entryId = captureEntryId(capture);
        return {
          entryId: entryId,
          nodeId: capture?.node_id || '',
          createdAt: capture?.meta?.analysis_enqueued_at || capture?.captured_at || capture?.created_at || capture?.meta?.captured_at || '',
          previewData: capturePreviewData(capture),
          annotation: capture?.voice_annotation || capture?.prompt_text || '',
          facingMode: capture?.meta?.facingMode || 'environment'
        };
      })
      .filter(function(job) { return !!job.entryId && !!job.previewData; })
      .sort(function(a, b) {
        return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      });
  }

  function scheduleAnalysisDrain(delay) {
    if (analysisQueueTimer) return;
    analysisQueueTimer = setTimeout(function() {
      analysisQueueTimer = null;
      syncAnalysisQueue();
    }, typeof delay === 'number' ? delay : 180);
  }

  function markCaptureAnalysisQueued(entryId, nodeId, dataUrl) {
    native?.touchProjectMemory?.(function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      const timestamp = new Date().toISOString();
      if (refs.capture) {
        refs.capture.preview_data = refs.capture.preview_data || dataUrl;
        refs.capture.data = refs.capture.data || dataUrl;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'pending',
          analysis_enqueued_at: refs.capture.meta?.analysis_enqueued_at || timestamp,
          preview_data: refs.capture.preview_data || dataUrl
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'pending',
          analysis_enqueued_at: refs.node.meta?.analysis_enqueued_at || timestamp,
          preview_data: refs.node.meta?.preview_data || dataUrl
        };
      }
    });
  }

  function applyAnalysisReady(job, result, insightNode) {
    native?.touchProjectMemory?.(function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        refs.capture.summary = result.clean;
        refs.capture.ai_analysis = result.clean;
        refs.capture.prompt_text = job.annotation || refs.capture.prompt_text || '';
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.data = refs.capture.data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'ready',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData
        };
      }
      if (refs.node) {
        refs.node.body = result.clean;
        refs.node.tags = Array.isArray(refs.node.tags) ? refs.node.tags : [];
        if (job.annotation && refs.node.tags.indexOf('show-tell') === -1) refs.node.tags.push('show-tell');
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'ready',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData
        };
        if (insightNode && insightNode.node_id) {
          refs.node.links = Array.isArray(refs.node.links) ? refs.node.links : [];
          if (refs.node.links.indexOf(insightNode.node_id) === -1) refs.node.links.push(insightNode.node_id);
          const linkedInsight = refs.nodes.find(function(node) { return node.node_id === insightNode.node_id; });
          if (linkedInsight) {
            linkedInsight.links = Array.isArray(linkedInsight.links) ? linkedInsight.links : [];
            if (linkedInsight.links.indexOf(refs.node.node_id) === -1) linkedInsight.links.push(refs.node.node_id);
          }
        }
      }
      native?.updateUIState?.({
        last_capture_summary: result.clean,
        last_insight_summary: result.clean
      });
    });
  }

  function applyAnalysisUnavailable(job, fallbackText) {
    native?.touchProjectMemory?.(function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        refs.capture.summary = fallbackText;
        refs.capture.ai_analysis = '';
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.data = refs.capture.data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'unavailable',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData
        };
      }
      if (refs.node) {
        refs.node.body = job.annotation || 'frame saved';
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'unavailable',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData
        };
      }
    });
  }

  function skipBlockedAnalysis(entryId, nodeId) {
    if (!entryId && !nodeId) return false;
    const payload = {
      entryId: entryId || '',
      nodeId: nodeId || '',
      previewData: '',
      annotation: '',
      facingMode: 'environment'
    };
    applyAnalysisUnavailable(payload, 'frame saved');
    native?.appendLogEntry?.({ kind: 'camera', message: 'visual insight unavailable' });
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return true;
  }

  function imageAnalysisPayload(job) {
    return {
      entryId: job.entryId,
      nodeId: job.nodeId,
      previewData: job.previewData,
      annotation: job.annotation || '',
      facingMode: job.facingMode || 'environment'
    };
  }

  function queueHasImageJob(entryId) {
    if (!queue) return false;
    return queue.snapshot().some(function(job) {
      return job.kind === 'image-analyze' && job.payload?.entryId === entryId;
    });
  }

  function syncAnalysisQueue() {
    if (document.visibilityState === 'hidden' || !queue) return;
    const jobs = getPendingAnalysisJobs();
    if (!jobs.length) return;
    jobs.forEach(function(job) {
      if (queueHasImageJob(job.entryId)) return;
      queue.enqueue({
        kind: 'image-analyze',
        priority: 'P1',
        payload: imageAnalysisPayload(job),
        origin: {
          screen: 'show',
          itemId: job.entryId
        },
        timeoutMs: 28000
      });
    });
  }

  if (queue && !window.__STRUCTA_CAMERA_QUEUE_REGISTERED__) {
    window.__STRUCTA_CAMERA_QUEUE_REGISTERED__ = true;
    queue.registerHandler('image-analyze', function(job) {
      const payload = job.payload || {};
      const rawBase64 = String(payload.previewData || '').split(',').pop();
      if (!rawBase64 || !window.StructaLLM?.processImage) {
        return {
          ok: false,
          blocked: true,
          message: 'visual analysis stalled — tap to retry, double side skips'
        };
      }

      const projectBefore = native?.getProjectMemory?.() || {};
      const hadAnalyzedCaptures = (projectBefore.captures || []).some(function(capture) {
        return captureEntryId(capture) !== payload.entryId && lower(capture?.meta?.analysis_status || '') === 'ready';
      });
      const desc = 'User captured a ' + (payload.facingMode || 'environment') + ' photo';

      return Promise.race([
        window.StructaLLM.processImage(rawBase64, desc, {
          facingMode: payload.facingMode,
          voiceAnnotation: payload.annotation,
          priority: 'low'
        }),
        new Promise(function(resolve) {
          setTimeout(function() {
            resolve({ ok: false, reason: 'timeout' });
          }, 28000);
        })
      ]).then(function(result) {
        if (result && result.ok && result.clean) {
          const insightNode = window.StructaLLM.storeAsInsight(result, payload.annotation ? 'show-tell' : 'capture');
          applyAnalysisReady(payload, result, insightNode);
          native?.appendLogEntry?.({ kind: 'llm', message: payload.annotation ? 'show+tell insight ready' : 'visual insight ready' });
          if (!hadAnalyzedCaptures) window.StructaLLM?.speakMilestone?.('first_capture');
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'visual-insight' }
          }));
          return result;
        }
        return {
          ok: false,
          blocked: true,
          message: 'visual analysis stalled — tap to retry, double side skips'
        };
      }).catch(function() {
        return {
          ok: false,
          blocked: true,
          message: 'visual analysis stalled — tap to retry, double side skips'
        };
      });
    });
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

    const analysisQueuedAt = new Date().toISOString();
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
        analysis_status: 'pending',
        analysis_enqueued_at: analysisQueuedAt
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
        meta: {
          bundle_id: bundle?.entry_id || null,
          facingMode: facingMode,
          analysis_status: 'pending',
          analysis_enqueued_at: analysisQueuedAt,
          preview_data: dataUrl
        }
      });
    }

    hideOverlay();
    markCaptureAnalysisQueued(bundle?.entry_id || '', captureNode?.node_id || '', dataUrl);
    scheduleAnalysisDrain(120);

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
  window.addEventListener('focus', function() { scheduleAnalysisDrain(180); });
  window.addEventListener('pageshow', function() { scheduleAnalysisDrain(180); });
  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') scheduleAnalysisDrain(180);
  });
  window.addEventListener('structa-memory-updated', function() {
    scheduleAnalysisDrain(180);
  });
  setTimeout(function() { scheduleAnalysisDrain(240); }, 320);

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
    pendingAnalysisCount,
    scheduleAnalysisDrain,
    skipBlockedAnalysis,
    get voiceStripActive() { return voiceStripActive; },
    get voiceStripTranscript() { return voiceStripTranscript; },
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return streamReady; }
  });
})();
