// Camera: smooth follow + screen shake (shake uses wall-clock dt, not beat time).
import { W } from './constants.js';

export class Camera {
  constructor() { this.x = 0; this.shake = 0; this._t = 0; }
  update(dt, targetX) {
    const want = Math.max(0, targetX - W * 0.36);
    this.x += (want - this.x) * (1 - Math.exp(-dt * 6));
    if (this.x < 0) this.x = 0;
    this.shake = Math.max(0, this.shake - dt * 30);
    this._t += dt;
  }
  addShake(amp, reduce) { if (!reduce) this.shake = Math.min(14, Math.max(this.shake, amp)); }
  get offsetX() { return this.shake > 0.05 ? Math.sin(this._t * 90) * this.shake : 0; }
  get offsetY() { return this.shake > 0.05 ? Math.cos(this._t * 77) * this.shake * 0.7 : 0; }
}
