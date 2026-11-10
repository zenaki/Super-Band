// Synth offline: semua suara lagu bawaan dibuat dari sini (tanpa file audio).
// Murni typed array, jadi bisa jalan di browser maupun Node (untuk test).

export const SR = 44100;
const TAU = Math.PI * 2;

const NOTE_INDEX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// 'e2' -> 40, 'f#3' -> 54, 'bb1' -> 34
export function parsePitch(str) {
  const m = /^([a-gA-G])([#b]?)(-?\d)$/.exec(str);
  if (!m) throw new Error(`Pitch tidak valid: "${str}"`);
  let n = NOTE_INDEX[m[1].toLowerCase()];
  if (m[2] === '#') n += 1;
  else if (m[2] === 'b') n -= 1;
  return n + (parseInt(m[3], 10) + 1) * 12;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------
// Filter biquad (RBJ cookbook)

export class Biquad {
  constructor(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  static lowpass(freq, q = 0.707, sr = SR) {
    const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  static highpass(freq, q = 0.707, sr = SR) {
    const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  static bandpass(freq, q = 1, sr = SR) {
    const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad(alpha, 0, -alpha, 1 + alpha, -2 * c, 1 - alpha);
  }

  static peaking(freq, q, gainDb, sr = SR) {
    const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    return new Biquad(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
  }

  process(buf, start = 0, end = buf.length) {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    // hindari denormal
    this.z1 = Math.abs(z1) < 1e-20 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-20 ? 0 : z2;
    return buf;
  }
}

// ---------------------------------------------------------------------
// Mixing helper

export function addMono(dst, src, offset, gain = 1) {
  const start = Math.max(0, offset);
  const end = Math.min(dst.length, offset + src.length);
  for (let i = start, j = start - offset; i < end; i++, j++) dst[i] += src[j] * gain;
}

// pan: -1 (kiri) .. 1 (kanan), equal power
export function addStereo(L, R, src, offset, gain = 1, pan = 0) {
  const a = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * gain;
  const gr = Math.sin(a) * gain;
  const start = Math.max(0, offset);
  const end = Math.min(L.length, offset + src.length);
  for (let i = start, j = start - offset; i < end; i++, j++) {
    const v = src[j];
    L[i] += v * gl;
    R[i] += v * gr;
  }
}

export function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] < 0 ? -buf[i] : buf[i];
    if (v > p) p = v;
  }
  return p;
}

export function rmsOf(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

// ---------------------------------------------------------------------
// Drum one-shot

function noiseBuffer(n, rng) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1;
  return out;
}

// Sumber "metal" ala drum machine: beberapa square inharmonic + noise
function metalBuffer(n, rng, base = 1) {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 9.2 * base);
  const out = new Float32Array(n);
  for (const f of freqs) {
    const inc = f / SR;
    let ph = rng();
    for (let i = 0; i < n; i++) {
      ph += inc;
      if (ph >= 1) ph -= 1;
      out[i] += ph < 0.5 ? 0.16 : -0.16;
    }
  }
  for (let i = 0; i < n; i++) out[i] += (rng() * 2 - 1) * 0.5;
  return out;
}

export function makeDrumKit(rng) {
  const kit = {};

  {
    const n = Math.floor(SR * 0.42);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = 47 + 135 * Math.exp(-t / 0.026);
      ph += (TAU * f) / SR;
      const amp = Math.exp(-t / 0.13) * Math.min(1, t / 0.0008);
      const click = t < 0.004 ? (rng() * 2 - 1) * (1 - t / 0.004) * 0.3 : 0;
      out[i] = Math.tanh((Math.sin(ph) * amp + click) * 1.7) * 0.95;
    }
    kit.kick = out;
  }

  {
    const n = Math.floor(SR * 0.32);
    const noise = noiseBuffer(n, rng);
    Biquad.highpass(1700, 0.7).process(noise);
    Biquad.lowpass(9500, 0.7).process(noise);
    const out = new Float32Array(n);
    let ph = 0;
    let ph2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = 178 + 70 * Math.exp(-t / 0.018);
      ph += (TAU * f) / SR;
      ph2 += (TAU * 331) / SR;
      const tone = (Math.sin(ph) + Math.sin(ph2) * 0.45) * Math.exp(-t / 0.065);
      const nz = noise[i] * Math.exp(-t / 0.085);
      out[i] = Math.tanh((tone * 0.55 + nz * 0.95) * 1.5) * 0.8;
    }
    kit.snare = out;
  }

  const hat = (decay, len, base) => {
    const n = Math.floor(SR * len);
    const src = metalBuffer(n, rng, base);
    Biquad.highpass(7200, 0.8).process(src);
    Biquad.highpass(6000, 0.7).process(src);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      src[i] *= Math.exp(-t / decay) * Math.min(1, t / 0.0005) * 0.9;
    }
    return src;
  };
  kit.hat = hat(0.024, 0.11, 1);
  kit.openHat = hat(0.17, 0.6, 1);

  {
    const n = Math.floor(SR * 2.0);
    const src = metalBuffer(n, rng, 0.82);
    Biquad.highpass(3800, 0.7).process(src);
    Biquad.peaking(6500, 0.8, 4).process(src);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      src[i] *= (0.65 * Math.exp(-t / 0.55) + 0.35 * Math.exp(-t / 0.12)) * Math.min(1, t / 0.001);
    }
    kit.crash = src;
  }

  {
    const n = Math.floor(SR * 0.7);
    const src = metalBuffer(n, rng, 1.15);
    Biquad.highpass(5600, 0.8).process(src);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (TAU * 3350) / SR;
      src[i] = src[i] * Math.exp(-t / 0.1) * 0.7 + Math.sin(ph) * Math.exp(-t / 0.22) * 0.16;
      src[i] *= Math.min(1, t / 0.0005);
    }
    kit.ride = src;
  }

  const tom = (f0) => {
    const n = Math.floor(SR * 0.45);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = f0 * (1 + 0.55 * Math.exp(-t / 0.035));
      ph += (TAU * f) / SR;
      const click = t < 0.003 ? (rng() * 2 - 1) * (1 - t / 0.003) * 0.35 : 0;
      out[i] = Math.tanh((Math.sin(ph) * Math.exp(-t / 0.15) + click) * 1.4) * 0.85 * Math.min(1, t / 0.0006);
    }
    return out;
  };
  kit.tom1 = tom(196);
  kit.tom2 = tom(147);
  kit.tom3 = tom(104);

  // gong: untuk aksen di awal bagian lagu
  {
    const n = Math.floor(SR * 3.2);
    const out = new Float32Array(n);
    const parts = [
      [73.4, 1, 1.5],
      [110.6, 0.45, 1.1],
      [147.6, 0.32, 0.9],
      [203.1, 0.2, 0.6],
      [287.3, 0.12, 0.4],
    ];
    for (const [f, a, d] of parts) {
      const inc = (TAU * f) / SR;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const wob = 1 + 0.12 * Math.sin(TAU * 1.7 * t);
        out[i] += Math.sin(inc * i) * a * wob * Math.exp(-t / d);
      }
    }
    for (let i = 0; i < n; i++) out[i] *= Math.min(1, i / (SR * 0.004)) * 0.6;
    kit.gong = out;
  }

  return kit;
}

