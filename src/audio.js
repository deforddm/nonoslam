/* NONOSLAM — tiny synthesized sound effects + haptics (no audio files needed). */
var NonoAudio = (function () {
  'use strict';
  var ctx = null, enabled = true, hapticsOn = true, master = null;

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  // one short tone: freq (Hz), duration (s), type, optional glide-to frequency
  function tone(freq, dur, type, glideTo, when, vol) {
    var c = ensure(); if (!c) return;
    var t = c.currentTime + (when || 0);
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.6, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  var sounds = {
    fill:    function () { tone(880, 0.05, 'triangle', 660); },
    x:       function () { tone(440, 0.05, 'square', 330, 0, 0.25); },
    clear:   function () { tone(520, 0.04, 'sine', 400, 0, 0.3); },
    undo:    function () { tone(600, 0.06, 'sine', 900, 0, 0.3); },
    error:   function () { tone(160, 0.18, 'sawtooth', 90, 0, 0.5); },
    hint:    function () { tone(700, 0.08, 'sine'); tone(1050, 0.1, 'sine', null, 0.09); },
    line:    function () { tone(1200, 0.05, 'sine', null, 0, 0.25); },
    solve:   function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.16, 'triangle', null, i * 0.09, 0.5); }); },
    slamGo:  function () { tone(330, 0.1, 'square', null, 0, 0.35); tone(660, 0.18, 'square', null, 0.1, 0.35); },
    tick:    function () { tone(1500, 0.03, 'sine', null, 0, 0.3); },
    over:    function () { [440, 370, 311, 220].forEach(function (f, i) { tone(f, 0.22, 'sawtooth', null, i * 0.18, 0.4); }); },
    bonus:   function () { tone(990, 0.06, 'triangle', 1480); }
  };

  function play(name) {
    if (!enabled || !sounds[name]) return;
    try { sounds[name](); } catch (e) { /* audio is best-effort */ }
  }

  function buzz(pattern) {
    if (!hapticsOn) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }

  return {
    play: play,
    buzz: buzz,
    unlock: ensure, // call from a user gesture so iOS lets audio through
    setEnabled: function (v) { enabled = !!v; },
    setHaptics: function (v) { hapticsOn = !!v; }
  };
})();
