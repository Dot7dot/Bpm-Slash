import test from 'node:test';
import assert from 'node:assert/strict';
import { quantizeAttack, judgeDelta } from '../js/core/quantizer.js';
import { slotSongTime } from '../js/core/beatMath.js';

const BPMS = [88, 72.5, 120, 150, 173.3];

test('exact slot time picks that slot with delta ~0 at many BPMs', () => {
  for (const bpm of BPMS) {
    for (let k = -8; k < 300; k++) {
      const q = quantizeAttack({ inputSongTime: slotSongTime(k, bpm), bpm });
      assert.equal(q.slotIndex, k, `bpm ${bpm} k ${k}`);
      assert.ok(Math.abs(q.deltaSec) < 1e-6);
      assert.equal(q.judgment, 'perfect');
      assert.equal(q.late, false);
    }
  }
});

test('slotSongTime is always a multiple of halfStep', () => {
  for (const bpm of BPMS) {
    const h = 30 / bpm;
    for (let i = 0; i < 100; i++) {
      const t = 0.0137 * i + 0.3;
      const q = quantizeAttack({ inputSongTime: t, bpm });
      assert.ok(Math.abs(q.slotSongTime / h - Math.round(q.slotSongTime / h)) < 1e-6);
      assert.equal(q.slotSongTime, q.slotIndex * h);
    }
  }
});

test('early press snaps forward, late within grace snaps back', () => {
  const bpm = 120; // halfStep 0.25
  let q = quantizeAttack({ inputSongTime: 0.20, bpm });
  assert.equal(q.slotIndex, 1); assert.equal(q.late, false);
  assert.ok(q.deltaSec < 0);
  q = quantizeAttack({ inputSongTime: 0.28, bpm, lateGraceSec: 0.04 });
  assert.equal(q.slotIndex, 1); assert.equal(q.late, true);
  assert.ok(Math.abs(q.deltaSec - 0.03) < 1e-9);
  q = quantizeAttack({ inputSongTime: 0.30, bpm, lateGraceSec: 0.04 });
  assert.equal(q.slotIndex, 2); assert.equal(q.late, false);
});

test('late grace boundary is inclusive', () => {
  const bpm = 120;
  const q = quantizeAttack({ inputSongTime: 0.25 + 0.04, bpm, lateGraceSec: 0.04 });
  assert.equal(q.slotIndex, 1); assert.equal(q.late, true);
});

test('strict mode (grace 0) always snaps forward unless exactly on slot', () => {
  const bpm = 120;
  let q = quantizeAttack({ inputSongTime: 0.251, bpm, lateGraceSec: 0 });
  assert.equal(q.slotIndex, 2); assert.equal(q.late, false);
  q = quantizeAttack({ inputSongTime: 0.25, bpm, lateGraceSec: 0 });
  assert.equal(q.slotIndex, 1);
  q = quantizeAttack({ inputSongTime: 0.2499999, bpm, lateGraceSec: 0 });
  assert.equal(q.slotIndex, 1);
});

test("'beat' mode only yields even slots", () => {
  for (const bpm of BPMS) {
    for (let i = 0; i < 400; i++) {
      const t = -1 + i * 0.0231;
      const q = quantizeAttack({ inputSongTime: t, bpm, mode: 'beat' });
      assert.equal(Math.abs(q.slotIndex % 2), 0, `bpm ${bpm} t ${t} -> ${q.slotIndex}`);
      assert.equal(q.half, 'front');
      assert.ok(q.slotSongTime >= t - 0.04 - 1e-9);
    }
  }
});

test("'beat' mode late grace applies to previous even slot", () => {
  const bpm = 120; // beat 0.5
  let q = quantizeAttack({ inputSongTime: 0.52, bpm, mode: 'beat' });
  assert.equal(q.slotIndex, 2); assert.equal(q.late, true);
  q = quantizeAttack({ inputSongTime: 0.30, bpm, mode: 'beat' }); // between slot1 and slot2: prev even = 0 is 0.3 late
  assert.equal(q.slotIndex, 2);
  q = quantizeAttack({ inputSongTime: 0.55, bpm, mode: 'beat' });
  assert.equal(q.slotIndex, 4);
});

test('minSlotIndex queueing', () => {
  const bpm = 120;
  // would pick slot 1 normally
  let q = quantizeAttack({ inputSongTime: 0.24, bpm, minSlotIndex: 2 });
  assert.equal(q.slotIndex, 2);
  assert.equal(q.late, false);
  assert.equal(q.judgment, 'auto'); // 10ms early but forced to slot 2 -> far
  // prev would be valid (late) but is below min
  q = quantizeAttack({ inputSongTime: 0.27, bpm, minSlotIndex: 2 });
  assert.equal(q.slotIndex, 2);
  // min far in the future
  q = quantizeAttack({ inputSongTime: 0.27, bpm, minSlotIndex: 9 });
  assert.equal(q.slotIndex, 9);
  // beat mode with odd min rounds up to even
  q = quantizeAttack({ inputSongTime: 0.27, bpm, mode: 'beat', minSlotIndex: 3 });
  assert.equal(q.slotIndex, 4);
  // min satisfied by prev
  q = quantizeAttack({ inputSongTime: 0.27, bpm, minSlotIndex: 1 });
  assert.equal(q.slotIndex, 1); assert.equal(q.late, true);
});

