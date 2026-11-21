import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beatSnap, levelOfTick, weightOfTick, halfOfLevel, autoSubdivision, stepTicksFor, judgeStepFor,
  judgeDelta, tickSongTime, resolveSubdivision, JUDGE_MULTIPLIER, LEVELS,
} from '../js/core/beatSnap.js';

const BPMS = [40, 72.5, 88, 120, 150, 173.3, 240];
const time = (k, bpm) => (k * (60 / bpm)) / 8;

// Helper: press at t with the scheduling clock slightly after the input (as in a real browser).
const snap = (t, bpm, o = {}) => beatSnap({ inputSongTime: t, schedNowSongTime: o.s ?? t + 0.005, bpm, ...o });

test('level and weight of ticks, including negative ticks', () => {
  const cases = [[0, 'bar', 5], [32, 'bar', 5], [-32, 'bar', 5], [16, 'half', 4], [-16, 'half', 4], [48, 'half', 4],
    [8, 'beat', 3], [24, 'beat', 3], [-8, 'beat', 3], [4, 'eighth', 2], [-4, 'eighth', 2], [12, 'eighth', 2],
    [2, 'sixteenth', 1], [-2, 'sixteenth', 1], [6, 'sixteenth', 1], [1, 'thirtysecond', 0], [-1, 'thirtysecond', 0], [7, 'thirtysecond', 0]];
  for (const [k, lv, w] of cases) {
    assert.equal(levelOfTick(k), lv, `tick ${k}`);
    assert.equal(weightOfTick(k), w, `tick ${k}`);
  }
  assert.deepEqual(LEVELS.map(halfOfLevel), ['front', 'front', 'front', 'back', 'sub', 'sub']);
});

test('auto subdivision table (spec 11.7) and boundary', () => {
  const step = (b) => stepTicksFor('auto', b);
  assert.equal(step(40), 1);
  assert.equal(step(88), 2);
  assert.equal(step(120), 2);
  assert.equal(step(150), 4);
  assert.equal(step(240), 4);
  assert.equal(autoSubdivision(40), 8);
  assert.equal(autoSubdivision(88), 4);
  assert.equal(autoSubdivision(150), 2);
  assert.equal(autoSubdivision(240), 2);
  // beatDur / 4 == 0.11 s exactly at 136.3636 bpm: still sixteenth
  assert.equal(autoSubdivision(60 / 0.44), 4);
  assert.equal(autoSubdivision(136.4), 2);
  // fixed settings
  assert.equal(stepTicksFor(1, 88), 8);
  assert.equal(stepTicksFor(2, 88), 4);
  assert.equal(stepTicksFor(4, 88), 2);
  assert.equal(stepTicksFor(8, 88), 1);
  assert.equal(resolveSubdivision('garbage', 88), 4);
  assert.equal(judgeStepFor(1), 4);
  assert.equal(judgeStepFor(2), 4);
  assert.equal(judgeStepFor(4), 4);
  assert.equal(judgeStepFor(8), 8);
});

test('judgment windows (inclusive boundaries)', () => {
  assert.equal(judgeDelta(0), 'perfect');
  assert.equal(judgeDelta(0.045), 'perfect');
  assert.equal(judgeDelta(0.0451), 'great');
  assert.equal(judgeDelta(0.09), 'great');
  assert.equal(judgeDelta(0.0901), 'good');
  assert.equal(judgeDelta(0.14), 'good');
  assert.equal(judgeDelta(0.1401), 'off');
  assert.deepEqual(JUDGE_MULTIPLIER, { perfect: 1.5, great: 1.25, good: 0.6, off: 0.4 });
});

test('tickSongTime is an integer multiply (no accumulation)', () => {
  for (const bpm of BPMS) for (let k = -40; k < 400; k++) assert.equal(tickSongTime(k, bpm), time(k, bpm));
});

