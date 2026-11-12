// Entry point: navigasi antar screen dan alur main.

import { VERSION } from './version.js';
import { audio, sfx } from './audio/player.js';
import { Highway } from './game/highway.js';
import { Session } from './game/session.js';
import { missHaptic } from './game/haptics.js';
import { Engine, Bot, STAR_CUTOFFS } from './core/engine.js';
import { compileTrack, listCharts, DIFF_LABEL, PART_LABEL, DIFFS } from './core/chart.js';
import { formatScore, formatTime, hashString, uid, extOf } from './core/util.js';
import { settings, saveSettings, resetSettings, getScore, bestStars, submitScore, clearScores, DEFAULTS } from './store/settings.js';
import { builtins, listEntries, loadAudio, importFiles, saveEntry, deleteEntry, decodeBlob, getArtUrl, titleFromName, pullEntry, pushToCloud, cloud } from './store/library.js';
import { autoChart } from './audio/analysis.js';
import { GAME_REPO } from './store/cloud.js';
import { separate, STEMS, stemFromName, STEM_LABEL } from './audio/separate.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const app = {
  screen: 'menu',
  entries: [],
  selected: null,
  part: 'guitar',
  diff: 'medium',
  speed: 1,
  session: null,
  highway: null,
  bot: new URLSearchParams(location.search).has('bot'),
};
window.superBand = app;

// ---------------------------------------------------------------------
// helper UI

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function showLoading(text, value = 0) {
  $('#loading').hidden = false;
  $('#loading-text').textContent = text;
  $('#loading-bar').style.width = `${Math.round(value * 100)}%`;
}

export function hideLoading() {
  $('#loading').hidden = true;
}

function starsHtml(n, total = 5) {
  let s = '';
  for (let i = 0; i < total; i++) s += `<i class="${i < n ? 'on' : ''}">★</i>`;
  return s;
}

function coverStyle(entry) {
  const h = hashString(entry.song.meta.title + entry.song.meta.artist);
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `background-image:linear-gradient(${(h >> 4) % 180}deg,hsl(${a} 85% 62%),hsl(${b} 80% 48%))`;
}

export function go(name, arg) {
  if (app.screen === 'game' && name !== 'game') endSession();
  if (app.screen === 'editor' && name !== 'editor' && app.editor) app.editor.close();
  if (app.screen === 'add' && name !== 'add') stopPreview();
  app.screen = name;
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('is-active', el.id === `screen-${name}`);
  document.body.classList.toggle('in-game', name === 'game' || name === 'editor');
  document.body.classList.toggle('dim-stage', name !== 'game');
  $('#stage').style.visibility = name === 'menu' || name === 'game' ? 'visible' : 'hidden';
  if (name === 'songs') renderSongs(arg);
  else if (name === 'settings') renderSettings();
  else if (name === 'help') renderHelp();
  else if (name === 'calibrate') resetCalibration();
  else if (name === 'add') setStatus('');
  else if (name === 'editor') openEditor(arg);
}
app.go = go;

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (!btn) return;
  audio.unlock();
  sfx.click();
  go(btn.dataset.go);
});

// ---------------------------------------------------------------------
// demo di belakang menu

const demo = { track: null, engine: null, bot: null, t0: 0 };

function demoFrame() {
  requestAnimationFrame(demoFrame);
  if (app.screen !== 'menu' || document.hidden) return;
  if (!demo.track) {
    demo.track = compileTrack(builtins()[1].song, 'guitar', 'hard');
    demo.t0 = performance.now() / 1000 + 1;
  }
  let t = performance.now() / 1000 - demo.t0;
  if (!demo.engine || t > demo.track.endTime + 1) {
    demo.t0 = performance.now() / 1000 + 1;
    t = -1;
    demo.engine = new Engine(demo.track, { mode: 'tap' });
    demo.bot = new Bot(demo.engine);
  }
  demo.bot.update(t);
  demo.engine.update(t);
  app.highway.lefty = false;
  app.highway.draw({ time: t, track: demo.track, engine: demo.engine, lookahead: 1.6, superActive: demo.engine.superActive, superReady: false });
}

// ---------------------------------------------------------------------
// pilih lagu

async function renderSongs(selectId) {
  app.entries = await listEntries();
  if (selectId) app.selected = app.entries.find((e) => e.id === selectId) || app.selected;
  if (!app.selected || !app.entries.includes(app.selected)) {
    app.selected = app.entries.find((e) => app.selected && e.id === app.selected.id) || app.entries[0];
  }
  const list = $('#song-list');
  list.innerHTML = app.entries
    .map((e) => {
      const m = e.song.meta;
      const best = bestStars(e.id);
      const tag = e.source === 'builtin' ? 'Original' : e.source === 'auto' ? 'Auto-chart' : e.source === 'custom' ? 'Chart sendiri' : 'Import';
      const where = e.remote ? ', belum diunduh' : '';
      return `<li><button class="song${e === app.selected ? ' is-selected' : ''}" data-id="${esc(e.id)}">
        <span class="cover" style="${coverStyle(e)}" data-cover="${esc(e.id)}">${esc((m.title || '?')[0].toUpperCase())}</span>
        <span><span class="song-title">${esc(m.title)}</span><br><span class="song-sub">${esc(m.artist)}, ${tag}${e.cloud ? ' <b class="cloud-tag">collection</b>' : ''}${where}</span></span>
        <span class="song-stars${best && best.gold ? ' is-gold' : ''}">${best ? '★'.repeat(best.stars) : ''}</span>
      </button></li>`;
    })
    .join('');
  for (const e of app.entries) {
    if (e.source !== 'import') continue;
    getArtUrl(e).then((url) => {
      const el = list.querySelector(`[data-cover="${CSS.escape(e.id)}"]`);
      if (url && el) {
        el.style.backgroundImage = `url(${url})`;
        el.textContent = '';
      }
    });
  }
  renderDetail();
}

