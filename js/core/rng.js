// Small deterministic RNG helpers (pure).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless hash of an integer to [0,1). */
export function hash01(n, salt = 0) {
  let x = (Math.imul(n | 0, 0x9E3779B1) ^ Math.imul((salt | 0) + 0x7F4A7C15, 0x85EBCA6B)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2C1B3C6D) >>> 0;
  x ^= x >>> 12; x = Math.imul(x, 0x297A2D39) >>> 0;
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
