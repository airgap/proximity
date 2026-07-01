import { describe, expect, it } from "bun:test";
import {
  decodeSnapshot,
  encodeSnapshot,
  EntityFlags,
  Facing,
  POS_SCALE,
  binaryTagOf,
  BinaryTag,
  type SnapshotEntity,
} from "./index.ts";

describe("snapshot codec", () => {
  it("round-trips entities within fixed-point precision", () => {
    const entities: SnapshotEntity[] = [
      { nid: 1, x: 10.5, y: 20.25, facing: Facing.Down, flags: EntityFlags.Moving },
      { nid: 65535, x: -100.75, y: 300.125, facing: Facing.Right, flags: 0 },
      { nid: 42, x: 0, y: 0, facing: Facing.Up, flags: EntityFlags.Speaking },
    ];
    const buf = encodeSnapshot(12345, entities);
    const decoded = decodeSnapshot(buf);

    expect(decoded.tick).toBe(12345);
    expect(decoded.entities).toHaveLength(3);
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i]!;
      const b = decoded.entities[i]!;
      expect(b.nid).toBe(a.nid);
      expect(b.facing).toBe(a.facing);
      expect(b.flags).toBe(a.flags);
      // Quantization error is at most half a fixed-point step.
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(0.5 / POS_SCALE);
      expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(0.5 / POS_SCALE);
    }
  });

  it("produces the documented 7 + 8*n byte layout", () => {
    const buf = encodeSnapshot(0, [
      { nid: 1, x: 1, y: 1, facing: Facing.Down, flags: 0 },
      { nid: 2, x: 2, y: 2, facing: Facing.Down, flags: 0 },
    ]);
    expect(buf.byteLength).toBe(7 + 8 * 2);
    expect(binaryTagOf(buf)).toBe(BinaryTag.Snapshot);
  });

  it("reuses a preallocated buffer without allocating", () => {
    const scratch = new Uint8Array(1024);
    const buf = encodeSnapshot(7, [{ nid: 9, x: 3, y: 4, facing: Facing.Left, flags: 0 }], scratch);
    // Returned view must alias the scratch buffer.
    expect(buf.buffer).toBe(scratch.buffer);
    expect(decodeSnapshot(buf).entities[0]!.nid).toBe(9);
  });

  it("clamps coordinates beyond int16 fixed-point range", () => {
    const buf = encodeSnapshot(0, [{ nid: 1, x: 99999, y: -99999, facing: Facing.Down, flags: 0 }]);
    const d = decodeSnapshot(buf).entities[0]!;
    expect(d.x).toBeCloseTo(32767 / POS_SCALE, 5);
    expect(d.y).toBeCloseTo(-32768 / POS_SCALE, 5);
  });
});
