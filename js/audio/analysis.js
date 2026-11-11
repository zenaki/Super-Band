// Auto-chart: bikin chart dari audio apa saja.
// Alur: spectral flux -> onset -> estimasi tempo -> pilih onset per difficulty -> petakan ke lane.

import { createSong, ensureTrack, normalizeSong, RES_DEFAULT, DIFFS } from '../core/chart.js';
import { nextTick } from '../core/util.js';
import { assignLanes } from './songBuilder.js';

const FFT_N = 1024;

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// channels: array Float32Array; hasil: { env, centroid, energy, fps }
export async function analyze(channels, sampleRate, onProgress) {
  const dec = Math.max(1, Math.round(sampleRate / 22050));
  const sr = sampleRate / dec;
  const len = Math.floor(channels[0].length / dec);
  const mono = new Float32Array(len);
  for (const ch of channels) {
    for (let i = 0; i < len; i++) {
      let s = 0;
      const o = i * dec;
      for (let k = 0; k < dec; k++) s += ch[o + k];
      mono[i] += s / dec / channels.length;
    }
  }
  const hop = Math.round(sr * 0.01);
  const frames = Math.max(0, Math.floor((len - FFT_N) / hop));
  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  const half = FFT_N / 2;
  const binHz = sr / FFT_N;
  const bLow = Math.round(200 / binHz);
  const bHigh = Math.min(half - 1, Math.round(3200 / binHz));
  const logF = new Float32Array(half);
  for (let b = 1; b < half; b++) logF[b] = 12 * Math.log2(b * binHz);
  const env = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const bright = new Float32Array(frames); // pusat massa spektrum penuh, dipakai untuk drum
  const energy = new Float32Array(frames);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  let prev = new Float32Array(half);
  let cur = new Float32Array(half);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < FFT_N; i++) {
      re[i] = mono[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let low = 0;
    let mid = 0;
    let high = 0;
    let cSum = 0;
    let cW = 0;
    let en = 0;
    let bSum = 0;
    let bW = 0;
    for (let b = 1; b < half; b++) {
      const mag = Math.log1p(20 * Math.sqrt(re[b] * re[b] + im[b] * im[b]));
      cur[b] = mag;
      // bandingkan dengan maksimum tetangga di frame sebelumnya supaya vibrato tidak dianggap onset
      const ref = Math.max(prev[b], prev[b - 1], b + 1 < half ? prev[b + 1] : 0);
      const d = mag - ref;
      if (b >= bLow && b <= bHigh) en += mag;
      if (d > 0) {
        bSum += d * logF[b];
        bW += d;
        if (b < bLow) low += d;
        else if (b <= bHigh) {
          mid += d;
          cSum += d * logF[b];
          cW += d;
        } else high += d;
      }
    }
    env[f] = 0.7 * low + mid + 0.3 * high;
    centroid[f] = cW > 0 ? cSum / cW : 0;
    bright[f] = bW > 0 ? bSum / bW : 0;
    energy[f] = en;
    const tmp = prev;
    prev = cur;
    cur = tmp;
    if (f % 1500 === 0) {
      if (onProgress) onProgress((f / frames) * 0.85);
      await nextTick();
    }
  }
  return { env, centroid, bright, energy, fps: sr / hop, lead: FFT_N / 2 / sr, mono, sr, hop };
}


// ---------------------------------------------------------------------
// Estimasi nada di sebuah onset: FFT panjang tepat setelah onset, lalu harmonic summation.
// Hasilnya beberapa kandidat nada (MIDI) dengan skor, supaya pemanggil bisa memilih
// yang paling nyambung dengan nada sebelumnya.

const PITCH_N = 4096;
const PITCH_LO = 43; // G2
const PITCH_HI = 84; // C6
let pitchWin = null;
const pRe = new Float32Array(PITCH_N);
const pIm = new Float32Array(PITCH_N);
const pMag = new Float32Array(PITCH_N / 2);
const pPrev = new Float32Array(PITCH_N / 2);

function spectrumAt(mono, start, out) {
  if (!pitchWin) {
    pitchWin = new Float32Array(PITCH_N);
    for (let i = 0; i < PITCH_N; i++) pitchWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (PITCH_N - 1));
  }
  for (let i = 0; i < PITCH_N; i++) {
    const k = start + i;
    pRe[i] = k >= 0 && k < mono.length ? mono[k] * pitchWin[i] : 0;
    pIm[i] = 0;
  }
  fft(pRe, pIm);
  for (let b = 0; b < PITCH_N / 2; b++) out[b] = Math.sqrt(Math.sqrt(pRe[b] * pRe[b] + pIm[b] * pIm[b]));
}

