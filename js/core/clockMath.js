// Pure clock mapping (DESIGN 5.1): performance.now() domain -> heard-domain audio time.
// getOutputTimestamp().contextTime is already what the listener hears, so no latency is subtracted there.

/** Maximum disagreement (s) between the timestamp-derived time and currentTime - outputLatency. */
export const PLAUSIBLE_TOLERANCE = 0.25;

/**
 * @param {{contextTime:number, performanceTime:number, currentTime:number, outputLatency:number,
 *          perfMs:number, nowPerfMs:number, state:string}} p
 * @returns {{time:number, source:'timestamp'|'fallback'}}
 */
export function heardAudioTime({ contextTime, performanceTime, currentTime, outputLatency, perfMs, nowPerfMs, state }) {
  const lat = Number.isFinite(outputLatency) && outputLatency > 0 ? outputLatency : 0;
  const shift = Number.isFinite(perfMs) && Number.isFinite(nowPerfMs) ? (perfMs - nowPerfMs) / 1000 : 0;
  const fallback = currentTime - lat + shift;
  if (state !== 'running') return { time: fallback, source: 'fallback' };
  if (!(contextTime > 0) || !(performanceTime > 0) || !Number.isFinite(contextTime) || !Number.isFinite(performanceTime)) {
    return { time: fallback, source: 'fallback' };
  }
  const v = contextTime + (perfMs - performanceTime) / 1000;
  if (!Number.isFinite(v) || Math.abs(v - fallback) > PLAUSIBLE_TOLERANCE) return { time: fallback, source: 'fallback' };
  return { time: v, source: 'timestamp' };
}
