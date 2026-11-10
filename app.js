'use strict';

/* ---------- Constants ---------- */

const LBS_PER_KG = 2.20462;
const GRAVITY = 9.80665;
// Badminton strings are mostly multifilament nylon.
const STRING_DENSITY = 1140; // kg/m^3
// An ideal membrane rings higher than a real racket: the frame flexes and the
// air the strings push around adds mass. Fitted to a reference recording of one
// racket strung at 24, 26, 28 and 30 lbs (1177, 1237, 1316 and 1362 Hz).
const MEMBRANE_K = 0.88;
const BESSEL_J0_ZERO = 2.4048; // fundamental mode of a circular membrane
// An ideal membrane gives tension ~ pitch^2, but in the reference recording
// tension rose as pitch^1.47 (the frame gives a little more at higher tension).
// The physics sets the level at REF_FREQ; the fitted exponent sets the slope.
const REF_FREQ = 1200;
const TENSION_EXPONENT = 1.47;
// The (1,1) membrane mode rings ~1.59x the fundamental and is often as loud.
const OVERTONE_DB = 12;
const MODEL_VERSION = 2;
// Rings below this are voices or room noise, not strings. Real taps in the
// reference recording scored 29-47 dB; talking and bumps scored under 20.
const MIN_SNR_DB = 20;
// Taps whose tension spread is wider than this ask for another tap.
const MAX_SPREAD_KG = 0.7; // about 1.5 lbs
const EXTRA_TAPS = 2;
// Background peak level above which the room is too noisy to tap reliably.
const NOISY_LEVEL = 0.03;
const CLIP_LEVEL = 0.98;

const RING_SIZE = 1 << 16;
const FFT_SIZE = 1 << 15;
const CHUNK = 128; // onset detection resolution (~3 ms)
const STORE_KEY = 'baddy-tension-v1';

/* ---------- Racket and string presets ---------- */

// Manufacturers don't publish string-bed dimensions, so these are approximate
// inner string-bed sizes. Calibration corrects any difference.
const HEADS = {
  isometric: { lengthMm: 220, widthMm: 190, label: 'isometric head' },
  compact: { lengthMm: 214, widthMm: 184, label: 'compact head' },
  oval: { lengthMm: 226, widthMm: 186, label: 'oval head' },
};

const RACKET_PRESETS = [
  ['Yonex', 'isometric', [
    'Astrox 100ZZ', 'Astrox 99 Pro', 'Astrox 88D Pro', 'Astrox 88S Pro', 'Astrox 77 Pro',
    'Nanoflare 1000Z', 'Nanoflare 800 Pro', 'Nanoflare 700 Pro', 'Arcsaber 11 Pro', 'Arcsaber 7 Pro',
    'Duora Z-Strike', 'Voltric 80', 'Nanoray 900', 'Nanoray Z-Speed',
  ]],
  ['Yonex', 'compact', ['Voltric Z-Force II']],
  ['Victor', 'isometric', ['Thruster K Falcon', 'Thruster Ryuga', 'Auraspeed 90K', 'Jetspeed S 12']],
  ['Li-Ning', 'isometric', ['Axforce 80', 'Aeronaut 9000', 'Halbertec 8000', 'Bladex 900']],
].flatMap(([brand, head, models]) => models.map(model => ({
  id: slug(brand + ' ' + model), brand, name: `${brand} ${model}`, head,
})));

// Gauge in mm; hybrids list mains then crosses.
const STRING_PRESETS = [
  ['Yonex', [
    ['BG80', 0.68], ['BG80 Power', 0.68], ['BG65', 0.70], ['BG65 Ti', 0.70],
    ['BG66 Ultimax', 0.65], ['BG66 Force', 0.65], ['Exbolt 63', 0.63], ['Exbolt 65', 0.65],
    ['Exbolt 68', 0.68], ['Nanogy 95', 0.69], ['Nanogy 98', 0.66], ['Nanogy 99', 0.69],
    ['Aerosonic', 0.61], ['Skyarc', 0.61], ['Aerobite (hybrid)', 0.67, 0.61],
    ['Aerobite Boost (hybrid)', 0.72, 0.61],
  ]],
  ['Victor', [['VBS-63', 0.63], ['VBS-66 Nano', 0.66], ['VBS-68P', 0.68], ['VBS-70', 0.70]]],
  ['Li-Ning', [['No.1', 0.65], ['No.7', 0.65]]],
  ['Ashaway', [['Zymax 62 Fire', 0.62], ['Zymax 66 Fire', 0.66]]],
].flatMap(([brand, items]) => items.map(([model, mains, crosses]) => ({
  id: slug(brand + ' ' + model), brand, name: `${brand} ${model}`,
  // Mass per metre averages across mains and crosses, so use the RMS gauge.
  gaugeMm: crosses ? Math.sqrt((mains * mains + crosses * crosses) / 2) : mains,
  gaugeLabel: crosses ? `${mains.toFixed(2)}/${crosses.toFixed(2)} mm` : `${mains.toFixed(2)} mm`,
})));

// Each model's stock colourway as plain colours: frame, accent stripe, grip and
// finish. These approximate the colours only; brand logos and graphics aren't
// drawn. 'approx' marks colourways no retailer listing confirmed.
const COLOURWAYS = {
  'yonex-astrox-100zz': { name: 'Dark Navy', frame: '#1a2440', accent: '#c9a24a', finish: 'gloss' },
  'yonex-astrox-99-pro': { name: 'White Tiger', frame: '#e9e6df', accent: '#e2502b', finish: 'pearl' },
  'yonex-astrox-88d-pro': { name: 'Black/Silver', frame: '#17191d', accent: '#b9bec6', finish: 'metallic' },
  'yonex-astrox-88s-pro': { name: 'Silver/Black', frame: '#b9bec6', accent: '#17191d', finish: 'metallic' },
  'yonex-astrox-77-pro': { name: 'High Orange', frame: '#f26a1b', accent: '#1b1b1f', finish: 'gloss' },
  'yonex-nanoflare-1000z': { name: 'Lightning Yellow', frame: '#e9e12a', accent: '#1b1b1f', finish: 'gloss' },
  'yonex-nanoflare-800-pro': { name: 'Deep Green', frame: '#0f4a3a', accent: '#c9d3cf', finish: 'gloss' },
  'yonex-nanoflare-700-pro': { name: 'Midnight Purple', frame: '#33215a', accent: '#b9a6e0', finish: 'gloss' },
  'yonex-arcsaber-11-pro': { name: 'Grayish Pearl', frame: '#a7aaa9', accent: '#c8312f', finish: 'pearl' },
  'yonex-arcsaber-7-pro': { name: 'Gray/Yellow', frame: '#6c7074', accent: '#e6d43a', finish: 'matte' },
  'yonex-duora-z-strike': { name: 'Black/White', frame: '#16181c', accent: '#f0f0f0', finish: 'gloss' },
  'yonex-voltric-80': { name: 'Black/Red', frame: '#17181c', accent: '#b3202a', finish: 'gloss', approx: true },
  'yonex-nanoray-900': { name: 'White/High Red', frame: '#ecebe8', accent: '#e3262e', finish: 'gloss' },
  'yonex-nanoray-z-speed': { name: 'Lime/Navy', frame: '#c8de2a', accent: '#1f2d55', finish: 'gloss', approx: true },
  'yonex-voltric-z-force-ii': { name: 'Black/Lime', frame: '#141518', accent: '#9be22d', finish: 'gloss' },
  'victor-thruster-k-falcon': { name: 'Claret/Black', frame: '#6e1424', accent: '#141414', finish: 'gloss', approx: true },
  'victor-thruster-ryuga': { name: 'Flame Red', frame: '#b51f1f', accent: '#f08a24', finish: 'gloss' },
  'victor-auraspeed-90k': { name: 'Midnight Blue', frame: '#1b2a55', accent: '#8fb4ff', finish: 'metallic' },
  'victor-jetspeed-s-12': { name: 'Light Dahlia/Purple', frame: '#f07a6a', accent: '#5b3a8c', finish: 'gloss' },
  'li-ning-axforce-80': { name: 'Black/Gold', frame: '#141414', accent: '#c9a24a', finish: 'gloss' },
  'li-ning-aeronaut-9000': { name: 'White/Gold', frame: '#ecebe6', accent: '#c9a24a', finish: 'pearl' },
  'li-ning-halbertec-8000': { name: 'Pink/Blue', frame: '#f07aa8', accent: '#5fb7e6', finish: 'gloss' },
  'li-ning-bladex-900': { name: 'Moon Max Blue', frame: '#2d4f8c', accent: '#d6dde8', finish: 'metallic' },
};