$('#song-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.song');
  if (!btn) return;
  app.selected = app.entries.find((x) => x.id === btn.dataset.id);
  for (const el of document.querySelectorAll('.song')) el.classList.toggle('is-selected', el === btn);
  sfx.click();
  if (app.selected && app.selected.remote) {
    const remote = app.selected;
    showLoading('Mengambil chart dari collection', 0.3);
    try {
      const full = await pullEntry(remote);
      app.entries[app.entries.indexOf(remote)] = full;
      if (app.selected === remote) app.selected = full;
      hideLoading();
      return renderSongs(full.id);
    } catch (err) {
      hideLoading();
      toast(err.message, 5000);
    }
  }
  renderDetail();
});

function renderDetail() {
  const box = $('#song-detail');
  const e = app.selected;
  if (!e) {
    box.innerHTML = '';
    return;
  }
  const charts = listCharts(e.song);
  if (!charts.length) {
    box.innerHTML = `<div class="detail-head"><b>${esc(e.song.meta.title)}</b><span></span></div>
      <div class="best">Chart ini masih kosong. Isi note-nya di editor dulu.</div>
      <div class="detail-actions"><button class="btn btn-primary" id="btn-edit">Edit chart</button><span></span>
      <button class="btn btn-quiet btn-danger" id="btn-delete">Hapus</button></div>`;
    return;
  }
  const parts = [...new Set(charts.map((c) => c.part))];
  if (!parts.includes(app.part)) app.part = parts[0];
  const diffs = charts.filter((c) => c.part === app.part);
  if (!diffs.some((c) => c.diff === app.diff)) {
    app.diff = (diffs.find((c) => c.diff === 'medium') || diffs[0]).diff;
  }
  const track = compileTrack(e.song, app.part, app.diff);
  const best = getScore(e.id, app.part, app.diff);
  const level = e.level ? `Level ${'●'.repeat(e.level)}${'○'.repeat(5 - e.level)}` : '';
  box.innerHTML = `
    <div class="detail-head"><b>${esc(e.song.meta.title)}</b><span>${formatTime(track.endTime)} ${level}</span></div>
    ${parts.length > 1 ? `<div class="chips">${parts.map((p) => `<button class="chip${p === app.part ? ' is-on' : ''}" data-part="${p}">${PART_LABEL[p]}</button>`).join('')}</div>` : ''}
    <div class="chips">${DIFFS.filter((d) => diffs.some((c) => c.diff === d))
      .map((d) => `<button class="chip${d === app.diff ? ' is-on' : ''}" data-diff="${d}">${DIFF_LABEL[d]}<small>${diffs.find((c) => c.diff === d).notes}</small></button>`)
      .join('')}</div>
    <div class="chips">${[1, 0.75, 0.5].map((s) => `<button class="chip${s === app.speed ? ' is-on' : ''}" data-speed="${s}">${s === 1 ? 'Tempo asli' : `Latihan ${s * 100}%`}</button>`).join('')}</div>
    <div class="best">${best ? `Skor terbaik ${formatScore(best.score)}, ${Math.round(best.accuracy * 100)}% kena${best.fullCombo ? ', full combo' : ''}` : 'Belum pernah dimainkan di difficulty ini'}</div>
    <div class="detail-actions">
      <button class="btn btn-primary" id="btn-play">Main</button>
      <button class="btn btn-quiet" id="btn-edit">Edit chart</button>
      ${e.source !== 'builtin' ? '<button class="btn btn-quiet btn-danger" id="btn-delete">Hapus</button>' : ''}
    </div>`;
}

$('#song-detail').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  audio.unlock();
  if (t.dataset.part) app.part = t.dataset.part;
  else if (t.dataset.diff) app.diff = t.dataset.diff;
  else if (t.dataset.speed) app.speed = parseFloat(t.dataset.speed);
  else if (t.id === 'btn-play') return startGame();
  else if (t.id === 'btn-edit') return go('editor', { entry: app.selected, part: app.part, diff: app.diff });
  else if (t.id === 'btn-delete') {
    if (!confirm(`Hapus "${app.selected.song.meta.title}" dari library${app.selected.cloud ? ' dan dari collection di semua device' : ''}?`)) return;
    await deleteEntry(app.selected);
    app.selected = null;
    toast('Lagu dihapus');
    return renderSongs();
  }
  sfx.click();
  renderDetail();
});

// ---------------------------------------------------------------------
// gameplay

const hud = {};
let hudCache = {};

async function startGame() {
  const entry = app.selected;
  if (!entry) return;
  await audio.unlock();
  let loaded;
  try {
    showLoading(entry.audioRef ? 'Band lagi soundcheck' : 'Membuka audio', 0);
    loaded = await loadAudio(entry, app.part, (v) => showLoading(entry.audioRef ? 'Band lagi soundcheck' : 'Membuka audio', v));
  } catch (err) {
    hideLoading();
    toast(err.message, 5000);
    return;
  }
  hideLoading();
  const track = compileTrack(entry.song, app.part, app.diff);
  go('game');
  app.highway.resize();
  hudCache = {};
  hud.grade.textContent = '';
  hud.combo.textContent = '';
  hud.plus.textContent = '';
  $('#pause-overlay').hidden = true;
  app.session = new Session({
    highway: app.highway,
    surface: $('#touch'),
    track,
    songOffset: entry.song.offset || 0,
    backing: loaded.backing,
    instrument: loaded.instrument,
    speed: app.speed,
    bot: app.bot,
    onFrame: updateHud,
    onEvent: gameEvent,
    onPause: pauseGame,
    onFinish: (res) => showResults(entry, res),
  });
  app.session.start();
}

function endSession() {
  if (app.session) app.session.destroy();
  app.session = null;
  $('#hud-count').textContent = '';
}

function setText(key, el, value) {
  if (hudCache[key] === value) return;
  hudCache[key] = value;
  el.textContent = value;
}

