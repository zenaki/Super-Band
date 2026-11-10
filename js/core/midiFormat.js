// Parser notes.mid (format chart Rock Band / Clone Hero) untuk part 5-fret.

import { createSong, ensureTrack, normalizeSong, OPEN, MOD_HOPO, MOD_STRUM } from './chart.js';

const TRACKS = {
  'PART GUITAR': 'guitar',
  'T1 GEMS': 'guitar',
  'PART GUITAR COOP': 'coop',
  'PART RHYTHM': 'rhythm',
  'PART BASS': 'bass',
  'PART KEYS': 'keys',
};
const DIFF_BASE = { easy: 60, medium: 72, hard: 84, expert: 96 };
const DIFF_INDEX = ['easy', 'medium', 'hard', 'expert'];

export function parseMidiFile(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const str = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[p + i]);
    p += n;
    return s;
  };
  if (str(4) !== 'MThd') throw new Error('Bukan file MIDI');
  const hlen = dv.getUint32(p);
  p += 4;
  const ntrks = dv.getUint16(p + 2);
  const division = dv.getUint16(p + 4);
  p += hlen;
  if (division & 0x8000) throw new Error('MIDI dengan resolusi SMPTE tidak didukung');
  const tracks = [];
  for (let t = 0; t < ntrks && p + 8 <= bytes.length; t++) {
    const id = str(4);
    const len = dv.getUint32(p);
    p += 4;
    const end = Math.min(bytes.length, p + len);
    if (id !== 'MTrk') {
      p = end;
      continue;
    }
    const events = [];
    let tick = 0;
    let status = 0;
    const vlq = () => {
      let v = 0;
      for (;;) {
        const b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80) || p >= end) return v;
      }
    };
    while (p < end) {
      tick += vlq();
      let b = bytes[p];
      if (b === 0xff) {
        p++;
        const type = bytes[p++];
        const l = vlq();
        events.push({ tick, meta: type, data: bytes.subarray(p, p + l) });
        p += l;
      } else if (b === 0xf0 || b === 0xf7) {
        p++;
        const l = vlq();
        events.push({ tick, sysex: bytes.subarray(p, p + l) });
        p += l;
      } else {
        if (b & 0x80) {
          status = b;
          p++;
        }
        const hi = status & 0xf0;
        const d1 = bytes[p++];
        const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[p++];
        if (hi === 0x90 && d2 > 0) events.push({ tick, on: d1, vel: d2 });
        else if (hi === 0x80 || hi === 0x90) events.push({ tick, off: d1 });
      }
    }
    p = end;
    tracks.push(events);
  }
  return { resolution: division, tracks };
}

const text = (data) => new TextDecoder('utf-8').decode(data);

// opts: { starPowerNote, sustainCutoff }
export function parseMidi(bytes, opts = {}) {
  const { resolution, tracks } = parseMidiFile(bytes);
  const song = createSong();
  song.resolution = resolution;
  song.hopoThreshold = Math.floor(resolution / 3) + 1;
  song.tempos = [];
  song.timeSigs = [];
  const cutoff = opts.sustainCutoff > 0 ? opts.sustainCutoff : Math.floor(resolution / 3);
  const snap = Math.round((10 * resolution) / 480);

  for (const events of tracks) {
    let name = '';
    for (const e of events) {
      if (e.meta === 0x03 && !name) name = text(e.data).trim();
      else if (e.meta === 0x51 && e.data.length >= 3) {
        const us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
        if (us > 0) song.tempos.push({ tick: e.tick, bpm: 60000000 / us });
      } else if (e.meta === 0x58 && e.data.length >= 2) song.timeSigs.push({ tick: e.tick, num: e.data[0], den: 2 ** e.data[1] });
    }
    if (name === 'EVENTS') {
      for (const e of events) {
        if (e.meta === undefined || e.meta < 1 || e.meta > 0x0f || e.meta === 0x03) continue;
        const m = /^\[?(?:section[ _]|prc_)(.*?)\]?$/.exec(text(e.data).trim());
        if (m) song.sections.push({ tick: e.tick, name: m[1].replace(/_/g, ' ').trim() });
      }
      continue;
    }
    const part = TRACKS[name];
    if (!part || (song.parts[part] && name === 'T1 GEMS')) continue;

    // interval note on/off
    const open = new Map();
    const spans = [];
    let enhanced = false;
    const sysSpans = [];
    const sysOpen = {};
    for (const e of events) {
      if (e.on !== undefined) open.set(e.on, e.tick);
      else if (e.off !== undefined && open.has(e.off)) {
        spans.push({ note: e.off, tick: open.get(e.off), end: e.tick });
        open.delete(e.off);
      } else if (e.meta !== undefined && e.meta >= 1 && e.meta <= 0x0f && /ENHANCED_OPENS/.test(text(e.data))) enhanced = true;
      else if (e.sysex && e.sysex.length >= 7 && e.sysex[0] === 0x50 && e.sysex[1] === 0x53 && e.sysex[2] === 0) {
        const key = `${e.sysex[4]}:${e.sysex[5]}`;
        if (e.sysex[6] === 1) sysOpen[key] = e.tick;
        else if (sysOpen[key] !== undefined) {
          sysSpans.push({ diff: e.sysex[4], mod: e.sysex[5], tick: sysOpen[key], end: e.tick });
          delete sysOpen[key];
        }
      }
    }
    const inSpan = (list, tick, inclusive) => list.some((s) => tick >= s.tick && (tick < s.end || (inclusive && tick === s.end) || s.end === s.tick));
    const of = (n) => spans.filter((s) => s.note === n);
    let spNote = opts.starPowerNote || 116;
    if (!opts.starPowerNote && !of(116).length && of(103).length) spNote = 103;
    const sp = of(spNote).map((s) => ({ tick: s.tick, len: s.end - s.tick }));
    const tapNotes = of(104);

    DIFF_INDEX.forEach((diff, di) => {
      const base = DIFF_BASE[diff];
      const gems = spans.filter((s) => s.note >= base - (enhanced ? 1 : 0) && s.note <= base + 4);
      if (!gems.length) return;
      gems.sort((a, b) => a.tick - b.tick);
      const forceH = of(base + 5);
      const forceS = of(base + 6);
      const sysTap = sysSpans.filter((s) => s.mod === 4 && (s.diff === di || s.diff === 0xff));
      const sysOp = sysSpans.filter((s) => s.mod === 1 && (s.diff === di || s.diff === 0xff));
      const tr = ensureTrack(song, part, diff);
      let groupTick = -Infinity;
      for (const s of gems) {
        // not yang hampir bersamaan dianggap satu chord
        const tick = s.tick - groupTick <= snap ? groupTick : s.tick;
        groupTick = tick;
        let len = s.end - s.tick;
        if (len <= cutoff) len = 0;
        let fret = s.note - base;
        if (fret < 0 || inSpan(sysOp, s.tick, false)) fret = OPEN;
        const note = { tick, fret, len };
        if (inSpan(forceH, s.tick, false)) note.mod = MOD_HOPO;
        else if (inSpan(forceS, s.tick, false)) note.mod = MOD_STRUM;
        if (inSpan(tapNotes, s.tick, false) || inSpan(sysTap, s.tick, true)) note.tap = true;
        tr.notes.push(note);
      }
      tr.sp = sp.map((x) => ({ ...x }));
    });
  }
  return normalizeSong(song);
}
