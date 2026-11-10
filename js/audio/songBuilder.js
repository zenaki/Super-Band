// Mengubah definisi lagu bawaan (lihat js/songs/) menjadi:
//  1. chart 4 difficulty (buildSongModel) - cepat, tanpa audio
//  2. audio stem backing + guitar (renderSong) - dirender sekali lalu di-cache pemanggil
//
// Notasi part gitar/keys per bar: token "<nada>:<durasi step>", dipisah spasi.
//   e3:2        note tunggal E3 sepanjang 2 step (1 step = 1/16 not)
//   E2:4        huruf besar = power chord (root + kwint + oktaf)
//   [a2 e3 a3]:8  chord bebas
//   -:4         diam
//   akhiran: "." palm mute, "~" ditahan + vibrato (jadi sustain di chart), "^" aksen

import {
  SR,
  parsePitch,
  midiToFreq,
  Biquad,
  addMono,
  addStereo,
  rmsOf,
  peakOf,
  makeDrumKit,
  pluck,
  sawNote,
  bellNote,
  subNote,
  ampSim,
  vibrato,
  echoAdd,
  reverbAdd,
  softClip,
} from './synth.js';
import { createSong, ensureTrack, normalizeSong, RES_DEFAULT, DIFFS } from '../core/chart.js';
import { mulberry32, hashString, nextTick } from '../core/util.js';

const TOKEN_RE = /(\[[^\]]+\][.~^]*|[^\s:[\]]+):(\d+)/g;
const NOTE_RE = /^([A-Ga-g][#b]?-?\d)([.~^]*)$/;
const CHORD_RE = /^([A-G][#b]?)(m7|maj7|sus4|m|5|7)?$/;
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const CHORD_TONES = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  5: [0, 7, 12],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7],
};

function parseChordSymbol(sym) {
  const m = CHORD_RE.exec(sym);
  if (!m) throw new Error(`Chord tidak dikenal: "${sym}"`);
  let pc = PC[m[1][0]];
  if (m[1][1] === '#') pc += 1;
  else if (m[1][1] === 'b') pc -= 1;
  return { pc: (pc + 12) % 12, quality: m[2] || '', tones: CHORD_TONES[m[2] || ''] };
}

function tile(list, bars, what) {
  if (!list || !list.length) return new Array(bars).fill(null);
  if (list.length > bars) throw new Error(`${what}: ${list.length} bar, bagian ini cuma ${bars} bar`);
  const out = [];
  for (let i = 0; i < bars; i++) out.push(list[i % list.length]);
  return out;
}

function expandRiffs(list, riffs, what) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string' && item.startsWith('@')) {
      for (const name of item.split(/\s+/)) {
        const riff = riffs && riffs[name.slice(1)];
        if (riff === undefined) throw new Error(`${what}: riff "${name}" tidak ada`);
        if (Array.isArray(riff)) out.push(...riff);
        else out.push(riff);
      }
    } else out.push(item);
  }
  return out;
}

// Satu bar notasi -> daftar event (step relatif terhadap awal bar)
export function parseBar(str, stepsPerBar, where = 'bar') {
  const events = [];
  let step = 0;
  let matched = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(str))) {
    matched += m[0].length;
    const head = m[1];
    const dur = parseInt(m[2], 10);
    if (!(dur > 0)) throw new Error(`${where}: durasi tidak valid di "${m[0]}"`);
    if (head !== '-') {
      let pitches;
      let flags = '';
      let kind = 'note';
      if (head[0] === '[') {
        const close = head.indexOf(']');
        flags = head.slice(close + 1);
        pitches = head
          .slice(1, close)
          .trim()
          .split(/\s+/)
          .map((p) => parsePitch(p))
          .sort((a, b) => a - b);
        kind = 'chord';
      } else {
        const nm = NOTE_RE.exec(head);
        if (!nm) throw new Error(`${where}: token tidak dikenal "${m[0]}"`);
        flags = nm[2];
        const root = parsePitch(nm[1]);
        if (nm[1][0] >= 'A' && nm[1][0] <= 'G') {
          kind = 'power';
          pitches = [root, root + 7, root + 12];
        } else pitches = [root];
      }
      events.push({
        step,
        dur,
        kind,
        pitches,
        pitch: pitches[0],
        muted: flags.includes('.'),
        vib: flags.includes('~'),
        accent: flags.includes('^'),
      });
    }
    step += dur;
  }
  const leftover = str.replace(TOKEN_RE, '').trim();
  if (leftover) throw new Error(`${where}: sisa teks tidak terbaca "${leftover}"`);
  if (step !== stepsPerBar) throw new Error(`${where}: total ${step} step, seharusnya ${stepsPerBar} ("${str}")`);
  return events;
}