test('rule late: just after a judge-grid point', () => {
  // 120 bpm: tickDur 62.5 ms, S 2, J 4 (250 ms)
  let r = snap(0.27, 120);
  assert.equal(r.rule, 'late'); assert.equal(r.tick, 4); assert.equal(r.late, true);
  assert.equal(r.level, 'eighth'); assert.equal(r.judgment, 'perfect');
  r = snap(0.25 + 0.04, 120); // boundary inclusive
  assert.equal(r.rule, 'late'); assert.equal(r.tick, 4);
  r = snap(0.25 + 0.0401, 120);
  assert.notEqual(r.rule, 'late');
});

test('rule aimed: just before a judge-grid point (aimWindow = min(0.09, J*tickDur/2))', () => {
  let r = snap(0.20, 120);
  assert.equal(r.rule, 'aimed'); assert.equal(r.tick, 4);
  r = snap(0.25 - 0.09, 120); // boundary
  assert.equal(r.rule, 'aimed');
  r = snap(0.25 - 0.0905, 120);
  assert.equal(r.rule, 'snap');
  // 240 bpm: tickDur 31.25 ms, J=4 (125 ms), window = 125/2 = 62.5 ms
  r = snap(0.125 - 0.062, 240);
  assert.equal(r.rule, 'aimed'); assert.equal(r.tick, 4);
  r = snap(0.125 - 0.0635, 240, { s: 0 });
  assert.equal(r.rule, 'snap');
});

test('rule snap places an off-beat press on the next connect-grid point (not before minWindup)', () => {
  // 120 bpm, t=0.12: nothing near a judge point
  const r = snap(0.12, 120);
  assert.equal(r.rule, 'snap');
  assert.equal(r.tick % r.stepTicks, 0);
  assert.ok(time(r.tick, 120) >= 0.12 + 0.05 - 1e-9);
  assert.equal(r.tick, 4);
});

test('beat magnet: wait for a strong tick if it is the next grid point and within 200 ms', () => {
  // 120 bpm t=0.30 -> c0=6 (sixteenth), c1=8 (beat, weight 3 > 1) 125 ms away
  const r = snap(0.30, 120);
  assert.equal(r.rule, 'snap'); assert.equal(r.magnet, true); assert.equal(r.tick, 8); assert.equal(r.level, 'beat');
  // 40 bpm: tickDur 187.5 ms, S=1, c1 - c0 = 187.5 ms <= 200 so magnet allowed if weight rises
  const k = 7; // tick 7 -> 8 is a beat
  const r2 = snap(time(k, 40) - 0.2, 40, { s: time(k, 40) - 0.21 });
  assert.equal(r2.rule === 'snap' && r2.tick === 8 ? r2.magnet : true, true);
  // no magnet when the strong tick is further than 200 ms away: 40 bpm, S=1 so c1 is 187.5 ms away -> allowed;
  // use fixed quarter grid 40 bpm: S=8, c1 is 1.5 s away
  const r3 = snap(0.5, 40, { subdivision: 1 });
  assert.equal(r3.magnet, false);
});

test('v3 F2: magnet cap is max(0.2 s, 0.35 * beatDur) so 72.5 BPM magnetizes', () => {
  // 72.5 bpm: beatDur 0.8276 s, auto S=2 (tickDur 103 ms), c1 - c0 = 207 ms > 0.2 s but <= 0.35 * beatDur = 290 ms.
  const bpm = 72.5;
  let found = 0;
  for (let k = 8; k < 400; k++) {
    // press so that c0 is the tick just before a beat (k mod 8 == 6) and c1 is that beat
    if (k % 8 !== 6) continue;
    const t = time(k, bpm) - 0.12; // earliest = t + 0.05 -> c0 = k (a multiple of S=2)
    const r = snap(t, bpm, { s: t });
    if (r.rule === 'snap' && r.tick % 8 === 0 && r.magnet) found++;
  }
  assert.ok(found > 0, 'magnet fired at 72.5 bpm');
  // an explicit tiny cap still cannot go below 0.35 * beatDur; a huge cap widens it
  const t0 = time(6, 72.5) - 0.12;
  assert.equal(snap(t0, 72.5, { s: t0, magnetMaxWaitSec: 0.05 }).magnet, true);
  // fixed quarter grid at 40 bpm: c1 is 1.5 s away > 0.35 * 1.5 = 0.525 s -> no magnet
  assert.equal(snap(0.5, 40, { subdivision: 1 }).magnet, false);
  // 120 bpm: cap = max(0.2, 0.175) = 0.2 s
  const r = snap(0.30, 120);
  assert.equal(r.magnet, true);
});

