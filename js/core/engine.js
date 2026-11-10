// Engine gameplay: judging, skor, multiplier, sustain, dan Super meter.
// Murni logic (tanpa DOM/audio) supaya bisa di-test di Node.
//
// Dua mode input:
//  - 'tap'   : tekan lane = pukul note (touch, keyboard santai, gamepad biasa)
//  - 'strum' : tahan fret + strum, lengkap dengan HOPO & tap note (guitar controller)

export const HIT_WINDOWS = { relaxed: 0.1, normal: 0.075, strict: 0.055 };

// Poin per gem tergantung ketepatan timing.
export const GRADE_POINTS = { perfect: 100, great: 75, cool: 50 };
export const NOTE_POINTS = GRADE_POINTS.great; // acuan untuk skor full combo
// batas |selisih waktu| relatif terhadap hit window
export const GRADE_LIMITS = { perfect: 0.34, great: 0.67 };

export function gradeFor(delta, window) {
  const r = Math.abs(delta) / window;
  return r <= GRADE_LIMITS.perfect ? 'perfect' : r <= GRADE_LIMITS.great ? 'great' : 'cool';
}
export const SUSTAIN_POINTS_PER_BEAT = 25;
export const SUPER_PER_PHRASE = 0.25;
export const SUPER_MIN = 0.5;
export const SUPER_BEATS_FULL = 32;
export const STAR_CUTOFFS = [0.03, 0.15, 0.32, 0.54, 0.76];

const MISS_GRACE = 0.03; // toleransi event yang datang telat dari browser
const STRUM_LENIENCY = 0.05; // strum boleh sedikit lebih dulu dari fret
const FRET_HIT_ABSORB = 0.09; // strum tepat setelah HOPO kena tidak dihitung overstrum
const SUSTAIN_RELEASE_SLACK = 0.1;

const PENDING = 0;
const HIT = 1;
const MISSED = 2;

export function baseMultiplier(streak) {
  return Math.min(4, 1 + Math.floor(streak / 10));
}

// Skor kalau semua note kena tanpa Super Mode. Dipakai sebagai acuan bintang.
export function fullComboScore(track) {
  let score = 0;
  let streak = 0;
  for (const note of track.notes) {
    score += NOTE_POINTS * note.count * baseMultiplier(streak);
    streak++;
    if (note.sustain) {
      const beats = track.beatAt(note.endTime) - track.beatAt(note.time);
      score += SUSTAIN_POINTS_PER_BEAT * beats * baseMultiplier(streak);
    }
  }
  return Math.max(1, Math.round(score));
}

export function starsFor(score, fcScore, fullCombo) {
  const ratio = score / Math.max(1, fcScore);
  let stars = 0;
  for (const cut of STAR_CUTOFFS) if (ratio >= cut) stars++;
  return { stars, gold: !!fullCombo && stars >= 5, ratio };
}

export class Engine {
  constructor(track, opts = {}) {
    this.track = track;
    this.notes = track.notes;
    this.mode = opts.mode === 'strum' ? 'strum' : 'tap';
    this.window = opts.window || HIT_WINDOWS.normal;
    this.ghostPenalty = opts.ghostPenalty !== false;
    this.onEvent = opts.onEvent || null;
    this.fcScore = fullComboScore(track);
    this.reset();
  }

  reset() {
    const n = this.notes.length;
    this.status = new Uint8Array(n);
    this.hitMask = new Uint8Array(n);
    this.phraseHits = new Uint16Array(this.track.phrases.length);
    this.cursor = 0;
    this.time = -Infinity;
    this.held = 0;
    this.score = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.hits = 0;
    this.misses = 0;
    this.ghosts = 0;
    this.super = 0;
    this.superActive = false;
    this.superLast = 0;
    this.superUses = 0;
    this.sustains = [];
    this.sustainAcc = 0;
    this.comboAlive = false;
    this.pendingStrum = null;
    this.lastFretHit = -Infinity;
    this.lastFretChange = -Infinity;
    this.lastHitTime = -Infinity;
    this.deltaSum = 0;
    this.deltaAbsSum = 0;
    this.early = 0;
    this.late = 0;
    this.grades = { perfect: 0, great: 0, cool: 0 };
  }

  emit(type, data) {
    if (this.onEvent) this.onEvent(type, data || {});
  }

  get multiplier() {
    return baseMultiplier(this.streak) * (this.superActive ? 2 : 1);
  }

