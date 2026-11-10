import test from 'node:test';
import assert from 'node:assert/strict';
import { SR, pluck, parsePitch, midiToFreq } from '../js/audio/synth.js';
import { parseBar, buildSongModel, renderSong, stemStats } from '../js/audio/songBuilder.js';
import { BUILTIN_SONGS } from '../js/songs/index.js';
import { autoChart } from '../js/audio/analysis.js';
import { compileTrack, listCharts } from '../js/core/chart.js';
import { mulberry32 } from '../js/core/util.js';

test('parsePitch dan notasi bar', () => {
  assert.equal(parsePitch('e2'), 40);
  assert.equal(parsePitch('bb3'), 58);
  assert.equal(parsePitch('c#4'), 61);
  const ev = parseBar('E2.:2 e3~:6 -:4 [a2 e3]^:4', 16);
  assert.equal(ev.length, 3);
  assert.equal(ev[0].kind, 'power');
  assert.equal(ev[0].muted, true);
  assert.equal(ev[1].vib, true);
  assert.equal(ev[2].step, 12);
  assert.equal(ev[2].accent, true);
  assert.throws(() => parseBar('e2:3', 16));
});

test('senar Karplus-Strong tidak fals', () => {
  for (const name of ['e2', 'a3', 'e5']) {
    const f = midiToFreq(parsePitch(name));
    const buf = new Float32Array(SR);
    pluck(buf, 0, f, SR, mulberry32(7), { damp: 0.25, sustain: 4 });
    // ukur periode lewat autokorelasi di sekitar periode yang diharapkan
    const p0 = SR / f;
    let best = 0;
    let bestLag = 0;
    for (let lag = p0 * 0.94; lag <= p0 * 1.06; lag += 0.02) {
      let s = 0;
      for (let i = 4000; i < 24000; i++) {
        const j = i + lag;
        const j0 = Math.floor(j);
        s += buf[i] * (buf[j0] + (buf[j0 + 1] - buf[j0]) * (j - j0));
      }
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    const cents = 1200 * Math.log2(p0 / bestLag);
    assert.ok(Math.abs(cents) < 6, `${name} meleset ${cents.toFixed(1)} cent`);
  }
});

test('lagu bawaan: chart valid di semua difficulty', () => {
  for (const def of BUILTIN_SONGS) {
    const song = buildSongModel(def);
    const charts = listCharts(song);
    assert.equal(charts.length, 4, def.id);
    const counts = Object.fromEntries(charts.map((c) => [c.diff, c.notes]));
    assert.ok(counts.easy < counts.expert, def.id);
    assert.ok(counts.easy <= counts.medium && counts.medium <= counts.hard && counts.hard <= counts.expert, `${def.id} ${JSON.stringify(counts)}`);
    const maxLane = { easy: 2, medium: 3, hard: 4, expert: 4 };
    for (const c of charts) {
      const tr = song.parts.guitar[c.diff];
      for (const n of tr.notes) assert.ok(n.fret >= 0 && n.fret <= maxLane[c.diff], `${def.id} ${c.diff} fret ${n.fret}`);
      const track = compileTrack(song, 'guitar', c.diff);
      assert.ok(track.phrases.length >= 3, `${def.id} ${c.diff} phrase`);
      if (c.diff === 'easy') assert.ok(track.notes.every((n) => !n.chord));
    }
  }
});

test('render lagu bawaan + auto-chart menemukan tempo-nya', async () => {
  const def = BUILTIN_SONGS.find((s) => s.id === 'neon-runway');
  const res = await renderSong(def);
  const st = stemStats(res);
  for (const buf of [...res.backing, ...res.guitar]) {
    for (let i = 0; i < buf.length; i += 997) assert.ok(Number.isFinite(buf[i]));
  }
  assert.ok(st.mixPeak <= 1.0, `peak ${st.mixPeak}`);
  assert.ok(st.mixRms > 0.08 && st.mixRms < 0.3, `rms ${st.mixRms}`);
  assert.ok(st.guitarRms > 0.03);

  const L = res.backing[0].map((v, i) => v + res.guitar[0][i]);
  const song = await autoChart([L], res.sampleRate, { title: 'Auto' });
  const ratio = song.detectedBpm / def.bpm;
  assert.ok([0.5, 1, 2].some((r) => Math.abs(ratio - r) < 0.03), `bpm ${song.detectedBpm}`);
  const charts = Object.fromEntries(listCharts(song).map((c) => [c.diff, c.notes]));
  assert.ok(charts.expert > 200 && charts.expert < 900, JSON.stringify(charts));
  assert.ok(charts.easy < charts.medium && charts.medium < charts.hard && charts.hard <= charts.expert, JSON.stringify(charts));
  // onset hasil deteksi harus dekat dengan grid 1/16 lagu aslinya
  const track = compileTrack(song, 'guitar', 'expert');
  const stepSec = 60 / def.bpm / 4;
  let near = 0;
  for (const n of track.notes) {
    const t = n.time + song.offset;
    const d = Math.abs(t / stepSec - Math.round(t / stepSec)) * stepSec;
    if (d < 0.03) near++;
  }
  assert.ok(near / track.notes.length > 0.85, `on-grid ${(near / track.notes.length).toFixed(2)}`);
});
