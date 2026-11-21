import test from 'node:test';
import assert from 'node:assert/strict';
import * as bm from '../js/core/beatMath.js';

test('beatDur / halfStep', () => {
  assert.ok(Math.abs(bm.beatDur(120) - 0.5) < 1e-12);
  assert.ok(Math.abs(bm.halfStep(120) - 0.25) < 1e-12);
  assert.ok(Math.abs(bm.halfStep(88) - 30 / 88) < 1e-12);
});

test('clampBpm', () => {
  assert.equal(bm.clampBpm(10), 40);
  assert.equal(bm.clampBpm(999), 240);
  assert.equal(bm.clampBpm(72.46), 72.5);
  assert.equal(bm.clampBpm(NaN), 88);
});

test('mod handles negatives', () => {
  assert.equal(bm.mod(-1, 4), 3);
  assert.equal(bm.mod(-4, 4), 0);
  assert.equal(bm.mod(5, 4), 1);
});

test('beatInBar and barIndex incl. negative count-in beats', () => {
  assert.equal(bm.beatInBarOf(0), 0);
  assert.equal(bm.beatInBarOf(3), 3);
  assert.equal(bm.beatInBarOf(4), 0);
  assert.equal(bm.beatInBarOf(-1), 3);
  assert.equal(bm.beatInBarOf(-4), 0);
  assert.equal(bm.barIndexOf(-1), -1);
  assert.equal(bm.barIndexOf(-4), -1);
  assert.equal(bm.barIndexOf(4), 1);
  assert.equal(bm.isDownbeatIndex(-4), true);
});

test('slot info: front/back, beat index, downbeat', () => {
  const a = bm.slotInfo(0, 88);
  assert.equal(a.half, 'front'); assert.equal(a.isDownbeat, true); assert.equal(a.beatIndex, 0);
  const b = bm.slotInfo(1, 88);
  assert.equal(b.half, 'back'); assert.equal(b.isDownbeat, false); assert.equal(b.beatIndex, 0);
  const c = bm.slotInfo(8, 88);
  assert.equal(c.isDownbeat, true); assert.equal(c.beatIndex, 4); assert.equal(c.barIndex, 1);
  const d = bm.slotInfo(-1, 88);
  assert.equal(d.half, 'back'); assert.equal(d.beatIndex, -1); assert.equal(d.beatInBar, 3);
  const e = bm.slotInfo(-8, 88);
  assert.equal(e.isDownbeat, true); assert.equal(e.beatIndex, -4);
  const f = bm.slotInfo(6, 88);
  assert.equal(f.beatInBar, 3); assert.equal(f.isDownbeat, false);
});

test('index at exact boundaries is float safe at many BPMs', () => {
  for (const bpm of [88, 72.5, 120, 150, 173.3, 40, 240, 99.9]) {
    for (let k = -40; k <= 400; k++) {
      const t = bm.slotSongTime(k, bpm);
      assert.equal(bm.slotIndexAt(t, bpm), k, `bpm ${bpm} k ${k}`);
      if (k % 2 === 0) assert.equal(bm.beatIndexAt(t, bpm), k / 2, `beat bpm ${bpm} k ${k}`);
    }
  }
});

test('beatInfoAt phase in [0,1] and pulse envelope', () => {
  const i = bm.beatInfoAt(0.25, 120);
  assert.equal(i.beatIndex, 0);
  assert.ok(Math.abs(i.beatPhase - 0.5) < 1e-9);
  const neg = bm.beatInfoAt(-0.25, 120);
  assert.equal(neg.beatIndex, -1);
  assert.ok(Math.abs(neg.beatPhase - 0.5) < 1e-9);
  assert.ok(Math.abs(bm.pulseAt(0, 0) - 1) < 1e-12);
  assert.ok(Math.abs(bm.pulseAt(0, 2) - 0.55) < 1e-12);
  assert.ok(bm.pulseAt(1, 0) < 0.01);
});

test('formatBarBeat', () => {
  assert.deepEqual(bm.formatBarBeat(0), { bar: 1, beat: 1, countIn: false });
  assert.deepEqual(bm.formatBarBeat(11), { bar: 3, beat: 4, countIn: false });
  assert.equal(bm.formatBarBeat(-3).countIn, true);
});