test('snap never goes below schedMinTick and always matches the connect grid', () => {
  for (const bpm of BPMS) {
    const tickDur = 60 / bpm / 8;
    for (let i = 0; i < 400; i++) {
      const t = -1 + i * 0.0173;
      const s = t + (i % 7) * 0.004; // scheduling clock ahead of the input by 0..24 ms
      const r = beatSnap({ inputSongTime: t, schedNowSongTime: s, bpm });
      const schedMin = Math.ceil((s + 0.005) / tickDur - 1e-9);
      if (r.rule === 'snap') {
        assert.ok(r.tick >= schedMin, `snap below schedMinTick bpm ${bpm} t ${t}`);
        assert.equal(((r.tick % r.stepTicks) + r.stepTicks) % r.stepTicks, 0);
        assert.ok(r.connectSongTime >= s + 0.005 - 1e-9);
        assert.ok(r.connectSongTime >= t + 0.05 - 1e-9);
      } else {
        assert.equal(((r.tick % r.judgeStepTicks) + r.judgeStepTicks) % r.judgeStepTicks, 0);
      }
      assert.ok(Number.isInteger(r.tick));
      assert.ok(Math.abs(r.connectSongTime - r.tick * (60 / bpm) / 8) < 1e-9);
      assert.equal(r.level, levelOfTick(r.tick));
      assert.equal(r.isDownbeat, r.tick % 32 === 0);
    }
  }
});

test('strict mode: never late, never earlier than schedulable', () => {
  for (const bpm of BPMS) {
    for (let i = 0; i < 500; i++) {
      const t = -0.5 + i * 0.0191;
      const s = t + (i % 5) * 0.006;
      const r = beatSnap({ inputSongTime: t, schedNowSongTime: s, bpm, strict: true, lateGraceSec: 0 });
      assert.notEqual(r.rule, 'late');
      assert.ok(r.connectSongTime >= s + 0.005 - 1e-9, `strict clamp bpm ${bpm} t ${t}`);
    }
  }
});

test('strict: aimed is rejected when its tick is no longer schedulable', () => {
  // 120 bpm: t=0.2 aims at tick 4 (0.25 s). Scheduling clock at 0.26 -> tick 4 not schedulable.
  const loose = beatSnap({ inputSongTime: 0.2, schedNowSongTime: 0.26, bpm: 120 });
  assert.equal(loose.rule, 'aimed'); assert.equal(loose.tick, 4);
  const strict = beatSnap({ inputSongTime: 0.2, schedNowSongTime: 0.26, bpm: 120, strict: true });
  assert.equal(strict.rule, 'snap'); assert.ok(strict.connectSongTime >= 0.265 - 1e-9);
});

test('minTick queueing: strictly increasing ticks at least minTick for every rule', () => {
  for (const bpm of [88, 150, 40, 240]) {
    for (let i = 0; i < 300; i++) {
      const t = 1 + i * 0.0137;
      const minTick = Math.floor(t / (60 / bpm / 8)) + (i % 9) - 3;
      const r = beatSnap({ inputSongTime: t, schedNowSongTime: t + 0.005, bpm, minTick });
      assert.ok(r.tick >= minTick);
    }
  }
  // late is rejected when pJ < minTick
  const r = beatSnap({ inputSongTime: 0.26, schedNowSongTime: 0.265, bpm: 120, minTick: 5 });
  assert.notEqual(r.rule, 'late'); assert.ok(r.tick >= 5);
});