// Ready-made looks for rackets that aren't listed, or for a different paint job.
const GENERIC_LOOKS = {
  graphite: { name: 'Graphite & green', frame: '#223244', accent: '#2fd59a', finish: 'gloss' },
  'red-black': { name: 'Red & black', frame: '#b3202a', accent: '#17181c', finish: 'gloss' },
  'navy-gold': { name: 'Navy & gold', frame: '#1a2440', accent: '#c9a24a', finish: 'gloss' },
  'white-green': { name: 'White & green', frame: '#ecebe8', accent: '#2fb36f', finish: 'pearl' },
  'black-orange': { name: 'Black & orange', frame: '#17181c', accent: '#f26a1b', finish: 'matte' },
  'silver-blue': { name: 'Silver & blue', frame: '#b9bec6', accent: '#2f6fd5', finish: 'metallic' },
};

const STRING_COLOURS = {
  White: '#f2f2ee', Yellow: '#f4e04d', Black: '#2a2d33', Orange: '#ff8a3d', Red: '#e0383e',
  Pink: '#f28ab8', Blue: '#4f8fe8', Lime: '#b4e64a', Purple: '#9a6fe0',
};

// The full look the 3D racket is drawn with.
function resolveLook(r, look = r.look || {}) {
  const m = racketPreset(r.model);
  const choice = look.colourway || 'model';
  let cw = null;
  if (choice === 'custom') cw = { frame: look.frame, accent: look.accent, finish: look.finish };
  else if (choice === 'model') cw = m && COLOURWAYS[m.id];
  else cw = GENERIC_LOOKS[choice];
  if (!cw || !cw.frame) cw = GENERIC_LOOKS.graphite;
  return {
    head: m ? m.head : 'isometric',
    frame: cw.frame, accent: cw.accent, finish: cw.finish || 'gloss',
    grip: look.grip || '#15171b',
    strings: look.strings || STRING_COLOURS.White,
  };
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function racketPreset(id) {
  return RACKET_PRESETS.find(p => p.id === id);
}

function stringPreset(id) {
  return STRING_PRESETS.find(p => p.id === id);
}

/* ---------- State ---------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function newRacket(name) {
  return {
    id: uid(), name,
    model: 'custom', string: 'yonex-bg80',
    lengthMm: 220, widthMm: 190, gaugeMm: 0.68,
    strungKg: 26 / LBS_PER_KG, strungDate: today(),
    alertPct: 10, cal: 1,
    stringings: [], // [{ date, kg }], one per restring
    calPrompt: false,
  };
}

function defaultState() {
  const r = newRacket('My racket');
  return {
    unit: 'lbs',
    activeId: r.id,
    // 600-1800 Hz covers roughly 10-45 lbs and keeps most overtones out.
    settings: { fmin: 600, fmax: 1800, sensitivity: 6, taps: 3 },
    modelVersion: MODEL_VERSION,
    historyView: 'current',
    rackets: [r],
    readings: [],
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.rackets) && s.rackets.length) {
      const d = defaultState();
      s.settings = Object.assign(d.settings, s.settings);
      s.readings = s.readings || [];
      if (!s.rackets.some(r => r.id === s.activeId)) s.activeId = s.rackets[0].id;
      s.historyView = s.historyView === 'all' ? 'all' : 'current';
      for (const r of s.rackets) {
        if (!Array.isArray(r.stringings)) {
          r.stringings = r.strungDate ? [{ date: r.strungDate, kg: r.strungKg }] : [];
        }
      }
      if ((s.modelVersion || 1) < MODEL_VERSION) {
        // The tension model changed, so old calibration factors no longer fit.
        // Saved readings keep their pitch and are simply re-converted.
        s.rackets.forEach(r => { r.cal = 1; });
        if (s.settings.fmin === 350 && s.settings.fmax === 2200) {
          const fresh = defaultState().settings;
          s.settings.fmin = fresh.fmin;
          s.settings.fmax = fresh.fmax;
        }
        s.modelVersion = MODEL_VERSION;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
      }
      return s;
    }
  } catch (e) { /* storage unavailable or corrupt */ }
  return defaultState();
}

let state = loadState();

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function activeRacket() {
  return state.rackets.find(r => r.id === state.activeId) || state.rackets[0];
}

/* ---------- Physics ---------- */

// Model the string bed as a membrane: strings at spacing d with tension T give
// membrane tension T/d per direction and areal density 2*mu/d, so the wave speed
// is sqrt(T / (2*mu)). The oval head is treated as a circle of equal area.
function membraneTensionKg(freq, r) {
  const radius = Math.sqrt((r.lengthMm / 1000) * (r.widthMm / 1000)) / 2;
  const mu = STRING_DENSITY * Math.PI * Math.pow(r.gaugeMm / 2000, 2);
  const waveSpeed = (2 * Math.PI * radius * freq) / (BESSEL_J0_ZERO * MEMBRANE_K);
  return (2 * mu * waveSpeed * waveSpeed) / GRAVITY;
}

function uncalibratedTensionKg(freq, r) {
  return membraneTensionKg(REF_FREQ, r) * Math.pow(freq / REF_FREQ, TENSION_EXPONENT);
}

/* ---------- Per-racket learning ---------- */

// Every calibration is saved as a point (pitch, known tension, string gauge).
// From those points the app fits this racket's own curve,
//   tension = gauge² · e^a · pitch^β,
// so it learns the racket's level and, once points cover different
// tensions, its slope too. Tension is stored per gauge², so a string change
// keeps the points useful.
const MAX_CAL_POINTS = 10;
// How strongly the general slope holds when points are close together. Worth
// about two points 4% apart in pitch (about 6% apart in tension).
const SLOPE_PRIOR = 2 * Math.pow(Math.log(1.04) / 2, 2);

function calPoints(r) {
  return Array.isArray(r.calPoints) ? r.calPoints : [];
}

function isCalibrated(r) {
  return calPoints(r).length > 0 || r.cal !== 1;
}

const fitCache = new WeakMap();
function racketFit(r) {
  const pts = calPoints(r);
  if (!pts.length) return null;
  const key = JSON.stringify(pts);
  const hit = fitCache.get(r);
  if (hit && hit.key === key) return hit.fit;
  const xs = pts.map(p => Math.log(p.freq));
  const ys = pts.map(p => Math.log(p.kg / (p.gauge * p.gauge)));
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i] - my); });
  // Least squares, pulled towards the general slope when the points are
  // too close together in pitch to say much about it.
  let beta = (sxy + SLOPE_PRIOR * TENSION_EXPONENT) / (sxx + SLOPE_PRIOR);
  beta = Math.min(2.2, Math.max(1.0, beta));
  const a = my - beta * mx;
  // How far the points sit from the curve (as a fraction of tension).
  let rss = 0;
  xs.forEach((x, i) => { rss += (ys[i] - a - beta * x) ** 2; });
  const spread = n >= 3 ? Math.sqrt(rss / (n - 2)) : null;
  const fit = { a, beta, n, spread };
  fitCache.set(r, { key, fit });
  return fit;
}

function tensionKg(freq, r) {
  const fit = racketFit(r);
  if (fit) return Math.exp(fit.a) * Math.pow(freq, fit.beta) * r.gaugeMm * r.gaugeMm;
  return uncalibratedTensionKg(freq, r) * r.cal; // r.cal: a single factor from older versions
}

function addCalPoint(r, freq, kg) {
  const pts = calPoints(r).slice();
  const date = today();
  // Calibrating twice the same day at the same tension refines, not doubles, that point.
  const same = pts.findIndex(p => p.date === date && Math.abs(p.kg - kg) < 0.1);
  if (same >= 0) pts.splice(same, 1);
  pts.push({ freq, kg, gauge: r.gaugeMm, date });
  r.calPoints = pts.slice(-MAX_CAL_POINTS);
  r.cal = 1;
}

function calSummary(r) {
  const fit = racketFit(r);
  if (!fit) {
    return r.cal === 1
      ? 'Not calibrated yet. Readings use the general model.'
      : `Calibrated in an older version (general model × ${r.cal.toFixed(3)}). Calibrate again to start learning this racket's curve.`;
  }
  if (fit.n === 1) return 'Learned from 1 calibration. Each time you calibrate, for example after a restring, the app refines this racket\u2019s curve.';
  const fitText = fit.spread != null
    ? ` The curve fits them within about ±${Math.max(0.1, toUnit(fit.spread * r.strungKg)).toFixed(1)} ${state.unit}.`
    : '';
  return `Learned from ${fit.n} calibrations.${fitText}`;
}

function toUnit(kg) {
  return state.unit === 'lbs' ? kg * LBS_PER_KG : kg;
}

