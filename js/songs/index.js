import neonRunway from './neonRunway.js';
import gamelanRiot from './gamelanRiot.js';
import senjaTerakhir from './senjaTerakhir.js';

// Urut dari yang paling mudah
export const BUILTIN_SONGS = [senjaTerakhir, neonRunway, gamelanRiot];

export function builtinById(id) {
  return BUILTIN_SONGS.find((s) => s.id === id) || null;
}
