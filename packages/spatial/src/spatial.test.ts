import { describe, expect, it } from "bun:test";
import { Grid } from "./grid.ts";
import { computeGains, falloffGain } from "./proximity.ts";

describe("falloffGain", () => {
  it("is 1 inside the flat zone and 0 beyond rMax", () => {
    expect(falloffGain(0, 2, 10)).toBe(1);
    expect(falloffGain(2, 2, 10)).toBe(1);
    expect(falloffGain(10, 2, 10)).toBe(0);
    expect(falloffGain(20, 2, 10)).toBe(0);
  });

  it("is monotonically decreasing and ~0.5 at the midpoint", () => {
    const mid = falloffGain(6, 2, 10); // midpoint of [2,10]
    expect(mid).toBeCloseTo(0.5, 5);
    expect(falloffGain(4, 2, 10)).toBeGreaterThan(falloffGain(8, 2, 10));
  });
});

describe("Grid", () => {
  it("finds neighbors within radius and excludes self", () => {
    const g = new Grid(100, 100, 10);
    g.insert(1, 5, 5);
    g.insert(2, 6, 6); // ~1.41 away from #1
    g.insert(3, 50, 50); // far
    const near = g.queryWithin(5, 5, 5, 1);
    expect(near).toContain(2);
    expect(near).not.toContain(1); // self excluded
    expect(near).not.toContain(3); // out of radius
  });

  it("relinks buckets on move so queries reflect new position", () => {
    const g = new Grid(100, 100, 10);
    g.insert(1, 5, 5);
    g.insert(2, 95, 95);
    expect(g.queryWithin(5, 5, 8, 99)).toContain(1);
    g.move(1, 90, 90); // now near #2
    expect(g.queryWithin(5, 5, 8, 99)).not.toContain(1);
    expect(g.queryWithin(95, 95, 8, 99)).toContain(1);
  });

  it("removes entities", () => {
    const g = new Grid(50, 50, 10);
    g.insert(7, 10, 10);
    expect(g.size).toBe(1);
    g.remove(7);
    expect(g.size).toBe(0);
    expect(g.queryWithin(10, 10, 20, -1)).toHaveLength(0);
  });

  it("handles a radius larger than the cell size", () => {
    const g = new Grid(200, 200, 5); // small cells
    g.insert(1, 0, 0);
    g.insert(2, 30, 0); // 30 away, spans 6 cells
    expect(g.queryWithin(0, 0, 40, 1)).toContain(2);
    expect(g.queryWithin(0, 0, 20, 1)).not.toContain(2);
  });
});

describe("computeGains kernel", () => {
  it("matches falloffGain over pair arrays", () => {
    const xs = new Float32Array([0, 3, 100]);
    const ys = new Float32Array([0, 4, 100]); // #0-#1 distance = 5
    const pairA = new Uint32Array([0, 0]);
    const pairB = new Uint32Array([1, 2]);
    const out = new Float32Array(2);
    computeGains(pairA, pairB, xs, ys, out, 2, 10);
    expect(out[0]).toBeCloseTo(falloffGain(5, 2, 10), 6);
    expect(out[1]).toBe(0); // #2 is far
  });
});