function fromUnit(v) {
  return state.unit === 'lbs' ? v / LBS_PER_KG : v;
}

function fmt(kg) {
  return toUnit(kg).toFixed(1);
}

/* ---------- Signal processing ---------- */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

// Find the dominant ring frequency in a short burst of samples.
function analyzeTap(samples, sampleRate, fmin, fmax) {
  const n = Math.min(samples.length, FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < n; i++) {
    re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);

  const binHz = sampleRate / FFT_SIZE;
  const lo = Math.max(2, Math.floor(fmin / binHz));
  const hi = Math.min(FFT_SIZE / 2 - 2, Math.ceil(fmax / binHz));
  const mags = new Float64Array(hi - lo + 1);
  let loudest = 0;
  for (let k = lo; k <= hi; k++) {
    const m = Math.hypot(re[k], im[k]);
    mags[k - lo] = m;
    if (m > mags[loudest]) loudest = k - lo;
  }

  // Higher ring modes can be as loud as the fundamental, so take the lowest
  // clear peak (local max over +-30 Hz) within OVERTONE_DB of the loudest.
  const floor = mags[loudest] * Math.pow(10, -OVERTONE_DB / 20);
  const halfWidth = Math.max(1, Math.round(30 / binHz));
  let best = loudest;
  for (let i = 1; i < loudest; i++) {
    if (mags[i] < floor) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - halfWidth); j <= Math.min(mags.length - 1, i + halfWidth); j++) {
      if (mags[j] > mags[i]) { isPeak = false; break; }
    }
    if (isPeak) { best = i; break; }
  }
  if (best === 0 || best === mags.length - 1) return { freq: null, snrDb: 0 };

  // Parabolic interpolation on log magnitude for sub-bin precision.
  const a = Math.log(mags[best - 1] + 1e-12);
  const b = Math.log(mags[best] + 1e-12);
  const c = Math.log(mags[best + 1] + 1e-12);
  const offset = (0.5 * (a - c)) / (a - 2 * b + c || 1e-12);
  const freq = (lo + best + offset) * binHz;

  const sorted = Array.from(mags).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
  const snrDb = 20 * Math.log10(mags[best] / median);

  return { freq, snrDb };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------- Microphone + tap detection ---------- */

class TapListener {
  constructor(onTap, onLevel, onOnset) {
    this.onTap = onTap;
    this.onLevel = onLevel;
    this.onOnset = onOnset || (() => {});
    this.running = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.5;
    source.connect(this.analyser);

    this.proc = this.ctx.createScriptProcessor(512, 1, 1);
    source.connect(this.proc);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.proc.connect(mute);
    mute.connect(this.ctx.destination);

    this.reset(this.sampleRate);
    this.proc.onaudioprocess = e => this.process(e.inputBuffer.getChannelData(0));
    this.running = true;
  }

  reset(sampleRate) {
    this.sampleRate = sampleRate;
    this.ring = new Float32Array(RING_SIZE);
    this.written = 0;
    this.noise = 0.0005;
    this.armed = true;
    this.pendingOnset = null;
    this.lastOnset = -Infinity;
    this.warmupUntil = sampleRate * 0.25;
  }

  stop() {
    this.running = false;
    if (this.proc) this.proc.onaudioprocess = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) this.ctx.close();
  }

  process(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    this.onLevel(Math.sqrt(sum / block.length));
    for (let i = 0; i < block.length; i += CHUNK) this.processChunk(block.subarray(i, i + CHUNK));
  }

  // Work in ~3 ms chunks on peak level: a tap is a sharp spike that averaging
  // over a whole block would smear into the background.
  processChunk(chunk) {
    const start = this.written;
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      this.ring[(start + i) % RING_SIZE] = chunk[i];
      const a = Math.abs(chunk[i]);
      if (a > peak) peak = a;
    }
    this.written += chunk.length;

    // Waiting for enough of the ring after a detected tap.
    const skip = Math.round(this.sampleRate * 0.004); // step past the impact click
    const length = Math.round(this.sampleRate * 0.12);
    if (this.pendingOnset !== null) {
      if (this.written - this.pendingOnset >= skip + length) {
        const samples = new Float32Array(length);
        let tapPeak = 0;
        for (let i = 0; i < skip + length; i++) {
          const v = this.ring[(this.pendingOnset + i) % RING_SIZE];
          if (i >= skip) samples[i - skip] = v;
          if (Math.abs(v) > tapPeak) tapPeak = Math.abs(v);
        }
        this.pendingOnset = null;
        const { fmin, fmax } = state.settings;
        const result = analyzeTap(samples, this.sampleRate, fmin, fmax);
        // How loud the tap was against what triggered it, for coaching.
        result.loudness = tapPeak / this.trigger;
        result.clipped = tapPeak >= CLIP_LEVEL;
        this.onTap(result);
      }
      return;
    }

    // Sensitivity 10 triggers at 2x the background peak level, 1 at 12x.
    const ratio = 2 * Math.pow(6, (10 - state.settings.sensitivity) / 9);
    const threshold = Math.max(this.noise * ratio, 0.002);
    const sinceTap = start - this.lastOnset;

    // Re-arm once the previous ring has died away, so its tail can't
    // re-trigger but the next tap is caught as soon as it lands.
    if (peak < threshold * 0.6) this.armed = true;

    if (this.armed && peak > threshold && start > this.warmupUntil && sinceTap > this.sampleRate * 0.13) {
      let onset = start;
      for (let i = 0; i < chunk.length; i++) {
        if (Math.abs(chunk[i]) > threshold) { onset = start + i; break; }
      }
      this.armed = false;
      this.trigger = threshold;
      this.pendingOnset = onset;
      this.lastOnset = onset;
      this.onOnset();
    } else if (sinceTap > this.sampleRate * 0.3) {
      // Track the room's background level so loud rooms don't false-trigger.
      this.noise += (peak - this.noise) * (peak > this.noise ? 0.01 : 0.05);
    }
  }
}

/* ---------- Native app (Capacitor) ---------- */

// When packaged as a phone app, Capacitor's bridge is on window. Plugins are
// called straight through the bridge, so the web build needs no bundler.
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

function nativeCall(plugin, method, options = {}) {
  return window.Capacitor.nativePromise(plugin, method, options);
}

// Stop the screen sleeping while you tap, or the mic goes quiet mid-reading.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (NATIVE) {
      await nativeCall('KeepAwake', on ? 'keepAwake' : 'allowSleep');
    } else if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* not supported; harmless */ }
}

/* ---------- UI ---------- */

const $ = id => document.getElementById(id);
const els = {
  stage: $('stage'), bar: $('topBar'), sheet: $('sheet'), fallback: $('stageFallback'), toast: $('toast'),
  chip: $('racketChipText'), pill: $('pill'), drawer: $('racketDrawer'), racketList: $('racketList'), more: $('morePanel'),
  tension: $('tensionValue'), unit: $('tensionUnit'), actions: $('readingActions'),
  confidence: $('confidence'), calPrompt: $('calPrompt'), calPromptText: $('calPromptText'),
  freq: $('freqValue'), loss: $('lossValue'), alert: $('alert'), status: $('status'),
  taps: $('tapDots'), listen: $('listenBtn'), save: $('saveBtn'), calibrate: $('calibrateBtn'),
  spectrum: $('spectrum'), level: $('level'), peak: $('peakLabel'), peak2: $('peakLabel2'),
  history: $('historyChart'), historyList: $('historyList'), historyNote: $('historyNote'),
};
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let listener = null;
let tapFreqs = []; // every tap heard in the current measurement
let lastSet = []; // the taps behind the reading shown
let lastFreq = null;
let setDone = false; // the measurement finished; the next tap starts a new one
let readingSerial = 0; // counts confirmed readings, so Save knows what it saved
let savedSerial = -1;
let lastTapAt = 0;
let noiseTimer = 0;
let noisyWarned = false;
let spectrumFrame = 0;
let pillFlash = null; // a short-lived label, e.g. "Overtone skipped"
let scene3d = null; // the 3D racket view, when the device supports it

// scene3d.js loads after this file and calls this once its scene is ready.
window.attachRacketScene = api => {
  scene3d = api;
  els.fallback.hidden = true;
  if (listener && listener.running) api.setListening(true);
  api.setLook(resolveLook(activeRacket()));
  sendInsets();
  sceneResult();
};

// Tell the 3D view how much of the screen the top bar and sheet cover, so it
// centres the racket in the space between them.
function sendInsets() {
  if (!scene3d) return;
  const st = els.stage.getBoundingClientRect();
  scene3d.setInsets(els.bar.getBoundingClientRect().bottom - st.top, st.bottom - els.sheet.getBoundingClientRect().top);
}
new ResizeObserver(sendInsets).observe(els.sheet);

