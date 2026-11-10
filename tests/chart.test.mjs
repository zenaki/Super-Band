import test from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap, compileTrack, listCharts, MOD_FLIP, MOD_HOPO, MOD_STRUM, OPEN } from '../js/core/chart.js';
import { makeSong, makeTrack } from './helpers.mjs';

test('TempoMap: tick <-> time dengan perubahan tempo', () => {
  const tm = new TempoMap(192, [
    { tick: 0, bpm: 120 },
    { tick: 768, bpm: 60 },
  ]);
  assert.equal(tm.tickToTime(0), 0);
  assert.ok(Math.abs(tm.tickToTime(192) - 0.5) < 1e-9);
  assert.ok(Math.abs(tm.tickToTime(768) - 2) < 1e-9);
  assert.ok(Math.abs(tm.tickToTime(960) - 3) < 1e-9);
  assert.ok(Math.abs(tm.timeToTick(3) - 960) < 1e-6);
  assert.ok(Math.abs(tm.timeToTick(1) - 384) < 1e-6);
  assert.equal(tm.bpmAt(800), 60);
});

test('compileTrack: chord digabung, waktu benar', () => {
  const track = makeTrack([
    [0, 0],
    [1, [1, 2]],
    [2, 4, 2],
  ]);
  assert.equal(track.notes.length, 3);
  assert.equal(track.notes[1].chord, true);
  assert.equal(track.notes[1].mask, 0b110);
  assert.equal(track.notes[1].count, 2);
  assert.ok(Math.abs(track.notes[1].time - 0.5) < 1e-9);
  assert.equal(track.notes[2].sustain, true);
  assert.ok(Math.abs(track.notes[2].endTime - 2) < 1e-9);
  assert.equal(track.gemCount, 4);
});

test('compileTrack: natural HOPO dan modifier', () => {
  const track = makeTrack([
    [0, 0],
    [0.25, 1], // 48 tick dari note sebelumnya -> HOPO
    [0.5, 1], // fret sama -> strum
    [0.75, [2, 3]], // chord -> strum
    [1, 0, 0, { mod: MOD_FLIP }], // natural HOPO di-flip -> strum
    [3, 2, 0, { mod: MOD_FLIP }], // jauh, di-flip -> HOPO
    [5, 3, 0, { mod: MOD_HOPO }],
    [5.25, 4, 0, { mod: MOD_STRUM }],
    [5.5, 3, 0, { tap: true }],
  ]);
  const hopo = track.notes.map((n) => n.hopo);
  assert.deepEqual(hopo, [false, true, false, false, false, true, true, false, false]);
  assert.equal(track.notes[8].tap, true);
});

test('compileTrack: open note dan phrase Super', () => {
  const track = makeTrack(
    [
      [0, OPEN],
      [1, 0],
      [2, 1],
      [3, 2],
      [8, 3],
    ],
    { sp: [[1, 2.5]] },
  );
  assert.equal(track.notes[0].open, true);
  assert.equal(track.notes[0].count, 1);
  assert.equal(track.phrases.length, 1);
  assert.equal(track.phrases[0].count, 3);
  assert.deepEqual(
    track.notes.map((n) => n.sp),
    [-1, 0, 0, 0, -1],
  );
});

test('normalizeSong: duplikat dibuang, open+fret jadi fret saja', () => {
  const song = makeSong([
    [0, 0],
    [0, 0, 1],
    [1, [OPEN, 2]],
  ]);
  const notes = song.parts.guitar.expert.notes;
  assert.equal(notes.length, 2);
  assert.equal(notes[0].len, 192);
  assert.equal(notes[1].fret, 2);
  assert.deepEqual(listCharts(song), [{ part: 'guitar', diff: 'expert', notes: 2 }]);
});

test('compileTrack: beat line mengikuti time signature', () => {
  const song = makeSong([[0, 0], [7, 1]]);
  song.timeSigs = [{ tick: 0, num: 3, den: 4 }];
  const track = compileTrack(song, 'guitar', 'expert');
  assert.equal(track.beats[0].measure, true);
  assert.equal(track.beats[1].measure, false);
  assert.equal(track.beats[3].measure, true);
});
