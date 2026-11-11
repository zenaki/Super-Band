import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseChart, serializeChart, parseIni, applyIni } from '../js/core/chartFormat.js';
import { parseMidi } from '../js/core/midiFormat.js';
import { readZip, writeZip, readSng } from '../js/core/archive.js';
import { compileTrack, OPEN, MOD_FLIP } from '../js/core/chart.js';

const CHART = `[Song]
{
  Name = "Lagu Tes"
  Artist = "Band Tes"
  Year = ", 2020"
  Offset = 0.5
  Resolution = 192
  MusicStream = "song.ogg"
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
  768 = TS 6 3
  768 = B 90500
}
[Events]
{
  0 = E "section Intro"
  768 = E "section Verse_1"
}
[ExpertSingle]
{
  192 = N 0 0
  240 = N 1 0
  240 = N 5 0
  384 = N 2 96
  384 = N 3 96
  480 = N 7 0
  576 = N 4 0
  576 = N 6 0
  192 = S 2 200
}
[EasyDoubleBass]
{
  0 = N 0 0
}
`;

test('.chart: parse metadata, sync, notes, modifier', () => {
  const song = parseChart(CHART);
  assert.equal(song.meta.title, 'Lagu Tes');
  assert.equal(song.meta.year, '2020');
  assert.equal(song.offset, 0.5);
  assert.deepEqual(song.tempos, [{ tick: 0, bpm: 120 }, { tick: 768, bpm: 90.5 }]);
  assert.deepEqual(song.timeSigs[1], { tick: 768, num: 6, den: 8 });
  assert.deepEqual(song.sections.map((s) => s.name), ['Intro', 'Verse 1']);
  const notes = song.parts.guitar.expert.notes;
  assert.equal(notes.length, 6);
  assert.equal(notes[1].mod, MOD_FLIP);
  assert.equal(notes[4].fret, OPEN);
  assert.equal(notes[5].tap, true);
  assert.ok(song.parts.bass.easy);
  const track = compileTrack(song, 'guitar', 'expert');
  assert.equal(track.notes[1].hopo, false); // natural HOPO di-flip
  assert.equal(track.notes[2].chord, true);
  assert.equal(track.phrases[0].count, 3);
});

test('.chart: serialize lalu parse lagi hasilnya sama', () => {
  const song = parseChart(CHART);
  const again = parseChart(serializeChart(song));
  assert.deepEqual(again.parts, song.parts);
  assert.deepEqual(again.tempos, song.tempos);
  assert.deepEqual(again.sections, song.sections);
});

test('song.ini: metadata dan delay', () => {
  const ini = parseIni('[song]\nname = Judul <color=#ff0000>Baru</color>\nArtist=X\ndelay = 250\nhopo_frequency = 170\n; komentar');
  assert.equal(ini.name, 'Judul Baru');
  const song = applyIni(parseChart(CHART), ini, false);
  assert.equal(song.meta.title, 'Judul Baru');
  assert.equal(song.offset, 0.75);
  assert.equal(song.hopoThreshold, 170);
});

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
function midiTrack(name, evs) {
  const b = [0, 0xff, 0x03, name.length, ...[...name].map((c) => c.charCodeAt(0))];
  let last = 0;
  for (const [tick, ...data] of evs.sort((x, y) => x[0] - y[0])) {
    b.push(...vlq(tick - last), ...data);
    last = tick;
  }
  b.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, (b.length >> 24) & 255, (b.length >> 16) & 255, (b.length >> 8) & 255, b.length & 255, ...b];
}