  get superReady() {
    return !this.superActive && this.super >= SUPER_MIN;
  }

  get finished() {
    return this.cursor >= this.notes.length && this.sustains.length === 0;
  }

  // ---- waktu berjalan -------------------------------------------------

  update(t) {
    if (t < this.time) t = this.time;
    if (this.sustains.length) this._tickSustains(t);

    if (this.superActive) {
      const beats = this.track.beatAt(t) - this.track.beatAt(this.superLast);
      this.superLast = t;
      if (beats > 0) this.super -= beats / SUPER_BEATS_FULL;
      if (this.super <= 0) {
        this.super = 0;
        this.superActive = false;
        this.emit('superEnd');
      }
    }

    const notes = this.notes;
    const n = notes.length;

    // HOPO/tap yang fret-nya sudah ditekan lebih awal: kena tepat di waktunya.
    if (this.mode === 'strum' && this.cursor < n && this.lastFretChange > this.lastHitTime) {
      const note = notes[this.cursor];
      if (
        this.status[this.cursor] === PENDING &&
        note.time <= t &&
        (note.tap || (note.hopo && this.comboAlive)) &&
        this._matches(note, this.cursor)
      ) {
        this._hit(this.cursor, note.time, this.held);
        this.lastFretHit = note.time;
      }
    }

    const limit = t - this.window - MISS_GRACE;
    for (let i = this.cursor; i < n && notes[i].time < limit; i++) {
      if (this.status[i] === PENDING) this._miss(i);
    }
    this._advance();

    if (this.pendingStrum !== null && t - this.pendingStrum > STRUM_LENIENCY) {
      this.pendingStrum = null;
      this._ghost(-1);
    }
    this.time = t;
  }

  _advance() {
    const n = this.notes.length;
    while (this.cursor < n && this.status[this.cursor] !== PENDING) this.cursor++;
  }

  _tickSustains(t) {
    const mult = this.multiplier;
    const beatAt = this.track.beatAt;
    for (let k = this.sustains.length - 1; k >= 0; k--) {
      const s = this.sustains[k];
      const upTo = Math.min(t, s.end);
      if (upTo > s.last) {
        this.sustainAcc += (beatAt(upTo) - beatAt(s.last)) * SUSTAIN_POINTS_PER_BEAT * mult;
        s.last = upTo;
      }
      if (t >= s.end) {
        this.sustains.splice(k, 1);
        this.emit('sustainEnd', { note: this.notes[s.idx], completed: true });
      }
    }
    this._flushSustain();
  }

  _flushSustain() {
    // toleransi kecil supaya 99.9999 tidak tertinggal gara-gara pembulatan float
    const whole = Math.floor(this.sustainAcc + 1e-6);
    if (whole >= 1) {
      this.score += whole;
      this.sustainAcc -= whole;
    }
  }

  _dropSustain(k, t) {
    const s = this.sustains[k];
    const upTo = Math.min(Math.max(t, s.last), s.end);
    if (upTo > s.last) {
      const beats = this.track.beatAt(upTo) - this.track.beatAt(s.last);
      this.sustainAcc += beats * SUSTAIN_POINTS_PER_BEAT * this.multiplier;
    }
    this.sustains.splice(k, 1);
    this._flushSustain();
    this.emit('sustainEnd', { note: this.notes[s.idx], completed: t >= s.end - SUSTAIN_RELEASE_SLACK });
  }

  // ---- input ----------------------------------------------------------

  fretDown(lane, t) {
    const bit = 1 << lane;
    if (this.held & bit) return;
    this.held |= bit;
    if (this.mode === 'strum') {
      this._fretChanged(t);
      return;
    }
    const w = this.window;
    const notes = this.notes;
    const n = notes.length;
    let openIdx = -1;
    for (let i = this.cursor; i < n; i++) {
      const note = notes[i];
      if (note.time > t + w) break;
      if (this.status[i] !== PENDING || note.time < t - w) continue;
      if (note.open) {
        if (openIdx < 0) openIdx = i;
        continue;
      }
      if (note.mask & bit && !(this.hitMask[i] & bit)) {
        this.hitMask[i] |= bit;
        if (this.hitMask[i] === note.mask) this._hit(i, t, note.mask);
        else this.emit('partial', { note, lane });
        return;
      }
    }
    if (openIdx >= 0) {
      // open note di tap mode: lane mana saja boleh
      this._hit(openIdx, t, bit);
      return;
    }
    this._ghost(lane);
  }

