// Results screen (DESIGN 9.2).
const $ = (id) => document.getElementById(id);

export function showResults(game, died) {
  const c = game.combo;
  const grade = c.rating(died);
  $('res-title').textContent = died ? '力竭倒下…' : '通關！';
  const g = $('res-grade');
  g.textContent = grade;
  g.className = 'grade g-' + grade;
  $('res-score').textContent = String(Math.floor(c.score));
  $('res-chain').textContent = c.maxChain;
  $('res-combos').textContent = c.eighthCombos + c.finishers + c.fills;
  $('res-perfect').textContent = c.judgments.perfect;
  $('res-great').textContent = c.judgments.great;
  $('res-good').textContent = c.judgments.good;
  $('res-auto').textContent = c.judgments.off;
  $('res-front').textContent = c.halves.front;
  $('res-back').textContent = c.halves.back + c.halves.sub;
  $('res-down').textContent = c.halves.downbeat;
  $('res-kills').textContent = game.kills;
  $('results').classList.remove('hidden');
}

export function hideResults() { $('results').classList.add('hidden'); }