const parseCache = new Map();

export function parseSong(def) {
  if (parseCache.has(def.id)) return parseCache.get(def.id);
  const stepsPerBeat = def.stepsPerBeat || 4;
  const beatsPerBar = def.beatsPerBar || 4;
  const stepsPerBar = stepsPerBeat * beatsPerBar;
  const lowNote = def.lowNote || 40;
  const P = {
    stepsPerBeat,
    beatsPerBar,
    stepsPerBar,
    sections: [],
    guitar: [],
    bass: [],
    rhythm: [],
    pad: [],
    keys: [],
    drums: [],
    totalBars: 0,
  };

  const bassPitch = (pc) => {
    let m = 24 + pc;
    if (m < lowNote - 12) m += 12;
    return m;
  };
  const rhythmPitch = (pc) => {
    let m = 36 + pc;
    if (m < lowNote) m += 12;
    return m;
  };

  let bar = 0;
  for (const sec of def.sections) {
    const where = `${def.id}/${sec.name}`;
    const bars = sec.bars;
    const tone = sec.tone || 'crunch';
    P.sections.push({ name: sec.name, bar, bars, tone });

    // chord per bar -> segmen
    const chordBars = tile(sec.chords, bars, `${where} chords`);
    const segs = [];
    for (let b = 0; b < bars; b++) {
      const cell = chordBars[b];
      if (!cell) continue;
      const parts = cell.split('|');
      const len = stepsPerBar / parts.length;
      parts.forEach((sym, k) => {
        if (sym === '-' || sym === 'N') return;
        segs.push({ step: (bar + b) * stepsPerBar + Math.round(k * len), dur: Math.round(len), chord: parseChordSymbol(sym) });
      });
    }
    const chordAt = (step) => {
      let found = null;
      for (const s of segs) if (s.step <= step && step < s.step + s.dur) found = s;
      return found;
    };

    // gitar pemain
    const gBars = tile(expandRiffs(sec.guitar, def.riffs, `${where} guitar`), bars, `${where} guitar`);
    const secGuitar = [];
    for (let b = 0; b < bars; b++) {
      if (!gBars[b]) continue;
      for (const ev of parseBar(gBars[b], stepsPerBar, `${where} guitar bar ${b + 1}`)) {
        const e = { ...ev, step: (bar + b) * stepsPerBar + ev.step, tone };
        secGuitar.push(e);
        P.guitar.push(e);
      }
    }

    // keys / melodi pengiring
    const kBars = tile(expandRiffs(sec.keys, def.riffs, `${where} keys`), bars, `${where} keys`);
    for (let b = 0; b < bars; b++) {
      if (!kBars[b]) continue;
      for (const ev of parseBar(kBars[b], stepsPerBar, `${where} keys bar ${b + 1}`)) {
        P.keys.push({ ...ev, step: (bar + b) * stepsPerBar + ev.step, tone: sec.keysTone || def.keysTone || 'bell' });
      }
    }

    // bass
    const bassStyle = sec.bass || 'none';
    if (bassStyle === 'follow') {
      for (const ev of secGuitar) {
        P.bass.push({ step: ev.step, dur: ev.dur, midi: bassPitch(ev.pitch % 12), gate: ev.muted ? 0.5 : 0.9 });
      }
    } else if (bassStyle !== 'none') {
      for (let b = 0; b < bars; b++) {
        const base = (bar + b) * stepsPerBar;
        const push = (off, dur, up = 0, gate = 0.85) => {
          const c = chordAt(base + off);
          if (c) P.bass.push({ step: base + off, dur, midi: bassPitch(c.chord.pc) + up, gate });
        };
        if (bassStyle === 'whole') {
          for (const s of segs) if (s.step >= base && s.step < base + stepsPerBar) push(s.step - base, s.dur, 0, 0.95);
        } else if (bassStyle === 'quarter') {
          for (let s = 0; s < stepsPerBar; s += stepsPerBeat) push(s, stepsPerBeat, 0, 0.8);
        } else if (bassStyle === 'eighth' || bassStyle === 'octave') {
          const half = stepsPerBeat / 2;
          for (let s = 0, k = 0; s < stepsPerBar; s += half, k++) push(s, half, bassStyle === 'octave' && k % 2 ? 12 : 0, 0.8);
        } else if (bassStyle === 'gallop') {
          for (let s = 0; s < stepsPerBar; s += stepsPerBeat) {
            push(s, 2, 0, 0.8);
            push(s + 2, 1, 0, 0.7);
            push(s + 3, 1, 0, 0.7);
          }
        } else throw new Error(`${where}: bass style "${bassStyle}" tidak dikenal`);
      }
    }

    // rhythm guitar pengiring (tidak masuk chart)
    const rStyle = sec.rhythm || 'none';
    if (rStyle === 'double') {
      for (const ev of secGuitar) P.rhythm.push({ ...ev });
    } else if (rStyle !== 'none') {
      const power = (step, dur, muted, accent) => {
        const c = chordAt(step);
        if (!c) return;
        const root = rhythmPitch(c.chord.pc);
        P.rhythm.push({ step, dur, kind: 'power', pitches: [root, root + 7, root + 12], pitch: root, muted, vib: false, accent });
      };
      for (let b = 0; b < bars; b++) {
        const base = (bar + b) * stepsPerBar;
        if (rStyle === 'whole') {
          for (const s of segs) if (s.step >= base && s.step < base + stepsPerBar) power(s.step, s.dur, false, true);
        } else if (rStyle === 'half') {
          for (let s = 0; s < stepsPerBar; s += stepsPerBeat * 2) power(base + s, stepsPerBeat * 2, false, false);
        } else if (rStyle === 'eighth') {
          const half = stepsPerBeat / 2;
          for (let s = 0; s < stepsPerBar; s += half) power(base + s, half, false, s % stepsPerBeat === 0);
        } else if (rStyle === 'chug') {
          const half = stepsPerBeat / 2;
          for (let s = 0; s < stepsPerBar; s += half) {
            const open = s === 0 || s === 6 || s === 12;
            power(base + s, half, !open, open);
          }
        } else throw new Error(`${where}: rhythm style "${rStyle}" tidak dikenal`);
      }
    }

    // pad
    if (sec.pad) {
      for (const s of segs) {
        let root = 48 + s.chord.pc;
        if (root > 55) root -= 12;
        P.pad.push({ step: s.step, dur: s.dur, pitches: s.chord.tones.map((t) => root + t) });
      }
    }

    // drum
    const dList = Array.isArray(sec.drums) ? sec.drums : sec.drums ? [sec.drums] : [];
    const dBars = tile(dList, bars, `${where} drums`);
    if (sec.fill && bars > 0) dBars[bars - 1] = sec.fill;
    for (let b = 0; b < bars; b++) {
      const name = dBars[b];
      if (!name) continue;
      const pat = def.patterns && def.patterns[name];
      if (!pat) throw new Error(`${where}: pattern drum "${name}" tidak ada`);
      for (const row of Object.keys(pat)) {
        const inst = DRUM_ROWS[row];
        if (!inst) throw new Error(`${where}: baris drum "${row}" tidak dikenal`);
        const line = pat[row];
        if (line.length !== stepsPerBar) throw new Error(`${where}: pattern "${name}.${row}" harus ${stepsPerBar} karakter`);
        for (let s = 0; s < stepsPerBar; s++) {
          const ch = line[s];
          if (ch === '.') continue;
          const vel = ch === 'X' ? 1 : ch === 'o' ? 0.45 : 0.78;
          P.drums.push({ step: (bar + b) * stepsPerBar + s, inst, vel });
        }
      }
    }
    if (sec.crash) P.drums.push({ step: bar * stepsPerBar, inst: 'crash', vel: 0.9 });
    if (sec.gong) P.drums.push({ step: bar * stepsPerBar, inst: 'gong', vel: 1 });

    bar += bars;
  }
  P.totalBars = bar;
  P.guitar.sort((a, b) => a.step - b.step);
  parseCache.set(def.id, P);
  return P;
}

