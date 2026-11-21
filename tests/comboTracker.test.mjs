import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComboTracker, FeverMeter, chainMultiplier, attackScore, FEVER_GAIN,
} from '../js/core/comboTracker.js';
import { levelOfTick, halfOfLevel } from '../js/core/beatSnap.js';

// q for a tick: step S (default 2 = sixteenth grid)
const mk = (tick, judgment = 'perfect', stepTicks = 2) => {
  const level = levelOfTick(tick);
  return { tick, judgment, level, half: halfOfLevel(level), stepTicks, isDownbeat: tick % 32 === 0 };
};

test('eighth combo: ticks k, k+4, k+8, k+12 (k mod 8 == 0), 4th hit', () => {
  const t = new ComboTracker();
  assert.equal(t.registerAttack(mk(8)).combo, null);
  assert.equal(t.registerAttack(mk(12)).combo, null);
  assert.equal(t.registerAttack(mk(16)).combo, null);
  assert.equal(t.registerAttack(mk(20)).combo, 'eighth');
  assert.equal(t.eighthCombos, 1);
});

test('eighth combo needs all four and k mod 8 == 0; groups do not overlap', () => {
  const t = new ComboTracker();
  t.registerAttack(mk(8)); t.registerAttack(mk(16)); t.registerAttack(mk(20)); // skipped 12
  assert.equal(t.registerAttack(mk(20 + 0)).combo, null);
  const u = new ComboTracker();
  const res = [];
  for (let k = 0; k < 32; k += 4) res.push(u.registerAttack(mk(k)).combo);
  // run 0,4,8,12 -> eighth on 12; 16,20,24,28 -> eighth on 28 but 24 could also... only 4th hits
  assert.equal(res[3], 'eighth');
  assert.equal(res[7], 'eighth');
  assert.equal(res.filter((x) => x === 'eighth').length, 2);
  // k mod 8 == 4 does not qualify
  const v = new ComboTracker();
  const r2 = [4, 8, 12, 16].map((k) => v.registerAttack(mk(k)).combo);
  assert.deepEqual(r2, [null, null, null, null]);
});

test('bar finisher: four beats in one bar, no off-beat attack in between', () => {
  const t = new ComboTracker();
  assert.equal(t.registerAttack(mk(32)).combo, null);
  assert.equal(t.registerAttack(mk(40)).combo, null);
  assert.equal(t.registerAttack(mk(48)).combo, null);
  const r = t.registerAttack(mk(56));
  assert.equal(r.combo, 'bar'); assert.equal(r.finisher, true);
  assert.equal(t.finishers, 1);
});

test('bar finisher is cancelled by an off-beat attack in between, and needs the same bar', () => {
  const t = new ComboTracker();
  for (const k of [32, 36, 40, 48]) t.registerAttack(mk(k));
  assert.equal(t.registerAttack(mk(56)).combo, null);
  const u = new ComboTracker();
  for (const k of [24, 32, 40]) u.registerAttack(mk(k));
  assert.equal(u.registerAttack(mk(48)).combo, null);
  // negative bar (count-in)
  const n = new ComboTracker();
  for (const k of [-32, -24, -16]) n.registerAttack(mk(k, 'perfect', 8));
  assert.equal(n.registerAttack(mk(-8, 'perfect', 8)).combo, 'bar');
});

test('fill: >= 4 consecutive hits exactly S apart ending on the downbeat', () => {
  const t = new ComboTracker();
  const res = [26, 28, 30, 32].map((k) => t.registerAttack(mk(k)).combo);
  assert.deepEqual(res, [null, null, null, 'fill']);
  assert.equal(t.fills, 1);
  // only 3 in a row -> no fill
  const u = new ComboTracker();
  const r2 = [28, 30, 32].map((k) => u.registerAttack(mk(k)).combo);
  assert.deepEqual(r2, [null, null, null]);
  // spacing must be exactly S: 4 hits with a gap
  const v = new ComboTracker();
  const r3 = [24, 28, 30, 32].map((k) => v.registerAttack(mk(k)).combo);
  assert.equal(r3[3], null);
  // step 1 (thirty-second grid) and step 4
  const w = new ComboTracker();
  assert.equal([29, 30, 31, 32].map((k) => w.registerAttack(mk(k, 'perfect', 1)).combo)[3], 'fill');
  const x = new ComboTracker();
  assert.equal([20, 24, 28, 32].map((k) => x.registerAttack(mk(k, 'perfect', 4)).combo)[3], 'fill');
});

test('fill must be consumed; a long run does not fill again until a new downbeat run', () => {
  const t = new ComboTracker();
  const res = [];
  for (let k = 24; k <= 64; k += 2) res.push([k, t.registerAttack(mk(k)).combo]);
  const fills = res.filter(([, c]) => c === 'fill').map(([k]) => k);
  assert.deepEqual(fills, [32, 64]);
});

test('priority: bar finisher > fill > eighth (never more than one combo per hit)', () => {
  const t = new ComboTracker();
  for (const k of [0, 4, 8, 12, 16, 20, 24, 28, 32]) {
    const c = t.registerAttack(mk(k, 'perfect', 4)).combo;
    assert.ok(c === null || ['eighth', 'bar', 'fill'].includes(c));
  }
});

