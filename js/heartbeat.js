/**
 * heartbeat.js — Configurable heartbeat for Structa on R1.
 *
 * Runs at BPH (beats per hour). Each beat quietly checks project state and
 * only surfaces meaningful deltas.
 *
 * BPH settings:
 *   1 BPH   = once per hour (background monitoring)
 *   60 BPH  = once per minute (active project management)
 *   240 BPH = every 15 seconds (intensive)
 *   0 BPH   = heartbeat off
 *
 * Rate limiting: LLM calls every 10th beat minimum (respects r1-llm.js MIN_GAP_MS).
 */
(() => {
  const native = window.StructaNative;

  let bpm = 0;           // beats per hour (0 = off)
  let interval = null;
  let beatCount = 0;
  let llmBeatInterval = 10;  // Only call LLM every Nth beat
  let idleBeats = 0;
  const MAX_IDLE_BEATS = 240; // 4 min idle → pause (at max BPH)

  function start(bph) {
    stop();
    bpm = Math.max(1, Math.min(240, bph));
    const ms = Math.round(3600000 / bpm);
    interval = setInterval(beat, ms);
    idleBeats = 0;
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    bpm = 0;
    beatCount = 0;
    idleBeats = 0;
  }

  function beat() {
    beatCount++;
    idleBeats++;

    // Auto-pause after extended idle
    if (idleBeats >= MAX_IDLE_BEATS) {
      stop();
      return;
    }

    const project = native?.getProjectMemory?.();
    if (!project) return;

    // Check for stale items (older than 1 hour)
    const now = Date.now();
    const staleTasks = (project.backlog || []).filter(t => {
      const age = now - new Date(t.created_at || 0).getTime();
      return age > 3600000;
    });

    // Check for unanswered questions
    const questions = project.open_questions || [];

    // Rate-limited LLM query for next-action suggestion
    if (beatCount % llmBeatInterval === 0 && window.StructaLLM) {
      const context = [
        `Project: ${project.name || 'untitled'}`,
        `Backlog: ${(project.backlog || []).length} items`,
        `Questions: ${questions.length}`,
        `Captures: ${(project.captures || []).length}`,
        `Insights: ${(project.insights || []).length}`
      ].join('. ');

      window.StructaLLM.query(`In 5 words, what should the user focus on next? ${context}`)
        .then(result => {
          if (result && result.clean) {
            const suggestion = String(result.clean || '').trim();
            const previous = native?.getUIState?.()?.last_event_summary || '';
            if (suggestion && suggestion.toLowerCase() !== String(previous).toLowerCase()) {
              native?.appendLogEntry?.({ kind: 'heartbeat', message: `suggestion: ${suggestion.slice(0, 60)}` });
            }
            idleBeats = 0; // Reset idle on successful LLM response
          }
        })
        .catch(() => {});
    }
  }

  // Reset idle counter on any user activity
  function resetIdle() {
    idleBeats = 0;
    // Auto-restart if paused and BPM was set
    if (!interval && bpm > 0) {
      start(bpm);
    }
  }

  window.addEventListener('structa-native-event', event => {
    const type = event?.detail?.event_type;
    if (type && ['ptt_started', 'ptt_stopped', 'message_sent', 'capture_stored'].includes(type)) {
      resetIdle();
    }
  });

  window.StructaHeartbeat = Object.freeze({
    start,
    stop,
    get bpm() { return bpm; },
    get beatCount() { return beatCount; },
    get idleBeats() { return idleBeats; },
    set llmBeatInterval(val) { llmBeatInterval = Math.max(1, val); },
    get llmBeatInterval() { return llmBeatInterval; }
  });
})();