function updateHud(t, eng) {
  const s = app.session;
  setText('score', hud.score, formatScore(eng.score));
  setText('streak', hud.streak, String(eng.streak));
  const m = eng.multiplier;
  if (hudCache.mult !== m || hudCache.sup !== eng.superActive) {
    hudCache.mult = m;
    hudCache.sup = eng.superActive;
    hud.mult.textContent = `x${m}`;
    hud.mult.dataset.m = String(Math.min(4, eng.superActive ? m / 2 : m));
    hud.mult.classList.toggle('is-super', eng.superActive);
  }
  const sp = Math.round(eng.super * 100);
  if (hudCache.sp !== sp) {
    hudCache.sp = sp;
    hud.super.style.height = `${sp}%`;
  }
  const ready = eng.superReady;
  if (hudCache.ready !== ready) {
    hudCache.ready = ready;
    hud.superBtn.disabled = !ready;
  }
  const prog = Math.max(0, Math.min(100, Math.round((t / s.endAt) * 100)));
  if (hudCache.prog !== prog) {
    hudCache.prog = prog;
    hud.progress.style.width = `${prog}%`;
  }
  const ratio = eng.score / eng.fcScore;
  let stars = 0;
  for (const c of STAR_CUTOFFS) if (ratio >= c) stars++;
  if (hudCache.stars !== stars) {
    if (hudCache.stars !== undefined && stars > hudCache.stars) sfx.star();
    hudCache.stars = stars;
    hud.stars.innerHTML = starsHtml(stars);
  }
  let sec = '';
  for (const x of s.track.sections) {
    if (x.time <= t + 0.2) sec = x.name;
    else break;
  }
  setText('sec', hud.section, sec);
  const lead = t < 0 ? Math.ceil(-t / s.speed) : 0;
  setText('count', hud.count, lead > 0 && lead <= 3 ? String(lead) : '');
}

let feedbackTimer = 0;
function feedback(text) {
  const el = hud.feedback;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    el.textContent = '';
    el.classList.remove('show');
  }, 950);
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

const GRADE_TEXT = { perfect: 'Perfect', great: 'Great', cool: 'Cool', miss: 'Miss' };

function restart(el) {
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function judge(grade, combo, points) {
  hud.grade.textContent = GRADE_TEXT[grade];
  hud.grade.dataset.g = grade;
  restart(hud.grade);
  hud.combo.innerHTML = combo >= 2 ? `<b>${combo}</b> combo` : '';
  if (points) {
    hud.plus.textContent = `+${formatScore(points)}`;
    restart(hud.plus);
  }
}

function gameEvent(type, data) {
  const eng = app.session.engine;
  if (type === 'hit') judge(data.grade, eng.streak, data.points);
  else if (type === 'miss') judge('miss', 0, 0);
  else if (type === 'ghost' && data.lost > 0) judge('miss', 0, 0);
  if (type === 'mult' && data.mult === 4) feedback('Gokil!');
  else if (type === 'hit' && eng.streak > 0 && eng.streak % 50 === 0) feedback(`${eng.streak} streak!`);
  else if (type === 'superStart') feedback('Super mode!');
  else if (type === 'superReady') feedback('Super siap!');
  else if ((type === 'miss' || type === 'ghost') && data.lost >= 30) feedback('Ambyar!');
  if (settings.haptics && type === 'miss') missHaptic();
}

function pauseGame() {
  if (!app.session || !app.session.running) return;
  app.session.pause();
  $('#pause-overlay').hidden = false;
}

function resumeGame() {
  $('#pause-overlay').hidden = true;
  let n = 3;
  const tick = () => {
    if (!app.session || app.screen !== 'game') return;
    if (n === 0) {
      hud.count.textContent = '';
      hudCache.count = '';
      app.session.resume();
      return;
    }
    hud.count.textContent = String(n--);
    sfx.tick(n === 0);
    setTimeout(tick, 550);
  };
  tick();
}

function showResults(entry, res) {
  const practice = app.speed < 1 || app.bot;
  const sub = practice ? { isBest: false } : submitScore(entry.id, app.part, app.diff, res);
  const verdict = res.gold ? 'Sempurna!' : ['Latihan lagi yuk', 'Latihan lagi yuk', 'Boleh juga', 'Lumayan!', 'Mantap!', 'Gokil!'][res.stars];
  const off = Math.round(res.avgOffsetMs);
  const timing = res.hits ? (Math.abs(off) < 8 ? 'pas' : `${Math.abs(off)} ms ${off < 0 ? 'kecepatan' : 'telat'}`) : '-';
  let note = '';
  if (practice) note = app.bot ? 'Mode demo, skor tidak disimpan.' : 'Mode latihan, skor tidak disimpan.';
  else if (sub.isBest) note = 'Skor terbaik baru!';
  if (res.hits > 20 && Math.abs(off) >= 30) note += ` Rata-rata tap kamu ${timing}. Coba Kalibrasi audio di Settings.`;
  $('#results').innerHTML = `
    <div class="verdict">${verdict}</div>
    <div class="res-stars${res.gold ? ' is-gold' : ''}">${starsHtml(res.stars)}</div>
    <div><div class="song-sub">${esc(entry.song.meta.title)}, ${DIFF_LABEL[app.diff]}</div><div class="res-score">${formatScore(res.score)}</div></div>
    <div class="res-grid">
      <div>Perfect <b>${res.perfect}</b></div>
      <div>Great <b>${res.great}</b></div>
      <div>Cool <b>${res.cool}</b></div>
      <div>Miss <b>${res.misses}</b></div>
      <div>Notes kena <b>${res.hits}/${res.total}</b></div>
      <div>Akurasi <b>${Math.round(res.accuracy * 100)}%</b></div>
      <div>Combo terpanjang <b>${res.maxStreak}</b></div>
      <div>Salah tekan <b>${res.ghosts}</b></div>
      <div>Super dipakai <b>${res.superUses}x</b></div>
      <div>Timing <b>${timing}</b></div>
    </div>
    <div class="res-note">${note}</div>
    <button class="btn btn-primary" id="btn-again">Main lagi</button>
    <button class="btn" id="btn-list">Pilih lagu lain</button>`;
  go('results');
  if (res.stars >= 3) sfx.star();
}

$('#results').addEventListener('click', (e) => {
  if (e.target.id === 'btn-again') startGame();
  else if (e.target.id === 'btn-list') go('songs');
});

// ---------------------------------------------------------------------
// tambah lagu

function setStatus(text, error = false) {
  const el = $('#add-status');
  el.textContent = text;
  el.classList.toggle('is-error', error);
}

async function handleImport(files) {
  if (!files.length) return;
  showLoading('Membaca file', 0);
  try {
    const res = await importFiles(files, (v) => showLoading('Membaca file', v));
    hideLoading();
    if (res.imported.length) {
      toast(`${res.imported.length} lagu masuk library`);
      if (res.errors.length) setStatus(res.errors.join('\n'), true);
      else return go('songs', res.imported[0].id);
    } else if (res.audioOnly.length) {
      return handleAutoChart(res.audioOnly);
    } else setStatus(res.errors.join('\n') || 'Tidak ada chart yang ditemukan di file itu.', true);
  } catch (err) {
    hideLoading();
    setStatus(`Import gagal: ${err.message}`, true);
  }
}

// Auto-chart: user memilih instrumen yang dijadikan frets.
// Satu file  -> instrumen dipisah kasar dengan filter (separate.js).
// Multi-file -> file stem asli (mvsep, Demucs, ...) dikenali dari nama filenya.
const split = { files: [], mix: null, stems: {}, bufs: new Map(), kind: 'guitar', node: null, multi: false };

const SPLIT_HINT = {
  all: 'Note mengikuti semua bunyi di lagu. Paling ramai, cocok kalau instrumennya sulit dipisah.',
  guitar: 'Mengambil bunyi bernada yang posisinya di kiri/kanan stereo, biasanya gitar dan keyboard.',
  bass: 'Mengambil nada rendah di tengah. Hasilnya paling kasar, sering butuh dirapikan di editor.',
  drums: 'Mengambil bunyi pukulan. Kick cenderung di lane kiri, cymbal di kanan.',
  vocals: 'Mengambil bunyi bernada di tengah stereo, biasanya vokal utama. Note mengikuti nyanyian.',
};

function channelsOf(buf) {
  const out = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) out.push(buf.getChannelData(c));
  return out;
}

