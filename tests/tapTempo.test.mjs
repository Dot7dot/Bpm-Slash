import test from 'node:test';
import assert from 'node:assert/strict';
import { TapTempo } from '../js/core/tapTempo.js';

test('first tap gives null, second gives bpm', () => {
  const t = new TapTempo();
  assert.equal(t.tap(0), null);
  assert.equal(t.tap(0.5), 120);
});

test('averages intervals', () => {
  const t = new TapTempo();
  let bpm;
  for (let i = 0; i < 6; i++) bpm = t.tap(i * (60 / 88));
  assert.ok(Math.abs(bpm - 88) < 0.06);
});

test('keeps only the last 8 intervals', () => {
  const t = new TapTempo();
  let time = 0;
  for (let i = 0; i < 10; i++) { t.tap(time); time += 1; } // 60 BPM
  time -= 0.5;
  let bpm;
  for (let i = 0; i < 9; i++) { time += 0.5; bpm = t.tap(time); } // 120 BPM
  assert.equal(t.count, 9);
  assert.ok(bpm > 115 && bpm <= 120, String(bpm));
});

test('resets after more than 2 seconds idle', () => {
  const t = new TapTempo();
  t.tap(0); t.tap(0.5); t.tap(1.0);
  assert.equal(t.tap(5.0), null);
  assert.equal(t.count, 1);
  assert.equal(t.tap(5.6), 100);
});

test('clamps and rounds to 0.1', () => {
  const t = new TapTempo();
  t.tap(0);
  assert.equal(t.tap(0.1), 240);
  const u = new TapTempo();
  u.tap(0);
  assert.equal(u.tap(1.9), 40);
  const w = new TapTempo();
  w.tap(0);
  assert.equal(w.tap(60 / 72.5), 72.5);
});

test('reset clears', () => {
  const t = new TapTempo();
  t.tap(0); t.tap(0.5); t.reset();
  assert.equal(t.count, 0);
  assert.equal(t.tap(1), null);
});
