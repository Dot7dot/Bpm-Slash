import test from 'node:test';
import assert from 'node:assert/strict';

const { Combat, UNISON_MULT } = await import('../js/game/combat.js');

// Minimal game stub: 120 bpm (beat 0.5 s), audio clock == song clock, one enemy standing in front of the player.
function makeGame(nowRef) {
  const dmg = [];
  const noop = () => {};
  const g = {
    over: null, vst: 0, enemies: [], hudPulse: 0,
    settings: { lateGraceMs: 45, subdivision: 'auto', reduceFlashing: true },
    conductor: { bpm: 120, beatDur: 0.5, beat0AudioTime: 0, inputSongTime: (ms) => ms / 1000 },
    engine: { ensure: () => ({ currentTime: nowRef.t }), playHit: (d, e) => ({ scheduledAudioTime: Math.max(d ? e : e, nowRef.t), ctxNowAtSchedule: nowRef.t, clamped: e < nowRef.t }), playConfirmHit: noop },
    fever: { active: false, multiplier: 1, onAttack: noop },
    combo: { registerAttack: () => ({ combo: null }), onUnison: noop },
    effects: new Proxy({}, { get: () => noop }),
    camera: { addShake: noop },
    player: { x: 100, y: 400, bodyY: 360, facing: 1 },
    confirmHit: noop, confirmBlock: noop,
    damageEnemy(e, d) { dmg.push(d); e.hp -= d; },
  };
  g.enemies.push({ x: 150, cy: 360, y: 400, r: 14, hp: 100, type: 'slime', blocks: () => false });
  g._dmg = dmg;
  return g;
}

test('unison: a first hit that already impacted (late rule) gets the missing x1.5 when the partner arrives', () => {
  const now = { t: 0.30 };
  const g = makeGame(now);
  const c = new Combat(g);
  // kick on beat tick 8 (t = 0.5)? Use a press 20 ms after tick 8 so the late rule puts it ON tick 8 and it connects immediately.
  now.t = 0.52;
  const k = c.pressAttack(520, 'kick');
  assert.equal(k.rule, 'late');
  c.update(0.52); // impact frame
  assert.equal(g._dmg.length, 1);
  const base = g._dmg[0];
  // snare arrives 10 ms later on the same tick
  now.t = 0.53;
  const s = c.pressAttack(530, 'snare');
  assert.equal(s.tick, k.tick);
  assert.equal(s.unison, true);
  // top-up dealt immediately: base * (1.5 - 1)
  assert.equal(g._dmg.length, 2);
  assert.ok(Math.abs(g._dmg[1] - base * (UNISON_MULT - 1)) < 1e-9);
  // the snare itself impacts with x1.5 included
  c.update(0.53);
  assert.equal(g._dmg.length, 3);
  // no double top-up
  assert.equal(c.queue.filter((a) => a.struck && a.struck.length).length <= 1, true);
});
