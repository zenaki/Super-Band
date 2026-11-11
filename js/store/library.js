// Library lagu: lagu bawaan (dirender di device) + lagu milik user (IndexedDB).

import { db, requestPersist } from './db.js';
import { audio } from '../audio/player.js';
import { BUILTIN_SONGS, builtinById } from '../songs/index.js';
import { buildSongModel, renderSong } from '../audio/songBuilder.js';
import { SR } from '../audio/synth.js';
import { parseChart, parseIni, applyIni } from '../core/chartFormat.js';
import { parseMidi } from '../core/midiFormat.js';
import { readZip, readSng } from '../core/archive.js';
import { listCharts, normalizeSong } from '../core/chart.js';
import { uid, extOf, stripExt, baseName, dirName, decodeText } from '../core/util.js';

export const AUDIO_EXT = ['ogg', 'opus', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'webm'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];

let builtinEntries = null;
let renderCache = null; // { id, backing, instrument }

export function builtins() {
  if (!builtinEntries) {
    builtinEntries = BUILTIN_SONGS.map((def) => ({
      id: `builtin:${def.id}`,
      source: 'builtin',
      level: def.level,
      song: buildSongModel(def),
      audioRef: def.id,
    }));
  }
  return builtinEntries;
}

export async function listEntries() {
  let user = [];
  try {
    user = await db.all('songs');
  } catch (err) {
    user = [];
  }
  user.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return [...builtins(), ...user];
}

export async function saveEntry(entry, files) {
  requestPersist();
  normalizeSong(entry.song);
  if (!entry.addedAt) entry.addedAt = Date.now();
  if (files) {
    entry.files = files.map((f) => ({ name: f.name, size: f.blob.size }));
    for (const f of files) await db.put('files', `${entry.id}/${f.name}`, f.blob);
  }
  await db.put('songs', entry.id, entry);
  return entry;
}

export async function deleteEntry(entry) {
  for (const f of entry.files || []) await db.del('files', `${entry.id}/${f.name}`);
  await db.del('songs', entry.id);
}

export async function getFile(entry, name) {
  return db.get('files', `${entry.id}/${name}`);
}

export async function getArtUrl(entry) {
  const f = (entry.files || []).find((x) => /^album\./i.test(x.name));
  if (!f) return null;
  const blob = await getFile(entry, f.name);
  return blob ? URL.createObjectURL(blob) : null;
}

export async function decodeBlob(blob) {
  const ctx = audio.init();
  const data = await blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, (err) => reject(err || new Error('decode gagal')));
    if (p && p.catch) p.catch(reject);
  });
}

function stemRole(name) {
  const stem = stripExt(name).toLowerCase();
  if (stem === 'guitar') return 'guitar';
  if (stem === 'rhythm') return 'rhythm';
  if (stem === 'bass') return 'bass';
  if (stem === 'keys') return 'keys';
  if (stem === 'preview' || stem === 'crowd') return null;
  return 'backing';
}

function audioFilesOf(entry) {
  let list = (entry.files || []).filter((f) => AUDIO_EXT.includes(extOf(f.name)) && stemRole(f.name));
  const has = (re) => list.some((f) => re.test(stripExt(f.name)));
  if (has(/^drums_\d$/i)) list = list.filter((f) => !/^drums$/i.test(stripExt(f.name)));
  if (has(/^vocals_\d$/i)) list = list.filter((f) => !/^vocals$/i.test(stripExt(f.name)));
  return list;
}

async function mixDown(entry, files, onProgress, base, span) {
  if (!files.length) return null;
  const ctx = audio.init();
  let out = null;
  for (let i = 0; i < files.length; i++) {
    const blob = await getFile(entry, files[i].name);
    if (!blob) continue;
    let buf;
    try {
      buf = await decodeBlob(blob);
    } catch (err) {
      throw new Error(`Audio "${files[i].name}" tidak bisa dibuka di browser ini. Coba convert ke MP3 atau M4A.`);
    }
    if (files.length === 1) return buf;
    if (!out) out = ctx.createBuffer(2, buf.length, buf.sampleRate);
    if (buf.length > out.length) {
      const bigger = ctx.createBuffer(2, buf.length, buf.sampleRate);
      for (let c = 0; c < 2; c++) bigger.getChannelData(c).set(out.getChannelData(c));
      out = bigger;
    }
    for (let c = 0; c < 2; c++) {
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
      const dst = out.getChannelData(c);
      for (let k = 0; k < src.length; k++) dst[k] += src[k];
    }
    if (onProgress) onProgress(base + (span * (i + 1)) / files.length);
  }
  return out;
}

// Siapkan audio untuk dimainkan: { backing, instrument } berupa AudioBuffer.
export async function loadAudio(entry, part, onProgress) {
  const ctx = audio.init();
  if (entry.audioRef) {
    if (renderCache && renderCache.id === entry.audioRef) return renderCache;
    renderCache = null;
    const def = builtinById(entry.audioRef);
    const bufs = [];
    await renderSong(def, {
      onProgress,
      alloc: (n) => {
        const b = ctx.createBuffer(2, n, SR);
        const g = ctx.createBuffer(2, n, SR);
        bufs.push(b, g);
        return [b.getChannelData(0), b.getChannelData(1), g.getChannelData(0), g.getChannelData(1)];
      },
    });
    renderCache = { id: entry.audioRef, backing: bufs[0], instrument: bufs[1] };
    return renderCache;
  }
  renderCache = null;
  const files = audioFilesOf(entry);
  if (!files.length) throw new Error('Lagu ini tidak punya file audio.');
  const role = part === 'coop' ? 'guitar' : part;
  let inst = files.filter((f) => stemRole(f.name) === role);
  let rest = files.filter((f) => stemRole(f.name) !== role);
  if (entry.play) {
    // lagu dari upload multi-file: pembagian stem sudah ditentukan saat chart dibuat
    const all = entry.files || [];
    inst = all.filter((f) => entry.play.instrument.includes(f.name));
    rest = all.filter((f) => entry.play.backing.includes(f.name));
  }
  if (!rest.length) {
    rest = inst;
    inst = [];
  }
  const backing = await mixDown(entry, rest, onProgress, 0, inst.length ? 0.7 : 1);
  const instrument = await mixDown(entry, inst, onProgress, 0.7, 0.3);
  if (onProgress) onProgress(1);
  return { backing, instrument };
}