async function bufOf(file) {
  if (!split.bufs.has(file)) {
    // simpan satu hasil decode saja supaya memori HP tidak habis
    split.bufs.clear();
    split.bufs.set(file, await decodeBlob(file));
  }
  return split.bufs.get(file);
}

function stopPreview() {
  if (split.node) {
    try {
      split.node.stop();
    } catch (err) {
      /* sudah berhenti */
    }
    split.node = null;
  }
  $('#split-preview').textContent = split.multi ? 'Dengarkan stem ini' : 'Dengarkan hasil pisah';
}

function renderSplit() {
  const options = split.multi
    ? [...(split.mix ? [['all', 'Semua instrumen']] : []), ...Object.keys(split.stems).map((k) => [k, STEM_LABEL[k]])]
    : STEMS;
  if (!options.some((o) => o[0] === split.kind)) split.kind = (options.find((o) => o[0] === 'guitar') || options[0])[0];
  $('#split-chips').innerHTML = options.map(([k, label]) => `<button class="chip${k === split.kind ? ' is-on' : ''}" data-stem="${k}">${label}</button>`).join('');
  let hint;
  if (split.multi) {
    const stemCount = Object.keys(split.stems).length;
    const playsStems = !split.mix || stemCount >= 4 || split.stems.other;
    hint = split.kind === 'all' ? 'Note mengikuti semua bunyi di lagu lengkap.' : `Frets dibuat langsung dari file stem ${STEM_LABEL[split.kind].toLowerCase()}.`;
    if (split.kind !== 'all') {
      hint += playsStems
        ? ' Saat main, stem ini di-mute kalau kamu miss.'
        : ' Saat main yang diputar lagu lengkapnya. Supaya instrumen ini bisa di-mute saat miss, upload juga semua stem lainnya.';
    }
    if (!split.mix) hint += ' Tidak ada file lagu lengkap, jadi yang diputar gabungan semua stem.';
  } else hint = SPLIT_HINT[split.kind];
  $('#split-hint').textContent = hint;
}

async function handleAutoChart(input) {
  const files = Array.isArray(input) ? input : [input];
  if (!files.length) return;
  await audio.unlock();
  stopPreview();
  split.files = files;
  split.bufs.clear();
  split.stems = {};
  split.mix = null;
  for (const f of files) {
    const kind = stemFromName(f.name);
    if (kind && !split.stems[kind]) split.stems[kind] = f;
    else if (!kind && !split.mix) split.mix = f;
  }
  split.multi = Object.keys(split.stems).length > 0 && files.length > 1;
  if (!split.multi) {
    split.mix = files[0];
    split.stems = {};
  }
  showLoading('Membuka audio', 0);
  try {
    const first = split.mix || Object.values(split.stems)[0];
    const buf = await bufOf(first);
    hideLoading();
    setStatus('');
    const names = split.multi
      ? `${split.mix ? `Lagu lengkap: ${split.mix.name}. ` : ''}Stem: ${Object.keys(split.stems).map((k) => STEM_LABEL[k]).join(', ')}.`
      : `${first.name}, ${formatTime(buf.duration)}`;
    $('#split-file').textContent = names;
    $('#split-panel').hidden = false;
    renderSplit();
    stopPreview();
    $('#split-panel').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    hideLoading();
    setStatus(`Audio tidak bisa dibuka: ${err.message || 'format tidak didukung browser ini'}. Coba MP3 atau M4A.`, true);
  }
}

$('#split-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-stem]');
  if (!chip) return;
  split.kind = chip.dataset.stem;
  stopPreview();
  sfx.click();
  renderSplit();
});