const PT = { sub: 0.3, cont: 0.7, hdec: 0.95, lo: 36, delay: 0.015, k: 5 };
export function pitchCandidates(mono, sr, onsetSample, lo = PT.lo, hi = PITCH_HI) {
  // spektrum sesudah onset dikurangi sebagian spektrum sebelum onset:
  // yang tersisa didominasi nada yang baru masuk, bukan bass/pad yang masih menahan
  spectrumAt(mono, onsetSample + Math.round(sr * PT.delay), pMag);
  spectrumAt(mono, onsetSample - PITCH_N - Math.round(sr * 0.01), pPrev);
  const half = PITCH_N / 2;
  for (let b = 0; b < half; b++) pMag[b] = Math.max(0, pMag[b] - PT.sub * pPrev[b]);
  const binHz = sr / PITCH_N;
  const LO = lo;
  const steps = (hi - LO) * 4 + 1;
  const sal = new Float32Array(steps);
  for (let s = 0; s < steps; s++) {
    const f0 = 440 * Math.pow(2, (LO + s / 4 - 69) / 12);
    let sum = 0;
    let w = 1;
    for (let h = 1; h <= 6; h++) {
      const pos = (f0 * h) / binHz;
      const i0 = Math.floor(pos);
      if (i0 + 1 >= half) break;
      sum += (pMag[i0] + (pMag[i0 + 1] - pMag[i0]) * (pos - i0)) * w;
      w *= PT.hdec;
    }
    sal[s] = sum;
  }
  const peaks = [];
  for (let s = 1; s < steps - 1; s++) {
    if (sal[s] > sal[s - 1] && sal[s] >= sal[s + 1]) peaks.push({ pitch: LO + s / 4, score: sal[s] });
  }
  peaks.sort((a, b) => b.score - a.score);
  return peaks.slice(0, PT.k || 5);
}

// Pilih satu nada per onset dengan Viterbi: gabungan skor kandidat dan kelancaran kontur,
// supaya melodi tidak loncat oktaf atau pindah ke instrumen lain di tengah frase.
export function trackPitches(mono, sr, onsetSamples, lo, hi) {
  const n = onsetSamples.length;
  const out = new Float32Array(n);
  if (!n) return out;
  const cands = [];
  for (let i = 0; i < n; i++) {
    let c = pitchCandidates(mono, sr, onsetSamples[i], lo, hi);
    if (!c.length) c = [{ pitch: 60, score: 1 }];
    const top = c[0].score || 1;
    cands.push(c.map((x) => ({ pitch: x.pitch, local: x.score / top, cost: 0, back: -1 })));
  }
  for (const c of cands[0]) c.cost = -c.local;
  for (let i = 1; i < n; i++) {
    const gapSec = (onsetSamples[i] - onsetSamples[i - 1]) / sr;
    const w = gapSec > 1.5 ? 0 : PT.cont;
    for (const c of cands[i]) {
      let best = Infinity;
      let back = 0;
      cands[i - 1].forEach((p, k) => {
        const v = p.cost + w * Math.min(1, Math.abs(c.pitch - p.pitch) / 19);
        if (v < best) {
          best = v;
          back = k;
        }
      });
      c.cost = best - c.local;
      c.back = back;
    }
  }
  let k = 0;
  cands[n - 1].forEach((c, j) => {
    if (c.cost < cands[n - 1][k].cost) k = j;
  });
  for (let i = n - 1; i >= 0; i--) {
    out[i] = cands[i][k].pitch;
    k = cands[i][k].back;
  }
  return out;
}

