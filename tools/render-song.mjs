// Dev tool: render lagu bawaan ke WAV. Pakai: node tools/render-song.mjs <id> <out.wav>
import { writeFileSync } from 'node:fs';
import { BUILTIN_SONGS, builtinById } from '../js/songs/index.js';
import { renderSong, buildSongModel, stemStats } from '../js/audio/songBuilder.js';
import { encodeWav } from '../js/audio/synth.js';
import { listCharts } from '../js/core/chart.js';

const ids = process.argv[2] ? [process.argv[2]] : BUILTIN_SONGS.map((s) => s.id);
for (const id of ids) {
  const def = builtinById(id);
  const t0 = Date.now();
  const model = buildSongModel(def);
  const res = await renderSong(def);
  console.log(id, `${res.duration.toFixed(1)}s`, `render ${Date.now() - t0}ms`, JSON.stringify(stemStats(res), (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
  console.log('  ', listCharts(model).map((c) => `${c.diff}:${c.notes}`).join(' '));
  if (process.argv[3]) {
    const L = res.backing[0].map((v, i) => v + res.guitar[0][i]);
    const R = res.backing[1].map((v, i) => v + res.guitar[1][i]);
    writeFileSync(process.argv[3], encodeWav(L, R));
  }
}
