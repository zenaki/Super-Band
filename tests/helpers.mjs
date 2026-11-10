import { createSong, ensureTrack, normalizeSong, compileTrack } from '../js/core/chart.js';

// Bikin song dari daftar [beat, fret(s), lenBeats?, extra?]
export function makeSong(rows, { bpm = 120, sp = [], res = 192 } = {}) {
  const song = createSong({ title: 'Test' });
  song.resolution = res;
  song.hopoThreshold = Math.floor((65 * res) / 192);
  song.tempos = [{ tick: 0, bpm }];
  const tr = ensureTrack(song, 'guitar', 'expert');
  for (const row of rows) {
    const [beat, frets, len = 0, extra = {}] = row;
    const list = Array.isArray(frets) ? frets : [frets];
    for (const fret of list) {
      tr.notes.push({ tick: Math.round(beat * res), fret, len: Math.round(len * res), ...extra });
    }
  }
  for (const [beat, len] of sp) tr.sp.push({ tick: Math.round(beat * res), len: Math.round(len * res) });
  return normalizeSong(song);
}

export function makeTrack(rows, opts) {
  return compileTrack(makeSong(rows, opts), 'guitar', 'expert');
}
