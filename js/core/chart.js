// Data model chart + konversi tick <-> waktu + kompilasi track untuk gameplay.
//
// Song model (disimpan apa adanya di library, semua posisi dalam tick):
// {
//   resolution: 192,                    // tick per quarter note
//   offset: 0,                          // detik; chartTime = audioTime - offset
//   hopoThreshold: 65,                  // jarak tick maksimum untuk natural HOPO
//   meta: { title, artist, album, genre, year, charter },
//   tempos:   [{ tick, bpm }],
//   timeSigs: [{ tick, num, den }],
//   sections: [{ tick, name }],
//   parts: { guitar: { expert: { notes: [{ tick, fret, len, mod, tap }], sp: [{ tick, len }] } } }
// }

import { lowerBound } from './util.js';

export const RES_DEFAULT = 192;
export const DIFFS = ['easy', 'medium', 'hard', 'expert'];
export const DIFF_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
export const PARTS = ['guitar', 'coop', 'rhythm', 'bass', 'keys'];
export const PART_LABEL = {
  guitar: 'Lead Guitar',
  coop: 'Co-op Guitar',
  rhythm: 'Rhythm Guitar',
  bass: 'Bass',
  keys: 'Keys',
};

export const LANES = 5;
export const OPEN = 5; // "fret" khusus untuk open note

// Modifier strum/HOPO per note
export const MOD_NONE = 0; // ikut aturan natural
export const MOD_FLIP = 1; // kebalikan dari natural (format .chart)
export const MOD_HOPO = 2; // paksa HOPO (format .mid)
export const MOD_STRUM = 3; // paksa strum (format .mid)

export function defaultHopoThreshold(resolution) {
  return Math.floor((65 * resolution) / 192);
}

export function createSong(meta = {}) {
  return {
    resolution: RES_DEFAULT,
    offset: 0,
    hopoThreshold: defaultHopoThreshold(RES_DEFAULT),
    meta: {
      title: 'Untitled',
      artist: 'Unknown',
      album: '',
      genre: '',
      year: '',
      charter: '',
      ...meta,
    },
    tempos: [{ tick: 0, bpm: 120 }],
    timeSigs: [{ tick: 0, num: 4, den: 4 }],
    sections: [],
    parts: {},
  };
}

export function emptyTrack() {
  return { notes: [], sp: [] };
}

export function ensureTrack(song, part, diff) {
  if (!song.parts[part]) song.parts[part] = {};
  if (!song.parts[part][diff]) song.parts[part][diff] = emptyTrack();
  return song.parts[part][diff];
}

export function cloneSong(song) {
  return JSON.parse(JSON.stringify(song));
}

function sortNotes(notes) {
  notes.sort((a, b) => a.tick - b.tick || a.fret - b.fret);
}

// Rapikan track: urutkan, buang note invalid/duplikat, samakan modifier per tick.
export function normalizeTrack(track) {
  const notes = [];
  for (const n of track.notes || []) {
    const tick = Math.round(n.tick);
    const fret = n.fret | 0;
    if (!(tick >= 0) || fret < 0 || fret > OPEN) continue;
    notes.push({
      tick,
      fret,
      len: Math.max(0, Math.round(n.len || 0)),
      mod: n.mod | 0,
      tap: !!n.tap,
    });
  }
  sortNotes(notes);
  const out = [];
  let i = 0;
  while (i < notes.length) {
    let j = i;
    let mod = MOD_NONE;
    let tap = false;
    while (j < notes.length && notes[j].tick === notes[i].tick) {
      if (notes[j].mod) mod = notes[j].mod;
      if (notes[j].tap) tap = true;
      j++;
    }
    let group = notes.slice(i, j);
    // open + fret lain di tick yang sama: buang open-nya
    if (group.length > 1 && group.some((n) => n.fret === OPEN)) {
      const fretted = group.filter((n) => n.fret !== OPEN);
      group = fretted.length ? fretted : [group[0]];
    }
    let prevFret = -1;
    for (const n of group) {
      if (n.fret === prevFret) {
        const last = out[out.length - 1];
        last.len = Math.max(last.len, n.len);
        continue;
      }
      prevFret = n.fret;
      out.push({ tick: n.tick, fret: n.fret, len: n.len, mod, tap });
    }
    i = j;
  }
  const sp = [];
  for (const p of track.sp || []) {
    const tick = Math.round(p.tick);
    if (!(tick >= 0)) continue;
    sp.push({ tick, len: Math.max(0, Math.round(p.len || 0)) });
  }
  sp.sort((a, b) => a.tick - b.tick);
  track.notes = out;
  track.sp = sp;
  return track;
}

