import type { FullStroke, StrokePoint } from "@proximity/protocol";

interface LocalStroke {
  color: string;
  width: number;
  points: StrokePoint[];
}

/**
 * Collaborative draw-over layer for presentation mode.
 *
 * Owns a transparent <canvas> laid over the shared screen. Strokes are stored in the shared
 * surface's normalized 0..1 coordinate space so they render identically on every viewer (and in
 * the recording) regardless of display size. When editable (the presenter), pointer input emits
 * stroke deltas via `onStroke`; remote deltas/snapshots/clears are applied for everyone.
 */
export class AnnotationOverlay {
  readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly strokes = new Map<string, LocalStroke>();
  private editable = false;
  private drawing = false;
  private curId: string | null = null;

  color = "#ff3b30";
  width = 4;
  onStroke?: (id: string, color: string, width: number, points: StrokePoint[], done: boolean) => void;

  constructor() {
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none;";
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
  }

  setEditable(on: boolean): void {
    this.editable = on;
    this.canvas.style.pointerEvents = on ? "auto" : "none";
    this.canvas.style.cursor = on ? "crosshair" : "default";
  }

  /** Match the backing store to the element's displayed size (call on layout changes). */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.redraw();
  }

  applyDelta(id: string, color: string, width: number, points: StrokePoint[]): void {
    let s = this.strokes.get(id);
    if (!s) {
      s = { color, width, points: [] };
      this.strokes.set(id, s);
    }
    for (const p of points) s.points.push(p);
    this.redraw();
  }

  applySnapshot(list: FullStroke[]): void {
    this.strokes.clear();
    for (const st of list) {
      this.strokes.set(st.strokeId, { color: st.color, width: st.width, points: [...st.points] });
    }
    this.redraw();
  }

  clear(): void {
    this.strokes.clear();
    this.redraw();
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.canvas.remove();
  }

  // -------------------------------------------------------------------------

  private redraw(): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of this.strokes.values()) this.drawStroke(s);
  }

  private drawStroke(s: LocalStroke): void {
    const { ctx, canvas } = this;
    if (s.points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width * dpr;
    const px = (p: StrokePoint) => [p.x * canvas.width, p.y * canvas.height] as const;
    if (s.points.length === 1) {
      const [x, y] = px(s.points[0]!);
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    const [x0, y0] = px(s.points[0]!);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < s.points.length; i++) {
      const [x, y] = px(s.points[i]!);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private pointFromEvent(e: PointerEvent): StrokePoint {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.editable) return;
    this.drawing = true;
    this.curId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const p = this.pointFromEvent(e);
    this.strokes.set(this.curId, { color: this.color, width: this.width, points: [p] });
    this.onStroke?.(this.curId, this.color, this.width, [p], false);
    this.redraw();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drawing || !this.curId) return;
    const p = this.pointFromEvent(e);
    this.strokes.get(this.curId)?.points.push(p);
    this.onStroke?.(this.curId, this.color, this.width, [p], false);
    this.redraw();
  };

  private onUp = (): void => {
    if (!this.drawing || !this.curId) return;
    this.onStroke?.(this.curId, this.color, this.width, [], true);
    this.drawing = false;
    this.curId = null;
  };
}