$('#split-preview').addEventListener('click', async () => {
  if (split.node) return stopPreview();
  if (!split.files.length) return;
  await audio.unlock();
  $('#split-preview').textContent = 'Menyiapkan';
  try {
    const realStem = split.multi && split.kind !== 'all' ? split.stems[split.kind] : null;
    const buf = await bufOf(realStem || split.mix);
    const from = Math.max(0, Math.min(buf.duration - 12, buf.duration * 0.3));
    const st = await separate(channelsOf(buf), buf.sampleRate, realStem || split.multi ? 'all' : split.kind, null, [from, from + 12]);
    let peak = 0.01;
    for (let i = 0; i < st.signal.length; i += 3) peak = Math.max(peak, Math.abs(st.signal[i]));
    const out = audio.ctx.createBuffer(1, st.signal.length, st.sampleRate);
    const d = out.getChannelData(0);
    const gain = Math.min(8, 0.7 / peak);
    for (let i = 0; i < d.length; i++) d[i] = st.signal[i] * gain;
    audio.setVolumes(settings.musicVolume, settings.sfxVolume);
    const node = audio.ctx.createBufferSource();
    node.buffer = out;
    node.connect(audio.music);
    node.onended = () => split.node === node && stopPreview();
    node.start();
    split.node = node;
    $('#split-preview').textContent = 'Stop';
  } catch (err) {
    stopPreview();
    setStatus(`Preview gagal: ${err.message || 'audio tidak bisa dibuka'}`, true);
  }
});

// mono 22 kHz dari satu file, untuk analisis
async function monoOf(file) {
  const buf = await bufOf(file);
  return separate(channelsOf(buf), buf.sampleRate, 'all');
}

$('#split-go').addEventListener('click', async () => {
  if (!split.files.length) return;
  stopPreview();
  const kind = split.kind;
  try {
    let stem = null;
    let mixSig;
    let label;
    const saved = [];
    let play = null;
    const extName = (base, f) => `${base}.${extOf(f.name) || 'mp3'}`;
    if (split.multi) {
      label = kind === 'all' ? 'Semua instrumen' : STEM_LABEL[kind];
      if (kind !== 'all') {
        showLoading(`Membaca stem ${label.toLowerCase()}`, 0.1);
        stem = await monoOf(split.stems[kind]);
        stem.kind = kind === 'piano' || kind === 'other' ? 'guitar' : kind;
      }
      if (split.mix) {
        showLoading('Membaca lagu lengkap', 0.3);
        mixSig = await monoOf(split.mix);
      } else {
        // tanpa lagu lengkap: tempo dihitung dari gabungan semua stem
        const keys = Object.keys(split.stems);
        for (let i = 0; i < keys.length; i++) {
          showLoading('Menggabungkan stem', i / keys.length);
          const m = await monoOf(split.stems[keys[i]]);
          if (!mixSig) mixSig = m;
          else for (let k = 0; k < Math.min(mixSig.signal.length, m.signal.length); k++) mixSig.signal[k] += m.signal[k];
        }
      }
      const stemNames = Object.fromEntries(Object.entries(split.stems).map(([k, f]) => [k, extName(k, f)]));
      const others = Object.keys(split.stems).filter((k) => k !== kind);
      const playsStems = !split.mix || Object.keys(split.stems).length >= 4 || split.stems.other;
      if (kind !== 'all' && playsStems && others.length) {
        play = { instrument: [stemNames[kind]], backing: others.map((k) => stemNames[k]) };
        for (const k of Object.keys(split.stems)) saved.push({ name: stemNames[k], blob: split.stems[k] });
      } else if (split.mix) {
        play = { instrument: [], backing: [extName('song', split.mix)] };
        saved.push({ name: extName('song', split.mix), blob: split.mix });
      } else {
        play = { instrument: [], backing: Object.values(stemNames) };
        for (const k of Object.keys(split.stems)) saved.push({ name: stemNames[k], blob: split.stems[k] });
      }
    } else {
      label = STEMS.find((x) => x[0] === kind)[1];
      const buf = await bufOf(split.mix);
      const channels = channelsOf(buf);
      if (kind !== 'all') {
        showLoading(`Memisahkan ${label.toLowerCase()}`, 0);
        stem = await separate(channels, buf.sampleRate, kind, (v) => showLoading(`Memisahkan ${label.toLowerCase()}`, v));
        stem.kind = kind;
      }
      mixSig = await separate(channels, buf.sampleRate, 'all');
      saved.push({ name: extName('song', split.mix), blob: split.mix });
    }
    split.bufs.clear();
    const nameSource = split.mix || split.files[0];
    const meta = titleFromName(nameSource.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_\-. (]*(guitar|bass|drums?|vocals?|piano|keys|other|instrum\w*)\)?$/i, ''));
    const song = await autoChart([mixSig.signal], mixSig.sampleRate, meta, (v) => showLoading('Mendengarkan ketukan lagu', v), { stem });
    song.meta.album = '';
    if (kind !== 'all') song.meta.title = `${song.meta.title} (${label})`;
    const entry = { id: uid('auto'), source: 'auto', song };
    if (play) entry.play = play;
    await saveEntry(entry, saved);
    hideLoading();
    split.files = [];
    $('#split-panel').hidden = true;
    toast(`Chart jadi, tempo ${Math.round(song.detectedBpm)} BPM`);
    go('songs', entry.id);
  } catch (err) {
    hideLoading();
    setStatus(`Chart gagal dibuat: ${err.message || 'audio tidak bisa dibuka'}`, true);
  }
});

