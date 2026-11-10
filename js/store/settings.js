// Settings + skor tersimpan di localStorage.

const KEY = 'superband.settings.v1';
const SCORE_KEY = 'superband.scores.v1';

export const DEFAULTS = {
  noteSpeed: 5,
  audioOffsetMs: 0,
  musicVolume: 0.9,
  sfxVolume: 0.7,
  hitWindow: 'normal',
  ghostPenalty: true,
  lefty: false,
  playMode: 'tap',
  gamepadPreset: 'pad',
  tapHighwayForSuper: true,
  haptics: true,
  keys: {
    frets: [['KeyA', 'Digit1'], ['KeyS', 'Digit2'], ['KeyD', 'Digit3'], ['KeyF', 'Digit4'], ['KeyG', 'Digit5']],
    strum: ['ArrowUp', 'ArrowDown', 'Enter'],
    super: ['Space'],
    pause: ['Escape', 'KeyP'],
  },
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* storage penuh / private mode */
  }
}

export const settings = { ...DEFAULTS, ...read(KEY, {}) };
settings.keys = { ...DEFAULTS.keys, ...(settings.keys || {}) };

export function saveSettings() {
  write(KEY, settings);
}

export function resetSettings() {
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, JSON.parse(JSON.stringify(DEFAULTS)));
  saveSettings();
}

// detik note terlihat sebelum sampai strikeline
export function lookahead() {
  const table = [3.0, 2.5, 2.1, 1.8, 1.5, 1.25, 1.05, 0.9, 0.78, 0.68];
  return table[Math.max(1, Math.min(10, settings.noteSpeed)) - 1];
}

const scores = read(SCORE_KEY, {});

export function getScore(id, part, diff) {
  return scores[`${id}|${part}|${diff}`] || null;
}

export function bestStars(id) {
  let best = null;
  for (const k of Object.keys(scores)) {
    if (k.startsWith(`${id}|`) && (!best || scores[k].stars > best.stars)) best = scores[k];
  }
  return best;
}

export function submitScore(id, part, diff, result) {
  const key = `${id}|${part}|${diff}`;
  const prev = scores[key];
  const isBest = !prev || result.score > prev.score;
  if (isBest) {
    scores[key] = {
      score: result.score,
      stars: result.stars,
      gold: result.gold,
      accuracy: result.accuracy,
      maxStreak: result.maxStreak,
      fullCombo: result.fullCombo,
      at: Date.now(),
    };
    write(SCORE_KEY, scores);
  }
  return { isBest, prev };
}

export function clearScores() {
  for (const k of Object.keys(scores)) delete scores[k];
  write(SCORE_KEY, scores);
}
