import {
  MAX_LEDATA,
  type OmfFixup,
  OmfFormatError,
  type OmfModule,
  parseOmf,
  writeOmf,
} from "./omf.ts";

/**
 * SHAPES resources: sprite and tile graphics as OMF object files.
 *
 * Each public symbol (_Rob_object, _Aliens = the robots, _Hero1, ...) starts a table of 12-byte
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
  /** Segment index in OmfModule.segments. */
  index: number;
  segment: Uint8Array;
  offset: number;
}

function pointerResolver(module: OmfModule) {
  const fixups = new Map<string, OmfFixup>();
  for (const f of module.fixups) {
    if (f.targetMethod === 0) fixups.set(`${f.segment}:${f.offset}`, f);
  }
  /**
   * The pointer stored at segment:offset, if a fixup makes it a pointer. As in OMF, the
   * target offset is the stored value plus the fixup's displacement.
   */
  return (segment: number, offset: number): Pointer | undefined => {
    const fixup = fixups.get(`${segment}:${offset}`);
    const from = module.segments[segment];
    const to = fixup === undefined ? undefined : module.segments[fixup.target];
    if (!fixup || !from || !to) return undefined;
    const view = new DataView(from.data.buffer, from.data.byteOffset, from.data.byteLength);
    return {
      index: fixup.target,
      segment: to.data,
      offset: (view.getUint16(offset, true) + fixup.displacement) & 0xffff,
    };
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
              const plane = pointerAt(frames.index, e + 2 + 4 * j);
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

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Appends `bytes` to segment `index` (even offset), as LEDATA blocks; returns the offset. */
function append(module: OmfModule, index: number, bytes: Uint8Array): number {
  const segment = module.segments[index];
  if (!segment) throw new OmfFormatError(`no segment ${index}`);
  const at = segment.data.length + (segment.data.length & 1);
  if (at + bytes.length > 0xffff)
    throw new RangeError(`segment ${segment.name} would exceed 64 KiB`);
  const data = new Uint8Array(at + bytes.length);
  data.set(segment.data);
  data.set(bytes, at);
  segment.data = data;
  for (let o = 0; o < bytes.length; o += MAX_LEDATA) {
    module.blocks.push({
      segment: index,
      offset: at + o,
      length: Math.min(MAX_LEDATA, bytes.length - o),
    });
  }
  return at;
}

/**
 * A SHAPES resource whose table `name` (e.g. "_Rob_object") holds `shapes` at the given
 * indices (null: an empty slot), as the game would read them; the shapes may come
 * from any resource (parseShapes). New frames and planes are appended to the segments
 * the resource already uses for them, with fixups of the kinds it already uses. Slots
 * within the table are rewritten in place; one beyond its end moves the table, grown
 * and followed by an empty descriptor, to the end of its segment (the old bytes stay
 * unused) and its public with it. Everything else is written back as it was (writeOmf).
 */
export function withShapes(
  data: Uint8Array,
  name: string,
  shapes: ReadonlyMap<number, Shape | null>,
): Uint8Array {
  const module = parseOmf(data);
  const pub = module.publics.find((p) => p.name === name);
  if (!pub) throw new RangeError(`no shape table ${name}`);
  const table = { segment: pub.segment, start: pub.offset };
  const near = module.fixups.find((f) => f.location === 1 && f.segment === table.segment);
  const far = module.fixups.find((f) => f.location === 3);
  if (!near || !far) throw new OmfFormatError(`table ${name}: no pointers to copy the kind of`);
  const planesSegment = far.target;
  const length = (parseShapes(data).get(name) ?? []).length;
  const slots = Math.max(length, ...[...shapes.keys()].map((i) => i + 1));
  for (const i of shapes.keys()) {
    if (!Number.isInteger(i) || i < 0) throw new RangeError(`slot ${i}`);
  }

  let start = table.start;
  if (slots > length) {
    // the grown table at the end of its segment, its old descriptors and pointers copied
    const old = module.segments[table.segment]?.data ?? new Uint8Array();
    const grown = new Uint8Array((slots + 1) * DESCRIPTOR_SIZE);
    grown.set(old.subarray(table.start, table.start + length * DESCRIPTOR_SIZE));
    start = append(module, table.segment, grown);
    for (const f of module.fixups.filter(
      (f) =>
        f.segment === table.segment &&
        f.offset >= table.start &&
        f.offset < table.start + length * DESCRIPTOR_SIZE,
    )) {
      module.fixups.push({ ...f, offset: f.offset - table.start + start });
    }
    for (const p of module.publics) if (p.name === name) p.offset = start;
  }

  for (const [slot, shape] of shapes) {
    const at = start + slot * DESCRIPTOR_SIZE;
    module.fixups = module.fixups.filter(
      (f) => !(f.segment === table.segment && f.offset === at + 6),
    );
    const descriptor = new Uint8Array(DESCRIPTOR_SIZE);
    if (shape) {
      // the planes one after another, then the frames pointing to them
      const planeSize = shape.height * shape.bytesPerRow;
      const used = shape.frames.flatMap((frame, k) =>
        frame.planes.flatMap((plane, j) =>
          plane ? [{ plane, entry: FRAME_SIZE * k + 2 + 4 * j }] : [],
        ),
      );
      for (const { plane } of used) {
        if (plane.length !== planeSize)
          throw new RangeError(`slot ${slot}: plane of ${plane.length} bytes`);
      }
      const planesAt = append(module, planesSegment, concat(used.map((u) => u.plane)));
      const frames = new Uint8Array(FRAME_SIZE * shape.frames.length);
      const framesView = new DataView(frames.buffer);
      for (const [k, frame] of shape.frames.entries())
        framesView.setUint16(FRAME_SIZE * k, frame.word, true);
      for (const [i, { entry }] of used.entries())
        framesView.setUint16(entry, planesAt + i * planeSize, true);
      const framesAt = append(module, table.segment, frames);
      for (const { entry } of used) {
        module.fixups.push({
          ...far,
          segment: table.segment,
          offset: framesAt + entry,
          target: planesSegment,
        });
      }
      descriptor.set([shape.width, shape.height, 0, 0, shape.bytesPerRow, shape.frames.length]);
      new DataView(descriptor.buffer).setUint16(6, framesAt, true);
      descriptor.set([...shape.colours, shape.unknown], 8);
      module.fixups.push({
        ...near,
        segment: table.segment,
        offset: at + 6,
        target: table.segment,
      });
    }
    module.segments[table.segment]?.data.set(descriptor, at);
  }
  return writeOmf(module);
}

export function planeBit(shape: Shape, plane: Uint8Array, x: number, y: number): boolean {
  return ((plane[y * shape.bytesPerRow + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
}

/**
 * Colour index per pixel (row-major, width * height), TRANSPARENT where no drawn plane
 * is set. `colours` overrides the descriptor colours (some object classes do that).
 * Results are 4-bit like the game's four bitplanes, so they never equal TRANSPARENT.
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
        out[i] = ((out[i] === TRANSPARENT ? background : out[i]) ^ colours[k]) & 0x0f;
      }
    }
  }
  return out;
}