for (const id of ['#file-import', '#dir-import']) {
  $(id).addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    handleImport(files);
  });
}
$('#file-audio').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) handleAutoChart(files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (app.screen === 'game' || !e.dataTransfer.files.length) return;
  go('add');
  handleImport([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------------
// settings

const KEY_LABEL = (code) => code.replace(/^Key|^Digit/, '').replace('Arrow', '');

function renderSettings() {
  const s = settings;
  const range = (key, label, min, max, step, fmt, hint = '') => `
    <div class="field"><label for="set-${key}">${label}</label><output id="out-${key}">${fmt(s[key])}</output>
    <input type="range" id="set-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}">${hint ? `<small>${hint}</small>` : ''}</div>`;
  const toggle = (key, label, hint = '') => `
    <div class="field"><label for="set-${key}">${label}</label><input type="checkbox" class="switch" id="set-${key}" data-key="${key}" ${s[key] ? 'checked' : ''}>${hint ? `<small>${hint}</small>` : ''}</div>`;
  const select = (key, label, opts, hint = '') => `
    <div class="field"><label for="set-${key}">${label}</label><select id="set-${key}" data-key="${key}">${opts.map(([v, t]) => `<option value="${v}" ${s[key] === v ? 'selected' : ''}>${t}</option>`).join('')}</select>${hint ? `<small>${hint}</small>` : ''}</div>`;
  $('#settings-body').innerHTML = `
    <div class="panel"><h3>Gameplay</h3>
      ${range('noteSpeed', 'Kecepatan note', 1, 10, 1, (v) => v, 'Makin besar makin cepat dan makin renggang.')}
      ${select('hitWindow', 'Toleransi timing', [['relaxed', 'Longgar'], ['normal', 'Normal'], ['strict', 'Ketat']])}
      ${select('playMode', 'Cara main', [['tap', 'Tap: tekan lane langsung'], ['strum', 'Strum: tahan fret lalu strum']], 'Strum untuk guitar controller atau keyboard. Layar sentuh pakai Tap.')}
      ${toggle('ghostPenalty', 'Salah tekan memutus streak')}
      ${toggle('lefty', 'Lefty flip', 'Urutan lane dibalik.')}
      ${toggle('tapHighwayForSuper', 'Tap highway untuk Super mode')}
    </div>
    <div class="panel"><h3>Audio</h3>
      ${range('audioOffsetMs', 'Audio offset', -300, 300, 5, (v) => `${v} ms`, 'Naikkan kalau note terasa datang lebih dulu dari musiknya.')}
      <button class="btn" data-go="calibrate">Kalibrasi audio</button>
      ${range('musicVolume', 'Volume musik', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
      ${range('sfxVolume', 'Volume efek', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
      ${toggle('hapticTap', 'Getar saat tombol ditekan', 'Getar kecil tiap tap tombol fret di layar. Di iPhone butuh iOS 18 atau lebih baru.')}
      ${toggle('haptics', 'Getar saat miss', 'Android saja, iPhone tidak mendukung.')}
    </div>
    <div class="panel"><h3>Keyboard dan gamepad</h3>
      <div class="label">Tombol fret (tap untuk ganti)</div>
      <div class="keys">${s.keys.frets.map((k, i) => `<button class="keycap" data-fret="${i}">${KEY_LABEL(k[0])}</button>`).join('')}</div>
      <small class="hint">Strum: panah atas/bawah. Super: Space. Pause: Esc.</small>
      ${select('gamepadPreset', 'Layout gamepad', [['pad', 'Gamepad: LT LB RB RT A'], ['guitar', 'Guitar controller']])}
    </div>
    <div class="panel" id="cloud-panel">${cloudPanelHtml()}</div>
    <div class="panel"><h3>Data</h3>
      <button class="btn" id="btn-reset-settings">Kembalikan settings awal</button>
      <button class="btn btn-danger" id="btn-clear-scores">Hapus semua skor</button>
    </div>`;
}

$('#settings-body').addEventListener('input', (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  const el = e.target;
  if (el.type === 'checkbox') settings[key] = el.checked;
  else if (el.type === 'range') {
    settings[key] = parseFloat(el.value);
    const out = $(`#out-${key}`);
    if (out) out.textContent = key === 'audioOffsetMs' ? `${el.value} ms` : key.endsWith('Volume') ? `${Math.round(el.value * 100)}%` : el.value;
  } else settings[key] = el.value;
  saveSettings();
  if (audio.ctx) audio.setVolumes(settings.musicVolume, settings.sfxVolume);
});

let waitingKey = null;
$('#settings-body').addEventListener('click', (e) => {
  const cap = e.target.closest('.keycap');
  if (cap) {
    for (const el of document.querySelectorAll('.keycap')) el.classList.remove('is-wait');
    cap.classList.add('is-wait');
    cap.textContent = '...';
    waitingKey = parseInt(cap.dataset.fret, 10);
    return;
  }
  if (e.target.id === 'btn-reset-settings') {
    resetSettings();
    renderSettings();
    toast('Settings dikembalikan');
  } else if (e.target.id === 'btn-clear-scores') {
    if (confirm('Hapus semua skor tersimpan?')) {
      clearScores();
      toast('Skor dihapus');
    }
  }
});
window.addEventListener('keydown', (e) => {
  if (waitingKey === null || app.screen !== 'settings') return;
  e.preventDefault();
  if (e.code !== 'Escape') {
    for (const pair of settings.keys.frets) if (pair[0] === e.code) pair[0] = '';
    settings.keys.frets[waitingKey][0] = e.code;
    for (let i = 0; i < 5; i++) if (!settings.keys.frets[i][0]) settings.keys.frets[i][0] = DEFAULTS.keys.frets[i][0];
    saveSettings();
  }
  waitingKey = null;
  renderSettings();
});

// ---------------------------------------------------------------------
// collection pribadi

let cloudMode = 'login';

function cloudPanelHtml() {
  if (cloud.loggedIn) {
    return `<h3>Collection pribadi</h3>
      <p>Login sebagai <b>${esc(cloud.session.username)}</b>. Lagu yang kamu tambahkan tersimpan di repo private <b>${esc(cloud.session.repo)}</b> dan muncul di semua device yang login dengan akun ini.</p>
      <div id="cloud-sync" class="sync" hidden><div class="sync-label" id="cloud-sync-label"></div><div class="progress"><i id="cloud-sync-bar"></i></div></div>
      <button class="btn" id="cloud-upload-all">Upload lagu lama di device ini ke collection</button>
      <button class="btn btn-quiet" id="cloud-logout">Logout dari device ini</button>
      <div class="status" id="cloud-status"></div>`;
  }
  if (cloudMode === 'setup') {
    return `<h3>Setup collection pribadi</h3>
      <p>Cukup sekali di satu device. Siapkan dulu repo GitHub <b>private</b> kosong untuk menyimpan lagu, lalu buat <b>fine-grained token</b> di GitHub, Settings, Developer settings, dengan akses ke repo itu dan ke <b>${esc(GAME_REPO)}</b>, izin <b>Contents: Read and write</b>.</p>
      <form class="ed-form" id="cloud-setup">
        <input type="text" name="repo" placeholder="Repo private, contoh: zenaki/super-band-library" autocomplete="off" required>
        <input type="password" name="token" placeholder="GitHub token (github_pat_...)" autocomplete="off" required>
        <input type="text" name="username" placeholder="Username baru" autocomplete="username" required>
        <input type="password" name="password" placeholder="Password baru, minimal 12 karakter" autocomplete="new-password" required>
        <input type="password" name="password2" placeholder="Ulangi password" autocomplete="new-password" required>
        <button class="btn btn-primary" type="submit">Simpan dan login</button>
      </form>
      <button class="btn btn-quiet" id="cloud-to-login">Sudah pernah setup? Login</button>
      <div class="status" id="cloud-status"></div>`;
  }
  return `<h3>Collection pribadi</h3>
    <p>Login supaya lagu yang kamu tambahkan selalu ada di device mana pun.</p>
    <form class="ed-form" id="cloud-login">
      <input type="text" name="username" placeholder="Username" autocomplete="username" required>
      <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
      <button class="btn btn-primary" type="submit">Login</button>
    </form>
    <button class="btn btn-quiet" id="cloud-to-setup">Belum punya akun? Setup pertama kali</button>
    <div class="status" id="cloud-status"></div>`;
}

function refreshCloudPanel(status, error = false) {
  const panel = $('#cloud-panel');
  if (!panel) return;
  panel.innerHTML = cloudPanelHtml();
  if (status) {
    const el = $('#cloud-status');
    el.textContent = status;
    el.classList.toggle('is-error', error);
  }
}

function cloudStatus(text, error = false) {
  const el = $('#cloud-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', error);
}

$('#settings-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (e.target.id === 'cloud-login') {
      cloudStatus('Membuka akun');
      await cloud.login(f.get('username'), f.get('password'));
      refreshCloudPanel('Login berhasil. Collection kamu muncul di daftar lagu.');
    } else if (e.target.id === 'cloud-setup') {
      if (f.get('password') !== f.get('password2')) throw new Error('Kedua password tidak sama.');
      cloudStatus('Mengecek token dan repo');
      await cloud.setup({ username: f.get('username'), password: f.get('password'), token: f.get('token'), repo: f.get('repo') });
      refreshCloudPanel('Setup selesai. Di device lain, cukup login dengan username dan password ini (butuh 1–2 menit sampai aktif).');
    }
  } catch (err) {
    cloudStatus(err.message, true);
    btn.disabled = false;
  }
});