const DRUM_ROWS = {
  k: 'kick',
  s: 'snare',
  h: 'hat',
  O: 'openHat',
  r: 'ride',
  c: 'crash',
  1: 'tom1',
  2: 'tom2',
  3: 'tom3',
  g: 'gong',
};

// ---------------------------------------------------------------------
// Chart

const LANE_COUNT = { easy: 3, medium: 4, hard: 5, expert: 5 };
const MIN_GAP = { easy: 0.4, medium: 0.21, hard: 0.15, expert: 0 };

function metricWeight(step, stepsPerBar, stepsPerBeat) {
  const s = step % stepsPerBar;
  if (s === 0) return 5;
  if (s % (stepsPerBeat * 2) === 0) return 4;
  if (s % stepsPerBeat === 0) return 3;
  if ((s * 2) % stepsPerBeat === 0) return 2;
  return 1;
}

function chartEvents(P) {
  const out = [];
  for (const ev of P.guitar) {
    let gems = 1;
    if (ev.kind === 'power') gems = ev.muted ? 1 : 2;
    else if (ev.kind === 'chord') gems = ev.pitches.length >= 4 ? 3 : 2;
    const long = !ev.muted && (ev.vib ? ev.dur >= 3 : ev.dur >= 6);
    out.push({
      step: ev.step,
      dur: ev.dur,
      pitch: ev.pitch,
      gems,
      wide: ev.kind === 'chord' && gems === 2,
      sustain: long ? ev.dur - 1 : 0,
      weight:
        metricWeight(ev.step, P.stepsPerBar, P.stepsPerBeat) + (ev.accent ? 1 : 0) + (long ? 1.5 : 0) + (gems > 1 ? 0.5 : 0),
    });
  }
  return out;
}

