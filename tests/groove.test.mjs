import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGroove, GROOVE_PATTERNS } from '../js/core/groove.js';

const K = (t) => ({ tick: t, instrument: 'kick' });
const S = (t) => ({ tick: t, instrument: 'snare' });
const shift = (hits, bar) => hits.map((h) => ({ ...h, tick: h.tick + bar * 32 }));

test('rock beat: kick 0/16, snare 8/24', () => {
  const g = evaluateGroove([K(0), S(8), K(16), S(24)], 0);
  assert.equal(g.id, 'rock');
  assert.equal(g.fever, 0.15);
  assert.equal(g.score, 500);
  assert.match(g.name, /搖滾/);
});

test('four on the floor: kick on every beat', () => {
  const g = evaluateGroove([K(0), K(8), K(16), K(24)], 3);
  assert.equal(g, null); // wrong bar: ticks belong to bar 0
  const h = evaluateGroove(shift([K(0), K(8), K(16), K(24)], 3), 3);
  assert.equal(h.id, 'fourOnFloor');
  assert.equal(h.score, 500);
});

test('backbeat: snare on 8 and 24 only', () => {
  const g = evaluateGroove([S(8), S(24)], 1);
  assert.equal(g, null);
  const h = evaluateGroove(shift([S(8), S(24)], 1), 1);
  assert.equal(h.id, 'backbeat');
  assert.equal(h.fever, 0.08);
  assert.equal(h.score, 250);
});

test('priority: rock beats four-on-the-floor and backbeat; four-on-floor beats backbeat', () => {
  assert.equal(evaluateGroove([K(0), K(8), K(16), K(24), S(8), S(24)], 0).id, 'rock');
  assert.equal(evaluateGroove([K(0), K(8), K(16), K(24), S(4)], 0).id, 'fourOnFloor');
  assert.equal(evaluateGroove([K(0), K(8), K(16), K(24), S(8), S(24)], 0).score, 500);
  assert.equal(evaluateGroove([K(0), K(16), S(8), S(24)], 0).id, 'rock');
});

test('partial hits do not count; extra hits are allowed', () => {
  assert.equal(evaluateGroove([K(0), S(8), K(16)], 0), null);
  assert.equal(evaluateGroove([K(0), K(8), K(16)], 0), null);
  assert.equal(evaluateGroove([S(8)], 0), null);
  assert.equal(evaluateGroove([], 0), null);
  assert.equal(evaluateGroove(null, 0), null);
  assert.equal(evaluateGroove([K(0), S(4), S(8), K(12), K(16), S(20), S(24), K(28), K(30)], 0).id, 'rock');
});

test('wrong instrument does not count', () => {
  assert.equal(evaluateGroove([S(0), K(8), S(16), K(24)], 0), null);
  assert.equal(evaluateGroove([K(8), K(24)], 0), null);
  assert.equal(evaluateGroove([S(0), S(8), S(16), S(24)], 0).id, 'backbeat');
  assert.equal(evaluateGroove([{ tick: 0, instrument: 'hat' }, K(8), K(16), K(24)], 0), null);
});

test('off-grid ticks do not count', () => {
  assert.equal(evaluateGroove([K(0), S(9), K(16), S(24)], 0), null);
  assert.equal(evaluateGroove([K(0), S(8), K(17), S(24)], 0).id, 'backbeat'); // kick off-grid, snare still counts
});

test('negative bars (count-in)', () => {
  assert.equal(evaluateGroove([K(-32), S(-24), K(-16), S(-8)], -1).id, 'rock');
  assert.equal(evaluateGroove([K(-64), K(-56), K(-48), K(-40)], -2).id, 'fourOnFloor');
  assert.equal(evaluateGroove([S(-24), S(-8)], -1).id, 'backbeat');
  assert.equal(evaluateGroove([K(-32), S(-24), K(-16), S(-8)], 0), null);
});

test('returns a fresh object each time', () => {
  const a = evaluateGroove([S(8), S(24)], 0);
  a.score = 1;
  assert.equal(GROOVE_PATTERNS.backbeat.score, 250);
});