function setPeak(text) {
  els.peak.textContent = text;
  els.peak2.textContent = text;
}

// The status label at the top of the sheet: what the app is doing right now.
function renderPill() {
  const r = activeRacket();
  let text = 'Ready', kind = '';
  if (pillFlash && performance.now() < pillFlash.until) {
    ({ text, kind } = pillFlash);
  } else if (setDone && lastFreq != null) {
    const rough = (spreadKg(lastSet, r) || 0) * 2 > MAX_SPREAD_KG;
    const lossPct = ((r.strungKg - tensionKg(lastFreq, r)) / r.strungKg) * 100;
    if (rough) { text = 'Rough reading'; kind = 'warn'; }
    else if (lossPct >= r.alertPct) { text = 'Restring'; kind = 'warn'; }
    else { text = 'Confirmed'; kind = 'ok'; }
  } else if (tapFreqs.length) {
    text = tapFreqs.length >= state.settings.taps ? 'One more tap' : 'Calculating';
    kind = 'live';
  } else if (listener && listener.running) {
    text = 'Listening';
    kind = 'live';
  }
  els.pill.textContent = text;
  els.pill.className = `pill ${kind}`;
}

function flashPill(text, kind, ms = 2500) {
  pillFlash = { text, kind, until: performance.now() + ms };
  renderPill();
  setTimeout(renderPill, ms + 20);
}

function sceneResult() {
  if (!scene3d) return;
  const r = activeRacket();
  if (!setDone || lastFreq == null || (spreadKg(lastSet, r) || 0) * 2 > MAX_SPREAD_KG) {
    scene3d.setResult(null);
    return;
  }
  const lossPct = ((r.strungKg - tensionKg(lastFreq, r)) / r.strungKg) * 100;
  scene3d.setResult(lossPct >= r.alertPct ? 'warn' : 'ok');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// kind 'tip' marks coaching: something to change about the next tap.
function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.classList.toggle('tip', kind === 'tip');
}

let toastTimer = 0;
function toast(text) {
  els.toast.hidden = true;
  void els.toast.offsetWidth; // restart the fade
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1900);
}

function renderUnits() {
  document.querySelectorAll('[data-unit]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit));
  });
  document.querySelectorAll('.unitName').forEach(s => { s.textContent = state.unit; });
  els.unit.textContent = state.unit;
}

function renderTapDots() {
  // An empty extra dot means the taps disagreed and one more is needed.
  const need = state.settings.taps;
  const n = !setDone && tapFreqs.length >= need ? tapFreqs.length + 1 : need;
  els.taps.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    if (i < tapFreqs.length) d.className = 'on';
    els.taps.appendChild(d);
  }
}

// The big number rolls to each new value, as in the storyboard.
let shownValue = null, numberFrame = 0;
function setNumber(value) {
  cancelAnimationFrame(numberFrame);
  if (value == null) { shownValue = null; els.tension.textContent = '--'; return; }
  const from = shownValue;
  shownValue = value;
  if (from == null || REDUCED_MOTION || Math.abs(from - value) < 0.05) {
    els.tension.textContent = value.toFixed(1);
    return;
  }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / 450);
    els.tension.textContent = (from + (value - from) * (1 - Math.pow(1 - k, 3))).toFixed(1);
    if (k < 1) numberFrame = requestAnimationFrame(step);
  };
  numberFrame = requestAnimationFrame(step);
}

function renderReading() {
  renderPill();
  const r = activeRacket();
  const strung = `${fmt(r.strungKg)} ${state.unit}`;
  els.alert.hidden = true;
  els.alert.className = 'note';
  els.tension.className = 'num';
  els.calPrompt.hidden = !r.calPrompt;
  els.calPromptText.textContent = `Just restrung? Tap the centre ${state.settings.taps} time${state.settings.taps === 1 ? '' : 's'} and the app will calibrate this racket to ${strung}.`;
  if (lastFreq == null) {
    setNumber(null);
    els.freq.textContent = '-- Hz';
    els.loss.textContent = `Strung at ${strung}`;
    els.confidence.textContent = '';
    els.actions.hidden = true;
    sendInsets();
    return;
  }
  const kg = tensionKg(lastFreq, r);
  setNumber(toUnit(kg));
  renderConfidence(r);
  els.freq.textContent = `${Math.round(lastFreq)} Hz`;
  const lossPct = ((r.strungKg - kg) / r.strungKg) * 100;
  els.loss.textContent = lossPct >= 0
    ? `${lossPct.toFixed(0)}% below ${strung}`
    : `${(-lossPct).toFixed(0)}% above ${strung}`;
  els.actions.hidden = false;
  const saved = savedSerial === readingSerial;
  els.save.disabled = saved;
  els.save.textContent = saved ? 'Saved' : 'Save reading';
  const rough = (spreadKg(lastSet, r) || 0) * 2 > MAX_SPREAD_KG;
  if (setDone && !rough) els.tension.classList.add(lossPct >= r.alertPct ? 'warn' : 'ok');

  if (lossPct >= r.alertPct) {
    els.alert.textContent = `Down ${lossPct.toFixed(0)}%. Time to restring.`;
    els.alert.classList.add('warn');
    els.alert.hidden = false;
  } else if (lossPct <= -15 && !isCalibrated(r)) {
    els.alert.textContent = 'Reading is well above the strung tension. Check the racket and string, or calibrate this racket.';
    els.alert.classList.add('info');
    els.alert.hidden = false;
  }
  sendInsets();
}

function sizeCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  canvas.style.height = cssHeight + 'px';
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: cssHeight };
}

function drawSpectrum() {
  const { ctx, w, h } = sizeCanvas(els.spectrum, 150);
  ctx.clearRect(0, 0, w, h);
  const { fmin, fmax } = state.settings;
  const lo = Math.max(0, fmin * 0.6);
  const hi = fmax * 1.1;
  const x = f => ((f - lo) / (hi - lo)) * w;

  // Analysis band
  ctx.fillStyle = cssVar('--band');
  ctx.fillRect(x(fmin), 0, x(fmax) - x(fmin), h - 16);

  // Axis labels
  ctx.fillStyle = cssVar('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const step = hi - lo > 1500 ? 500 : 250;
  for (let f = Math.ceil(lo / step) * step; f <= hi; f += step) {
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x(f), h - 3);
  }

  if (listener && listener.running) {
    const a = listener.analyser;
    const data = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(data);
    const binHz = listener.sampleRate / a.fftSize;
    ctx.beginPath();
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1.5;
    let started = false;
    for (let k = Math.floor(lo / binHz); k <= Math.ceil(hi / binHz) && k < data.length; k++) {
      const db = Math.max(-110, Math.min(-20, data[k]));
      const y = (h - 16) * (1 - (db + 110) / 90);
      const px = x(k * binHz);
      if (!started) { ctx.moveTo(px, y); started = true; } else ctx.lineTo(px, y);
    }
    ctx.stroke();
  }

  if (lastFreq != null) {
    ctx.strokeStyle = cssVar('--peak');
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(lastFreq), 0);
    ctx.lineTo(x(lastFreq), h - 16);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (listener && listener.running && els.more.open) spectrumFrame = requestAnimationFrame(drawSpectrum);
}

function racketReadings(r) {
  return state.readings.filter(x => x.racketId === r.id).sort((a, b) => a.t - b.t);
}

/* ---------- Restrings and history ---------- */

const DAY_MS = 86400000;

function dayStart(date) {
  return new Date(date + 'T00:00').getTime();
}

function daysSince(date, t = Date.now()) {
  return Math.floor((t - dayStart(date)) / DAY_MS);
}

