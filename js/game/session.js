// Satu sesi main: menyambungkan player (audio), engine (judging), highway (gambar), dan input.

import { Engine, Bot, HIT_WINDOWS } from '../core/engine.js';
import { audio, Player, sfx } from '../audio/player.js';
import { settings, lookahead } from '../store/settings.js';
import { Input } from './input.js';

const LEAD_IN = 3;

export class Session {
  // opts: { highway, surface, track, songOffset, backing, instrument, speed, bot, onEvent, onFinish, onPause }
  constructor(opts) {
    this.o = opts;
    this.highway = opts.highway;
    this.track = opts.track;
    this.player = new Player();
    this.player.load(opts.backing, opts.instrument);
    this.speed = opts.speed || 1;
    this.mode = settings.playMode === 'strum' ? 'strum' : 'tap';
    this.engine = new Engine(this.track, {
      mode: this.mode,
      window: HIT_WINDOWS[settings.hitWindow] || HIT_WINDOWS.normal,
      ghostPenalty: settings.ghostPenalty,
      onEvent: (type, data) => this.onEngine(type, data),
    });
    this.bot = opts.bot ? new Bot(this.engine) : null;
    this.input = new Input(opts.surface, this.highway, {
      timeAt: (ms) => this.timeAt(ms),
      fret: (lane, down, t) => {
        if (this.bot || !this.running) return;
        if (down) this.engine.fretDown(lane, t);
        else this.engine.fretUp(lane, t);
      },
      strum: (t) => {
        if (!this.bot && this.running) this.engine.strum(t);
      },
      superKey: (t) => {
        if (!this.bot && this.running) this.engine.activateSuper(t);
      },
      pause: () => this.o.onPause && this.o.onPause(),
    });
    this.running = false;
    this.finished = false;
    this.raf = 0;
    this.endAt = this.track.endTime + 2.2;
    this._frame = () => this.frame();
    this.highway.lefty = settings.lefty;
  }

  // selisih antara posisi audio terjadwal dan waktu chart yang "terdengar" sekarang
  get shift() {
    return audio.outputLatency + settings.audioOffsetMs / 1000 + (this.o.songOffset || 0);
  }

  timeAt(perfMs) {
    return this.player.timeAt(perfMs) - this.shift * (this.player.playing ? 1 : 1);
  }

  start() {
    audio.setVolumes(settings.musicVolume, settings.sfxVolume);
    this.player.play(-LEAD_IN * this.speed + Math.min(0, this.track.firstTime - 1), this.speed);
    this.running = true;
    this.input.attach();
    this.raf = requestAnimationFrame(this._frame);
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    this.player.pause();
    this.input.releaseAll();
    cancelAnimationFrame(this.raf);
  }

  resume() {
    if (this.running || this.finished) return;
    this.player.play(this.player.pausedAt, this.speed);
    this.running = true;
    this.raf = requestAnimationFrame(this._frame);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    this.player.stop();
  }

  onEngine(type, data) {
    const hw = this.highway;
    if (type === 'hit') {
      this.player.setMuted(false);
      if (data.note.open) hw.flash(-1);
      else for (const lane of data.note.frets) hw.flash(lane);
    } else if (type === 'miss') {
      this.player.setMuted(true);
      if (data.lost >= 1) sfx.miss();
      if (data.note.open) hw.flash(-1, 'miss');
      else for (const lane of data.note.frets) hw.flash(lane, 'miss');
    } else if (type === 'ghost') {
      if (settings.ghostPenalty) {
        this.player.setMuted(true);
        sfx.miss();
      }
      if (data.lane >= 0) hw.flash(data.lane, 'miss');
    } else if (type === 'superReady') sfx.superReady();
    else if (type === 'superStart') sfx.superStart();
    if (this.o.onEvent) this.o.onEvent(type, data);
  }

  frame() {
    if (!this.running) return;
    const t = this.timeAt(performance.now());
    if (this.bot) this.bot.update(t);
    this.engine.update(t);
    this.highway.draw({
      time: t,
      track: this.track,
      engine: this.engine,
      lookahead: lookahead() * this.speed,
      superActive: this.engine.superActive,
      superReady: this.engine.superReady,
    });
    if (this.o.onFrame) this.o.onFrame(t, this.engine);
    if (t >= this.endAt) {
      this.finished = true;
      this.running = false;
      this.input.detach();
      this.player.stop();
      if (this.o.onFinish) this.o.onFinish(this.engine.results());
      return;
    }
    this.raf = requestAnimationFrame(this._frame);
  }
}
