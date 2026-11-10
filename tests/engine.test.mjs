import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Bot, fullComboScore, starsFor, baseMultiplier, gradeFor } from '../js/core/engine.js';
import { MOD_HOPO, OPEN } from '../js/core/chart.js';
import { makeTrack } from './helpers.mjs';

// 120 BPM -> 1 beat = 0.5 detik
const T = (beat) => beat * 0.5;

function collect(engine) {
  const events = [];
  engine.onEvent = (type, data) => events.push({ type, ...data });
  return events;
}

test('tap mode: hit di dalam window, miss di luar', () => {
  const track = makeTrack([[2, 0], [4, 1], [6, 2]]);
  const eng = new Engine(track, { mode: 'tap' });
  const ev = collect(eng);
  eng.update(T(2) - 0.05);
  eng.fretDown(0, T(2) - 0.04);
  eng.fretUp(0, T(2) + 0.05);
  assert.equal(eng.hits, 1);
  assert.equal(eng.score, 75); // 40 ms meleset = Great
  // note kedua tidak ditekan
  eng.update(T(4) + 0.3);
  assert.equal(eng.misses, 1);
  assert.equal(eng.streak, 0);
  // terlalu cepat untuk note ketiga -> ghost
  eng.fretDown(2, T(6) - 0.2);
  assert.equal(eng.ghosts, 1);
  eng.fretUp(2, T(6) - 0.15);
  eng.fretDown(2, T(6) + 0.07);
  assert.equal(eng.hits, 2);
  assert.deepEqual(
    ev.map((e) => e.type),
    ['hit', 'miss', 'ghost', 'hit'],
  );
});

test('tap mode: chord harus lengkap, ghost tap memutus streak', () => {
  const track = makeTrack([[2, [0, 1]], [4, [2, 3]], [6, 4]]);
  const eng = new Engine(track, { mode: 'tap' });
  eng.fretDown(0, T(2) - 0.01);
  assert.equal(eng.hits, 0);
  eng.fretDown(1, T(2) + 0.02);
  assert.equal(eng.hits, 1);
  assert.equal(eng.score, 200); // chord 2 gem, Perfect
  eng.fretUp(0, T(2) + 0.1);
  eng.fretUp(1, T(2) + 0.1);
  // chord kedua cuma separuh -> miss
  eng.fretDown(2, T(4));
  eng.fretUp(2, T(4) + 0.05);
  eng.update(T(4) + 0.2);
  assert.equal(eng.misses, 1);
  assert.equal(eng.hits, 1);
  // lane salah -> ghost, streak tetap 0
  eng.fretDown(0, T(6));
  assert.equal(eng.ghosts, 1);
  eng.fretDown(4, T(6) + 0.01);
  assert.equal(eng.hits, 2);
  assert.equal(eng.streak, 1);
});

test('multiplier naik tiap 10 streak sampai 4x', () => {
  assert.equal(baseMultiplier(0), 1);
  assert.equal(baseMultiplier(9), 1);
  assert.equal(baseMultiplier(10), 2);
  assert.equal(baseMultiplier(30), 4);
  assert.equal(baseMultiplier(500), 4);
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([2 + i, i % 5]);
  const track = makeTrack(rows);
  const eng = new Engine(track, { mode: 'tap' });
  const bot = new Bot(eng);
  for (let t = 0; t < 25; t += 1 / 60) {
    bot.update(t);
    eng.update(t);
  }
  assert.equal(eng.hits, 40);
  assert.equal(eng.misses, 0);
  // semua Perfect: 10x100 + 10x200 + 10x300 + 10x400
  assert.equal(eng.score, 10000);
  assert.equal(fullComboScore(track), 7500);
  assert.equal(eng.results().perfect, 40);
  const res = eng.results();
  assert.equal(res.fullCombo, true);
  assert.equal(res.stars, 5);
  assert.equal(res.gold, true);
});

test('sustain: poin per beat, lepas lebih awal menghentikan poin', () => {
  const track = makeTrack([[2, 0, 4], [10, 1, 4]]);
  const eng = new Engine(track, { mode: 'tap' });
  eng.fretDown(0, T(2));
  eng.update(T(6) + 0.01);
  // 100 + 4 beat x 25
  assert.equal(eng.score, 200);
  assert.equal(eng.sustains.length, 0);
  eng.fretUp(0, T(6) + 0.02);
  eng.fretDown(1, T(10));
  eng.update(T(11));
  eng.fretUp(1, T(12));
  eng.update(T(14) + 0.1);
  // +100 + 2 beat x 25
  assert.equal(eng.score, 350);
});

