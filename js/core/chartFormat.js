// Parser & serializer format .chart (Clone Hero / Moonscraper) + song.ini.

import {
  createSong,
  ensureTrack,
  normalizeSong,
  defaultHopoThreshold,
  compileTrack,
  DIFFS,
  OPEN,
  MOD_FLIP,
  MOD_HOPO,
  MOD_STRUM,
  MOD_NONE,
} from './chart.js';

const DIFF_NAMES = { Easy: 'easy', Medium: 'medium', Hard: 'hard', Expert: 'expert' };
const INSTRUMENTS = { Single: 'guitar', DoubleGuitar: 'coop', DoubleRhythm: 'rhythm', DoubleBass: 'bass', Keyboard: 'keys' };

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1);
  return v;
}

export function parseChart(text) {
  const song = createSong();
  const sections = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line[0] === '[' && line[line.length - 1] === ']') {
      current = [];
      sections[line.slice(1, -1)] = current;
    } else if (line === '{' || line === '}') {
      if (line === '}') current = null;
    } else if (current) {
      const eq = line.indexOf('=');
      if (eq > 0) current.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
    }
  }

  const meta = {};
  for (const [k, v] of sections.Song || []) meta[k] = unquote(v);
  song.resolution = parseInt(meta.Resolution, 10) || 192;
  song.hopoThreshold = defaultHopoThreshold(song.resolution);
  song.offset = parseFloat(meta.Offset) || 0;
  song.meta.title = meta.Name || 'Untitled';
  song.meta.artist = meta.Artist || 'Unknown';
  song.meta.album = meta.Album || '';
  song.meta.genre = meta.Genre || '';
  song.meta.year = (meta.Year || '').replace(/^,\s*/, '');
  song.meta.charter = meta.Charter || '';
  song.streams = {};
  for (const k of Object.keys(meta)) if (/Stream$/.test(k) && meta[k]) song.streams[k] = meta[k];

  song.tempos = [];
  song.timeSigs = [];
  for (const [k, v] of sections.SyncTrack || []) {
    const tick = parseInt(k, 10);
    const p = v.split(/\s+/);
    if (p[0] === 'B') song.tempos.push({ tick, bpm: parseInt(p[1], 10) / 1000 });
    else if (p[0] === 'TS') song.timeSigs.push({ tick, num: parseInt(p[1], 10) || 4, den: 2 ** (p[2] !== undefined ? parseInt(p[2], 10) : 2) });
  }
  for (const [k, v] of sections.Events || []) {
    const m = /^E\s+"?\[?(?:section[ _]|prc_)(.*?)\]?"?$/.exec(v);
    if (m) song.sections.push({ tick: parseInt(k, 10), name: m[1].replace(/_/g, ' ').trim() });
  }

  for (const name of Object.keys(sections)) {
    const m = /^(Easy|Medium|Hard|Expert)(\w+)$/.exec(name);
    if (!m || !INSTRUMENTS[m[2]]) continue;
    const tr = ensureTrack(song, INSTRUMENTS[m[2]], DIFF_NAMES[m[1]]);
    const mods = new Map();
    for (const [k, v] of sections[name]) {
      const tick = parseInt(k, 10);
      const p = v.split(/\s+/);
      if (p[0] === 'N') {
        const type = parseInt(p[1], 10);
        const len = parseInt(p[2], 10) || 0;
        if (type >= 0 && type <= 4) tr.notes.push({ tick, fret: type, len });
        else if (type === 7) tr.notes.push({ tick, fret: OPEN, len });
        else if (type === 5 || type === 6) {
          const cur = mods.get(tick) || { forced: false, tap: false };
          if (type === 5) cur.forced = true;
          else cur.tap = true;
          mods.set(tick, cur);
        }
      } else if (p[0] === 'S' && p[1] === '2') tr.sp.push({ tick, len: parseInt(p[2], 10) || 0 });
    }
    for (const n of tr.notes) {
      const md = mods.get(n.tick);
      if (md) {
        if (md.forced) n.mod = MOD_FLIP;
        if (md.tap) n.tap = true;
      }
    }
  }
  return normalizeSong(song);
}

// Ubah modifier gaya .mid (paksa HOPO/strum) menjadi flip relatif terhadap natural.
function flipFlags(song, part, diff) {
  const compiled = compileTrack(song, part, diff);
  const plain = JSON.parse(JSON.stringify(song));
  for (const n of plain.parts[part][diff].notes) {
    n.mod = MOD_NONE;
    n.tap = false;
  }
  const natural = compileTrack(plain, part, diff);
  const flips = new Set();
  if (compiled && natural) {
    for (let i = 0; i < compiled.notes.length; i++) {
      if (!compiled.notes[i].tap && compiled.notes[i].hopo !== natural.notes[i].hopo) flips.add(compiled.notes[i].tick);
    }
  }
  return flips;
}

