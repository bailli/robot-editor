import type { Rgb } from "./palette.ts";
import { ROOM_HEIGHT, ROOM_WIDTH, type Room } from "./scene.ts";
import {
  type Shape,
  type ShapeTable,
  TILE_BACKGROUND,
  TRANSPARENT,
  shapePixels,
} from "./shapes.ts";

export const TILE_WIDTH = 16;
export const TILE_HEIGHT = 12;
export const SCREEN_WIDTH = ROOM_WIDTH * TILE_WIDTH;
export const SCREEN_HEIGHT = ROOM_HEIGHT * TILE_HEIGHT;

/**
 * Renders a room to palette indices (SCREEN_WIDTH x SCREEN_HEIGHT, row-major).
 *
 * Base cells are drawn as tiles on colour 15, overlay cells as sprites on top.
 * Shapes come from the episode's _Rob_object table, indexed by the cell's low byte;
 * frame 0 is used. Not yet applied: wall auto-tiling and state-dependent colours.
 */
export function renderRoom(room: Room, objects: ShapeTable): Uint8Array {
  const out = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(TILE_BACKGROUND);
  const cache = new Map<Shape, Uint8Array>();
  const draw = (layer: Uint16Array, sprite: boolean) => {
    layer.forEach((cell, i) => {
      const type = cell & 0xff;
      const shape = type === 0 ? null : objects[type];
      if (!shape) return;
      let pixels = cache.get(shape);
      if (!pixels) {
        pixels = shapePixels(shape);
        cache.set(shape, pixels);
      }
      const x0 = (i % ROOM_WIDTH) * TILE_WIDTH;
      const y0 = Math.floor(i / ROOM_WIDTH) * TILE_HEIGHT;
      const w = Math.min(shape.width, SCREEN_WIDTH - x0);
      const h = Math.min(shape.height, SCREEN_HEIGHT - y0);
      for (let y = 0; y < h; y++) {
        const row = (y0 + y) * SCREEN_WIDTH + x0;
        for (let x = 0; x < w; x++) {
          const c = pixels[y * shape.width + x] ?? TRANSPARENT;
          if (c === TRANSPARENT && sprite) continue;
          out[row + x] = c === TRANSPARENT ? TILE_BACKGROUND : c;
        }
      }
    });
  };
  draw(room.base, false);
  draw(room.overlay, true);
  return out;
}

/** Converts palette indices to RGBA, e.g. for `new ImageData(rgba, SCREEN_WIDTH)`. */
export function toRgba(indices: Uint8Array, palette: readonly Rgb[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(indices.length * 4);
  indices.forEach((c, i) => {
    const [r, g, b] = palette[c] ?? [0, 0, 0];
    out.set([r, g, b, 255], i * 4);
  });
  return out;
}