export function estimateTempo(env, fps) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.max(0, env[i] - mean);
  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 60);
  const ac = new Float32Array(maxLag * 2 + 2);
  const span = Math.min(n, Math.floor(fps * 90));
  const start = Math.max(0, Math.floor((n - span) / 2));
  for (let lag = minLag; lag <= maxLag * 2 && lag < span; lag++) {
    let s = 0;
    for (let i = start; i + lag < start + span; i += 2) s += x[i] * x[i + lag];
    ac[lag] = s;
  }
  let best = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.55) ** 2);
    const score = (ac[lag] + 0.5 * ac[lag * 2]) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // perhalus puncak
  let lagF = best;
  if (best > minLag && best < maxLag) {
    const a = ac[best - 1];
    const b = ac[best];
    const c = ac[best + 1];
    const den = a - 2 * b + c;
    if (den < 0) lagF = best + (0.5 * (a - c)) / den;
  }
  // Perhalus tempo + fase: cari kombinasi yang beat-nya paling pas di sepanjang lagu.
  // Selisih 0.2% saja sudah bikin grid geser jauh di akhir lagu.
  const score = (lag, ph) => {
    let s = 0;
    for (let k = ph; k < n - 1; k += lag) {
      const i = Math.floor(k);
      s += x[i] + (x[i + 1] - x[i]) * (k - i);
    }
    return s;
  };
  let bestLag = lagF;
  let bestPhase = 0;
  let bestSum = -1;
  for (let pass = 0; pass < 2; pass++) {
    const center = bestLag;
    const range = pass === 0 ? 0.015 : 0.0015;
    const stepsLag = 30;
    for (let a = -stepsLag; a <= stepsLag; a++) {
      const lag = center * (1 + (range * a) / stepsLag);
      for (let ph = 0; ph < lag; ph += 1) {
        const sc = score(lag, ph);
        if (sc > bestSum) {
          bestSum = sc;
          bestLag = lag;
          bestPhase = ph;
        }
      }
    }
  }
  // fase lebih halus dari satu frame
  let finePhase = bestPhase;
  for (let d = -1; d <= 1; d += 0.1) {
    const ph = bestPhase + d;
    if (ph < 0) continue;
    const sc = score(bestLag, ph);
    if (sc > bestSum) {
      bestSum = sc;
      finePhase = ph;
    }
  }
  let bpm = (60 * fps) / bestLag;
  if (Math.abs(bpm - Math.round(bpm)) < 0.04) bpm = Math.round(bpm);
  return { bpm: Math.round(bpm * 1000) / 1000, phase: finePhase / fps };
}

export function pickOnsets(env, fps) {
  const n = env.length;
  const w = Math.round(fps * 0.12);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const global = prefix[n] / Math.max(1, n);
  const out = [];
  const minGap = Math.round(fps * 0.085);
  let last = -minGap;
  for (let i = 2; i < n - 2; i++) {
    const v = env[i];
    if (v < env[i - 1] || v < env[i + 1] || v < env[i - 2] || v <= env[i + 2]) continue;
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w);
    const local = (prefix[b] - prefix[a]) / (b - a);
    const thr = local * 1.35 + global * 0.22;
    if (v < thr) continue;
    if (i - last < minGap) {
      if (out.length && v > out[out.length - 1].strength * thr) {
        out[out.length - 1] = { frame: i, strength: v / thr };
        last = i;
      }
      continue;
    }
    out.push({ frame: i, strength: v / thr });
    last = i;
  }
  return out;
}

const GAPS = { easy: 0.42, medium: 0.26, hard: 0.17, expert: 0.1 };
const LANES = { easy: 3, medium: 4, hard: 5, expert: 5 };
const CHORD_RATE = { easy: 0, medium: 0.06, hard: 0.12, expert: 0.16 };