function thin(events, diff, stepSec, P) {
  if (diff === 'expert') return events.map((e) => ({ ...e }));
  const gap = MIN_GAP[diff] / stepSec - 1e-6; // dalam step
  const order = events.map((e, i) => i).sort((a, b) => events[b].weight - events[a].weight || events[a].step - events[b].step);
  const keep = new Uint8Array(events.length);
  const taken = [];
  for (const i of order) {
    const s = events[i].step;
    let ok = true;
    for (const t of taken) {
      if (Math.abs(t - s) < gap) {
        ok = false;
        break;
      }
    }
    if (ok) {
      keep[i] = 1;
      taken.push(s);
    }
  }
  let list = events.filter((e, i) => keep[i]).map((e) => ({ ...e }));

  if (diff === 'medium') {
    // kurangi not di ketukan "dan" kalau kiri-kanannya rapat, kecuali menjelang ketukan 1 dan 3
    const near = 0.3 / stepSec;
    list = list.filter((e, i) => {
      if (e.weight > 2.4) return true;
      const prev = list[i - 1];
      const next = list[i + 1];
      const crowded = prev && next && e.step - prev.step < near && next.step - e.step < near;
      if (!crowded) return true;
      return e.step % (P.stepsPerBeat * 2) === P.stepsPerBeat * 2 - P.stepsPerBeat / 2;
    });
  }

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (diff === 'easy') {
      e.gems = 1;
    } else if (diff === 'medium') {
      e.gems = e.gems >= 2 && e.weight >= 4 ? 2 : 1;
    } else if (e.gems > 2) e.gems = 2;
    e.wide = e.wide && e.gems === 2;
    // sustain jangan menabrak note berikutnya
    const next = list[i + 1];
    if (e.sustain && next) e.sustain = Math.min(e.sustain, next.step - e.step - 1);
    if (e.sustain < 3) e.sustain = 0;
  }
  return list;
}

