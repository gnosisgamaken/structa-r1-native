(() => {
  'use strict';

  const STORAGE_KEY = 'structa.queue.v1';
  const VERSION = 1;
  const MAX_JOB_AGE_MS = 10 * 60 * 1000;
  const TIMEOUTS = {
    P0: 8000,
    P1: 12000,
    P2: 20000,
    P3: 30000
  };
  const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3'];

  let sequence = 0;
  let ready = false;
  let paused = false;
  let pending = [];
  let blocked = [];
  let inFlight = null;
  let activeTimer = null;
  const handlers = new Map();
  const listeners = new Map();

  function now() {
    return Date.now();
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function emit(name, detail) {
    const payload = clone(detail || {});
    const bucket = listeners.get(name) || [];
    bucket.forEach(function(handler) {
      try { handler(payload); } catch (_) {}
    });
    try {
      window.dispatchEvent(new CustomEvent('structa-queue-' + name, { detail: payload }));
    } catch (_) {}
  }

  function on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(handler);
    return function off() {
      const bucket = listeners.get(name) || [];
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    };
  }

  function priorityValue(priority) {
    const normalized = PRIORITY_ORDER.includes(priority) ? priority : 'P2';
    return PRIORITY_ORDER.indexOf(normalized);
  }

  function effectiveTimeout(job) {
    return Math.max(1000, Number(job.timeoutMs || TIMEOUTS[job.priority] || TIMEOUTS.P2));
  }

  function persist() {
    const snapshot = {
      version: VERSION,
      paused: paused,
      pending: pending.map(stripRuntimeFields),
      blocked: blocked.map(stripRuntimeFields),
      inFlight: inFlight ? stripRuntimeFields(inFlight) : null
    };
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (_) {}
    if (window.creationStorage?.plain?.setItem) {
      window.creationStorage.plain.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(function() {});
    }
  }

  function stripRuntimeFields(job) {
    return {
      id: job.id,
      kind: job.kind,
      priority: job.priority,
      payload: clone(job.payload),
      origin: clone(job.origin),
      status: job.status,
      enqueuedAt: job.enqueuedAt,
      startedAt: job.startedAt || 0,
      timeoutMs: job.timeoutMs || 0,
      error: job.error || ''
    };
  }

  function hydrateFrom(raw) {
    if (!raw) return false;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || parsed.version !== VERSION) return false;
      paused = !!parsed.paused;
      const cutoff = now() - MAX_JOB_AGE_MS;
      pending = (parsed.pending || []).filter(function(job) {
        return job && Number(job.enqueuedAt || 0) >= cutoff;
      }).map(function(job) {
        return {
          id: job.id,
          kind: job.kind,
          priority: PRIORITY_ORDER.includes(job.priority) ? job.priority : 'P2',
          payload: clone(job.payload),
          origin: clone(job.origin),
          status: 'pending',
          enqueuedAt: Number(job.enqueuedAt || now()),
          startedAt: 0,
          timeoutMs: Number(job.timeoutMs || 0),
          error: ''
        };
      });
      blocked = (parsed.blocked || []).filter(Boolean).map(function(job) {
        return {
          id: job.id,
          kind: job.kind,
          priority: PRIORITY_ORDER.includes(job.priority) ? job.priority : 'P2',
          payload: clone(job.payload),
          origin: clone(job.origin),
          status: 'blocked',
          enqueuedAt: Number(job.enqueuedAt || now()),
          startedAt: Number(job.startedAt || 0),
          timeoutMs: Number(job.timeoutMs || 0),
          error: job.error || 'blocked'
        };
      });
      if (parsed.inFlight) {
        blocked.push({
          id: parsed.inFlight.id,
          kind: parsed.inFlight.kind,
          priority: PRIORITY_ORDER.includes(parsed.inFlight.priority) ? parsed.inFlight.priority : 'P2',
          payload: clone(parsed.inFlight.payload),
          origin: clone(parsed.inFlight.origin),
          status: 'blocked',
          enqueuedAt: Number(parsed.inFlight.enqueuedAt || now()),
          startedAt: Number(parsed.inFlight.startedAt || 0),
          timeoutMs: Number(parsed.inFlight.timeoutMs || 0),
          error: 'stalled while app was closed'
        });
      }
      inFlight = null;
      return true;
    } catch (_) {
      return false;
    }
  }

  function load() {
    if (ready) return Promise.resolve(snapshot());
    let seeded = false;
    try {
      seeded = hydrateFrom(window.localStorage?.getItem(STORAGE_KEY));
    } catch (_) {}
    const finish = function() {
      ready = true;
      persist();
      maybeProcess();
      return snapshot();
    };
    if (window.creationStorage?.plain?.getItem) {
      return window.creationStorage.plain.getItem(STORAGE_KEY).then(function(raw) {
        if (!seeded) hydrateFrom(raw);
        return finish();
      }).catch(function() {
        return finish();
      });
    }
    return Promise.resolve(finish());
  }

  function selectNextJob() {
    if (!pending.length) return null;
    const sorted = pending.slice().sort(function(a, b) {
      const priorityDiff = priorityValue(a.priority) - priorityValue(b.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return a.enqueuedAt - b.enqueuedAt;
    });
    return sorted[0] || null;
  }

  function finalizeActive() {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    inFlight = null;
    persist();
  }

  function maybeProcess() {
    if (!ready || paused || inFlight) return;
    const next = selectNextJob();
    if (!next) return;
    const handler = handlers.get(next.kind);
    if (typeof handler !== 'function') return;
    pending = pending.filter(function(job) { return job.id !== next.id; });
    next.status = 'running';
    next.startedAt = now();
    inFlight = next;
    persist();
    emit('started', { job: stripRuntimeFields(next) });

    let settled = false;
    const timeoutMs = effectiveTimeout(next);
    activeTimer = setTimeout(function() {
      if (settled || !inFlight || inFlight.id !== next.id) return;
      settled = true;
      next.status = 'blocked';
      next.error = 'timed out';
      blocked.unshift(next);
      finalizeActive();
      emit('blocked', { job: stripRuntimeFields(next), reason: 'timeout' });
      maybeProcess();
    }, timeoutMs);

    Promise.resolve(handler(stripRuntimeFields(next), {
      progress: function(message) {
        if (typeof next.onProgress === 'function') {
          try { next.onProgress(message); } catch (_) {}
        }
        emit('progress', { job: stripRuntimeFields(next), message: String(message || '') });
      }
    })).then(function(result) {
      if (settled || !inFlight || inFlight.id !== next.id) return;
      settled = true;
      if (result && result.blocked) {
        next.status = 'blocked';
        next.error = String(result.message || result.error || 'blocked');
        blocked.unshift(next);
        finalizeActive();
        emit('blocked', {
          job: stripRuntimeFields(next),
          reason: 'handler',
          message: next.error
        });
        maybeProcess();
        return;
      }
      finalizeActive();
      if (typeof next.onResolve === 'function') {
        try { next.onResolve(result); } catch (_) {}
      }
      emit('resolved', { job: stripRuntimeFields(next), result: clone(result) });
      maybeProcess();
    }).catch(function(error) {
      if (settled || !inFlight || inFlight.id !== next.id) return;
      settled = true;
      finalizeActive();
      if (typeof next.onReject === 'function') {
        try { next.onReject(error); } catch (_) {}
      }
      emit('rejected', {
        job: stripRuntimeFields(next),
        error: String(error && error.message ? error.message : error || 'failed')
      });
      maybeProcess();
    });
  }

  function enqueue(input) {
    const job = {
      id: 'job-' + now() + '-' + (++sequence),
      kind: input.kind,
      priority: PRIORITY_ORDER.includes(input.priority) ? input.priority : 'P2',
      payload: clone(input.payload),
      origin: clone(input.origin),
      status: 'pending',
      enqueuedAt: now(),
      startedAt: 0,
      timeoutMs: Number(input.timeoutMs || 0),
      error: '',
      onResolve: typeof input.onResolve === 'function' ? input.onResolve : null,
      onReject: typeof input.onReject === 'function' ? input.onReject : null,
      onProgress: typeof input.onProgress === 'function' ? input.onProgress : null
    };
    pending.push(job);
    persist();
    emit('enqueued', { job: stripRuntimeFields(job) });
    maybeProcess();
    return job.id;
  }

  function retry(jobId) {
    const job = blocked.find(function(entry) { return entry.id === jobId; });
    if (!job) return false;
    blocked = blocked.filter(function(entry) { return entry.id !== jobId; });
    pending.push({
      ...job,
      status: 'pending',
      startedAt: 0,
      enqueuedAt: now(),
      error: ''
    });
    persist();
    emit('enqueued', { job: stripRuntimeFields(job) });
    maybeProcess();
    return true;
  }

  function cancel(jobId) {
    let changed = false;
    const beforePending = pending.length;
    pending = pending.filter(function(job) { return job.id !== jobId; });
    if (pending.length !== beforePending) changed = true;
    const beforeBlocked = blocked.length;
    blocked = blocked.filter(function(job) { return job.id !== jobId; });
    if (blocked.length !== beforeBlocked) changed = true;
    if (inFlight && inFlight.id === jobId) {
      inFlight.error = 'cancelled';
      changed = true;
    }
    if (changed) {
      persist();
      emit('blocked', { job: { id: jobId }, reason: 'cancelled' });
    }
    return changed;
  }

  function pause() {
    paused = true;
    persist();
  }

  function resume() {
    paused = false;
    persist();
    maybeProcess();
  }

  function isPaused() {
    return paused;
  }

  function snapshot() {
    const items = []
      .concat(pending.map(stripRuntimeFields))
      .concat(inFlight ? [stripRuntimeFields(inFlight)] : [])
      .concat(blocked.map(stripRuntimeFields));
    items.sort(function(a, b) {
      const aTime = a.startedAt || a.enqueuedAt || 0;
      const bTime = b.startedAt || b.enqueuedAt || 0;
      const priorityDiff = priorityValue(a.priority) - priorityValue(b.priority);
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      if (priorityDiff !== 0) return priorityDiff;
      return aTime - bTime;
    });
    return items.map(function(job) {
      return {
        id: job.id,
        kind: job.kind,
        priority: job.priority,
        status: job.status,
        origin: clone(job.origin),
        payload: clone(job.payload),
        startedAt: job.startedAt || 0,
        enqueuedAt: job.enqueuedAt || 0,
        timeoutMs: job.timeoutMs || 0,
        elapsedMs: Math.max(0, now() - (job.startedAt || job.enqueuedAt || now())),
        error: job.error || ''
      };
    });
  }

  function restore(items, options) {
    const opts = options || {};
    const list = Array.isArray(items) ? items : [];
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    inFlight = null;
    pending = [];
    blocked = [];
    list.forEach(function(job) {
      if (!job || !job.id) return;
      const restored = {
        id: job.id,
        kind: job.kind,
        priority: PRIORITY_ORDER.includes(job.priority) ? job.priority : 'P2',
        payload: clone(job.payload),
        origin: clone(job.origin),
        status: job.status === 'blocked' ? 'blocked' : (job.status === 'running' ? 'running' : 'pending'),
        enqueuedAt: Number(job.enqueuedAt || now()),
        startedAt: Number(job.startedAt || 0),
        timeoutMs: Number(job.timeoutMs || 0),
        error: job.error || ''
      };
      if (restored.status === 'blocked') {
        blocked.push(restored);
      } else if (restored.status === 'running' && !inFlight) {
        inFlight = restored;
      } else {
        restored.status = 'pending';
        pending.push(restored);
      }
    });
    paused = !!opts.paused;
    if (inFlight) {
      inFlight.status = 'blocked';
      inFlight.error = inFlight.error || 'restored as blocked';
      blocked.unshift(inFlight);
      inFlight = null;
    }
    persist();
    if (!paused) maybeProcess();
    return snapshot();
  }

  function countByPriority(maxPriority) {
    return snapshot().filter(function(job) {
      return job.status !== 'blocked' && priorityValue(job.priority) <= priorityValue(maxPriority);
    }).length;
  }

  function registerHandler(kind, handler) {
    handlers.set(kind, handler);
    maybeProcess();
  }

  window.StructaProcessingQueue = Object.freeze({
    load: load,
    enqueue: enqueue,
    retry: retry,
    cancel: cancel,
    pause: pause,
    resume: resume,
    isPaused: isPaused,
    snapshot: snapshot,
    restore: restore,
    on: on,
    registerHandler: registerHandler,
    countByPriority: countByPriority
  });

  load();
})();