test('.mid: tempo, note, force, tap, open, star power', () => {
  const txt = [...'[ENHANCED_OPENS]'].map((c) => c.charCodeAt(0));
  const sec = [...'[section Solo]'].map((c) => c.charCodeAt(0));
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 0x01, 0xe0,
    ...midiTrack('tempo', [[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [0, 0xff, 0x58, 4, 3, 2, 24, 8]]),
    ...midiTrack('EVENTS', [[960, 0xff, 0x01, sec.length, ...sec]]),
    ...midiTrack('PART GUITAR', [
      [0, 0xff, 0x01, txt.length, ...txt],
      [480, 0x90, 96, 100], [600, 0x80, 96, 0],
      [600, 0x90, 97, 100], [650, 0x80, 97, 0],
      [600, 0x90, 102, 100], [601, 0x80, 102, 0],
      [960, 0x90, 98, 100], [960, 0x90, 99, 100], [1440, 0x80, 98, 0], [1440, 0x80, 99, 0],
      [1920, 0x90, 95, 100], [1930, 0x80, 95, 0],
      [2400, 0x90, 100, 100], [2410, 0x80, 100, 0],
      [2400, 0x90, 104, 100], [2401, 0x80, 104, 0],
      [960, 0x90, 116, 100], [1500, 0x80, 116, 0],
      [480, 0x90, 60, 100], [490, 0x80, 60, 0],
    ]),
  ]);
  const song = parseMidi(bytes);
  assert.equal(song.resolution, 480);
  assert.equal(Math.round(song.tempos[0].bpm), 120);
  assert.deepEqual(song.timeSigs[0], { tick: 0, num: 3, den: 4 });
  assert.equal(song.sections[0].name, 'Solo');
  const track = compileTrack(song, 'guitar', 'expert');
  assert.equal(track.notes.length, 5);
  assert.equal(track.notes[0].sustain, false); // 120 tick < cutoff
  assert.equal(track.notes[1].hopo, false); // dipaksa strum
  assert.equal(track.notes[2].chord, true);
  assert.equal(track.notes[2].sustain, true);
  assert.equal(track.notes[2].sp, 0);
  assert.equal(track.notes[3].open, true);
  assert.equal(track.notes[4].tap, true);
  assert.equal(song.parts.guitar.easy.notes.length, 1);
});

test('zip: baca entry deflate dan store, tulis ulang', async () => {
  const a = new TextEncoder().encode('halo '.repeat(200));
  const b = new Uint8Array([1, 2, 3, 4, 5]);
  const z = writeZip([{ name: 'folder/a.txt', data: a }, { name: 'b.bin', data: b }]);
  const entries = readZip(z);
  assert.deepEqual(entries.map((e) => e.name), ['folder/a.txt', 'b.bin']);
  assert.deepEqual(await entries[0].read(), a);
  assert.deepEqual(await entries[1].read(), b);
  // entry deflate buatan tangan
  const comp = deflateRawSync(a);
  const zz = writeZip([{ name: 'c.txt', data: new Uint8Array(comp) }]);
  const dv = new DataView(zz.buffer);
  dv.setUint16(8, 8, true);
  const cd = zz.length - 22 - 46 - 5;
  dv.setUint16(cd + 10, 8, true);
  dv.setUint32(cd + 24, a.length, true);
  assert.deepEqual(await readZip(zz)[0].read(), a);
});

test('.sng: metadata dan file ter-unmask', async () => {
  const enc = new TextEncoder();
  const mask = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255);
  const content = enc.encode('[Song]\n{\n  Resolution = 192\n}\n');
  const masked = content.map((v, i) => v ^ mask[i & 15] ^ (i & 255));
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return [...b]; };
  const i32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return [...b]; };
  const kv = (k, v) => [...i32(k.length), ...enc.encode(k), ...i32(v.length), ...enc.encode(v)];
  const metaBody = [...u64(1), ...kv('name', 'Tes')];
  const fname = enc.encode('notes.chart');
  const idxLen = 8 + 1 + fname.length + 16;
  const dataStart = 26 + 8 + metaBody.length + 8 + idxLen + 8;
  const idxBody = [...u64(1), fname.length, ...fname, ...u64(content.length), ...u64(dataStart)];
  const bytes = new Uint8Array([...enc.encode('SNGPKG'), 1, 0, 0, 0, ...mask, ...u64(metaBody.length), ...metaBody, ...u64(idxBody.length), ...idxBody, ...u64(content.length), ...masked]);
  const sng = readSng(bytes);
  assert.equal(sng.meta.name, 'Tes');
  assert.equal(sng.files[0].name, 'notes.chart');
  assert.deepEqual(await sng.files[0].read(), content);
});

test('stemFromName: kenali jenis stem dari nama file', async () => {
  const { stemFromName } = await import('../js/audio/separate.js');
  assert.equal(stemFromName('headhunt_bs6stem_mt_0_guitar.mp3'), 'guitar');
  assert.equal(stemFromName('headhunt_bs6stem_mt_0_bass.mp3'), 'bass');
  assert.equal(stemFromName('Song (Drums).wav'), 'drums');
  assert.equal(stemFromName('song-vocals.m4a'), 'vocals');
  assert.equal(stemFromName('track_instrumental.mp3'), 'other');
  assert.equal(stemFromName('Headhunt.mp3'), null);
  assert.equal(stemFromName('Bassline Junkie.mp3'), null);
  assert.equal(stemFromName('bass.ogg'), 'bass');
});
