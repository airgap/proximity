/** Keyboard movement input. WASD / arrow keys. Ignored while a text field is focused. */
export class Input {
  private readonly keys = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      if (isTyping()) return;
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) e.preventDefault();
      this.keys.add(k);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    // Drop keys on blur so the avatar doesn't "stick" moving when focus leaves the window.
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** Normalized-ish intent axis in {-1,0,1} per component (caller normalizes length). */
  axis(): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("arrowup") || this.keys.has("w")) dy -= 1;
    if (this.keys.has("arrowdown") || this.keys.has("s")) dy += 1;
    if (this.keys.has("arrowleft") || this.keys.has("a")) dx -= 1;
    if (this.keys.has("arrowright") || this.keys.has("d")) dx += 1;
    return { dx, dy };
  }
}

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}