export function serializeChart(song, audioName = 'song.ogg') {
  const L = [];
  const q = (s) => `"${String(s || '').replace(/"/g, "'")}"`;
  L.push('[Song]', '{');
  L.push(`  Name = ${q(song.meta.title)}`);
  L.push(`  Artist = ${q(song.meta.artist)}`);
  L.push(`  Charter = ${q(song.meta.charter)}`);
  L.push(`  Album = ${q(song.meta.album)}`);
  L.push(`  Year = ${q(song.meta.year ? `, ${song.meta.year}` : '')}`);
  L.push(`  Offset = ${song.offset || 0}`);
  L.push(`  Resolution = ${song.resolution}`);
  L.push('  Player2 = bass', '  Difficulty = 0', '  PreviewStart = 0', '  PreviewEnd = 0');
  L.push(`  Genre = ${q(song.meta.genre || 'rock')}`);
  L.push('  MediaType = "cd"');
  L.push(`  MusicStream = ${q(audioName)}`);
  L.push('}', '[SyncTrack]', '{');
  const sync = [];
  for (const t of song.timeSigs) {
    const exp = Math.round(Math.log2(t.den));
    sync.push([t.tick, 0, `  ${t.tick} = TS ${t.num}${exp !== 2 ? ` ${exp}` : ''}`]);
  }
  for (const t of song.tempos) sync.push([t.tick, 1, `  ${t.tick} = B ${Math.round(t.bpm * 1000)}`]);
  sync.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const s of sync) L.push(s[2]);
  L.push('}', '[Events]', '{');
  for (const s of song.sections) L.push(`  ${s.tick} = E "section ${s.name}"`);
  L.push('}');
  const instName = Object.fromEntries(Object.entries(INSTRUMENTS).map(([k, v]) => [v, k]));
  const diffName = Object.fromEntries(Object.entries(DIFF_NAMES).map(([k, v]) => [v, k]));
  for (const part of Object.keys(song.parts)) {
    for (const diff of [...DIFFS].reverse()) {
      const tr = song.parts[part][diff];
      if (!tr || !tr.notes.length) continue;
      const needsCompile = tr.notes.some((n) => n.mod === MOD_HOPO || n.mod === MOD_STRUM);
      const flips = needsCompile ? flipFlags(song, part, diff) : null;
      const ev = [];
      const seenTick = new Set();
      for (const n of tr.notes) {
        ev.push([n.tick, 0, `  ${n.tick} = N ${n.fret === OPEN ? 7 : n.fret} ${n.len}`]);
        if (seenTick.has(n.tick)) continue;
        seenTick.add(n.tick);
        const forced = flips ? flips.has(n.tick) : n.mod === MOD_FLIP;
        if (forced) ev.push([n.tick, 1, `  ${n.tick} = N 5 0`]);
        if (n.tap) ev.push([n.tick, 2, `  ${n.tick} = N 6 0`]);
      }
      for (const p of tr.sp) ev.push([p.tick, 3, `  ${p.tick} = S 2 ${p.len}`]);
      ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      L.push(`[${diffName[diff]}${instName[part]}]`, '{');
      for (const e of ev) L.push(e[2]);
      L.push('}');
    }
  }
  return `${L.join('\r\n')}\r\n`;
}

export function parseIni(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#' || line[0] === '[') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim().toLowerCase()] = line
      .slice(eq + 1)
      .trim()
      .replace(/<[^>]+>/g, '');
  }
  return out;
}

// Terapkan metadata song.ini ke song model (ini lebih diprioritaskan dari isi chart).
export function applyIni(song, ini, isMidi) {
  const m = song.meta;
  if (ini.name) m.title = ini.name;
  if (ini.artist) m.artist = ini.artist;
  if (ini.album) m.album = ini.album;
  if (ini.genre) m.genre = ini.genre;
  if (ini.year) m.year = ini.year.replace(/^,\s*/, '');
  if (ini.charter || ini.frets) m.charter = ini.charter || ini.frets;
  const delay = parseFloat(ini.delay);
  if (Number.isFinite(delay) && delay !== 0) song.offset = (song.offset || 0) + delay / 1000;
  const hf = parseInt(ini.hopo_frequency, 10);
  if (hf > 0) song.hopoThreshold = hf;
  else if (/^(true|1)$/i.test(ini.eighthnote_hopo || '')) song.hopoThreshold = Math.floor(song.resolution / 2) + (isMidi ? 1 : 0);
  return song;
}

export function serializeIni(song) {
  const m = song.meta;
  return [
    '[song]',
    `name = ${m.title}`,
    `artist = ${m.artist}`,
    `album = ${m.album || ''}`,
    `genre = ${m.genre || ''}`,
    `year = ${m.year || ''}`,
    `charter = ${m.charter || ''}`,
    'diff_guitar = -1',
    'delay = 0',
    '',
  ].join('\r\n');
}
