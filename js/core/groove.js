// Drummer groove patterns (docs/DESIGN-DRUMMER.md section 4). Pure function, no DOM.
// A bar has 32 ticks; ticks 0 / 8 / 16 / 24 are beats 1 / 2 / 3 / 4.
import { TICKS_PER_BAR } from './beatSnap.js';

export const GROOVE_PATTERNS = Object.freeze({
  rock: { id: 'rock', name: '搖滾節奏', nameEn: 'Rock Beat', fever: 0.15, score: 500 },
  fourOnFloor: { id: 'fourOnFloor', name: '四拍大鼓', nameEn: 'Four on the Floor', fever: 0.15, score: 500 },
  backbeat: { id: 'backbeat', name: '反拍', nameEn: 'Backbeat', fever: 0.08, score: 250 },
});

/**
 * Evaluate one finished bar.
 * @param {Array<{tick:number, instrument:'kick'|'snare'}>} hits hits that connected in the bar
 * @param {number} barIndex bar being evaluated (may be negative during the count-in)
 * @returns {null | {id:string, name:string, nameEn:string, fever:number, score:number}}
 *   Only the best pattern is returned: rock > fourOnFloor > backbeat. Extra hits are allowed; hits outside
 *   the bar and unknown instruments are ignored.
 */
export function evaluateGroove(hits, barIndex) {
  const base = barIndex * TICKS_PER_BAR;
  const kick = new Set();
  const snare = new Set();
  for (const h of hits || []) {
    if (!h) continue;
    const pos = h.tick - base;
    if (!Number.isInteger(pos) || pos < 0 || pos >= TICKS_PER_BAR) continue;
    if (h.instrument === 'kick') kick.add(pos);
    else if (h.instrument === 'snare') snare.add(pos);
  }
  const k = (...p) => p.every((x) => kick.has(x));
  const s = (...p) => p.every((x) => snare.has(x));
  let id = null;
  if (k(0, 16) && s(8, 24)) id = 'rock';
  else if (k(0, 8, 16, 24)) id = 'fourOnFloor';
  else if (s(8, 24)) id = 'backbeat';
  return id ? { ...GROOVE_PATTERNS[id] } : null;
}
