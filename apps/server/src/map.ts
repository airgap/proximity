import { packCollision, type MapDescriptor } from "@proximity/protocol";

/**
 * Generate a simple default room for the MVP: a walled border with a few interior obstacles and
 * an open spawn point. Real spaces will load a Tiled map from the DB; this keeps the walking
 * skeleton self-contained with no external assets.
 */
export function generateDefaultMap(
  width = 48,
  height = 32,
  tileSize = 32,
): MapDescriptor {
  const flags = new Uint8Array(width * height);
  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) flags[y * width + x] = 1;
  };

  // Border walls.
  for (let x = 0; x < width; x++) {
    set(x, 0);
    set(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    set(0, y);
    set(width - 1, y);
  }

  // A couple of interior blocks to make proximity/occlusion interesting.
  for (let y = 8; y < 12; y++) for (let x = 10; x < 20; x++) set(x, y);
  for (let y = 20; y < 26; y++) for (let x = 30; x < 34; x++) set(x, y);
  // A small "meeting table" island.
  for (let y = 14; y < 18; y++) for (let x = 36; x < 42; x++) set(x, y);

  return {
    name: "Atrium",
    width,
    height,
    tileSize,
    collisionB64: packCollision(flags),
    spawn: { x: 4.5, y: 4.5 },
  };
}