export function normalizeSong(song) {
  if (!song.resolution || song.resolution <= 0) song.resolution = RES_DEFAULT;
  if (typeof song.offset !== 'number' || !Number.isFinite(song.offset)) song.offset = 0;
  if (!song.hopoThreshold) song.hopoThreshold = defaultHopoThreshold(song.resolution);
  song.meta = { title: 'Untitled', artist: 'Unknown', ...(song.meta || {}) };

  const tempos = (song.tempos || []).filter((t) => t.tick >= 0 && t.bpm > 0);
  tempos.sort((a, b) => a.tick - b.tick);
  const dedupTempos = [];
  for (const t of tempos) {
    const last = dedupTempos[dedupTempos.length - 1];
    if (last && last.tick === t.tick) last.bpm = t.bpm;
    else dedupTempos.push({ tick: Math.round(t.tick), bpm: t.bpm });
  }
  if (!dedupTempos.length || dedupTempos[0].tick !== 0) {
    dedupTempos.unshift({ tick: 0, bpm: dedupTempos.length ? dedupTempos[0].bpm : 120 });
  }
  song.tempos = dedupTempos;

  const sigs = (song.timeSigs || []).filter((t) => t.tick >= 0 && t.num > 0 && t.den > 0);
  sigs.sort((a, b) => a.tick - b.tick);
  const dedupSigs = [];
  for (const s of sigs) {
    const last = dedupSigs[dedupSigs.length - 1];
    if (last && last.tick === s.tick) {
      last.num = s.num;
      last.den = s.den;
    } else dedupSigs.push({ tick: Math.round(s.tick), num: s.num, den: s.den });
  }
  if (!dedupSigs.length || dedupSigs[0].tick !== 0) dedupSigs.unshift({ tick: 0, num: 4, den: 4 });
  song.timeSigs = dedupSigs;

  song.sections = (song.sections || [])
    .filter((s) => s.tick >= 0 && s.name)
    .map((s) => ({ tick: Math.round(s.tick), name: String(s.name) }))
    .sort((a, b) => a.tick - b.tick);

  if (!song.parts) song.parts = {};
  for (const part of Object.keys(song.parts)) {
    const diffs = song.parts[part];
    for (const diff of Object.keys(diffs)) {
      normalizeTrack(diffs[diff]);
      if (!diffs[diff].notes.length) delete diffs[diff];
    }
    if (!Object.keys(diffs).length) delete song.parts[part];
  }
  return song;
}

// Daftar chart yang tersedia: [{ part, diff, notes }]
export function listCharts(song) {
  const out = [];
  for (const part of PARTS) {
    const diffs = song.parts && song.parts[part];
    if (!diffs) continue;
    for (const diff of DIFFS) {
      const tr = diffs[diff];
      if (tr && tr.notes.length) out.push({ part, diff, notes: countGroups(tr.notes) });
    }
  }
  return out;
}

export function countGroups(notes) {
  let count = 0;
  let last = -1;
  for (const n of notes) {
    if (n.tick !== last) {
      count++;
      last = n.tick;
    }
  }
  return count;
}

export function lastTick(song) {
  let end = 0;
  for (const part of Object.keys(song.parts || {})) {
    for (const diff of Object.keys(song.parts[part])) {
      const notes = song.parts[part][diff].notes;
      for (let i = notes.length - 1; i >= 0 && i >= notes.length - 8; i--) {
        end = Math.max(end, notes[i].tick + notes[i].len);
      }
    }
  }
  for (const s of song.sections || []) end = Math.max(end, s.tick);
  return end;
}

export class TempoMap {
  constructor(resolution, tempos) {
    this.res = resolution;
    const list = [...tempos].sort((a, b) => a.tick - b.tick);
    if (!list.length || list[0].tick !== 0) list.unshift({ tick: 0, bpm: list.length ? list[0].bpm : 120 });
    this.segs = [];
    let time = 0;
    for (let i = 0; i < list.length; i++) {
      if (i > 0) {
        const prev = this.segs[i - 1];
        time = prev.time + (list[i].tick - prev.tick) * prev.spt;
      }
      this.segs.push({ tick: list[i].tick, bpm: list[i].bpm, time, spt: 60 / (list[i].bpm * resolution) });
    }
  }

  segForTick(tick) {
    const segs = this.segs;
    let i = lowerBound(segs, tick + 1, (s) => s.tick) - 1;
    if (i < 0) i = 0;
    return segs[i];
  }