// Petakan kontur nada ke lane: nada naik = lane naik.
export function assignLanes(events, laneCount, stepsPerBar) {
  const n = events.length;
  const lanes = new Array(n);
  let lo = 0;
  let hi = 0;
  const win = stepsPerBar * 2;
  for (let i = 0; i < n; i++) {
    const e = events[i];
    const span = e.gems === 3 ? 2 : e.gems === 2 ? (e.wide && laneCount >= 4 ? 2 : 1) : 0;
    const maxLane = laneCount - 1 - span;
    while (events[lo].step < e.step - win) lo++;
    while (hi < n && events[hi].step <= e.step + win) hi++;
    let pmin = Infinity;
    let pmax = -Infinity;
    for (let k = lo; k < hi; k++) {
      if (events[k].pitch < pmin) pmin = events[k].pitch;
      if (events[k].pitch > pmax) pmax = events[k].pitch;
    }
    const prevE = i > 0 ? events[i - 1] : null;
    const linked = prevE && e.step - prevE.step <= win;
    const range = pmax - pmin;
    let lane;
    if (range < 1) lane = linked ? lanes[i - 1] : Math.floor(maxLane / 2);
    else {
      const scale = Math.min(1, maxLane / range);
      const base = (maxLane - range * scale) / 2;
      lane = Math.round(base + (e.pitch - pmin) * scale);
    }
    if (lane > maxLane) lane = maxLane;
    if (lane < 0) lane = 0;
    if (linked) {
      const pl = lanes[i - 1];
      if (e.pitch > prevE.pitch && lane <= pl) lane = pl + 1;
      else if (e.pitch < prevE.pitch && lane >= pl) lane = pl - 1;
      else if (e.pitch === prevE.pitch && e.gems === prevE.gems) lane = pl;
      // mentok di ujung: turun/naik tangga supaya run panjang tetap bergerak
      if (lane > maxLane) lane = pl >= maxLane ? Math.max(0, maxLane - 2) : maxLane;
      if (lane < 0) lane = pl <= 0 ? Math.min(maxLane, 2) : 0;
    }
    lanes[i] = lane;
    e.lane = lane;
    e.span = span;
  }
  return lanes;
}

export function buildSongModel(def) {
  const P = parseSong(def);
  const res = RES_DEFAULT;
  const ticksPerStep = res / P.stepsPerBeat;
  const stepSec = 60 / def.bpm / P.stepsPerBeat;
  const song = createSong({
    title: def.title,
    artist: def.artist,
    album: def.album || 'Super Band Originals',
    genre: def.genre || 'Rock',
    year: def.year || '',
    charter: 'Super Band',
  });
  song.resolution = res;
  song.tempos = [{ tick: 0, bpm: def.bpm }];
  song.timeSigs = [{ tick: 0, num: P.beatsPerBar, den: 4 }];
  song.sections = P.sections.map((s) => ({ tick: s.bar * P.stepsPerBar * ticksPerStep, name: s.name }));

  // phrase Super: 2 bar di tiap blok 8 bar
  const sp = [];
  const barTicks = P.stepsPerBar * ticksPerStep;
  for (let b = 2; b + 2 <= P.totalBars; b += 8) sp.push({ tick: b * barTicks, len: 2 * barTicks });

  const base = chartEvents(P);
  for (const diff of DIFFS) {
    const list = thin(base, diff, stepSec, P);
    assignLanes(list, LANE_COUNT[diff], P.stepsPerBar);
    const tr = ensureTrack(song, 'guitar', diff);
    for (const e of list) {
      const tick = Math.round(e.step * ticksPerStep);
      const len = e.sustain ? Math.round(e.sustain * ticksPerStep) : 0;
      const frets = e.gems === 3 ? [e.lane, e.lane + 1, e.lane + 2] : e.gems === 2 ? [e.lane, e.lane + e.span] : [e.lane];
      for (const fret of frets) tr.notes.push({ tick, fret, len });
    }
    tr.sp = sp.map((p) => ({ ...p }));
  }
  normalizeSong(song);
  song.lengthSec = P.totalBars * P.stepsPerBar * stepSec + 2.5;
  return song;
}

