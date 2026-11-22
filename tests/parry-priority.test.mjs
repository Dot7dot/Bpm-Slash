import test from 'node:test';
import assert from 'node:assert/strict';

const { Combat } = await import('../js/game/combat.js');
const { Bat, Guard } = await import('../js/game/enemies.js');

// 120 bpm (beat 0.5 s). Strike tick 16 (t = 1.0 s, beat index 2 telegraphed on beat 1... any tick works).
const STRIKE_TICK = 16;
function setup(type, ex) {
  const now = { t: 0 };
  const noop = () => {};
  const log = [];
  const parries = [];
  const g = {
    over: null, vst: 0, enemies: [], hudPulse: 0,
    settings: { lateGraceMs: 45, subdivision: 'auto', reduceFlashing: true },
    conductor: { bpm: 120, beatDur: 0.5, beat0AudioTime: 0, inputSongTime: (ms) => ms / 1000 },
    engine: { ensure: () => ({ currentTime: now.t }), playHit: (d, e) => ({ scheduledAudioTime: Math.max(e, now.t), ctxNowAtSchedule: now.t, clamped: e < now.t }), playConfirmHit: noop },
    fever: { active: false, multiplier: 1, onAttack: noop, onParry: noop },
    combo: { registerAttack: () => ({ combo: null }), onUnison: noop, onParry: noop },
    effects: new Proxy({}, { get: () => noop }),
    camera: { addShake: noop },
    player: { x: 100, y: 400, bodyY: 360, facing: 1 },
    confirmHit: noop, confirmBlock: noop, confirmKill: noop,
    logWorld: (k) => log.push(k),
    damageEnemy(e, d, kb) { const dmg = e.stunned ? d * 2 : d; e.takeHit(dmg) && (e.dead = true); e.shove(kb); },
  };
  g.onParry = function (e, a) { if (!this.combat.markParried(a)) return; parries.push(e.id); };
  g.combat = new Combat(g);
  const e = type === 'bat' ? new Bat(1, ex, 300) : new Guard(1, ex);
  e.y = 400; e.facing = -1; e.curEv = { beatIndex: 1, beatInBar: 2 };
  e.armStrike({ beatIndex: 1 }, g);
  assert.equal(e.strikeTick, STRIKE_TICK);
  g.enemies.push(e);
  return { g, e, now, log, parries };
}
const press = (s, ms, inst) => { s.now.t = ms / 1000; return s.g.combat.pressAttack(ms, inst); };

test('kick 40 ms before the strike beat parries a bat at 20 px; bat survives the parry moment, is stunned', () => {
  const s = setup('bat', 120);
  s.e.hp = s.e.maxHp = 1; // one hit would kill it
  const a = press(s, 1000 - 40, 'kick');
  assert.equal(a.tick, STRIKE_TICK);
  s.g.combat.update(1.0);
  assert.deepEqual(s.parries, [1]);
  assert.equal(s.e.stunned, true);
  assert.equal(s.e.strikeTick, null);
  assert.ok(s.log.includes('parry') && s.log.includes('enemy-stun'));
});

test('snare 20 ms after the beat (late rule) parries a shielded guard', () => {
  const s = setup('guard', 130);
  s.e.facing = -1; // faces the player
  assert.equal(s.e.blocks(s.g.player.x), true);
  const a = press(s, 1020, 'snare');
  assert.equal(a.tick, STRIKE_TICK);
  s.g.combat.update(1.02);
  assert.deepEqual(s.parries, [1]);
  assert.equal(s.e.stunned, true);
});

test('kick on a shielded guard parries (shield does not prevent it)', () => {
  const s = setup('guard', 130);
  press(s, 1000, 'kick');
  s.g.combat.update(1.0);
  assert.deepEqual(s.parries, [1]);
});

test('enemy that moves during the grace window is still parried (parry decided at the strike tick)', () => {
  const s = setup('bat', 130);
  press(s, 1000 - 10, 'kick');
  s.g.combat.update(1.0);
  s.e.x += 300; // swoop / step afterwards
  s.g.combat.update(1.04);
  assert.deepEqual(s.parries, [1]);
});

test('attack on a different tick does not parry', () => {
  const s = setup('bat', 120);
  press(s, 1000 + 250, 'kick');
  s.g.combat.update(1.25);
  assert.deepEqual(s.parries, []);
  assert.equal(s.e.stunned, false);
  assert.equal(s.e.strikeTick, STRIKE_TICK);
});

test('one attack parries several enemies', () => {
  const s = setup('bat', 120);
  const e2 = new Guard(2, 140); e2.y = 400; e2.facing = -1; e2.curEv = { beatIndex: 1, beatInBar: 2 };
  e2.armStrike({ beatIndex: 1 }, s.g); s.g.enemies.push(e2);
  press(s, 1000, 'kick');
  s.g.combat.update(1.0);
  assert.equal(s.e.stunned && e2.stunned, true); // both stunned; score/fever count once per attack (Game.onParry idempotent)
  assert.equal(s.parries.length, 1);
});
