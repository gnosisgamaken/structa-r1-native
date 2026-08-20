/**
 * camera-capture.js — Camera for R1 with user-gesture acquisition.
 *
 * Changes (2026-04-16):
 * - SHOW+TELL: PTT during camera opens a voice strip at bottom
 * - Voice annotation is captured alongside the image
 * - Captures are saved first and remain usable even if native image callbacks do not return
 * - show+tell semantics come from the reliable Rabbit text lane via processImage({ voiceAnnotation })
 * - Audio engine: play capture sound on frame grab
 * - capture() still uses StructaLLM.processImage(), but that path is deterministic-by-default
 */
(() => {
  const native = window.StructaNative;
  const queue = window.StructaProcessingQueue;
  const visionProtocol = window.StructaVisionProtocol;
  const overlay = document.getElementById('camera-overlay');
  const preview = document.getElementById('camera-preview');
  const canvas = document.getElementById('camera-canvas');
  const status = document.getElementById('camera-status');
  const cancelButton = document.getElementById('camera-cancel');
  const cameraTransition = document.getElementById('camera-transition');
  const cameraTransitionLabel = document.getElementById('camera-transition-label');

  let stream = null;
  let facingMode = 'environment';
  let lastBundle = null;
  let flipLocked = false;
  let streamReady = false;
  let overlayVisible = false;
  let streamAcquiring = false;
  let cameraSessionEpoch = 0;
  let cameraSessionOpen = false;
  let acquisitionEpoch = 0;

  function isLabVisionProbeMode() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      return params.get('lab') === '1' && params.get('vision_probe') === '1';
    } catch (_) {
      return false;
    }
  }

  // === SHOW+TELL voice strip state ===
  let voiceStripActive = false;
  let voiceStripTranscript = '';
  let voiceStripRecognition = null;
  let voiceStripStopping = false;
  let pendingVoiceCapture = false;
  let pendingVoiceCaptureTimer = null;
  let voiceStripSession = null;
  let voiceStripSequence = 0;
  let analysisQueueTimer = null;
  let lastCaptureAt = 0;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const CAPTURE_COOLDOWN_MS = 600;
  const ANALYSIS_CAPTURE_WIDTH = 640;
  const THUMBNAIL_WIDTH = 256;
  const ANALYSIS_JPEG_QUALITY = 0.84;
  const THUMBNAIL_JPEG_QUALITY = 0.7;
  const CAMERA_READY_STATUS = 'tap frame to shoot · wheel flips';
  const MIN_FLIP_TRANSITION_MS = 180;
  const NATIVE_STT_TERMINAL_TIMEOUT_MS = Math.max(
    50,
    Number(window.__STRUCTA_CAMERA_STT_TIMEOUT_MS__ || 12000)
  );

  function nextVoiceStripRequestId() {
    voiceStripSequence += 1;
    return 'camera-stt-' + Date.now().toString(36) + '-' + voiceStripSequence.toString(36);
  }

  function getCaps() {
    return window.__structaCaps || {};
  }

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function activeProjectId() {
    return String(
      native?.getActiveProjectId?.()
      || native?.getProjectMemory?.()?.project_id
      || native?.getProjectMemory?.()?.id
      || ''
    );
  }

  function isOriginProjectActive(projectId) {
    return !projectId || activeProjectId() === String(projectId);
  }

  function touchOriginProject(projectId, mutator) {
    if (projectId && native?.touchProjectMemoryById) {
      return native.touchProjectMemoryById(projectId, mutator);
    }
    if (!isOriginProjectActive(projectId)) return null;
    return native?.touchProjectMemory?.(mutator) || null;
  }

  function setStatus(text) {
    if (status) status.textContent = String(text || '').toLowerCase();
  }

  function setFlipTransition(active, targetMode) {
    if (!cameraTransition) return;
    if (cameraTransitionLabel && targetMode) {
      cameraTransitionLabel.textContent = targetMode === 'user' ? 'front lens' : 'rear lens';
    }
    cameraTransition.classList.toggle('active', !!active);
    cameraTransition.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function waitForFlipBeat(startedAt) {
    const remaining = MIN_FLIP_TRANSITION_MS - (Date.now() - startedAt);
    return remaining > 0
      ? new Promise(function(resolve) { setTimeout(resolve, remaining); })
      : Promise.resolve();
  }

  function captureEntryId(capture) {
    return capture?.entry_id || capture?.id || capture?.node_id || capture?.capture_image || capture?.meta?.bundle_id || '';
  }

  function capturePreviewData(capture) {
    return capture?.preview_data || capture?.data || capture?.image_asset?.data || capture?.meta?.preview_data || '';
  }

  function captureAnalysisAssetId(capture) {
    return capture?.image_asset?.entry_id
      || capture?.meta?.image_asset_id
      || capture?.meta?.image_asset?.entry_id
      || '';
  }

  function getStoredAssetData(assetId) {
    if (!assetId) return '';
    const memory = native?.getMemory?.() || {};
    const asset = (memory.assets || []).find(function(item) {
      return item?.entry_id === assetId;
    });
    return asset?.data || '';
  }

  function hasAnalysisSource(capture) {
    return !!(captureAnalysisAssetId(capture) || capturePreviewData(capture));
  }

  function resolveJobMedia(payload) {
    const project = payload?.projectId && native?.getProjectMemoryById
      ? (native.getProjectMemoryById(payload.projectId) || {})
      : (native?.getProjectMemory?.() || {});
    const refs = findCaptureRefs(project, payload?.entryId || '', payload?.nodeId || '');
    const assetId = payload?.assetId || captureAnalysisAssetId(refs.capture) || refs.node?.meta?.image_asset_id || '';
    const previewData = capturePreviewData(refs.capture) || refs.node?.meta?.preview_data || '';
    return {
      assetId: assetId,
      analysisData: getStoredAssetData(assetId) || previewData,
      previewData: previewData
    };
  }

  function dataUrlMimeType(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)/i);
    return match ? String(match[1]).toLowerCase() : 'image/jpeg';
  }

  function createThumbnailDataUrl(dataUrl) {
    return new Promise(function(resolve) {
      const source = String(dataUrl || '');
      if (!source || typeof Image === 'undefined') {
        resolve('');
        return;
      }
      const image = new Image();
      image.onload = function() {
        const scale = Math.min(1, THUMBNAIL_WIDTH / Math.max(1, image.width));
        const targetWidth = Math.max(1, Math.round(image.width * scale));
        const targetHeight = Math.max(1, Math.round(image.height * scale));
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = targetWidth;
        thumbCanvas.height = targetHeight;
        const context = thumbCanvas.getContext('2d');
        if (!context) {
          resolve('');
          return;
        }
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        try {
          resolve(thumbCanvas.toDataURL('image/jpeg', THUMBNAIL_JPEG_QUALITY));
        } catch (_) {
          resolve('');
        }
      };
      image.onerror = function() { resolve(''); };
      image.src = source;
    });
  }

  function createThumbnailFromCanvas(sourceCanvas) {
    if (!sourceCanvas?.width || !sourceCanvas?.height) return '';
    const scale = Math.min(1, THUMBNAIL_WIDTH / Math.max(1, sourceCanvas.width));
    const targetWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
    const targetHeight = Math.max(1, Math.round(sourceCanvas.height * scale));
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = targetWidth;
    thumbCanvas.height = targetHeight;
    const context = thumbCanvas.getContext('2d');
    if (!context) return '';
    context.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
    try {
      return thumbCanvas.toDataURL('image/jpeg', THUMBNAIL_JPEG_QUALITY);
    } catch (_) {
      return '';
    }
  }

  function updateCaptureThumbnail(entryId, nodeId, projectId, thumbnailData) {
    if (!thumbnailData) return;
    const mutate = function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      if (refs.capture) {
        refs.capture.preview_data = thumbnailData;
        refs.capture.meta = { ...(refs.capture.meta || {}), preview_data: thumbnailData };
      }
      if (refs.node) {
        refs.node.meta = { ...(refs.node.meta || {}), preview_data: thumbnailData };
      }
    };
    if (projectId && native?.touchProjectMemoryById) {
      native.touchProjectMemoryById(projectId, mutate);
    } else if (isOriginProjectActive(projectId)) {
      native?.touchProjectMemory?.(mutate);
    }
  }

  function engineVisualEnvelope(envelope) {
    const value = envelope && typeof envelope === 'object' ? envelope : {};
    return {
      ...value,
      project_role: value.project_role || 'unknown',
      classification_confidence: Number(value.project_role_confidence || 0)
    };
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
      return lower(capture?.meta?.analysis_status || '') === 'pending' && hasAnalysisSource(capture);
    }).length;
  }

  function getPendingAnalysisJobs() {
    const project = native?.getProjectMemory?.() || {};
    const projectId = String(project.project_id || project.id || activeProjectId());
    return (project.captures || [])
      .filter(function(capture) {
        return lower(capture?.meta?.analysis_status || '') === 'pending' && hasAnalysisSource(capture);
      })
      .map(function(capture) {
        const entryId = captureEntryId(capture);
        return {
          entryId: entryId,
          nodeId: capture?.node_id || '',
          projectId: capture?.meta?.project_id || projectId,
          createdAt: capture?.meta?.analysis_enqueued_at || capture?.captured_at || capture?.created_at || capture?.meta?.captured_at || '',
          assetId: captureAnalysisAssetId(capture),
          annotation: capture?.voice_annotation || capture?.prompt_text || '',
          operationId: capture?.meta?.operation_id || '',
          facingMode: capture?.meta?.facingMode || 'environment',
          annotationWindowUntil: Number(capture?.meta?.annotation_window_until || 0)
        };
      })
      .filter(function(job) { return !!job.entryId; })
      .filter(function(job) {
        return Number(job.annotationWindowUntil || 0) <= Date.now();
      })
      .sort(function(a, b) {
        return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      });
  }

  function getPendingClaimExtractionJobs() {
    const project = native?.getProjectMemory?.() || {};
    return (project.captures || [])
      .filter(function(capture) {
        return !!capturePreviewData(capture)
          && !!capture?.meta?.claim_extraction_pending
          && lower(capture?.meta?.analysis_status || '') === 'ready';
      })
      .map(function(capture) {
        var descriptionText = String(capture?.description_text || capture?.meta?.description_text || capture?.ai_analysis || capture?.summary || '').trim();
        return {
          entryId: captureEntryId(capture),
          nodeId: capture?.node_id || '',
          text: descriptionText,
          annotation: capture?.voice_annotation || capture?.prompt_text || '',
          createdAt: capture?.meta?.analysis_completed_at || capture?.captured_at || capture?.created_at || ''
        };
      })
      .filter(function(job) { return !!job.entryId && !!job.text; })
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

  function markCaptureAnalysisQueued(entryId, nodeId, thumbnailData, assetId, projectId) {
    const mutate = function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      const timestamp = new Date().toISOString();
      if (refs.capture) {
        refs.capture.preview_data = refs.capture.preview_data || thumbnailData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'pending',
          analysis_stage: 'queued',
          analysis_enqueued_at: refs.capture.meta?.analysis_enqueued_at || timestamp,
          preview_data: refs.capture.preview_data || thumbnailData,
          image_asset_id: refs.capture.meta?.image_asset_id || assetId || '',
          annotation_window_until: 0
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'pending',
          analysis_stage: 'queued',
          analysis_enqueued_at: refs.node.meta?.analysis_enqueued_at || timestamp,
          preview_data: refs.node.meta?.preview_data || thumbnailData,
          image_asset_id: refs.node.meta?.image_asset_id || assetId || '',
          annotation_window_until: 0
        };
      }
    };
    if (projectId && native?.touchProjectMemoryById) native.touchProjectMemoryById(projectId, mutate);
    else if (isOriginProjectActive(projectId)) native?.touchProjectMemory?.(mutate);
  }

  // The native-vision gate must not compete with the governed production
  // analysis request. In the explicit lab route, retain the original frame
  // and pause ordinary analysis until the one plain-text bridge probe runs.
  function markCaptureLabProbeReady(entryId, nodeId, thumbnailData, assetId, projectId) {
    const mutate = function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      const timestamp = new Date().toISOString();
      if (refs.capture) {
        refs.capture.preview_data = refs.capture.preview_data || thumbnailData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'lab-ready',
          analysis_stage: 'vision probe ready',
          analysis_enqueued_at: timestamp,
          image_asset_id: refs.capture.meta?.image_asset_id || assetId || '',
          claim_extraction_pending: false
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'lab-ready',
          analysis_stage: 'vision probe ready',
          analysis_enqueued_at: timestamp,
          preview_data: refs.node.meta?.preview_data || thumbnailData,
          image_asset_id: refs.node.meta?.image_asset_id || assetId || '',
          claim_extraction_pending: false
        };
      }
    };
    if (projectId && native?.touchProjectMemoryById) native.touchProjectMemoryById(projectId, mutate);
    else if (isOriginProjectActive(projectId)) native?.touchProjectMemory?.(mutate);
    native?.traceEvent?.('vision.probe', 'capture', 'ready', {
      entryId: entryId || '',
      nodeId: nodeId || '',
      projectId: projectId || ''
    });
  }

  function getLatestCaptureForLab() {
    const project = native?.getProjectMemory?.() || {};
    const latestId = String(lastBundle?.entry_id || '');
    const captures = Array.isArray(project.captures) ? project.captures : [];
    const capture = (latestId && captures.find(function(entry) {
      return captureEntryId(entry) === latestId;
    })) || captures[0] || lastBundle || null;
    const entryId = captureEntryId(capture) || latestId;
    const assetId = captureAnalysisAssetId(capture) || capture?.image_asset?.entry_id || lastBundle?.image_asset?.entry_id || '';
    const imageData = getStoredAssetData(assetId)
      || capture?.image_asset?.data
      || lastBundle?.image_asset?.data
      || '';
    return {
      ok: !!(entryId && imageData),
      entryId: entryId,
      nodeId: capture?.node_id || '',
      imageData: imageData,
      imageMimeType: capture?.image_asset?.mime_type || lastBundle?.image_asset?.mime_type || dataUrlMimeType(imageData)
    };
  }

  function updateCaptureAnalysisStage(entryId, nodeId, patch, projectId) {
    const updated = touchOriginProject(projectId, function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      if (refs.capture) {
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          ...(patch || {})
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          ...(patch || {})
        };
      }
    });
    return !!updated;
  }

  function markClaimExtractionResult(entryId, nodeId, claimIds, pending) {
    const ids = Array.isArray(claimIds) ? claimIds.filter(Boolean) : [];
    native?.touchProjectMemory?.(function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      if (refs.capture) {
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          claim_extraction_pending: !!pending,
          claim_ids: ids,
          analysis_stage: pending ? 'extracting claims' : 'done'
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          claim_extraction_pending: !!pending,
          claim_ids: ids,
          analysis_stage: pending ? 'extracting claims' : 'done'
        };
      }
    });
  }

  function hasShowTellSemanticResult(entryId, nodeId, projectId) {
    const project = projectId && native?.getProjectMemoryById
      ? (native.getProjectMemoryById(projectId) || {})
      : (native?.getProjectMemory?.() || {});
    const refs = findCaptureRefs(project, entryId, nodeId);
    const captureDone = !!refs.capture?.meta?.show_tell_semantic_done;
    const nodeDone = !!refs.node?.meta?.show_tell_semantic_done;
    return captureDone || nodeDone;
  }

  function markShowTellSemanticResult(entryId, nodeId, patch, projectId) {
    const update = patch && typeof patch === 'object' ? patch : {};
    touchOriginProject(projectId, function(project) {
      const refs = findCaptureRefs(project, entryId, nodeId);
      if (refs.capture) {
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          ...update,
          show_tell_semantic_done: true
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          ...update,
          show_tell_semantic_done: true
        };
      }
    });
  }

  function applyAnalysisReady(job, result, analysisMeta) {
    const meta = analysisMeta && typeof analysisMeta === 'object' ? analysisMeta : {};
    const envelope = result?.envelope || result?.structured || {};
    const validatedEnvelope = envelope?.schema === visionProtocol?.SCHEMA && !!envelope?.vision_id;
    const ocr = Array.isArray(envelope.ocr) ? envelope.ocr : [];
    const observations = Array.isArray(envelope.observations) ? envelope.observations : [];
    const interpretations = Array.isArray(envelope.interpretations) ? envelope.interpretations : [];
    const implications = Array.isArray(envelope.implications) ? envelope.implications : [];
    const uncertainties = Array.isArray(envelope.uncertainties) ? envelope.uncertainties : [];
    const observationText = String(
      visionProtocol?.observationSummary?.(envelope)
      || result?.clean
      || (envelope.status === 'insufficient' ? 'visual signal insufficient' : 'visual observation stored')
    ).trim();
    const visionMeta = {
      vision_id: envelope.vision_id || result?.visionId || '',
      vision_schema: envelope.schema || visionProtocol?.SCHEMA || '',
      vision_status: envelope.status || 'observed',
      capture_kind: envelope.capture_kind || 'unknown',
      project_role: envelope.project_role || 'unknown',
      project_role_confidence: Number(envelope.project_role_confidence || 0),
      visual_ocr: ocr,
      visual_observations: observations,
      visual_interpretations: interpretations,
      visual_implications: implications,
      visual_uncertainties: uncertainties,
      uncertainty_count: uncertainties.length,
      vision_envelope: envelope,
      vision_engine_ingested: false
    };
    const projectBefore = job?.projectId && native?.getProjectMemoryById
      ? (native.getProjectMemoryById(job.projectId) || {})
      : (native?.getProjectMemory?.() || {});
    const operationCapture = (projectBefore.captures || []).find(function(capture) {
      return captureEntryId(capture) === job.entryId || (job.nodeId && capture?.node_id === job.nodeId);
    }) || null;
    const operationId = job.operationId || operationCapture?.meta?.operation_id || '';
    touchOriginProject(job?.projectId, function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        const currentUserComment = String(refs.capture.latest_comment_text || refs.capture.meta?.latest_comment_text || '').trim();
        refs.capture.description_text = observationText;
        if (!job.annotation) refs.capture.summary = observationText;
        refs.capture.ai_analysis = observationText;
        if (job.annotation && !currentUserComment) refs.capture.latest_comment_text = job.annotation;
        refs.capture.prompt_text = job.annotation || refs.capture.prompt_text || '';
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          ...visionMeta,
          analysis_status: 'ready',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData,
          claim_ids: [],
          claim_extraction_pending: false,
          analysis_stage: uncertainties.length ? 'review queued' : 'done',
          annotation_window_until: 0,
          description_text: observationText,
          latest_comment_text: currentUserComment || job.annotation || '',
          capture_semantic_result_count: Number(refs.capture?.meta?.capture_semantic_result_count || 0) + (meta.countIncrement ? 1 : 0)
        };
      }
      if (refs.node) {
        const currentNodeComment = String(refs.node.meta?.latest_comment_text || '').trim();
        refs.node.tags = Array.isArray(refs.node.tags) ? refs.node.tags : [];
        if (job.annotation && refs.node.tags.indexOf('show-tell') === -1) refs.node.tags.push('show-tell');
        refs.node.meta = {
          ...(refs.node.meta || {}),
          ...visionMeta,
          analysis_status: 'ready',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData,
          claim_ids: [],
          claim_extraction_pending: false,
          analysis_stage: uncertainties.length ? 'review queued' : 'done',
          annotation_window_until: 0,
          description_text: observationText,
          latest_comment_text: currentNodeComment || job.annotation || '',
          capture_semantic_result_count: Number(refs.node?.meta?.capture_semantic_result_count || 0) + (meta.countIncrement ? 1 : 0)
        };
      }
      if (isOriginProjectActive(job?.projectId)) {
        native?.updateUIState?.({
          last_capture_summary: job.annotation
            ? String(refs.capture?.summary || job.annotation || 'show+tell saved')
            : observationText,
          user_status: uncertainties.length ? 'visual review queued' : 'visual observation stored'
        });
      }
    });
    const engineResult = validatedEnvelope
      ? window.StructaProjectEngine?.ingestVisualEnvelope?.(
          job.entryId || '',
          engineVisualEnvelope(envelope),
          {
            projectId: job.projectId || '',
            captureId: job.entryId || '',
            nodeId: job.nodeId || '',
            source: 'rabbit-vision'
          }
        )
      : null;
    if (validatedEnvelope && engineResult && !engineResult.stale && engineResult.ok !== false) {
      updateCaptureAnalysisStage(job.entryId, job.nodeId, {
        vision_engine_ingested: true,
        vision_engine_ingested_at: new Date().toISOString()
      }, job.projectId);
    }
    if (validatedEnvelope && (!engineResult || engineResult.stale)) {
      native?.traceEvent?.('vision.analysis', 'stored', 'engine-deferred', {
        entryId: job.entryId || '',
        projectId: job.projectId || ''
      });
    }
    native?.recordOperationWrite?.(operationId, 'capture_description', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || ''
    });
    if (meta?.commentId) {
      native?.recordOperationWrite?.(operationId, 'capture_comment', {
        entryId: job.entryId || '',
        nodeId: job.nodeId || '',
        commentId: meta.commentId
      });
    }
    native?.traceEvent?.('vision.analysis', 'analyzing', uncertainties.length ? 'review-queued' : 'stored', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || '',
      visionId: visionMeta.vision_id,
      ocrCount: ocr.length,
      observationCount: observations.length,
      interpretationCount: interpretations.length,
      implicationCount: implications.length,
      uncertaintyCount: uncertainties.length
    });
    return {
      ok: true,
      engine: engineResult || null,
      engineDeferred: validatedEnvelope && (!engineResult || !!engineResult.stale)
    };
  }

  function applyCaptureSaved(job, result) {
    const summary = String(result?.savedSummary || job.annotation || 'frame saved');
    const prompt = String(result?.savedPrompt || (job.annotation ? 'show+tell saved' : 'hold ptt to describe'));
    touchOriginProject(job?.projectId, function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        refs.capture.summary = summary;
        refs.capture.ai_analysis = '';
        refs.capture.description_text = refs.capture.description_text || '';
        refs.capture.prompt_text = job.annotation || refs.capture.prompt_text || '';
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.data = refs.capture.data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'saved',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData,
          claim_ids: [],
          claim_extraction_pending: false,
          analysis_stage: 'saved',
          annotation_window_until: 0
        };
      }
      if (refs.node) {
        refs.node.body = refs.node.body || (job.annotation || 'visual note');
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'saved',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData,
          claim_ids: [],
          claim_extraction_pending: false,
          analysis_stage: 'saved',
          annotation_window_until: 0
        };
      }
      if (isOriginProjectActive(job?.projectId)) {
        native?.updateUIState?.({
          last_capture_summary: summary,
          user_status: job.annotation ? 'capture comment stored' : 'frame saved'
        });
      }
    });
    native?.traceEvent?.('image', 'analyzing', 'saved', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || '',
      prompt: prompt
    });
  }

  function applyAnalysisUnavailable(job, fallbackText) {
    const savedSummary = String(fallbackText || job.annotation || 'frame saved');
    touchOriginProject(job?.projectId, function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        if (!job.annotation) {
          refs.capture.summary = savedSummary;
          refs.capture.ai_analysis = '';
        }
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'saved',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData,
          description_text: refs.capture.meta?.description_text || refs.capture.description_text || '',
          latest_comment_text: refs.capture.meta?.latest_comment_text || refs.capture.latest_comment_text || '',
          analysis_stage: 'saved',
          vision_status: 'unavailable',
          claim_extraction_pending: false,
          annotation_window_until: 0
        };
      }
      if (refs.node) {
        refs.node.body = refs.node.body || (job.annotation || 'frame saved');
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'saved',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData,
          description_text: refs.node.meta?.description_text || '',
          latest_comment_text: refs.node.meta?.latest_comment_text || '',
          analysis_stage: 'saved',
          vision_status: 'unavailable',
          claim_extraction_pending: false,
          annotation_window_until: 0
        };
      }
      if (isOriginProjectActive(job?.projectId)) {
        native?.updateUIState?.({
          last_capture_summary: savedSummary,
          user_status: 'frame saved'
        });
      }
    });
    native?.traceEvent?.('vision.analysis', 'analyzing', 'degraded-saved', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || '',
      fallback: savedSummary
    });
  }

  function applyProbeDescription(entryId, nodeId, text, meta) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    const project = native?.getProjectMemory?.() || {};
    const refs = findCaptureRefs(project, entryId, nodeId);
    const previewData = capturePreviewData(refs.capture) || refs.node?.meta?.preview_data || '';
    if (!refs.capture && !refs.node) return false;
    applyAnalysisReady({
      entryId: entryId || '',
      nodeId: nodeId || '',
      previewData: previewData,
      annotation: '',
      operationId: refs.capture?.meta?.operation_id || refs.node?.meta?.operation_id || '',
      facingMode: refs.capture?.meta?.facingMode || 'environment'
    }, {
      ok: true,
      text: clean,
      clean: clean,
      raw: String(meta?.raw || ''),
      claims: [],
      claim_extraction_pending: false
    }, {
      claimIds: [],
      commentId: '',
      countIncrement: 0
    });
    native?.traceEvent?.('image.probe', 'apply', 'capture', {
      entryId: entryId || '',
      nodeId: nodeId || '',
      source: meta?.source || 'probe',
      text: clean.slice(0, 160)
    });
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return true;
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
      projectId: job.projectId || '',
      assetId: job.assetId || '',
      annotation: job.annotation || '',
      operationId: job.operationId || '',
      facingMode: job.facingMode || 'environment',
      imageInputMode: 'raw-base64'
    };
  }

  function queueHasImageJob(entryId) {
    if (!queue) return false;
    return queue.snapshot().some(function(job) {
      return job.kind === 'image-analyze' && job.payload?.entryId === entryId;
    });
  }

  function syncDeferredVisualIngest() {
    const engine = window.StructaProjectEngine;
    if (!engine?.ingestVisualEnvelope) return;
    const project = native?.getProjectMemory?.() || {};
    const projectId = String(project.project_id || project.id || activeProjectId());
    const seen = new Set();
    (project.captures || []).filter(function(capture) {
      const entryId = captureEntryId(capture);
      const meta = capture?.meta || {};
      if (!entryId || seen.has(entryId) || meta.vision_engine_ingested) return false;
      if (meta.vision_envelope?.schema !== visionProtocol?.SCHEMA || !meta.vision_envelope?.vision_id) return false;
      seen.add(entryId);
      return true;
    }).slice(0, 4).forEach(function(capture) {
      const entryId = captureEntryId(capture);
      const result = engine.ingestVisualEnvelope(entryId, engineVisualEnvelope(capture.meta.vision_envelope), {
        projectId: projectId,
        captureId: entryId,
        nodeId: capture.node_id || '',
        source: 'rabbit-vision-deferred'
      });
      if (result && !result.stale && result.ok !== false) {
        updateCaptureAnalysisStage(entryId, capture.node_id || '', {
          vision_engine_ingested: true,
          vision_engine_ingested_at: new Date().toISOString()
        }, projectId);
      }
    });
  }

  function syncAnalysisQueue() {
    if (document.visibilityState === 'hidden' || !queue) return;
    syncDeferredVisualIngest();
    const jobs = getPendingAnalysisJobs();
    jobs.forEach(function(job) {
      if (queueHasImageJob(job.entryId)) return;
      native?.traceEvent?.('image', 'pending', 'queued', {
        entryId: job.entryId,
        nodeId: job.nodeId || ''
      });
      queue.enqueue({
        kind: 'image-analyze',
        priority: 'P1',
        payload: imageAnalysisPayload(job),
        origin: {
          screen: 'show',
          itemId: job.entryId
        },
        timeoutMs: 24000
      });
    });
    getPendingClaimExtractionJobs().forEach(function(job) {
      if (queue.snapshot().some(function(entry) {
        return entry.kind === 'image-claim-extract' && entry.payload?.entryId === job.entryId;
      })) return;
      queue.enqueue({
        kind: 'image-claim-extract',
        priority: 'P2',
        payload: job,
        origin: {
          screen: 'show',
          itemId: job.entryId
        },
        timeoutMs: 12000
      });
    });
  }

  if (queue && !window.__STRUCTA_CAMERA_QUEUE_REGISTERED__) {
    window.__STRUCTA_CAMERA_QUEUE_REGISTERED__ = true;
    queue.registerHandler('image-analyze', function(job) {
      const payload = job.payload || {};
      if (!isOriginProjectActive(payload.projectId)) {
        native?.traceEvent?.('vision.analysis', 'queued', 'stale-project', {
          jobId: job.id || '',
          entryId: payload.entryId || '',
          projectId: payload.projectId || '',
          activeProjectId: activeProjectId()
        });
        return { ok: true, stale: true, message: 'project changed' };
      }
      const media = resolveJobMedia(payload);
      payload.assetId = media.assetId || payload.assetId || '';
      payload.previewData = media.previewData || '';
      updateCaptureAnalysisStage(payload.entryId, payload.nodeId, {
        analysis_status: 'pending',
        analysis_stage: 'analyzing'
      }, payload.projectId);
      native?.traceEvent?.('image', 'queued', 'analyzing', {
        jobId: job.id || '',
        entryId: payload.entryId || '',
        nodeId: payload.nodeId || ''
      });
      const analysisImage = String(media.analysisData || '');
      if (!analysisImage || !window.StructaLLM?.processImage) {
        applyAnalysisUnavailable(payload, payload.annotation ? 'show+tell saved' : 'frame saved');
        return {
          ok: true,
          degraded: true,
          unavailable: true,
          message: 'frame saved'
        };
      }

      const projectBefore = native?.getProjectMemory?.() || {};
      const hadAnalyzedCaptures = (projectBefore.captures || []).some(function(capture) {
        return captureEntryId(capture) !== payload.entryId && lower(capture?.meta?.analysis_status || '') === 'ready';
      });
      const desc = 'User captured a ' + (payload.facingMode || 'environment') + ' photo';

      return Promise.race([
        window.StructaLLM.processImage(analysisImage, desc, {
          imageId: payload.entryId,
          itemId: payload.nodeId || '',
          facingMode: payload.facingMode,
          voiceAnnotation: payload.annotation,
          imageInputMode: payload.imageInputMode || 'raw-base64',
          priority: 'low',
          timeout: 18000
        }),
        new Promise(function(resolve) {
          setTimeout(function() {
            resolve({ ok: false, reason: 'timeout' });
          }, 20500);
        })
      ]).then(function(result) {
        if (result && result.ok && result.clean && result.envelope) {
          var appendedComment = null;
          if (payload.annotation && payload.nodeId && native?.appendThreadComment
              && !hasShowTellSemanticResult(payload.entryId, payload.nodeId, payload.projectId)) {
            appendedComment = native.appendThreadComment(
              payload.nodeId,
              result.clean,
              'capture_result',
              'show-tell',
              { projectId: payload.projectId }
            );
            if (appendedComment?.comment?.id) {
              window.dispatchEvent(new CustomEvent('structa-thread-comment-appended', {
                detail: {
                  nodeId: payload.nodeId,
                  commentId: appendedComment.comment.id,
                  comment: appendedComment.comment,
                  surface: 'show'
                }
              }));
              markShowTellSemanticResult(payload.entryId, payload.nodeId, {
                show_tell_comment_id: appendedComment.comment.id
              }, payload.projectId);
            }
          }
          applyAnalysisReady(payload, result, {
            commentId: appendedComment?.comment?.id || '',
            countIncrement: payload.annotation ? 1 : 0
          });
          if (isOriginProjectActive(payload.projectId)) {
            window.StructaFeedback?.fire?.('resolve');
            native?.appendLogEntry?.({ kind: 'llm', message: payload.annotation ? 'capture comment stored' : 'description stored' });
            window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
              detail: { source: 'visual-insight' }
            }));
          }
          return result;
        }
        if (result && result.ok && result.savedOnly) {
          applyCaptureSaved(payload, result);
          if (isOriginProjectActive(payload.projectId)) window.StructaFeedback?.fire?.('resolve');
          return result;
        }
        applyAnalysisUnavailable(payload, payload.annotation ? 'show+tell saved' : 'frame saved');
        if (isOriginProjectActive(payload.projectId)) {
          native?.appendLogEntry?.({ kind: 'camera', message: payload.annotation ? 'capture comment stored' : 'description unavailable' });
          window.StructaFeedback?.fire?.('resolve');
        }
        native?.traceEvent?.('vision.analysis', 'analyzing', 'degraded-saved', {
          jobId: job.id || '',
          entryId: payload.entryId || '',
          reason: result?.reason || 'stalled'
        });
        return {
          ok: true,
          degraded: true,
          unavailable: true,
          message: 'frame saved'
        };
      }).catch(function() {
        applyAnalysisUnavailable(payload, payload.annotation ? 'show+tell saved' : 'frame saved');
        if (isOriginProjectActive(payload.projectId)) {
          native?.appendLogEntry?.({ kind: 'camera', message: payload.annotation ? 'capture comment stored' : 'description unavailable' });
          window.StructaFeedback?.fire?.('resolve');
        }
        native?.traceEvent?.('vision.analysis', 'analyzing', 'degraded-saved', {
          jobId: job.id || '',
          entryId: payload.entryId || '',
          reason: 'exception'
        });
        return {
          ok: true,
          degraded: true,
          unavailable: true,
          message: 'frame saved'
        };
      });
    });
    queue.registerHandler('image-claim-extract', function(job) {
      const payload = job.payload || {};
      const project = native?.getProjectMemory?.() || {};
      updateCaptureAnalysisStage(payload.entryId, payload.nodeId, {
        analysis_stage: 'extracting claims',
        claim_extraction_pending: true
      });
      return window.StructaLLM.extractClaimsFromText({
        project: {
          id: project.project_id || '',
          name: project.name || 'untitled project',
          type: project.type || 'general',
          brief: project.brief || '',
          selectedSurface: 'show',
          openQuestions: (project.open_question_nodes || []).slice(0, 2).map(function(question) {
            return {
              id: question.node_id || '',
              body: question.body || question.title || '',
              branchId: question.branch_id || question.meta?.branch_id || 'main'
            };
          }),
          recentClaims: (project.claims || []).filter(function(claim) {
            return claim && claim.status === 'active' && claim.text;
          }).slice(-3).reverse().map(function(claim) {
            return {
              id: claim.id || '',
              text: claim.text || '',
              kind: claim.kind || 'fact',
              branchId: claim.branchId || 'main',
              status: claim.status || 'active'
            };
          }),
          activeBranch: {
            id: 'main',
            name: 'main',
            parentBranchId: ''
          },
          summary: project.name || ''
        },
        input: {
          text: payload.text || '',
          deviceId: native?.deviceId || ''
        },
        source: payload.annotation ? 'show-tell' : 'image',
        sourceRef: {
          imageId: payload.entryId || '',
          itemId: payload.nodeId || ''
        },
        meta: {
          deviceId: native?.deviceId || '',
          imageId: payload.entryId || ''
        }
      }).then(function(result) {
        if (!result || !result.ok) {
          native?.traceEvent?.('image.claims', 'pending', 'extraction_failed', {
            entryId: payload.entryId || '',
            reason: result?.error || 'extract failed'
          });
          return { ok: true };
        }
        const stored = native?.ingestClaims?.(result.claims || [], {
          source: payload.annotation ? 'show-tell' : 'image',
          sourceRef: {
            imageId: payload.entryId || '',
            itemId: payload.nodeId || ''
          }
        }) || [];
        markClaimExtractionResult(payload.entryId, payload.nodeId, stored.map(function(claim) { return claim.id; }), false);
        native?.traceEvent?.('image.claims', 'pending', 'extracted', {
          entryId: payload.entryId || '',
          count: stored.length
        });
        return { ok: true, claims: stored };
      }).catch(function(error) {
        native?.traceEvent?.('image.claims', 'pending', 'extraction_failed', {
          entryId: payload.entryId || '',
          reason: error?.message || 'extract failed'
        });
        return { ok: true };
      });
    });
  }

  function beginCameraSession() {
    cameraSessionOpen = true;
    cameraSessionEpoch += 1;
    return cameraSessionEpoch;
  }

  function invalidateCameraSession() {
    cameraSessionOpen = false;
    cameraSessionEpoch += 1;
    streamAcquiring = false;
    acquisitionEpoch = 0;
  }

  function isCurrentCameraSession(epoch) {
    return cameraSessionOpen && epoch === cameraSessionEpoch;
  }

  function finishAcquisition(epoch) {
    if (acquisitionEpoch !== epoch) return;
    acquisitionEpoch = 0;
    streamAcquiring = false;
  }

  function stopMediaStream(mediaStream) {
    if (!mediaStream) return;
    try {
      mediaStream.getTracks().forEach(function(track) {
        if (track?.readyState !== 'ended') track.stop();
      });
    } catch (_) {}
  }

  function releaseMediaStream(mediaStream) {
    if (!mediaStream) return;
    stopMediaStream(mediaStream);
    if (preview?.srcObject === mediaStream) preview.srcObject = null;
    if (window.__STRUCTA_PRIMED_STREAM__ === mediaStream) {
      window.__STRUCTA_PRIMED_STREAM__ = null;
    }
    if (stream === mediaStream) {
      stream = null;
      streamReady = false;
    }
  }

  function releaseAllCameraStreams() {
    const activeStream = stream;
    const primedStream = window.__STRUCTA_PRIMED_STREAM__;
    releaseMediaStream(activeStream);
    if (primedStream && primedStream !== activeStream) releaseMediaStream(primedStream);
    if (preview) preview.srcObject = null;
    stream = null;
    streamReady = false;
  }

  async function readyOverlay(targetMode, epoch, mediaStream) {
    const candidate = mediaStream || stream;
    if (!isCurrentCameraSession(epoch)) {
      releaseMediaStream(candidate);
      return false;
    }
    const ready = await attachPreview(candidate, epoch);
    if (!isCurrentCameraSession(epoch)) {
      releaseMediaStream(candidate);
      return false;
    }
    if (!ready) {
      invalidateCameraSession();
      releaseMediaStream(candidate);
      setStatus('preview unavailable');
      return false;
    }
    if (targetMode && targetMode !== facingMode) {
      facingMode = targetMode;
      native?.setCameraFacing?.(facingMode);
    }
    streamReady = true;
    setStatus(CAMERA_READY_STATUS);
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

  function hideOverlay(detail = {}) {
    if (!overlayVisible) return;
    overlayVisible = false;
    stopVoiceStrip();
    overlay?.classList.remove('open');
    overlay?.setAttribute('aria-hidden', 'true');
    document.getElementById('app')?.classList.remove('overlay-active');
    window.dispatchEvent(new CustomEvent('structa-camera-close', {
      detail: { reason: detail.reason || 'capture' }
    }));
  }

  function killStream() {
    invalidateCameraSession();
    stopVoiceStrip();
    releaseAllCameraStreams();
    setStatus('idle');
  }

  async function attachPreview(mediaStream, epoch) {
    if (!preview) return true;
    if (epoch && !isCurrentCameraSession(epoch)) return false;
    preview.srcObject = mediaStream || stream;
    await preview.play().catch(() => {});
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (epoch && !isCurrentCameraSession(epoch)) return false;
      if (preview.readyState >= 2 && preview.videoWidth > 0) return true;
      if (!preview.paused) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    return preview.videoWidth > 0 || preview.readyState >= 2;
  }

  function openFromGesture(mode) {
    const target = mode === 'user' || mode === 'selfie' ? 'user' : 'environment';

    if (streamReady && stream) {
      const epoch = beginCameraSession();
      setStatus('opening');
      void readyOverlay(target, epoch, stream).then((opened) => {
        if (opened && isCurrentCameraSession(epoch) && target !== facingMode) flip();
      });
      return;
    }

    const primed = window.__STRUCTA_PRIMED_STREAM__;
    if (primed && primed.active) {
      const epoch = beginCameraSession();
      stream = primed;
      facingMode = target;
      if (preview) preview.srcObject = stream;
      native?.setCameraFacing?.(facingMode);
      setStatus('opening');
      void readyOverlay(target, epoch, stream);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      if (getCaps().nativeCapturePreferred && window.r1?.camera?.capturePhoto) {
        beginCameraSession();
        facingMode = target;
        native?.setCameraFacing?.(facingMode);
        setStatus(CAMERA_READY_STATUS);
        showOverlay();
        showOverlayReady();
        return;
      }
      setStatus('camera unavailable');
      window.dispatchEvent(new CustomEvent('structa-camera-denied', {
        detail: { reason: 'camera-unavailable' }
      }));
      return;
    }

    if (streamAcquiring) return;
    const epoch = beginCameraSession();
    streamAcquiring = true;
    acquisitionEpoch = epoch;
    facingMode = target;
    setStatus('opening');

    navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { max: 640 }, height: { max: 480 } } })
      .then(async (mediaStream) => {
        finishAcquisition(epoch);
        if (!isCurrentCameraSession(epoch)) {
          releaseMediaStream(mediaStream);
          return;
        }
        stream = mediaStream;
        window.__STRUCTA_PRIMED_STREAM__ = stream;
        if (preview) preview.srcObject = stream;
        native?.setCameraFacing?.(facingMode);
        const ok = await readyOverlay(target, epoch, mediaStream);
        if (!ok) return;
      })
      .catch(err => {
        finishAcquisition(epoch);
        if (!isCurrentCameraSession(epoch)) return;
        invalidateCameraSession();
        releaseAllCameraStreams();
        setStatus('camera blocked');
        window.dispatchEvent(new CustomEvent('structa-camera-denied', {
          detail: { reason: err?.name || 'permission-denied' }
        }));
      });
  }

  async function flip() {
    if (flipLocked || !streamReady || !cameraSessionOpen) return;
    flipLocked = true;
    const epoch = cameraSessionEpoch;
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    const transitionStartedAt = Date.now();
    setFlipTransition(true, nextMode);
    setStatus(nextMode === 'user' ? 'opening front lens' : 'opening rear lens');
    try {
      releaseAllCameraStreams();
      if (!isCurrentCameraSession(epoch)) return;
      streamAcquiring = true;
      acquisitionEpoch = epoch;
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextMode, width: { max: 640 }, height: { max: 480 } }
      });
      finishAcquisition(epoch);
      if (!isCurrentCameraSession(epoch)) {
        releaseMediaStream(mediaStream);
        return;
      }
      stream = mediaStream;
      facingMode = nextMode;
      window.__STRUCTA_PRIMED_STREAM__ = stream;
      const attached = await attachPreview(mediaStream, epoch);
      if (!attached || !isCurrentCameraSession(epoch)) {
        releaseMediaStream(mediaStream);
        return;
      }
      streamReady = true;
      native?.setCameraFacing?.(facingMode);
      await waitForFlipBeat(transitionStartedAt);
      if (isCurrentCameraSession(epoch)) setStatus(CAMERA_READY_STATUS);
    } catch (_) {
      finishAcquisition(epoch);
      if (!isCurrentCameraSession(epoch)) return;
      releaseAllCameraStreams();
      setStatus('flip failed');
    } finally {
      setFlipTransition(false);
      flipLocked = false;
    }
  }

  // === SHOW+TELL voice strip ===

  function startVoiceStrip() {
    if (voiceStripActive || voiceStripStopping) return false;
    if (typeof CreationVoiceHandler !== 'undefined'
        && (window.__STRUCTA_NATIVE_STT_OWNER__ || window.StructaVoice?.nativeCapturePending)) {
      setStatus('finish previous note first');
      native?.traceEvent?.('camera.voice', 'idle', 'start-blocked', {
        reason: 'native-callback-pending',
        owner: window.__STRUCTA_NATIVE_STT_OWNER__ || 'voice'
      });
      return false;
    }
    voiceStripActive = true;
    voiceStripStopping = false;
    pendingVoiceCapture = false;
    if (pendingVoiceCaptureTimer) {
      clearTimeout(pendingVoiceCaptureTimer);
      pendingVoiceCaptureTimer = null;
    }
    voiceStripTranscript = '';
    voiceStripSession = {
      requestId: nextVoiceStripRequestId(),
      projectId: activeProjectId(),
      transcript: '',
      terminal: false,
      released: false,
      cancelled: false,
      stopSent: false,
      settled: false,
      aborted: false,
      timeoutId: null,
      target: null
    };

    // Mute heartbeat audio during capture
    if (window.StructaAudio) window.StructaAudio.mute();

    // Show voice strip UI
    var strip = document.getElementById('camera-voice-strip');
    if (strip) {
      strip.classList.add('active');
      strip.querySelector('.strip-text').textContent = 'recording narration...';
    }
    setStatus('release for frame + note');

    // Start R1 native STT if available
    if (typeof CreationVoiceHandler !== 'undefined') {
      try {
        window.__STRUCTA_PTT_TARGET__ = 'camera';
        window.__STRUCTA_NATIVE_STT_OWNER__ = 'camera';
        CreationVoiceHandler.postMessage('start');
        return true;
      } catch (e) {
        if (window.__STRUCTA_NATIVE_STT_OWNER__ === 'camera') window.__STRUCTA_NATIVE_STT_OWNER__ = null;
      }
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
    return true;
  }

  function requestVoiceStripStop(session) {
    if (!session || session.stopSent) return;
    session.stopSent = true;
    if (typeof CreationVoiceHandler !== 'undefined') {
      try { CreationVoiceHandler.postMessage('stop'); } catch (e) {}
    }
  }

  function armVoiceStripTerminalTimeout(session) {
    if (!session || session.timeoutId || session.settled || typeof CreationVoiceHandler === 'undefined') return;
    session.timeoutId = setTimeout(function() {
      session.timeoutId = null;
      releaseTimedOutVoiceSession(session);
    }, NATIVE_STT_TERMINAL_TIMEOUT_MS);
  }

  function finishVoiceStripPresentation() {
    voiceStripActive = false;
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

    // Hide voice strip UI
    var strip = document.getElementById('camera-voice-strip');
    if (strip) {
      strip.classList.remove('active');
      var textEl = strip.querySelector('.strip-text');
      if (textEl) textEl.textContent = 'recording narration...';
    }
    setStatus(CAMERA_READY_STATUS);
  }

  function stopVoiceStrip() {
    if (!voiceStripActive && !voiceStripStopping && !voiceStripSession) return;
    var session = voiceStripSession;
    if (session && !session.terminal) {
      if (!session.released) {
        session.cancelled = true;
        session.aborted = true;
        session.abortReason = 'camera-cancelled-before-frame';
      }
      requestVoiceStripStop(session);
      armVoiceStripTerminalTimeout(session);
    }
    finishVoiceStripPresentation();
    if (!session || session.terminal) {
      voiceStripStopping = false;
      voiceStripSession = null;
      if (window.__STRUCTA_NATIVE_STT_OWNER__ === 'camera') window.__STRUCTA_NATIVE_STT_OWNER__ = null;
    }
  }

  function settleVoiceStripSession(session) {
    if (!session || session.settled || !session.terminal) return false;
    if (!session.target) {
      if (!session.aborted) return false;
      session.settled = true;
      if (session.timeoutId) clearTimeout(session.timeoutId);
      voiceStripStopping = false;
      if (voiceStripSession === session) voiceStripSession = null;
      if (window.__STRUCTA_NATIVE_STT_OWNER__ === 'camera') window.__STRUCTA_NATIVE_STT_OWNER__ = null;
      native?.traceEvent?.('camera.voice', 'terminal', 'discarded', {
        projectId: session.projectId,
        reason: session.abortReason || 'capture-aborted',
        requestId: session.requestId
      });
      return true;
    }
    session.settled = true;
    if (session.timeoutId) clearTimeout(session.timeoutId);
    const target = session.target;
    const transcript = String(session.transcript || '').trim();
    var appended = null;
    if (!session.cancelled && transcript && native?.appendCaptureComment) {
      appended = native.appendCaptureComment(target.entryId, target.nodeId, transcript, {
        projectId: session.projectId,
        requestId: session.requestId,
        operationId: target.operationId || '',
        kind: 'context',
        origin: 'camera-ptt'
      });
      if (appended && !appended.duplicate) {
        native?.recordOperationWrite?.(target.operationId || '', 'capture_comment', {
          entryId: target.entryId,
          nodeId: target.nodeId,
          commentId: appended.comment?.id || ''
        });
        window.dispatchEvent(new CustomEvent('structa-thread-comment-appended', {
          detail: {
            entryId: target.entryId,
            nodeId: target.nodeId,
            commentId: appended.comment?.id || '',
            comment: appended.comment || null,
            voiceEntryId: appended.voiceEntry?.node_id || '',
            surface: 'show'
          }
        }));
        window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
          detail: { source: 'capture-comment' }
        }));
        const project = native?.getProjectMemoryById?.(session.projectId) || {};
        queue?.enqueue?.({
          kind: 'thread-refine',
          priority: 'P2',
          payload: {
            nodeId: target.nodeId,
            commentId: appended.comment?.id || '',
            commentText: transcript,
            surface: 'show',
            selection: {
              kind: 'show',
              id: target.nodeId,
              captureId: target.entryId,
              title: 'visual reference',
              summary: transcript,
              status: 'open',
              createdAt: '',
              claims: []
            },
            projectId: session.projectId,
            projectName: project.name || 'untitled project',
            projectType: project.type || 'general',
            projectBrief: project.brief || '',
            topQuestions: (project.open_questions || []).slice(0, 3),
            projectSummary: ''
          },
          origin: { screen: 'show', itemId: target.nodeId },
          timeoutMs: 12000
        });
      }
    }
    if (!session.cancelled) {
      markCaptureAnalysisQueued(
        target.entryId,
        target.nodeId,
        target.thumbnailData,
        target.assetId,
        session.projectId
      );
      scheduleAnalysisDrain(0);
    }
    native?.traceEvent?.('camera.voice', 'terminal', session.cancelled ? 'discarded' : 'attached', {
      projectId: session.projectId,
      entryId: target.entryId,
      nodeId: target.nodeId,
      hasTranscript: !!transcript,
      duplicate: !!appended?.duplicate,
      requestId: session.requestId
    });
    voiceStripStopping = false;
    if (voiceStripSession === session) voiceStripSession = null;
    if (window.__STRUCTA_NATIVE_STT_OWNER__ === 'camera') window.__STRUCTA_NATIVE_STT_OWNER__ = null;
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
    return true;
  }

  function abortVoiceStripSession(session, reason) {
    if (!session || session.settled) return;
    session.cancelled = true;
    session.aborted = true;
    session.abortReason = reason || 'capture-aborted';
    settleVoiceStripSession(session);
  }

  function releaseTimedOutVoiceSession(session) {
    if (!session || session.settled || session.terminal) return;
    session.settled = true;
    session.quarantined = true;
    if (session.target) {
      markCaptureAnalysisQueued(
        session.target.entryId,
        session.target.nodeId,
        session.target.thumbnailData,
        session.target.assetId,
        session.projectId
      );
      scheduleAnalysisDrain(0);
    }
    voiceStripStopping = false;
    if (voiceStripSession === session) voiceStripSession = null;
    // R1 supplies no callback id. Keep the bridge quarantined until this page
    // is relaunched so a late old terminal can never attach to a new frame.
    if (window.__STRUCTA_NATIVE_STT_OWNER__ === 'camera') {
      window.__STRUCTA_NATIVE_STT_OWNER__ = 'camera-timeout';
    }
    native?.traceEvent?.('camera.voice', 'waiting', 'timed-out', {
      projectId: session.projectId,
      entryId: session.target?.entryId || '',
      requestId: session.requestId
    });
    window.dispatchEvent(new CustomEvent('structa-memory-updated'));
  }

  function finalizeVoiceStripCapture() {
    if (!voiceStripActive && !voiceStripStopping) {
      return capture();
    }
    var session = voiceStripSession;
    voiceStripStopping = true;
    pendingVoiceCapture = false;
    window.__STRUCTA_PTT_TARGET__ = 'camera';
    setStatus('capturing...');
    if (session) session.released = true;

    if (voiceStripRecognition) {
      try { voiceStripRecognition.stop(); } catch (e) {}
    }
    if (session && typeof CreationVoiceHandler === 'undefined') {
      session.terminal = true;
      session.transcript = String(voiceStripTranscript || '').trim();
    }
    requestVoiceStripStop(session);
    armVoiceStripTerminalTimeout(session);
    finishVoiceStripPresentation();
    // The frame is stored immediately. The native STT terminal owns only the
    // exact comment attachment and analysis release, never the shutter.
    return capture({ voiceSession: session });
  }

  // Listen for R1 STT results during voice strip
  window.addEventListener('structa-stt-ended', function(event) {
    var session = voiceStripSession;
    if (session && !session.terminal) {
      session.terminal = true;
      session.transcript = String(event?.detail?.transcript || '').trim();
      voiceStripTranscript = session.transcript;
      var strip = document.getElementById('camera-voice-strip');
      if (strip) {
        var textEl = strip.querySelector('.strip-text');
        if (textEl) textEl.textContent = voiceStripTranscript.slice(-40);
      }
      settleVoiceStripSession(session);
    }
  });

  async function capture(options = {}) {
    if (Date.now() - lastCaptureAt < CAPTURE_COOLDOWN_MS) {
      abortVoiceStripSession(options?.voiceSession || null, 'shutter-cooldown');
      setStatus('shutter settling');
      window.StructaFeedback?.fire?.('blocked');
      return null;
    }
    lastCaptureAt = Date.now();
    const voiceSession = options?.voiceSession || null;
    const captureProjectId = String(voiceSession?.projectId || activeProjectId());
    let dataUrl = '';
    let thumbnailData = '';
    let w = preview?.videoWidth || 720;
    let h = preview?.videoHeight || 720;
    if (preview && stream) {
      var scale = Math.min(1, ANALYSIS_CAPTURE_WIDTH / Math.max(1, w));
      var targetWidth = Math.max(1, Math.round(w * scale));
      var targetHeight = Math.max(1, Math.round(h * scale));
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(preview, 0, 0, targetWidth, targetHeight);
      try {
        dataUrl = canvas.toDataURL('image/jpeg', ANALYSIS_JPEG_QUALITY);
        thumbnailData = createThumbnailFromCanvas(canvas);
      } catch (_) {
        dataUrl = '';
        thumbnailData = '';
      }
      w = targetWidth;
      h = targetHeight;
    } else if (getCaps().nativeCapturePreferred && window.r1?.camera?.capturePhoto) {
      try {
        const nativeResult = await window.r1.camera.capturePhoto(640, 480);
        const raw = typeof nativeResult === 'string'
          ? nativeResult
          : (nativeResult?.dataUrl || nativeResult?.imageBase64 || nativeResult?.base64 || '');
        dataUrl = raw && raw.indexOf('data:image') === 0 ? raw : (raw ? ('data:image/png;base64,' + raw) : '');
        w = nativeResult?.width || 640;
        h = nativeResult?.height || 480;
      } catch (_) {
        dataUrl = '';
      }
    }
    if (!dataUrl) {
      abortVoiceStripSession(voiceSession, 'frame-capture-failed');
      native?.appendLogEntry?.({ kind: 'camera', message: 'frame capture failed — try again' });
      window.StructaFeedback?.fire?.('blocked');
      window.dispatchEvent(new CustomEvent('structa-capture-failed'));
      return null;
    }
    if (!isOriginProjectActive(captureProjectId)) {
      abortVoiceStripSession(voiceSession, 'project-changed-before-store');
      native?.traceEvent?.('image', 'captured', 'stale-project', {
        projectId: captureProjectId,
        activeProjectId: activeProjectId()
      });
      invalidateCameraSession();
      releaseAllCameraStreams();
      hideOverlay();
      return null;
    }
    if (pendingVoiceCaptureTimer) {
      clearTimeout(pendingVoiceCaptureTimer);
      pendingVoiceCaptureTimer = null;
    }

    // A terminal may arrive before storage finishes. Snapshot its exact text;
    // otherwise keep analysis gated until the same session receives terminal.
    var annotation = String(voiceSession?.transcript || voiceStripTranscript || '').trim();
    var awaitingVoiceTerminal = !!(voiceSession && !voiceSession.terminal);
    finishVoiceStripPresentation();

    // Play capture sound
    if (window.StructaAudio) {
      window.StructaAudio.init();
      window.StructaFeedback?.fire?.('capture');
    }

    const capturedAt = new Date().toISOString();
    const mimeType = dataUrlMimeType(dataUrl);
    const fileExtension = mimeType === 'image/png' ? '.png' : '.jpg';
    const imageAsset = {
      kind: 'capture',
      name: 'camera-' + Date.now() + fileExtension,
      mime_type: mimeType,
      data: dataUrl,
      meta: {
        facingMode,
        width: w,
        height: h,
        captured_at: capturedAt,
        purpose: 'vision-analysis'
      }
    };
    const storedAsset = native?.storeAsset?.(imageAsset);
    const resolvedAsset = storedAsset && storedAsset.ok && storedAsset.payload
      ? { ...imageAsset, ...storedAsset.payload, meta: { ...(imageAsset.meta || {}), ...(storedAsset.payload.meta || {}) } }
      : imageAsset;
    const assetStored = !!(storedAsset && storedAsset.ok && storedAsset.payload?.entry_id);
    const captureAsset = assetStored ? {
      entry_id: resolvedAsset.entry_id,
      kind: resolvedAsset.kind,
      name: resolvedAsset.name,
      mime_type: resolvedAsset.mime_type,
      meta: resolvedAsset.meta
    } : resolvedAsset;

    const analysisQueuedAt = new Date().toISOString();
    const annotationWindowUntil = 0;
    const operationId = native?.beginOperation?.({
      kind: voiceSession ? 'show+tell' : 'show',
      allowed: voiceSession ? { capture: 1, capture_comment: 1, capture_description: 1 } : { capture: 1, capture_description: 1 }
    }) || '';
    const bundleInput = {
      project_code: captureProjectId,
      source_type: 'camera',
      input_type: annotation ? 'image+voice' : 'image',
      image_asset: captureAsset,
      prompt_text: annotation || (facingMode === 'user' ? 'selfie frame' : 'camera frame'),
      description_text: '',
      latest_comment_text: '',
      summary: annotation ? 'show+tell saved' : 'frame saved',
      approval_state: 'draft',
      tags: annotation ? [facingMode, 'capture', 'show-tell'] : [facingMode, 'capture'],
      links: [],
      meta: {
        facingMode, width: w, height: h, voiceAnnotation: annotation,
        project_id: captureProjectId,
        image_asset_id: resolvedAsset.entry_id || '',
        image_asset_name: resolvedAsset.name || '',
        preview_data: thumbnailData,
        analysis_status: awaitingVoiceTerminal ? 'awaiting-comment' : 'pending',
        analysis_stage: awaitingVoiceTerminal ? 'awaiting comment' : 'queued',
        analysis_enqueued_at: analysisQueuedAt,
        analysis_width: w,
        thumbnail_width: Math.min(w, THUMBNAIL_WIDTH),
        claim_extraction_pending: false,
        annotation_window_until: annotationWindowUntil,
        operation_id: operationId
      }
    };
    const bundle = window.StructaCaptureBundles?.createCaptureBundle?.(bundleInput)
      || window.StructaContracts?.createCaptureBundle?.(bundleInput);
    if (!bundle?.entry_id) {
      abortVoiceStripSession(voiceSession, 'capture-bundle-unavailable');
      native?.traceEvent?.('image', 'captured', 'bundle-unavailable', { projectId: captureProjectId });
      return null;
    }

    lastBundle = bundle;
    native?.storeCaptureBundle?.(bundle);
    native?.recordOperationWrite?.(operationId, 'capture', {
      entryId: bundle?.entry_id || ''
    });
    native?.updateUIState?.({
      last_capture_entry_id: bundle?.entry_id || '',
      last_capture_summary: annotation ? 'show+tell saved' : 'frame saved'
    });
    window.dispatchEvent(new CustomEvent('structa-capture-stored', {
      detail: { entryId: bundle?.entry_id || '', summary: bundle?.summary || '' }
    }));

    native?.appendLogEntry?.({ kind: 'camera', message: annotation ? 'capture comment stored' : 'frame saved' });
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: annotation ? 'show-tell' : 'capture' }
    }));
    // Retire this presentation session before hiding it so a late preview or
    // acquisition callback cannot reopen the overlay. A completed frame also
    // releases every camera track; STRUCTA never keeps a hidden lens live.
    invalidateCameraSession();
    releaseAllCameraStreams();
    hideOverlay();

    // Also store as node if available
    var captureNode = null;
    if (native?.addNodeToProject || native?.addNode) {
      const nodeInput = {
        type: 'capture',
        title: annotation ? 'show+tell: ' + annotation.slice(0, 40) : 'visual note',
        body: annotation || 'visual note',
        source: 'camera',
        capture_image: bundle?.entry_id || null,
        voice_annotation: annotation || null,
        tags: annotation ? ['show-tell', facingMode] : [facingMode],
        meta: {
          bundle_id: bundle?.entry_id || null,
          project_id: captureProjectId,
          facingMode: facingMode,
          analysis_status: awaitingVoiceTerminal ? 'awaiting-comment' : 'pending',
          analysis_stage: awaitingVoiceTerminal ? 'awaiting comment' : 'queued',
          analysis_enqueued_at: analysisQueuedAt,
          preview_data: thumbnailData,
          image_asset_id: resolvedAsset.entry_id || '',
          image_asset_name: resolvedAsset.name || '',
          image_asset: captureAsset,
          claim_extraction_pending: false,
          annotation_window_until: annotationWindowUntil
        }
      };
      captureNode = native?.addNodeToProject
        ? native.addNodeToProject(captureProjectId, nodeInput)
        : (isOriginProjectActive(captureProjectId) ? native.addNode(nodeInput) : null);
    }
    if (captureNode?.node_id) {
      const linkCaptureNode = function(project) {
        const refs = findCaptureRefs(project, bundle?.entry_id || '', captureNode.node_id);
        if (refs.capture) refs.capture.node_id = captureNode.node_id;
        if (refs.node) {
          refs.node.capture_image = refs.node.capture_image || bundle?.entry_id || '';
          refs.node.meta = {
            ...(refs.node.meta || {}),
            bundle_id: refs.node.meta?.bundle_id || bundle?.entry_id || ''
          };
        }
      };
      if (native?.touchProjectMemoryById) native.touchProjectMemoryById(captureProjectId, linkCaptureNode);
      else if (isOriginProjectActive(captureProjectId)) native?.touchProjectMemory?.(linkCaptureNode);
    }
    native?.traceEvent?.('image', 'captured', 'stored', {
      entryId: bundle?.entry_id || '',
      annotation: !!annotation,
      nodeId: captureNode?.node_id || ''
    });

    const captureTarget = {
      entryId: bundle?.entry_id || '',
      nodeId: captureNode?.node_id || '',
      thumbnailData: thumbnailData,
      assetId: resolvedAsset.entry_id || '',
      operationId: operationId
    };
    if (isLabVisionProbeMode() && !voiceSession) {
      markCaptureLabProbeReady(
        captureTarget.entryId,
        captureTarget.nodeId,
        captureTarget.thumbnailData,
        captureTarget.assetId,
        captureProjectId
      );
      if (isOriginProjectActive(captureProjectId)) {
        native?.updateUIState?.({ user_status: 'frame saved · vision test ready' });
      }
    } else if (voiceSession) {
      voiceSession.target = captureTarget;
      if (voiceSession.quarantined || (voiceSession.settled && !voiceSession.terminal)) {
        markCaptureAnalysisQueued(
          captureTarget.entryId,
          captureTarget.nodeId,
          captureTarget.thumbnailData,
          captureTarget.assetId,
          captureProjectId
        );
        scheduleAnalysisDrain(0);
      } else {
        settleVoiceStripSession(voiceSession);
      }
    } else {
      markCaptureAnalysisQueued(
        captureTarget.entryId,
        captureTarget.nodeId,
        captureTarget.thumbnailData,
        captureTarget.assetId,
        captureProjectId
      );
      scheduleAnalysisDrain(120);
    }
    if (!thumbnailData) {
      void createThumbnailDataUrl(dataUrl).then(function(resolvedThumbnail) {
        if (!resolvedThumbnail) return;
        updateCaptureThumbnail(
          bundle?.entry_id || '',
          captureNode?.node_id || '',
          captureProjectId,
          resolvedThumbnail
        );
      });
    }

    return bundle;
  }

  function close(options = {}) {
    voiceStripActive = false;
    voiceStripTranscript = '';
    voiceStripStopping = false;
    pendingVoiceCapture = false;
    clearTimeout(pendingVoiceCaptureTimer);
    pendingVoiceCaptureTimer = null;
    setFlipTransition(false);
    flipLocked = false;
    invalidateCameraSession();
    releaseAllCameraStreams();
    setStatus('camera closed');
    hideOverlay({ reason: options.reason || 'cancel' });
  }

  // Overlay interactions — scroll=flip, tap=capture
  overlay?.addEventListener('wheel', event => {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    flip();
  }, { passive: false });

  overlay?.addEventListener('pointerup', event => {
    if (!overlay.classList.contains('open')) return;
    // Don't capture from either explicit camera control.
    if (event.target.closest && event.target.closest('#camera-voice-strip, #camera-cancel')) return;
    event.preventDefault();
    event.stopPropagation();
    capture();
  });

  cancelButton?.addEventListener('pointerup', function(event) {
    if (!overlay.classList.contains('open')) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  window.addEventListener('pagehide', killStream);
  window.addEventListener('focus', function() { scheduleAnalysisDrain(180); });
  window.addEventListener('pageshow', function() { scheduleAnalysisDrain(180); });
  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') scheduleAnalysisDrain(180);
  });
  window.addEventListener('structa-capture-stored', function() {
    scheduleAnalysisDrain(180);
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
    applyProbeDescription,
    getLatestCaptureForLab,
    getPendingAnnotation: function() { return null; },
    get voiceStripActive() { return voiceStripActive; },
    get voiceStripTranscript() { return voiceStripTranscript; },
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return streamReady; }
  });
})();
