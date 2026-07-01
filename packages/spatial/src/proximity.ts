/**
 * Proximity math: the distance -> gain falloff curve and the parallelizable gain kernel.
 *
 * `falloffGain` is C¹-continuous (flat inner zone, raised-cosine rolloff) so ramping audio
 * gain toward it never produces zipper/stepping artifacts.
 *
 * `computeGains` is a pure function over flat typed arrays — the exact shape `@lyku/para-parallel`
 * (pmap over SharedArrayBuffer) and `parabun:gpu` want. Day one it runs inline on the CPU; the
 * same signature is used by the pmap/gpu backends when load tests justify them.
 */

/**
 * Distance -> gain in [0, 1].
 *  - d <= r0:        1        (flat: face-to-face is full volume)
 *  - r0 < d < rMax:  cosine rolloff
 *  - d >= rMax:      0
 */
export function falloffGain(dist: number, r0: number, rMax: number): number {
  if (dist <= r0) return 1;
  if (dist >= rMax) return 0;
  const t = (dist - r0) / (rMax - r0);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * For each (a, b) pair, compute the falloff gain from the squared distance between the two
 * entities and write it to `out[i]`. Positions are indexed by entity slot in `xs`/`ys`.
 *
 * @param pairA  slot index of listener for pair i
 * @param pairB  slot index of speaker for pair i
 * @param out    gains, length >= n
 * @param n      number of pairs to process (defaults to pairA.length)
 */
export function computeGains(
  pairA: Uint32Array,
  pairB: Uint32Array,
  xs: Float32Array,
  ys: Float32Array,
  out: Float32Array,
  r0: number,
  rMax: number,
  n: number = pairA.length,
): void {
  for (let i = 0; i < n; i++) {
    const a = pairA[i]!;
    const b = pairB[i]!;
    const dx = xs[a]! - xs[b]!;
    const dy = ys[a]! - ys[b]!;
    out[i] = falloffGain(Math.sqrt(dx * dx + dy * dy), r0, rMax);
  }
}
