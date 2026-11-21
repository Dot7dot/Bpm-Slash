import test from 'node:test';
import assert from 'node:assert/strict';
import { snapRef, grooveRef, combosRef } from '../tools/rhythm-audit.mjs';
import { beatSnap } from '../js/core/beatSnap.js';
import { evaluateGroove } from '../js/core/groove.js';
import { ComboTracker } from '../js/core/comboTracker.js';

function lcg(seed) { let a = seed >>> 0; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('audit reference snap equals the game beatSnap (new magnet cap, random inputs)', () => {
  const r = lcg(7);
  for (let i = 0; i < 4000; i++) {
    const bpm = [40, 72.5, 88, 120, 150, 240][Math.floor(r() * 6)];
    const sub = ['auto', 1, 2, 4, 8][Math.floor(r() * 5)];
    const t = r() * 20;
    const s = t + r() * 0.03;
    const minTick = r() < 0.5 ? -Infinity : Math.floor(t / (60 / bpm / 8)) + Math.floor(r() * 6) - 2;
    const strict = r() < 0.15;
    const lateGraceSec = strict ? 0 : 0.025;
    const a = beatSnap({ inputSongTime: t, schedNowSongTime: s, bpm, subdivision: sub, lateGraceSec, minTick, strict });
    const b = snapRef({ t, s, bpm, subdivision: sub, lateGraceSec, minTick, strict });
    assert.deepEqual([a.tick, a.rule, a.magnet, a.judgment], [b.tick, b.rule, b.magnet, b.judgment], `i=${i}`);
  }
});

test('audit groove reference equals evaluateGroove; combosRef equals ComboTracker with unison partners', () => {
  const r = lcg(11);
  for (let i = 0; i < 500; i++) {
    const bar = Math.floor(r() * 8) - 3;
    const hits = [];
    for (let k = 0; k < Math.floor(r() * 9); k++) hits.push({ tick: bar * 32 + Math.floor(r() * 4) * 8 + (r() < 0.2 ? 4 : 0), instrument: r() < 0.5 ? 'kick' : 'snare' });
    assert.equal(grooveRef(hits, bar), (evaluateGroove(hits, bar) || {}).id ?? null);
  }
  const seq = [];
  for (let n = 0; n < 6; n++) for (const t of [0, 8, 16, 24]) { seq.push({ tick: n * 32 + t, stepTicks: 2 }); if (r() < 0.5) seq.push({ tick: n * 32 + t, stepTicks: 2 }); }
  const trk = new ComboTracker();
  const got = seq.map((a) => trk.registerAttack({ ...a, judgment: 'perfect', level: 'beat', half: 'front' }).combo);
  assert.deepEqual(combosRef(seq), got);
});