function agoText(date) {
  const d = daysSince(date);
  if (d < 0) return '';
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

// Keep one entry per stringing date, so the history can mark each restring.
function recordStringing(r, date, kg) {
  if (!date) return;
  const same = r.stringings.find(x => x.date === date);
  if (same) same.kg = kg;
  else r.stringings.push({ date, kg });
  r.stringings.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The stringing a moment in time belonged to (the latest one on or before it).
function stringingAt(r, t) {
  let found = null;
  for (const x of r.stringings) if (dayStart(x.date) <= t) found = x;
  return found || (r.strungDate ? { date: r.strungDate, kg: r.strungKg } : null);
}

function currentStringing(r) {
  return r.strungDate ? { date: r.strungDate, kg: r.strungKg } : null;
}

// Half the spread of the taps' tensions: the ± shown next to a reading.
function spreadKg(freqs, r) {
  if (!freqs || freqs.length < 2) return null;
  const t = freqs.map(f => tensionKg(f, r));
  return (Math.max(...t) - Math.min(...t)) / 2;
}

function pmText(freqs, r) {
  const pm = spreadKg(freqs, r);
  return pm == null ? '' : `±${Math.max(toUnit(pm), 0.1).toFixed(1)}`;
}

function shortDate(t) {
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function drawHistory() {
  const r = activeRacket();
  const view = state.historyView;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  const all = racketReadings(r);
  const cur = currentStringing(r);
  const since = cur ? dayStart(cur.date) : -Infinity;
  const items = view === 'current' ? all.filter(x => x.t >= since) : all;

  const { ctx, w, h } = sizeCanvas(els.history, 180);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 36, r: 10, t: 14, b: 22 };

  // Each stringing is a segment with its own strung and restring lines.
  const stringings = view === 'current'
    ? (cur ? [cur] : [])
    : (r.stringings.length ? r.stringings : (cur ? [cur] : []));
  let x0 = view === 'current' && cur ? since : Math.min(...stringings.map(x => dayStart(x.date)), ...items.map(x => x.t), Date.now());
  let x1 = Math.max(Date.now(), ...items.map(x => x.t));
  if (x1 - x0 < 7 * DAY_MS) x1 = x0 + 7 * DAY_MS;
  const segs = stringings.map((st, i) => ({
    st,
    from: Math.max(x0, dayStart(st.date)),
    to: i + 1 < stringings.length ? dayStart(stringings[i + 1].date) : x1,
  }));

  const values = items.map(x => toUnit(tensionKg(x.freq, r)));
  const lines = segs.flatMap(sg => [toUnit(sg.st.kg), toUnit(sg.st.kg) * (1 - r.alertPct / 100)]);
  const minV = Math.min(...lines, ...values, 99) - 1;
  const maxV = Math.max(...lines, ...values, 0) + 1;
  const y = v => pad.t + (1 - (v - minV) / (maxV - minV)) * (h - pad.t - pad.b);
  const x = t => pad.l + ((t - x0) / (x1 - x0)) * (w - pad.l - pad.r);

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--muted');
  ctx.textAlign = 'right';
  for (const v of [minV + 1, (minV + maxV) / 2, maxV - 1]) ctx.fillText(v.toFixed(0), pad.l - 6, y(v) + 4);

  // x-axis: days since restring, or dates for the full history.
  ctx.textAlign = 'center';
  if (view === 'current' && cur) {
    const span = (x1 - x0) / DAY_MS;
    const step = [1, 2, 7, 14, 30, 60, 90, 180].find(s => span / s <= 5) || 365;
    for (let d = 0; d <= span; d += step) ctx.fillText(d === 0 ? 'day 0' : String(d), x(x0 + d * DAY_MS), h - 5);
  } else {
    for (let i = 0; i <= 3; i++) ctx.fillText(shortDate(x0 + ((x1 - x0) * i) / 3), pad.l + 14 + ((w - pad.l - pad.r - 28) * i) / 3, h - 5);
  }

  const hline = (v, from, to, color, label) => {
    ctx.strokeStyle = color;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x(from), y(v)); ctx.lineTo(x(to), y(v)); ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(label, Math.min(x(from) + 4, w - pad.r - 50), y(v) - 4);
    }
  };
  segs.forEach((sg, i) => {
    const last = i === segs.length - 1;
    hline(toUnit(sg.st.kg), sg.from, sg.to, cssVar('--muted'), last ? 'strung' : '');
    hline(toUnit(sg.st.kg) * (1 - r.alertPct / 100), sg.from, sg.to, cssVar('--warn'), last ? 'restring' : '');
    if (view === 'all' && dayStart(sg.st.date) >= x0) {
      ctx.strokeStyle = cssVar('--line');
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(sg.from), pad.t - 6); ctx.lineTo(x(sg.from), h - pad.b); ctx.stroke();
      ctx.lineWidth = 1;
    }
  });

  if (items.length) {
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    let prevSeg = null;
    items.forEach((it, i) => {
      const seg = stringingAt(r, it.t);
      const px = x(it.t), py = y(values[i]);
      if (i === 0 || seg !== prevSeg) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      prevSeg = seg;
    });
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar('--accent');
    items.forEach((it, i) => { ctx.beginPath(); ctx.arc(x(it.t), y(values[i]), 3.5, 0, Math.PI * 2); ctx.fill(); });
  }

  els.historyNote.textContent = view === 'current'
    ? (cur ? `Strung ${agoText(cur.date)} at ${fmt(cur.kg)} ${state.unit}` : '')
    : `${all.length} reading${all.length === 1 ? '' : 's'} · ${Math.max(1, r.stringings.length)} stringing${r.stringings.length > 1 ? 's' : ''}`;

  els.historyList.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = all.length ? 'No readings since this restring yet.' : 'No saved readings yet.';
    els.historyList.appendChild(li);
  }
  let segShown = null;
  for (const it of [...items].reverse()) {
    const seg = stringingAt(r, it.t);
    if (view === 'all' && segShown && seg !== segShown) addRestringRow(segShown);
    segShown = seg;
    const li = document.createElement('li');
    const val = document.createElement('b');
    const pm = pmText(it.freqs, r);
    val.textContent = `${fmt(tensionKg(it.freq, r))}${pm ? ' ' + pm : ''} ${state.unit}`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    const when = new Date(it.t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const day = seg ? ` · day ${daysSince(seg.date, it.t)}` : '';
    meta.textContent = `${when}${day} · ${Math.round(it.freq)} Hz`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost tiny';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete reading');
    del.onclick = () => {
      state.readings = state.readings.filter(x => x.id !== it.id);
      saveState();
      drawHistory();
      renderRacketList();
    };
    li.append(val, meta, del);
    els.historyList.appendChild(li);
  }
  if (view === 'all' && segShown) addRestringRow(segShown);
}

function addRestringRow(st) {
  const li = document.createElement('li');
  li.className = 'restring';
  li.textContent = `Restrung at ${fmt(st.kg)} ${state.unit} · ${shortDate(dayStart(st.date))}`;
  els.historyList.appendChild(li);
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function historyCsv() {
  const u = state.unit;
  const rows = [['Racket', 'Date', 'Time', 'Days since restring', `Tension (${u})`, `Plus/minus (${u})`, 'Pitch (Hz)', `Strung at (${u})`, 'Below strung (%)']];
  for (const r of state.rackets) {
    for (const it of racketReadings(r)) {
      const st = stringingAt(r, it.t);
      const kg = tensionKg(it.freq, r);
      const d = new Date(it.t);
      const pm = spreadKg(it.freqs, r);
      rows.push([
        r.name,
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        d.toTimeString().slice(0, 5),
        st ? daysSince(st.date, it.t) : '',
        toUnit(kg).toFixed(1),
        pm == null ? '' : toUnit(pm).toFixed(1),
        Math.round(it.freq),
        st ? toUnit(st.kg).toFixed(1) : '',
        st ? (((st.kg - kg) / st.kg) * 100).toFixed(1) : '',
      ]);
    }
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

function shortName(p) {
  return p.name.slice(p.brand.length + 1);
}

/* ---------- Rackets: the name tag, the list, and swiping on the racket ---------- */

function stringShort(r) {
  const s = stringPreset(r.string);
  return s ? shortName(s) : `${r.gaugeMm} mm string`;
}

function racketSummary(r) {
  const m = racketPreset(r.model);
  return `${m ? shortName(m) : `${r.lengthMm}×${r.widthMm} mm head`} · ${stringShort(r)}`;
}

function renderChip() {
  const r = activeRacket();
  els.chip.textContent = `${r.name} · ${stringShort(r)}`;
}

function renderRacketList() {
  const box = els.racketList;
  box.innerHTML = '';
  for (const r of state.rackets) {
    const card = document.createElement('div');
    card.className = 'racket-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-current', String(r.id === state.activeId));
    const name = document.createElement('span');
    name.className = 'rc-name';
    const look = resolveLook(r);
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = `linear-gradient(135deg, ${look.frame} 55%, ${look.accent} 55%)`;
    name.append(swatch, r.name);
    const meta = document.createElement('span');
    meta.className = 'rc-meta';
    meta.textContent = racketSummary(r);
    const last = racketReadings(r).pop();
    const line = document.createElement('span');
    line.className = 'rc-last';
    if (last) {
      const v = document.createElement('b');
      v.textContent = `${fmt(tensionKg(last.freq, r))} ${state.unit}`;
      line.append(v, ` · ${shortDate(last.t)}`);
    } else {
      line.textContent = 'No readings yet';
    }
    const tags = document.createElement('span');
    tags.className = 'rc-meta';
    tags.textContent = `${r.strungDate ? `Strung ${agoText(r.strungDate)} · ` : ''}${calPoints(r).length > 1 ? `learned from ${calPoints(r).length} calibrations` : isCalibrated(r) ? 'calibrated' : 'not calibrated'}`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn edit';
    edit.textContent = 'Edit';
    edit.onclick = e => { e.stopPropagation(); openRacketDialog(r, false); };
    card.append(name, meta, line, tags, edit);
    const pick = () => {
      if (r.id !== state.activeId) {
        const from = state.rackets.findIndex(x => x.id === state.activeId);
        const to = state.rackets.indexOf(r);
        selectRacket(r.id, to > from ? 1 : -1);
      }
      els.drawer.close();
    };
    card.onclick = pick;
    card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    box.appendChild(card);
  }
}

function selectRacket(id, dir = 1) {
  state.activeId = id;
  tapFreqs = [];
  lastSet = [];
  lastFreq = null;
  setDone = false;
  setPeak('');
  if (scene3d) { scene3d.reset(); scene3d.spin(dir); }
  saveState();
  renderAll();
  setStatus(listener && listener.running ? `Measuring ${activeRacket().name}. Tap the centre of the strings.` : `Switched to ${activeRacket().name}.`);
}

function switchBy(step) {
  const n = state.rackets.length;
  if (n < 2) { toast('Add another racket to switch'); return; }
  const i = state.rackets.findIndex(r => r.id === state.activeId);
  const next = state.rackets[(i + step + n) % n];
  selectRacket(next.id, step);
  toast(next.name);
}

// Swipe left or right on the racket to switch; swipe up on the sheet for history.
function onSwipe(el, handler) {
  let sx = null, sy = 0, t0 = 0;
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input, select, a')) return;
    sx = e.clientX; sy = e.clientY; t0 = performance.now();
  });
  el.addEventListener('pointerup', e => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (performance.now() - t0 < 800) handler(dx, dy);
  });
  el.addEventListener('pointercancel', () => { sx = null; });
}
onSwipe(els.stage, (dx, dy) => {
  if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) switchBy(dx < 0 ? 1 : -1);
});
onSwipe(els.sheet, (dx, dy) => {
  if (dy < -40 && Math.abs(dy) > 1.5 * Math.abs(dx)) openMore();
});