// ---------------------------------------------------------------------
// Karplus-Strong: senar petik. Dipakai untuk gitar dan bass.
//
// opts: { amp, sustain (detik), damp (0..0.5), bright (0..1), pick (0..0.5), release (detik) }

export function pluck(out, start, freq, durSamples, rng, opts = {}) {
  const amp = opts.amp ?? 1;
  const damp = opts.damp ?? 0.3;
  const bright = opts.bright ?? 0.7;
  const pick = opts.pick ?? 0.18;
  const sustain = opts.sustain ?? 2.5;
  const release = Math.floor((opts.release ?? 0.045) * SR);

  const period = SR / freq;
  let N = Math.floor(period - damp - 0.2);
  if (N < 2) N = 2;
  const frac = period - damp - N; // 0.2 .. 1.2
  const C = (1 - frac) / (1 + frac);
  const g = Math.exp(-period / (SR * sustain));
  const gRel = Math.exp(-period / (SR * 0.018));

  const dl = new Float32Array(N);
  let v = 0;
  let mean = 0;
  for (let i = 0; i < N; i++) {
    v += bright * (rng() * 2 - 1 - v);
    dl[i] = v;
    mean += v;
  }
  mean /= N;
  for (let i = 0; i < N; i++) dl[i] -= mean;
  // posisi petik: comb filter melingkar
  const shift = Math.max(1, Math.round(pick * N));
  if (shift < N) {
    const tmp = new Float32Array(dl);
    for (let i = 0; i < N; i++) dl[i] = tmp[i] - 0.85 * tmp[(i + N - shift) % N];
  }
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(dl[i]));
  const norm = peak > 0 ? amp / peak : 0;
  for (let i = 0; i < N; i++) dl[i] *= norm;

  const total = Math.min(out.length - start, durSamples + release);
  let p = 0;
  let prevX = 0;
  let apX1 = 0;
  let apY1 = 0;
  const oneMinus = 1 - damp;
  for (let i = 0; i < total; i++) {
    const x = dl[p];
    const lp = oneMinus * x + damp * prevX;
    prevX = x;
    const ap = C * lp + apX1 - C * apY1;
    apX1 = lp;
    apY1 = ap;
    dl[p] = ap * (i < durSamples ? g : gRel);
    if (++p >= N) p = 0;
    if (start + i >= 0) out[start + i] += x;
  }
}

