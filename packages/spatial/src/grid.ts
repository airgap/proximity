/**
 * Uniform bucket grid for area-of-interest (AOI) queries.
 *
 * Avatars are roughly uniformly dense and constantly moving, so a fixed grid gives O(1)
 * insert/move/remove and cheap radius queries — no rebalancing like a quadtree. Cell size is
 * chosen == the audio radius so that everyone within audio range of an entity lives in that
 * entity's cell or the 8 adjacent cells (a 3×3 Moore block); larger query radii simply widen
 * the scanned cell span.
 */
export class Grid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;

  /** cellIndex -> list of entity ids currently in that cell. */
  private readonly cells: number[][];
  /** entity id -> current cell index (for O(1) move/remove). */
  private readonly idCell = new Map<number, number>();
  private readonly idX = new Map<number, number>();
  private readonly idY = new Map<number, number>();

  constructor(widthTiles: number, heightTiles: number, cellSize: number) {
    if (cellSize <= 0) throw new Error("cellSize must be > 0");
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(widthTiles / cellSize));
    this.rows = Math.max(1, Math.ceil(heightTiles / cellSize));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  get size(): number {
    return this.idCell.size;
  }

  private clampCol(cx: number): number {
    return cx < 0 ? 0 : cx >= this.cols ? this.cols - 1 : cx;
  }
  private clampRow(cy: number): number {
    return cy < 0 ? 0 : cy >= this.rows ? this.rows - 1 : cy;
  }

  private cellIndexAt(x: number, y: number): number {
    const cx = this.clampCol(Math.floor(x / this.cellSize));
    const cy = this.clampRow(Math.floor(y / this.cellSize));
    return cy * this.cols + cx;
  }

  insert(id: number, x: number, y: number): void {
    const idx = this.cellIndexAt(x, y);
    this.cells[idx]!.push(id);
    this.idCell.set(id, idx);
    this.idX.set(id, x);
    this.idY.set(id, y);
  }

  /** Update an entity's position, relinking buckets only if the cell changed. */
  move(id: number, x: number, y: number): void {
    const prev = this.idCell.get(id);
    if (prev === undefined) {
      this.insert(id, x, y);
      return;
    }
    this.idX.set(id, x);
    this.idY.set(id, y);
    const next = this.cellIndexAt(x, y);
    if (next === prev) return;
    const bucket = this.cells[prev]!;
    const at = bucket.indexOf(id);
    if (at !== -1) {
      // swap-remove: O(1), order within a cell doesn't matter.
      bucket[at] = bucket[bucket.length - 1]!;
      bucket.pop();
    }
    this.cells[next]!.push(id);
    this.idCell.set(id, next);
  }

  remove(id: number): void {
    const idx = this.idCell.get(id);
    if (idx === undefined) return;
    const bucket = this.cells[idx]!;
    const at = bucket.indexOf(id);
    if (at !== -1) {
      bucket[at] = bucket[bucket.length - 1]!;
      bucket.pop();
    }
    this.idCell.delete(id);
    this.idX.delete(id);
    this.idY.delete(id);
  }

  positionOf(id: number): { x: number; y: number } | undefined {
    const x = this.idX.get(id);
    const y = this.idY.get(id);
    return x === undefined || y === undefined ? undefined : { x, y };
  }

  /**
   * Collect ids whose position is within `radius` tiles of (x, y), excluding `exceptId`.
   * Results are appended to `out` (cleared first) to avoid per-call allocation on the hot path.
   */
  queryWithin(
    x: number,
    y: number,
    radius: number,
    exceptId: number,
    out: number[] = [],
  ): number[] {
    out.length = 0;
    const r2 = radius * radius;
    const span = Math.max(1, Math.ceil(radius / this.cellSize));
    const ccx = this.clampCol(Math.floor(x / this.cellSize));
    const ccy = this.clampRow(Math.floor(y / this.cellSize));
    const minCx = this.clampCol(ccx - span);
    const maxCx = this.clampCol(ccx + span);
    const minCy = this.clampRow(ccy - span);
    const maxCy = this.clampRow(ccy + span);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells[cy * this.cols + cx]!;
        for (let k = 0; k < bucket.length; k++) {
          const id = bucket[k]!;
          if (id === exceptId) continue;
          const ex = this.idX.get(id)!;
          const ey = this.idY.get(id)!;
          const dx = ex - x;
          const dy = ey - y;
          if (dx * dx + dy * dy <= r2) out.push(id);
        }
      }
    }
    return out;
  }
}