function openMore() {
  if (els.more.open) return;
  els.more.showModal();
  drawHistory();
  drawSpectrum();
}

function renderAll() {
  if (scene3d) scene3d.setLook(resolveLook(activeRacket()));
  renderUnits();
  renderChip();
  renderRacketList();
  renderTapDots();
  renderReading();
  drawSpectrum();
  drawHistory();
}

/* ---------- Taps ---------- */

function flashTap() {
  const card = els.sheet;
  card.classList.remove('hit');
  void card.offsetWidth; // restart the animation
  card.classList.add('hit');
  if (scene3d) scene3d.tap();
}

// The n taps that agree best (the tightest run once sorted).
function bestCluster(freqs, n) {
  const sorted = [...freqs].sort((a, b) => a - b);
  let best = sorted.slice(0, n);
  for (let i = 1; i + n <= sorted.length; i++) {
    const c = sorted.slice(i, i + n);
    if (c[n - 1] - c[0] < best[n - 1] - best[0]) best = c;
  }
  return best;
}

function renderConfidence(r) {
  const need = state.settings.taps;
  els.confidence.className = 'confidence';
  if (!setDone) {
    els.confidence.textContent = tapFreqs.length >= need
      ? 'Taps disagree, so one more tap is needed'
      : `${tapFreqs.length} of ${need} taps`;
    if (tapFreqs.length >= need) els.confidence.classList.add('rough');
    return;
  }
  const pm = spreadKg(lastSet, r);
  if (pm == null) {
    els.confidence.textContent = 'Single tap';
    return;
  }
  const rough = pm * 2 > MAX_SPREAD_KG;
  els.confidence.textContent = `${pmText(lastSet, r)} ${state.unit} · ${rough ? 'taps vary, so treat this as rough' : `${lastSet.length} taps agree`}`;
  if (rough) els.confidence.classList.add('rough');
}

// Explain why a tap didn't count, so the next one does.
function coachFailedTap({ freq, loudness }) {
  if (freq == null) {
    setStatus('Heard a knock but no string ring. Flick the centre of the strings, not the frame.', 'tip');
  } else if (loudness != null && loudness < 2.5) {
    setStatus('Too quiet to read. Hold the phone 5–20 cm from the strings, or flick a little harder.', 'tip');
  } else {
    setStatus('That sounded like the frame or a knock, not the strings. Flick the centre of the strings.', 'tip');
  }
}

// Each tap updates the reading straight away. Once enough agree, the set is
// confirmed; if they disagree, the app asks for up to two more and keeps the
// taps that agree best. The next tap after that starts a new measurement.
function handleTap(result) {
  lastTapAt = performance.now();
  noisyWarned = false;
  const { freq, snrDb, clipped } = result;
  if (freq == null || snrDb < MIN_SNR_DB) {
    if (scene3d) scene3d.classify({ kind: 'dud' });
    coachFailedTap(result);
    return;
  }
  if (setDone) {
    tapFreqs = [];
    setDone = false;
    if (scene3d) scene3d.setResult(null);
  }
  // A tap that mostly rang the second mode reads ~1.5-1.7x the others.
  if (tapFreqs.length) {
    const ratio = freq / median(tapFreqs);
    if (ratio > 1.45 && ratio < 1.75) {
      if (scene3d) scene3d.classify({ kind: 'overtone', freq });
      flashPill('Overtone skipped', 'warn');
      setStatus('That tap rang an overtone, so it was skipped. Tap the exact centre again.', 'tip');
      return;
    }
    if (ratio > 1 / 1.75 && ratio < 1 / 1.45) tapFreqs = []; // earlier taps were the overtones
  }
  const r = activeRacket();
  const need = state.settings.taps;
  tapFreqs.push(freq);
  if (scene3d) scene3d.classify({ kind: 'ok', freq });
  lastSet = tapFreqs.length > need ? bestCluster(tapFreqs, need) : [...tapFreqs];
  lastFreq = median(lastSet);
  setPeak(`last tap ${Math.round(freq)} Hz`);
  const loud = clipped ? ' That was very loud, so hold the phone a little further away.' : '';

  if (tapFreqs.length < need) {
    renderTapDots();
    renderReading();
    if (!listener || !listener.running) drawSpectrum();
    const left = need - tapFreqs.length;
    setStatus(`Tap ${tapFreqs.length} heard. ${left} more to confirm…${loud}`, clipped ? 'tip' : '');
    return;
  }

  const range = need > 1 ? spreadKg(lastSet, r) * 2 : 0;
  if (range > MAX_SPREAD_KG && tapFreqs.length < need + EXTRA_TAPS) {
    renderTapDots();
    renderReading();
    const t = lastSet.map(f => tensionKg(f, r));
    setStatus(`Taps disagree (${fmt(Math.min(...t))}–${fmt(Math.max(...t))} ${state.unit}). Tap the exact centre once more.`, 'tip');
    return;
  }

  setDone = true;
  readingSerial++;
  renderTapDots();
  renderReading();
  sceneResult();
  if (!listener || !listener.running) drawSpectrum();
  if (range > MAX_SPREAD_KG) {
    setStatus('Your taps still vary, so this reading is rough. Tap exactly in the centre, the same way each time, and measure again.', 'tip');
    return;
  }
  setStatus(`Reading confirmed. Save it, or tap again to start a new measurement.${loud}`, clipped ? 'tip' : '');
  if (r.calPrompt) openCalDialog(true);
}

// While listening, warn once if the room is loud enough to spoil taps.
function checkNoise() {
  if (!listener || !listener.running) return;
  const quietFor = performance.now() - lastTapAt;
  if (listener.noise > NOISY_LEVEL && quietFor > 3000 && !noisyWarned) {
    noisyWarned = true;
    setStatus('It’s noisy here, so taps may be missed or misread. Find a quieter spot, or hold the phone closer to the strings.', 'tip');
  } else if (listener.noise < NOISY_LEVEL * 0.5 && noisyWarned && quietFor > 3000) {
    noisyWarned = false;
    setStatus('Quieter now. Tap the centre of the strings.');
  }
}

