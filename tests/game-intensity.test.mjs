import test from 'node:test';
import assert from 'node:assert/strict';

// Game imports canvas drawing modules but only touches the DOM at runtime, so the prototype method can be tested directly.
const { Game } = await import('../js/game/game.js');

test('intensityAtBar: sections (endBar exclusive), barIntensity fallback, out of range = mid', () => {
  const f = (songMap, bar) => Game.prototype.intensityAtBar.call({ songMap }, bar);
  const sections = [{ startBar: 0, endBar: 4, intensity: 'low' }, { startBar: 4, endBar: 12, intensity: 'mid' }, { startBar: 12, endBar: 20, intensity: 'high' }];
  assert.equal(f({ sections }, 0), 'low');
  assert.equal(f({ sections }, 3), 'low');
  assert.equal(f({ sections }, 4), 'mid');
  assert.equal(f({ sections }, 19), 'high');
  assert.equal(f({ sections }, 20), 'mid');
  assert.equal(f({ sections }, -3), 'mid');
  assert.equal(f(null, 5), 'mid');
  assert.equal(f({ barIntensity: ['high', 'low'] }, 1), 'low');
  assert.equal(f({ barIntensity: ['high', 'low'] }, 9), 'mid');
});
