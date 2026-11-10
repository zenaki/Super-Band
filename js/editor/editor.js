// Chart editor: timeline vertikal, tap untuk pasang note, record sambil lagu jalan.

import { audio, Player, sfx } from '../audio/player.js';
import { analyze, estimateTempo } from '../audio/analysis.js';
import { LANE_COLORS } from '../game/highway.js';
import {
  TempoMap,
  ensureTrack,
  normalizeTrack,
  cloneSong,
  createSong,
  DIFFS,
  DIFF_LABEL,
  MOD_NONE,
  MOD_FLIP,
} from '../core/chart.js';
import { serializeChart, serializeIni } from '../core/chartFormat.js';
import { writeZip } from '../core/archive.js';
import { listEntries, loadAudio, saveEntry, getFile, decodeBlob, titleFromName, AUDIO_EXT } from '../store/library.js';
import { formatTime, uid, extOf, lowerBound } from '../core/util.js';

const SNAPS = [
  [1, '1/4'],
  [2, '1/8'],
  [3, '1/12'],
  [4, '1/16'],
  [6, '1/24'],
  [8, '1/32'],
];
const TOOLS = [
  ['note', 'Note'],
  ['sustain', 'Tahan'],
  ['kind', 'Jenis'],
  ['super', 'Super'],
];
const GUTTER = 40;
const MAP_W = 16;