  fretUp(lane, t) {
    const bit = 1 << lane;
    if (!(this.held & bit)) return;
    this.held &= ~bit;
    for (let k = this.sustains.length - 1; k >= 0; k--) {
      if (this.sustains[k].mask & bit) this._dropSustain(k, t);
    }
    if (this.mode === 'strum') this._fretChanged(t);
  }

  strum(t) {
    if (this.mode !== 'strum') return;
    if (this.pendingStrum !== null) {
      this.pendingStrum = null;
      this._ghost(-1);
    }
    if (this._tryStrum(t)) return;
    if (t - this.lastFretHit <= FRET_HIT_ABSORB) return;
    this.pendingStrum = t;
  }

  activateSuper(t) {
    if (!this.superReady) return false;
    this.superActive = true;
    this.superLast = Math.max(t, this.time);
    this.superUses++;
    this.emit('superStart');
    return true;
  }

  // ---- strum mode -----------------------------------------------------

  _matchMask(note, held) {
    if (note.open) return held === 0;
    if (note.chord) return held === note.mask;
    return (held & ~(note.mask - 1)) === note.mask; // fret lebih rendah boleh ikut ditahan
  }

  _matches(note, idx) {
    if (this._matchMask(note, this.held)) return true;
    let susMask = 0;
    for (const s of this.sustains) if (s.idx !== idx) susMask |= s.mask;
    return susMask !== 0 && this._matchMask(note, this.held & ~susMask);
  }

  _firstInWindow(t) {
    const w = this.window;
    const notes = this.notes;
    for (let i = this.cursor; i < notes.length; i++) {
      if (notes[i].time > t + w) return -1;
      if (this.status[i] === PENDING && notes[i].time >= t - w) return i;
    }
    return -1;
  }

  _tryStrum(t) {
    const w = this.window;
    const notes = this.notes;
    for (let i = this.cursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.time > t + w) break;
      if (this.status[i] !== PENDING || note.time < t - w) continue;
      if (this._matches(note, i)) {
        for (let k = this.cursor; k < i; k++) if (this.status[k] === PENDING) this._miss(k);
        this._hit(i, t, this.held);
        return true;
      }
    }
    return false;
  }

  _fretChanged(t) {
    this.lastFretChange = t;
    if (this.pendingStrum !== null && t - this.pendingStrum <= STRUM_LENIENCY) {
      if (this._tryStrum(t)) {
        this.pendingStrum = null;
        return;
      }
    }
    const i = this._firstInWindow(t);
    if (i >= 0) {
      const note = this.notes[i];
      if ((note.tap || (note.hopo && this.comboAlive)) && this._matches(note, i)) {
        this._hit(i, t, this.held);
        this.lastFretHit = t;
      }
    }
  }

  // ---- hasil judging --------------------------------------------------

  _hit(i, t, lanes) {
    const note = this.notes[i];
    const before = baseMultiplier(this.streak);
    const grade = gradeFor(t - note.time, this.window);
    this.grades[grade]++;
    const points = GRADE_POINTS[grade] * note.count * this.multiplier;
    this.status[i] = HIT;
    this.score += points;
    this.hits++;
    this.streak++;
    if (this.streak > this.maxStreak) this.maxStreak = this.streak;
    this.comboAlive = true;
    this.lastHitTime = t;
    const delta = t - note.time;
    this.deltaSum += delta;
    this.deltaAbsSum += Math.abs(delta);
    if (delta < -0.02) this.early++;
    else if (delta > 0.02) this.late++;

    if (note.sustain) {
      const mask = note.open ? lanes : note.mask;
      // di tap mode semua lane chord harus masih ditahan supaya sustain jalan
      if (this.mode !== 'tap' || (this.held & mask) === mask) {
        this.sustains.push({ idx: i, mask, last: Math.max(t, note.time), end: note.endTime });
      }
    }
    this._advance();
    this.emit('hit', { note, delta, points, grade });

    const after = baseMultiplier(this.streak);
    if (after !== before) this.emit('mult', { mult: after });

    if (note.sp >= 0) {
      const p = note.sp;
      this.phraseHits[p]++;
      if (this.phraseHits[p] === this.track.phrases[p].count) {
        const wasReady = this.super >= SUPER_MIN;
        this.super = Math.min(1, this.super + SUPER_PER_PHRASE);
        this.emit('superGain', { value: this.super });
        if (!wasReady && this.super >= SUPER_MIN && !this.superActive) this.emit('superReady');
      }
    }
  }

  _breakStreak() {
    const before = baseMultiplier(this.streak);
    const had = this.streak;
    this.streak = 0;
    this.comboAlive = false;
    if (before !== 1) this.emit('mult', { mult: 1 });
    return had;
  }

  _miss(i) {
    this.status[i] = MISSED;
    this.misses++;
    const lost = this._breakStreak();
    this.emit('miss', { note: this.notes[i], lost });
  }

  _ghost(lane) {
    this.ghosts++;
    if (!this.ghostPenalty) {
      this.emit('ghost', { lane, lost: 0 });
      return;
    }
    const lost = this._breakStreak();
    this.emit('ghost', { lane, lost });
  }

  // ---- ringkasan ------------------------------------------------------

  results() {
    const total = this.notes.length;
    const fullCombo = total > 0 && this.hits === total && (!this.ghostPenalty || this.ghosts === 0);
    const star = starsFor(this.score, this.fcScore, fullCombo);
    return {
      score: Math.round(this.score),
      hits: this.hits,
      misses: this.misses,
      ghosts: this.ghosts,
      total,
      accuracy: total ? this.hits / total : 0,
      maxStreak: this.maxStreak,
      fullCombo,
      stars: star.stars,
      gold: star.gold,
      ratio: star.ratio,
      superUses: this.superUses,
      avgOffsetMs: this.hits ? (this.deltaSum / this.hits) * 1000 : 0,
      avgErrorMs: this.hits ? (this.deltaAbsSum / this.hits) * 1000 : 0,
      early: this.early,
      late: this.late,
      perfect: this.grades.perfect,
      great: this.grades.great,
      cool: this.grades.cool,
    };
  }
}