$('#settings-body').addEventListener('click', async (e) => {
  const id = e.target.id;
  if (id === 'cloud-to-setup' || id === 'cloud-to-login') {
    cloudMode = id === 'cloud-to-setup' ? 'setup' : 'login';
    refreshCloudPanel();
  } else if (id === 'cloud-logout') {
    cloud.logout();
    cloudMode = 'login';
    refreshCloudPanel('Logout. Lagu yang sudah diunduh tetap ada di device ini.');
  } else if (id === 'cloud-upload-all') {
    const all = (await listEntries()).filter((x) => x.source !== 'builtin' && !x.cloud);
    if (!all.length) return cloudStatus('Semua lagu di device ini sudah ada di collection.');
    cloudStatus('');
    for (const entry of all) pushToCloud(entry, null);
  }
});

const syncErrors = [];

function showSync(d) {
  const box = $('#cloud-sync');
  if (!box) return;
  if (d.state === 'idle') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const idx = Math.min(d.total, d.done + 1);
  const part = d.state === 'progress' ? (d.message || 0) / 100 : 0;
  const overall = d.total ? (d.done + (d.state === 'done' || d.state === 'error' ? 0 : part)) / d.total : 0;
  $('#cloud-sync-bar').style.width = `${Math.round(overall * 100)}%`;
  const file = d.file ? `, ${d.file}` : '';
  $('#cloud-sync-label').textContent =
    d.state === 'progress' ? `Upload ${idx} dari ${d.total}: ${d.title}${file} (${d.message}%)` : `Upload ${idx} dari ${d.total}: ${d.title}`;
}

window.addEventListener('cloud-sync', (e) => {
  const d = e.detail;
  showSync(d);
  if (d.state === 'start' && d.total <= 1) toast(`Upload ke collection: ${d.title}`, 2000);
  else if (d.state === 'done') {
    if (d.total <= 1) toast(`"${d.title}" tersimpan di collection`);
    if (app.screen === 'songs') renderSongs(app.selected && app.selected.id);
  } else if (d.state === 'error') {
    syncErrors.push(d.message);
    toast(d.message, 6000);
  } else if (d.state === 'idle') {
    if (syncErrors.length) cloudStatus(syncErrors.join('\n'), true);
    else cloudStatus('Semua lagu sudah tersimpan di collection.');
    syncErrors.length = 0;
  }
});

// ---------------------------------------------------------------------
// kalibrasi

const calib = { running: false, clicks: [], taps: [], timer: 0 };
const CALIB_BEATS = 16;
const CALIB_GAP = 0.6;

function resetCalibration() {
  calib.running = false;
  clearTimeout(calib.timer);
  $('#calib-pad').textContent = 'Mulai';
  $('#calib-result').textContent = `Offset sekarang ${settings.audioOffsetMs} ms`;
}

$('#calib-pad').addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  await audio.unlock();
  const ctx = audio.ctx;
  if (!calib.running) {
    audio.setVolumes(settings.musicVolume, Math.max(0.5, settings.sfxVolume));
    calib.running = true;
    calib.taps = [];
    calib.clicks = [];
    const start = ctx.currentTime + 0.5;
    for (let i = 0; i < CALIB_BEATS; i++) {
      calib.clicks.push(start + i * CALIB_GAP);
      sfx.tick(i % 4 === 0, 0.5 + i * CALIB_GAP);
    }
    $('#calib-pad').textContent = 'Tap!';
    $('#calib-result').textContent = 'Ikuti bunyi tik, 16 kali';
    calib.timer = setTimeout(finishCalibration, (0.5 + CALIB_BEATS * CALIB_GAP + 0.4) * 1000);
    return;
  }
  const lag = Math.max(0, Math.min(0.2, (performance.now() - e.timeStamp) / 1000));
  calib.taps.push(ctx.currentTime - (Number.isFinite(lag) ? lag : 0));
  const pad = $('#calib-pad');
  pad.classList.add('is-beat');
  setTimeout(() => pad.classList.remove('is-beat'), 90);
});

