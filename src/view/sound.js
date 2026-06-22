/* ============================================================================
 * src/view/sound.js — procedural audio (SFX + background music), browser-only
 * ============================================================================
 * All sound is synthesized at runtime via the Web Audio API — no asset files,
 * so it works offline / over file:// and fits the project's all-procedural
 * ethos (same reason the visuals are baked from code, not shipped as PNGs).
 *
 * Architecture mirrors the renderers: this module lives in the VIEW layer and
 * *observes* sim state each frame (GameSound.observe(sim)), firing one-shot SFX
 * on state edges (a dish served, a customer rages out, a build, day start/end,
 * …) and varying the music's intensity by dayState. It NEVER touches the sim,
 * and it is NOT loaded by the headless test harness — so there's no test
 * impact. It also avoids Math.random entirely (uses a private LCG for noise),
 * so it can't perturb the date-seeded gameplay RNG.
 *
 * Autoplay: browsers suspend AudioContext until a user gesture. The game boots
 * from the Play click, which is where scene.js calls init()/resume() — so audio
 * unlocks on that gesture.
 * ========================================================================== */

const GameSound = (() => {
  let ctx = null, master = null, musicGain = null, sfxGain = null;
  let muted = false;
  let _musicTimer = null, _nextNoteTime = 0, _step = 0;
  let _intensity = 0;     // 0 = calm (between days / events), 1 = active (service)
  let _prev = null;       // last sim snapshot, for edge detection

  // Noise buffers (for build/break SFX) are generated ONCE per length from a
  // fixed seed and cached, so every play of a given effect is byte-identical
  // run to run — never random per-play. A private LCG fills them, so this also
  // never touches the date-seeded Math.random.
  const _noiseCache = new Map();
  function _noiseBuffer(n) {
    let buf = _noiseCache.get(n);
    if (buf) return buf;
    buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 0x9e3779b9 >>> 0;                       // fixed seed → identical every run
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = ((s / 4294967296) * 2 - 1) * (1 - i / n);   // decaying white noise
    }
    _noiseCache.set(n, buf);
    return buf;
  }

  function _supported() {
    return typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  }

  function init() {
    if (ctx || !_supported()) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master   = ctx.createGain(); master.gain.value = 0.9;   master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.gain.value = 0.09; musicGain.connect(master);
    sfxGain  = ctx.createGain(); sfxGain.gain.value = 0.5;   sfxGain.connect(master);
    try { muted = (window.localStorage && localStorage.getItem('chow-muted') === '1'); } catch (e) {}
    _applyMute();
  }

  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }
  function _now() { return ctx ? ctx.currentTime : 0; }

  function _applyMute() { if (master) master.gain.value = muted ? 0 : 0.9; }
  function isMuted() { return muted; }
  function setMuted(m) {
    muted = !!m; _applyMute();
    try { if (window.localStorage) localStorage.setItem('chow-muted', muted ? '1' : '0'); } catch (e) {}
  }
  function toggleMute() { setMuted(!muted); resume(); return muted; }

  /* ---- tiny synth primitives ---- */
  function _tone(freq, t0, dur, type, peak, dest) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest || sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function _arp(freqs, t0, step, type, peak) {
    for (let i = 0; i < freqs.length; i++) _tone(freqs[i], t0 + i * step, step * 1.7, type, peak || 0.4);
  }
  function _noiseBurst(t0, dur, peak) {
    if (!ctx) return;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const src = ctx.createBufferSource(); src.buffer = _noiseBuffer(n);  // cached, consistent
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(g); g.connect(sfxGain);
    src.start(t0); src.stop(t0 + dur + 0.03);
  }

  /* ---- one-shot SFX ---- */
  function sfx(name) {
    if (!ctx || muted) return;
    const t = _now() + 0.001;
    switch (name) {
      case 'serve':    _tone(659, t, 0.12, 'triangle', 0.5); _tone(988, t + 0.09, 0.18, 'triangle', 0.5); break; // happy up
      case 'angry':    _tone(330, t, 0.18, 'sawtooth', 0.4); _tone(247, t + 0.13, 0.24, 'sawtooth', 0.4); break; // sad down
      case 'build':    _noiseBurst(t, 0.10, 0.5); _tone(160, t, 0.14, 'square', 0.4); break;
      case 'break':    _noiseBurst(t, 0.28, 0.6); _tone(110, t, 0.22, 'sawtooth', 0.5); break;
      case 'repair':   _tone(523, t, 0.05, 'square', 0.3); _tone(698, t + 0.06, 0.05, 'square', 0.3); _tone(880, t + 0.12, 0.09, 'square', 0.3); break;
      case 'dayStart': _arp([523, 659, 784, 1047], t, 0.10, 'triangle', 0.45); break;
      case 'dayEnd':   _arp([523, 659, 784, 1047, 1319], t, 0.13, 'triangle', 0.5); break;       // fanfare
      case 'midday':   _tone(880, t, 0.10, 'square', 0.4); _tone(880, t + 0.20, 0.10, 'square', 0.4); break; // alert
      case 'gameover': _arp([523, 440, 349, 262], t, 0.24, 'sawtooth', 0.5); break;              // descending
      case 'proc':     _tone(1245, t, 0.04, 'square', 0.16); break;                              // subtle tick
    }
  }

  /* ---- procedural background music ----
   * A 32-step (4-bar, eighth-note) loop over the I–V–vi–IV progression (C–G–
   * Am–F) — pop music's catchiest chord cycle. Each bar layers: a root–fifth
   * bass bounce, a soft sustained chord pad, a syncopated melodic hook, and
   * (during service only) a kick/snare/hi-hat groove. Calm mode (between days /
   * events) drops the drums, thins the melody, and slows the tempo. Fully
   * deterministic — fixed patterns, drums reuse the cached noise buffers. */
  const C5 = 523.25, C4 = 261.63, C3 = 130.81;
  const _hz = (base, semi) => base * Math.pow(2, semi / 12);
  const PROG       = [0, 7, 9, 5];                    // C, G, Am, F (semitones from C)
  const PROG_MINOR = [false, false, true, false];    // Am is the minor one
  // 32-step hook (semitones from C5, null = rest). Rests on the off-beats give
  // it a bouncy, singable syncopation; the same rhythm repeats each bar so the
  // motif sticks while the pitches trace each chord.
  const MEL = [
    7, null, 7, 4,  5, 4, 2, null,   // bar 1 over C:  G . G E  F E D .
    2, null, 4, 2, -1, null, 2, null, // bar 2 over G:  D . E D  B . D .
    0, null, 4, 7,  9, 7, 4, null,   // bar 3 over Am: C . E G  A G E .
    5, null, 4, 2,  0, null, -1, null, // bar 4 over F: F . E D  C . B .
  ];

  function startMusic() {
    if (!ctx || _musicTimer) return;
    _nextNoteTime = _now() + 0.1;
    _step = 0;
    _musicTimer = setInterval(_scheduler, 25);        // lookahead scheduler
  }
  function stopMusic() { if (_musicTimer) { clearInterval(_musicTimer); _musicTimer = null; } }

  function _scheduler() {
    if (!ctx) return;
    const bpm = 88 + _intensity * 40;                 // calm 88 → active 128
    const stepDur = (60 / bpm) / 2;                   // eighth notes
    while (_nextNoteTime < _now() + 0.12) {
      _scheduleStep(_nextNoteTime);
      _nextNoteTime += stepDur;
      _step = (_step + 1) % 32;
    }
  }

  // --- drum voices (routed through musicGain so the mix/mute apply) ---
  function _kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.11);
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + 0.15);
  }
  function _drumNoise(t, dur, peak) {
    const src = ctx.createBufferSource();
    src.buffer = _noiseBuffer(Math.max(1, Math.floor(ctx.sampleRate * dur)));
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(g); g.connect(musicGain);
    src.start(t); src.stop(t + dur + 0.02);
  }
  function _snare(t) { _drumNoise(t, 0.13, 0.26); _tone(190, t, 0.08, 'triangle', 0.16, musicGain); }
  function _hat(t)   { _drumNoise(t, 0.025, 0.12); }

  function _chordPad(t, root, minor, dur, gain) {
    const third = minor ? 3 : 4;
    for (const iv of [0, third, 7]) _tone(_hz(C4, root + iv), t, dur, 'sine', gain, musicGain);
  }

  function _scheduleStep(t) {
    if (muted) return;
    const calm = _intensity === 0;
    const bar = (_step >> 3) & 3;                      // 0..3 — which chord
    const sib = _step & 7;                             // 0..7 — step within the bar
    const root = PROG[bar];

    // Bass: root–fifth bounce (boom-tick boom-tick).
    if (sib === 0 || sib === 4)      _tone(_hz(C3, root),     t, 0.26, 'triangle', 0.5,  musicGain);
    else if (sib === 2 || sib === 6) _tone(_hz(C3, root + 7), t, 0.18, 'triangle', 0.34, musicGain);

    // Soft sustained chord pad on the bar downbeat.
    if (sib === 0) _chordPad(t, root, PROG_MINOR[bar], calm ? 3.0 : 1.7, calm ? 0.09 : 0.06);

    // Melody hook — full when active; off-beats dropped + softer/sine when calm.
    if (!(calm && (sib % 2 === 1))) {
      const m = MEL[_step];
      if (m !== null && m !== undefined) {
        _tone(_hz(C5, m), t, calm ? 0.5 : 0.22, calm ? 'sine' : 'triangle', calm ? 0.20 : 0.30, musicGain);
      }
    }

    // Drum groove — service only (keeps the between-day mood mellow).
    if (!calm) {
      if (sib === 0 || sib === 4) _kick(t);            // beats 1 & 3
      if (sib === 2 || sib === 6) _snare(t);           // backbeat
      if (sib % 2 === 1)          _hat(t);             // off-beat hats
    }
  }

  function _setIntensityFor(dayState) {
    _intensity = (dayState === 'spawning' || dayState === 'draining') ? 1 : 0;
  }

  /* ---- per-frame observation: fire SFX on sim state edges ---- */
  function _snap(sim) {
    let lastPopupId = (_prev && _prev.lastPopupId) || 0;
    if (sim.popups) for (const p of sim.popups) if (p.id > lastPopupId) lastPopupId = p.id;
    return {
      served: sim.stats.served, angry: sim.stats.angry,
      buildings: sim.buildings.length, dayState: sim.dayState,
      gameOver: sim.gameOver, lastPopupId,
    };
  }

  function observe(sim) {
    if (!ctx || !sim) return;
    if (!_prev) { _prev = _snap(sim); _setIntensityFor(sim.dayState); return; }
    const p = _prev;
    if (sim.stats.served > p.served) sfx('serve');
    if (sim.stats.angry  > p.angry)  sfx('angry');
    if (sim.buildings.length > p.buildings) sfx('build');
    // New popups (by monotonically-increasing id) → break/repair/ability ticks.
    if (sim.popups) {
      for (const pop of sim.popups) {
        if (pop.id <= p.lastPopupId) continue;
        if (pop.icon === '💥') sfx('break');
        else if (pop.icon === '🔧') sfx('repair');
        else if (pop.icon === '💰') { /* covered by 'serve' */ }
        else sfx('proc');
      }
    }
    if (sim.dayState !== p.dayState) {
      if (sim.dayState === 'spawning') sfx('dayStart');
      else if (sim.dayState === 'dayEnd') sfx('dayEnd');
      else if (sim.dayState === 'midday_event') sfx('midday');
      _setIntensityFor(sim.dayState);
    }
    if (sim.gameOver && !p.gameOver) { sfx('gameover'); _intensity = 0; }
    _prev = _snap(sim);
  }

  return { init, resume, startMusic, stopMusic, observe, sfx,
           isMuted, setMuted, toggleMute };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GameSound };
