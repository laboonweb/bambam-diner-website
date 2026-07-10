/* Bambam Diner — scroll driver, reveals, tiles, status badge. */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Touch capability, not screen width — touchscreen laptops keep mouse wording
  var isTouch = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  // Hero pin length; the bowl finishes building at BUILD_END of the pin and
  // the remaining scroll holds the completed bowl before the page releases.
  // Build distance is ~327vh on both arms; the post-build hold is ~92vh on
  // mouse viewports but only ~53vh (about one natural swipe) on touch, where
  // multiple swipes of pinned "nothing left to build" feel laggy.
  var HERO_LENGTH_VH = isTouch ? 480 : 520;
  var BUILD_END = isTouch ? 0.86 : 0.78;
  // "Return home" lands here: just past build completion, in the pinned
  // admire state (finished bowl, spin hint) — not back at the empty bowl,
  // not released into the menu. Relative to BUILD_END so it holds on both
  // the touch and mouse arms.
  var HOME_P = BUILD_END + 0.04;
  var verb = isTouch ? 'swipe' : 'scroll';
  var raf = 0, lastCap = '', navScrolled = false;
  var has3d = false;

  // (Loading-screen bootstrap lives inline in index.html so its timeout
  //  starts at parse time, before the script bundles finish downloading.)

  /* ---- Deferred 3D stack ----
     three.min.js (589KB — was 75% of page weight) no longer loads as a
     blocking script tag. It's injected here, in parallel with everything
     else: jsDelivr CDN first (brotli ~120KB wire + immutable cache),
     vendor/ copy as fallback (offline / file:// / CDN blocked). The SVG
     bowl runs the hero from the start; when the 3D scene is ready it
     crossfades in over the state-matched SVG.

     Loader gating: the reveal waits for the hero to be painted AND one of
     (3D ready | 3D impossible | THREE_WAIT elapsed) — so fast connections
     still never see the SVG→3D swap, while slow ones reveal into the SVG
     instead of staring at the loader. The inline 4.5s cap still rules. */
  var THREE_WAIT = 1600;
  var heroPainted = false, threeSettled = false, threeWaitOver = false;

  function maybeHeroReady() {
    if (!heroPainted || !(threeSettled || threeWaitOver)) return;
    if (window.__bbHeroReady) window.__bbHeroReady();
  }

  function injectScript(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = onload;
    s.onerror = onerror;
    document.head.appendChild(s);
  }

  function threeFailed() {
    threeSettled = true;
    maybeHeroReady();
  }

  function upgrade3D() {
    var canvas = document.getElementById('bowl3d');
    var fb = document.getElementById('bowlFallback');
    has3d = !!(window.BB3D && window.BB3D.init());
    if (has3d && canvas) {
      if (window.__bbRevealed && fb) {
        // 3D arrived AFTER the reveal — the visitor is looking at the SVG,
        // so crossfade both layers (canvas transparent pixels would show
        // the SVG "alongside" otherwise), then retire the SVG for good.
        fb.style.display = 'block';
        var retired = false;
        var retire = function () {
          if (retired) return;
          retired = true;
          fb.style.display = 'none';
        };
        canvas.addEventListener('transitionend', retire, { once: true });
        setTimeout(retire, 800); // reduced-motion / missed-event guard
        requestAnimationFrame(function () {
          canvas.style.opacity = '1';
          fb.style.opacity = '0';
        });
      } else {
        // Loader still up (or SVG missing): snap straight to the finished
        // 3D. Fading here made the SVG peek through at reveal time.
        canvas.style.opacity = '1';
        if (fb) fb.style.display = 'none';
      }
      lastCap = '';
      tick(); // hand current scroll progress + caption to the 3D path
    }
    threeSettled = true;
    maybeHeroReady();
  }

  function load3D() {
    if (!document.getElementById('bowl3d')) { threeSettled = true; return; } // subpages: no hero
    var CDN = 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js';
    function hero() { injectScript('js/hero3d.js', upgrade3D, threeFailed); }
    injectScript(CDN, hero, function () {
      injectScript('vendor/three.min.js', hero, threeFailed);
    });
    setTimeout(function () { threeWaitOver = true; maybeHeroReady(); }, THREE_WAIT);
  }
  load3D(); // starts the download now — scripts sit at the end of <body>

  // Scroll offset of the built-bowl admire state. Computed at call time, not
  // cached: innerHeight moves under us on phones (Safari toolbar collapse) and
  // the track height depends on the current viewport.
  function homeScrollY(track) {
    return track.offsetTop + Math.max(0, track.offsetHeight - window.innerHeight) * HOME_P;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var track = document.getElementById('heroTrack');
    if (track) {
      var fullH = (window.CSS && CSS.supports && CSS.supports('height', '100dvh')) ? '100dvh' : '100svh';
      track.style.height = reduced ? fullH : HERO_LENGTH_VH + 'vh';

      // Logo → home lands on the finished bowl, not the empty one at scroll 0.
      var home = document.getElementById('navHome');
      if (home) {
        home.addEventListener('click', function (e) {
          e.preventDefault();
          window.scrollTo({ top: homeScrollY(track), behavior: reduced ? 'auto' : 'smooth' });
        });
      }
      // Subpage logos link to index.html#bowl-done: jump straight to the
      // admire state before the loader reveals (instant — the CSS
      // scroll-behavior: smooth would otherwise animate through the build).
      if (location.hash === '#bowl-done') {
        // 'instant' (not 'auto') — the html scroll-behavior:smooth rule makes
        // 'auto' animate through the whole build sequence otherwise.
        try { window.scrollTo({ top: homeScrollY(track), behavior: 'instant' }); }
        catch (err) { window.scrollTo(0, homeScrollY(track)); }
        try { history.replaceState(null, '', location.pathname); } catch (err) { /* file:// */ }
      }
    }

    if (isTouch) {
      var capEl = document.getElementById('stageCaption');
      if (capEl) capEl.textContent = 'swipe to build your bowl';
      var hintEl = document.getElementById('scrollHintWord');
      if (hintEl) hintEl.textContent = 'SWIPE';
    }

    updateStatusBadge();
    setInterval(updateStatusBadge, 60 * 1000);
    setupPetals();

    window.addEventListener('scroll', onScroll, { passive: true });
    // Debounced: Safari fires bursts of resizes while its toolbar collapses/expands
    window.addEventListener('resize', onResize, { passive: true });
    tick();
    setupNav();
    setupReveals();
    setupTiles();
    setupHeroIntro();

    // Hero (SVG — or 3D if it beat us here) has painted; the reveal also
    // waits for the 3D stack to settle or time out (see maybeHeroReady).
    requestAnimationFrame(function () {
      heroPainted = true;
      maybeHeroReady();
    });
  });

  // Staggered fade-and-rise entrance for the hero copy, matching the
  // scroll-reveal feel; plays as soon as the loading screen fades out.
  function setupHeroIntro() {
    if (reduced || !document.getElementById('heroTrack')) return;
    if (!document.body.animate) return;
    var ids = ['heroEyebrow', 'heroLogo', 'heroH1', 'heroPara', 'heroStatus', 'heroCtas'];
    var anims = [];
    ids.forEach(function (id, i) {
      var el = document.getElementById(id);
      if (!el) return;
      try {
        var a = el.animate(
          [{ opacity: 0, translate: '0 26px' }, { opacity: 1, translate: '0 0' }],
          { duration: 640, delay: i * 85, easing: 'cubic-bezier(.22, .61, .36, 1)', fill: 'backwards' }
        );
        a.pause();
        anims.push(a);
      } catch (e) { /* older browser: leave content visible */ }
    });
    function play() { anims.forEach(function (a) { a.play(); }); }
    if (!document.getElementById('bbLoader') || window.__bbRevealed) play();
    else document.addEventListener('bb:reveal', play, { once: true });
  }

  /* ---- Sakura petals: ambient site-wide layer. 12 elements animated purely
     by CSS keyframes (transform + opacity, styles in style.css); the layer is
     pointer-events: none so it can never intercept the bowl drag, nav, or
     player taps. Paused while the tab is hidden; skipped under reduced motion
     (a static frozen mid-fall scatter would just look broken). */
  function setupPetals() {
    if (reduced) return;
    var layer = document.createElement('div');
    layer.id = 'bbPetals';
    layer.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 12; i++) {
      var p = document.createElement('i');
      p.className = 'bb-petal';
      var fall = 9 + Math.random() * 8; // seconds top→bottom
      p.style.left = (Math.random() * 104 - 2) + '%';
      p.style.width = (9 + Math.random() * 8) + 'px';
      p.style.animationDuration = fall.toFixed(2) + 's';
      // negative delay: petals are already mid-fall on load, no empty sky
      p.style.animationDelay = (-Math.random() * fall).toFixed(2) + 's';
      p.style.setProperty('--drift', (Math.random() * 24 - 6).toFixed(1) + 'vw');
      p.style.setProperty('--spin', Math.round(180 + Math.random() * 540) + 'deg');
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    document.addEventListener('visibilitychange', function () {
      layer.classList.toggle('bb-paused', document.hidden);
    });
  }

  var resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { onScroll(); }, 150);
  }

  function setupNav() {
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');
    if (!toggle || !links) return;
    function close() {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
    }
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', close);
    });
    document.addEventListener('click', function (e) {
      if (!links.classList.contains('open')) return;
      if (links.contains(e.target) || toggle.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
  }

  function onScroll() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function tick() {
    raf = 0;
    var nav = document.getElementById('topNav');
    if (nav) {
      var sc = window.scrollY > 24;
      if (sc !== navScrolled) {
        navScrolled = sc;
        nav.style.boxShadow = sc ? '0 6px 22px rgba(43, 26, 18, .16)' : 'none';
      }
    }
    var track = document.getElementById('heroTrack');
    var stage = document.getElementById('heroSticky');
    if (!track || !stage) return;

    var vh = window.innerHeight;
    var total = Math.max(1, track.offsetHeight - vh);
    var p = reduced ? 1 : Math.min(1, Math.max(0, -track.getBoundingClientRect().top / total));

    // Build progress: the bowl completes at BUILD_END of the pin, then the
    // finished bowl stays pinned (b holds at 1) for the remaining scroll.
    var b = Math.min(1, p / BUILD_END);

    var seg = function (a2, b2) { return Math.min(1, Math.max(0, (b - a2) / (b2 - a2))); };
    var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
    var back = function (t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      var c = 1.4;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    };

    var vals = {
      p: b,
      broth: easeOut(seg(0.02, 0.16)),
      noodles: easeOut(seg(0.16, 0.29)),
      egg: back(seg(0.29, 0.42)),
      chashu: back(seg(0.42, 0.55)),
      nori: back(seg(0.55, 0.67)),
      onion: easeOut(seg(0.67, 0.79)),
      chops: back(seg(0.82, 0.93)),
      steam: easeOut(seg(0.9, 0.99))
    };
    vals.pour = vals.broth <= 0 ? 0 : vals.broth < 0.8 ? Math.min(1, vals.broth * 8) : Math.max(0, (1 - vals.broth) / 0.2);

    var s = stage.style;
    s.setProperty('--p', b.toFixed(4));
    s.setProperty('--broth', vals.broth.toFixed(4));
    s.setProperty('--noodles', vals.noodles.toFixed(4));
    s.setProperty('--egg', vals.egg.toFixed(4));
    s.setProperty('--chashu', vals.chashu.toFixed(4));
    s.setProperty('--nori', vals.nori.toFixed(4));
    s.setProperty('--onion', vals.onion.toFixed(4));
    s.setProperty('--chops', vals.chops.toFixed(4));
    s.setProperty('--steam', vals.steam.toFixed(4));
    s.setProperty('--pour', vals.pour.toFixed(4));

    if (has3d) window.BB3D.setProgress(vals);

    var cap = verb + ' to build your bowl';
    if (b >= 0.99 && has3d) cap = isTouch ? 'BAM! swipe to spin · pull down for top view' : 'BAM! drag to spin · pull down for top view';
    else if (b >= 0.93) cap = 'BAM! itadakimasu — kainan na!';
    else if (b >= 0.82) cap = 'chopsticks on top — ready!';
    else if (b >= 0.67) cap = 'a flurry of spring onions';
    else if (b >= 0.55) cap = 'crisp nori, tucked in';
    else if (b >= 0.42) cap = 'melt-in-your-mouth chashu';
    else if (b >= 0.29) cap = 'soft-boiled egg, jammy inside';
    else if (b >= 0.16) cap = 'fresh noodles, right in';
    else if (b >= 0.02) cap = 'pouring the 13-hour broth…';
    if (cap !== lastCap) {
      lastCap = cap;
      var el = document.getElementById('stageCaption');
      if (el) el.textContent = cap;
    }
  }

  function setupReveals() {
    if (reduced) return;
    if (!('IntersectionObserver' in window) || !document.body.animate) return;
    var targets = [];
    document.querySelectorAll('[data-reveal]').forEach(function (el) { targets.push([el, 0]); });
    document.querySelectorAll('[data-reveal-stagger]').forEach(function (g) {
      Array.prototype.slice.call(g.children).forEach(function (el, i) {
        targets.push([el, Math.min(i * 85, 680)]);
      });
    });
    var pending = new Map();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var anim = pending.get(en.target);
        if (anim) { anim.play(); pending.delete(en.target); }
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -9% 0px', threshold: 0.08 });
    var vh = window.innerHeight;
    var entrance = [];
    targets.forEach(function (pair) {
      var el = pair[0], delay = pair[1];
      if (el.getBoundingClientRect().top < vh * 0.96) { entrance.push(el); return; }
      try {
        var anim = el.animate(
          [{ opacity: 0, translate: '0 28px' }, { opacity: 1, translate: '0 0' }],
          { duration: 640, delay: delay, easing: 'cubic-bezier(.22, .61, .36, 1)', fill: 'backwards' }
        );
        anim.pause();
        pending.set(el, anim);
        io.observe(el);
      } catch (e) { /* older browser: leave content visible */ }
    });
    // Reveal targets already in view at load (subpage headings, first cards)
    // get a staggered entrance when the curtain opens — the same motion
    // language as the homepage hero intro — instead of never animating.
    // On index nothing with data-reveal sits inside the pinned hero, so this
    // path only fires on the subpages.
    if (entrance.length && document.getElementById('bbLoader') && !window.__bbRevealed) {
      var anims = [];
      entrance.forEach(function (el, i) {
        try {
          var a = el.animate(
            [{ opacity: 0, translate: '0 26px' }, { opacity: 1, translate: '0 0' }],
            { duration: 640, delay: Math.min(i * 85, 680), easing: 'cubic-bezier(.22, .61, .36, 1)', fill: 'backwards' }
          );
          a.pause();
          anims.push(a);
        } catch (e) { /* older browser: leave content visible */ }
      });
      document.addEventListener('bb:reveal', function () {
        anims.forEach(function (a) { a.play(); });
      }, { once: true });
    }
  }

  function setupTiles() {
    document.querySelectorAll('[data-zoom-tile]').forEach(function (t) {
      t.addEventListener('pointerenter', function () { t.style.setProperty('--z', '1'); });
      t.addEventListener('pointerleave', function () { t.style.setProperty('--z', '0'); });
    });
  }

  function updateStatusBadge() {
    var dot = document.getElementById('statusDot');
    var txt = document.getElementById('statusText');
    if (!dot || !txt) return;

    var now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    var day = now.getDay(); // Monday (1) closed; open Tue–Sun 12:00–21:00
    var h = now.getHours() + now.getMinutes() / 60;
    var open = day !== 1 && h >= 12 && h < 21;

    var statusText;
    if (open) statusText = 'Open now · until 9:00 PM';
    else if (day === 1 || (day === 0 && h >= 21)) statusText = 'Closed · opens Tuesday 12:00 PM';
    else if (h < 12) statusText = 'Closed · opens today 12:00 PM';
    else statusText = 'Closed · opens tomorrow 12:00 PM';

    txt.textContent = statusText;
    dot.style.background = open ? '#3BA55D' : '#D7263D';
  }
})();
