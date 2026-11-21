import test from 'node:test';
import assert from 'node:assert/strict';
import { heardAudioTime } from '../js/core/clockMath.js';

const base = { contextTime: 9.96, performanceTime: 10000, currentTime: 10.0, outputLatency: 0.04, perfMs: 10000, nowPerfMs: 10000, state: 'running' };

test('valid timestamp: no latency subtraction', () => {
  const r = heardAudioTime(base);
  assert.equal(r.source, 'timestamp');
  assert.ok(Math.abs(r.time - 9.96) < 1e-9);
});
test('valid timestamp: perfMs shifts linearly', () => {
  const r = heardAudioTime({ ...base, perfMs: 10020 });
  assert.ok(Math.abs(r.time - 9.98) < 1e-9);
});
test('unsupported (zero) timestamp falls back to currentTime - outputLatency', () => {
  const r = heardAudioTime({ ...base, contextTime: 0, performanceTime: 0 });
  assert.equal(r.source, 'fallback');
  assert.ok(Math.abs(r.time - 9.96) < 1e-9);
});
test('NaN timestamp falls back; fallback shifts by perfMs - now', () => {
  const r = heardAudioTime({ ...base, contextTime: NaN, perfMs: 9990 });
  assert.equal(r.source, 'fallback');
  assert.ok(Math.abs(r.time - 9.95) < 1e-9);
});
test('implausible timestamp (>0.25 s off) falls back', () => {
  const r = heardAudioTime({ ...base, contextTime: 9.2 });
  assert.equal(r.source, 'fallback');
  assert.ok(Math.abs(r.time - 9.96) < 1e-9);
});
test('suspended context uses fallback', () => {
  const r = heardAudioTime({ ...base, state: 'suspended' });
  assert.equal(r.source, 'fallback');
});
test('missing outputLatency treated as 0', () => {
  const r = heardAudioTime({ ...base, contextTime: 0, performanceTime: 0, outputLatency: undefined });
  assert.ok(Math.abs(r.time - 10.0) < 1e-9);
});