// ---------------------------------------------------------------------
// Audio

const LEVEL = {
  kick: 0.82,
  snare: 0.62,
  hat: 0.2,
  openHat: 0.2,
  ride: 0.2,
  crash: 0.28,
  tom1: 0.6,
  tom2: 0.62,
  tom3: 0.66,
  gong: 0.55,
};
const PAN = { kick: 0, snare: 0.05, hat: 0.28, openHat: 0.28, ride: -0.3, crash: -0.22, tom1: 0.35, tom2: 0, tom3: -0.35, gong: 0 };

const GUITAR_TONES = {
  crunch: { single: { damp: 0.22, bright: 0.8, pick: 0.14, sustain: 3.2 }, chord: { damp: 0.28, bright: 0.72, pick: 0.17, sustain: 2.6 } },
  lead: { single: { damp: 0.14, bright: 0.9, pick: 0.11, sustain: 5 }, chord: { damp: 0.25, bright: 0.75, pick: 0.16, sustain: 3 } },
  clean: { single: { damp: 0.2, bright: 0.62, pick: 0.2, sustain: 2.2 }, chord: { damp: 0.22, bright: 0.6, pick: 0.2, sustain: 2.4 } },
};

function playGuitar(buf, ev, startSample, stepSamples, rng, toneName, human = 0) {
  const tone = GUITAR_TONES[toneName] || GUITAR_TONES.crunch;
  const jitter = human ? Math.round((rng() * 2 - 1) * human * SR) : 0;
  const start = startSample + jitter;
  const amp = (ev.accent ? 1.2 : 1) * (human ? 0.9 + rng() * 0.2 : 1);
  const full = ev.dur * stepSamples;
  if (ev.muted) {
    const dur = Math.min(full, Math.floor(0.085 * SR));
    const strings = ev.kind === 'note' ? ev.pitches : ev.pitches.slice(0, 2);
    strings.forEach((p, k) => {
      pluck(buf, start + k * 70, midiToFreq(p), dur, rng, { amp: amp * (k ? 0.7 : 1), damp: 0.5, bright: 0.5, pick: 0.2, sustain: 0.11, release: 0.02 });
    });
    return;
  }
  const dur = Math.max(1, Math.floor(full * 0.96) - 60);
  if (ev.kind === 'note') {
    pluck(buf, start, midiToFreq(ev.pitches[0]), dur, rng, { amp, ...tone.single });
    return;
  }
  const strumGap = toneName === 'clean' ? 520 : 260;
  ev.pitches.forEach((p, k) => {
    pluck(buf, start + k * strumGap, midiToFreq(p), Math.max(1, dur - k * strumGap), rng, {
      amp: amp * (1 - k * 0.12),
      ...tone.chord,
    });
  });
}

async function step(onProgress, value) {
  if (onProgress) onProgress(value);
  await nextTick();
}

