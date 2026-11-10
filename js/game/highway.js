// Renderer highway perspektif di canvas 2D.

import { lowerBound } from '../core/util.js';

export const LANE_COLORS = ['#2edb5a', '#ff3b46', '#ffd21f', '#2f8cff', '#ff8a1e'];
const SUPER_COLOR = '#22e6d2';
const OPEN_COLOR = '#b06bff';
const S_FAR = 0.2;
const K = 1 / S_FAR - 1;
const SPR_W = 168;
const SPR_H = 104;

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function makeGem(color, type, star) {
  const c = document.createElement('canvas');
  c.width = SPR_W;
  c.height = SPR_H;
  const g = c.getContext('2d');
  const cx = SPR_W / 2;
  const cy = SPR_H / 2 + 6;
  const rx = SPR_W / 2 - 6;
  const ry = SPR_H / 2 - 14;
  // bayangan + badan
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.ellipse(cx, cy + 8, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = shade(color, -0.45);
  g.beginPath();
  g.ellipse(cx, cy + 3, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  const grad = g.createLinearGradient(0, cy - ry - 8, 0, cy + ry);
  grad.addColorStop(0, shade(color, 0.45));
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, shade(color, -0.3));
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(cx, cy - 5, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  // tutup atas
  if (type === 'strum') {
    g.fillStyle = '#0d0a14';
    g.beginPath();
    g.ellipse(cx, cy - 8, rx * 0.58, ry * 0.58, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(cx, cy - 10, rx * 0.42, ry * 0.42, 0, 0, Math.PI * 2);
    g.fill();
  } else if (type === 'hopo') {
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.beginPath();
    g.ellipse(cx, cy - 9, rx * 0.56, ry * 0.56, 0, 0, Math.PI * 2);
    g.fill();
  } else {
    // tap: cincin terang, tengah gelap
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.beginPath();
    g.ellipse(cx, cy - 8, rx * 0.56, ry * 0.56, 0, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#0d0a14';
    g.beginPath();
    g.ellipse(cx, cy - 8, rx * 0.36, ry * 0.36, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (star) {
    g.fillStyle = type === 'tap' ? '#ffffff' : '#0d0a14';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.16 : 0.36;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * rx * r;
      const y = cy - 9 + Math.sin(a) * ry * r * 1.25;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
    g.fill();
  }
  return c;
}

export class Highway {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lefty = false;
    this.flashes = [];
    this.sprites = {};
    this.pulse = 0;
    for (const type of ['strum', 'hopo', 'tap']) {
      this.sprites[type] = LANE_COLORS.map((c) => makeGem(c, type, false));
      this.sprites[`${type}S`] = LANE_COLORS.map(() => makeGem(SUPER_COLOR, type, true));
    }
    this.resize();
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 360;
    const H = c.clientHeight || 640;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    this.dpr = dpr;
    this.W = W;
    this.H = H;
    const portrait = H >= W;
    this.cx = W / 2;
    if (portrait) {
      this.strikeY = H - Math.max(96, H * 0.15);
      this.hw = Math.min(W * 0.485, 290);
      this.topY = H * 0.2;
    } else {
      this.strikeY = H - Math.max(64, H * 0.2);
      this.hw = Math.min(W * 0.3, H * 0.62);
      this.topY = H * 0.1;
    }
    this.vy = (this.topY - this.strikeY * S_FAR) / (1 - S_FAR);
    this.fretZoneTop = this.strikeY - Math.max(70, H * (portrait ? 0.16 : 0.24));
  }

  scaleAt(u) {
    return 1 / (1 + u * K);
  }

  yAt(s) {
    return this.vy + (this.strikeY - this.vy) * s;
  }

  laneX(lane, s) {
    const l = this.lefty ? 4 - lane : lane;
    return this.cx + (l - 2) * 0.4 * this.hw * s;
  }

  // Lane dari posisi sentuh. null kalau di luar zona fret.
  laneAt(x, y) {
    if (y < this.fretZoneTop) return null;
    let l = Math.floor((x - (this.cx - this.hw)) / (this.hw * 0.4));
    l = Math.max(0, Math.min(4, l));
    return this.lefty ? 4 - l : l;
  }

  // posisi relatif di dalam lane (0..1), untuk hysteresis saat jari geser
  laneFrac(x) {
    const f = (x - (this.cx - this.hw)) / (this.hw * 0.4);
    return f - Math.floor(f);
  }

  flash(lane, kind = 'hit') {
    this.flashes.push({ lane, kind, t: performance.now() });
    if (this.flashes.length > 40) this.flashes.shift();
  }

  // state: { time, track, engine, lookahead, superActive, superReady }
  draw(state) {
    const g = this.ctx;
    const { W, H, cx, hw } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const t = state.time;
    const look = state.lookahead;
    const eng = state.engine;
    const track = state.track;
    const sup = !!state.superActive;

    // papan
    const sNear = this.scaleAt(-0.14);
    const yNear = Math.min(H + 40, this.yAt(sNear));
    const yFar = this.yAt(S_FAR);
    g.beginPath();
    g.moveTo(cx - hw * S_FAR, yFar);
    g.lineTo(cx + hw * S_FAR, yFar);
    g.lineTo(cx + hw * sNear, yNear);
    g.lineTo(cx - hw * sNear, yNear);
    g.closePath();
    const board = g.createLinearGradient(0, yFar, 0, yNear);
    board.addColorStop(0, 'rgba(14,8,24,0.2)');
    board.addColorStop(0.25, sup ? '#0b2a33' : '#150c24');
    board.addColorStop(1, sup ? '#0e3a44' : '#1d1232');
    g.fillStyle = board;
    g.fill();

    // garis beat
    if (track) {
      const beats = track.beats;
      let bi = lowerBound(beats, t - 0.05, (b) => b.time);
      for (; bi < beats.length && beats[bi].time < t + look; bi++) {
        const b = beats[bi];
        const s = this.scaleAt((b.time - t) / look);
        const y = this.yAt(s);
        g.strokeStyle = b.measure ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.12)';
        g.lineWidth = b.measure ? 2.2 * s + 0.4 : 1.2 * s + 0.3;
        g.beginPath();
        g.moveTo(cx - hw * s, y);
        g.lineTo(cx + hw * s, y);
        g.stroke();
      }
    }

    // garis lane + tepi
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    for (let i = 1; i < 5; i++) {
      const off = (i * 0.4 - 1) * hw;
      g.beginPath();
      g.moveTo(cx + off * S_FAR, yFar);
      g.lineTo(cx + off * sNear, yNear);
      g.stroke();
    }
    g.lineWidth = 4;
    g.strokeStyle = sup ? SUPER_COLOR : state.superReady ? '#ffc629' : '#6b4fb0';
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + side * hw * S_FAR, yFar);
      g.lineTo(cx + side * hw * sNear, yNear);
      g.stroke();
    }

    // strikeline
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - hw, this.strikeY);
    g.lineTo(cx + hw, this.strikeY);
    g.stroke();

    const held = eng ? eng.held : state.held || 0;
    const now = performance.now();
    const rx = hw * 0.4 * 0.47;
    const ry = rx * 0.5;

    // target fret
    for (let lane = 0; lane < 5; lane++) {
      const x = this.laneX(lane, 1);
      const down = (held >> lane) & 1;
      const color = LANE_COLORS[lane];
      g.fillStyle = down ? color : '#120b1e';
      g.strokeStyle = color;
      g.lineWidth = 4;
      g.beginPath();
      g.ellipse(x, this.strikeY + (down ? 3 : 0), rx, ry, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = down ? '#ffffff' : shade(color, -0.55);
      g.beginPath();
      g.ellipse(x, this.strikeY + (down ? 3 : 0), rx * 0.42, ry * 0.42, 0, 0, Math.PI * 2);
      g.fill();
    }

    // note
    if (track) {
      const notes = track.notes;
      let first = lowerBound(notes, t - 0.6, (nn) => nn.endTime);
      let last = first;
      while (last < notes.length && notes[last].time < t + look) last++;
      const sustaining = new Set();
      if (eng) for (const s of eng.sustains) sustaining.add(s.idx);

      for (let i = last - 1; i >= first; i--) {
        const note = notes[i];
        const st = eng ? eng.status[i] : 0;
        const isSus = sustaining.has(i);
        if (st === 1 && !isSus) continue;
        let u = (note.time - t) / look;
        if (st === 2 && u < -0.14) continue;
        const useSuper = sup || note.sp >= 0;
        const missed = st === 2;

        // ekor sustain
        if (note.sustain && (st !== 1 || isSus)) {
          const u0 = Math.max(isSus ? 0 : u, -0.14);
          const u1 = Math.min(1, (note.endTime - t) / look);
          if (u1 > u0) {
            const s0 = this.scaleAt(u0);
            const s1 = this.scaleAt(u1);
            const lanes = note.open ? [2] : note.frets;
            for (const lane of lanes) {
              const w = (note.open ? hw * 0.9 : rx * 0.3) * (isSus ? 1.35 : 1);
              const x0 = note.open ? cx : this.laneX(lane, s0);
              const x1 = note.open ? cx : this.laneX(lane, s1);
              g.fillStyle = missed ? 'rgba(120,110,140,0.5)' : note.open ? OPEN_COLOR : useSuper ? SUPER_COLOR : LANE_COLORS[lane];
              g.globalAlpha = isSus ? 0.95 : 0.7;
              g.beginPath();
              g.moveTo(x0 - w * s0, this.yAt(s0));
              g.lineTo(x0 + w * s0, this.yAt(s0));
              g.lineTo(x1 + w * s1, this.yAt(s1));
              g.lineTo(x1 - w * s1, this.yAt(s1));
              g.closePath();
              g.fill();
              g.globalAlpha = 1;
            }
          }
        }
        if (st === 1) continue;
        if (u > 1) continue;
        const s = this.scaleAt(u);
        const y = this.yAt(s);
        const alpha = missed ? 0.35 : u > 0.86 ? (1 - u) / 0.14 : 1;
        g.globalAlpha = Math.max(0, alpha);
        if (note.open) {
          const w = hw * s * 0.96;
          const h = Math.max(4, 18 * s);
          g.fillStyle = useSuper ? SUPER_COLOR : OPEN_COLOR;
          g.beginPath();
          g.roundRect(cx - w, y - h / 2, w * 2, h, h / 2);
          g.fill();
          g.fillStyle = note.hopo ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
          g.fillRect(cx - w * 0.9, y - h * 0.16, w * 1.8, h * 0.32);
        } else {
          const type = note.tap ? 'tap' : note.hopo ? 'hopo' : 'strum';
          const set = this.sprites[useSuper ? `${type}S` : type];
          const dw = rx * 2.3 * s;
          const dh = dw * (SPR_H / SPR_W);
          const hitMask = eng ? eng.hitMask[i] : 0;
          for (const lane of note.frets) {
            if (hitMask & (1 << lane)) continue;
            g.drawImage(set[lane], this.laneX(lane, s) - dw / 2, y - dh / 2 - 2 * s, dw, dh);
          }
        }
        g.globalAlpha = 1;
      }

      // percikan di lane yang sedang sustain
      if (eng) {
        for (const sus of eng.sustains) {
          for (let lane = 0; lane < 5; lane++) {
            if (!(sus.mask & (1 << lane))) continue;
            const x = this.laneX(lane, 1);
            const flick = 0.6 + 0.4 * Math.sin(now / 28 + lane);
            const glow = g.createRadialGradient(x, this.strikeY, 2, x, this.strikeY, rx * 1.5);
            glow.addColorStop(0, `rgba(255,255,255,${0.75 * flick})`);
            glow.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = glow;
            g.fillRect(x - rx * 1.5, this.strikeY - rx * 1.5, rx * 3, rx * 3);
          }
        }
      }
    }

    // kilatan hit / miss
    for (let k = this.flashes.length - 1; k >= 0; k--) {
      const f = this.flashes[k];
      const age = (now - f.t) / 260;
      if (age >= 1) {
        this.flashes.splice(k, 1);
        continue;
      }
      const x = f.lane < 0 ? cx : this.laneX(f.lane, 1);
      if (f.kind === 'hit') {
        const r = rx * (0.7 + age * 1.3);
        g.globalAlpha = 1 - age;
        g.strokeStyle = '#ffffff';
        g.lineWidth = 5 * (1 - age) + 1;
        g.beginPath();
        g.ellipse(x, this.strikeY, r, r * 0.5, 0, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = sup ? SUPER_COLOR : f.lane < 0 ? OPEN_COLOR : LANE_COLORS[f.lane];
        g.beginPath();
        g.moveTo(x - rx * 0.5, this.strikeY);
        g.lineTo(x, this.strikeY - rx * (1.2 + age * 1.6));
        g.lineTo(x + rx * 0.5, this.strikeY);
        g.closePath();
        g.fill();
      } else {
        g.globalAlpha = (1 - age) * 0.8;
        g.strokeStyle = '#f0353c';
        g.lineWidth = 4;
        const d = rx * 0.5;
        g.beginPath();
        g.moveTo(x - d, this.strikeY - d * 0.6);
        g.lineTo(x + d, this.strikeY + d * 0.6);
        g.moveTo(x + d, this.strikeY - d * 0.6);
        g.lineTo(x - d, this.strikeY + d * 0.6);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }
}
