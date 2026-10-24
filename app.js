'use strict';

/* ---------- Constants ---------- */

const LBS_PER_KG = 2.20462;
const GRAVITY = 9.80665;
// Badminton strings are mostly multifilament nylon.
const STRING_DENSITY = 1140; // kg/m^3
// An ideal membrane rings higher than a real racket: the frame flexes and the
// air the strings push around adds mass. 0.8 matches published tennis data;
// per-racket calibration corrects the rest.
const MEMBRANE_K = 0.8;
const BESSEL_J0_ZERO = 2.4048; // fundamental mode of a circular membrane

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
  };
}

function defaultState() {
  const r = newRacket('My racket');
  return {
    unit: 'lbs',
    activeId: r.id,
    settings: { fmin: 350, fmax: 2200, sensitivity: 6, taps: 3 },
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
function uncalibratedTensionKg(freq, r) {
  const radius = Math.sqrt((r.lengthMm / 1000) * (r.widthMm / 1000)) / 2;
  const mu = STRING_DENSITY * Math.PI * Math.pow(r.gaugeMm / 2000, 2);
  const waveSpeed = (2 * Math.PI * radius * freq) / (BESSEL_J0_ZERO * MEMBRANE_K);
  return (2 * mu * waveSpeed * waveSpeed) / GRAVITY;
}

function tensionKg(freq, r) {
  return uncalibratedTensionKg(freq, r) * r.cal;
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
  let best = 0;
  for (let k = lo; k <= hi; k++) {
    const m = Math.hypot(re[k], im[k]);
    mags[k - lo] = m;
    if (m > mags[best]) best = k - lo;
  }
  if (best === 0 || best === mags.length - 1) return null;

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
        for (let i = 0; i < length; i++) {
          samples[i] = this.ring[(this.pendingOnset + skip + i) % RING_SIZE];
        }
        this.pendingOnset = null;
        const { fmin, fmax } = state.settings;
        const result = analyzeTap(samples, this.sampleRate, fmin, fmax);
        if (result) this.onTap(result);
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
      this.pendingOnset = onset;
      this.lastOnset = onset;
      this.onOnset();
    } else if (sinceTap > this.sampleRate * 0.3) {
      // Track the room's background level so loud rooms don't false-trigger.
      this.noise += (peak - this.noise) * (peak > this.noise ? 0.01 : 0.05);
    }
  }
}

/* ---------- UI ---------- */

const $ = id => document.getElementById(id);
const els = {
  racketSelect: $('racketSelect'), tension: $('tensionValue'), unit: $('tensionUnit'),
  freq: $('freqValue'), loss: $('lossValue'), alert: $('alert'), status: $('status'),
  taps: $('tapDots'), listen: $('listenBtn'), save: $('saveBtn'), calibrate: $('calibrateBtn'),
  spectrum: $('spectrum'), level: $('level'), peak: $('peakLabel'),
  history: $('historyChart'), historyList: $('historyList'), historyNote: $('historyNote'),
};

let listener = null;
let tapFreqs = [];
let lastFreq = null;
let spectrumFrame = 0;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setStatus(text) {
  els.status.textContent = text;
}

function renderUnits() {
  document.querySelectorAll('[data-unit]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit));
  });
  document.querySelectorAll('.unitName').forEach(s => { s.textContent = state.unit; });
  els.unit.textContent = state.unit;
}

function renderRacketSelect() {
  els.racketSelect.innerHTML = '';
  for (const r of state.rackets) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.name;
    els.racketSelect.appendChild(o);
  }
  els.racketSelect.value = state.activeId;
}

function renderTapDots() {
  const n = state.settings.taps;
  els.taps.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    if (i < tapFreqs.length) d.className = 'on';
    els.taps.appendChild(d);
  }
}

function renderReading() {
  const r = activeRacket();
  const strung = `${fmt(r.strungKg)} ${state.unit}`;
  els.alert.hidden = true;
  els.alert.className = 'alert';
  if (lastFreq == null) {
    els.tension.textContent = '--';
    els.freq.textContent = '-- Hz';
    els.loss.textContent = `Strung at ${strung}`;
    els.save.disabled = true;
    els.calibrate.disabled = true;
    return;
  }
  const kg = tensionKg(lastFreq, r);
  els.tension.textContent = fmt(kg);
  els.freq.textContent = `${Math.round(lastFreq)} Hz`;
  const lossPct = ((r.strungKg - kg) / r.strungKg) * 100;
  els.loss.textContent = lossPct >= 0
    ? `${lossPct.toFixed(0)}% below ${strung}`
    : `${(-lossPct).toFixed(0)}% above ${strung}`;
  els.save.disabled = false;
  els.calibrate.disabled = false;

  if (lossPct >= r.alertPct) {
    els.alert.textContent = `Down ${lossPct.toFixed(0)}% from the strung tension. Time to restring.`;
    els.alert.classList.add('warn');
    els.alert.hidden = false;
  } else if (lossPct <= -15 && r.cal === 1) {
    els.alert.textContent = 'Reading is well above the strung tension. Check the head size and gauge, or calibrate this racket.';
    els.alert.classList.add('info');
    els.alert.hidden = false;
  }
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

  if (listener && listener.running) spectrumFrame = requestAnimationFrame(drawSpectrum);
}

