import test from 'node:test';
import assert from 'node:assert/strict';
import { ComboTracker, chainMultiplier, attackScore } from '../js/core/comboTracker.js';
import { quantizeAttack } from '../js/core/quantizer.js';

const mk = (k, judgment = 'perfect') => {
  const q = quantizeAttack({ inputSongTime: k * 0.25, bpm: 120 });
  return { ...q, judgment };
};

test('eighth combo triggers on 4th of four consecutive slots (front,back,front,back)', () => {
  const t = new ComboTracker();
  assert.equal(t.registerAttack(mk(8)).eighth, false);
  assert.equal(t.registerAttack(mk(9)).eighth, false);
  assert.equal(t.registerAttack(mk(10)).eighth, false);
  assert.equal(t.registerAttack(mk(11)).eighth, true);
  assert.equal(t.eighthCombos, 1);
});

test('eighth combo needs all four slots', () => {
  const t = new ComboTracker();
  t.registerAttack(mk(8)); t.registerAttack(mk(10)); // skip 9
  assert.equal(t.registerAttack(mk(11)).eighth, false);
});

test('eighth combo groups do not overlap', () => {
  const t = new ComboTracker();
  const res = [];
  for (let k = 0; k < 8; k++) res.push(t.registerAttack(mk(k)).eighth);
  assert.deepEqual(res, [false, false, false, true, false, false, false, true]);
});

test('bar finisher: four front beats in one bar, no back beats between', () => {
  const t = new ComboTracker();
  assert.equal(t.registerAttack(mk(16)).finisher, false);
  assert.equal(t.registerAttack(mk(18)).finisher, false);
  assert.equal(t.registerAttack(mk(20)).finisher, false);
  const r = t.registerAttack(mk(22));
  assert.equal(r.finisher, true);
  assert.equal(r.eighth, false);
  assert.equal(t.finishers, 1);
});

test('bar finisher cancelled by a back-beat attack in between', () => {
  const t = new ComboTracker();
  t.registerAttack(mk(16)); t.registerAttack(mk(17)); t.registerAttack(mk(18)); t.registerAttack(mk(20));
  assert.equal(t.registerAttack(mk(22)).finisher, false);
});

test('bar finisher needs the same bar', () => {
  const t = new ComboTracker();
  t.registerAttack(mk(14)); t.registerAttack(mk(16)); t.registerAttack(mk(18));
  assert.equal(t.registerAttack(mk(20)).finisher, false);
  const u = new ComboTracker();
  u.registerAttack(mk(2)); u.registerAttack(mk(4)); u.registerAttack(mk(6));
  assert.equal(u.registerAttack(mk(8)).finisher, false);
  // negative bar (count-in) works too
  const n = new ComboTracker();
  n.registerAttack(mk(-8)); n.registerAttack(mk(-6)); n.registerAttack(mk(-4));
  assert.equal(n.registerAttack(mk(-2)).finisher, true);
});

test('chain: perfect/great/good increment, auto resets, hurt resets', () => {
  const t = new ComboTracker();
  t.registerAttack(mk(0, 'perfect'));
  t.registerAttack(mk(2, 'great'));
  t.registerAttack(mk(4, 'good'));
  assert.equal(t.chain, 3);
  t.registerAttack(mk(6, 'auto'));
  assert.equal(t.chain, 0);
  assert.equal(t.maxChain, 3);
  t.registerAttack(mk(8, 'perfect'));
  t.onHurt();
  assert.equal(t.chain, 0);
});

test('score formula and combo bonus', () => {
  assert.equal(chainMultiplier(0), 1);
  assert.equal(chainMultiplier(10), 1.5);
  assert.equal(chainMultiplier(30), 2.5);
  assert.equal(chainMultiplier(1000), 4);
  assert.equal(attackScore('perfect', 0), 100);
  assert.equal(attackScore('great', 10), 100 * 0.8 * 1.5);
  assert.equal(attackScore('auto', 0), 20);
  const t = new ComboTracker();
  t.registerAttack(mk(8)); t.registerAttack(mk(9)); t.registerAttack(mk(10));
  const before = t.score;
  const r = t.registerAttack(mk(11));
  assert.equal(r.scoreGain, 100 + 500);
  assert.equal(t.score, before + 600);
});

test('stats and rating', () => {
  const t = new ComboTracker();
  for (let i = 0; i < 10; i++) t.registerAttack(mk(i * 2, i < 9 ? 'perfect' : 'good'));
  assert.equal(t.attacks, 10);
  assert.equal(t.rating(false), 'S');
  assert.equal(t.rating(true), 'A');
  assert.equal(t.halves.downbeat + t.halves.front, 10);
  const u = new ComboTracker();
  for (let i = 0; i < 10; i++) u.registerAttack(mk(i * 2, i < 5 ? 'perfect' : 'auto'));
  assert.equal(u.rating(false), 'B');
  const v = new ComboTracker();
  for (let i = 0; i < 10; i++) v.registerAttack(mk(i * 2, i < 2 ? 'perfect' : 'auto'));
  assert.equal(v.rating(false), 'C');
  assert.equal(new ComboTracker().rating(false), 'C');
});