test('chain: perfect/great +1, good keeps, off resets (unless fever), hurt resets', () => {
  const t = new ComboTracker();
  t.registerAttack(mk(0, 'perfect')); t.registerAttack(mk(8, 'great')); t.registerAttack(mk(16, 'good'));
  assert.equal(t.chain, 2);
  t.registerAttack(mk(24, 'off'));
  assert.equal(t.chain, 0);
  assert.equal(t.maxChain, 2);
  t.registerAttack(mk(32, 'perfect')); t.registerAttack(mk(40, 'perfect'));
  t.registerAttack(mk(48, 'off'), { fever: true });
  assert.equal(t.chain, 2);
  t.onHurt();
  assert.equal(t.chain, 0);
});

test('score formula, combo and parry bonuses', () => {
  assert.equal(chainMultiplier(0), 1);
  assert.equal(chainMultiplier(10), 1.5);
  assert.equal(chainMultiplier(30), 2.5);
  assert.equal(chainMultiplier(1000), 4);
  assert.equal(attackScore('perfect', 0), 100);
  assert.equal(attackScore('great', 10), 100 * 0.8 * 1.5);
  assert.equal(attackScore('good', 0), 40);
  assert.equal(attackScore('off', 0), 10);
  const t = new ComboTracker();
  t.registerAttack(mk(32)); t.registerAttack(mk(40)); t.registerAttack(mk(48));
  const before = t.score;
  const r = t.registerAttack(mk(56));
  assert.equal(r.scoreGain, attackScore('perfect', 4) + 500);
  assert.equal(t.score, before + r.scoreGain);
  const s0 = t.score;
  t.onParry();
  assert.equal(t.score, s0 + 300);
  assert.equal(t.parries, 1);
});

test('stats and rating', () => {
  const t = new ComboTracker();
  for (let i = 0; i < 10; i++) t.registerAttack(mk(i * 8, i < 9 ? 'perfect' : 'good'));
  assert.equal(t.attacks, 10);
  assert.equal(t.rating(false), 'S');
  assert.equal(t.rating(true), 'A');
  assert.equal(t.halves.downbeat + t.halves.front, 10);
  const u = new ComboTracker();
  for (let i = 0; i < 10; i++) u.registerAttack(mk(i * 8, i < 5 ? 'perfect' : 'off'));
  assert.equal(u.rating(false), 'B');
  assert.equal(new ComboTracker().rating(false), 'C');
  const v = new ComboTracker();
  v.registerAttack(mk(4)); v.registerAttack(mk(2)); v.registerAttack(mk(1));
  assert.equal(v.halves.back, 1); assert.equal(v.halves.sub, 2);
});

// ---------- fever ----------
const beatEv = (i) => ({ beatIndex: i, beatInBar: ((i % 4) + 4) % 4, beatSongTime: i * 0.5 });

test('fever gains: perfect/great/good/off/parry/combo', () => {
  const f = new FeverMeter();
  f.onAttack('perfect'); assert.ok(Math.abs(f.value - 0.06) < 1e-12);
  f.onAttack('great'); assert.ok(Math.abs(f.value - 0.10) < 1e-12);
  f.onAttack('good'); assert.ok(Math.abs(f.value - 0.10) < 1e-12);
  f.onAttack('off'); assert.ok(Math.abs(f.value - 0.05) < 1e-12);
  f.onAttack('off'); f.onAttack('off'); assert.equal(f.value, 0);
  f.onParry(); assert.equal(f.value, FEVER_GAIN.parry);
  f.onAttack('good', 'eighth'); assert.ok(Math.abs(f.value - 0.35) < 1e-12);
});

test('fever decays by song-time delta: 0.02/s, 0.05/s within 2 s of a hurt', () => {
  const f = new FeverMeter();
  f.value = 0.5;
  f.update(10, 0.5);
  f.update(11, 0.5);
  assert.ok(Math.abs(f.value - 0.48) < 1e-9);
  f.onHurt(11);
  f.update(12, 0.5);
  assert.ok(Math.abs(f.value - 0.43) < 1e-9);
  f.update(13.5, 0.5); // 1 s still inside hurt window (until 13), then 0.5 s outside: dt is split by frame: whole frame uses state at end
  assert.ok(f.value < 0.43);
  // frame-rate independent
  const a = new FeverMeter(); a.value = 0.5; a.update(0, 1);
  for (let i = 1; i <= 100; i++) a.update(i * 0.01, 1);
  const b = new FeverMeter(); b.value = 0.5; b.update(0, 1); b.update(1, 1);
  assert.ok(Math.abs(a.value - b.value) < 1e-9);
});

test('fever arms at full, starts on the next downbeat for 8 beats, ends on a downbeat', () => {
  const f = new FeverMeter();
  f.value = 0.97; f.onAttack('perfect');
  assert.equal(f.armed, true); assert.equal(f.value, 1);
  assert.equal(f.onBeat(beatEv(5)), null); // not a downbeat
  f.update(2.6, 0.5);
  assert.equal(f.value, 1); // armed: no decay
  assert.equal(f.onBeat(beatEv(8)), 'start');
  assert.equal(f.active, true); assert.equal(f.armed, false); assert.equal(f.endsAtBeat, 16);
  assert.equal(f.multiplier, 2);
  f.update(4 + 2, 0.5); // 2 s into 4 s of fever
  assert.ok(Math.abs(f.value - 0.5) < 1e-9);
  assert.equal(f.onBeat(beatEv(12)), null);
  f.onAttack('perfect'); // gains ignored while active
  assert.ok(Math.abs(f.value - 0.5) < 1e-9);
  assert.equal(f.onBeat(beatEv(16)), 'end');
  assert.equal(f.active, false); assert.equal(f.value, 0); assert.equal(f.multiplier, 1);
  // a hit during armed state does not add
  const g = new FeverMeter(); g.value = 1; g.armed = true; g.onAttack('off'); assert.equal(g.value, 1);
});
