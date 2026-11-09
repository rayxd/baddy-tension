// The 3D racket view. Real taps drive it: each tap rings the string bed like a
// drum skin and sends a sound wave out across the screen; a confirmed reading
// turns the racket to face you and locks the wave into a steady line.
// app.js talks to it through window.attachRacketScene. Without WebGL this never
// attaches and the app shows a flat racket picture instead. With Reduce Motion
// on, the racket stays still and only its colours change.
import * as THREE from './vendor/three.module.min.js';

const COLORS = {
  accent: 0x2fd59a, // string green
  amber: 0xff922b, // overtones and restring warnings
  chalk: 0x4a6075, // idle strings
  mint: 0xc9ffe9, // strings while ringing
  dud: 0x5d6b7a, // a tap that didn't count
};

// String bed: half width, half height and centre height, in scene units.
const A = 0.95, B = 1.18, CY = 0.55;
const IDLE_STOP_MS = 6000; // stop drawing this long after the last activity

function J0(x) { let s = 1, t = 1; for (let k = 1; k < 14; k++) { t *= -(x * x / 4) / (k * k); s += t; } return s; }
function J1(x) { let t = x / 2, s = t; for (let k = 1; k < 14; k++) { t *= -(x * x / 4) / (k * (k + 1)); s += t; } return s; }

// Drum-membrane mode shapes: (0,1) is the fundamental the app measures,
// (1,1) is the overtone that rocks the bed in two halves.
function modeShape(x, y, overtone) {
  const nx = x / A, ny = (y - CY) / B, r = Math.min(1, Math.hypot(nx, ny));
  return overtone ? J1(3.832 * r) * (r > 1e-4 ? nx / r : 0) / 0.582 : J0(2.405 * r);
}

const smoothstep = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