// Pemain otomatis: dipakai untuk demo di menu dan untuk test.
export class Bot {
  constructor(engine) {
    this.engine = engine;
    this.next = 0;
    this.releases = [];
    this.useSuper = true;
  }

  _cancelRelease(lane) {
    for (let k = this.releases.length - 1; k >= 0; k--) {
      if (this.releases[k].lane === lane) this.releases.splice(k, 1);
    }
  }

  update(t) {
    const eng = this.engine;
    const notes = eng.notes;
    for (;;) {
      // proses release dan note berikutnya sesuai urutan waktu
      let relIdx = -1;
      for (let k = 0; k < this.releases.length; k++) {
        if (this.releases[k].at <= t && (relIdx < 0 || this.releases[k].at < this.releases[relIdx].at)) relIdx = k;
      }
      const note = this.next < notes.length && notes[this.next].time <= t ? notes[this.next] : null;
      if (relIdx >= 0 && (!note || this.releases[relIdx].at <= note.time)) {
        const r = this.releases[relIdx];
        this.releases.splice(relIdx, 1);
        eng.fretUp(r.lane, r.at);
        continue;
      }
      if (!note) break;
      this.next++;
      this._play(note);
    }
  }

  _play(note) {
    const eng = this.engine;
    const at = note.time;
    const strum = eng.mode === 'strum';
    const lanes = note.open ? (strum ? [] : [0]) : note.frets;
    const mask = note.open ? (strum ? 0 : 1) : note.mask;
    for (let lane = 0; lane < 5; lane++) {
      const bit = 1 << lane;
      if (!(eng.held & bit)) continue;
      const want = (mask & bit) !== 0;
      if (strum) {
        const sustaining = eng.sustains.some((s) => s.mask & bit && s.end > at + 0.02);
        if (want) this._cancelRelease(lane);
        else if (!sustaining) {
          this._cancelRelease(lane);
          eng.fretUp(lane, at);
        }
      } else if (want) {
        this._cancelRelease(lane);
        eng.fretUp(lane, at);
      }
    }
    for (const lane of lanes) eng.fretDown(lane, at);
    if (strum && eng.status[note.idx] === PENDING) eng.strum(at);
    const upAt = note.sustain ? note.endTime + 0.01 : at + 0.07;
    for (const lane of lanes) this.releases.push({ lane, at: upAt });
    if (this.useSuper && eng.superReady) eng.activateSuper(at);
  }
}
