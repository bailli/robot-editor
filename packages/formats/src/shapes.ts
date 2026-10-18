import { type OmfModule, parseOmf } from "./omf.ts";

/**
 * SHAPES resources: sprite and tile graphics as OMF object files.
 *
 * Each public symbol (_Rob_object, _Aliens, _Hero1, ...) starts a table of 12-byte
 * shape descriptors in the data segment:
 *   u8  width            u8  height
 *   u16 0                u8  bytes per row        u8 frame count
 *   u16 ptr -> frames    u8[3] colours c0 c1 c2   u8 unknown
 * An all-zero descriptor is an empty slot. _Rob_object is indexed by map tile type.
 *
 * Frame, 18 bytes: u16 unknown, then 4 far pointers to 1-bit planes
 * (height * bytesPerRow bytes, MSB = leftmost pixel); a pointer without fixup is empty.
 *
 * Drawing (0x428ea0 / 0x428f70): start from a background colour and XOR colour c_k
 * into every pixel set in plane k, for k = 0..2. Plane 3 is not used for drawing.
 * Map tiles start from colour 15 (0x41fb93). Pixels set in no plane are transparent
 * when drawn as a sprite.
 */

export type Colours = readonly [c0: number, c1: number, c2: number];

export interface Frame {
  word: number;
  /** Four 1-bit planes; null where the frame has no plane. */
  planes: readonly (Uint8Array | null)[];
}

export interface Shape {
  width: number;
  height: number;
  bytesPerRow: number;
  colours: Colours;
  unknown: number;
  frames: Frame[];
}

/** Shapes of one public symbol; null marks empty slots. */
export type ShapeTable = readonly (Shape | null)[];

export const TILE_BACKGROUND = 15;
/** Value returned by shapePixels for pixels set in no plane. */
export const TRANSPARENT = 0xff;

const DESCRIPTOR_SIZE = 12;
const FRAME_SIZE = 18;
const PLANES = 4;
const DRAWN_PLANES = 3;

interface Pointer {
  segment: Uint8Array;
  offset: number;
}

function pointerResolver(module: OmfModule) {
  const targets = new Map<string, number>();
  for (const f of module.fixups) {
    if (f.targetMethod === 0) targets.set(`${f.segment}:${f.offset}`, f.target);
  }
  /** The pointer stored at segment:offset, if a fixup makes it a pointer. */
  return (segment: number, offset: number): Pointer | undefined => {
    const target = targets.get(`${segment}:${offset}`);
    const from = module.segments[segment];
    const to = target === undefined ? undefined : module.segments[target];
    if (!from || !to) return undefined;
    const view = new DataView(from.data.buffer, from.data.byteOffset, from.data.byteLength);
    return { segment: to.data, offset: view.getUint16(offset, true) };
  };
}

export function parseShapes(data: Uint8Array): Map<string, ShapeTable> {
  const module = parseOmf(data);
  const pointerAt = pointerResolver(module);
  const tables = new Map<string, ShapeTable>();
  const publics = [...module.publics].sort((a, b) => a.offset - b.offset);

  for (const [i, pub] of publics.entries()) {
    const segment = module.segments[pub.segment];
    if (!segment) continue;
    const seg = segment.data;
    const next = publics.slice(i + 1).find((p) => p.segment === pub.segment);
    const end = next?.offset ?? seg.length;
    const table: (Shape | null)[] = [];

    for (let p = pub.offset; p + DESCRIPTOR_SIZE <= end; p += DESCRIPTOR_SIZE) {
      const descriptor = seg.subarray(p, p + DESCRIPTOR_SIZE);
      const [width = 0, height = 0, , , bytesPerRow = 0, frameCount = 0] = descriptor;
      if (width === 0) {
        if (descriptor.some((b) => b !== 0)) break;
        table.push(null);
        continue;
      }
      const frames = pointerAt(pub.segment, p + 6);
      if (!frames) break;
      const frameView = new DataView(
        frames.segment.buffer,
        frames.segment.byteOffset,
        frames.segment.byteLength,
      );
      const frameSegment = module.segments.findIndex((s) => s?.data === frames.segment);
      const planeSize = height * bytesPerRow;
      table.push({
        width,
        height,
        bytesPerRow,
        colours: [descriptor[8], descriptor[9], descriptor[10]],
        unknown: descriptor[11],
        frames: Array.from({ length: frameCount }, (_, k): Frame => {
          const e = frames.offset + FRAME_SIZE * k;
          return {
            word: frameView.getUint16(e, true),
            planes: Array.from({ length: PLANES }, (_, j) => {
              const plane = pointerAt(frameSegment, e + 2 + 4 * j);
              return plane ? plane.segment.slice(plane.offset, plane.offset + planeSize) : null;
            }),
          };
        }),
      });
    }
    while (table.length > 0 && table.at(-1) === null) table.pop();
    tables.set(pub.name, table);
  }
  return tables;
}

export function planeBit(shape: Shape, plane: Uint8Array, x: number, y: number): boolean {
  return ((plane[y * shape.bytesPerRow + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
}

/**
 * Colour index per pixel (row-major, width * height), TRANSPARENT where no drawn plane
 * is set. `colours` overrides the descriptor colours (some object classes do that).
 */
export function shapePixels(
  shape: Shape,
  frame = 0,
  background = TILE_BACKGROUND,
  colours: Colours = shape.colours,
): Uint8Array {
  if (!Number.isInteger(frame) || frame < 0 || frame >= shape.frames.length) {
    throw new RangeError(`shape has no frame ${frame}`);
  }
  const { planes } = shape.frames[frame];
  const out = new Uint8Array(shape.width * shape.height).fill(TRANSPARENT);
  for (let k = 0; k < DRAWN_PLANES; k++) {
    const plane = planes[k];
    if (!plane) continue;
    for (let y = 0; y < shape.height; y++) {
      for (let x = 0; x < shape.width; x++) {
        if (!planeBit(shape, plane, x, y)) continue;
        const i = y * shape.width + x;
        out[i] = (out[i] === TRANSPARENT ? background : out[i]) ^ colours[k];
      }
    }
  }
  return out;
}
