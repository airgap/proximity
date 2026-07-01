/**
 * Map collision helpers, shared by the server (which generates/loads maps) and the client
 * (which renders walls and does local move prediction). Collision is a row-major grid of
 * `width * height` tiles, 1 bit per tile (1 = blocked), packed 8 tiles/byte and base64-encoded
 * for transport inside `MapDescriptor.collisionB64`.
 */

/** Pack a 0/1-per-tile flag array into a base64 string (1 bit per tile). */
export function packCollision(flags: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(flags.length / 8));
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) bytes[i >> 3]! |= 1 << (i & 7);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Unpack a base64 collision string back into a 0/1-per-tile flag array of length `tileCount`. */
export function unpackCollision(b64: string, tileCount: number): Uint8Array {
  const bin = atob(b64);
  const flags = new Uint8Array(tileCount);
  for (let i = 0; i < tileCount; i++) {
    const byte = bin.charCodeAt(i >> 3);
    flags[i] = (byte >> (i & 7)) & 1;
  }
  return flags;
}

/** Whether tile (tx, ty) is blocked or out of bounds. `flags` is row-major width*height. */
export function isBlocked(
  flags: Uint8Array,
  width: number,
  height: number,
  tx: number,
  ty: number,
): boolean {
  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return true;
  return flags[ty * width + tx] === 1;
}
