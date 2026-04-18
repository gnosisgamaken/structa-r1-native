/**
 * audio-engine.js -- Web Audio feedback + heartbeat sounds for Structa.
 *
 * Slot-driven so uploaded sound assets can replace procedural cues later
 * without touching interaction code. For now every slot uses a procedural
 * fallback optimized for low-latency UI feedback on R1.
 */
(() => {
  'use strict';

  let ctx = null;
  let muted = false;
  let enabled = true;
  let initialized = false;
  const feedbackLastFiredAt = Object.create(null);

  const SOUND_SLOTS = Object.freeze({
    'nav-scroll':         { source: 'procedural', mode: 'tone',  asset: '', freq: 720, dur: 18,  gain: 0.035 },
    'nav-touch':          { source: 'procedural', mode: 'tone',  asset: '', freq: 640, dur: 16,  gain: 0.040 },
    'capture':            { source: 'procedural', mode: 'tone',  asset: '', freq: 880, dur: 40,  gain: 0.10 },
    'resolve':            { source: 'procedural', mode: 'tone',  asset: '', freq: 660, dur: 30,  gain: 0.09 },
    'blocked':            { source: 'procedural', mode: 'tone',  asset: '', freq: 220, dur: 80,  gain: 0.10 },
    'voice-open':         { source: 'procedural', mode: 'sweep', asset: '', freq: 400, sweep: 600, dur: 100, gain: 0.08 },
    'approve':            { source: 'procedural', mode: 'notes', asset: '', notes: [523, 659, 784], dur: 100, gain: 0.12 },
    'decision':           { source: 'procedural', mode: 'notes', asset: '', notes: [523, 659], dur: 150, gain: 0.15 },
    'debug-bpm-up':       { source: 'procedural', mode: 'sweep', asset: '', freq: 400, sweep: 600, dur: 60, gain: 0.08 },
    'debug-bpm-down':     { source: 'procedural', mode: 'sweep', asset: '', freq: 600, sweep: 400, dur: 60, gain: 0.08 },
    'heartbeat-observe':  { source: 'procedural', mode: 'tone',      asset: '', freq: 60,  dur: 80,  gain: 0.08 },
    'heartbeat-clarify':  { source: 'procedural', mode: 'tone',      asset: '', freq: 80,  dur: 80,  gain: 0.08 },
    'heartbeat-research': { source: 'procedural', mode: 'tone',      asset: '', freq: 80,  dur: 80,  gain: 0.08 },
    'heartbeat-evaluate': { source: 'procedural', mode: 'tone',      asset: '', freq: 120, dur: 80,  gain: 0.10 },
    'heartbeat-decision': { source: 'procedural', mode: 'tone-pair', asset: '', freq: 200, freq2: 300, dur: 120, gain: 0.12 },
    'heartbeat-cooldown': { source: 'procedural', mode: 'tone',      asset: '', freq: 40,  dur: 100, gain: 0.06 }
  });

  const PLAY_ALIASES = Object.freeze({
    voice: 'voice-open',
    approve: 'approve',
    decision: 'decision',
    bpmUp: 'debug-bpm-up',
    bpmDown: 'debug-bpm-down'
  });

  const CUE_ALIASES = Object.freeze({
    capture: 'capture',
    resolve: 'resolve',
    blocker: 'blocked'
  });

  const HEARTBEAT_ALIASES = Object.freeze({
    observe: 'heartbeat-observe',
    clarify: 'heartbeat-clarify',
    research: 'heartbeat-research',
    evaluate: 'heartbeat-evaluate',
    decision: 'heartbeat-decision',
    cooldown: 'heartbeat-cooldown'
  });

  const FEEDBACK_ALIASES = Object.freeze({
    'scroll-step': 'nav-scroll',
    'touch-commit': 'nav-touch',
    blocked: 'blocked',
    resolve: 'resolve',
    capture: 'capture',
    'voice-open': 'voice-open'
  });

  const FEEDBACK_SUPPRESSION_MS = Object.freeze({
    'scroll-step': 42,
    'touch-commit': 52,
    blocked: 90,
    resolve: 90,
    capture: 90,
    'voice-open': 140
  });

  function init() {
    if (initialized) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      initialized = true;
    } catch (_) {}
  }

  function tone(freq, duration, gainVal, startTime) {
    init();
    if (!ctx || muted || !enabled) return;
    var now = startTime || ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration / 1000);
  }

  function sweep(startFreq, endFreq, duration, gainVal) {
    init();
    if (!ctx || muted || !enabled) return;
    var now = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.linearRampToValueAtTime(endFreq, now + duration / 1000);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration / 1000 + 0.01);
  }

  function playSlot(slotName) {
    init();
    if (!ctx || muted || !enabled) return false;
    var cfg = SOUND_SLOTS[slotName];
    if (!cfg) return false;

    switch (cfg.mode) {
      case 'notes':
        cfg.notes.forEach(function(freq, index) {
          tone(freq, cfg.dur, cfg.gain, ctx.currentTime + index * (cfg.dur / 1000));
        });
        return true;
      case 'sweep':
        sweep(cfg.freq, cfg.sweep, cfg.dur, cfg.gain);
        return true;
      case 'tone-pair':
        tone(cfg.freq, cfg.dur, cfg.gain);
        tone(cfg.freq2, cfg.dur, cfg.gain * 0.7, ctx.currentTime + 0.01);
        return true;
      case 'tone':
      default:
        tone(cfg.freq, cfg.dur, cfg.gain);
        return true;
    }
  }

  function heartbeat(phase) {
    return playSlot(HEARTBEAT_ALIASES[phase] || 'heartbeat-observe');
  }

  function play(soundName) {
    return playSlot(PLAY_ALIASES[soundName] || soundName);
  }

  function playTone(freq, duration, gainVal) {
    tone(freq, duration, typeof gainVal === 'number' ? gainVal : 0.10);
  }

  function cue(name) {
    return playSlot(CUE_ALIASES[name] || name);
  }

  function fireFeedback(kind) {
    var slot = FEEDBACK_ALIASES[kind];
    if (!slot) return false;
    var now = (window.performance && typeof window.performance.now === 'function')
      ? window.performance.now()
      : Date.now();
    var minGap = FEEDBACK_SUPPRESSION_MS[kind] || 60;
    if (feedbackLastFiredAt[kind] && now - feedbackLastFiredAt[kind] < minGap) {
      return false;
    }
    feedbackLastFiredAt[kind] = now;
    return playSlot(slot);
  }

  window.StructaAudio = Object.freeze({
    init: init,
    heartbeat: heartbeat,
    play: play,
    playSlot: playSlot,
    playTone: playTone,
    cue: cue,
    slots: SOUND_SLOTS,
    mute: function() { muted = true; },
    unmute: function() { muted = false; },
    setEnabled: function(val) { enabled = !!val; },
    get muted() { return muted; },
    get enabled() { return enabled; },
    get initialized() { return initialized; }
  });

  window.StructaFeedback = Object.freeze({
    fire: fireFeedback,
    slots: FEEDBACK_ALIASES
  });
})();