  segForTime(time) {
    const segs = this.segs;
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segs[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    return segs[Math.max(0, lo - 1)];
  }

  tickToTime(tick) {
    const s = this.segForTick(tick);
    return s.time + (tick - s.tick) * s.spt;
  }

  timeToTick(time) {
    const s = this.segForTime(time);
    return s.tick + (time - s.time) / s.spt;
  }

  bpmAt(tick) {
    return this.segForTick(tick).bpm;
  }

  beatAtTime(time) {
    return this.timeToTick(time) / this.res;
  }
}

// Garis beat/measure dari tick 0 sampai endTick.
export function buildBeats(song, tempoMap, endTick) {
  const out = [];
  const res = song.resolution;
  const sigs = song.timeSigs && song.timeSigs.length ? song.timeSigs : [{ tick: 0, num: 4, den: 4 }];
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    const segEnd = i + 1 < sigs.length ? sigs[i + 1].tick : endTick + 1;
    const beatLen = Math.max(1, Math.round((res * 4) / sig.den));
    let b = 0;
    for (let tick = sig.tick; tick < segEnd && tick <= endTick; tick += beatLen, b++) {
      out.push({ tick, time: tempoMap.tickToTime(tick), measure: b % sig.num === 0 });
      if (out.length > 200000) return out;
    }
  }
  return out;
}

// Ubah track (tick) menjadi daftar note siap main (detik), sudah dikelompokkan per chord.
export function compileTrack(song, part, diff) {
  const src = song.parts && song.parts[part] && song.parts[part][diff];
  if (!src || !src.notes.length) return null;
  const res = song.resolution;
  const tm = new TempoMap(res, song.tempos);
  const threshold = song.hopoThreshold || defaultHopoThreshold(res);

  const raw = [...src.notes].sort((a, b) => a.tick - b.tick || a.fret - b.fret);
  const notes = [];
  let i = 0;
  while (i < raw.length) {
    let j = i;
    let mask = 0;
    let open = false;
    let len = 0;
    let mod = MOD_NONE;
    let tap = false;
    const frets = [];
    while (j < raw.length && raw[j].tick === raw[i].tick) {
      const n = raw[j];
      if (n.fret === OPEN) open = true;
      else if (!(mask & (1 << n.fret))) {
        mask |= 1 << n.fret;
        frets.push(n.fret);
      }
      if (n.len > len) len = n.len;
      if (n.mod) mod = n.mod;
      if (n.tap) tap = true;
      j++;
    }
    if (mask) open = false;
    const tick = raw[i].tick;
    const time = tm.tickToTime(tick);
    let endTime = len > 0 ? tm.tickToTime(tick + len) : time;
    let sustain = len > 0 && endTime - time >= 0.12;
    if (!sustain) endTime = time;
    const count = open ? 1 : frets.length;
    const prev = notes[notes.length - 1];
    const natural =
      !!prev && tick - prev.tick <= threshold && count === 1 && !(prev.mask === mask && prev.open === open);
    let hopo = natural;
    if (mod === MOD_FLIP) hopo = !natural;
    else if (mod === MOD_HOPO) hopo = true;
    else if (mod === MOD_STRUM) hopo = false;
    notes.push({
      idx: notes.length,
      tick,
      len: sustain ? len : 0,
      time,
      endTime,
      mask,
      frets,
      open,
      count,
      chord: count > 1,
      hopo: hopo && !(tap && !open),
      tap: tap && !open,
      sustain,
      sp: -1,
    });
    i = j;
  }

  // Super phrase (star power)
  const phrases = [];
  const spList = [...(src.sp || [])].sort((a, b) => a.tick - b.tick);
  let ni = 0;
  for (const p of spList) {
    const endTick = p.tick + p.len;
    while (ni < notes.length && notes[ni].tick < p.tick) ni++;
    let k = ni;
    let count = 0;
    const idx = phrases.length;
    while (k < notes.length && (notes[k].tick < endTick || (p.len === 0 && notes[k].tick === p.tick))) {
      if (notes[k].sp < 0) {
        notes[k].sp = idx;
        count++;
      }
      k++;
    }
    if (count > 0) {
      phrases.push({
        start: tm.tickToTime(p.tick),
        end: tm.tickToTime(Math.max(endTick, p.tick + 1)),
        count,
        first: ni,
        last: k - 1,
      });
    }
    ni = k;
  }

  const last = notes[notes.length - 1];
  let endTick = 0;
  for (let k = notes.length - 1; k >= 0 && k >= notes.length - 16; k--) {
    endTick = Math.max(endTick, notes[k].tick + notes[k].len);
  }
  const beats = buildBeats(song, tm, endTick + res * 8);
  const sections = (song.sections || []).map((s) => ({ time: tm.tickToTime(s.tick), tick: s.tick, name: s.name }));
  let gems = 0;
  for (const n of notes) gems += n.count;

  return {
    part,
    diff,
    resolution: res,
    tempoMap: tm,
    notes,
    phrases,
    beats,
    sections,
    firstTime: notes[0].time,
    endTime: Math.max(last.endTime, tm.tickToTime(endTick)),
    noteCount: notes.length,
    gemCount: gems,
    beatAt: (time) => tm.timeToTick(time) / res,
  };
}