export function createEditor(root, host) {
  const { go, toast, showLoading, hideLoading } = host;
  const st = {
    entry: null,
    song: null,
    part: 'guitar',
    diff: 'expert',
    track: null,
    tm: null,
    time: 0,
    zoom: 220,
    snap: 4,
    tool: 'note',
    playing: false,
    record: false,
    undo: [],
    redo: [],
    dirty: false,
    peaks: null,
    duration: 60,
    player: new Player(),
    raf: 0,
    drag: null,
    nextClick: 0,
    padDown: {},
    open: false,
  };
  let canvas = null;
  let g = null;

  // ---------- pilih lagu ----------

  async function showPicker() {
    stop();
    const entries = await listEntries();
    root.innerHTML = `<div class="ed-pick">
      <header class="bar" style="padding:0"><button class="back" id="ed-exit">Menu</button><h2>Chart editor</h2><span></span></header>
      <label class="btn btn-primary file-btn">Chart baru dari file audio<input id="ed-new" type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.opus,.flac" hidden></label>
      <p class="hint">Atau buka chart yang sudah ada. Lagu bawaan disimpan sebagai salinan.</p>
      ${entries.map((e) => `<button class="btn" data-id="${e.id}">${escapeHtml(e.song.meta.title)}</button>`).join('')}
    </div>`;
    root.querySelector('#ed-exit').onclick = () => go('menu');
    root.querySelector('#ed-new').onchange = (e) => {
      const f = e.target.files[0];
      if (f) newFromAudio(f);
    };
    for (const b of root.querySelectorAll('[data-id]')) {
      b.onclick = () => {
        audio.unlock();
        load(entries.find((x) => x.id === b.dataset.id));
      };
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  async function newFromAudio(file) {
    await audio.unlock();
    showLoading('Mencari tempo lagu', 0);
    try {
      const buf = await decodeBlob(file);
      const an = await analyze([buf.getChannelData(0)], buf.sampleRate, (v) => showLoading('Mencari tempo lagu', v));
      const { bpm, phase } = estimateTempo(an.env, an.fps);
      const song = createSong({ ...titleFromName(file.name), charter: '' });
      song.tempos = [{ tick: 0, bpm }];
      song.offset = phase + an.lead;
      const entry = { id: uid('custom'), source: 'custom', song };
      await saveEntry(entry, [{ name: `song.${extOf(file.name) || 'mp3'}`, blob: file }]);
      hideLoading();
      toast(`Tempo terdeteksi ${bpm} BPM`);
      load(entry);
    } catch (err) {
      hideLoading();
      toast(`Audio tidak bisa dibuka: ${err.message || 'format tidak didukung'}`, 5000);
    }
  }

  // ---------- buka chart ----------

  async function load(entry, part, diff) {
    st.entry = entry;
    st.song = cloneSong(entry.song);
    st.part = part || Object.keys(st.song.parts)[0] || 'guitar';
    const have = st.song.parts[st.part] ? Object.keys(st.song.parts[st.part]) : [];
    st.diff = diff && have.includes(diff) ? diff : have.includes('expert') ? 'expert' : have[have.length - 1] || 'expert';
    st.undo = [];
    st.redo = [];
    st.dirty = false;
    st.time = 0;
    buildUi();
    setTrack();
    showLoading('Membuka audio', 0);
    try {
      const a = await loadAudio(entry, st.part, (v) => showLoading('Membuka audio', v));
      st.player.load(a.backing, a.instrument);
      st.duration = st.player.duration;
      st.peaks = makePeaks(a.backing, a.instrument);
    } catch (err) {
      toast(err.message, 5000);
      st.peaks = null;
      st.duration = 180;
    }
    hideLoading();
    draw();
  }

  function makePeaks(a, b) {
    const src = a || b;
    if (!src) return null;
    const per = 100;
    const n = Math.ceil(src.duration * per);
    const out = new Float32Array(n);
    for (const buf of [a, b]) {
      if (!buf) continue;
      const d = buf.getChannelData(0);
      const stride = buf.sampleRate / per;
      for (let i = 0; i < n; i++) {
        let m = 0;
        const s0 = Math.floor(i * stride);
        const s1 = Math.min(d.length, Math.floor(s0 + stride));
        for (let k = s0; k < s1; k += 8) {
          const v = d[k] < 0 ? -d[k] : d[k];
          if (v > m) m = v;
        }
        if (m > out[i]) out[i] = m;
      }
    }
    return out;
  }

  function setTrack() {
    st.track = ensureTrack(st.song, st.part, st.diff);
    st.tm = new TempoMap(st.song.resolution, st.song.tempos);
    updateButtons();
  }

  function buildUi() {
    root.innerHTML = `
      <div class="ed-top">
        <button class="back" id="ed-back">Tutup</button>
        <div class="ed-title">${escapeHtml(st.song.meta.title)}</div>
        <select id="ed-diff">${DIFFS.map((d) => `<option value="${d}" ${d === st.diff ? 'selected' : ''}>${DIFF_LABEL[d]}</option>`).join('')}</select>
        <button class="ed-btn" id="ed-undo" aria-label="Undo">↶</button>
        <button class="ed-btn" id="ed-redo" aria-label="Redo">↷</button>
        <button class="ed-btn" id="ed-info">Info</button>
        <button class="ed-btn" id="ed-export">Export</button>
        <button class="ed-btn is-on" id="ed-save">Simpan</button>
      </div>
      <div class="ed-main"><canvas id="ed-canvas"></canvas></div>
      <div class="ed-bottom">
        <div class="ed-row">
          <button class="ed-btn" id="ed-play">Play</button>
          <div class="ed-time" id="ed-time">0:00</div>
          <select id="ed-snap">${SNAPS.map(([v, t]) => `<option value="${v}" ${v === st.snap ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <button class="ed-btn" id="ed-zout" aria-label="Zoom out">−</button>
          <button class="ed-btn" id="ed-zin" aria-label="Zoom in">+</button>
          <select id="ed-speed"><option value="1">100%</option><option value="0.75">75%</option><option value="0.5">50%</option></select>
          <button class="ed-btn" id="ed-rec">Rec</button>
        </div>
        <div class="ed-row">${TOOLS.map(([k, t]) => `<button class="ed-btn" data-tool="${k}">${t}</button>`).join('')}
          <button class="ed-btn" id="ed-copy">Salin dari…</button><button class="ed-btn" id="ed-clear">Kosongkan</button></div>
        <div class="ed-pads">${LANE_COLORS.map((c, i) => `<button class="ed-pad" data-pad="${i}" style="background:${c}" aria-label="Lane ${i + 1}"></button>`).join('')}</div>
      </div>`;
    canvas = root.querySelector('#ed-canvas');
    g = canvas.getContext('2d');
    const q = (s) => root.querySelector(s);
    q('#ed-back').onclick = () => {
      if (st.dirty && !confirm('Ada perubahan yang belum disimpan. Tutup editor?')) return;
      go('songs');
    };
    q('#ed-diff').onchange = (e) => {
      st.diff = e.target.value;
      setTrack();
      draw();
    };
    q('#ed-undo').onclick = undo;
    q('#ed-redo').onclick = redo;
    q('#ed-save').onclick = save;
    q('#ed-export').onclick = exportChart;
    q('#ed-info').onclick = editInfo;
    q('#ed-play').onclick = togglePlay;
    q('#ed-snap').onchange = (e) => {
      st.snap = parseInt(e.target.value, 10);
      draw();
    };
    q('#ed-zin').onclick = () => {
      st.zoom = Math.min(900, st.zoom * 1.3);
      draw();
    };
    q('#ed-zout').onclick = () => {
      st.zoom = Math.max(60, st.zoom / 1.3);
      draw();
    };
    q('#ed-rec').onclick = () => {
      st.record = !st.record;
      updateButtons();
      if (st.record) toast('Rec aktif: play lalu tekan pad warna mengikuti lagu');
    };
    q('#ed-copy').onclick = copyFrom;
    q('#ed-clear').onclick = () => {
      if (!st.track.notes.length || !confirm(`Hapus semua note di ${DIFF_LABEL[st.diff]}?`)) return;
      snapshot();
      st.track.notes = [];
      st.track.sp = [];
      draw();
    };
    for (const b of root.querySelectorAll('[data-tool]')) {
      b.onclick = () => {
        st.tool = b.dataset.tool;
        updateButtons();
      };
    }
    for (const b of root.querySelectorAll('[data-pad]')) {
      const lane = parseInt(b.dataset.pad, 10);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        padDown(lane);
      });
      const up = () => padUp(lane);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    }
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      seek(st.time - e.deltaY / st.zoom);
    }, { passive: false });
    resize();
  }

  function updateButtons() {
    const q = (s) => root.querySelector(s);
    if (!q('#ed-play')) return;
    q('#ed-play').textContent = st.playing ? 'Stop' : 'Play';
    q('#ed-play').classList.toggle('is-on', st.playing);
    q('#ed-rec').classList.toggle('is-on', st.record);
    q('#ed-undo').disabled = !st.undo.length;
    q('#ed-redo').disabled = !st.redo.length;
    for (const b of root.querySelectorAll('[data-tool]')) b.classList.toggle('is-on', b.dataset.tool === st.tool);
  }

  // ---------- koordinat ----------

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    st.W = canvas.clientWidth;
    st.H = canvas.clientHeight;
    canvas.width = Math.round(st.W * dpr);
    canvas.height = Math.round(st.H * dpr);
    st.dpr = dpr;
    st.playY = st.H * 0.8;
    st.laneW = (st.W - GUTTER - MAP_W) / 5;
    draw();
  }

  const yOf = (time) => st.playY - (time - st.time) * st.zoom;
  const timeAtY = (y) => st.time + (st.playY - y) / st.zoom;
  const tickOfTime = (time) => st.tm.timeToTick(time);
  const snapTicks = () => st.song.resolution / st.snap;
  const snapTick = (tick) => Math.max(0, Math.round(tick / snapTicks()) * snapTicks());
  const laneAtX = (x) => Math.max(0, Math.min(4, Math.floor((x - GUTTER) / st.laneW)));

  function seek(t) {
    st.time = Math.max(-1, Math.min(st.duration, t));
    if (st.playing) startAudio();
    draw();
  }

  // ---------- edit ----------

  function snapshot() {
    st.undo.push(JSON.stringify({ notes: st.track.notes, sp: st.track.sp }));
    if (st.undo.length > 100) st.undo.shift();
    st.redo = [];
    st.dirty = true;
    updateButtons();
  }

  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify({ notes: st.track.notes, sp: st.track.sp }));
    const s = JSON.parse(from.pop());
    st.track.notes = s.notes;
    st.track.sp = s.sp;
    st.dirty = true;
    updateButtons();
    draw();
  }
  const undo = () => restore(st.undo, st.redo);
  const redo = () => restore(st.redo, st.undo);

  function findNote(tick, lane, tol = 0) {
    return st.track.notes.find((n) => n.fret === lane && Math.abs(n.tick - tick) <= tol);
  }

  function toggleNote(tick, lane) {
    snapshot();
    const hit = findNote(tick, lane);
    if (hit) st.track.notes.splice(st.track.notes.indexOf(hit), 1);
    else {
      const same = st.track.notes.find((n) => n.tick === tick);
      st.track.notes.push({ tick, fret: lane, len: 0, mod: same ? same.mod : MOD_NONE, tap: same ? same.tap : false });
      normalizeTrack(st.track);
      if (!st.playing) sfx.note();
    }
    draw();
  }

  function cycleKind(tick) {
    const group = st.track.notes.filter((n) => n.tick === tick);
    if (!group.length) return;
    snapshot();
    const cur = group[0].tap ? 2 : group[0].mod === MOD_FLIP ? 1 : 0;
    const next = (cur + 1) % 3;
    for (const n of group) {
      n.mod = next === 1 ? MOD_FLIP : MOD_NONE;
      n.tap = next === 2;
    }
    toast(['Jenis: otomatis', 'Jenis: dibalik (strum ↔ HOPO)', 'Jenis: tap note'][next], 1200);
    draw();
  }

  function pointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const d = { x, y, moved: false, startTime: st.time, mode: 'scroll' };
    if (x > st.W - MAP_W) d.mode = 'map';
    else if (x >= GUTTER) {
      const tick = snapTick(tickOfTime(timeAtY(y)));
      const lane = laneAtX(x);
      d.tick = tick;
      d.lane = lane;
      if (st.tool === 'sustain') {
        const note = findNote(tick, lane, snapTicks() / 2) || nearestBelow(tickOfTime(timeAtY(y)), lane);
        if (note) {
          d.mode = 'sustain';
          d.note = note;
          snapshot();
        }
      } else if (st.tool === 'super') {
        d.mode = 'super';
      }
    }
    if (d.mode === 'map') seek((y / st.H) * st.duration);
    st.drag = d;
  }

  function nearestBelow(tick, lane) {
    let best = null;
    for (const n of st.track.notes) {
      if (n.fret !== lane || n.tick > tick) continue;
      if (tick - n.tick <= st.song.resolution * 2 && (!best || n.tick > best.tick)) best = n;
    }
    return best;
  }

  function pointerMove(e) {
    const d = st.drag;
    if (!d) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (Math.abs(y - d.y) > 8 || Math.abs(x - d.x) > 8) d.moved = true;
    if (d.mode === 'map') seek((y / st.H) * st.duration);
    else if (d.mode === 'scroll' && d.moved) seek(d.startTime + (y - d.y) / st.zoom);
    else if (d.mode === 'sustain') {
      const end = snapTick(tickOfTime(timeAtY(y)));
      d.note.len = Math.max(0, end - d.note.tick);
      for (const n of st.track.notes) if (n.tick === d.note.tick && n !== d.note && d.chord) n.len = d.note.len;
      draw();
    } else if (d.mode === 'super') {
      d.endTick = snapTick(tickOfTime(timeAtY(y)));
      draw();
    }
  }

  function pointerUp() {
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    if (d.mode === 'sustain') {
      if (!d.moved) d.note.len = 0;
      draw();
      return;
    }
    if (d.mode === 'super') {
      if (d.moved && d.endTick !== undefined && d.endTick !== d.tick) {
        snapshot();
        const a = Math.min(d.tick, d.endTick);
        const b = Math.max(d.tick, d.endTick);
        st.track.sp = st.track.sp.filter((p) => p.tick + p.len <= a || p.tick >= b);
        st.track.sp.push({ tick: a, len: b - a });
        st.track.sp.sort((p, q2) => p.tick - q2.tick);
      } else {
        const hit = st.track.sp.find((p) => d.tick >= p.tick && d.tick < p.tick + p.len);
        if (hit) {
          snapshot();
          st.track.sp.splice(st.track.sp.indexOf(hit), 1);
        }
      }
      draw();
      return;
    }
    if (d.mode !== 'scroll' || d.moved || d.tick === undefined) return;
    if (st.tool === 'note') toggleNote(d.tick, d.lane);
    else if (st.tool === 'kind') cycleKind(d.tick);
    else if (st.tool === 'sustain') toast('Tarik ke atas dari sebuah note untuk membuat sustain', 1800);
  }

  function padDown(lane) {
    audio.unlock();
    const tick = snapTick(tickOfTime(st.time));
    if (st.playing && st.record) {
      if (!findNote(tick, lane)) {
        snapshot();
        st.track.notes.push({ tick, fret: lane, len: 0, mod: MOD_NONE, tap: false });
        normalizeTrack(st.track);
      }
      st.padDown[lane] = { tick, at: st.time };
    } else toggleNote(tick, lane);
  }

  function padUp(lane) {
    const p = st.padDown[lane];
    if (!p) return;
    delete st.padDown[lane];
    if (st.time - p.at > 0.4) {
      const note = findNote(p.tick, lane);
      if (note) note.len = Math.max(0, snapTick(tickOfTime(st.time)) - p.tick);
    }
  }

  function copyFrom() {
    const others = DIFFS.filter((d) => d !== st.diff && st.song.parts[st.part] && st.song.parts[st.part][d] && st.song.parts[st.part][d].notes.length);
    if (!others.length) return toast('Belum ada difficulty lain yang berisi note');
    const pick = prompt(`Salin note dari difficulty mana? (${others.join(', ')})`, others[others.length - 1]);
    if (!pick || !others.includes(pick.trim().toLowerCase())) return;
    snapshot();
    const src = st.song.parts[st.part][pick.trim().toLowerCase()];
    st.track.notes = JSON.parse(JSON.stringify(src.notes));
    st.track.sp = JSON.parse(JSON.stringify(src.sp));
    draw();
  }

  function editInfo() {
    const title = prompt('Judul lagu', st.song.meta.title);
    if (title === null) return;
    const artist = prompt('Artis', st.song.meta.artist);
    if (artist === null) return;
    const bpm = parseFloat(prompt(st.song.tempos.length > 1 ? 'BPM awal (chart ini punya beberapa perubahan tempo)' : 'BPM', st.song.tempos[0].bpm));
    const off = parseFloat(prompt('Offset: detik audio sebelum ketukan pertama', (st.song.offset || 0).toFixed(3)));
    st.song.meta.title = title.trim() || st.song.meta.title;
    st.song.meta.artist = artist.trim() || st.song.meta.artist;
    if (bpm > 20 && bpm < 400) st.song.tempos[0].bpm = bpm;
    if (Number.isFinite(off)) st.song.offset = off;
    st.dirty = true;
    st.tm = new TempoMap(st.song.resolution, st.song.tempos);
    root.querySelector('.ed-title').textContent = st.song.meta.title;
    draw();
  }

  // ---------- simpan / export ----------

  async function save() {
    for (const p of Object.keys(st.song.parts)) for (const d of Object.keys(st.song.parts[p])) normalizeTrack(st.song.parts[p][d]);
    try {
      if (st.entry.source === 'builtin') {
        const copy = { id: uid('custom'), source: 'custom', audioRef: st.entry.audioRef, level: st.entry.level, song: cloneSong(st.song) };
        copy.song.meta.title = `${st.song.meta.title} (edit)`;
        await saveEntry(copy);
        st.entry = copy;
        st.song.meta.title = copy.song.meta.title;
        root.querySelector('.ed-title').textContent = copy.song.meta.title;
      } else {
        st.entry.song = cloneSong(st.song);
        if (st.entry.source === 'auto') st.entry.source = 'custom';
        await saveEntry(st.entry);
      }
      setTrack();
      st.dirty = false;
      host.app.selected = st.entry;
      toast('Chart tersimpan');
    } catch (err) {
      toast(`Gagal menyimpan: ${err.message}`, 5000);
    }
  }

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function exportChart() {
    const safe = (st.song.meta.title || 'chart').replace(/[^\w\- ]+/g, '').trim() || 'chart';
    const audioFiles = (st.entry.files || []).filter((f) => AUDIO_EXT.includes(extOf(f.name)));
    const copy = cloneSong(st.song);
    for (const p of Object.keys(copy.parts)) {
      for (const d of Object.keys(copy.parts[p])) {
        normalizeTrack(copy.parts[p][d]);
        if (!copy.parts[p][d].notes.length) delete copy.parts[p][d];
      }
    }
    const text = serializeChart(copy, audioFiles.length ? audioFiles[0].name : 'song.ogg');
    if (!audioFiles.length) {
      download(`${safe}.chart`, text, 'text/plain');
      toast('File .chart di-download (tanpa audio)');
      return;
    }
    const enc = new TextEncoder();
    const files = [
      { name: `${safe}/notes.chart`, data: enc.encode(text) },
      { name: `${safe}/song.ini`, data: enc.encode(serializeIni(copy)) },
    ];
    for (const f of audioFiles) {
      const blob = await getFile(st.entry, f.name);
      if (blob) files.push({ name: `${safe}/${f.name}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    download(`${safe}.zip`, writeZip(files), 'application/zip');
    toast('Folder lagu di-download sebagai .zip');
  }

  // ---------- playback ----------

  const shift = () => audio.outputLatency + (st.song.offset || 0);

  function startAudio() {
    const speed = parseFloat(root.querySelector('#ed-speed').value) || 1;
    st.player.play(st.time + shift(), speed);
    st.nextClick = lowerBound(st.track.notes, tickOfTime(st.time), (n) => n.tick);
  }

  function togglePlay() {
    audio.unlock();
    if (st.playing) stop();
    else {
      audio.setVolumes(0.9, 0.6);
      st.playing = true;
      startAudio();
      st.raf = requestAnimationFrame(frame);
    }
    updateButtons();
  }

  function stop() {
    st.playing = false;
    st.player.pause();
    cancelAnimationFrame(st.raf);
    st.padDown = {};
    updateButtons();
  }

  function frame() {
    if (!st.playing) return;
    st.time = st.player.timeAt(performance.now()) - shift();
    // bunyi klik saat note lewat playhead
    const notes = st.track.notes;
    const ahead = tickOfTime(st.time + 0.08);
    let lastTick = -1;
    while (st.nextClick < notes.length && notes[st.nextClick].tick <= ahead) {
      const n = notes[st.nextClick++];
      if (n.tick !== lastTick && !st.record) sfx.note(Math.max(0, st.tm.tickToTime(n.tick) - st.time));
      lastTick = n.tick;
    }
    if (st.time >= st.duration) stop();
    draw();
    st.raf = requestAnimationFrame(frame);
  }

  // ---------- gambar ----------

  function draw() {
    if (!g || !st.track) return;
    const { W, H } = st;
    g.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    g.fillStyle = '#0e0818';
    g.fillRect(0, 0, W, H);
    const res = st.song.resolution;
    const tTop = timeAtY(0);
    const tBot = timeAtY(H);
    const x0 = GUTTER;
    const x1 = W - MAP_W;

    // waveform
    if (st.peaks) {
      g.fillStyle = '#4a3477';
      const off = st.song.offset || 0;
      for (let y = 0; y < H; y += 2) {
        const i = Math.round((timeAtY(y) + off) * 100);
        if (i < 0 || i >= st.peaks.length) continue;
        const w = st.peaks[i] * (GUTTER - 4);
        g.fillRect(GUTTER - 2 - w, y, w, 2);
      }
    }

    // lane
    for (let l = 0; l <= 5; l++) {
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x0 + l * st.laneW, 0, 1, H);
    }

    // phrase Super
    const drawSp = (a, b, alpha) => {
      const ya = yOf(st.tm.tickToTime(a));
      const yb = yOf(st.tm.tickToTime(b));
      g.fillStyle = `rgba(34,230,210,${alpha})`;
      g.fillRect(x0, yb, x1 - x0, ya - yb);
    };
    for (const p of st.track.sp) drawSp(p.tick, p.tick + p.len, 0.16);
    if (st.drag && st.drag.mode === 'super' && st.drag.endTick !== undefined) {
      drawSp(Math.min(st.drag.tick, st.drag.endTick), Math.max(st.drag.tick, st.drag.endTick), 0.3);
    }

    // grid
    const sig = st.song.timeSigs[0] || { num: 4, den: 4 };
    const stepT = snapTicks();
    const first = Math.max(0, Math.floor(tickOfTime(tBot) / stepT) * stepT);
    const lastT = tickOfTime(tTop);
    const beatTicks = (res * 4) / sig.den;
    const dense = (st.tm.tickToTime(first + stepT) - st.tm.tickToTime(first)) * st.zoom < 7;
    g.font = '600 11px sans-serif';
    for (let tick = first; tick <= lastT; tick += stepT) {
      const onBeat = Math.abs(tick / beatTicks - Math.round(tick / beatTicks)) < 1e-6;
      if (dense && !onBeat) continue;
      const beat = Math.round(tick / beatTicks);
      const onBar = onBeat && beat % sig.num === 0;
      const y = Math.round(yOf(st.tm.tickToTime(tick)));
      g.fillStyle = onBar ? 'rgba(255,255,255,0.55)' : onBeat ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.09)';
      g.fillRect(x0, y, x1 - x0, onBar ? 2 : 1);
      if (onBar) {
        g.fillStyle = '#b3a6cf';
        g.fillText(String(beat / sig.num + 1), 3, y - 3);
      }
    }
    for (const s of st.song.sections) {
      const y = yOf(st.tm.tickToTime(s.tick));
      if (y < -10 || y > H + 10) continue;
      g.fillStyle = '#ffc629';
      g.fillText(s.name, x0 + 4, y - 4);
    }

    // note
    const notes = st.track.notes;
    const r = Math.min(st.laneW * 0.36, 17);
    const loTick = tickOfTime(tBot) - res * 16;
    for (const n of notes) {
      if (n.tick < loTick) continue;
      if (n.tick > lastT + res) break;
      const y = yOf(st.tm.tickToTime(n.tick));
      const open = n.fret === 5;
      const x = open ? (x0 + x1) / 2 : x0 + (n.fret + 0.5) * st.laneW;
      const color = open ? '#b06bff' : LANE_COLORS[n.fret];
      if (n.len > 0) {
        const ye = yOf(st.tm.tickToTime(n.tick + n.len));
        g.fillStyle = color;
        g.globalAlpha = 0.6;
        g.fillRect(x - (open ? (x1 - x0) / 2 - 6 : 5), ye, open ? x1 - x0 - 12 : 10, y - ye);
        g.globalAlpha = 1;
      }
      if (y < -20 || y > H + 20) continue;
      g.fillStyle = color;
      if (open) g.fillRect(x0 + 6, y - 5, x1 - x0 - 12, 10);
      else {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = n.tap ? '#0e0818' : '#ffffff';
        g.beginPath();
        g.arc(x, y, r * (n.tap ? 0.55 : 0.42), 0, Math.PI * 2);
        g.fill();
        if (n.mod === MOD_FLIP && !n.tap) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          g.beginPath();
          g.arc(x, y, r + 3, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }

    // playhead
    g.fillStyle = '#ffc629';
    g.fillRect(0, st.playY - 1, x1, 3);

    // minimap
    g.fillStyle = '#2c1b4d';
    g.fillRect(x1, 0, MAP_W, H);
    if (notes.length) {
      g.fillStyle = '#b3a6cf';
      const off = st.song.offset || 0;
      for (let i = 0; i < notes.length; i += Math.max(1, Math.floor(notes.length / 400))) {
        g.fillRect(x1 + 3, ((st.tm.tickToTime(notes[i].tick) + off) / st.duration) * H, MAP_W - 6, 1);
      }
    }
    g.fillStyle = '#ffc629';
    g.fillRect(x1, (Math.max(0, st.time) / st.duration) * H - 1, MAP_W, 3);

    const timeEl = root.querySelector('#ed-time');
    if (timeEl) timeEl.textContent = `${formatTime(Math.max(0, st.time))} / ${formatTime(st.duration)}`;
  }

  // ---------- keyboard ----------

  function onKey(e) {
    if (!st.open || !st.track || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (/^Digit[1-5]$/.test(e.code) && !e.repeat) padDown(parseInt(e.code.slice(5), 10) - 1);
    else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      const tick = snapTick(tickOfTime(st.time)) + (e.code === 'ArrowUp' ? 1 : -1) * snapTicks();
      seek(st.tm.tickToTime(Math.max(0, tick)));
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault();
      save();
    }
  }
  function onKeyUp(e) {
    if (st.open && /^Digit[1-5]$/.test(e.code)) padUp(parseInt(e.code.slice(5), 10) - 1);
  }

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', () => st.open && resize());

  return {
    open(arg) {
      st.open = true;
      if (arg && arg.entry) load(arg.entry, arg.part, arg.diff);
      else showPicker();
    },
    close() {
      st.open = false;
      stop();
      st.player.stop();
      st.track = null;
      root.innerHTML = '';
    },
  };
}
