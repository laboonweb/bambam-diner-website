/* Bambam Diner — floating background music player.
   The playlist + enable-music bootstrap (window.__bbMusic) lives INLINE in
   index.html: autoplay policies (Safari strictest) require audio.play() to
   run synchronously inside the click gesture, and the loader button is
   clickable before this file may have finished downloading. This module
   adopts whatever that bootstrap created and owns everything after that. */
(function () {
  'use strict';

  var m = window.__bbMusic;
  var root = document.getElementById('bbPlayer');
  if (!m || !root) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Phone = touch-primary AND phone-sized — same test hero3d.js uses.
  // Phones get the compact mini-bar by default; desktop/tablet keep the pill.
  var isPhoneView = window.matchMedia &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches &&
    window.matchMedia('(max-width: 760px), (max-height: 500px)').matches;

  // Filenames follow "Title by Creator" — split on the LAST " by " so
  // titles containing "by" elsewhere stay intact.
  var tracks = m.tracks.map(function (name) {
    var cut = name.lastIndexOf(' by ');
    return {
      file: 'audio/' + encodeURIComponent(name) + '.mp3',
      title: cut > -1 ? name.slice(0, cut) : name,
      creator: cut > -1 ? name.slice(cut + 4) : ''
    };
  });

  // Session-only state, kept in memory (no localStorage). Mute lives on
  // audio.muted so the volume level survives mute/unmute untouched.
  var state = {
    index: m.index,
    shuffle: false,
    repeat: 0, // 0 off · 1 all · 2 one
    history: [], // shuffle backtracking for "previous"
    bag: [] // shuffle: remaining not-yet-played indices
  };

  var audio, ctx, analyser, freq, graphTried = false, rafId = 0;
  var canvas, g2d, els = {};

  var WAVE_W = 52, WAVE_H = 26, BAR_COUNT = 12;
  var BAR_COLORS = ['#D7263D', '#FFC72C'];
  var STATIC_BARS = [0.34, 0.58, 0.42, 0.78, 0.5, 0.68, 0.38, 0.74, 0.55, 0.62, 0.4, 0.48];

  // Init NOW, not at DOMContentLoaded: the player markup sits above this
  // script tag, and DOMContentLoaded would make the track title wait behind
  // whatever else is still downloading on slow connections.
  init();

  function init() {
    ['Pop', 'Shuffle', 'Repeat', 'RepeatBadge', 'Mute', 'MuteOn', 'MuteOff', 'Vol', 'List',
      'Title', 'Sub', 'Prev', 'Play', 'PlayIco', 'PauseIco', 'Next', 'More', 'Fold', 'Mini', 'MiniTitle'
    ].forEach(function (k) { els[k] = document.getElementById('bbp' + k); });
    canvas = document.getElementById('bbpWave');
    g2d = canvas.getContext('2d');
    sizeCanvas();

    audio = m.audio;
    if (!audio) {
      // Lazy: preload none + no play() — no audio bytes move until the
      // visitor actually starts playback.
      audio = m.audio = new Audio();
      audio.preload = 'none';
      audio.src = tracks[state.index].file;
      audio.volume = 0.7;
    }

    buildList();

    audio.addEventListener('play', function () { ensureGraph(); updateUI(); startWave(); });
    audio.addEventListener('pause', function () { updateUI(); stopWave(); });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('volumechange', updateUI);

    els.Play.addEventListener('click', function () { if (audio.paused) safePlay(); else audio.pause(); });
    els.Next.addEventListener('click', function () { goNext(false); });
    els.Prev.addEventListener('click', goPrev);
    els.More.addEventListener('click', function () {
      if (els.Pop.hidden) { els.Pop.hidden = false; els.More.setAttribute('aria-expanded', 'true'); }
      else closePop();
    });
    if (isPhoneView) {
      root.classList.add('bb-mobile', 'compact');
      els.Mini.addEventListener('click', function () { root.classList.remove('compact'); });
      els.Fold.addEventListener('click', function () { closePop(); root.classList.add('compact'); });

      // Hero-aware: the pinned hero keeps its swipe caption + progress bar
      // at the bottom of the phone viewport — exactly where the player
      // floats. Step aside while the hero owns the screen and come back
      // once the visitor scrolls past. The sticky stage's intersection
      // ratio sits at ~1 for the whole pin and falls as it releases.
      var heroStage = document.getElementById('heroSticky');
      if (heroStage && 'IntersectionObserver' in window) {
        root.classList.add('bb-hero'); // page opens at the hero
        new IntersectionObserver(function (entries) {
          var inHero = entries[0].isIntersecting && entries[0].intersectionRatio >= 0.8;
          if (inHero) closePop();
          root.classList.toggle('bb-hero', inHero);
        }, { threshold: [0.75, 0.85] }).observe(heroStage);
      }
    }
    els.Shuffle.addEventListener('click', function () {
      state.shuffle = !state.shuffle;
      if (state.shuffle) refillBag();
      state.history.length = 0;
      updateUI();
    });
    els.Repeat.addEventListener('click', function () {
      state.repeat = (state.repeat + 1) % 3;
      updateUI();
    });
    els.Mute.addEventListener('click', function () { audio.muted = !audio.muted; updateUI(); });
    els.Vol.addEventListener('input', function () {
      audio.volume = els.Vol.value / 100;
      if (audio.muted && audio.volume > 0) audio.muted = false;
    });

    document.addEventListener('click', function (e) {
      if (els.Pop.hidden || root.contains(e.target)) return;
      closePop();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });
    window.addEventListener('resize', sizeCanvas, { passive: true });
    document.addEventListener('bb:musicwanted', updateUI);

    updateUI();
    drawWave();
    // Adopted audio may already be playing (loader click landed before init)
    if (!audio.paused) { ensureGraph(); startWave(); }
  }

  function safePlay() {
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
  }

  function closePop() {
    els.Pop.hidden = true;
    els.More.setAttribute('aria-expanded', 'false');
  }

  function buildList() {
    tracks.forEach(function (t, i) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      var num = document.createElement('span');
      num.className = 'bbp-li-num';
      num.textContent = i + 1;
      var meta = document.createElement('span');
      meta.className = 'bbp-li-meta';
      var ti = document.createElement('span');
      ti.className = 'bbp-li-title';
      ti.textContent = t.title;
      var by = document.createElement('span');
      by.className = 'bbp-li-by';
      by.textContent = t.creator ? 'by ' + t.creator : '';
      meta.appendChild(ti);
      meta.appendChild(by);
      btn.appendChild(num);
      btn.appendChild(meta);
      btn.addEventListener('click', function () {
        if (i === state.index) { safePlay(); return; }
        state.history.push(state.index);
        var bi = state.bag.indexOf(i);
        if (bi > -1) state.bag.splice(bi, 1);
        loadTrack(i, true);
      });
      li.appendChild(btn);
      els.List.appendChild(li);
    });
  }

  function loadTrack(i, autoplay) {
    state.index = i;
    m.index = i;
    audio.src = tracks[i].file;
    if (autoplay) safePlay();
    updateUI();
    drawWave();
  }

  function refillBag() {
    state.bag = [];
    for (var i = 0; i < tracks.length; i++) if (i !== state.index) state.bag.push(i);
    for (var j = state.bag.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = state.bag[j];
      state.bag[j] = state.bag[k];
      state.bag[k] = t;
    }
  }

  // -1 = playlist finished (repeat off): stop instead of advancing
  function pickNext(manual) {
    if (state.shuffle) {
      if (!state.bag.length) {
        if (state.repeat === 1 || manual) refillBag();
        else return -1;
      }
      return state.bag.pop();
    }
    var n = state.index + 1;
    if (n >= tracks.length) return (state.repeat === 1 || manual) ? 0 : -1;
    return n;
  }

  function goNext(fromEnded) {
    var wasPlaying = fromEnded || !audio.paused;
    var n = pickNext(!fromEnded);
    if (n < 0) { updateUI(); drawWave(); return; }
    if (state.shuffle) state.history.push(state.index);
    loadTrack(n, wasPlaying);
  }

  function goPrev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    var wasPlaying = !audio.paused;
    var p;
    if (state.shuffle && state.history.length) p = state.history.pop();
    else p = (state.index - 1 + tracks.length) % tracks.length;
    loadTrack(p, wasPlaying);
  }

  function onEnded() {
    if (state.repeat === 2) { audio.currentTime = 0; safePlay(); return; }
    goNext(true);
  }

  function updateUI() {
    var t = tracks[state.index];
    els.Title.textContent = t.title;
    els.MiniTitle.textContent = t.title;
    els.Sub.textContent = (t.creator ? 'by ' + t.creator + ' · ' : '') +
      'Track ' + (state.index + 1) + ' of ' + tracks.length;

    var playing = !audio.paused;
    root.classList.toggle('playing', playing);
    els.PlayIco.style.display = playing ? 'none' : '';
    els.PauseIco.style.display = playing ? '' : 'none';
    els.Play.setAttribute('aria-label', playing ? 'Pause' : 'Play');

    els.Shuffle.classList.toggle('active', state.shuffle);
    els.Shuffle.setAttribute('aria-pressed', state.shuffle ? 'true' : 'false');
    els.Shuffle.setAttribute('aria-label', state.shuffle ? 'Shuffle on' : 'Shuffle off');

    els.Repeat.classList.toggle('active', state.repeat > 0);
    els.RepeatBadge.style.display = state.repeat === 2 ? '' : 'none';
    els.Repeat.setAttribute('aria-label',
      state.repeat === 0 ? 'Repeat: off' : state.repeat === 1 ? 'Repeat: all' : 'Repeat: one');

    els.MuteOn.style.display = audio.muted ? 'none' : '';
    els.MuteOff.style.display = audio.muted ? '' : 'none';
    els.Mute.classList.toggle('active', audio.muted);
    els.Mute.setAttribute('aria-pressed', audio.muted ? 'true' : 'false');
    els.Mute.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');

    if (document.activeElement !== els.Vol) els.Vol.value = Math.round(audio.volume * 100);

    var items = els.List.children;
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('current', i === state.index);
  }

  /* ---- Web Audio analyser (live waveform) ---- */

  function ensureGraph() {
    if (graphTried) {
      if (ctx && ctx.state === 'suspended') { var r = ctx.resume(); if (r && r.catch) r.catch(function () {}); }
      return;
    }
    graphTried = true;
    // On file:// the media element is a CORS-opaque source: routing it
    // through the graph would output silence. Skip — static bars instead.
    if (location.protocol === 'file:') return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC(); } catch (e) { ctx = null; return; }
    var wire = function () {
      try {
        var src = ctx.createMediaElementSource(audio);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.72;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        freq = new Uint8Array(analyser.frequencyBinCount);
        startWave();
      } catch (e) { analyser = null; }
    };
    // Never route audio into a suspended context (it would go silent);
    // wire the analyser only once the context is actually running.
    if (ctx.state === 'running') wire();
    else ctx.resume().then(wire, function () { ctx = null; });
  }

  function sizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(WAVE_W * dpr);
    canvas.height = Math.round(WAVE_H * dpr);
    g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWave();
  }

  function drawWave() {
    var live = analyser && !reduced && !audio.paused;
    if (live) analyser.getByteFrequencyData(freq);
    g2d.clearRect(0, 0, WAVE_W, WAVE_H);
    var slot = WAVE_W / BAR_COUNT;
    var bw = slot * 0.62;
    for (var i = 0; i < BAR_COUNT; i++) {
      var v;
      if (live) {
        // log-ish spread over the lower bins, where the music energy is
        var bin = 1 + Math.floor(Math.pow(i / BAR_COUNT, 1.5) * 22);
        v = Math.max(0.14, freq[bin] / 255);
      } else {
        v = STATIC_BARS[i] * (audio && !audio.paused ? 1 : 0.55);
      }
      var bh = Math.max(3, v * WAVE_H);
      var x = i * slot + (slot - bw) / 2;
      var y = (WAVE_H - bh) / 2;
      g2d.fillStyle = BAR_COLORS[i % 2];
      if (g2d.roundRect) {
        g2d.beginPath();
        g2d.roundRect(x, y, bw, bh, bw / 2);
        g2d.fill();
      } else {
        g2d.fillRect(x, y, bw, bh);
      }
    }
  }

  function startWave() {
    drawWave();
    // Reduced motion: one static frame, no animation loop (audio unaffected)
    if (reduced || !analyser) return;
    if (!rafId) rafId = requestAnimationFrame(waveTick);
  }

  function waveTick() {
    rafId = 0;
    drawWave();
    if (!audio.paused && analyser) rafId = requestAnimationFrame(waveTick);
  }

  function stopWave() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    drawWave();
  }
})();
