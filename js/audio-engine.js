/**
 * audio-engine.js — Web Audio heartbeat + interaction sounds for Structa.
 *
 * Heartbeat: phase-specific low-frequency pulse every chain beat.
 * Interaction: capture click, voice start, approval chime, decision chord.
 * Mutes automatically during active voice/camera capture.
 */
(() => {
  'use strict';

  let ctx = null;
  let muted = false;
  let enabled = true;
  let initialized = false;

  const HEARTBEAT = {
    observe:  { freq: 60,  dur: 80,  gain: 0.08 },
    clarify:  { freq: 80,  dur: 80,  gain: 0.08 },
    research: { freq: 80,  dur: 80,  gain: 0.08 },
    evaluate: { freq: 120, dur: 80,  gain: 0.10 },
    decision: { freq: 200, dur: 120, gain: 0.12, freq2: 300 },
    cooldown: { freq: 40,  dur: 100, gain: 0.06 }
  };

  const SOUNDS = {
    capture:   { freq: 800,  dur: 30,  gain: 0.12 },
    voice:     { freq: 400,  dur: 100, gain: 0.08, sweep: 600 },
    approve:   { notes: [523, 659, 784], dur: 100, gain: 0.12 },
    decision:  { notes: [523, 659], dur: 150, gain: 0.15 },
    bpmUp:     { freq: 400,  dur: 60,  gain: 0.08, sweep: 600 },
    bpmDown:   { freq: 600,  dur: 60,  gain: 0.08, sweep: 400 }
  };

  function init() {
    if (initialized) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      initialized = true;
    } catch (e) { /* no audio support */ }
  }

  function tone(freq, duration, gainVal, startTime) {
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

  function heartbeat(phase) {
    if (!ctx || muted || !enabled) return;
    var cfg = HEARTBEAT[phase];
    if (!cfg) return;
    tone(cfg.freq, cfg.dur, cfg.gain);
    if (cfg.freq2) {
      tone(cfg.freq2, cfg.dur, cfg.gain * 0.7, ctx.currentTime + 0.01);
    }
  }

  function play(soundName) {
    if (!ctx || muted || !enabled) return;
    init();
    var cfg = SOUNDS[soundName];
    if (!cfg) return;

    if (cfg.notes) {
      // Arpeggio
      cfg.notes.forEach(function(freq, i) {
        tone(freq, cfg.dur, cfg.gain, ctx.currentTime + i * (cfg.dur / 1000));
      });
    } else if (cfg.sweep) {
      sweep(cfg.freq, cfg.sweep, cfg.dur, cfg.gain);
    } else {
      tone(cfg.freq, cfg.dur, cfg.gain);
    }
  }

  window.StructaAudio = Object.freeze({
    init: init,
    heartbeat: heartbeat,
    play: play,
    mute: function() { muted = true; },
    unmute: function() { muted = false; },
    setEnabled: function(val) { enabled = !!val; },
    get muted() { return muted; },
    get enabled() { return enabled; },
    get initialized() { return initialized; }
  });
})();