test('rapid mashing falls onto consecutive grid points (fill)', () => {
  // 88 bpm, S=2: presses every 30 ms starting at 2.0 with minTick chaining
  const bpm = 88;
  let minTick = -Infinity;
  const ticks = [];
  for (let i = 0; i < 6; i++) {
    const t = 2.0 + i * 0.03;
    const r = beatSnap({ inputSongTime: t, schedNowSongTime: t + 0.005, bpm, minTick });
    ticks.push(r.tick); minTick = r.tick + 1;
  }
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
  for (const k of ticks) assert.equal(k % 2 === 0 || k % 4 === 0, true);
});

test('exact grid times map to themselves (float safety at many BPMs)', () => {
  for (const bpm of BPMS) {
    const J = judgeStepFor(stepTicksFor('auto', bpm));
    for (let k = -64; k < 400; k += J) {
      const t = time(k, bpm);
      const r = beatSnap({ inputSongTime: t, schedNowSongTime: t - 0.05, bpm });
      assert.equal(r.tick, k, `bpm ${bpm} k ${k}`);
      assert.equal(r.rule, 'late');
      assert.equal(r.judgeTick, k);
      assert.equal(r.judgment, 'perfect');
      assert.ok(Math.abs(r.judgeDeltaSec) < 1e-9);
      // 1 ms early -> aimed to the same tick
      const e = beatSnap({ inputSongTime: t - 0.001, schedNowSongTime: t - 0.05, bpm });
      assert.equal(e.tick, k); assert.equal(e.rule, 'aimed');
    }
  }
});

test('judgment is relative to the nearest judge-grid point, independent of the landing tick', () => {
  const bpm = 120;
  // 100 ms after tick 4 (0.25): late grace missed, nearest judge point is tick 4 (|d| = 0.1 -> good)
  const r = snap(0.35, bpm);
  assert.equal(r.judgeTick, 4);
  assert.ok(Math.abs(r.judgeDeltaSec - 0.1) < 1e-9);
  assert.equal(r.judgment, 'good'); assert.equal(r.onBeat, false);
  const p = snap(0.26, bpm);
  assert.equal(p.judgment, 'perfect'); assert.equal(p.onBeat, true);
  const g = snap(0.25 + 0.08, bpm);
  assert.equal(g.judgment, 'great'); assert.equal(g.onBeat, true);
  const o = snap(0.25 + 0.125, bpm); // exactly halfway: off (0.125 > 0.14? no -> good), use 0.2 for off? max |d| = 0.125
  assert.equal(o.judgment, 'good');
});

test('negative ticks (count-in) have correct modulo fields', () => {
  const r = beatSnap({ inputSongTime: -1.3, schedNowSongTime: -1.3, bpm: 120 });
  assert.ok(r.tick < 0);
  assert.ok(r.beatInBar >= 0 && r.beatInBar < 4);
  assert.equal(r.beatIndex, Math.floor(r.tick / 8));
  assert.equal(r.barIndex, Math.floor(r.tick / 32));
  assert.equal(r.level, levelOfTick(r.tick));
});

test('result carries the grid description', () => {
  const r = snap(1.0, 150);
  assert.equal(r.stepTicks, 4); assert.equal(r.judgeStepTicks, 4);
  const r2 = snap(1.0, 40);
  assert.equal(r2.stepTicks, 1); assert.equal(r2.judgeStepTicks, 4);
  const r3 = snap(1.0, 88, { subdivision: 1 });
  assert.equal(r3.stepTicks, 8); assert.equal(r3.judgeStepTicks, 8);
});

test('150 / 240 bpm: aim window shrinks with the judge grid; presses land on the 8th grid', () => {
  for (const bpm of [150, 240]) {
    for (let i = 0; i < 200; i++) {
      const t = 1 + i * 0.0091;
      const r = snap(t, bpm);
      assert.equal(r.stepTicks, 4);
      assert.equal(((r.tick % 4) + 4) % 4, 0);
    }
  }
});
