// Input terpadu: touch, keyboard, gamepad / guitar controller.

import { settings } from '../store/settings.js';
import { tapHaptic } from './haptics.js';

export const GAMEPAD_PRESETS = {
  // gamepad biasa: LT LB RB RT A
  pad: { frets: [6, 4, 5, 7, 0], strum: [12, 13], super: [2, 3], pause: [9] },
  // guitar controller: hijau merah kuning biru oranye
  guitar: { frets: [0, 1, 3, 2, 4], strum: [12, 13], super: [8], pause: [9] },
};

export class Input {
  // h: { timeAt(perfMs), fret(lane, down, t), strum(t), superKey(t), pause() }
  constructor(surface, highway, h) {
    this.surface = surface;
    this.highway = highway;
    this.h = h;
    this.pointers = new Map();
    this.laneCount = [0, 0, 0, 0, 0];
    this.keyDown = new Set();
    this.padState = {};
    this.enabled = false;
    this._pd = (e) => this.pointerDown(e);
    this._pm = (e) => this.pointerMove(e);
    this._pu = (e) => this.pointerUp(e);
    this._kd = (e) => this.key(e, true);
    this._ku = (e) => this.key(e, false);
    this._ctx = (e) => e.preventDefault();
  }

  attach() {
    if (this.enabled) return;
    this.enabled = true;
    const s = this.surface;
    s.addEventListener('pointerdown', this._pd);
    s.addEventListener('pointermove', this._pm);
    s.addEventListener('pointerup', this._pu);
    s.addEventListener('pointercancel', this._pu);
    s.addEventListener('contextmenu', this._ctx);
    window.addEventListener('keydown', this._kd);
    window.addEventListener('keyup', this._ku);
    this.timer = setInterval(() => this.pollPads(), 4);
  }

  detach() {
    if (!this.enabled) return;
    this.enabled = false;
    const s = this.surface;
    s.removeEventListener('pointerdown', this._pd);
    s.removeEventListener('pointermove', this._pm);
    s.removeEventListener('pointerup', this._pu);
    s.removeEventListener('pointercancel', this._pu);
    s.removeEventListener('contextmenu', this._ctx);
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
    clearInterval(this.timer);
    this.releaseAll();
  }

  releaseAll() {
    const t = this.h.timeAt(performance.now());
    for (let lane = 0; lane < 5; lane++) {
      if (this.laneCount[lane] > 0) this.h.fret(lane, false, t);
      this.laneCount[lane] = 0;
    }
    this.pointers.clear();
    this.keyDown.clear();
    this.padState = {};
  }

  setLane(lane, down, t) {
    if (down) {
      if (this.laneCount[lane]++ === 0) this.h.fret(lane, true, t);
    } else if (this.laneCount[lane] > 0 && --this.laneCount[lane] === 0) this.h.fret(lane, false, t);
  }

  stamp(e) {
    // sebagian browser memberi timeStamp 0 atau epoch; pakai performance.now() kalau tidak masuk akal
    const now = performance.now();
    const ts = e.timeStamp > 0 && e.timeStamp <= now + 5 && now - e.timeStamp < 250 ? e.timeStamp : now;
    return this.h.timeAt(ts);
  }

  local(e) {
    const r = this.surface.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  pointerDown(e) {
    e.preventDefault();
    const [x, y] = this.local(e);
    const lane = this.highway.laneAt(x, y);
    const t = this.stamp(e);
    if (lane === null) {
      if (settings.tapHighwayForSuper) this.h.superKey(t);
      return;
    }
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch (err) {
      /* abaikan */
    }
    this.pointers.set(e.pointerId, lane);
    this.setLane(lane, true, t);
    if (settings.hapticTap) tapHaptic();
  }

  pointerMove(e) {
    const cur = this.pointers.get(e.pointerId);
    if (cur === undefined) return;
    const [x, y] = this.local(e);
    const lane = this.highway.laneAt(x, Math.max(y, this.highway.fretZoneTop));
    if (lane === null || lane === cur) return;
    // hysteresis: harus masuk cukup dalam ke lane sebelah
    const frac = this.highway.laneFrac(x);
    if (frac < 0.18 || frac > 0.82) return;
    const t = this.stamp(e);
    this.setLane(cur, false, t);
    this.pointers.set(e.pointerId, lane);
    this.setLane(lane, true, t);
    if (settings.hapticTap) tapHaptic();
  }

  pointerUp(e) {
    const cur = this.pointers.get(e.pointerId);
    if (cur === undefined) return;
    this.pointers.delete(e.pointerId);
    this.setLane(cur, false, this.stamp(e));
  }

  key(e, down) {
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    const code = e.code;
    const k = settings.keys;
    const t = this.stamp(e);
    for (let lane = 0; lane < 5; lane++) {
      if (k.frets[lane].includes(code)) {
        e.preventDefault();
        if (down && this.keyDown.has(code)) return;
        if (down) this.keyDown.add(code);
        else if (!this.keyDown.delete(code)) return;
        this.setLane(lane, down, t);
        return;
      }
    }
    if (!down) return;
    if (k.strum.includes(code)) {
      e.preventDefault();
      this.h.strum(t);
    } else if (k.super.includes(code)) {
      e.preventDefault();
      this.h.superKey(t);
    } else if (k.pause.includes(code)) {
      e.preventDefault();
      this.h.pause();
    }
  }

  pollPads() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const preset = GAMEPAD_PRESETS[settings.gamepadPreset] || GAMEPAD_PRESETS.pad;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const prev = this.padState[pad.index] || (this.padState[pad.index] = []);
      const t = this.h.timeAt(performance.now());
      for (let b = 0; b < pad.buttons.length; b++) {
        const btn = pad.buttons[b];
        const down = btn.pressed || btn.value > 0.5;
        if (down === !!prev[b]) continue;
        prev[b] = down;
        const lane = preset.frets.indexOf(b);
        if (lane >= 0) this.setLane(lane, down, t);
        else if (down && preset.strum.includes(b)) this.h.strum(t);
        else if (down && preset.super.includes(b)) this.h.superKey(t);
        else if (down && preset.pause.includes(b)) this.h.pause();
      }
    }
  }
}