async function toggleListening() {
  if (listener && listener.running) {
    listener.stop();
    clearInterval(noiseTimer);
    if (scene3d) scene3d.setListening(false);
    keepAwake(false);
    cancelAnimationFrame(spectrumFrame);
    els.listen.textContent = 'Start listening';
    els.listen.classList.remove('live');
    els.level.style.width = '0';
    setStatus(lastFreq != null ? 'Stopped. Your last reading is shown above.' : 'Stopped.');
    renderPill();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(NATIVE
      ? 'This phone’s web view can’t use the microphone. Update Android System WebView (or iOS) and try again.'
      : 'This browser can’t use the microphone here. Open the app over https in Safari or Chrome.');
    return;
  }
  tapFreqs = [];
  setDone = false;
  noisyWarned = false;
  lastTapAt = performance.now();
  renderTapDots();
  listener = new TapListener(handleTap, rms => {
    els.level.style.width = Math.min(100, Math.sqrt(rms) * 250) + '%';
    if (scene3d) scene3d.setLevel(rms);
  }, flashTap);
  try {
    await listener.start();
  } catch (e) {
    setStatus(e && e.name === 'NotAllowedError'
      ? (NATIVE
        ? 'Microphone access was blocked. Allow it for Baddy Tension in your phone’s Settings → Apps → Permissions, then try again.'
        : 'Microphone access was blocked. Allow it in your browser settings, then try again.')
      : 'Couldn’t start the microphone: ' + (e && e.message ? e.message : e));
    return;
  }
  els.listen.textContent = 'Stop';
  els.listen.classList.add('live');
  keepAwake(true);
  noiseTimer = setInterval(checkNoise, 1000);
  if (scene3d) scene3d.setListening(true);
  renderPill();
  setStatus(`Listening… tap the centre of the strings ${state.settings.taps} time${state.settings.taps === 1 ? '' : 's'}.`);
  drawSpectrum();
}

/* ---------- Racket dialog ---------- */

const racketDialog = $('racketDialog');
const racketForm = $('racketForm');
let editingId = null;

function fillPresetSelect(select, presets, label) {
  select.innerHTML = '';
  const groups = {};
  for (const p of presets) {
    if (!groups[p.brand]) {
      groups[p.brand] = document.createElement('optgroup');
      groups[p.brand].label = p.brand;
      select.appendChild(groups[p.brand]);
    }
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = label(p);
    groups[p.brand].appendChild(o);
  }
  const other = document.createElement('option');
  other.value = 'custom';
  other.textContent = 'Other / not listed';
  select.appendChild(other);
}

fillPresetSelect(racketForm.elements.model, RACKET_PRESETS, shortName);
fillPresetSelect(racketForm.elements.string, STRING_PRESETS, p => `${shortName(p)} (${p.gaugeLabel})`);

/* ----- Look: colours for the 3D racket ----- */

function fillLookSelects() {
  const f = racketForm.elements;
  f.lookStrings.innerHTML = '';
  for (const [name, hex] of Object.entries(STRING_COLOURS)) {
    const o = document.createElement('option');
    o.value = hex;
    o.textContent = name;
    f.lookStrings.appendChild(o);
  }
}
fillLookSelects();

// The colourway list depends on the model picked: its stock colours come first.
function renderColourwayOptions(selected) {
  const f = racketForm.elements;
  const m = racketPreset(f.model.value);
  const cw = m && COLOURWAYS[m.id];
  f.lookColourway.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    f.lookColourway.appendChild(o);
  };
  if (cw) add('model', `Stock colours: ${cw.name}${cw.approx ? ' (approximate)' : ''}`);
  for (const [id, g] of Object.entries(GENERIC_LOOKS)) add(id, g.name);
  add('custom', 'Custom colours');
  f.lookColourway.value = [...f.lookColourway.options].some(o => o.value === selected) ? selected : (cw ? 'model' : 'graphite');
}

function formRacket() {
  const f = racketForm.elements;
  return { model: f.model.value };
}

function formLook() {
  const f = racketForm.elements;
  return {
    colourway: f.lookColourway.value,
    frame: f.lookFrame.value, accent: f.lookAccent.value, finish: f.lookFinish.value,
    grip: f.lookGrip.value, strings: f.lookStrings.value,
  };
}

// Show the chosen colourway's colours in the pickers, and preview it in 3D.
function syncLookInputs() {
  const f = racketForm.elements;
  const look = resolveLook(formRacket(), formLook());
  if (f.lookColourway.value !== 'custom') {
    f.lookFrame.value = look.frame;
    f.lookAccent.value = look.accent;
    f.lookFinish.value = look.finish;
  }
  previewLook();
}

function previewLook() {
  if (scene3d) scene3d.setLook(resolveLook(formRacket(), formLook()));
}

racketForm.elements.lookColourway.addEventListener('change', syncLookInputs);
for (const n of ['lookFrame', 'lookAccent', 'lookFinish']) {
  racketForm.elements[n].addEventListener('input', () => {
    racketForm.elements.lookColourway.value = 'custom'; // tweaking a colour makes it custom
    previewLook();
  });
}
for (const n of ['lookGrip', 'lookStrings']) racketForm.elements[n].addEventListener('input', previewLook);

racketForm.elements.model.addEventListener('change', () => {
  const f = racketForm.elements;
  const p = racketPreset(f.model.value);
  renderColourwayOptions(f.lookColourway.value === 'custom' ? 'custom' : 'model');
  syncLookInputs();
  if (!p) {
    $('sizeDetails').open = true;
    return;
  }
  f.lengthMm.value = HEADS[p.head].lengthMm;
  f.widthMm.value = HEADS[p.head].widthMm;
  if (f.name.dataset.auto === 'true' || !f.name.value.trim()) {
    f.name.value = shortName(p);
    f.name.dataset.auto = 'true';
  }
});

racketForm.elements.string.addEventListener('change', () => {
  const f = racketForm.elements;
  const p = stringPreset(f.string.value);
  if (p) f.gaugeMm.value = +p.gaugeMm.toFixed(3);
  else $('sizeDetails').open = true;
});

racketForm.elements.gaugeMm.addEventListener('input', () => {
  const f = racketForm.elements;
  const p = stringPreset(f.string.value);
  if (p && Math.abs(+f.gaugeMm.value - p.gaugeMm) > 0.001) f.string.value = 'custom';
});

racketForm.elements.name.addEventListener('input', () => {
  racketForm.elements.name.dataset.auto = 'false';
});

function openRacketDialog(r, isNew) {
  editingId = isNew ? null : r.id;
  $('racketDialogTitle').textContent = isNew ? 'New racket' : 'Edit racket';
  $('deleteRacket').hidden = isNew || state.rackets.length < 2;
  const f = racketForm.elements;
  const model = racketPreset(r.model);
  f.model.value = model ? model.id : 'custom';
  f.string.value = stringPreset(r.string) ? r.string : 'custom';
  $('sizeDetails').open = !model;
  f.name.value = r.name;
  f.name.dataset.auto = String(isNew || r.name === 'My racket' || (model && r.name === shortName(model)));
  f.lengthMm.value = r.lengthMm;
  f.widthMm.value = r.widthMm;
  f.gaugeMm.value = r.gaugeMm;
  f.strung.value = toUnit(r.strungKg).toFixed(1);
  f.strungDate.value = r.strungDate || '';
  f.alertPct.value = r.alertPct;
  $('calInfo').textContent = calSummary(r);
  const look = r.look || {};
  renderColourwayOptions(look.colourway || 'model');
  const resolved = resolveLook(r);
  f.lookFrame.value = resolved.frame;
  f.lookAccent.value = resolved.accent;
  f.lookFinish.value = resolved.finish;
  f.lookGrip.value = resolved.grip;
  f.lookStrings.value = Object.values(STRING_COLOURS).includes(resolved.strings) ? resolved.strings : STRING_COLOURS.White;
  previewLook();
  racketDialog.returnValue = '';
  racketDialog.showModal();
}

