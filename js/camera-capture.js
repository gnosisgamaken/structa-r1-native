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
  let lastCaptureAt = 0;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const CAPTURE_COOLDOWN_MS = 600;
  const TARGET_CAPTURE_WIDTH = 320;
  const CAMERA_READY_STATUS = 'click shoots · tap status cancels';

  function getCaps() {
    return window.__structaCaps || {};
  }

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
          operationId: capture?.meta?.operation_id || '',
          facingMode: capture?.meta?.facingMode || 'environment',
          annotationWindowUntil: Number(capture?.meta?.annotation_window_until || 0)
        };
      })
      .filter(function(job) { return !!job.entryId && !!job.previewData; })
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
          analysis_stage: 'queued',
          analysis_enqueued_at: refs.capture.meta?.analysis_enqueued_at || timestamp,
          preview_data: refs.capture.preview_data || dataUrl,
          annotation_window_until: 0
        };
      }
      if (refs.node) {
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'pending',
          analysis_stage: 'queued',
          analysis_enqueued_at: refs.node.meta?.analysis_enqueued_at || timestamp,
          preview_data: refs.node.meta?.preview_data || dataUrl,
          annotation_window_until: 0
        };
      }
    });
  }

  function updateCaptureAnalysisStage(entryId, nodeId, patch) {
    native?.touchProjectMemory?.(function(project) {
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

  function hasShowTellSemanticResult(entryId, nodeId) {
    const project = native?.getProjectMemory?.() || {};
    const refs = findCaptureRefs(project, entryId, nodeId);
    const captureDone = !!refs.capture?.meta?.show_tell_semantic_done;
    const nodeDone = !!refs.node?.meta?.show_tell_semantic_done;
    return captureDone || nodeDone;
  }

  function markShowTellSemanticResult(entryId, nodeId, patch) {
    const update = patch && typeof patch === 'object' ? patch : {};
    native?.touchProjectMemory?.(function(project) {
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
    const claimIds = Array.isArray(result?.claims) ? result.claims.map(function(claim) { return claim?.id; }).filter(Boolean) : [];
    const linkedClaimIds = Array.isArray(meta?.claimIds) ? meta.claimIds.filter(Boolean) : claimIds;
    const projectBefore = native?.getProjectMemory?.() || {};
    const operationCapture = (projectBefore.captures || []).find(function(capture) {
      return captureEntryId(capture) === job.entryId || (job.nodeId && capture?.node_id === job.nodeId);
    }) || null;
    const operationId = job.operationId || operationCapture?.meta?.operation_id || '';
    native?.touchProjectMemory?.(function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        if (job.annotation) {
          refs.capture.latest_comment_text = result.clean;
        } else {
          refs.capture.description_text = result.clean;
          refs.capture.summary = result.clean;
          refs.capture.ai_analysis = result.clean;
        }
        refs.capture.prompt_text = job.annotation || refs.capture.prompt_text || '';
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.data = refs.capture.data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'ready',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData,
          claim_ids: linkedClaimIds,
          claim_extraction_pending: !!result?.claim_extraction_pending,
          analysis_stage: result?.claim_extraction_pending ? 'extracting claims' : 'done',
          annotation_window_until: 0,
          description_text: job.annotation ? (refs.capture.meta?.description_text || refs.capture.description_text || '') : result.clean,
          latest_comment_text: job.annotation ? result.clean : (refs.capture.meta?.latest_comment_text || refs.capture.latest_comment_text || ''),
          capture_semantic_result_count: Number(refs.capture?.meta?.capture_semantic_result_count || 0) + (meta.countIncrement ? 1 : 0)
        };
      }
      if (refs.node) {
        if (!job.annotation) refs.node.body = result.clean;
        refs.node.tags = Array.isArray(refs.node.tags) ? refs.node.tags : [];
        if (job.annotation && refs.node.tags.indexOf('show-tell') === -1) refs.node.tags.push('show-tell');
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'ready',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData,
          claim_ids: linkedClaimIds,
          claim_extraction_pending: !!result?.claim_extraction_pending,
          analysis_stage: result?.claim_extraction_pending ? 'extracting claims' : 'done',
          annotation_window_until: 0,
          description_text: job.annotation ? (refs.node.meta?.description_text || refs.capture?.description_text || '') : result.clean,
          latest_comment_text: job.annotation ? result.clean : (refs.node.meta?.latest_comment_text || ''),
          capture_semantic_result_count: Number(refs.node?.meta?.capture_semantic_result_count || 0) + (meta.countIncrement ? 1 : 0)
        };
      }
      native?.updateUIState?.({
        last_capture_summary: job.annotation ? String(refs.capture?.summary || refs.capture?.description_text || 'show+tell saved') : result.clean,
        user_status: job.annotation ? 'hold ptt to describe' : 'image described'
      });
    });
    native?.recordOperationWrite?.(operationId, job.annotation ? 'capture_comment' : 'capture_description', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || ''
    });
    native?.traceEvent?.('image', 'analyzing', 'analyzed', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || '',
      semanticResultId: meta?.commentId || ''
    });
  }

  function applyCaptureSaved(job, result) {
    const summary = String(result?.savedSummary || job.annotation || 'frame saved');
    const prompt = String(result?.savedPrompt || (job.annotation ? 'show+tell saved' : 'hold ptt to describe'));
    native?.touchProjectMemory?.(function(project) {
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
      native?.updateUIState?.({
        last_capture_summary: summary,
        user_status: prompt
      });
    });
    native?.traceEvent?.('image', 'analyzing', 'saved', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || '',
      prompt: prompt
    });
  }

  function applyAnalysisUnavailable(job, fallbackText) {
    native?.touchProjectMemory?.(function(project) {
      const refs = findCaptureRefs(project, job.entryId, job.nodeId);
      if (refs.capture) {
        if (!job.annotation) {
          refs.capture.summary = fallbackText;
          refs.capture.ai_analysis = '';
        }
        refs.capture.preview_data = refs.capture.preview_data || job.previewData;
        refs.capture.data = refs.capture.data || job.previewData;
        refs.capture.meta = {
          ...(refs.capture.meta || {}),
          analysis_status: 'unavailable',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.capture.preview_data || job.previewData,
          description_text: refs.capture.meta?.description_text || refs.capture.description_text || '',
          latest_comment_text: refs.capture.meta?.latest_comment_text || refs.capture.latest_comment_text || '',
          analysis_stage: 'blocked',
          annotation_window_until: 0
        };
      }
      if (refs.node) {
        refs.node.body = refs.node.body || (job.annotation || 'frame saved');
        refs.node.meta = {
          ...(refs.node.meta || {}),
          analysis_status: 'unavailable',
          analysis_completed_at: new Date().toISOString(),
          preview_data: refs.node.meta?.preview_data || job.previewData,
          description_text: refs.node.meta?.description_text || '',
          latest_comment_text: refs.node.meta?.latest_comment_text || '',
          analysis_stage: 'blocked',
          annotation_window_until: 0
        };
      }
      native?.updateUIState?.({
        last_capture_summary: fallbackText || 'image description unavailable',
        user_status: job.annotation ? 'show+tell saved' : 'image description unavailable'
      });
    });
    native?.traceEvent?.('image', 'analyzing', 'blocked', {
      entryId: job.entryId || '',
      nodeId: job.nodeId || '',
      fallback: fallbackText || ''
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
      operationId: job.operationId || '',
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
        timeoutMs: 28000
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
      updateCaptureAnalysisStage(payload.entryId, payload.nodeId, {
        analysis_status: 'pending',
        analysis_stage: 'analyzing'
      });
      native?.traceEvent?.('image', 'queued', 'analyzing', {
        jobId: job.id || '',
        entryId: payload.entryId || '',
        nodeId: payload.nodeId || ''
      });
      const rawBase64 = String(payload.previewData || '').split(',').pop();
      if (!rawBase64 || !window.StructaLLM?.processImage) {
        return {
          ok: false,
          blocked: true,
          message: 'visual note stalled — click retry, double side skips'
        };
      }

      const projectBefore = native?.getProjectMemory?.() || {};
      const hadAnalyzedCaptures = (projectBefore.captures || []).some(function(capture) {
        return captureEntryId(capture) !== payload.entryId && lower(capture?.meta?.analysis_status || '') === 'ready';
      });
      const desc = 'User captured a ' + (payload.facingMode || 'environment') + ' photo';

      return Promise.race([
        window.StructaLLM.processImage(rawBase64, desc, {
          imageId: payload.entryId,
          itemId: payload.nodeId || '',
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
          if (payload.annotation && hasShowTellSemanticResult(payload.entryId, payload.nodeId)) {
            native?.traceEvent?.('show.tell', 'analyzing', 'deduped', {
              entryId: payload.entryId || '',
              nodeId: payload.nodeId || ''
            });
            return {
              ...result,
              deduped: true
            };
          }
          if (result.claim_extraction_pending) {
            updateCaptureAnalysisStage(payload.entryId, payload.nodeId, {
              analysis_stage: 'extracting claims',
              claim_extraction_pending: true
            });
          }
          var storedClaimIds = [];
          if (Array.isArray(result.claims) && result.claims.length && native?.ingestClaims) {
            const storedClaims = native.ingestClaims(result.claims, {
              source: payload.annotation ? 'show-tell' : 'image',
              sourceRef: {
                imageId: payload.entryId || '',
                itemId: payload.nodeId || ''
              }
            }) || [];
            storedClaimIds = storedClaims.map(function(claim) { return claim?.id; }).filter(Boolean);
          }
          var appendedComment = null;
          if (payload.annotation && payload.nodeId && native?.appendThreadComment) {
            appendedComment = native.appendThreadComment(
              payload.nodeId,
              result.clean,
              'capture_result',
              'show-tell'
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
              });
            }
          }
          applyAnalysisReady(payload, result, {
            claimIds: storedClaimIds,
            commentId: appendedComment?.comment?.id || '',
            countIncrement: payload.annotation ? 1 : 0
          });
          window.StructaFeedback?.fire?.('resolve');
          native?.appendLogEntry?.({ kind: 'llm', message: payload.annotation ? 'show+tell result ready' : 'visual result ready' });
          if (!hadAnalyzedCaptures && !payload.annotation) window.StructaLLM?.speakMilestone?.('first_capture');
          window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
            detail: { source: 'visual-insight' }
          }));
          return result;
        }
        if (result && result.ok && result.savedOnly) {
          applyCaptureSaved(payload, result);
          window.StructaFeedback?.fire?.('resolve');
          return result;
        }
        applyAnalysisUnavailable(payload, payload.annotation ? 'show+tell saved' : 'frame saved');
        native?.appendLogEntry?.({ kind: 'camera', message: payload.annotation ? 'show+tell saved' : 'image description unavailable' });
        window.StructaFeedback?.fire?.('resolve');
        native?.traceEvent?.('image', 'analyzing', 'blocked', {
          jobId: job.id || '',
          entryId: payload.entryId || '',
          reason: result?.reason || 'stalled'
        });
        return {
          ok: true,
          unavailable: true,
          message: payload.annotation ? 'show+tell saved' : 'image description unavailable'
        };
      }).catch(function() {
        applyAnalysisUnavailable(payload, payload.annotation ? 'show+tell saved' : 'frame saved');
        native?.appendLogEntry?.({ kind: 'camera', message: payload.annotation ? 'show+tell saved' : 'image description unavailable' });
        window.StructaFeedback?.fire?.('resolve');
        native?.traceEvent?.('image', 'analyzing', 'blocked', {
          jobId: job.id || '',
          entryId: payload.entryId || '',
          reason: 'exception'
        });
        return {
          ok: true,
          unavailable: true,
          message: payload.annotation ? 'show+tell saved' : 'image description unavailable'
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
      if (getCaps().nativeCapturePreferred && window.r1?.camera?.capturePhoto) {
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
        window.dispatchEvent(new CustomEvent('structa-camera-denied', {
          detail: { reason: err?.name || 'permission-denied' }
        }));
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
          setStatus(CAMERA_READY_STATUS);
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
    setStatus('release for frame + note');

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
    setStatus(CAMERA_READY_STATUS);
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
    if (Date.now() - lastCaptureAt < CAPTURE_COOLDOWN_MS) {
      setStatus('shutter settling');
      window.StructaFeedback?.fire?.('blocked');
      return null;
    }
    lastCaptureAt = Date.now();
    let dataUrl = '';
    let w = preview?.videoWidth || 720;
    let h = preview?.videoHeight || 720;
    if (preview && stream) {
      var scale = Math.min(1, TARGET_CAPTURE_WIDTH / Math.max(1, w));
      var targetWidth = Math.max(180, Math.round(w * scale));
      var targetHeight = Math.max(180, Math.round(h * scale));
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(preview, 0, 0, targetWidth, targetHeight);
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (_) {
        dataUrl = '';
      }
      w = targetWidth;
      h = targetHeight;
    } else if (getCaps().nativeCapturePreferred && window.r1?.camera?.capturePhoto) {
      try {
        const nativeResult = await window.r1.camera.capturePhoto(240, 282);
        const raw = typeof nativeResult === 'string'
          ? nativeResult
          : (nativeResult?.dataUrl || nativeResult?.imageBase64 || nativeResult?.base64 || '');
        dataUrl = raw && raw.indexOf('data:image') === 0 ? raw : (raw ? ('data:image/png;base64,' + raw) : '');
        w = nativeResult?.width || 240;
        h = nativeResult?.height || 282;
      } catch (_) {
        dataUrl = '';
      }
    }
    if (!dataUrl) {
      native?.appendLogEntry?.({ kind: 'camera', message: 'frame capture failed — try again' });
      window.StructaFeedback?.fire?.('blocked');
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
      window.StructaFeedback?.fire?.('capture');
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
    const annotationWindowUntil = 0;
    const operationId = native?.beginOperation?.({
      kind: annotation ? 'show+tell' : 'show',
      allowed: annotation ? { capture: 1, capture_comment: 1, capture_description: 1 } : { capture: 1, capture_description: 1 }
    }) || '';
    const bundle = window.StructaCaptureBundles?.createCaptureBundle?.({
      source_type: 'camera',
      input_type: annotation ? 'image+voice' : 'image',
      image_asset: resolvedAsset,
      prompt_text: annotation || (facingMode === 'user' ? 'selfie frame' : 'camera frame'),
      description_text: '',
      latest_comment_text: '',
      summary: annotation ? 'show+tell saved' : 'frame saved',
      approval_state: 'draft',
      tags: annotation ? [facingMode, 'capture', 'show-tell'] : [facingMode, 'capture'],
      links: [],
      meta: {
        facingMode, width: w, height: h, voiceAnnotation: annotation,
        image_asset_id: resolvedAsset.entry_id || '',
        image_asset_name: resolvedAsset.name || '',
        preview_data: dataUrl,
        analysis_status: 'pending',
        analysis_stage: annotation ? 'queued' : 'queued',
        analysis_enqueued_at: analysisQueuedAt,
        claim_extraction_pending: false,
        annotation_window_until: annotationWindowUntil,
        operation_id: operationId
      }
    });

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

    native?.appendLogEntry?.({ kind: 'camera', message: annotation ? 'show+tell saved' : 'frame saved' });
    window.dispatchEvent(new CustomEvent('structa-fast-feedback', {
      detail: { source: annotation ? 'show-tell' : 'capture' }
    }));

    // Also store as node if available
    var captureNode = null;
    if (native?.addNode) {
      captureNode = native.addNode({
        type: 'capture',
        title: annotation ? 'show+tell: ' + annotation.slice(0, 40) : 'visual note',
        body: annotation || 'visual note',
        source: 'camera',
        capture_image: bundle?.entry_id || null,
        voice_annotation: annotation || null,
        tags: annotation ? ['show-tell', facingMode] : [facingMode],
        meta: {
          bundle_id: bundle?.entry_id || null,
          facingMode: facingMode,
          analysis_status: 'pending',
          analysis_stage: 'queued',
          analysis_enqueued_at: analysisQueuedAt,
          preview_data: dataUrl,
          claim_extraction_pending: false,
          annotation_window_until: annotationWindowUntil
        }
      });
    }
    if (captureNode?.node_id) {
      native?.touchProjectMemory?.(function(project) {
        const refs = findCaptureRefs(project, bundle?.entry_id || '', captureNode.node_id);
        if (refs.capture) refs.capture.node_id = captureNode.node_id;
        if (refs.node) {
          refs.node.capture_image = refs.node.capture_image || bundle?.entry_id || '';
          refs.node.meta = {
            ...(refs.node.meta || {}),
            bundle_id: refs.node.meta?.bundle_id || bundle?.entry_id || ''
          };
        }
      });
    }
    native?.traceEvent?.('image', 'captured', 'stored', {
      entryId: bundle?.entry_id || '',
      annotation: !!annotation,
      nodeId: captureNode?.node_id || ''
    });

    hideOverlay();
    markCaptureAnalysisQueued(bundle?.entry_id || '', captureNode?.node_id || '', dataUrl);
    scheduleAnalysisDrain(annotation ? 120 : 60);

    return bundle;
  }

  function close() {
    voiceStripActive = false;
    voiceStripTranscript = '';
    voiceStripStopping = false;
    pendingVoiceCapture = false;
    setStatus('camera closed');
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

  status?.addEventListener('pointerup', function(event) {
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
    getPendingAnnotation: function() { return null; },
    get voiceStripActive() { return voiceStripActive; },
    get voiceStripTranscript() { return voiceStripTranscript; },
    get facingMode() { return facingMode; },
    get lastBundle() { return lastBundle; },
    get primed() { return streamReady; }
  });
})();