// Hasil: song model siap disimpan ke library.
// opts.stem: { signal, sampleRate, kind } hasil separate(). Tempo tetap dihitung dari lagu lengkap,
// sedangkan note dan lane diambil dari instrumen yang dipilih.
export async function autoChart(channels, sampleRate, meta = {}, onProgress, opts = {}) {
  const stem = opts.stem && opts.stem.kind !== 'all' ? opts.stem : null;
  const full = await analyze(channels, sampleRate, (v) => onProgress && onProgress(stem ? v * 0.5 : v));
  const { bpm, phase } = estimateTempo(full.env, full.fps);
  const an = stem ? await analyze([stem.signal], stem.sampleRate, (v) => onProgress && onProgress(0.5 + v * 0.5)) : full;
  const kind = stem ? stem.kind : 'all';
  const onsets = pickOnsets(an.env, an.fps);
  const res = RES_DEFAULT;
  const beatSec = 60 / bpm;
  const song = createSong({ title: meta.title || 'Untitled', artist: meta.artist || 'Unknown', charter: `Auto-chart (${kind})` });
  song.resolution = res;
  song.tempos = [{ tick: 0, bpm }];
  song.offset = phase + full.lead + 0.004;
  song.autoCharted = true;

  // nada tiap onset, dipakai untuk menentukan lane (nada tinggi = lane kanan)
  const onsetSamples = onsets.map((o) => Math.round((o.frame / an.fps + an.lead) * an.sr));
  let pitches;
  if (kind === 'drums') pitches = onsets.map((o) => an.bright[o.frame]); // kick di kiri, cymbal di kanan
  else if (kind === 'bass') pitches = trackPitches(an.mono, an.sr, onsetSamples, 28, 60);
  else if (kind === 'vocals') pitches = trackPitches(an.mono, an.sr, onsetSamples, 45, 84);
  else pitches = trackPitches(an.mono, an.sr, onsetSamples);
  onsets.forEach((o, i) => {
    o.pitch = pitches[i];
  });

  // waktu onset -> tick (dibulatkan ke 1/16 kalau memang dekat)
  const cand = [];
  for (const o of onsets) {
    const time = o.frame / an.fps + an.lead + 0.004;
    let beat = (time - song.offset) / beatSec;
    if (beat < 0) continue;
    const q = Math.round(beat * 4) / 4;
    const onGrid = Math.abs(q - beat) * beatSec < 0.035;
    if (onGrid) beat = q;
    const sub = Math.round(beat * 4) % 4;
    const weight = o.strength * (onGrid ? (sub === 0 ? 1.5 : sub === 2 ? 1.2 : 1) : 0.85);
    cand.push({ tick: Math.round(beat * res), time, frame: o.frame, pitch: o.pitch, strength: o.strength, weight });
  }

  const sp = [];
  const barTicks = res * 4;
  const lastTick = cand.length ? cand[cand.length - 1].tick : 0;
  for (let b = 2; (b + 2) * barTicks <= lastTick; b += 8) sp.push({ tick: b * barTicks, len: 2 * barTicks });

  for (const diff of DIFFS) {
    const gap = GAPS[diff];
    const order = cand.map((c, i) => i).sort((a, b) => cand[b].weight - cand[a].weight);
    const taken = [];
    const keep = new Uint8Array(cand.length);
    // bucket per detik supaya pengecekan jarak tetap cepat
    const buckets = new Map();
    for (const i of order) {
      const t = cand[i].time;
      const key = Math.floor(t);
      let ok = true;
      for (let k = key - 1; k <= key + 1 && ok; k++) {
        for (const other of buckets.get(k) || []) {
          if (Math.abs(other - t) < gap) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      keep[i] = 1;
      taken.push(i);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    const list = cand.filter((c, i) => keep[i]);
    if (!list.length) continue;
    const sorted = list.map((c) => c.strength).sort((a, b) => b - a);
    const chordCut = CHORD_RATE[diff] > 0 ? sorted[Math.floor(sorted.length * CHORD_RATE[diff])] : Infinity;
    const events = list.map((c, i) => {
      const next = list[i + 1];
      const room = next ? next.time - c.time : 2;
      let sustain = 0;
      if (room >= 0.7) {
        // tahan selama energi band tengah masih bertahan
        const base = an.energy[Math.min(an.energy.length - 1, c.frame + 4)];
        let f = c.frame + 4;
        const maxF = Math.min(an.energy.length, c.frame + Math.round((room - 0.18) * an.fps));
        while (f < maxF && an.energy[f] > base * 0.55) f++;
        const held = (f - c.frame) / an.fps;
        if (held >= 0.45) sustain = Math.round((held / beatSec) * res);
      }
      return {
        step: c.tick / (res / 4),
        tick: c.tick,
        pitch: c.pitch,
        gems: c.strength >= chordCut ? 2 : 1,
        wide: false,
        sustain,
      };
    });
    assignLanes(events, LANES[diff], 16);
    const tr = ensureTrack(song, 'guitar', diff);
    for (const e of events) {
      tr.notes.push({ tick: e.tick, fret: e.lane, len: e.sustain });
      if (e.gems === 2) tr.notes.push({ tick: e.tick, fret: e.lane + e.span, len: e.sustain });
    }
    tr.sp = sp.map((p) => ({ ...p }));
  }
  if (onProgress) onProgress(1);
  normalizeSong(song);
  song.detectedBpm = bpm;
  return song;
}