racketDialog.addEventListener('close', () => {
  // Undo the preview; renderAll below draws the saved look.
  if (scene3d) scene3d.setLook(resolveLook(activeRacket()));
  if (racketDialog.returnValue !== 'save') return;
  const f = racketForm.elements;
  let r = editingId ? state.rackets.find(x => x.id === editingId) : null;
  const isNew = !r;
  if (!r) {
    r = newRacket('');
    state.rackets.push(r);
  }
  const prevDate = r.strungDate, prevKg = r.strungKg;
  const prevLength = r.lengthMm, prevWidth = r.widthMm;
  const geometryChanged = r.lengthMm !== +f.lengthMm.value || r.widthMm !== +f.widthMm.value || r.gaugeMm !== +f.gaugeMm.value;
  r.name = f.name.value.trim() || 'Racket';
  r.model = f.model.value;
  r.string = f.string.value;
  r.lengthMm = +f.lengthMm.value;
  r.widthMm = +f.widthMm.value;
  r.gaugeMm = +f.gaugeMm.value;
  r.strungKg = fromUnit(+f.strung.value);
  r.strungDate = f.strungDate.value;
  r.alertPct = +f.alertPct.value;
  r.look = formLook();
  // A different head size makes old calibrations meaningless. A new string
  // gauge doesn't: the points are stored per gauge².
  const headChanged = r.lengthMm !== prevLength || r.widthMm !== prevWidth;
  if (headChanged && editingId) { r.cal = 1; r.calPoints = []; }
  const restrung = isNew || r.strungDate !== prevDate || Math.abs(r.strungKg - prevKg) > 0.05;
  if (restrung) recordStringing(r, r.strungDate, r.strungKg);
  // Strung today: the best moment to calibrate, so offer it.
  if (restrung && r.strungDate === today()) r.calPrompt = true;
  setStatus(r.calPrompt
    ? `${r.name} saved. Tap the centre ${state.settings.taps} times to calibrate it.`
    : `${r.name} saved.`);
  if (state.activeId !== r.id) {
    state.activeId = r.id;
    tapFreqs = []; lastSet = []; lastFreq = null; setDone = false;
    if (scene3d) { scene3d.reset(); scene3d.spin(1); }
  }
  saveState();
  renderAll();
  // A new racket goes straight to measuring.
  if (isNew && els.drawer.open) els.drawer.close();
});

$('deleteRacket').onclick = () => {
  const r = state.rackets.find(x => x.id === editingId);
  if (!r || !confirm(`Delete "${r.name}" and its ${racketReadings(r).length} saved readings?`)) return;
  state.rackets = state.rackets.filter(x => x.id !== r.id);
  state.readings = state.readings.filter(x => x.racketId !== r.id);
  state.activeId = state.rackets[0].id;
  saveState();
  racketDialog.close('deleted');
  renderAll();
};

/* ---------- Calibration dialog ---------- */

const calDialog = $('calDialog');
const calForm = $('calForm');

let calFromPrompt = false;

function openCalDialog(fromPrompt) {
  if (lastFreq == null || calDialog.open) return;
  const r = activeRacket();
  calFromPrompt = fromPrompt;
  $('calFreq').textContent = `${Math.round(lastFreq)} Hz`;
  calForm.elements.known.value = toUnit(r.strungKg).toFixed(1);
  calForm.elements.resetDate.checked = !fromPrompt || r.strungDate !== today();
  renderCalPoints();
  calDialog.returnValue = '';
  calDialog.showModal();
}

// The calibrations this racket has learned from, each removable.
function renderCalPoints() {
  const r = activeRacket();
  const list = $('calPoints');
  list.innerHTML = '';
  $('calLearned').textContent = calSummary(r);
  for (const p of [...calPoints(r)].reverse()) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.textContent = `${fmt(p.kg)} ${state.unit} at ${Math.round(p.freq)} Hz · ${shortDate(dayStart(p.date))}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn tiny';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove this calibration');
    del.onclick = () => {
      r.calPoints = calPoints(r).filter(x => x !== p);
      saveState();
      renderCalPoints();
      renderAll();
    };
    li.append(what, del);
    list.appendChild(li);
  }
  $('resetCal').hidden = !isCalibrated(r);
}

els.calibrate.onclick = () => openCalDialog(false);

calDialog.addEventListener('close', () => {
  const r = activeRacket();
  if (calDialog.returnValue !== 'save' || lastFreq == null) {
    if (calFromPrompt && calDialog.returnValue === 'cancel') {
      r.calPrompt = false;
      saveState();
      renderReading();
      setStatus('Skipped calibration. You can use Calibrate… any time.');
    }
    return;
  }
  const knownKg = fromUnit(+calForm.elements.known.value);
  addCalPoint(r, lastFreq, knownKg);
  r.calPrompt = false;
  if (calForm.elements.resetDate.checked) {
    r.strungKg = knownKg;
    r.strungDate = today();
    recordStringing(r, r.strungDate, r.strungKg);
  }
  saveState();
  renderAll();
  const n = calPoints(r).length;
  setStatus(`Calibrated. This racket now reads ${fmt(tensionKg(lastFreq, r))} ${state.unit} at ${Math.round(lastFreq)} Hz${n > 1 ? `, learned from ${n} calibrations` : ''}.`);
});

$('resetCal').onclick = () => {
  const r = activeRacket();
  r.cal = 1;
  r.calPoints = [];
  saveState();
  calDialog.close('reset');
  renderAll();
  setStatus('Calibration cleared. Readings use the general model again.');
};

/* ---------- Wiring ---------- */

els.listen.onclick = toggleListening;

els.save.onclick = () => {
  if (lastFreq == null) return;
  state.readings.push({ id: uid(), racketId: state.activeId, t: Date.now(), freq: lastFreq, freqs: [...lastSet] });
  savedSerial = readingSerial;
  saveState();
  drawHistory();
  renderRacketList();
  renderReading();
  setStatus('Saved to history. Swipe up to see it.');
};

$('racketChip').onclick = () => { renderRacketList(); els.drawer.showModal(); };
$('addRacket').onclick = () => openRacketDialog(newRacket(`Racket ${state.rackets.length + 1}`), true);
$('moreBtn').onclick = openMore;
$('grabber').onclick = openMore;
// Tapping the dimmed backdrop closes the racket list.
els.drawer.addEventListener('click', e => { if (e.target === els.drawer) els.drawer.close(); });

$('calPromptDismiss').onclick = () => {
  activeRacket().calPrompt = false;
  saveState();
  renderReading();
};

document.querySelectorAll('[data-view]').forEach(b => {
  b.onclick = () => { state.historyView = b.dataset.view; saveState(); drawHistory(); };
});

document.querySelectorAll('[data-unit]').forEach(b => {
  b.onclick = () => { state.unit = b.dataset.unit; saveState(); renderAll(); };
});

const settingInputs = { setFmin: 'fmin', setFmax: 'fmax', setSens: 'sensitivity', setTaps: 'taps' };
for (const [id, key] of Object.entries(settingInputs)) {
  const input = $(id);
  input.value = state.settings[key];
  input.onchange = () => {
    const v = +input.value;
    if (!Number.isFinite(v)) return;
    state.settings[key] = v;
    if (state.settings.fmax <= state.settings.fmin + 100) state.settings.fmax = state.settings.fmin + 100;
    $('setFmax').value = state.settings.fmax;
    tapFreqs = [];
    setDone = false;
    saveState();
    renderAll();
  };
}

async function saveFile(name, text, type, title) {
  if (NATIVE) {
    // App webviews can't download files, so save it and open the share sheet
    // (Drive, email, Files…).
    try {
      const { uri } = await nativeCall('Filesystem', 'writeFile', {
        path: name, data: text, directory: 'CACHE', encoding: 'utf8',
      });
      await nativeCall('Share', 'share', { title, files: [uri] });
    } catch (err) {
      if (!/cancel/i.test(String(err && err.message))) setStatus('Couldn’t export: ' + (err && err.message ? err.message : err));
    }
    return;
  }
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('exportBtn').onclick = () => saveFile(`baddy-tension-${today()}.json`, JSON.stringify(state, null, 2), 'application/json', 'Baddy Tension backup');
$('csvBtn').onclick = () => saveFile(`baddy-tension-history-${today()}.csv`, historyCsv(), 'text/csv', 'Baddy Tension history');

$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const s = JSON.parse(await file.text());
    if (!Array.isArray(s.rackets) || !s.rackets.length) throw new Error('no rackets');
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    state = loadState();
    renderAll();
    setStatus('Backup imported.');
  } catch (err) {
    setStatus('That file isn’t a Baddy Tension backup.');
  }
  e.target.value = '';
};

window.addEventListener('resize', () => { drawSpectrum(); drawHistory(); });
window.addEventListener('resize', sendInsets);

// The phone app ships its files inside the app, so it needs no offline cache.
if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  // When a new version takes over, reload once so the page isn't left on old files.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded || (listener && listener.running)) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
}

renderAll();

// Exposed for testing in the console: simulateTap(1100) feeds a synthetic ping
// through the same analysis path as a real tap.
window.simulateTap = (freq, sampleRate = 48000) => {
  const n = Math.round(sampleRate * 0.15);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    s[i] = 0.5 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * freq * t)
      + 0.15 * Math.exp(-t * 60) * Math.sin(2 * Math.PI * freq * 2.3 * t)
      + 0.01 * (Math.random() * 2 - 1);
  }
  const result = analyzeTap(s, sampleRate, state.settings.fmin, state.settings.fmax);
  result.loudness = 10;
  if (scene3d) scene3d.tap();
  handleTap(result);
  return result;
};
