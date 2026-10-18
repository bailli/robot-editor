import { readFileSync, writeFileSync } from "node:fs";

import { decode, encode } from "fast-png";

import type { Rgb } from "@robot/formats";

/** An 8-bit palette image: one palette index per pixel, row-major. */
export interface IndexedImage {
  width: number;
  height: number;
  indices: Uint8Array;
  palette: readonly Rgb[];
}

export function readIndexedPng(path: URL | string): IndexedImage {
  const png = decode(readFileSync(path));
  if (!png.palette || png.depth !== 8 || png.channels !== 1) {
    throw new Error(`${String(path)}: expected an 8-bit palette PNG`);
  }
  return {
    width: png.width,
    height: png.height,
    indices: Uint8Array.from(png.data),
    palette: png.palette.map(([r = 0, g = 0, b = 0]): Rgb => [r, g, b]),
  };
}

/** Writes an 8-bit palette PNG, optionally enlarged by an integer factor. */
export function writeIndexedPng(path: URL | string, image: IndexedImage, zoom = 1): void {
  const width = image.width * zoom;
  const height = image.height * zoom;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const src = Math.floor(y / zoom) * image.width;
    for (let x = 0; x < width; x++)
      indices[y * width + x] = image.indices[src + Math.floor(x / zoom)] ?? 0;
  }
  const palette = image.palette.map(([r, g, b]) => [r, g, b]);
  writeFileSync(path, encode({ width, height, data: indices, depth: 8, channels: 1, palette }));
}