test('Super: phrase lengkap mengisi meter, aktivasi menggandakan skor lalu habis', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push([2 + i, 0]);
  for (let i = 0; i < 60; i++) rows.push([12 + i, 1]);
  const track = makeTrack(rows, { sp: [[2, 4], [6, 4]] });
  assert.equal(track.phrases.length, 2);
  const eng = new Engine(track, { mode: 'tap' });
  const ev = collect(eng);
  const bot = new Bot(eng);
  bot.useSuper = false;
  for (let t = 0; t < T(11); t += 1 / 120) {
    bot.update(t);
    eng.update(t);
  }
  assert.ok(Math.abs(eng.super - 0.5) < 1e-9);
  assert.equal(eng.superReady, true);
  assert.ok(ev.some((e) => e.type === 'superReady'));
  const before = eng.score;
  assert.equal(eng.activateSuper(T(11)), true);
  assert.equal(eng.multiplier, 2); // streak 8 -> 1x, kali 2
  bot.update(T(12));
  eng.update(T(12));
  assert.equal(eng.score - before, 200);
  // setengah meter = 16 beat
  for (let t = T(12); t < T(11) + T(16) + 0.2; t += 1 / 120) {
    bot.update(t);
    eng.update(t);
  }
  assert.equal(eng.superActive, false);
  assert.equal(eng.super, 0);
  assert.ok(ev.some((e) => e.type === 'superEnd'));
});

test('Super: phrase yang ada miss-nya tidak mengisi meter', () => {
  const track = makeTrack([[2, 0], [3, 1], [4, 2], [8, 3]], { sp: [[2, 3]] });
  const eng = new Engine(track, { mode: 'tap' });
  eng.fretDown(0, T(2));
  eng.fretUp(0, T(2) + 0.05);
  eng.update(T(3) + 0.3); // note kedua miss
  eng.fretDown(2, T(4));
  eng.update(T(5));
  assert.equal(eng.super, 0);
  assert.equal(eng.activateSuper(T(5)), false);
});

test('tap mode: open note bisa dipukul dengan lane mana saja', () => {
  const track = makeTrack([[2, OPEN], [3, 2]]);
  const eng = new Engine(track, { mode: 'tap' });
  eng.fretDown(3, T(2));
  assert.equal(eng.hits, 1);
  eng.fretUp(3, T(2) + 0.05);
  eng.fretDown(2, T(3));
  assert.equal(eng.hits, 2);
  assert.equal(eng.ghosts, 0);
});

test('strum mode: butuh strum, fret lebih rendah boleh ditahan, chord harus persis', () => {
  const track = makeTrack([[2, 2], [4, [0, 1]], [6, 3], [8, OPEN]]);
  const eng = new Engine(track, { mode: 'strum' });
  eng.fretDown(0, T(2) - 0.3); // anchor
  eng.fretDown(2, T(2) - 0.2);
  eng.update(T(2) - 0.1);
  assert.equal(eng.hits, 0);
  eng.strum(T(2));
  assert.equal(eng.hits, 1);
  eng.fretUp(2, T(3));
  eng.fretDown(1, T(3));
  eng.strum(T(4));
  assert.equal(eng.hits, 2);
  // fret salah -> overstrum setelah leniency lewat
  eng.fretUp(0, T(5));
  eng.fretUp(1, T(5));
  eng.fretDown(4, T(5));
  eng.strum(T(6));
  eng.update(T(6) + 0.06);
  assert.equal(eng.hits, 2);
  assert.equal(eng.ghosts, 1);
  eng.update(T(6) + 0.2);
  assert.equal(eng.misses, 1);
  // open: strum tanpa fret
  eng.fretUp(4, T(7));
  eng.strum(T(8));
  assert.equal(eng.hits, 3);
});

test('strum mode: HOPO kena tanpa strum selama combo hidup, tap note selalu bisa', () => {
  const track = makeTrack([
    [2, 0],
    [2.25, 1], // HOPO
    [2.5, 2], // HOPO
    [6, 3, 0, { tap: true }],
    [8, 0],
    [8.25, 1], // HOPO tapi combo putus
  ]);
  assert.equal(track.notes[1].hopo, true);
  const eng = new Engine(track, { mode: 'strum' });
  eng.fretDown(0, T(2) - 0.2);
  eng.strum(T(2));
  eng.fretDown(1, T(2.25));
  eng.fretDown(2, T(2.5));
  assert.equal(eng.hits, 3);
  eng.fretUp(0, T(3));
  eng.fretUp(1, T(3));
  eng.fretUp(2, T(3));
  eng.fretDown(3, T(6) + 0.01);
  assert.equal(eng.hits, 4);
  eng.fretUp(3, T(7));
  // miss note 8 -> HOPO berikutnya butuh strum
  eng.update(T(8) + 0.12);
  assert.equal(eng.misses, 1);
  eng.fretDown(1, T(8.25));
  assert.equal(eng.hits, 4);
  eng.strum(T(8.25) + 0.01);
  assert.equal(eng.hits, 5);
});