function racketReadings(r) {
  return state.readings.filter(x => x.racketId === r.id).sort((a, b) => a.t - b.t);
}

function drawHistory() {
  const r = activeRacket();
  const items = racketReadings(r);
  const { ctx, w, h } = sizeCanvas(els.history, 170);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 36, r: 10, t: 10, b: 20 };
  const strung = toUnit(r.strungKg);
  const alertLine = strung * (1 - r.alertPct / 100);
  const values = items.map(x => toUnit(tensionKg(x.freq, r)));
  const minV = Math.min(alertLine, ...values) - 1;
  const maxV = Math.max(strung, ...values) + 1;
  const y = v => pad.t + (1 - (v - minV) / (maxV - minV)) * (h - pad.t - pad.b);
  const t0 = items.length ? items[0].t : Date.now();
  const t1 = items.length > 1 ? items[items.length - 1].t : t0 + 1;
  const x = t => items.length > 1 ? pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r) : (pad.l + w - pad.r) / 2;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--muted');
  ctx.textAlign = 'right';
  for (const v of [minV + 1, (minV + maxV) / 2, maxV - 1]) {
    ctx.fillText(v.toFixed(0), pad.l - 6, y(v) + 4);
  }

  const hline = (v, color, label) => {
    ctx.strokeStyle = color;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, pad.l + 4, y(v) - 4);
  };
  hline(strung, cssVar('--muted'), 'strung');
  hline(alertLine, cssVar('--warn'), 'restring');

  if (items.length) {
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    items.forEach((it, i) => {
      const px = x(it.t), py = y(values[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = cssVar('--accent');
    items.forEach((it, i) => {
      ctx.beginPath(); ctx.arc(x(it.t), y(values[i]), 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }

  if (r.strungDate) {
    const days = Math.floor((Date.now() - new Date(r.strungDate + 'T00:00').getTime()) / 86400000);
    els.historyNote.textContent = days >= 0 ? `Strung ${days === 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's') + ' ago'}` : '';
  } else {
    els.historyNote.textContent = '';
  }

  els.historyList.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No saved readings yet.';
    els.historyList.appendChild(li);
  }
  for (const it of [...items].reverse()) {
    const li = document.createElement('li');
    const when = new Date(it.t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const val = document.createElement('b');
    val.textContent = `${fmt(tensionKg(it.freq, r))} ${state.unit}`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${when} · ${Math.round(it.freq)} Hz`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost tiny';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete reading');
    del.onclick = () => {
      state.readings = state.readings.filter(x => x.id !== it.id);
      saveState();
      drawHistory();
    };
    li.append(val, meta, del);
    els.historyList.appendChild(li);
  }
}

function shortName(p) {
  return p.name.slice(p.brand.length + 1);
}

function renderRacketInfo() {
  const r = activeRacket();
  const m = racketPreset(r.model);
  const s = stringPreset(r.string);
  const model = m ? m.name : `Custom ${r.lengthMm}×${r.widthMm} mm head`;
  const string = s ? `${s.name} ${s.gaugeLabel}` : `${r.gaugeMm} mm string`;
  $('racketInfo').textContent = `${model} · ${string}${r.cal !== 1 ? ' · calibrated' : ''}`;
}

function renderAll() {
  renderUnits();
  renderRacketSelect();
  renderRacketInfo();
  renderTapDots();
  renderReading();
  drawSpectrum();
  drawHistory();
}

/* ---------- Taps ---------- */

function flashTap() {
  const card = els.tension.closest('.reading');
  card.classList.remove('hit');
  void card.offsetWidth; // restart the animation
  card.classList.add('hit');
}

// Every tap updates the reading straight away; the median of the set
// settles it, then the next tap starts a fresh set.
function handleTap({ freq, snrDb }) {
  if (snrDb < 8) {
    setStatus('Heard a tap but no clear ring. Flick the centre of the strings, not the frame.');
    return;
  }
  const need = state.settings.taps;
  if (tapFreqs.length >= need) tapFreqs = [];
  tapFreqs.push(freq);
  els.peak.textContent = `last tap ${Math.round(freq)} Hz`;
  lastFreq = median(tapFreqs);
  renderTapDots();
  renderReading();
  if (!listener || !listener.running) drawSpectrum();

  if (tapFreqs.length < need) {
    const left = need - tapFreqs.length;
    setStatus(`Tap ${tapFreqs.length} heard. ${left} more to confirm…`);
    return;
  }
  const spread = (Math.max(...tapFreqs) - Math.min(...tapFreqs)) / lastFreq;
  setStatus(spread > 0.06
    ? 'Taps were inconsistent, so this reading may be off. Keep tapping the centre to measure again.'
    : 'Reading confirmed. Save it, or tap again to start a new measurement.');
}

async function toggleListening() {
  if (listener && listener.running) {
    listener.stop();
    cancelAnimationFrame(spectrumFrame);
    els.listen.textContent = 'Start listening';
    els.listen.classList.remove('live');
    els.level.style.width = '0';
    setStatus(lastFreq != null ? 'Stopped. Your last reading is shown above.' : 'Stopped.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser can’t use the microphone here. Open the app over https in Safari or Chrome.');
    return;
  }
  tapFreqs = [];
  renderTapDots();
  listener = new TapListener(handleTap, rms => {
    els.level.style.width = Math.min(100, Math.sqrt(rms) * 250) + '%';
  }, flashTap);
  try {
    await listener.start();
  } catch (e) {
    setStatus(e && e.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser settings, then try again.'
      : 'Couldn’t start the microphone: ' + (e && e.message ? e.message : e));
    return;
  }
  els.listen.textContent = 'Stop';
  els.listen.classList.add('live');
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

racketForm.elements.model.addEventListener('change', () => {
  const f = racketForm.elements;
  const p = racketPreset(f.model.value);
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
  $('calInfo').textContent = r.cal === 1
    ? 'Not calibrated yet. Readings use the physics model only.'
    : `Calibrated: model × ${r.cal.toFixed(3)}.`;
  racketDialog.returnValue = '';
  racketDialog.showModal();
}

racketDialog.addEventListener('close', () => {
  if (racketDialog.returnValue !== 'save') return;
  const f = racketForm.elements;
  let r = editingId ? state.rackets.find(x => x.id === editingId) : null;
  if (!r) {
    r = newRacket('');
    state.rackets.push(r);
  }
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
  if (geometryChanged && editingId) r.cal = 1; // old calibration was for different geometry
  state.activeId = r.id;
  saveState();
  renderAll();
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

els.calibrate.onclick = () => {
  const r = activeRacket();
  $('calFreq').textContent = `${Math.round(lastFreq)} Hz`;
  calForm.elements.known.value = toUnit(r.strungKg).toFixed(1);
  calDialog.returnValue = '';
  calDialog.showModal();
};

calDialog.addEventListener('close', () => {
  if (calDialog.returnValue !== 'save' || lastFreq == null) return;
  const r = activeRacket();
  const knownKg = fromUnit(+calForm.elements.known.value);
  r.cal = knownKg / uncalibratedTensionKg(lastFreq, r);
  if (calForm.elements.resetDate.checked) {
    r.strungKg = knownKg;
    r.strungDate = today();
  }
  saveState();
  renderAll();
  setStatus(`Calibrated. This racket now reads ${fmt(knownKg)} ${state.unit} at ${Math.round(lastFreq)} Hz.`);
});

$('resetCal').onclick = () => {
  activeRacket().cal = 1;
  saveState();
  calDialog.close('reset');
  renderAll();
  setStatus('Calibration reset to the physics model.');
};

/* ---------- Wiring ---------- */

els.listen.onclick = toggleListening;

els.save.onclick = () => {
  if (lastFreq == null) return;
  state.readings.push({ id: uid(), racketId: state.activeId, t: Date.now(), freq: lastFreq });
  saveState();
  drawHistory();
  setStatus('Saved to history.');
};

els.racketSelect.onchange = () => {
  state.activeId = els.racketSelect.value;
  saveState();
  renderAll();
};

$('editRacket').onclick = () => openRacketDialog(activeRacket(), false);
$('addRacket').onclick = () => openRacketDialog(newRacket(`Racket ${state.rackets.length + 1}`), true);

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
    saveState();
    renderAll();
  };
}

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `baddy-tension-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

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
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderAll);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
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
  if (result) handleTap(result);
  return result;
};