test('judgment windows', () => {
  assert.equal(judgeDelta(0), 'perfect');
  assert.equal(judgeDelta(0.045), 'perfect');
  assert.equal(judgeDelta(0.046), 'great');
  assert.equal(judgeDelta(0.09), 'great');
  assert.equal(judgeDelta(0.091), 'good');
  assert.equal(judgeDelta(0.14), 'good');
  assert.equal(judgeDelta(0.141), 'auto');
  const bpm = 120;
  assert.equal(quantizeAttack({ inputSongTime: 0.5 - 0.03, bpm }).judgment, 'perfect');
  assert.equal(quantizeAttack({ inputSongTime: 0.5 - 0.07, bpm }).judgment, 'great');
  assert.equal(quantizeAttack({ inputSongTime: 0.5 - 0.12, bpm }).judgment, 'good');
  assert.equal(quantizeAttack({ inputSongTime: 0.5 - 0.2, bpm }).judgment, 'auto');
});

test('front / back / downbeat classification incl. negative beats', () => {
  const bpm = 100; // halfStep 0.3
  const h = 0.3;
  let q = quantizeAttack({ inputSongTime: 0, bpm });
  assert.equal(q.half, 'front'); assert.equal(q.isDownbeat, true); assert.equal(q.beatInBar, 0);
  q = quantizeAttack({ inputSongTime: h, bpm });
  assert.equal(q.half, 'back'); assert.equal(q.isDownbeat, false);
  q = quantizeAttack({ inputSongTime: 2 * h, bpm });
  assert.equal(q.half, 'front'); assert.equal(q.beatInBar, 1); assert.equal(q.isDownbeat, false);
  q = quantizeAttack({ inputSongTime: 8 * h, bpm });
  assert.equal(q.isDownbeat, true); assert.equal(q.beatIndex, 4);
  // count-in: beat -4 is a downbeat (slot -8), beat -1 is beatInBar 3
  q = quantizeAttack({ inputSongTime: -8 * h, bpm });
  assert.equal(q.slotIndex, -8); assert.equal(q.isDownbeat, true); assert.equal(q.beatIndex, -4);
  q = quantizeAttack({ inputSongTime: -1 * h, bpm });
  assert.equal(q.slotIndex, -1); assert.equal(q.half, 'back'); assert.equal(q.beatIndex, -1); assert.equal(q.beatInBar, 3);
  q = quantizeAttack({ inputSongTime: -2 * h, bpm });
  assert.equal(q.slotIndex, -2); assert.equal(q.half, 'front'); assert.equal(q.beatInBar, 3); assert.equal(q.isDownbeat, false);
});

test('negative times quantize correctly (count-in)', () => {
  const bpm = 88;
  const h = 30 / bpm;
  const q = quantizeAttack({ inputSongTime: -3.3 * h, bpm, lateGraceSec: 0.04 });
  // -3.3 slots: prev=-4 is 0.7*h = 0.2386 late (beyond grace), so next = -3
  assert.equal(q.slotIndex, -3);
});

import { minSchedulableSlot } from '../js/core/quantizer.js';

test('minSchedulableSlot: smallest slot at least marginSec in the future', () => {
  for (const bpm of [40, 72.5, 88, 120, 240]) {
    const h = 30 / bpm;
    for (let i = 0; i < 400; i++) {
      const now = -2 + i * 0.0173;
      for (const mode of ['half', 'beat']) {
        const k = minSchedulableSlot({ schedNowSongTime: now, bpm, mode, marginSec: 0.005 });
        const step = mode === 'beat' ? 2 : 1;
        assert.ok(k * h >= now + 0.005, `bpm ${bpm} now ${now} ${mode}`);
        assert.ok((k - step) * h < now + 0.005, `not minimal: bpm ${bpm} now ${now} ${mode}`);
        if (mode === 'beat') assert.equal(Math.abs(k % 2), 0);
      }
    }
  }
});

test('minSchedulableSlot: exact boundary and default margin', () => {
  const h = 30 / 120;
  assert.equal(minSchedulableSlot({ schedNowSongTime: 4 * h - 0.0049, bpm: 120 }), 5);
  assert.equal(minSchedulableSlot({ schedNowSongTime: 4 * h - 0.0051, bpm: 120 }), 4);
  assert.equal(minSchedulableSlot({ schedNowSongTime: 4 * h - 0.004, bpm: 120 }), 5);
  assert.equal(minSchedulableSlot({ schedNowSongTime: 4 * h - 0.004, bpm: 120, mode: 'beat' }), 6);
});

test('strict mode: quantizeAttack with minSchedulableSlot never lands in the past', () => {
  for (const bpm of [40, 120, 240]) {
    const h = 30 / bpm;
    for (let i = 0; i < 500; i++) {
      const now = i * 0.0113;
      const input = now - 0.03; // heard-domain input is slightly behind the schedule clock
      const q = quantizeAttack({
        inputSongTime: input, bpm, lateGraceSec: 0,
        minSlotIndex: minSchedulableSlot({ schedNowSongTime: now, bpm }),
      });
      assert.ok(q.slotIndex * h >= now + 0.005);
      assert.equal(q.late, false);
    }
  }
});