// ---------------------------------------------------------------------
// Instrumen sederhana lain

// Saw band-limited (polyBLEP) dengan lowpass + envelope. Untuk pad dan synth lead.
export function sawNote(out, start, freq, durSamples, opts = {}) {
  const amp = opts.amp ?? 0.3;
  const attack = Math.max(1, Math.floor((opts.attack ?? 0.01) * SR));
  const release = Math.max(1, Math.floor((opts.release ?? 0.08) * SR));
  const detune = opts.detune ?? 0.004;
  const cutoff = opts.cutoff ?? 1800;
  const pulse = opts.pulse ?? 0; // 0 = saw, >0 campur square
  const vibRate = opts.vibRate ?? 5.2;
  const vibDepth = opts.vibDepth ?? 0;
  const total = Math.min(out.length - start, durSamples + release);
  if (total <= 0) return;
  const voices = [freq * (1 - detune), freq * (1 + detune)];
  const phases = [0.13, 0.61];
  const lpA = 1 - Math.exp((-TAU * cutoff) / SR);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < total; i++) {
    let s = 0;
    const vib = vibDepth ? 1 + vibDepth * Math.sin((TAU * vibRate * i) / SR) * Math.min(1, i / (SR * 0.25)) : 1;
    for (let k = 0; k < 2; k++) {
      const inc = (voices[k] * vib) / SR;
      let ph = phases[k] + inc;
      if (ph >= 1) ph -= 1;
      phases[k] = ph;
      let saw = 2 * ph - 1;
      if (ph < inc) {
        const t = ph / inc;
        saw -= t + t - t * t - 1;
      } else if (ph > 1 - inc) {
        const t = (ph - 1) / inc;
        saw -= t * t + t + t + 1;
      }
      s += saw * (1 - pulse) + (ph < 0.5 ? 0.7 : -0.7) * pulse;
    }
    lp1 += lpA * (s * 0.5 - lp1);
    lp2 += lpA * (lp1 - lp2);
    let env = 1;
    if (i < attack) env = i / attack;
    if (i >= durSamples) env *= 1 - (i - durSamples) / release;
    out[start + i] += lp2 * env * amp;
  }
}

// Bilah logam (saron/bell): partial inharmonic dengan decay berbeda.
export function bellNote(out, start, freq, durSamples, opts = {}) {
  const amp = opts.amp ?? 0.3;
  const decay = opts.decay ?? 0.9;
  const total = Math.min(out.length - start, Math.floor(Math.max(durSamples, SR * decay * 2.2)));
  if (total <= 0) return;
  const parts = [
    [1, 1, 1],
    [2.76, 0.42, 0.55],
    [5.4, 0.2, 0.3],
    [8.93, 0.08, 0.16],
  ];
  for (const [ratio, a, d] of parts) {
    const f = freq * ratio;
    if (f > SR * 0.45) continue;
    const inc = (TAU * f) / SR;
    const tau = decay * d * SR;
    for (let i = 0; i < total; i++) {
      out[start + i] += Math.sin(inc * i) * a * amp * Math.exp(-i / tau) * Math.min(1, i / 40);
    }
  }
}

// Sub sine untuk mempertebal bass
export function subNote(out, start, freq, durSamples, amp = 0.4) {
  const release = Math.floor(0.03 * SR);
  const total = Math.min(out.length - start, durSamples + release);
  const inc = (TAU * freq) / SR;
  for (let i = 0; i < total; i++) {
    let env = Math.min(1, i / 200) * Math.exp(-i / (SR * 1.2));
    if (i >= durSamples) env *= 1 - (i - durSamples) / release;
    out[start + i] += Math.sin(inc * i) * env * amp;
  }
}

// ---------------------------------------------------------------------
// Efek

// Amp + cabinet sederhana untuk gitar distorsi. In-place.
export function ampSim(buf, opts = {}) {
  const drive = opts.drive ?? 12;
  const level = opts.level ?? 0.5;
  const bias = opts.bias ?? 0.12;
  const tone = opts.tone ?? 4300;
  const scoop = opts.scoop ?? -2;
  Biquad.highpass(opts.tight ?? 95, 0.7).process(buf);
  Biquad.peaking(850, 0.9, opts.mid ?? 5).process(buf);
  const off = Math.tanh(bias);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive + bias) - off;
  Biquad.lowpass(tone, 0.75).process(buf);
  Biquad.lowpass(tone * 1.25, 0.7).process(buf);
  if (scoop) Biquad.peaking(420, 1, scoop).process(buf);
  Biquad.peaking(2400, 1.2, opts.presence ?? 3).process(buf);
  Biquad.highpass(75, 0.7).process(buf);
  for (let i = 0; i < buf.length; i++) buf[i] *= level;
  return buf;
}