test('strum mode: fret ditekan lebih awal untuk HOPO tetap kena tepat waktu', () => {
  const track = makeTrack([[2, 0], [2.25, 1, 0, { mod: MOD_HOPO }]]);
  const eng = new Engine(track, { mode: 'strum' });
  eng.fretDown(0, T(2) - 0.2);
  eng.strum(T(2) - 0.07);
  assert.equal(eng.hits, 1);
  // pindah fret langsung setelah strum, jauh sebelum window note kedua
  eng.fretDown(1, T(2) - 0.06);
  assert.equal(eng.hits, 1);
  eng.update(T(2.25) - 0.01);
  assert.equal(eng.hits, 1);
  eng.update(T(2.25) + 0.005);
  assert.equal(eng.hits, 2);
});

test('strum mode: strum sedikit lebih dulu dari fret masih dihitung', () => {
  const track = makeTrack([[2, 1], [4, 2]]);
  const eng = new Engine(track, { mode: 'strum' });
  eng.strum(T(2));
  eng.fretDown(1, T(2) + 0.03);
  assert.equal(eng.hits, 1);
  assert.equal(eng.ghosts, 0);
  eng.fretUp(1, T(3));
  // strum ganda cepat: yang pertama jadi overstrum
  eng.fretDown(2, T(4) - 0.1);
  eng.strum(T(4));
  eng.strum(T(4) + 0.02);
  eng.update(T(4) + 0.2);
  assert.equal(eng.hits, 2);
  assert.equal(eng.ghosts, 1);
});

test('bot strum mode: full combo termasuk chord, HOPO, sustain, dan open', () => {
  const rows = [];
  let beat = 2;
  for (let i = 0; i < 30; i++) {
    rows.push([beat, i % 5]);
    beat += 0.25;
  }
  rows.push([beat + 1, [0, 2], 2]);
  rows.push([beat + 4, OPEN]);
  rows.push([beat + 5, [1, 2, 3]]);
  rows.push([beat + 6, 4, 3]);
  const track = makeTrack(rows);
  const eng = new Engine(track, { mode: 'strum' });
  const bot = new Bot(eng);
  for (let t = 0; t < track.endTime + 1; t += 1 / 60) {
    bot.update(t);
    eng.update(t);
  }
  const res = eng.results();
  assert.equal(res.misses, 0);
  assert.equal(res.ghosts, 0);
  assert.equal(res.hits, rows.length);
  assert.equal(res.fullCombo, true);
  assert.ok(res.score >= eng.fcScore, `${res.score} vs ${eng.fcScore}`);
});

test('ghostPenalty off: salah tekan tidak memutus streak', () => {
  const track = makeTrack([[2, 0], [3, 1]]);
  const eng = new Engine(track, { mode: 'tap', ghostPenalty: false });
  eng.fretDown(0, T(2));
  eng.fretDown(4, T(2.5));
  assert.equal(eng.streak, 1);
  assert.equal(eng.ghosts, 1);
});

test('starsFor: cutoff relatif terhadap skor full combo', () => {
  assert.equal(starsFor(0, 1000, false).stars, 0);
  assert.equal(starsFor(200, 1000, false).stars, 2);
  assert.equal(starsFor(600, 1000, false).stars, 4);
  assert.equal(starsFor(800, 1000, false).stars, 5);
  assert.equal(starsFor(800, 1000, false).gold, false);
  assert.equal(starsFor(1000, 1000, true).gold, true);
});

test('event telat dari browser masih dihitung selama timestamp-nya valid', () => {
  const track = makeTrack([[2, 0]]);
  const eng = new Engine(track, { mode: 'tap' });
  // frame sudah lewat sedikit di luar window, lalu event dengan timestamp lama baru datang
  eng.update(T(2) + 0.09);
  eng.fretDown(0, T(2) + 0.07);
  assert.equal(eng.hits, 1);
  assert.equal(eng.misses, 0);
});

test('grade: Perfect, Great, Cool dari ketepatan timing', () => {
  assert.equal(gradeFor(0.01, 0.075), 'perfect');
  assert.equal(gradeFor(-0.04, 0.075), 'great');
  assert.equal(gradeFor(0.07, 0.075), 'cool');
  const track = makeTrack([[2, 0], [4, 1], [6, 2]]);
  const eng = new Engine(track, { mode: 'tap' });
  const grades = [];
  eng.onEvent = (type, d) => type === 'hit' && grades.push([d.grade, d.points]);
  eng.fretDown(0, T(2) + 0.005);
  eng.fretDown(1, T(4) - 0.045);
  eng.fretDown(2, T(6) + 0.07);
  assert.deepEqual(grades, [['perfect', 100], ['great', 75], ['cool', 50]]);
  const res = eng.results();
  assert.deepEqual([res.perfect, res.great, res.cool], [1, 1, 1]);
});
