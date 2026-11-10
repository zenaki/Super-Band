// AudioContext bersama, pemutar multi-stem, song clock, dan efek suara kecil.

const TAU = Math.PI * 2;

export const audio = {
  ctx: null,
  master: null,
  music: null,
  sfx: null,
  unlocked: false,
  musicLevel: 0.9,

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.music = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.music.connect(comp);
    this.sfx.connect(comp);
    comp.connect(this.master);
    this.master.connect(this.ctx.destination);
    return this.ctx;
  },

  // Harus dipanggil dari gesture user (tap/klik) supaya audio boleh bunyi.
  async unlock() {
    this.init();
    try {
      // iOS: tetap bunyi walau tombol silent aktif
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (err) {
      /* abaikan */
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (err) {
        /* abaikan */
      }
    }
    if (!this.unlocked) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.ctx.destination);
      src.start();
      this.unlocked = true;
    }
  },

  setVolumes(music, sfx) {
    this.init();
    this.musicLevel = music;
    this.music.gain.cancelScheduledValues(this.ctx.currentTime);
    this.music.gain.setValueAtTime(music, this.ctx.currentTime);
    this.sfx.gain.value = sfx;
  },

  get outputLatency() {
    if (!this.ctx) return 0;
    const v = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Number.isFinite(v) ? Math.min(0.5, v) : 0;
  },
};

export class Player {
  constructor() {
    this.backing = null;
    this.instrument = null;
    this.nodes = [];
    this.instGain = null;
    this.playing = false;
    this.rate = 1;
    this.pos0 = 0; // posisi lagu saat c0
    this.c0 = 0; // ctx time saat mulai
    this.pausedAt = 0;
    this.clockOff = null;
    this.muted = false;
  }

  load(backing, instrument) {
    this.stop();
    this.backing = backing || null;
    this.instrument = instrument || null;
    this.pausedAt = 0;
  }

  get duration() {
    return Math.max(this.backing ? this.backing.duration : 0, this.instrument ? this.instrument.duration : 0);
  }

  // Mulai dari posisi `from` detik. from negatif = hitung mundur sebelum audio masuk.
  play(from = this.pausedAt, rate = this.rate) {
    const ctx = audio.init();
    this._kill();
    this.rate = rate;
    const lead = 0.06;
    this.c0 = ctx.currentTime + lead;
    this.pos0 = from;
    const mk = (buffer, dest) => {
      if (!buffer) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(dest);
      if (from >= 0) {
        if (from < buffer.duration) src.start(this.c0, from);
      } else src.start(this.c0 + -from / rate, 0);
      this.nodes.push(src);
    };
    mk(this.backing, audio.music);
    this.instGain = ctx.createGain();
    this.instGain.gain.value = this.muted ? 0 : 1;
    this.instGain.connect(audio.music);
    mk(this.instrument, this.instGain);
    this.playing = true;
    this.clockOff = null;
  }

  _kill() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch (err) {
        /* belum start */
      }
      n.disconnect();
    }
    this.nodes = [];
    if (this.instGain) this.instGain.disconnect();
    this.instGain = null;
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this._kill();
    this.playing = false;
  }

  stop() {
    this._kill();
    this.playing = false;
    this.pausedAt = 0;
  }

  // Posisi audio yang sedang dijadwalkan (belum dikurangi latency).
  get time() {
    if (!this.playing) return this.pausedAt;
    return this.pos0 + (audio.ctx.currentTime - this.c0) * this.rate;
  }

  // Posisi untuk timestamp performance.now() tertentu; lebih halus dari ctx.currentTime.
  timeAt(perfMs) {
    if (!this.playing) return this.pausedAt;
    const sample = audio.ctx.currentTime - performance.now() / 1000;
    if (this.clockOff === null || Math.abs(sample - this.clockOff) > 0.05) this.clockOff = sample;
    else this.clockOff += (sample - this.clockOff) * 0.02;
    return this.pos0 + (perfMs / 1000 + this.clockOff - this.c0) * this.rate;
  }

  // Bisukan stem instrumen saat pemain miss. Kalau tidak ada stem terpisah, musik diredam sebentar.
  setMuted(muted) {
    if (this.muted === muted) return;
    this.muted = muted;
    const ctx = audio.ctx;
    if (this.instrument && this.instGain) {
      this.instGain.gain.cancelScheduledValues(ctx.currentTime);
      this.instGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.012);
    } else if (!this.instrument && muted) {
      // base harus dari setting, bukan g.value: saat miss beruntun g.value masih di tengah ramp
      // dan volumenya akan terus mengecil sampai hilang
      const g = audio.music.gain;
      const base = audio.musicLevel;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(base * 0.55, ctx.currentTime);
      g.linearRampToValueAtTime(base, ctx.currentTime + 0.25);
      this.muted = false;
    }
  }
}

// ---- efek suara ------------------------------------------------------

function tone(freq, dur, type = 'sine', gain = 0.2, slideTo = 0, when = 0) {
  const ctx = audio.ctx;
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  osc.connect(g);
  g.connect(audio.sfx);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

let noiseBuf = null;
function noise(dur, gain, hp = 2000, when = 0) {
  const ctx = audio.ctx;
  if (!ctx) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(audio.sfx);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

export const sfx = {
  click() {
    tone(660, 0.05, 'triangle', 0.12);
  },
  back() {
    tone(420, 0.06, 'triangle', 0.1);
  },
  miss() {
    // senar "kecekik"
    tone(92 + Math.random() * 20, 0.12, 'sawtooth', 0.16, 70);
    noise(0.05, 0.1, 1500);
  },
  superReady() {
    tone(880, 0.12, 'sine', 0.14);
    tone(1320, 0.18, 'sine', 0.12, 0, 0.09);
  },
  superStart() {
    tone(220, 0.5, 'sawtooth', 0.12, 1760);
    noise(0.5, 0.08, 4000);
  },
  star() {
    tone(1046, 0.16, 'triangle', 0.16);
    tone(1568, 0.3, 'triangle', 0.14, 0, 0.1);
  },
  tick(accent = false, when = 0) {
    tone(accent ? 1600 : 1100, 0.04, 'square', 0.16, 0, when);
  },
  note(when = 0) {
    tone(1900, 0.03, 'square', 0.1, 0, when);
  },
};

export { TAU };
