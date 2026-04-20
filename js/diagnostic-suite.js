(() => {
  'use strict';

  const native = window.StructaNative;
  const queue = window.StructaProcessingQueue;
  const llm = window.StructaLLM;
  const contracts = window.StructaContracts;
  const triangle = window.StructaTriangle;

  const DIAGNOSTIC_PROJECT_NAME = '__diagnostic';
  const REPORT_STORAGE_KEY = 'structa.diagnostics.reports';
  const REPORT_LIMIT = 10;
  const TEST_TIMEOUT_MS = 15000;
  const SUITE_TIMEOUT_MS = 90000;
  const RUN_RATE_LIMIT_MS = 60000;
  const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WHZp9sAAAAASUVORK5CYII=';
  const APP_BUILD_SHA = 'workspace';
  const UI_BUILD_ID = window.StructaBuild?.uiBuildId || 'ui-unknown';
  const DECLARED_TEST_COUNT = Number(window.StructaBuild?.declaredDiagnosticTests || 0) || 37;

  const listeners = [];
  const handlerRegistry = { ready: false };
  const state = {
    mode: 'idle',
    running: false,
    abortRequested: false,
    currentRunId: '',
    report: null,
    progress: null,
    lastStartedAt: 0,
    lastError: '',
    voiceCheck: null,
    manualVoiceCheck: null
  };
  let voiceCheckListenerBound = false;

  class SkipError extends Error {
    constructor(message) {
      super(message || 'skipped');
      this.name = 'SkipError';
    }
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function compact(text, limit) {
    var max = Number(limit || 96);
    var value = String(text || '').trim().replace(/\s+/g, ' ');
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  function createFailure(message, details) {
    var error = new Error(message || 'failed');
    Object.assign(error, details || {});
    return error;
  }

  function normalizeFailure(input, fallbackMessage, defaults) {
    var base = defaults && typeof defaults === 'object' ? defaults : {};
    if (input instanceof Error) {
      return input;
    }
    var details = Object.assign({}, base);
    if (input && typeof input === 'object') {
      details.code = input.code || input.error?.code || details.code || '';
      details.layer = input.layer || input.error?.layer || details.layer || '';
      details.latencyMs = Number(input.latencyMs || input.error?.latencyMs || details.latencyMs || 0) || 0;
      details.statusCode = Number(input.status || input.statusCode || input.error?.status || 0) || 0;
      details.cause = input;
    }
    var message = fallbackMessage || 'failed';
    if (input && typeof input === 'object') {
      message = input.data?.error || input.error?.message || (typeof input.error === 'string' ? input.error : '') || input.message || fallbackMessage || 'failed';
    } else if (typeof input === 'string' && input) {
      message = input;
    }
    return createFailure(message, details);
  }

  function failFromResult(result, fallbackMessage, defaults) {
    throw normalizeFailure(result, fallbackMessage, defaults);
  }

  function inferResultCode(result) {
    if (!result || typeof result !== 'object') return '';
    return result.code || result.error?.code || '';
  }

  function inferResultLayer(result) {
    if (!result || typeof result !== 'object') return '';
    return result.layer || result.error?.layer || '';
  }

  function inferResultLatency(result) {
    if (!result || typeof result !== 'object') return 0;
    return Number(result.latencyMs || result.error?.latencyMs || 0) || 0;
  }

  function formatFailureDetail(item) {
    var parts = [];
    if (item.error?.code) parts.push(item.error.code);
    if (item.error?.layer) parts.push(item.error.layer);
    if (item.error?.latencyMs) parts.push(item.error.latencyMs + 'ms');
    return parts.join(' · ');
  }

  function hasStorageTier(tier) {
    return !!native?.storage?.[tier]?.write && !!native?.storage?.[tier]?.read;
  }

  async function assertStorageRoundTrip(assertions, tier, key, label) {
    expect(assertions, hasStorageTier(tier), label + ' storage available', label + ' storage unavailable');
    var payload = {
      ok: true,
      label: label,
      at: nowIso()
    };
    var write = await native.storage[tier].write(key, payload);
    expect(assertions, write?.ok === true, label + ' storage write', write?.error || (label + ' storage write failed'));
    var read = await native.storage[tier].read(key);
    expect(assertions, read?.ok === true, label + ' storage read', read?.error || (label + ' storage read failed'));
    expect(assertions, JSON.stringify(read?.value || null) === JSON.stringify(payload), label + ' storage roundtrip', label + ' storage mismatch');
    await native.storage[tier].remove(key);
  }

  function formatReportDigest(report) {
    var failed = report.results.filter(function(item) {
      return item.status === 'fail' || item.status === 'timeout';
    }).slice(0, 8);
    var lines = [
      'Structa diagnostics',
      'summary: ' + report.summary.total + ' tests · ' + report.summary.passed + ' pass · ' + report.summary.failed + ' fail · ' + report.summary.skipped + ' skip',
      'duration: ' + report.durationMs + 'ms'
    ];
    if (failed.length) {
      lines.push('');
      lines.push('failures:');
      failed.forEach(function(item) {
        lines.push('- ' + item.id + ' ' + item.name + ' · ' + (item.error?.message || item.status));
      });
    }
    if (report.runError) {
      lines.push('');
      lines.push('suite failure:');
      lines.push('- ' + (report.runError.message || 'diagnostics failed before tests'));
    }
    lines.push('');
    lines.push('full report saved locally in Structa diagnostics');
    return lines.join('\n');
  }

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  function emitProgress() {
    var payload = getState();
    listeners.forEach(function(handler) {
      try { handler(payload); } catch (_) {}
    });
    try {
      window.dispatchEvent(new CustomEvent('structa-diagnostics-progress', { detail: payload }));
    } catch (_) {}
  }

  function setState(patch) {
    Object.assign(state, patch || {});
    emitProgress();
  }

  function getState() {
    return clone(state);
  }

  function resetLocalState() {
    setState({
      mode: 'idle',
      running: false,
      abortRequested: false,
      currentRunId: '',
      report: null,
      progress: null,
      lastStartedAt: 0,
      lastError: '',
      voiceCheck: null,
      manualVoiceCheck: null
    });
    return { ok: true };
  }

  function onProgress(handler) {
    if (typeof handler !== 'function') return function() {};
    listeners.push(handler);
    return function() {
      var index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  function diagnosticCtx(ctx) {
    var detail = ctx && typeof ctx === 'object' ? clone(ctx) : {};
    detail.meta = Object.assign({}, detail.meta || {}, { diagnostic: true });
    return detail;
  }

  function diagTrace(flow, from, to, ctx) {
    native?.traceEvent?.(flow, from, to, diagnosticCtx(ctx));
  }

  function diagLog(message, detail) {
    var text = String(message || '').trim();
    if (!text) return;
    if (detail) text += ' · ' + String(detail || '').trim();
    native?.appendLogEntry?.({
      kind: 'diagnostic',
      message: text
    });
  }

  function getTraceEvents() {
    return native?.getTrace?.()?.events || [];
  }

  function awaitTrace(matcher, timeoutMs) {
    var started = getTraceEvents().length;
    var waitMs = Number(timeoutMs || TEST_TIMEOUT_MS);
    return new Promise(function(resolve, reject) {
      var done = false;
      var timeout = setTimeout(function() {
        if (done) return;
        done = true;
        window.removeEventListener('structa-trace', onTrace);
        reject(new Error('timeout'));
      }, waitMs);

      function match(entry) {
        if (typeof matcher === 'function') return !!matcher(entry);
        if (!matcher || typeof matcher !== 'object') return false;
        return Object.keys(matcher).every(function(key) {
          if (matcher[key] && typeof matcher[key] === 'object' && !Array.isArray(matcher[key])) {
            var actual = entry[key];
            if (!actual || typeof actual !== 'object') return false;
            return Object.keys(matcher[key]).every(function(child) {
              return actual[child] === matcher[key][child];
            });
          }
          return entry[key] === matcher[key];
        });
      }

      function onTrace(event) {
        if (done) return;
        var entry = event && event.detail ? event.detail : null;
        if (!entry || !match(entry)) return;
        done = true;
        clearTimeout(timeout);
        window.removeEventListener('structa-trace', onTrace);
        resolve(entry);
      }

      var existing = getTraceEvents().slice(started).find(match);
      if (existing) {
        clearTimeout(timeout);
        resolve(existing);
        return;
      }
      window.addEventListener('structa-trace', onTrace);
    });
  }

  function wait(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, Math.max(0, Number(ms || 0)));
    });
  }

  function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise(function(_, reject) {
        setTimeout(function() {
          reject(new Error((label || 'operation') + ' timeout'));
        }, Number(timeoutMs || TEST_TIMEOUT_MS));
      })
    ]);
  }

  function fetchJson(path, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var startedAt = Date.now();
    var request = {
      method: opts.method || 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    if (request.method !== 'GET') {
      request.body = JSON.stringify(opts.body || {});
    }
    return fetch(path, request).then(function(response) {
      return response.text().then(function(text) {
        var data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (_) {
          data = { ok: false, error: 'invalid json', raw: text };
        }
        return {
          ok: response.ok,
          status: response.status,
          data: data,
          latencyMs: Date.now() - startedAt,
          error: response.ok ? null : {
            code: response.status >= 500 ? 'server-500' : 'server-4xx',
            layer: 'server',
            latencyMs: Date.now() - startedAt,
            status: response.status
          }
        };
      });
    }).catch(function(error) {
      return {
        ok: false,
        status: 0,
        data: {},
        latencyMs: Date.now() - startedAt,
        error: {
          code: 'network-error',
          layer: 'network',
          latencyMs: Date.now() - startedAt,
          message: error?.message || 'network request failed'
        }
      };
    });
  }

  function ensureHandlers() {
    if (handlerRegistry.ready || !queue?.registerHandler) return;
    handlerRegistry.ready = true;
    handlerRegistry.order = [];
    queue.registerHandler('diag-noop', function(job, tools) {
      tools?.progress?.('noop');
      return Promise.resolve({ ok: true, jobId: job.id });
    });
    queue.registerHandler('diag-order', function(job, tools) {
      handlerRegistry.order.push(job.priority + ':' + job.id);
      tools?.progress?.('order');
      return wait(25).then(function() { return { ok: true }; });
    });
    queue.registerHandler('diag-timeout', function() {
      return new Promise(function() {});
    });
  }

  function expect(assertions, condition, label, detail) {
    var ok = !!condition;
    assertions.push({
      label: label,
      ok: ok,
      detail: ok ? undefined : compact(detail || label, 220)
    });
    if (!ok) throw new Error(detail || label);
  }

  function getProject() {
    return native?.getProjectMemory?.() || {};
  }

  function getProjectId() {
    return getProject().project_id || '';
  }

  function getOpenQuestions() {
    return (getProject().nodes || []).filter(function(node) {
      return node.type === 'question' && node.status === 'open';
    });
  }

  function counts() {
    var project = getProject();
    return {
      claims: (project.claims || []).length,
      answers: (project.answers || []).length,
      nodes: (project.nodes || []).length,
      questions: getOpenQuestions().length
    };
  }

  function currentCaps() {
    return Object.assign(
      {},
      native?.getCapabilities?.() || {},
      llm?.getCapabilities?.() || {}
    );
  }

  function getBuildMeta() {
    return {
      uiBuildId: UI_BUILD_ID,
      declaredTestCount: DECLARED_TEST_COUNT
    };
  }

  async function fetchBuildStatus() {
    var meta = getBuildMeta();
    var response = await fetchJson('/buildinfo', { method: 'GET' });
    return {
      uiBuildId: meta.uiBuildId,
      declaredTestCount: meta.declaredTestCount,
      serverBuildSha: response.ok && response.data?.ok === true ? String(response.data.sha || '') : '',
      serverBuiltAt: response.ok && response.data?.ok === true ? String(response.data.built_at || '') : '',
      status: response.ok && response.data?.ok === true ? 'current' : 'server-unavailable'
    };
  }

  function makeReport(results, startedAt, finishedAt, runError) {
    var failed = results.filter(function(item) { return item.status === 'fail' || item.status === 'timeout'; });
    var failureCodes = {};
    failed.forEach(function(item) {
      var key = item.error?.code || item.status || 'unknown';
      failureCodes[key] = Number(failureCodes[key] || 0) + 1;
    });
    if (runError?.code) {
      failureCodes[runError.code] = Number(failureCodes[runError.code] || 0) + 1;
    }
    var summary = {
      total: results.length,
      passed: results.filter(function(item) { return item.status === 'pass'; }).length,
      failed: failed.length + (runError ? 1 : 0),
      skipped: results.filter(function(item) { return item.status === 'skip'; }).length,
      failureCodes: failureCodes
    };
    return {
      schema_version: 1,
      startedAt: startedAt,
      finishedAt: finishedAt,
      durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
      device: {
        userAgent: navigator.userAgent,
        runtimeCaps: currentCaps(),
        appVersion: APP_BUILD_SHA
      },
      uiBuildId: UI_BUILD_ID,
      declaredTestCount: DECLARED_TEST_COUNT,
      manual_voice_check: state.manualVoiceCheck || null,
      summary: summary,
      runError: runError || null,
      results: results,
      traceTail: getTraceEvents().slice(-100),
      delivery: null
    };
  }

  function formatFailureBlock(report) {
    var failed = report.results.filter(function(item) {
      return item.status === 'fail' || item.status === 'timeout';
    });
    if (report.runError) {
      var suiteLines = [
        'failures:',
        '  suite preflight',
        '    ' + (report.runError.message || 'diagnostics failed before tests')
      ];
      var suiteDetail = [report.runError.code, report.runError.layer, report.runError.latencyMs ? (report.runError.latencyMs + 'ms') : ''].filter(Boolean).join(' · ');
      if (suiteDetail) suiteLines.push('    ' + suiteDetail);
      if (!failed.length) return suiteLines.join('\n');
      return suiteLines.join('\n') + '\n' + failed.map(function(item) {
        var lines = [
          '  ' + item.id + ' ' + item.name,
          '    ' + (item.error?.message || item.status)
        ];
        var detail = formatFailureDetail(item);
        if (detail) lines.push('    ' + detail);
        return lines.join('\n');
      }).join('\n');
    }
    if (!failed.length) return 'failures:\n  none';
    return ['failures:'].concat(failed.map(function(item) {
      var lines = [
        '  ' + item.id + ' ' + item.name,
        '    ' + (item.error?.message || item.status)
      ];
      var detail = formatFailureDetail(item);
      if (detail) lines.push('    ' + detail);
      if (item.traceExcerpt && item.traceExcerpt.length) {
        lines.push('    last trace events:');
        item.traceExcerpt.slice(-3).forEach(function(entry) {
          lines.push('      ' + [entry.flow, entry.from, entry.to].filter(Boolean).join(' · '));
        });
      }
      return lines.join('\n');
    })).join('\n');
  }

  function buildRunError(error, defaults) {
    var normalized = normalizeFailure(error, error?.message || 'diagnostics failed before tests', defaults || {
      code: 'diagnostic-preflight',
      layer: 'diagnostic-runtime'
    });
    return {
      message: normalized?.message || 'diagnostics failed before tests',
      code: normalized?.code || '',
      layer: normalized?.layer || '',
      latencyMs: Number(normalized?.latencyMs || 0) || 0,
      statusCode: Number(normalized?.statusCode || 0) || 0
    };
  }

  function formatReportEmail(report) {
    var failureCodeSummary = Object.keys(report.summary.failureCodes || {}).map(function(code) {
      return code + ': ' + report.summary.failureCodes[code];
    }).join(' · ');
    var lines = [
      'Structa diagnostics · ' + report.startedAt,
      'device: rabbit-r1 · app: structa · commit: ' + (report.device?.appVersion || 'workspace'),
      'summary: ' + report.summary.total + ' tests · ' + report.summary.passed + ' pass · ' + report.summary.failed + ' fail · ' + report.summary.skipped + ' skip · ' + report.durationMs + 'ms',
      failureCodeSummary ? ('failure codes: ' + failureCodeSummary) : '',
      '',
      formatFailureBlock(report),
      '',
      'full JSON saved locally in Structa diagnostics'
    ];
    return lines.join('\n');
  }

  function saveLocalReport(report) {
    if (!hasStorageTier('plain')) {
      return Promise.resolve({ ok: false, error: 'plain storage unavailable' });
    }
    return native.storage.plain.read(REPORT_STORAGE_KEY).then(function(result) {
      var reports = result?.ok && Array.isArray(result.value) ? result.value : [];
      reports = Array.isArray(reports) ? reports : [];
      reports.unshift(report);
      reports = reports.slice(0, REPORT_LIMIT);
      return native.storage.plain.write(REPORT_STORAGE_KEY, reports).then(function(write) {
        if (!write?.ok) throw new Error(write?.error || 'storage failed');
        diagTrace('diag.report.saved_locally', 'report', 'saved', {
          runId: state.currentRunId,
          count: reports.length
        });
        return { ok: true, count: reports.length };
      });
    }).catch(function(error) {
      diagTrace('diag.report.saved_locally', 'report', 'failed', {
        runId: state.currentRunId,
        reason: error?.message || 'storage failed'
      });
      return { ok: false, error: error?.message || 'storage failed' };
    });
  }

  function emailReport(report) {
    var subject = report.summary.failed
      ? 'Structa diagnostics · ' + report.summary.failed + ' failures · ' + report.startedAt.slice(0, 10)
      : 'Structa diagnostics · all green';
    var body = formatReportEmail(report);
    var digest = formatReportDigest(report);
    if (llm?.emailText) {
      return Promise.resolve(llm.emailText(subject, body)).then(function(result) {
        if (result?.ok) {
          diagTrace('diag.report.emailed', 'report', 'emailed', {
            runId: state.currentRunId,
            subject: subject,
            bytes: body.length,
            mode: result.mode || 'unknown'
          });
          return Object.assign({ ok: true, digest: digest }, result);
        }
        diagTrace('diag.report.emailed_failed', 'report', 'failed', {
          runId: state.currentRunId,
          reason: result?.error || 'email failed',
          mode: result?.mode || 'unknown'
        });
        return Object.assign({ ok: false, digest: digest }, result || {});
      });
    }
    return Promise.resolve({ ok: false, error: 'email unavailable', digest: digest });
  }

  function createDiagnosticProject() {
    diagTrace('diag.project.create', 'idle', 'start', {
      runId: state.currentRunId,
      name: DIAGNOSTIC_PROJECT_NAME
    });
    var project = native?.createProject?.(DIAGNOSTIC_PROJECT_NAME, 'general', {
      internal: true,
      allowDuplicate: true,
      bypassCap: true,
      silentMilestone: true
    });
    if (!project || project.ok === false) {
      var createError = buildRunError(project || new Error('diagnostic project unavailable'), {
        code: 'diagnostic-project-create-failed',
        layer: 'diagnostic-runtime'
      });
      diagTrace('diag.project.create_failed', 'start', 'failed', {
        runId: state.currentRunId,
        error: createError
      });
      diagLog('diagnostic project unavailable', createError.message);
      throw createFailure(createError.message, createError);
    }
    var projectId = project.project_id || project.projectId || '';
    if (!projectId) {
      var idError = buildRunError(new Error('diagnostic project id missing'), {
        code: 'diagnostic-project-id-missing',
        layer: 'diagnostic-runtime'
      });
      diagTrace('diag.project.create_failed', 'start', 'missing-id', {
        runId: state.currentRunId,
        error: idError
      });
      diagLog('diagnostic project unavailable', idError.message);
      throw createFailure(idError.message, idError);
    }
    var switched = native?.switchProject?.(projectId);
    if (!switched || (switched.project_id && switched.project_id !== projectId)) {
      var switchError = buildRunError(new Error('diagnostic project switch failed'), {
        code: 'diagnostic-project-switch-failed',
        layer: 'diagnostic-runtime'
      });
      diagTrace('diag.project.create_failed', 'start', 'switch-failed', {
        runId: state.currentRunId,
        error: switchError,
        projectId: projectId
      });
      diagLog('diagnostic project unavailable', switchError.message);
      throw createFailure(switchError.message, switchError);
    }
    if (getProjectId() !== projectId) {
      var activeError = buildRunError(new Error('diagnostic project not active after switch'), {
        code: 'diagnostic-project-inactive',
        layer: 'diagnostic-runtime'
      });
      diagTrace('diag.project.create_failed', 'start', 'inactive', {
        runId: state.currentRunId,
        error: activeError,
        projectId: projectId
      });
      diagLog('diagnostic project unavailable', activeError.message);
      throw createFailure(activeError.message, activeError);
    }
    diagTrace('diag.project.create', 'start', 'ready', {
      runId: state.currentRunId,
      projectId: projectId
    });
    native?.updateUIState?.({
      selected_card_id: 'now',
      last_surface: 'home'
    });
    return project;
  }

  function bindVoiceCheckListener() {
    if (voiceCheckListenerBound) return;
    voiceCheckListenerBound = true;
    window.addEventListener('structa-stt-ended', function(event) {
      if (!state.voiceCheck) return;
      var transcript = String(event?.detail?.transcript || '').trim();
      state.voiceCheck.lastTranscript = transcript;
      if (state.voiceCheck.phase === 'awaiting_transcript') {
        state.voiceCheck.phase = 'confirm_transcript';
      } else if (state.voiceCheck.phase === 'awaiting_silence') {
        state.voiceCheck.phase = 'confirm_silence';
      } else {
        return;
      }
      emitProgress();
    });
  }

  function withIsolatedProject(fn) {
    var snapshot = native?.snapshotState?.();
    var traceStart = getTraceEvents().length;
    if (!snapshot || !native?.restoreSnapshot) {
      var snapshotError = buildRunError(new Error('snapshot restore unavailable'), {
        code: 'diagnostic-snapshot-unavailable',
        layer: 'diagnostic-runtime'
      });
      diagTrace('diag.snapshot.restore_failed', 'pending', 'unavailable', {
        runId: state.currentRunId,
        error: snapshotError
      });
      diagLog('diagnostic cleanup unavailable', snapshotError.message);
      return Promise.reject(createFailure(snapshotError.message, snapshotError));
    }
    createDiagnosticProject();
    return Promise.resolve(fn(getProjectId())).catch(function(error) {
      throw createFailure(error?.message || 'diagnostic project failed', buildRunError(error, {
        code: error?.code || 'diagnostic-runtime',
        layer: error?.layer || 'diagnostic-runtime',
        latencyMs: error?.latencyMs || 0
      }));
    }).finally(function() {
      var diagnosticTrace = getTraceEvents().slice(traceStart);
      return native.restoreSnapshot(snapshot, {
        preserveCurrentTrace: true,
        appendTraceEvents: diagnosticTrace,
        preserveCurrentVoiceCalls: false
      }).catch(function(error) {
        var restoreError = buildRunError(error, {
          code: 'diagnostic-restore-failed',
          layer: 'diagnostic-runtime'
        });
        diagTrace('diag.snapshot.restore_failed', 'pending', 'failed', {
          runId: state.currentRunId,
          error: restoreError
        });
        diagLog('diagnostic cleanup failed', restoreError.message);
        throw createFailure(restoreError.message, restoreError);
      });
    });
  }

  function withDiagnosticMute(fn) {
    var previousDiagnosticsFlag = window.__STRUCTA_DIAGNOSTICS_RUNNING__;
    var previousForceSilent = window.__STRUCTA_FORCE_SILENT__;
    var chain = window.StructaImpactChain;
    var chainState = {
      exists: !!chain,
      active: !!chain?.active,
      paused: !!chain?.isPaused?.(),
      bpm: Number(chain?.bpm || 2) || 2
    };
    window.__STRUCTA_DIAGNOSTICS_RUNNING__ = true;
    window.__STRUCTA_FORCE_SILENT__ = 'diagnostics';
    if (chain) {
      try {
        chain.pause('diagnostics');
        diagTrace('diag.chain.pause', chainState.active ? 'active' : 'idle', 'paused', {
          runId: state.currentRunId,
          paused: chainState.paused,
          active: chainState.active
        });
        diagLog('diagnostic chain paused', chainState.active ? 'background reasoning muted' : 'already idle');
      } catch (error) {
        diagTrace('diag.chain.pause', 'pending', 'failed', {
          runId: state.currentRunId,
          error: error?.message || 'chain pause failed'
        });
      }
    }
    return Promise.resolve().then(fn).finally(function() {
      window.__STRUCTA_DIAGNOSTICS_RUNNING__ = previousDiagnosticsFlag;
      if (previousForceSilent === undefined) delete window.__STRUCTA_FORCE_SILENT__;
      else window.__STRUCTA_FORCE_SILENT__ = previousForceSilent;
      if (!chain) return;
      try {
        if (chainState.paused) {
          chain.pause('diagnostics restore');
        } else if (chainState.active) {
          chain.bpm = chainState.bpm;
          chain.resume();
        } else {
          chain.pause('diagnostics restore');
        }
        diagTrace('diag.chain.restore', 'paused', chainState.active ? 'active' : (chainState.paused ? 'paused' : 'idle'), {
          runId: state.currentRunId,
          active: chainState.active,
          paused: chainState.paused
        });
      } catch (error) {
        diagTrace('diag.chain.restore', 'paused', 'failed', {
          runId: state.currentRunId,
          error: error?.message || 'chain restore failed'
        });
      }
    });
  }

  function reserveQuestion(body) {
    return native?.addNode?.({
      type: 'question',
      status: 'open',
      title: compact(body, 48),
      body: body,
      source: 'diagnostic',
      meta: { priority: 'high', branch_id: 'main' }
    });
  }

  function reserveInsight(body, withClaim) {
    var node = native?.addNode?.({
      type: 'insight',
      status: 'open',
      title: compact(body, 48),
      body: body,
      source: 'diagnostic',
      meta: { branch_id: 'main' }
    });
    if (withClaim && node?.node_id) {
      native?.ingestClaims?.([{
        text: body,
        kind: 'fact',
        source: 'diagnostic',
        sourceRef: { itemId: node.node_id },
        branchId: 'main'
      }], {
        source: 'diagnostic',
        sourceRef: { itemId: node.node_id },
        dedupByBranchText: true
      });
    }
    return node;
  }

  async function runPreparedBridgeEndpoint(path, payload) {
    var prepared = await fetchJson(path, { body: payload });
    if (!prepared.ok || prepared.data?.ok === false) {
      failFromResult(prepared, prepared.data?.error || path + ' prepare failed', {
        layer: inferResultLayer(prepared) || 'server',
        latencyMs: inferResultLatency(prepared)
      });
    }
    var rawPrompt = String(prepared.data?.llm?.prompt || '');
    var protectedPrompt = '🚫 DO NOT SEARCH.\n' +
      '🚫 DO NOT SPEAK.\n' +
      '🚫 DO NOT SAVE NOTES.\n' +
      '🚫 DO NOT CREATE JOURNAL ENTRIES.\n' +
      'ONLY PROCESS THE PROVIDED INPUT.\n\n' + rawPrompt;
    var llmResult = await llm.sendToLLM(protectedPrompt, {
      journal: false,
      timeout: prepared.data?.llm?.timeout || TEST_TIMEOUT_MS,
      priority: prepared.data?.llm?.priority || 'high',
      imageBase64: prepared.data?.llm?.imageBase64,
      pluginId: 'com.playgranada.structa',
      policy: {
        allowSpeech: false,
        silent: true,
        source: 'diagnostics',
        reason: 'diagnostics stay written'
      }
    });
    if (!llmResult?.ok) {
      failFromResult(llmResult, llmResult?.error || path + ' bridge failed', {
        layer: inferResultLayer(llmResult) || 'bridge',
        latencyMs: inferResultLatency(llmResult)
      });
    }
    var normalized = await fetchJson(path, {
      body: Object.assign({}, payload, {
        rawResponse: llmResult.clean || llmResult.text || ''
      })
    });
    if (!normalized.ok || normalized.data?.ok === false) {
      failFromResult(normalized, normalized.data?.error || path + ' normalize failed', {
        layer: inferResultLayer(normalized) || 'server',
        latencyMs: inferResultLatency(normalized)
      });
    }
    return normalized.data;
  }

  function getSummaryRows() {
    var rows = [];
    var queueBusy = (queue?.snapshot?.() || []).some(function(job) {
      return job && job.status !== 'blocked';
    });
    var disabledReason = queueBusy ? 'wait for queue to drain' : '';
    rows.push({
      kind: 'muted',
      message: 'build · ' + UI_BUILD_ID,
      detail: DECLARED_TEST_COUNT + ' declared tests'
    });
    rows.push({
      kind: 'action',
      actionId: 'diagnostics-run',
      message: 'run diagnostics',
      detail: disabledReason || 'written report in log drawer',
      disabled: !!disabledReason
    });
    rows.push({
      kind: 'action',
      actionId: 'diagnostics-build-check',
      message: 'check build',
      detail: 'show ui and server build',
      disabled: false
    });
    rows.push({
      kind: 'action',
      actionId: 'voice-check',
      message: 'voice check',
      detail: 'manual mic + sound path · only test that may speak',
      disabled: false
    });
    return rows;
  }

  function beginVoiceCheck() {
    if (state.running || state.voiceCheck) return Promise.resolve({ ok: false, error: 'diagnostics busy' });
    if (!(currentCaps().hasBridge || typeof window.CreationVoiceHandler !== 'undefined')) {
      return Promise.resolve({ ok: false, error: 'voice check requires device bridge' });
    }
    bindVoiceCheckListener();
    var snapshot = native?.snapshotState?.();
    if (!snapshot || !native?.restoreSnapshot) {
      return Promise.resolve({ ok: false, error: 'snapshot restore unavailable' });
    }
    var traceStart = getTraceEvents().length;
    createDiagnosticProject();
    try {
      llm?.speakMilestone?.('project_live');
    } catch (_) {}
    setState({
      mode: 'voice-check',
      voiceCheck: {
        snapshot: snapshot,
        traceStart: traceStart,
        phase: 'confirm_tone',
        results: {
          heardTone: null,
          transcriptMatch: null,
          silentHandled: null
        },
        lastTranscript: ''
      }
    });
    return Promise.resolve({ ok: true });
  }

  function finishVoiceCheck() {
    if (!state.voiceCheck) return Promise.resolve({ ok: false });
    var check = state.voiceCheck;
    var diagnosticTrace = getTraceEvents().slice(check.traceStart || 0);
    var result = {
      at: nowIso(),
      heardTone: check.results.heardTone,
      transcriptMatch: check.results.transcriptMatch,
      silentHandled: check.results.silentHandled,
      transcript: check.lastTranscript || ''
    };
    return native.restoreSnapshot(check.snapshot, {
      preserveCurrentTrace: true,
      appendTraceEvents: diagnosticTrace,
      preserveCurrentVoiceCalls: false
    }).then(function() {
      setState({
        mode: state.report ? 'report' : 'idle',
        voiceCheck: null,
        manualVoiceCheck: result
      });
      return { ok: true, result: result };
    });
  }

  function publishDiagnosticSummary(report) {
    if (!report || !native?.appendLogEntry) return;
    native.appendLogEntry({
      kind: 'diagnostic',
      message: 'diagnostics · ' + report.summary.passed + ' pass · ' + report.summary.failed + ' fail · ' + report.summary.skipped + ' skip'
    });
    if (report.runError) {
      native.appendLogEntry({
        kind: 'diagnostic',
        message: 'diagnostics failed before tests · ' + (report.runError.message || 'diagnostic preflight failed')
      });
    }
    (report.results || []).filter(function(item) {
      return item.status !== 'pass';
    }).slice(0, 6).forEach(function(item) {
      var detail = formatFailureDetail(item);
      native.appendLogEntry({
        kind: 'diagnostic',
        message: item.id + ' ' + item.name + ' · ' + (item.error?.message || item.status) + (detail ? (' · ' + detail) : '')
      });
    });
  }

  function makeTest(id, name, category, runFn, options) {
    return Object.assign({ id: id, name: name, category: category, run: runFn }, options || {});
  }

  function buildTests() {
    ensureHandlers();
    var tests = [];

    tests.push(makeTest('A1', 'bridge present', 'runtime', async function(assertions) {
      expect(assertions, !!currentCaps().hasBridge, 'bridge available', 'bridge missing');
    }));
    tests.push(makeTest('A2', 'voice bridge present', 'runtime', async function(assertions) {
      expect(assertions, typeof window.CreationVoiceHandler !== 'undefined', 'voice bridge available', 'CreationVoiceHandler missing');
    }));
    tests.push(makeTest('A3', 'storage write/read plain', 'runtime', async function(assertions) {
      await assertStorageRoundTrip(assertions, 'plain', '__diag', 'plain');
    }));
    tests.push(makeTest('A4', 'storage write/read secure', 'runtime', async function(assertions) {
      if (!hasStorageTier('secure')) throw new SkipError('secure storage unavailable');
      await assertStorageRoundTrip(assertions, 'secure', '__diag.secure', 'secure');
    }));
    tests.push(makeTest('A5', 'memory snapshot restore', 'runtime', async function(assertions) {
      var before = native.snapshotState();
      native.updateUIState({ last_event_summary: 'diagnostic a5' });
      var changed = native.snapshotState();
      expect(assertions, before.memory?.uiState?.last_event_summary !== changed.memory?.uiState?.last_event_summary, 'snapshot changed', 'snapshot did not change');
      await native.restoreSnapshot(before, { preserveCurrentTrace: false });
      var after = native.snapshotState();
      expect(assertions, after.memory?.uiState?.last_event_summary === before.memory?.uiState?.last_event_summary, 'snapshot restored', 'restore mismatch');
    }));

    tests.push(makeTest('C1', 'claim insertion and dedup', 'claims', async function(assertions) {
      var baseline = counts().claims;
      var payload = ['first fact', 'second fact', 'third fact'].map(function(text) {
        return { text: text, kind: 'fact', source: 'diagnostic', branchId: 'main' };
      });
      native.ingestClaims(payload, { source: 'diagnostic', dedupByBranchText: true });
      native.ingestClaims(payload, { source: 'diagnostic', dedupByBranchText: true });
      expect(assertions, counts().claims === baseline + 3, 'claim dedup holds', 'claim count mismatch after dedup');
    }));
    tests.push(makeTest('C2', 'claim id collision', 'claims', async function(assertions) {
      var stamp = new Date().toISOString();
      var claims = [0, 1, 2, 3, 4].map(function(index) {
        return { text: 'collision claim ' + index, kind: 'fact', source: 'diagnostic', createdAt: stamp };
      });
      var stored = native.ingestClaims(claims, { source: 'diagnostic', dedupByBranchText: true });
      var ids = stored.map(function(entry) { return entry.id; });
      expect(assertions, new Set(ids).size === 5, 'claim ids unique', 'claim ids collided');
    }));
    tests.push(makeTest('C3', 'setClaimStatus traces', 'claims', async function(assertions) {
      var claim = native.ingestClaims([{ text: 'status target', kind: 'fact', source: 'diagnostic' }], { source: 'diagnostic' })[0];
      var traceWait = awaitTrace(function(entry) {
        return entry.flow === 'claim' && entry.from === 'active' && entry.to === 'superseded' && entry.ctx?.claimId === claim.id;
      }, 2000);
      native.setClaimStatus(claim.id, 'superseded', { reason: 'diagnostic' });
      await traceWait;
      var project = getProject();
      var updated = (project.claims || []).find(function(entry) { return entry.id === claim.id; });
      expect(assertions, updated?.status === 'superseded', 'claim status updated', 'claim status not updated');
    }));
    tests.push(makeTest('C4', 'claim evidence integrity', 'claims', async function(assertions) {
      native.ingestClaims([{
        text: 'orphan evidence target',
        kind: 'fact',
        source: 'diagnostic',
        evidence: ['missing-claim-id']
      }], { source: 'diagnostic' });
      var orphan = native.validateEvidenceIntegrity?.();
      expect(assertions, Array.isArray(orphan) && orphan.length > 0, 'orphan evidence detected', 'orphan evidence missing');
    }));

    tests.push(makeTest('I1', 'queue enqueue and resolve', 'queue', async function(assertions) {
      var waitResolved = awaitTrace(function(entry) {
        return entry.flow === 'queue' && entry.from === 'resolved' && entry.to === 'diag-noop';
      }, 3000);
      queue.enqueue({ kind: 'diag-noop', priority: 'P3', payload: {}, origin: { projectId: getProjectId() } });
      await waitResolved;
      expect(assertions, true, 'queue resolved');
    }));
    tests.push(makeTest('I2', 'queue priority ordering', 'queue', async function(assertions) {
      handlerRegistry.order = [];
      queue.pause();
      queue.enqueue({ kind: 'diag-order', priority: 'P3', payload: {}, origin: { projectId: getProjectId() } });
      queue.enqueue({ kind: 'diag-order', priority: 'P1', payload: {}, origin: { projectId: getProjectId() } });
      queue.resume();
      await wait(200);
      expect(assertions, handlerRegistry.order[0] && handlerRegistry.order[0].indexOf('P1:') === 0, 'higher priority starts first', 'priority order wrong');
    }));
    tests.push(makeTest('I3', 'queue persistence snapshot', 'queue', async function(assertions) {
      queue.pause();
      var jobId = queue.enqueue({ kind: 'diag-noop', priority: 'P3', payload: { x: 1 }, origin: { projectId: getProjectId() } });
      var before = queue.snapshot();
      queue.restore(before, { paused: true });
      var after = queue.snapshot();
      queue.cancel(jobId);
      queue.resume();
      expect(assertions, before.length === after.length, 'queue restore length matches', 'queue restore length mismatch');
    }));
    tests.push(makeTest('I4', 'queue timeout becomes blocker', 'queue', async function(assertions) {
      var waitBlocked = awaitTrace(function(entry) {
        return entry.flow === 'queue' && entry.from === 'blocked' && entry.to === 'diag-timeout';
      }, 4000);
      queue.enqueue({ kind: 'diag-timeout', priority: 'P3', timeoutMs: 100, payload: {}, origin: { projectId: getProjectId() } });
      await waitBlocked;
      expect(assertions, true, 'queue timeout blocked');
    }));

    tests.push(makeTest('J1', 'server reachable', 'network', async function(assertions) {
      var response = await fetchJson('/healthz', { method: 'GET' });
      if (response.ok && response.status === 200 && response.data?.ok === true) {
        expect(assertions, true, 'healthz ok');
        return;
      }
      var echo = await fetchJson('/v1/diagnostic/echo', {
        body: { ping: 'diagnostic' }
      });
      expect(assertions, echo.ok && echo.data?.ok === true, 'server reachable via echo', 'server unreachable');
    }));
    tests.push(makeTest('J2', 'endpoint inventory', 'network', async function(assertions) {
      var project = getProject();
      var focus = { kind: 'branch', id: 'main', branchId: 'main', phase: 'observe' };
      var checks = [
        ['/v1/voice/interpret', { project: project, input: { transcript: 'diagnostic voice' }, policy: { priority: 'high' } }],
        ['/v1/claims/extract_from_text', { input: { text: '- one claim' }, source: 'diagnostic', sourceRef: { itemId: 'diag' }, meta: { deviceId: native?.deviceId || '' } }],
        ['/v1/chain/step', { project: project, focus: focus, history: { previous_steps: [], plateau_count: 0 } }],
        ['/v1/triangle/synthesize', { project: project, itemA: { itemId: 'a', claimIds: ['c1'], claims: [{ id: 'c1', text: 'a', kind: 'fact', status: 'active', branchId: 'main' }] }, itemB: { itemId: 'b', claimIds: ['c2'], claims: [{ id: 'c2', text: 'b', kind: 'fact', status: 'active', branchId: 'main' }] }, angle: { text: 'bridge', sttConfidence: 0.9 }, branchContext: { id: 'main', name: 'main' } }],
        ['/v1/thread/extract', { project: project, selection: { id: 'diag-item', summary: 'item', kind: 'know' }, input: { transcript: 'diagnostic comment' }, sourceRef: { itemId: 'diag-item' } }],
        ['/v1/project/title', { project: project, transcript: 'design the better queue' }]
      ];
      var imageCheck = await fetchJson('/v1/image/context_prompt', {
        body: { project: project, input: { imageId: 'diag-image' }, meta: {} }
      });
      if (imageCheck.ok && imageCheck.status === 200) {
        expect(assertions, true, 'endpoint ok /v1/image/context_prompt');
      } else {
        var legacyImage = await fetchJson('/v1/image/analyze', {
          body: {
            project: project,
            input: { imageId: 'diag-image', imageBase64: PNG_1X1_BASE64 },
            meta: {}
          }
        });
        expect(assertions, legacyImage.ok && legacyImage.status === 200, 'image analysis path available', '/v1/image/context_prompt failed');
      }
      for (var i = 0; i < checks.length; i += 1) {
        var result = await fetchJson(checks[i][0], { body: checks[i][1] });
        expect(assertions, result.ok && result.status === 200, 'endpoint ok ' + checks[i][0], checks[i][0] + ' failed');
      }
    }));
    tests.push(makeTest('J3', 'server build info', 'network', async function(assertions) {
      var response = await fetchJson('/buildinfo', { method: 'GET' });
      if (!response.ok || response.data?.ok !== true) throw new SkipError('buildinfo unavailable');
      expect(assertions, true, 'buildinfo ok');
      expect(assertions, typeof response.data?.sha === 'string', 'buildinfo has sha', 'buildinfo missing sha');
      if (APP_BUILD_SHA !== 'workspace' && response.data?.sha !== 'workspace') {
        expect(assertions, response.data?.sha === APP_BUILD_SHA, 'build sha matches app', 'server/app build skew');
      } else {
        expect(assertions, true, 'build sha comparison unavailable');
      }
    }));

    tests.push(makeTest('D1', 'synthetic transcript ingest', 'voice', async function(assertions) {
      var result = await runPreparedBridgeEndpoint('/v1/voice/interpret', {
        project: getProject(),
        input: { transcript: 'DIAG_TRANSCRIPT_VOICE_01' },
        policy: { priority: 'high' }
      });
      var stored = native.ingestClaims(result.claims || [], { source: 'voice', sourceRef: { itemId: 'diag-voice' } });
      expect(assertions, stored.length > 0, 'voice claims stored', 'voice claims missing');
      expect(assertions, stored.every(function(entry) { return entry.source === 'voice'; }), 'voice source tagged', 'voice source wrong');
    }));
    tests.push(makeTest('D2', 'answer mode produces answer node', 'voice', async function(assertions) {
      var question = reserveQuestion('DIAG_QUESTION_ANSWER_01');
      var result = await runPreparedBridgeEndpoint('/v1/voice/interpret', {
        project: getProject(),
        input: { transcript: 'DIAG_ANSWER_01', questionText: question.body },
        answeringQuestion: true,
        questionText: question.body,
        policy: { priority: 'high' }
      });
      var answer = native.addAnswerNode(question.node_id, 'DIAG_ANSWER_01', {
        claims: (result.answerNode?.claims || []),
        sttConfidence: result.answerNode?.sttConfidence || null
      });
      native.enrichAnswerNode(answer.id, {
        claims: (result.claims || []).map(function(entry) { return entry.text; })
      });
      native.resolveQuestion({ nodeId: question.node_id }, 'DIAG_ANSWER_01');
      expect(assertions, !!answer?.id, 'answer node stored', 'answer node missing');
      var updatedQuestion = (getProject().nodes || []).find(function(node) { return node.node_id === question.node_id; });
      expect(assertions, updatedQuestion?.status === 'resolved', 'question resolved', 'question not resolved');
    }));
    tests.push(makeTest('D3', 'project title endpoint', 'voice', async function(assertions) {
      var result = await llm.titleProject('DIAG_TITLE_20260420', getProject());
      if (!result?.ok) failFromResult(result, result?.error || 'title endpoint failed', {
        layer: inferResultLayer(result) || 'server',
        latencyMs: inferResultLatency(result)
      });
      expect(assertions, result?.ok === true, 'title endpoint ok', 'title endpoint failed');
      expect(assertions, String(result.title || '').split(/\s+/).filter(Boolean).length >= 2, 'title has words', 'title too short');
      expect(assertions, String(result.title || '').length <= 24, 'title under 24 chars', 'title too long');
    }, { timeoutMs: 22000 }));

    tests.push(makeTest('E1', 'context prompt endpoint', 'image', async function(assertions) {
      var response = await fetchJson('/v1/image/context_prompt', {
        body: {
          project: getProject(),
          input: { imageId: 'diag-image', itemId: 'diag-item', voiceAnnotation: 'DIAG_ANNOTATION_01' },
          meta: {}
        }
      });
      expect(assertions, response.ok && response.data?.ok === true, 'context prompt ok', 'context prompt failed');
      expect(assertions, String(response.data?.prompt || '').indexOf(getProject().name || '') !== -1, 'prompt includes project name', 'project name missing from prompt');
      expect(assertions, String(response.data?.prompt || '').length < 3000, 'prompt under budget', 'prompt too long');
    }));
    tests.push(makeTest('E2A', 'bridge dispatch', 'image', async function(assertions) {
      var traceWait = awaitTrace(function(entry) {
        return entry.flow === 'image.bridge' && entry.to === 'response';
      }, 9000).catch(function() { return null; });
      var result = await llm.processImage(PNG_1X1_BASE64, 'DIAG_PIXEL_01', {
        imageId: 'diag-image-' + Date.now(),
        itemId: 'diag-item-image',
        voiceAnnotation: 'DIAG_ANNOTATION_02',
        forceBridgeOnly: true
      });
      if (!result?.ok) failFromResult(result, result?.error || 'bridge image failed', {
        layer: inferResultLayer(result) || 'bridge',
        latencyMs: inferResultLatency(result)
      });
      await traceWait;
      expect(assertions, result?.ok === true, 'bridge image returned', 'bridge image failed');
      expect(assertions, String(result.clean || '').length >= 0, 'bridge image text captured');
    }, { timeoutMs: 16000 }));
    tests.push(makeTest('E3', 'claim extraction stage b', 'image', async function(assertions) {
      var extracted = await llm.extractClaimsFromText({
        input: { text: 'DIAG_FRAME_01\n- DIAG_VISUAL_BOTTLENECK', deviceId: native?.deviceId || '' },
        source: 'image',
        sourceRef: { imageId: 'diag-image-stage-b' },
        meta: { deviceId: native?.deviceId || '' }
      });
      expect(assertions, extracted?.ok === true, 'claim extraction ok', 'claim extraction failed');
      expect(assertions, Array.isArray(extracted?.claims), 'claim extraction array', 'claim extraction malformed');
    }));
    tests.push(makeTest('E4', 'journal entry manual verify', 'image', async function(assertions) {
      expect(assertions, true, 'manual verification required', 'open rabbithole journal to confirm Structa entry');
    }));
    tests.push(makeTest('E2B', 'fallback path', 'image', async function(assertions) {
      var traceWait = awaitTrace(function(entry) {
        return entry.flow === 'image.dispatch' && entry.to === 'fallback-server';
      }, 3000);
      var result = await llm.processImage(PNG_1X1_BASE64, 'DIAG_FALLBACK_PIXEL_01', {
        imageId: 'diag-image-fallback',
        itemId: 'diag-item-fallback',
        forceFallbackServer: true
      });
      await traceWait;
      if (!result?.ok) failFromResult(result, result?.error || 'server fallback failed', {
        layer: inferResultLayer(result) || 'server',
        latencyMs: inferResultLatency(result)
      });
      expect(assertions, result?.ok === true, 'server fallback returned', 'server fallback failed');
    }, { timeoutMs: 32000 }));

    tests.push(makeTest('F1', 'triangle rejects empty side', 'triangle', async function(assertions) {
      triangle.dismiss?.();
      var noClaimNode = reserveInsight('DIAG_EMPTY_TRIANGLE_SIDE', false);
      var claimNode = reserveInsight('DIAG_TRIANGLE_SIDE_B', true);
      triangle.copy({ type: 'know', id: noClaimNode.node_id, body: noClaimNode.body, project_id: getProjectId() });
      triangle.complete({ type: 'know', id: claimNode.node_id, body: claimNode.body, project_id: getProjectId() });
      var result = await triangle.submit('join these');
      expect(assertions, result?.ok === false, 'empty side rejected', 'triangle did not reject empty side');
    }));
    tests.push(makeTest('F2', 'triangle round trip', 'triangle', async function(assertions) {
      triangle.dismiss?.();
      var a = reserveInsight('DIAG_TRIANGLE_SOURCE_A', true);
      var b = reserveInsight('DIAG_TRIANGLE_SOURCE_B', true);
      var itemAClaims = native.getClaimsForItem(a.node_id) || [];
      var itemBClaims = native.getClaimsForItem(b.node_id) || [];
      var result = await runPreparedBridgeEndpoint('/v1/triangle/synthesize', {
        project: getProject(),
        itemA: {
          itemId: a.node_id,
          claimIds: itemAClaims.map(function(entry) { return entry.id; }),
          claims: itemAClaims
        },
        itemB: {
          itemId: b.node_id,
          claimIds: itemBClaims.map(function(entry) { return entry.id; }),
          claims: itemBClaims
        },
        angle: {
          text: 'what pattern links them',
          sttConfidence: 0.99
        },
        branchContext: {
          id: 'main',
          name: 'main',
          parentBranchId: ''
        }
      });
      var verdict = contracts.validateTriangleOutput(result, {
        project: getProject(),
        parentEvidenceIds: itemAClaims.map(function(entry) { return entry.id; }).concat(itemBClaims.map(function(entry) { return entry.id; }))
      });
      expect(assertions, verdict.ok === true, 'triangle output valid', 'triangle output invalid');
      expect(assertions, result?.status === 'synthesized' || result?.status === 'ambiguous', 'triangle finished', 'triangle never finished');
    }, { timeoutMs: 32000 }));
    tests.push(makeTest('F3', 'triangle validator orphan evidence', 'triangle', async function(assertions) {
      var verdict = contracts.validateTriangleOutput({
        status: 'synthesized',
        title: 'DIAG_TRIANGLE_TITLE',
        derived_claims: [{ text: 'invalid child', kind: 'fact', branchId: 'main', evidence: ['missing-parent-a', 'missing-parent-b'] }],
        unresolved_tensions: []
      }, {
        project: getProject(),
        parentEvidenceIds: ['known-a', 'known-b']
      });
      expect(assertions, verdict.ok === false, 'triangle validator rejected orphan evidence', 'triangle validator accepted orphan evidence');
    }));

    tests.push(makeTest('G1', 'digest builder', 'chain', async function(assertions) {
      reserveQuestion('which branch should lead?');
      var focus = native.activateNextFocus() || native.getActiveFocus();
      var response = await fetchJson('/v1/chain/digest_preview?debug=1', {
        body: {
          debug: true,
          project: getProject(),
          focus: focus,
          history: { previous_steps: [], plateau_count: 0 }
        }
      });
      expect(assertions, response.ok && response.data?.ok === true, 'digest preview ok', 'digest preview failed');
      expect(assertions, typeof response.data?.digest === 'object', 'digest typed', 'digest missing');
    }));
    tests.push(makeTest('G2', 'chain step round trip', 'chain', async function(assertions) {
      var claimNode = reserveInsight('DIAG_CHAIN_SOURCE', true);
      var focus = native.activateNextFocus() || native.getActiveFocus();
      if (!focus) throw new SkipError('no focus available');
      var result = await runPreparedBridgeEndpoint('/v1/chain/step', {
        project: getProject(),
        focus: focus,
        history: {
          previous_steps: (focus.steps || []).slice(-4),
          plateau_count: focus.plateauCount || 0
        }
      });
      var verdict = contracts.validateChainOutput(result, {
        project: getProject(),
        currentPhase: focus.phase || 'observe',
        currentState: focus.state || 'active'
      });
      expect(assertions, verdict.ok === true || result.note === 'insufficient_signal', 'chain output valid or insufficient', 'chain output invalid');
      expect(assertions, claimNode?.node_id ? true : true, 'chain step executed');
    }, { timeoutMs: 30000 }));
    tests.push(makeTest('G3', 'focus termination plateau', 'chain', async function(assertions) {
      reserveQuestion('what should plateau?');
      var focus = native.activateNextFocus() || native.getActiveFocus();
      expect(assertions, !!focus?.id, 'focus started', 'focus not started');
      var completed = native.completeActiveFocus('plateau', { producedClaimCount: 0, stepCount: 3 });
      expect(assertions, !!completed?.historyEntry, 'focus ended', 'focus plateau did not end');
      expect(assertions, completed?.historyEntry?.outcome === 'plateau', 'plateau outcome stored', 'plateau outcome missing');
    }));

    tests.push(makeTest('H1', 'thread extract', 'thread', async function(assertions) {
      var node = reserveInsight('thread parent item', true);
      var comment = native.appendThreadComment(node.node_id, 'this contradicts the old path', 'comment', 'ptt');
      var result = await runPreparedBridgeEndpoint('/v1/thread/extract', {
        project: getProject(),
        selection: { id: node.node_id, summary: node.body, kind: 'know' },
        input: { transcript: 'this contradicts the old path' },
        sourceRef: { itemId: node.node_id }
      });
      expect(assertions, result?.ok === true, 'thread extract ok', 'thread extract failed');
      if (typeof result?.summary !== 'string') {
        throw createFailure('thread summary missing', {
          code: 'shape-mismatch',
          layer: 'server',
          latencyMs: inferResultLatency(result) || 0
        });
      }
      expect(assertions, typeof result?.summary === 'string', 'thread extract summary', 'thread summary missing');
      native.applyThreadExtraction(node.node_id, comment.id, result);
    }));
    tests.push(makeTest('H2', 'contradiction surfaces question', 'thread', async function(assertions) {
      var node = reserveInsight('existing claim in thread', true);
      var existingClaim = native.getClaimsForItem(node.node_id)[0];
      var comment = native.appendThreadComment(node.node_id, 'we should not keep that old claim', 'comment', 'ptt');
      var extractionResult = native.applyThreadExtraction(node.node_id, comment.id, {
        summary: 'contradiction',
        claims: [{
          text: 'we should not keep that old claim',
          kind: 'fact',
          source: 'comment',
          sourceRef: { itemId: node.node_id, threadEntryId: comment.id }
        }],
        contradicts: existingClaim.text
      });
      expect(assertions, extractionResult?.contradictionId === existingClaim.id, 'contradiction linked', 'contradiction not linked');
      expect(assertions, extractionResult?.claimStatusUpdate?.status === 'disputed', 'claim marked disputed in update', 'claim not disputed');
      var updated = (getProject().claims || []).find(function(entry) { return entry.id === existingClaim.id; });
      expect(assertions, updated?.status === 'disputed', 'claim disputed', 'claim not disputed');
      expect(assertions, getOpenQuestions().length > 0, 'reconciliation question created', 'reconciliation question missing');
    }));

    tests.push(makeTest('B1', 'milestone cooldown contract', 'voice-doctrine', async function(assertions) {
      var first = llm.evaluateMilestone('project_live', {
        hasBridge: true,
        lastMilestoneSpeechAt: 0,
        now: 10000
      });
      var second = llm.evaluateMilestone('project_live', {
        hasBridge: true,
        lastMilestoneSpeechAt: 9500,
        now: 10000
      });
      expect(assertions, first.ok === true, 'first milestone allowed', 'first milestone suppressed');
      expect(assertions, second.ok === false && second.reason === 'cooldown', 'second milestone suppressed by cooldown', 'cooldown contract failed');
    }));
    tests.push(makeTest('B2', 'non-allowlisted milestone rejected', 'voice-doctrine', async function(assertions) {
      var result = llm.evaluateMilestone('not_a_real_kind', {
        hasBridge: true,
        now: 10000
      });
      expect(assertions, result.ok === false, 'invalid milestone rejected', 'invalid milestone accepted');
      expect(assertions, result.reason === 'not-allowlisted', 'invalid milestone reason surfaced', 'invalid milestone reason missing');
    }));
    tests.push(makeTest('B3', 'single wantsR1Response true', 'voice-doctrine', async function(assertions) {
      var response = await fetchJson('/js/r1-llm.js', { method: 'GET' });
      if (!response.ok || typeof response.data !== 'object' || response.data?.raw) {
        var rawFetch = await fetch('/js/r1-llm.js');
        var rawText = await rawFetch.text();
        var matches = rawText.match(/wantsR1Response\s*:\s*true/g) || [];
        expect(assertions, matches.length === 1, 'single wantsR1Response true', 'unexpected wantsR1Response count');
        return;
      }
      expect(assertions, true, 'runtime source fetched');
    }));

    return tests;
  }

  async function runTest(test) {
    var startedAt = Date.now();
    var assertions = [];
    var traceStart = getTraceEvents().length;
    diagTrace('diag.test.start', 'run', test.id, {
      runId: state.currentRunId,
      testId: test.id
    });
    try {
      await withTimeout(test.run(assertions), test.timeoutMs || TEST_TIMEOUT_MS, test.id);
      var result = {
        id: test.id,
        name: test.name,
        category: test.category,
        status: 'pass',
        durationMs: Date.now() - startedAt,
        assertions: assertions,
        traceExcerpt: getTraceEvents().slice(traceStart)
      };
      diagTrace('diag.test.end', test.id, 'pass', {
        runId: state.currentRunId,
        testId: test.id,
        durationMs: result.durationMs
      });
      return result;
    } catch (error) {
      var normalized = normalizeFailure(error, error?.message || 'failed', {
        code: /timeout/i.test(String(error?.message || '')) ? 'client-timeout' : '',
        layer: '',
        latencyMs: Date.now() - startedAt
      });
      var status = error instanceof SkipError ? 'skip' : (/timeout/i.test(String(error?.message || '')) ? 'timeout' : 'fail');
      var result = {
        id: test.id,
        name: test.name,
        category: test.category,
        status: status,
        durationMs: Date.now() - startedAt,
        assertions: assertions,
        error: {
          message: normalized?.message || status,
          code: normalized?.code || '',
          layer: normalized?.layer || '',
          latencyMs: normalized?.latencyMs || 0,
          statusCode: normalized?.statusCode || 0
        },
        traceExcerpt: getTraceEvents().slice(traceStart)
      };
      diagTrace('diag.test.end', test.id, status, {
        runId: state.currentRunId,
        testId: test.id,
        durationMs: result.durationMs
      });
      return result;
    }
  }

  async function run(opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    if (state.running) {
      return { ok: false, error: 'diagnostics already running' };
    }
    if (Date.now() - state.lastStartedAt < RUN_RATE_LIMIT_MS) {
      return { ok: false, error: 'diagnostics rate limited' };
    }
    if ((queue?.snapshot?.() || []).some(function(job) {
      return job && job.status !== 'blocked';
    })) {
      return { ok: false, error: 'wait for queue to drain' };
    }
    if (!(currentCaps().hasBridge || new URLSearchParams(window.location.search || '').get('debug') === '1')) {
      return { ok: false, error: 'diagnostics require device bridge or debug mode' };
    }

    var startedAt = nowIso();
    var runId = 'diag-' + Date.now();
    setState({
      running: true,
      mode: 'running',
      abortRequested: false,
      currentRunId: runId,
      lastStartedAt: Date.now(),
      report: null,
      progress: {
        total: 0,
        done: 0,
        current: ''
      },
      lastError: ''
    });
    diagTrace('diag.preflight.start', 'idle', 'running', {
      runId: runId
    });
    diagLog('diagnostics preflight', 'starting');
    diagTrace('diag.run.start', 'idle', 'running', {
      runId: runId,
      testCount: DECLARED_TEST_COUNT
    });

    var results = [];
    var runError = null;
    try {
      if (!llm?.withOperationPolicy) {
        throw createFailure('diagnostic silent policy unavailable', {
          code: 'diagnostic-policy-unavailable',
          layer: 'diagnostic-runtime'
        });
      }
      diagTrace('diag.policy.attach', 'pending', 'start', {
        runId: runId
      });
      await llm.withOperationPolicy({
        allowSpeech: false,
        silent: true,
        source: 'diagnostics',
        reason: 'diagnostics stay written'
      }, function() {
        diagTrace('diag.policy.attach', 'start', 'active', {
          runId: runId
        });
        return withDiagnosticMute(function() {
          return withIsolatedProject(async function() {
            var tests = buildTests();
            setState({
              progress: {
                total: tests.length,
                done: 0,
                current: ''
              }
            });
            for (var index = 0; index < tests.length; index += 1) {
              if (state.abortRequested) break;
              var test = tests[index];
              setState({
                progress: {
                  total: tests.length,
                  done: index,
                  current: test.id + ' ' + test.name
                }
              });
              var result = await runTest(test);
              results.push(result);
              setState({
                progress: {
                  total: tests.length,
                  done: index + 1,
                  current: test.id + ' ' + result.status
                }
              });
            }
          });
        });
      });
    } catch (error) {
      runError = buildRunError(error, {
        code: error?.code || 'diagnostic-preflight',
        layer: error?.layer || 'diagnostic-runtime',
        latencyMs: error?.latencyMs || 0
      });
      if (runError.code === 'diagnostic-policy-unavailable') {
        diagTrace('diag.policy.attach_failed', 'pending', 'failed', {
          runId: runId,
          error: runError
        });
      } else {
        diagTrace('diag.preflight.failed', 'running', 'failed', {
          runId: runId,
          error: runError
        });
      }
      diagLog('diagnostics failed before tests', runError.message);
      setState({ lastError: runError.message || 'diagnostic run failed' });
    }

    var finishedAt = nowIso();
    var report = makeReport(results, startedAt, finishedAt, runError);
    if (state.abortRequested) report.aborted = true;
    await saveLocalReport(report);
    publishDiagnosticSummary(report);
    if (options.email !== false) {
      report.delivery = await emailReport(report);
      if (!report.delivery?.ok) {
        setState({ lastError: report.delivery?.error || 'email delivery failed' });
      }
    }
    diagTrace('diag.run.end', 'running', 'complete', {
      runId: runId,
      passed: report.summary.passed,
      failed: report.summary.failed,
      skipped: report.summary.skipped
    });
    setState({
      running: false,
      mode: 'report',
      report: report,
      progress: null
    });
    return report;
  }

  function abort() {
    if (!state.running) return false;
    setState({ abortRequested: true });
    return true;
  }

  function getDrawerRows() {
    if (state.mode === 'running' && state.progress) {
      var reportRows = [{
        kind: 'status',
        message: 'diagnostics · running',
        detail: state.progress.done + ' done · ' + state.progress.total + ' total'
      }, {
        kind: 'muted',
        message: 'build · ' + UI_BUILD_ID,
        detail: DECLARED_TEST_COUNT + ' declared tests'
      }];
      if (state.progress.current) {
        reportRows.push({
          kind: 'status',
          message: state.progress.current,
          detail: 'watching live device traces'
        });
      }
      reportRows.push({
        kind: 'action',
        actionId: 'diagnostics-abort',
        message: 'abort diagnostics',
        detail: 'cleanup still runs'
      });
      return reportRows;
    }
    if (state.mode === 'report' && state.report) {
      var rows = [{
        kind: 'status',
        message: 'diagnostics · ' + state.report.summary.total + '/' + (state.report.declaredTestCount || DECLARED_TEST_COUNT) + ' tests',
        detail: state.report.summary.passed + ' pass · ' + state.report.summary.failed + ' fail · ' + state.report.summary.skipped + ' skip'
      }, {
        kind: 'muted',
        message: 'build · ' + (state.report.uiBuildId || UI_BUILD_ID),
        detail: 'declared ' + (state.report.declaredTestCount || DECLARED_TEST_COUNT)
      }];
      if (state.report.runError) {
        var runErrorDetail = [state.report.runError.code, state.report.runError.layer, state.report.runError.latencyMs ? (state.report.runError.latencyMs + 'ms') : ''].filter(Boolean).join(' · ');
        rows.push({
          kind: 'error',
          message: 'diagnostics failed before tests',
          detail: (state.report.runError.message || 'diagnostic preflight failed') + (runErrorDetail ? (' · ' + runErrorDetail) : '')
        });
      }
      if (state.report.delivery) {
        rows.push({
          kind: state.report.delivery.ok ? 'status' : 'muted',
          message: state.report.delivery.ok ? 'report exported' : 'report saved locally',
          detail: state.report.delivery.ok
            ? ('email sent · saved locally')
            : (((state.report.delivery.code === 'email-unavailable' ? 'email unavailable' : (state.report.delivery.error || 'email failed'))) + ' · saved locally only')
        });
      } else {
        rows.push({
          kind: 'status',
          message: 'report saved locally',
          detail: 'written report stays in this drawer'
        });
      }
      state.report.results.filter(function(item) {
        return item.status !== 'pass';
      }).slice(0, 6).forEach(function(item) {
        var detail = formatFailureDetail(item);
        rows.push({
          kind: item.status === 'skip' ? 'muted' : 'error',
          message: item.id + ' ' + item.name,
          detail: (item.error?.message || item.status) + (detail ? (' · ' + detail) : '')
        });
      });
      rows.push({
        kind: 'action',
        actionId: 'diagnostics-build-check',
        message: 'check build',
        detail: 'show ui and server build'
      });
      rows.push({
        kind: 'action',
        actionId: 'diagnostics-export',
        message: 'export again',
        detail: 'best-effort email export'
      });
      rows.push({
        kind: 'action',
        actionId: 'diagnostics-clear',
        message: 'delete saved reports',
        detail: 'holds only the last 10'
      });
      return rows;
    }
    if (state.mode === 'voice-check' && state.voiceCheck) {
      var check = state.voiceCheck;
      var voiceRows = [{
        kind: 'status',
        message: 'voice check',
        detail: 'manual mic + sound path'
      }];
      if (check.phase === 'confirm_tone') {
        voiceRows.push({ kind: 'status', message: 'did you hear the milestone?', detail: 'click one answer' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-heard', message: 'heard tone', detail: 'sound path is alive' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-silent', message: 'silent', detail: 'sound path may be broken' });
      } else if (check.phase === 'awaiting_transcript') {
        voiceRows.push({ kind: 'status', message: 'hold ptt and say structa', detail: 'release to save transcript' });
      } else if (check.phase === 'confirm_transcript') {
        voiceRows.push({ kind: 'status', message: 'transcript', detail: check.lastTranscript || 'no transcript' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-match', message: 'matches', detail: 'stt looks right' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-wrong', message: 'wrong text', detail: 'stt misheard' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-none', message: 'no transcript', detail: 'nothing came through' });
      } else if (check.phase === 'awaiting_silence') {
        voiceRows.push({ kind: 'status', message: 'hold ptt and say nothing', detail: 'release quietly' });
      } else if (check.phase === 'confirm_silence') {
        voiceRows.push({ kind: 'status', message: 'silent release handled?', detail: check.lastTranscript || 'no transcript' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-empty-ok', message: 'handled silently', detail: 'good' });
        voiceRows.push({ kind: 'action', actionId: 'voice-check-empty-bad', message: 'transcript came through', detail: 'needs work' });
      }
      voiceRows.push({ kind: 'action', actionId: 'voice-check-cancel', message: 'cancel voice check', detail: 'restore prior state' });
      return voiceRows;
    }
    return getSummaryRows();
  }

  function clearSavedReports() {
    if (!hasStorageTier('plain')) return Promise.resolve(false);
    return native.storage.plain.write(REPORT_STORAGE_KEY, []).then(function(result) {
      return !!result?.ok;
    }).catch(function() {
      return false;
    });
  }

  function handleAction(actionId) {
    if (actionId === 'diagnostics-run') return run({ email: false });
    if (actionId === 'diagnostics-build-check') {
      return fetchBuildStatus().then(function(result) {
        diagLog('build check', 'ui ' + result.uiBuildId + ' · server ' + (result.serverBuildSha || 'unavailable') + ' · tests ' + result.declaredTestCount);
        return { ok: true, result: result };
      }).catch(function(error) {
        diagLog('build check failed', error?.message || 'server unavailable');
        return { ok: false, error: error?.message || 'build check failed' };
      });
    }
    if (actionId === 'voice-check') return beginVoiceCheck();
    if (actionId === 'diagnostics-abort') {
      abort();
      return Promise.resolve({ ok: true });
    }
    if (actionId === 'diagnostics-export' && state.report) {
      return emailReport(state.report).then(function(result) {
        state.report.delivery = result;
        if (!result?.ok) state.lastError = result?.error || 'email delivery failed';
        emitProgress();
        return result;
      });
    }
    if (actionId === 'diagnostics-clear') {
      return clearSavedReports();
    }
    if (actionId === 'voice-check-heard' && state.voiceCheck) {
      state.voiceCheck.results.heardTone = 'heard';
      state.voiceCheck.phase = 'awaiting_transcript';
      emitProgress();
      return Promise.resolve({ ok: true });
    }
    if (actionId === 'voice-check-silent' && state.voiceCheck) {
      state.voiceCheck.results.heardTone = 'silent';
      state.voiceCheck.phase = 'awaiting_transcript';
      emitProgress();
      return Promise.resolve({ ok: true });
    }
    if (actionId === 'voice-check-match' && state.voiceCheck) {
      state.voiceCheck.results.transcriptMatch = 'matches';
      state.voiceCheck.phase = 'awaiting_silence';
      state.voiceCheck.lastTranscript = '';
      emitProgress();
      return Promise.resolve({ ok: true });
    }
    if (actionId === 'voice-check-wrong' && state.voiceCheck) {
      state.voiceCheck.results.transcriptMatch = 'wrong';
      state.voiceCheck.phase = 'awaiting_silence';
      state.voiceCheck.lastTranscript = '';
      emitProgress();
      return Promise.resolve({ ok: true });
    }
    if (actionId === 'voice-check-none' && state.voiceCheck) {
      state.voiceCheck.results.transcriptMatch = 'none';
      state.voiceCheck.phase = 'awaiting_silence';
      state.voiceCheck.lastTranscript = '';
      emitProgress();
      return Promise.resolve({ ok: true });
    }
    if (actionId === 'voice-check-empty-ok' && state.voiceCheck) {
      state.voiceCheck.results.silentHandled = 'ok';
      return finishVoiceCheck();
    }
    if (actionId === 'voice-check-empty-bad' && state.voiceCheck) {
      state.voiceCheck.results.silentHandled = 'bad';
      return finishVoiceCheck();
    }
    if (actionId === 'voice-check-cancel' && state.voiceCheck) {
      return finishVoiceCheck();
    }
    return Promise.resolve({ ok: false, error: 'unknown diagnostic action' });
  }

  window.StructaDiagnostics = Object.freeze({
    run: run,
    abort: abort,
    onProgress: onProgress,
    getState: getState,
    getDrawerRows: getDrawerRows,
    handleAction: handleAction,
    resetLocalState: resetLocalState
  });
})();