// ---------------------------------------------------------------------
// Import

function titleFromName(name) {
  const stem = stripExt(baseName(name)).replace(/[_]+/g, ' ').trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(stem);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: 'Unknown', title: stem || 'Untitled' };
}

export { titleFromName };

// items: [{ path, read(): Promise<Uint8Array> }] dari satu folder lagu
async function importFolder(items, iniOverride, label) {
  const byName = new Map(items.map((it) => [baseName(it.path).toLowerCase(), it]));
  const charts = items.filter((it) => ['chart', 'mid'].includes(extOf(it.path)));
  if (!charts.length) return null;
  const pick = byName.get('notes.chart') || byName.get('notes.mid') || charts.find((c) => extOf(c.path) === 'chart') || charts[0];
  const isMidi = extOf(pick.path) === 'mid';
  const ini = iniOverride || (byName.has('song.ini') ? parseIni(decodeText(await byName.get('song.ini').read())) : {});
  const bytes = await pick.read();
  let song;
  if (isMidi) {
    const spn = parseInt(ini.multiplier_note || ini.star_power_note, 10);
    song = parseMidi(bytes, { starPowerNote: spn === 103 || spn === 116 ? spn : 0, sustainCutoff: parseInt(ini.sustain_cutoff_threshold, 10) || 0 });
  } else song = parseChart(decodeText(bytes));
  applyIni(song, ini, isMidi);
  if (song.meta.title === 'Untitled' && label) Object.assign(song.meta, titleFromName(label));
  if (!listCharts(song).length) throw new Error(`"${song.meta.title}" tidak punya chart gitar/bass/keys 5-fret.`);

  const files = [];
  for (const it of items) {
    const ext = extOf(it.path);
    const name = baseName(it.path);
    const isArt = IMAGE_EXT.includes(ext) && /^album\./i.test(name);
    if (!AUDIO_EXT.includes(ext) && !isArt) continue;
    const data = await it.read();
    const type = isArt ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : `audio/${ext === 'mp3' ? 'mpeg' : ext === 'opus' ? 'ogg' : ext}`;
    files.push({ name: isArt ? `album.${ext}` : name.toLowerCase(), blob: new Blob([data], { type }) });
  }
  if (!files.some((f) => AUDIO_EXT.includes(extOf(f.name)))) throw new Error(`"${song.meta.title}" tidak menyertakan file audio.`);
  const entry = { id: uid('song'), source: 'import', song };
  await saveEntry(entry, files);
  return entry;
}

// fileList: File[] dari input / drag-drop.
// Hasil: { imported: [entry], errors: [string], audioOnly: [File] }
export async function importFiles(fileList, onProgress) {
  const result = { imported: [], errors: [], audioOnly: [] };
  const files = [...fileList];
  const loose = [];
  let done = 0;
  const tick = () => onProgress && onProgress(++done / files.length);
  for (const file of files) {
    const ext = extOf(file.name);
    try {
      if (ext === 'zip') {
        const entries = readZip(new Uint8Array(await file.arrayBuffer()));
        const groups = new Map();
        for (const e of entries) {
          if (e.name.startsWith('__MACOSX/')) continue;
          const dir = dirName(e.name);
          if (!groups.has(dir)) groups.set(dir, []);
          groups.get(dir).push({ path: e.name, read: () => e.read() });
        }
        let found = 0;
        for (const [dir, items] of groups) {
          try {
            const entry = await importFolder(items, null, dir || file.name);
            if (entry) {
              result.imported.push(entry);
              found++;
            }
          } catch (err) {
            result.errors.push(err.message);
          }
        }
        if (!found && !result.errors.length) result.errors.push(`"${file.name}" tidak berisi notes.chart atau notes.mid.`);
      } else if (ext === 'sng') {
        const sng = readSng(new Uint8Array(await file.arrayBuffer()));
        const items = sng.files.map((f) => ({ path: f.name, read: () => f.read() }));
        const entry = await importFolder(items, sng.meta, file.name);
        if (entry) result.imported.push(entry);
        else result.errors.push(`"${file.name}" tidak berisi chart.`);
      } else {
        loose.push(file);
      }
    } catch (err) {
      result.errors.push(`${file.name}: ${err.message}`);
    }
    tick();
  }
  if (loose.length) {
    const groups = new Map();
    for (const f of loose) {
      const dir = dirName(f.webkitRelativePath || '');
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(f);
    }
    for (const [dir, group] of groups) {
      const hasChart = group.some((f) => ['chart', 'mid'].includes(extOf(f.name)));
      if (!hasChart) {
        result.audioOnly.push(...group.filter((f) => AUDIO_EXT.includes(extOf(f.name))));
        continue;
      }
      try {
        const items = group.map((f) => ({ path: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) }));
        const entry = await importFolder(items, null, baseName(dir) || group[0].name);
        if (entry) result.imported.push(entry);
      } catch (err) {
        result.errors.push(err.message);
      }
    }
  }
  return result;
}