// Hasil: { sampleRate, length, backing: [L, R], guitar: [L, R], duration }
// opts.alloc(n) boleh mengembalikan 4 Float32Array (mis. channel data AudioBuffer)
// supaya hasil render tidak perlu disalin lagi.
export async function renderSong(def, opts = {}) {
  const onProgress = opts.onProgress || null;
  const P = parseSong(def);
  const stepSec = 60 / def.bpm / P.stepsPerBeat;
  const stepSamples = stepSec * SR;
  const bodySec = P.totalBars * P.stepsPerBar * stepSec;
  const n = Math.ceil((bodySec + 2.8) * SR);
  const at = (s) => Math.round(s * stepSamples);
  const rng = mulberry32(def.seed || hashString(def.id));
  const mix = { bass: 0.62, rhythm: 0.3, pad: 0.13, keys: 0.3, guitar: 0.4, reverb: 0.22, ...(def.mix || {}) };

  const [bL, bR, gL, gR] = opts.alloc
    ? opts.alloc(n, SR)
    : [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let send = new Float32Array(n);
  let scratch = new Float32Array(n);

  // --- drum
  const kit = makeDrumKit(rng);
  for (const hit of P.drums) {
    const src = kit[hit.inst];
    const gain = LEVEL[hit.inst] * hit.vel;
    addStereo(bL, bR, src, at(hit.step), gain, PAN[hit.inst]);
    if (hit.inst === 'snare' || hit.inst.startsWith('tom')) addMono(send, src, at(hit.step), gain * 0.3);
    else if (hit.inst === 'crash' || hit.inst === 'gong') addMono(send, src, at(hit.step), gain * 0.15);
  }
  await step(onProgress, 0.12);

  // --- bass
  for (const ev of P.bass) {
    const f = midiToFreq(ev.midi);
    const dur = Math.max(1, Math.floor(ev.dur * stepSamples * ev.gate));
    pluck(scratch, at(ev.step), f, dur, rng, { amp: 0.9, damp: 0.5, bright: 0.4, pick: 0.24, sustain: 3.2, release: 0.03 });
    subNote(scratch, at(ev.step), f, dur, 0.4);
  }
  Biquad.lowpass(1500, 0.7).process(scratch);
  for (let i = 0; i < n; i++) scratch[i] = Math.tanh(scratch[i] * 1.5) * 0.66;
  Biquad.highpass(32, 0.7).process(scratch);
  addStereo(bL, bR, scratch, 0, mix.bass, 0);
  await step(onProgress, 0.24);

  // --- rhythm guitar pengiring: dua take, kiri dan kanan
  if (P.rhythm.length) {
    for (const side of [-1, 1]) {
      scratch.fill(0);
      for (const ev of P.rhythm) playGuitar(scratch, ev, at(ev.step), stepSamples, rng, 'crunch', 0.004);
      ampSim(scratch, { drive: 9, level: 1, tone: side < 0 ? 3700 : 4100, scoop: -3, tight: 105 });
      addStereo(bL, bR, scratch, 0, mix.rhythm, side * 0.74);
      await step(onProgress, side < 0 ? 0.36 : 0.48);
    }
  }

  // --- pad
  if (P.pad.length) {
    scratch.fill(0);
    for (const ev of P.pad) {
      const dur = Math.floor(ev.dur * stepSamples);
      for (const p of ev.pitches) sawNote(scratch, at(ev.step), midiToFreq(p), dur, { amp: 0.3, attack: 0.09, release: 0.22, cutoff: 1300, detune: 0.006 });
    }
    addStereo(bL, bR, scratch, 0, mix.pad, -0.35);
    // sisi kanan sedikit telat supaya melebar
    addStereo(bL, bR, scratch, Math.floor(0.011 * SR), mix.pad, 0.35);
    addMono(send, scratch, 0, mix.pad * 0.5);
  }

  // --- keys / melodi pengiring
  if (P.keys.length) {
    scratch.fill(0);
    for (const ev of P.keys) {
      const dur = Math.floor(ev.dur * stepSamples * 0.94);
      for (const p of ev.pitches) {
        if (ev.tone === 'synth') {
          sawNote(scratch, at(ev.step), midiToFreq(p), dur, { amp: 0.42, attack: 0.012, release: 0.09, cutoff: 2600, pulse: 0.35, vibDepth: ev.dur >= 4 ? 0.006 : 0 });
        } else bellNote(scratch, at(ev.step), midiToFreq(p), dur, { amp: ev.accent ? 0.55 : 0.42, decay: 0.7 });
      }
    }
    addStereo(bL, bR, scratch, 0, mix.keys, 0.18);
    echoAdd(scratch, bL, bR, mix.keys * 0.28, -0.3, stepSec * 3, 0.3, 0.5);
    addMono(send, scratch, 0, mix.keys * 0.5);
  }
  await step(onProgress, 0.56);

  // --- reverb backing
  reverbAdd(send, bL, bR, mix.reverb * 5, scratch, { room: 0.8, damp: 0.4 });
  await step(onProgress, 0.68);

  // --- gitar pemain: tiap tone diproses di buffer sendiri
  send.fill(0);
  for (const toneName of ['crunch', 'lead', 'clean']) {
    const events = P.guitar.filter((e) => e.tone === toneName);
    if (!events.length) continue;
    scratch.fill(0);
    for (const ev of events) playGuitar(scratch, ev, at(ev.step), stepSamples, rng, toneName, 0);

    // vibrato di note panjang
    const segs = [];
    for (const ev of events) {
      if (!ev.vib || ev.muted || ev.dur < 4) continue;
      const from = at(ev.step) + Math.floor(0.2 * SR);
      const to = Math.min(n, at(ev.step + ev.dur) - 200);
      const last = segs[segs.length - 1];
      if (to - from > 2000 && (!last || last.to <= from)) segs.push({ from, to, depth: toneName === 'lead' ? 12 : 8 });
    }
    vibrato(scratch, segs, 5.5);

    if (toneName === 'clean') {
      Biquad.highpass(90, 0.7).process(scratch);
      Biquad.lowpass(6500, 0.7).process(scratch);
      for (let i = 0; i < n; i++) scratch[i] = Math.tanh(scratch[i] * 1.3) * 0.9;
      addStereo(gL, gR, scratch, 0, mix.guitar * 1.15, -0.12);
      echoAdd(scratch, gL, gR, mix.guitar * 0.3, 0.4, stepSec * 3, 0.25, 0.5);
      addMono(send, scratch, 0, mix.guitar * 0.55);
    } else if (toneName === 'lead') {
      ampSim(scratch, { drive: 24, level: 1, tone: 3900, scoop: 0, mid: 7, presence: 4, tight: 140 });
      addStereo(gL, gR, scratch, 0, mix.guitar * 0.92, 0);
      echoAdd(scratch, gL, gR, mix.guitar * 0.2, 0.3, stepSec * 3, 0.34, 0.45);
      echoAdd(scratch, gL, gR, mix.guitar * 0.1, -0.4, stepSec * 4, 0.3, 0.5);
      addMono(send, scratch, 0, mix.guitar * 0.3);
    } else {
      ampSim(scratch, { drive: 13, level: 1, tone: 4400, scoop: -2, tight: 100 });
      addStereo(gL, gR, scratch, 0, mix.guitar, 0);
      addMono(send, scratch, 0, mix.guitar * 0.16);
    }
    await step(onProgress, toneName === 'crunch' ? 0.78 : toneName === 'lead' ? 0.86 : 0.9);
  }
  reverbAdd(send, gL, gR, mix.reverb * 5, scratch, { room: 0.84, damp: 0.35 });
  send = null;
  scratch = null;
  await step(onProgress, 0.95);

  // --- master: samakan loudness lalu soft clip
  let sum = 0;
  const bodyN = Math.min(n, Math.floor(bodySec * SR));
  for (let i = 0; i < bodyN; i += 2) {
    const l = bL[i] + gL[i];
    const r = bR[i] + gR[i];
    sum += l * l + r * r;
  }
  const rms = Math.sqrt(sum / Math.max(1, bodyN));
  const gain = rms > 0 ? Math.min(6, 0.17 / rms) : 1;
  for (const buf of [bL, bR, gL, gR]) {
    for (let i = 0; i < n; i++) buf[i] *= gain;
    softClip(buf, 0.62);
  }
  // fade out ekor
  const fade = Math.floor(0.6 * SR);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    const idx = n - 1 - i;
    bL[idx] *= k;
    bR[idx] *= k;
    gL[idx] *= k;
    gR[idx] *= k;
  }
  if (onProgress) onProgress(1);
  return { sampleRate: SR, length: n, duration: n / SR, backing: [bL, bR], guitar: [gL, gR] };
}

export function stemStats(result) {
  const { backing, guitar } = result;
  const mixL = new Float32Array(result.length);
  for (let i = 0; i < result.length; i++) mixL[i] = backing[0][i] + guitar[0][i];
  return {
    backingRms: rmsOf(backing[0]),
    guitarRms: rmsOf(guitar[0]),
    backingPeak: Math.max(peakOf(backing[0]), peakOf(backing[1])),
    guitarPeak: Math.max(peakOf(guitar[0]), peakOf(guitar[1])),
    mixPeak: peakOf(mixL),
    mixRms: rmsOf(mixL),
  };
}