// Vibrato lewat delay termodulasi, in-place.
// segments: [{ from, to, depth }] terurut dan tidak tumpang tindih; depth dalam sample.
// Kedalaman naik pelan di awal segmen supaya terdengar seperti jari yang mulai goyang.
export function vibrato(buf, segments, rate = 5.4) {
  if (!segments.length) return buf;
  const HALF = 64;
  const SIZE = 256;
  const MASK = SIZE - 1;
  const ring = new Float32Array(SIZE);
  const w = (TAU * rate) / SR;
  const ramp = Math.floor(0.14 * SR);
  const n = buf.length;
  let seg = 0;
  for (let i = 0; i < n + HALF; i++) {
    ring[i & MASK] = i < n ? buf[i] : 0;
    const j = i - HALF; // posisi output; input sampai j + HALF sudah ada di ring
    if (j < 0) continue;
    while (seg < segments.length && segments[seg].to <= j) seg++;
    let d = 0;
    if (seg < segments.length && segments[seg].from <= j) {
      const sg = segments[seg];
      d = Math.min(1, (j - sg.from) / ramp, (sg.to - j) / 400) * sg.depth;
    }
    if (d <= 0) {
      buf[j] = ring[j & MASK];
      continue;
    }
    const pos = j - d * Math.sin(w * j);
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = i0 >= 0 ? ring[i0 & MASK] : 0;
    const b = i0 + 1 >= 0 ? ring[(i0 + 1) & MASK] : 0;
    buf[j] = a + (b - a) * f;
  }
  return buf;
}

// Feedback delay: hasil wet langsung ditambahkan ke outL/outR.
export function echoAdd(src, outL, outR, gain, pan, timeSec, feedback = 0.35, damp = 0.45) {
  const d = Math.max(1, Math.round(timeSec * SR));
  const ring = new Float32Array(d);
  const a = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * gain;
  const gr = Math.sin(a) * gain;
  let lp = 0;
  let p = 0;
  const n = src.length;
  for (let i = d; i < n; i++) {
    const fed = ring[p];
    lp += (1 - damp) * (fed - lp);
    const wet = src[i - d] + lp * feedback;
    ring[p] = wet;
    if (++p >= d) p = 0;
    outL[i] += wet * gl;
    outR[i] += wet * gr;
  }
}

// Reverb ringan (comb paralel + allpass seri). Input mono, wet ditambahkan ke outL/outR.
// tmp: buffer kerja sepanjang input (dipakai ulang oleh pemanggil supaya hemat memori).
export function reverbAdd(input, outL, outR, gain, tmp, opts = {}) {
  const room = opts.room ?? 0.82;
  const damp = opts.damp ?? 0.35;
  const n = input.length;
  const combLens = [1116, 1277, 1422, 1557, 1617];
  const apLens = [556, 341];
  const wet = tmp && tmp.length === n ? tmp : new Float32Array(n);
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch * 23;
    wet.fill(0);
    for (const len0 of combLens) {
      const len = len0 + spread;
      const line = new Float32Array(len);
      let p = 0;
      let store = 0;
      for (let i = 0; i < n; i++) {
        const y = line[p];
        store = y * (1 - damp) + store * damp;
        line[p] = input[i] + store * room;
        if (++p >= len) p = 0;
        wet[i] += y;
      }
    }
    for (const len0 of apLens) {
      const len = len0 + spread;
      const line = new Float32Array(len);
      let p = 0;
      for (let i = 0; i < n; i++) {
        const buffered = line[p];
        const x = wet[i];
        line[p] = x + buffered * 0.5;
        wet[i] = buffered - x;
        if (++p >= len) p = 0;
      }
    }
    const out = ch === 0 ? outL : outR;
    const g = gain * 0.2;
    for (let i = 0; i < n; i++) out[i] += wet[i] * g;
  }
}

// Soft clip: linear sampai knee, lalu melengkung menuju 1.
export function softClip(buf, knee = 0.6) {
  const span = 1 - knee;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const a = x < 0 ? -x : x;
    if (a > knee) {
      const y = knee + span * Math.tanh((a - knee) / span);
      buf[i] = x < 0 ? -y : y;
    }
  }
  return buf;
}

// Encode stereo float ke WAV 16-bit (dipakai tools & export).
export function encodeWav(L, R, sr = SR) {
  const n = L.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const wr = (o, s) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  wr(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  wr(36, 'data');
  dv.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    dv.setInt16(o, Math.round(l * 32767), true);
    dv.setInt16(o + 2, Math.round(r * 32767), true);
    o += 4;
  }
  return bytes;
}