function finishCalibration() {
  calib.running = false;
  const diffs = [];
  for (const tap of calib.taps) {
    let best = null;
    for (let i = 3; i < calib.clicks.length; i++) {
      const d = tap - calib.clicks[i];
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    if (best !== null && Math.abs(best) < CALIB_GAP / 2) diffs.push(best);
  }
  $('#calib-pad').textContent = 'Ulangi';
  if (diffs.length < 6) {
    $('#calib-result').textContent = 'Tap-nya kurang banyak. Coba lagi dan ikuti sampai bunyinya habis.';
    return;
  }
  diffs.sort((a, b) => a - b);
  const median = diffs[diffs.length >> 1];
  const value = Math.max(-300, Math.min(300, Math.round(((median - audio.outputLatency) * 1000) / 5) * 5));
  settings.audioOffsetMs = value;
  saveSettings();
  $('#calib-result').textContent = `Offset disimpan: ${value} ms (dari ${diffs.length} tap)`;
}

// ---------------------------------------------------------------------
// bantuan

function renderHelp() {
  $('#help-body').innerHTML = `
    <h3>Dasar</h3>
    <p>Note turun di 5 lane. Tekan lane-nya tepat saat note menyentuh garis di bawah. Note berekor harus <b>ditahan</b> sampai ekornya habis.</p>
    <ul>
      <li><b>Chord</b>: dua note atau lebih sejajar, tekan bersamaan.</li>
      <li><b>Timing</b>: makin pas makin besar poinnya. Perfect 100, Great 75, Cool 50 per note.</li>
      <li><b>Combo</b>: tiap 10 note beruntun, multiplier naik sampai x4. Miss atau salah tekan mengembalikannya ke x1.</li>
      <li><b>Super mode</b>: note berbintang warna tosca. Kena semua satu rangkaian, meter Super terisi. Kalau sudah setengah, tap tombol Super (atau tap highway) untuk skor dobel.</li>
      <li><b>Bar ungu</b> selebar highway adalah open note. Di mode Tap, tekan lane mana saja.</li>
    </ul>
    <h3>Kontrol</h3>
    <ul>
      <li><b>Layar sentuh</b>: tap lima tombol fret di bawah. Bisa multi-touch untuk chord.</li>
      <li><b>Keyboard</b>: A S D F G atau 1 2 3 4 5. Space untuk Super, Esc untuk pause.</li>
      <li><b>Gamepad</b>: LT LB RB RT A untuk lima lane, X atau Y untuk Super, Start untuk pause.</li>
      <li><b>Guitar controller</b>: pilih layout Guitar controller dan cara main Strum di Settings. Note tanpa cincin hitam (HOPO) dan note cincin putih (tap) bisa dipukul tanpa strum.</li>
    </ul>
    <h3>Kalau timing terasa meleset</h3>
    <p>Buka Settings lalu Kalibrasi audio, terutama kalau pakai headphone Bluetooth.</p>
    <h3>Lagu sendiri</h3>
    <ul>
      <li><b>Import</b>: file .zip atau .sng lagu Clone Hero, atau notes.chart / notes.mid beserta audionya.</li>
      <li><b>Stem sendiri</b>: di Auto-chart, pilih sekaligus lagu lengkap dan file stem (nama file harus mengandung guitar, bass, drums, vocals, piano, atau other). Frets dibuat dari stem yang kamu pilih.</li>
      <li><b>Auto-chart</b>: pilih file audio, pilih instrumen yang mau dijadikan frets (gitar, bass, drum, vokal, atau semua), lalu chart dibuat otomatis.</li>
      <li><b>Chart editor</b>: bikin atau rapikan chart, lalu export ke .chart.</li>
    </ul>
    <p>Di iPhone, pakai Share lalu Add to Home Screen supaya layarnya penuh dan lagu tersimpan lebih awet.</p>`;
}

// ---------------------------------------------------------------------
// editor (dimuat saat dibutuhkan)

async function openEditor(arg) {
  try {
    const mod = await import('./editor/editor.js');
    if (!app.editor) app.editor = mod.createEditor($('#screen-editor'), { app, go, toast, showLoading, hideLoading });
    app.editor.open(arg || null);
  } catch (err) {
    toast(`Editor gagal dibuka: ${err.message}`, 5000);
    go('menu');
  }
}

// ---------------------------------------------------------------------
// boot

function boot() {
  $('#version').textContent = `v${VERSION}`;
  app.highway = new Highway($('#stage'));
  Object.assign(hud, {
    score: $('#hud-score'),
    stars: $('#hud-stars'),
    streak: $('#hud-streak'),
    mult: $('#hud-mult'),
    super: $('#hud-super'),
    superBtn: $('#btn-super'),
    progress: $('#hud-progress'),
    section: $('#hud-section'),
    feedback: $('#hud-feedback'),
    count: $('#hud-count'),
    grade: $('#hud-grade'),
    combo: $('#hud-combo'),
    plus: $('#hud-plus'),
  });
  window.addEventListener('resize', () => app.highway.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => app.highway.resize(), 250));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.screen === 'game') pauseGame();
  });
  $('#btn-pause').addEventListener('click', pauseGame);
  $('#btn-resume').addEventListener('click', resumeGame);
  $('#btn-restart').addEventListener('click', () => {
    endSession();
    startGame();
  });
  $('#btn-quit').addEventListener('click', () => go('songs'));
  $('#btn-super').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (app.session && app.session.running) app.session.engine.activateSuper(app.session.timeAt(performance.now()));
  });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  go('menu');
  requestAnimationFrame(demoFrame);
}

boot();
