// Pemisah instrumen ringan (tanpa model AI), cukup cepat untuk HP.
//
// Idenya dari cara lagu biasanya di-mix:
//  - drum      : bunyi singkat (perkusif), energinya tidak bertahan dari frame ke frame
//  - bass      : bunyi bertahan di frekuensi rendah, posisi tengah
//  - vokal     : bunyi bertahan di frekuensi tengah, posisi tengah stereo
//  - gitar     : bunyi bertahan yang posisinya di kiri/kanan stereo
// Hasilnya bukan stem bersih, tapi cukup untuk menentukan note dari instrumen yang dipilih.

import { fft } from './analysis.js';
import { nextTick } from '../core/util.js';

export const STEMS = [
  ['all', 'Semua instrumen'],
  ['guitar', 'Gitar / melodi'],
  ['bass', 'Bass'],
  ['drums', 'Drum'],
  ['vocals', 'Vokal'],
];

const N = 1024;
const HOP = 512;
const HALF = N / 2;
const RING = 5; // frame yang dibandingkan untuk memisah bunyi bertahan vs singkat

function decimate(ch, dec) {
  const n = Math.floor(ch.length / dec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dec;
    for (let k = 0; k < dec; k++) s += ch[o + k];
    out[i] = s / dec;
  }
  return out;
}

const smooth = (x, lo, hi) => (x <= lo ? 0 : x >= hi ? 1 : (x - lo) / (hi - lo));

// channels: [L, R] atau [mono]. Hasil: { signal: Float32Array, sampleRate, mono: boolean }
export async function separate(channels, sampleRate, stem, onProgress, range) {
  const dec = Math.max(1, Math.round(sampleRate / 22050));
  const sr = sampleRate / dec;
  let L = channels[0];
  let R = channels[1] || channels[0];
  if (range) {
    const a = Math.max(0, Math.floor(range[0] * sampleRate));
    const b = Math.min(L.length, Math.floor(range[1] * sampleRate));
    L = L.subarray(a, b);
    R = R.subarray(a, b);
  }
  L = decimate(L, dec);
  R = channels[1] ? decimate(R, dec) : L;
  const n = L.length;
  const out = new Float32Array(n);
  if (stem === 'all') {
    for (let i = 0; i < n; i++) out[i] = (L[i] + R[i]) * 0.5;
    return { signal: out, sampleRate: sr, mono: !channels[1] };
  }

  // apakah file ini praktis mono?
  let eM = 0;
  let eS = 0;
  for (let i = 0; i < n; i += 7) {
    const m = L[i] + R[i];
    const s = L[i] - R[i];
    eM += m * m;
    eS += s * s;
  }
  const mono = eS < eM * 0.003;

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sin((Math.PI * (i + 0.5)) / N); // sqrt-Hann: analisis x sintesis = Hann
  const binHz = sr / N;
  const frames = Math.max(0, Math.floor((n - N) / HOP) + 1);
  const mk = () => Array.from({ length: RING }, () => new Float32Array(HALF + 1));
  const mRe = mk();
  const mIm = mk();
  const sRe = mk();
  const sIm = mk();
  const mMag = mk();
  const sMag = mk();
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const oRe = new Float32Array(N);
  const oIm = new Float32Array(N);
  // Jendela ke depan (frame ini + 4 berikutnya): awal note tetap tajam, jadi timing onset tidak geser.
  const mid = RING - 1;

  for (let f = 0; f < frames + mid; f++) {
    const slot = f % RING;
    if (f < frames) {
      const o = f * HOP;
      for (let i = 0; i < N; i++) {
        re[i] = (L[o + i] + R[o + i]) * 0.5 * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b <= HALF; b++) {
        mRe[slot][b] = re[b];
        mIm[slot][b] = im[b];
        mMag[slot][b] = Math.hypot(re[b], im[b]);
      }
      if (!mono) {
        for (let i = 0; i < N; i++) {
          re[i] = (L[o + i] - R[o + i]) * 0.5 * win[i];
          im[i] = 0;
        }
        fft(re, im);
        for (let b = 0; b <= HALF; b++) {
          sRe[slot][b] = re[b];
          sIm[slot][b] = im[b];
          sMag[slot][b] = Math.hypot(re[b], im[b]);
        }
      }
    } else {
      mMag[slot].fill(0);
      sMag[slot].fill(0);
    }
    const c = f - mid; // frame yang diproses sekarang
    if (c < 0) continue;
    const cs = c % RING;
    oRe.fill(0);
    oIm.fill(0);
    for (let b = 1; b < HALF; b++) {
      const hz = b * binHz;
      const mm = mMag[cs][b];
      const sm = mono ? 0 : sMag[cs][b];
      // bagian yang "bertahan": minimum dari frame ini sampai beberapa frame ke depan
      let hM = mm;
      let hS = sm;
      for (let k = 0; k < RING; k++) {
        if (mMag[k][b] < hM) hM = mMag[k][b];
        if (!mono && sMag[k][b] < hS) hS = sMag[k][b];
      }
      const fhM = mm > 1e-9 ? hM / mm : 0;
      const fhS = sm > 1e-9 ? hS / sm : 0;
      const side = hS / (hM + hS + 1e-9); // 0 = tengah, makin besar makin ke samping
      const center = 1 - smooth(side, 0.08, 0.3);
      let gM = 0;
      let gS = 0;
      if (stem === 'drums') {
        gM = Math.max(0, 1 - 1.4 * fhM);
        gS = Math.max(0, 1 - 1.4 * fhS) * 0.5;
      } else if (stem === 'bass') {
        gM = fhM * (1 - smooth(hz, 180, 300));
      } else if (stem === 'vocals') {
        gM = fhM * smooth(hz, 180, 320) * (1 - smooth(hz, 5000, 7000)) * (mono ? 1 : center);
      } else {
        // gitar / melodi
        const band = smooth(hz, 110, 220) * (1 - smooth(hz, 5000, 7000));
        if (mono) gM = fhM * band;
        else {
          gS = fhS * band;
          gM = fhM * band * (1 - center);
        }
      }
      if (gM === 0 && gS === 0) continue;
      const r = mRe[cs][b] * gM + sRe[cs][b] * gS;
      const i2 = mIm[cs][b] * gM + sIm[cs][b] * gS;
      oRe[b] = r;
      oIm[b] = i2;
      oRe[N - b] = r;
      oIm[N - b] = -i2;
    }
    // inverse FFT lewat tukar real/imaginer
    fft(oIm, oRe);
    const o = c * HOP;
    for (let i = 0; i < N; i++) out[o + i] += (oRe[i] / N) * win[i];
    if (f % 400 === 0) {
      if (onProgress) onProgress(f / frames);
      await nextTick();
    }
  }
  return { signal: out, sampleRate: sr, mono };
}