function createScene(stage, canvas, still) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0b131c, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2.5, 3, 4);
  scene.add(key);
  const rim = new THREE.PointLight(COLORS.accent, 6, 9);
  rim.position.set(-1.8, 1.8, -1.6);
  scene.add(rim);

  /* ----- Racket ----- */
  const racket = new THREE.Group();
  scene.add(racket);
  // Colours and finish come from the racket's look (setLook); these are defaults.
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x223244, metalness: 0.55, roughness: 0.32 });
  const accentMat = new THREE.MeshStandardMaterial({ color: COLORS.accent, metalness: 0.4, roughness: 0.35 });
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0x8b9bb0, metalness: 0.7, roughness: 0.25 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x1c2a39, roughness: 0.85 });

  // The head frame plus a thin accent stripe along its face. Head shapes:
  // isometric has squarer shoulders, oval is a plain ellipse, compact is smaller.
  const HEAD_SHAPES = { isometric: { square: 0.05, scale: 1 }, oval: { square: 0, scale: 1 }, compact: { square: 0.04, scale: 0.95 } };
  let headMeshes = [];
  let headShape = '';
  function buildHead(shape) {
    if (shape === headShape) return;
    headShape = shape;
    const cfg = HEAD_SHAPES[shape] || HEAD_SHAPES.isometric;
    headMeshes.forEach(m => { racket.remove(m); m.geometry.dispose(); });
    const pts = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const k = 1 + cfg.square * Math.pow(Math.sin(2 * a), 2);
      pts.push(new THREE.Vector3((A + 0.06) * c * k, CY + (B + 0.06) * s * (s > 0 ? k : 1), 0));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const frame = new THREE.Mesh(new THREE.TubeGeometry(curve, 220, 0.052, 12, true), frameMat);
    const stripe = new THREE.Mesh(new THREE.TubeGeometry(curve, 220, 0.016, 6, true), accentMat);
    stripe.position.z = 0.045;
    headMeshes = [frame, stripe];
    headMeshes.forEach(m => racket.add(m));
    racket.scale.setScalar(cfg.scale);
  }
  buildHead('isometric');

  const cyl = (r0, r1, y0, y1, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, y1 - y0, 20), mat);
    m.position.y = (y0 + y1) / 2;
    racket.add(m);
  };
  const throatY = CY - B - 0.06;
  cyl(0.05, 0.075, throatY - 0.12, throatY + 0.02, frameMat);
  cyl(0.032, 0.032, -2.05, throatY - 0.1, shaftMat);
  cyl(0.088, 0.08, -3.2, -2.05, gripMat);
  cyl(0.094, 0.094, -2.16, -2.05, accentMat);

  // Faint glow across the string bed that brightens while it rings.
  const bedShape = new THREE.Shape();
  bedShape.absellipse(0, CY, A, B, 0, Math.PI * 2);
  const bed = new THREE.Mesh(new THREE.ShapeGeometry(bedShape, 48),
    new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.04, depthWrite: false, side: THREE.DoubleSide }));
  bed.position.z = -0.01;
  racket.add(bed);

  // Strings: 20 mains and 23 crosses, each a polyline displaced every frame.
  const NP = 30;
  const strings = [];
  const stringMat = new THREE.LineBasicMaterial({ color: COLORS.chalk, transparent: true, opacity: 0.9 });
  const stringBase = new THREE.Color(COLORS.chalk); // the string's own colour, dimmed for the dark stage
  const addString = (horizontal, c) => {
    const half = horizontal
      ? A * Math.sqrt(Math.max(0, 1 - ((c - CY) / B) ** 2))
      : B * Math.sqrt(Math.max(0, 1 - (c / A) ** 2));
    const pos = new Float32Array(NP * 3);
    const m0 = new Float32Array(NP), m1 = new Float32Array(NP), seed = new Float32Array(NP);
    for (let i = 0; i < NP; i++) {
      const u = -half + (2 * half * i) / (NP - 1);
      const x = horizontal ? u : c, y = horizontal ? c : CY + u;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      m0[i] = modeShape(x, y, false);
      m1[i] = modeShape(x, y, true);
      seed[i] = x * 9 + y * 7;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    racket.add(new THREE.Line(g, stringMat));
    strings.push({ g, pos, m0, m1, seed });
  };
  for (let i = 0; i < 20; i++) addString(false, -A + ((i + 1) * 2 * A) / 21);
  for (let i = 0; i < 23; i++) addString(true, CY - B + ((i + 1) * 2 * B) / 24);

  // Tap ripples across the string plane.
  const ripples = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64),
      new THREE.MeshBasicMaterial({ color: COLORS.mint, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(0, CY, 0.06);
    racket.add(m);
    return m;
  });

  /* ----- The wave: a ribbon behind the racket plus a soft glow copy ----- */
  const WN = 360, WX = 3.6;
  const ribbon = (halfWidth, opacity) => {
    const pos = new Float32Array(WN * 2 * 3);
    const idx = [];
    for (let i = 0; i < WN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(0, CY, -0.7);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { g, pos, mat, halfWidth };
  };
  const waveCore = ribbon(0.014, 0.95);
  const waveGlow = ribbon(0.075, 0.16);
  const ys = new Float32Array(WN);

  /* ----- State driven by app.js ----- */
  const now = () => performance.now() / 1000;
  let taps = []; // { t0, kind: 'pending' | 'ok' | 'overtone' | 'dud', k }
  let listening = false, listen = 0;
  let level = 0;
  let result = null, lock = 0;
  let lastActivity = performance.now();
  let running = false, visible = true, onScreen = true;
  let prevT = now();
  let insetTop = 0, insetBottom = 0; // screen covered by the top bar and the reading sheet
  let spinStart = -10, spinDir = 1; // a full turn when you switch racket

  const col = new THREE.Color(), tmp = new THREE.Color();

  // Fit the head in the open space between the top bar and the sheet, and
  // centre it there by shifting the view.
  function fitCamera() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const free = Math.max(160, h - insetTop - insetBottom);
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Pixels per scene unit at distance z is h / (2 z tan); fit 3.0 units of
    // height into the free space and 2.5 units of width across the screen.
    const z = Math.max((3.0 * h) / (2 * tan * free), (2.5 * h) / (2 * tan * w));
    camera.position.set(0, 0.45, z);
    camera.lookAt(0, 0.45, 0);
    const target = insetTop + free / 2;
    camera.setViewOffset(w, h, 0, h / 2 - target, w, h);
    camera.updateProjectionMatrix();
  }

  function frame() {
    const t = now();
    const dt = Math.min(0.1, t - prevT);
    prevT = t;

    // Ease listening and result lock towards their targets (jump when still).
    listen += ((listening ? 1 : 0) - listen) * (still ? 1 : Math.min(1, dt * 4));
    lock += ((result ? 1 : 0) - lock) * (still ? 1 : Math.min(1, dt * 2.5));
    const warn = result === 'warn';
    const finalColour = warn ? COLORS.amber : COLORS.accent;

    // Pose: idle sway, calmer while listening, square-on for a result.
    const sway = still ? 0.25 : 0.36 * Math.sin(t * (2 * Math.PI / 6));
    const settle = smoothstep(lock);
    const spinAge = (t - spinStart) / 0.7;
    const spin = still || spinAge >= 1 ? 0 : spinDir * 2 * Math.PI * Math.pow(1 - spinAge, 3);
    racket.rotation.y = sway * (1 - 0.6 * listen) * (1 - settle) + spin;
    racket.rotation.x = -0.08 * (1 - settle) + (still ? 0 : 0.04 * Math.sin(t * 0.9) * (1 - lock));
    racket.position.y = still ? 0 : 0.05 * Math.sin(t * 1.3);

    // Strings.
    taps = still ? [] : taps.filter(p => t - p.t0 < 3);
    let energy = 0, overEnergy = 0, dudEnergy = 0;
    for (const p of taps) {
      const age = t - p.t0;
      const e = Math.exp(-age / (p.kind === 'dud' ? 0.15 : 0.42));
      if (p.kind === 'overtone') overEnergy += e;
      else if (p.kind === 'dud') dudEnergy += e;
      else energy += e;
    }
    const shimmer = still ? 0 : (0.004 + Math.min(0.02, level * 0.4)) * listen * (1 - lock);
    for (const s of strings) {
      for (let i = 0; i < NP; i++) {
        let z = shimmer * Math.sin(t * 23 + s.seed[i]);
        for (const p of taps) {
          const age = t - p.t0;
          const decay = p.kind === 'dud' ? 0.12 : 0.42;
          const amp = 0.16 * Math.exp(-age / decay) * Math.sin(2 * Math.PI * 3.1 * age + 0.4);
          z += amp * (p.kind === 'overtone' ? s.m1[i] : s.m0[i]);
        }
        if (!still) z += 0.012 * lock * Math.sin(t * 5) * s.m0[i];
        s.pos[i * 3 + 2] = z;
      }
      s.g.attributes.position.needsUpdate = true;
    }

    col.copy(stringBase).lerp(tmp.setHex(COLORS.accent).multiplyScalar(0.8), listen * 0.45);
    col.lerp(tmp.setHex(COLORS.mint), Math.min(1, energy));
    col.lerp(tmp.setHex(COLORS.amber), Math.min(1, overEnergy * 1.4));
    col.lerp(tmp.setHex(finalColour), lock);
    stringMat.color.copy(col);
    bed.material.color.copy(col);
    bed.material.opacity = 0.03 + 0.12 * Math.min(1, energy + overEnergy) + 0.06 * lock;
    rim.color.setHex(warn && lock > 0.5 ? COLORS.amber : COLORS.accent);

    // Ripples: one per recent tap.
    const recent = taps.slice(-3);
    ripples.forEach((r, i) => {
      const p = recent[i];
      const age = p ? t - p.t0 : -1;
      if (age < 0 || age > 0.8) { r.material.opacity = 0; return; }
      const sc = 0.08 + (1 - Math.pow(1 - age / 0.8, 3)) * 1.05;
      r.scale.set(sc * A, sc * B, 1);
      r.material.opacity = 0.75 * (1 - age / 0.8);
      r.material.color.setHex(p.kind === 'overtone' ? COLORS.amber : p.kind === 'dud' ? COLORS.dud : COLORS.mint);
    });

    // Wave: room noise while listening, a burst per tap, a steady line when locked.
    let waveColour = COLORS.accent;
    if (overEnergy > energy && overEnergy > 0.05) waveColour = COLORS.amber;
    else if (dudEnergy > energy && dudEnergy > 0.05) waveColour = COLORS.dud;
    else if (warn && lock > 0.5) waveColour = COLORS.amber;
    waveCore.mat.color.setHex(waveColour);
    waveGlow.mat.color.setHex(waveColour);
    const noiseAmp = still ? 0 : listen * (1 - lock) * (0.02 + Math.min(0.08, level * 1.5));
    for (let i = 0; i < WN; i++) {
      const x = -WX + (2 * WX * i) / (WN - 1), ax = Math.abs(x);
      let y = noiseAmp * (Math.sin(x * 23 + t * 17) * 0.5 + Math.sin(x * 41 - t * 29) * 0.3 + Math.sin(x * 67 + t * 7) * 0.2);
      for (const p of taps) {
        const age = t - p.t0;
        const front = age * 3.0;
        if (ax > front) continue;
        const life = p.kind === 'overtone' ? 0.45 : p.kind === 'dud' ? 0.2 : 0.95;
        const k = p.kind === 'overtone' ? p.k * 1.59 : p.k;
        const env = Math.exp(-age / life) * Math.exp(-ax * 0.3) * (1 - Math.exp(-(front - ax) * 5));
        y += 0.42 * env * Math.sin(k * ax - 17 * age);
      }
      y += lock * 0.11 * Math.sin(10 * x - (still ? 0 : t * 4)) * Math.exp(-ax * 0.12);
      ys[i] = y;
    }
    for (const rb of [waveCore, waveGlow]) {
      for (let i = 0; i < WN; i++) {
        const x = -WX + (2 * WX * i) / (WN - 1);
        rb.pos[i * 6] = x; rb.pos[i * 6 + 1] = ys[i] + rb.halfWidth;
        rb.pos[i * 6 + 3] = x; rb.pos[i * 6 + 4] = ys[i] - rb.halfWidth;
      }
      rb.g.attributes.position.needsUpdate = true;
    }
    waveGlow.mat.opacity = 0.1 + 0.2 * Math.min(1, energy + overEnergy + lock * 0.5);

    renderer.render(scene, camera);

    // Keep drawing while something is moving; otherwise rest on a still frame.
    const busy = !still && (listening || taps.length || Math.abs(lock - (result ? 1 : 0)) > 0.01 ||
      t - spinStart < 0.8 || performance.now() - lastActivity < IDLE_STOP_MS);
    if (busy && visible && onScreen) requestAnimationFrame(frame);
    else running = false;
  }

  function wake() {
    lastActivity = performance.now();
    if (!running && visible && onScreen) {
      running = true;
      prevT = now();
      requestAnimationFrame(frame);
    }
  }

  new ResizeObserver(() => { fitCamera(); wake(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) wake(); });
  new IntersectionObserver(entries => {
    onScreen = entries[0].isIntersecting;
    if (onScreen) wake();
  }).observe(stage);
  stage.addEventListener('pointerdown', wake);
  fitCamera();
  wake();

  return {
    setListening(on) { listening = on; if (!on) level = 0; wake(); },
    setInsets(top, bottom) {
      if (Math.abs(top - insetTop) < 1 && Math.abs(bottom - insetBottom) < 1) return;
      insetTop = top; insetBottom = bottom;
      fitCamera();
      wake();
    },
    // Spin the racket a full turn, e.g. when switching racket (1 or -1).
    spin(dir) { spinStart = now(); spinDir = dir < 0 ? -1 : 1; wake(); },
    setLevel(rms) { level = rms; },
    // A tap landed: ring the strings now; classify() colours it once analysed.
    tap() { taps.push({ t0: now(), kind: 'pending', k: 10 }); wake(); },
    classify({ kind, freq }) {
      const p = [...taps].reverse().find(x => x.kind === 'pending');
      if (!p) return;
      p.kind = kind;
      if (freq) p.k = 10 * (freq / 1250); // higher pitch, tighter wave
      wake();
    },
    // 'ok', 'warn', or null while a new measurement is under way.
    setResult(kind) { if (kind !== result) { result = kind; wake(); } },
    reset() { taps = []; result = null; wake(); },
    // The racket's look: { head, frame, accent, shaft, grip, strings, finish }.
    setLook(look) {
      buildHead(look.head || 'isometric');
      const FINISH = { gloss: [0.28, 0.35], matte: [0.75, 0.1], metallic: [0.3, 0.85], pearl: [0.38, 0.5] };
      const [rough, metal] = FINISH[look.finish] || FINISH.gloss;
      frameMat.color.set(look.frame);
      frameMat.roughness = rough;
      frameMat.metalness = metal;
      accentMat.color.set(look.accent);
      accentMat.roughness = rough;
      accentMat.metalness = metal;
      shaftMat.color.set(look.shaft || '#8b9bb0');
      gripMat.color.set(look.grip);
      // Strings read best a little dimmer than their real colour on the dark stage.
      stringBase.set(look.strings).lerp(new THREE.Color(0x101b27), 0.35);
      wake();
    },
  };
}

const stage = document.getElementById('stage');
const canvas = document.getElementById('stageCanvas');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (stage && canvas && webglAvailable()) {
  try {
    const api = createScene(stage, canvas, reduceMotion);
    if (window.attachRacketScene) window.attachRacketScene(api);
  } catch (e) {
    /* the flat racket picture stays */
  }
}
