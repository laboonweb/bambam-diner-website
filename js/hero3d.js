/* Bambam Diner — low-poly 3D ramen bowl.
 * Scroll drives the build (broth → noodles → egg → chashu → nori → onions → steam),
 * then the finished bowl can be dragged to spin. Falls back to the inline SVG
 * bowl when WebGL is unavailable. */
(function () {
  'use strict';

  var COLORS = {
    bowl: 0xD7263D,
    bowlInner: 0xF3E3C2,
    outline: 0x2B1A12,
    broth: 0xEEB64B,
    noodleA: 0xF6D77B,
    noodleB: 0xF1CC66,
    chashuEdge: 0xE7B583,
    chashuCenter: 0xF6DCB4,
    eggWhite: 0xFFFDF3,
    yolk: 0xF2932F,
    nori: 0x2E4A38,
    noriInner: 0x4C7A57,
    onion: 0x4E9C46,
    onionLight: 0x5CAD52,
    steam: 0xC9B8A3,
    shadow: 0x2B1A12
  };

  var state = {
    active: false,
    built: false,
    reduced: false,
    vals: { p: 0, broth: 0, noodles: 0, egg: 0, chashu: 0, nori: 0, onion: 0, steam: 0, pour: 0 },
    dragY: 0, velY: 0, velPhi: 0,
    spin: 0, spinAngle: 0, lastT: 0,
    dragging: false,
    visible: true,
    rafId: 0
  };

  // Orbit: azimuth spins the bowl group; polar moves the camera on a vertical arc.
  // phi is measured from straight-above: 15° (near top-down) to 85° (near level).
  var ORBIT = {
    r: 5.75, targetY: 0.72,
    phi: 1.08,                  // ~62° — natural 3/4 view: down into the opening, foot still visible
    min: 15 * Math.PI / 180,
    max: 85 * Math.PI / 180
  };

  function updateCamera() {
    camera.position.set(0, ORBIT.targetY + ORBIT.r * Math.cos(ORBIT.phi), ORBIT.r * Math.sin(ORBIT.phi));
    camera.lookAt(0, ORBIT.targetY, 0);
  }

  var renderer, scene, camera, bowlGroup;
  var parts = {}; // broth, noodles, pour, drops[], onions[], steamPuffs[]
  var clock;

  function mat(color, opts) {
    var m = new THREE.MeshStandardMaterial(Object.assign({
      color: color, flatShading: true, roughness: 0.75, metalness: 0
    }, opts || {}));
    m.color.convertSRGBToLinear(); // keep hex colors true under sRGB output
    return m;
  }

  // Cartoon outline: inverted dark hull behind the mesh
  function addOutline(mesh, thickness) {
    var outline = new THREE.Mesh(
      mesh.geometry,
      new THREE.MeshBasicMaterial({ color: COLORS.outline, side: THREE.BackSide })
    );
    outline.scale.setScalar(1 + (thickness || 0.045));
    mesh.add(outline);
    return outline;
  }

  function buildBowl() {
    var group = new THREE.Group();

    // Bowl body via lathe (foot → outer wall → rim → inner wall).
    // The radius increases monotonically from foot to rim: an earlier inward
    // notch above the foot created an overhang you could see straight through
    // from raised camera angles (read as a stray white ring).
    var pts = [
      new THREE.Vector2(0.55, 0.00),
      new THREE.Vector2(0.85, 0.00),
      new THREE.Vector2(0.92, 0.19),
      new THREE.Vector2(1.02, 0.38),
      new THREE.Vector2(1.38, 0.75),
      new THREE.Vector2(1.68, 1.10),
      new THREE.Vector2(1.80, 1.34),
      new THREE.Vector2(1.72, 1.38),
      new THREE.Vector2(1.55, 1.18),
      new THREE.Vector2(1.22, 0.78),
      new THREE.Vector2(0.85, 0.52),
      new THREE.Vector2(0.0, 0.46)
    ];
    var bowlGeo = new THREE.LatheGeometry(pts, 14);
    var bowl = new THREE.Mesh(bowlGeo, mat(COLORS.bowl, { side: THREE.DoubleSide, roughness: 0.6 }));
    group.add(bowl);

    // Outline hull for the bowl silhouette (outer surface only)
    var outerPts = pts.slice(0, 8);
    var hullGeo = new THREE.LatheGeometry(outerPts, 14);
    var hull = new THREE.Mesh(hullGeo, new THREE.MeshBasicMaterial({ color: COLORS.outline, side: THREE.BackSide }));
    hull.scale.set(1.035, 1.035, 1.035);
    hull.position.y = -0.02;
    group.add(hull);

    // Interior floor: slightly darker red so the inside reads as the same
    // bowl with depth. (An earlier cream disk here was oversized — it poked
    // through the wall as a white ring and painted the interior cream.)
    var floor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.6, 0.08, 14),
      mat(0xB71C31)
    );
    floor.position.y = 0.52;
    group.add(floor);

    // Yellow accent band on the wall (nod to the BAM BAM lettering)
    var band = new THREE.Mesh(
      new THREE.CylinderGeometry(1.54, 1.36, 0.22, 14, 1, true),
      mat(0xFFC72C, { side: THREE.DoubleSide })
    );
    band.position.y = 0.82;
    group.add(band);

    // Fake contact shadow
    var shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 18),
      new THREE.MeshBasicMaterial({ color: COLORS.shadow, transparent: true, opacity: 0.12 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.02;
    shadow.scale.set(1.15, 1, 1);
    group.add(shadow);

    return group;
  }

  function buildBroth() {
    var broth = new THREE.Mesh(
      new THREE.CylinderGeometry(1.52, 1.2, 0.14, 14),
      mat(COLORS.broth, { transparent: true, roughness: 0.5 })
    );
    broth.position.y = 1.1;
    return broth;
  }

  function buildNoodles() {
    var g = new THREE.Group();
    var lanes = [-0.55, -0.18, 0.18, 0.55];
    for (var i = 0; i < lanes.length; i++) {
      var pts3 = [];
      for (var s = 0; s <= 8; s++) {
        var x = -1.05 + (2.1 * s) / 8;
        pts3.push(new THREE.Vector3(x, 1.19 + Math.sin(s * 1.9 + i) * 0.035, lanes[i] + Math.sin(s * 1.3 + i * 2) * 0.06));
      }
      var curve = new THREE.CatmullRomCurve3(pts3);
      var tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.065, 5, false),
        mat(i % 2 ? COLORS.noodleB : COLORS.noodleA, { transparent: true })
      );
      g.add(tube);
    }
    return g;
  }

  function buildChashu(radius, x, z) {
    var g = new THREE.Group();
    var slice = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.16, 10), mat(COLORS.chashuEdge, { transparent: true }));
    addOutline(slice, 0.06);
    var center = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.17, 10), mat(COLORS.chashuCenter, { transparent: true }));
    g.add(slice); g.add(center);
    g.position.set(x, 0, z);
    g.rotation.y = Math.random() * Math.PI;
    return g;
  }

  function buildEgg(scale, x, z, rotY) {
    var g = new THREE.Group();
    var white = new THREE.Mesh(new THREE.SphereGeometry(0.42 * scale, 10, 8), mat(COLORS.eggWhite, { transparent: true, roughness: 0.55 }));
    white.scale.y = 0.55;
    addOutline(white, 0.07);
    var yolk = new THREE.Mesh(new THREE.SphereGeometry(0.19 * scale, 9, 7), mat(COLORS.yolk, { transparent: true, roughness: 0.4 }));
    yolk.scale.y = 0.5;
    yolk.position.y = 0.12 * scale;
    g.add(white); g.add(yolk);
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    return g;
  }

  function buildNori() {
    // Flat sheet standing in the broth, leaning back against the rim.
    // Face normal points at the bowl center so it reads correctly from
    // every azimuth when the bowl spins.
    var g = new THREE.Group();
    var sheet = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.05, 0.06), mat(COLORS.nori, { transparent: true }));
    addOutline(sheet, 0.05);
    var stripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.68, 0.065), mat(COLORS.noriInner, { transparent: true }));
    stripe.position.z = 0.004;
    g.add(sheet); g.add(stripe);
    g.position.set(-0.78, 0.34, -0.78); // local offset; parent group carries the drop
    g.rotation.order = 'YXZ';
    g.rotation.y = Math.PI / 4;   // face the bowl center from the back-left
    g.rotation.x = -0.24;         // lean back onto the rim
    var wrap = new THREE.Group();
    wrap.add(g);
    return wrap;
  }

  function buildChopsticks() {
    // Pair of tapered low-poly sticks resting across the rim.
    var g = new THREE.Group();
    for (var i = 0; i < 2; i++) {
      var stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.062, 4.1, 6),
        mat(i ? 0xC98F4B : 0xD9A05B, { transparent: true, roughness: 0.65 })
      );
      addOutline(stick, 0.035);
      var holder = new THREE.Group();
      holder.add(stick);
      holder.rotation.z = -Math.PI / 2;            // lie along X, thin tips to the right
      holder.rotation.y = i ? -0.05 : 0.06;        // slightly splayed, casually dropped
      holder.position.set(0.25, 0, -0.14 + i * 0.3);
      g.add(holder);
    }
    var wrap = new THREE.Group();
    wrap.add(g);
    return wrap;
  }

  function buildOnions() {
    var g = new THREE.Group();
    var spots = [
      [-0.65, 0.55], [0.15, -0.35], [0.75, 0.35], [-0.2, 0.8],
      [0.45, 0.75], [-0.95, -0.15], [0.95, -0.25], [-0.35, -0.7], [0.3, 0.15]
    ];
    for (var i = 0; i < spots.length; i++) {
      var ring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.05, 7),
        mat(i % 2 ? COLORS.onionLight : COLORS.onion, { transparent: true })
      );
      ring.position.set(spots[i][0], 1.2, spots[i][1]);
      ring.rotation.set(Math.random() * 0.5, 0, Math.random() * 0.5);
      ring.userData.delay = (i % 3) * 0.18; // three little waves, like the SVG
      g.add(ring);
    }
    return g;
  }

  function buildSteam() {
    var puffs = [];
    var cols = [[-0.55, 0.1, 0], [0.05, -0.2, 0.6], [0.6, 0.25, 1.2]];
    for (var c = 0; c < cols.length; c++) {
      for (var k = 0; k < 3; k++) {
        var puff = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.13 + k * 0.035, 0),
          new THREE.MeshStandardMaterial({ color: COLORS.steam, flatShading: true, transparent: true, opacity: 0, roughness: 1 })
        );
        puff.userData = { x: cols[c][0], z: cols[c][1], phase: cols[c][2] + k * 0.85, k: k };
        puffs.push(puff);
      }
    }
    return puffs;
  }

  function buildPour() {
    var g = new THREE.Group();
    var stream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.17, 3.2, 8),
      mat(COLORS.broth, { transparent: true })
    );
    stream.position.y = 1.2 + 1.6;
    var splash = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.34, 0.1, 9),
      mat(0xF6CE74, { transparent: true })
    );
    splash.position.y = 1.18;
    g.add(stream); g.add(splash);
    return g;
  }

  function setGroupOpacity(obj, opacity) {
    obj.traverse(function (n) {
      if (n.isMesh && n.material && n.material.transparent) n.material.opacity = opacity;
    });
  }

  function init() {
    var canvas = document.getElementById('bowl3d');
    var fallback = document.getElementById('bowlFallback');
    if (!canvas || typeof THREE === 'undefined') return false;

    // WebGL support check
    try {
      var test = document.createElement('canvas');
      if (!(window.WebGLRenderingContext && (test.getContext('webgl') || test.getContext('experimental-webgl')))) return false;
    } catch (e) { return false; }

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
    } catch (e) { return false; }

    state.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    updateCamera();

    scene.add(new THREE.HemisphereLight(0xFFF7E9, 0xD9B98C, 0.95));
    var sun = new THREE.DirectionalLight(0xFFFFFF, 0.85);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    bowlGroup = new THREE.Group();
    scene.add(bowlGroup);

    bowlGroup.add(buildBowl());

    parts.broth = buildBroth();
    parts.broth.visible = false;
    bowlGroup.add(parts.broth);

    parts.noodles = buildNoodles();
    parts.noodles.visible = false;
    bowlGroup.add(parts.noodles);

    // Drop-in toppings: [group, key, targetY, dropHeight]
    parts.drops = [];
    function drop(group, key, targetY, height) {
      group.position.y = targetY + height;
      group.visible = false;
      bowlGroup.add(group);
      parts.drops.push({ g: group, key: key, y: targetY, h: height });
    }
    drop(buildEgg(1.0, 0.82, -0.28, 0.4), 'egg', 1.16, 3.4);
    drop(buildEgg(0.82, 0.28, -0.78, 2.1), 'egg', 1.14, 2.7);
    drop(buildChashu(0.5, -0.72, 0.28), 'chashu', 1.16, 3.4);
    drop(buildChashu(0.4, 0.5, 0.62), 'chashu', 1.14, 2.8);
    drop(buildNori(), 'nori', 1.18, 3.6);
    // rim top edge is y≈1.36; stick radius ≈0.05 → centers at 1.41 rest ON the rim
    drop(buildChopsticks(), 'chops', 1.41, 3.2);

    parts.onions = buildOnions();
    parts.onions.visible = false;
    bowlGroup.add(parts.onions);

    parts.pour = buildPour();
    parts.pour.visible = false;
    bowlGroup.add(parts.pour);

    parts.steamPuffs = buildSteam();
    parts.steamPuffs.forEach(function (p) { bowlGroup.add(p); });

    clock = new THREE.Clock();

    setupResize(canvas);
    setupDrag(canvas);
    setupVisibility();

    state.active = true;
    canvas.style.display = 'block';
    canvas.style.touchAction = isPhone() ? 'auto' : 'pan-y';
    if (fallback) fallback.style.display = 'none';

    renderer.render(scene, camera); // paint the empty bowl before the loader lifts
    startLoop();
    return true;
  }

  function setupResize(canvas) {
    var wrap = canvas.parentElement;
    var timer = 0;
    function resize() {
      var w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      startLoop();
    }
    // Debounced: Safari fires resize bursts during toolbar collapse/expand
    function onResize() {
      clearTimeout(timer);
      timer = setTimeout(resize, 150);
    }
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(wrap);
    else window.addEventListener('resize', onResize);
    resize();
  }

  // Phones (touch-primary AND phone-sized) get zero canvas gesture capture
  // mid-build — people swipe through mid-screen to scroll, exactly where the
  // bowl sits. Tablets/desktop keep drag-anytime behavior.
  function isPhone() {
    return window.matchMedia &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches &&
      window.matchMedia('(max-width: 760px), (max-height: 500px)').matches;
  }

  function setupDrag(canvas) {
    var lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', function (e) {
      if (!state.built && isPhone()) return; // pass through: page scroll owns it
      state.dragging = true;
      state.velY = 0; state.velPhi = 0;
      lastX = e.clientX; lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!state.dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      state.dragY += dx * 0.009;
      state.velY = dx * 0.009;
      // "grab the object": drag DOWN (dy > 0) pulls the bowl's front toward
      // the viewer → camera climbs toward a top-down view (phi decreases)
      ORBIT.phi = Math.min(ORBIT.max, Math.max(ORBIT.min, ORBIT.phi - dy * 0.006));
      state.velPhi = -dy * 0.006;
    });
    function release() {
      state.dragging = false;
      canvas.style.cursor = 'grab';
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    // Once the bowl is built the canvas owns its touch gestures entirely
    // (touch-action flips to 'none' in applyVals); before that, vertical
    // swipes must keep scrolling the page so the build can progress.
    canvas.addEventListener('touchstart', function (e) {
      if (state.built) e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', function (e) {
      if (state.built) e.preventDefault();
    }, { passive: false });
  }

  function setupVisibility() {
    var track = document.getElementById('heroTrack');
    if (!track || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (entries) {
      state.visible = entries[0].isIntersecting;
      if (state.visible) startLoop();
    }, { rootMargin: '100px' }).observe(track);
  }

  function applyVals() {
    var v = state.vals;

    parts.broth.visible = v.broth > 0.002;
    if (parts.broth.visible) {
      var b = Math.max(0.002, v.broth);
      parts.broth.scale.set(b, 1, b);
      parts.broth.material.opacity = Math.min(1, v.broth * 6);
    }

    parts.noodles.visible = v.noodles > 0.002;
    if (parts.noodles.visible) {
      var n = Math.max(0.002, Math.min(1, v.noodles));
      parts.noodles.rotation.y = (1 - n) * 2.6;
      parts.noodles.scale.setScalar(n);
      setGroupOpacity(parts.noodles, Math.min(1, v.noodles * 4));
    }

    parts.drops.forEach(function (d) {
      var val = v[d.key];
      d.g.visible = val > 0.02;
      if (!d.g.visible) return;
      d.g.position.y = d.y + (1 - val) * d.h; // back-eased val overshoots → little bounce
      setGroupOpacity(d.g, Math.min(1, val * 4));
    });

    parts.onions.visible = v.onion > 0.02;
    if (parts.onions.visible) {
      parts.onions.children.forEach(function (ring) {
        var lv = Math.max(0, Math.min(1, v.onion * 1.4 - ring.userData.delay));
        ring.position.y = 1.2 + (1 - lv) * 2.4;
        ring.material.opacity = Math.min(1, lv * 3);
      });
    }

    parts.pour.visible = v.pour > 0.01;
    if (parts.pour.visible) setGroupOpacity(parts.pour, v.pour);

    state.built = v.p >= 0.97;
    // built: canvas owns gestures; mid-build: phones scroll natively in every
    // direction ('auto'), tablets/desktop keep pan-y (vertical scrolls, drag spins)
    var ta = state.built ? 'none' : (isPhone() ? 'auto' : 'pan-y');
    if (renderer.domElement.style.touchAction !== ta) renderer.domElement.style.touchAction = ta;
  }

  function animateSteam(t) {
    var s = state.vals.steam;
    parts.steamPuffs.forEach(function (p) {
      var u = state.reduced ? (0.3 + p.userData.k * 0.25) : ((t * 0.45 + p.userData.phase) % 1.6) / 1.6;
      p.position.set(
        p.userData.x + Math.sin(t * 1.3 + p.userData.phase * 4) * 0.08,
        1.45 + u * 1.5,
        p.userData.z
      );
      p.material.opacity = s * Math.max(0, Math.sin(u * Math.PI)) * 0.75;
      p.visible = s > 0.01;
    });
  }

  function startLoop() {
    if (state.rafId || !state.active) return;
    state.rafId = requestAnimationFrame(tick);
  }

  function tick() {
    state.rafId = 0;
    if (!state.visible) { renderer.render(scene, camera); return; }

    var t = clock.getElapsedTime();
    var dt = Math.min(0.05, t - (state.lastT || t));
    state.lastT = t;

    // inertia on both orbit axes
    if (!state.dragging) {
      if (Math.abs(state.velY) > 0.0004) {
        state.dragY += state.velY;
        state.velY *= state.reduced ? 0 : 0.94;
      }
      if (Math.abs(state.velPhi) > 0.0004) {
        ORBIT.phi += state.velPhi;
        if (ORBIT.phi <= ORBIT.min || ORBIT.phi >= ORBIT.max) {
          ORBIT.phi = Math.min(ORBIT.max, Math.max(ORBIT.min, ORBIT.phi));
          state.velPhi = 0; // settle at the bound, no bounce
        }
        state.velPhi *= state.reduced ? 0 : 0.94;
      }
    }
    updateCamera();

    // slow showcase spin once built; pauses during drag, eases back in after
    var spinTarget = (state.built && !state.dragging && !state.reduced) ? 0.12 : 0;
    state.spin += (spinTarget - state.spin) * Math.min(1, dt * 1.5);
    state.spinAngle += state.spin * dt;

    var autoRot = state.reduced ? 0 : state.vals.p * 0.5;
    bowlGroup.rotation.y = autoRot + state.spinAngle + state.dragY;
    if (!state.reduced) bowlGroup.position.y = state.built ? Math.sin(t * 1.1) * 0.03 : 0;

    animateSteam(t);
    renderer.render(scene, camera);
    state.rafId = requestAnimationFrame(tick);
  }

  window.BB3D = {
    init: init,
    isActive: function () { return state.active; },
    isBuilt: function () { return state.built; },
    orbitPhi: function () { return ORBIT.phi; },
    orbitState: function () { return { phi: ORBIT.phi, spinAngle: state.spinAngle, spin: state.spin }; },
    setProgress: function (vals) {
      if (!state.active) return;
      state.vals = vals;
      applyVals();
      startLoop();
    }
  };
})();
