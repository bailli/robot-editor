import { CIRCUIT_NODE_RECORD, GATE_CLASS, nodeBulb } from "./circuits.ts";
import { type EpisodeClasses, FrameMethod, type ObjectClass } from "./classes.ts";
import { TELEPORTER_RECORD } from "./exits.ts";
import type { Rgb } from "./palette.ts";
import { type TeleporterCondition, teleporterCondition } from "./records.ts";
import {
  LOGIC_CELL,
  ROOM_CELLS,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type Room,
  resolveCell,
} from "./scene.ts";
import {
  type Colours,
  type Shape,
  type ShapeTable,
  TILE_BACKGROUND,
  TRANSPARENT,
  planeBit,
  shapePixels,
} from "./shapes.ts";

export const TILE_WIDTH = 16;
export const TILE_HEIGHT = 12;
export const SCREEN_WIDTH = ROOM_WIDTH * TILE_WIDTH;
export const SCREEN_HEIGHT = ROOM_HEIGHT * TILE_HEIGHT;
const CELL_PIXELS = TILE_WIDTH * TILE_HEIGHT;
const DRAWN_PLANES = 3;

/**
 * Frame of a map cell: the low nibble of the cell's high byte, or 0 if the shape has no
 * such frame; undefined if the shape has no frames at all. This is what the wall class
 * (0x41faa0) and most other object classes do; walls store their diagonal corner pieces
 * this way (frames 1-4), so there is no neighbour-based auto-tiling at runtime.
 */
export function cellFrame(shape: Shape, cell: number): number | undefined {
  if (shape.frames.length === 0) return undefined;
  const frame = (cell >> 8) & 0xf;
  return frame < shape.frames.length ? frame : 0;
}

/** Plane masks (one 0/1 per pixel) of planes 0..2; null where a plane is empty. */
type Masks = (Uint8Array | null)[];

function frameMasks(shape: Shape, frame: number): Masks {
  const planes = frame >= 0 && frame < shape.frames.length ? shape.frames[frame].planes : undefined;
  return Array.from({ length: DRAWN_PLANES }, (_, k) => {
    const plane = planes?.[k];
    if (!plane) return null;
    const mask = new Uint8Array(CELL_PIXELS);
    for (let y = 0; y < TILE_HEIGHT; y++) {
      for (let x = 0; x < TILE_WIDTH; x++)
        mask[y * TILE_WIDTH + x] = planeBit(shape, plane, x, y) ? 1 : 0;
    }
    return mask;
  });
}

/** Colour per pixel from explicit masks, TRANSPARENT where none is set. */
function colourise(masks: Masks, colours: Colours, background = TILE_BACKGROUND): Uint8Array {
  const out = new Uint8Array(CELL_PIXELS).fill(TRANSPARENT);
  masks.forEach((mask, k) => {
    if (!mask) return;
    mask.forEach((bit, i) => {
      if (bit) out[i] = ((out[i] === TRANSPARENT ? background : out[i]) ^ colours[k]) & 0x0f;
    });
  });
  return out;
}

/** XORs a frame's plane colours onto existing (opaque) pixels. */
function xorFrame(
  pixels: Uint8Array,
  shape: Shape,
  frame: number,
  planes = DRAWN_PLANES,
): Uint8Array {
  frameMasks(shape, frame)
    .slice(0, planes)
    .forEach((mask, k) => {
      mask?.forEach((bit, i) => {
        if (bit) pixels[i] = (pixels[i] ^ shape.colours[k]) & 0x0f;
      });
    });
  return pixels;
}

const white = () => new Uint8Array(CELL_PIXELS).fill(TILE_BACKGROUND);

function framePixels(shape: Shape, frame: number, colours?: Colours): Uint8Array {
  return shapePixels(shape, frame < shape.frames.length ? frame : 0, TILE_BACKGROUND, colours);
}

/** FrameMethod.TERRAIN without state bit 4: 8x6 quarters from the pattern's frames. */
function terrain(shape: Shape, pattern: number): Uint8Array {
  const quarterFrames = [
    pattern & 0xf,
    (pattern >> 4) & 0xf,
    (pattern >> 12) & 0xf,
    (pattern >> 8) & 0xf,
  ];
  const quarterMasks = quarterFrames.map((frame) => frameMasks(shape, frame));
  const masks: Masks = Array.from({ length: DRAWN_PLANES }, (_, j) => {
    const plane = new Uint8Array(CELL_PIXELS);
    quarterMasks.forEach((frameMask, q) => {
      const src = frameMask[j];
      if (!src) return;
      const x0 = (q % 2) * 8;
      const y0 = Math.floor(q / 2) * 6;
      for (let y = y0; y < y0 + 6; y++) {
        for (let x = x0; x < x0 + 8; x++) plane[y * TILE_WIDTH + x] = src[y * TILE_WIDTH + x] ?? 0;
      }
    });
    return plane;
  });
  return colourise(masks, shape.colours);
}

/** FrameMethod.MASKED (0x41fb80): quarters cut by mask frames base+0..3. */
function masked(
  shape: Shape,
  cls: ObjectClass | undefined,
  pattern: number,
  state: number,
): Uint8Array {
  const planes = Array.from({ length: DRAWN_PLANES }, () => new Uint8Array(CELL_PIXELS));
  let maskBase = 0;
  let extra = 0;
  if (cls?.id === 0xde) {
    maskBase = 7;
    extra = state >> 6;
  } else if (cls?.id === 0xdf) {
    maskBase = 0x10;
    extra = (state >> 4) & 0xc;
  }
  for (let k = 0; k < 4; k++) {
    const f = (pattern >> (4 * k)) & 7;
    if (!f) continue;
    let frame = f - 1;
    if (state & 0x20) frame ^= 3;
    frame += extra;
    const mask = frameMasks(shape, maskBase + k)[0];
    const src = frameMasks(shape, frame);
    planes.forEach((plane, j) => {
      const s = src[j];
      if (!s || !mask) return;
      plane.forEach((bit, i) => (plane[i] = bit | ((s[i] ?? 0) & (mask[i] ?? 0))));
    });
  }
  return colourise(planes, shape.colours);
}

/** FrameMethod.ADDONS (0x426bf0). */
function addons(shape: Shape, state: number): Uint8Array {
  if (state >= 0x20) {
    if (state === 0x21) return xorFrame(xorFrame(white(), shape, 9), shape, 10);
    return xorFrame(white(), shape, 10);
  }
  const pixels = xorFrame(white(), shape, state & 7);
  if (state & 0x08) xorFrame(pixels, shape, 8);
  if (state & 0x10) xorFrame(pixels, shape, 9);
  return pixels;
}

/** FrameMethod.CUT (0x426dc0). */
function cut(shape: Shape, state: number): Uint8Array {
  if (state < 8) return xorFrame(white(), shape, state);
  if (state >= 0x28) return xorFrame(white(), shape, 12);
  const src = frameMasks(shape, state & 7);
  const mask = frameMasks(shape, (state >> 3) + 7)[0];
  const pixels = white();
  for (let k = 0; k < 2; k++) {
    const s = src[k];
    if (!s || !mask) continue;
    s.forEach((bit, i) => {
      if (bit & (mask[i] ?? 0)) pixels[i] = (pixels[i] ^ shape.colours[k]) & 0x0f;
    });
  }
  return pixels;
}

/** One 16-pixel glyph row (MSB = left), built from bits 7..1 like 0x4291e0 does. */
export function glyphRow(byte: number): number {
  let dx = 0;
  for (let k = 0; k < 7; k++) {
    const bx = ((byte >> (k + 1)) & 1) << 15;
    dx |= bx;
    dx >>= 1;
    dx |= bx;
    dx >>= k === 6 ? 2 : 1;
  }
  return dx & 0xffff;
}

/** FrameMethod.LETTER (0x40e8f0): frame 0, then glyph state & 0x7f in colour 1. */
function letter(shape: Shape, font: Uint8Array, state: number): Uint8Array {
  const colours: Colours = state & 0x80 ? [0, shape.colours[1], shape.colours[2]] : shape.colours;
  const pixels = framePixels(shape, 0, colours).map((c) =>
    c === TRANSPARENT ? TILE_BACKGROUND : c,
  );
  const char = state & 0x7f;
  if (char > 0x20) {
    for (let row = 0; row < 8; row++) {
      const bits = glyphRow(font[char * 8 + row] ?? 0);
      for (let x = 0; x < TILE_WIDTH; x++) {
        if (bits & (0x8000 >> x)) pixels[(3 + row) * TILE_WIDTH + x] = colours[1];
      }
    }
  }
  return pixels;
}

const NO_CLASSES: EpisodeClasses = {
  actorKinds: [],
  classes: new Map(),
  typeOfClass: new Map(),
  underlays: [],
  terrainPatterns: [],
  maskedPatterns: [],
  font: new Uint8Array(128 * 8),
};

function underlayIndex(method: number, state: number): number {
  switch (method) {
    case FrameMethod.WALL:
      return state & 0xf0 ? state >> 4 : 0;
    case FrameMethod.UNDERLAY5:
      return state & 0xe0 && (state & 0xf) < 6 ? state >> 5 : 0;
    case FrameMethod.TERRAIN:
      return state & 0xe0 ? (state >> 5) + 0xf : 0;
    default:
      return 0;
  }
}

/**
 * The 16x12 pixels of a map cell as drawn by its object class (palette indices,
 * TRANSPARENT where a sprite leaves the background visible), or undefined if nothing is
 * drawn. See tools/render_classes.py for the description of each class method.
 */
export function cellPixels(
  cell: number,
  objects: ShapeTable,
  episode: EpisodeClasses = NO_CLASSES,
  sprite = false,
): Uint8Array | undefined {
  const type = cell & 0xff;
  const state = cell >> 8;
  if (type === 0 || type === LOGIC_CELL) return undefined;
  const shape = objects.at(type);
  if (!shape || shape.frames.length === 0) return undefined;
  if (shape.width !== TILE_WIDTH || shape.height !== TILE_HEIGHT) return undefined;
  const cls = episode.classes.get(type);
  const method = cls?.frameMethod ?? 0;

  let pixels: Uint8Array;
  switch (method) {
    case FrameMethod.ZERO:
      pixels = framePixels(shape, 0);
      break;
    case FrameMethod.STATE:
      pixels = framePixels(shape, state);
      break;
    case FrameMethod.TERRAIN:
      pixels =
        state & 0x10
          ? framePixels(shape, (state & 0xf) + 4)
          : terrain(shape, episode.terrainPatterns[state & 0xf] ?? 0);
      break;
    case FrameMethod.MASKED:
      pixels = masked(shape, cls, episode.maskedPatterns[state & 0x1f] ?? 0, state);
      break;
    case FrameMethod.DOOR:
      pixels = framePixels(shape, 0, [state & 0xf || 15, shape.colours[1], shape.colours[2]]);
      break;
    case FrameMethod.LETTER:
      pixels = letter(shape, episode.font, state);
      break;
    case FrameMethod.ADDONS:
      pixels = addons(shape, state);
      break;
    case FrameMethod.CUT:
      pixels = cut(shape, state);
      break;
    default:
      pixels = framePixels(shape, state & 0xf);
  }

  const k = episode.underlays.length > 0 ? underlayIndex(method, state) : 0;
  const entry = k > 0 ? episode.underlays[k - 1] : undefined;
  if (entry) {
    const [classId, underState] = entry;
    const underType = episode.typeOfClass.get(classId) ?? 0;
    const under = underType > 0 ? objects.at(underType) : null;
    if (under && under.frames.length > 0) {
      const below = framePixels(under, underState);
      return pixels.map((c, i) =>
        c !== TRANSPARENT
          ? c
          : below[i] !== TRANSPARENT
            ? (below[i] ?? TILE_BACKGROUND)
            : TILE_BACKGROUND,
      );
    }
  }
  return sprite ? pixels : pixels.map((c) => (c === TRANSPARENT ? TILE_BACKGROUND : c));
}

const TILE_SIZE = TILE_WIDTH * TILE_HEIGHT;

/** The class whose frame 0 lies under the cell of a teleporter that needs an object. */
const TELEPORTER_CLASS = 0x43;

/**
 * What the game draws under the cell a teleporter with a condition shows (0x4328f0, type
 * 13 by byte 7, see teleporterCondition): for one that needs the object colour 15 with
 * the teleporter's frame 0 (class 0x43) XORed in, for one that forbids it black; then the
 * cell as a sprite. A GATE piece (class 76) that is forbidden is drawn instead as its
 * frame, the record's slot (the game takes the logic cell's state), XORed onto black in
 * colour 15. shownCells says which cells get a backing.
 */
export type Backing = Exclude<TeleporterCondition, "none">;

function backedPixels(
  cell: number,
  backing: Backing,
  objects: ShapeTable,
  episode: EpisodeClasses,
): Uint8Array {
  const out = new Uint8Array(TILE_SIZE).fill(backing === "carry" ? TILE_BACKGROUND : 0);
  if (backing === "not carry" && episode.classes.get(cell & 0xff)?.id === GATE_CLASS) {
    const gate = objects.at(cell & 0xff);
    const plane = gate ? frameMasks(gate, cell >> 8)[0] : null;
    plane?.forEach((bit, i) => {
      if (bit) out[i] ^= 0x0f;
    });
    return out;
  }
  const teleporter = episode.typeOfClass.get(TELEPORTER_CLASS);
  const frame = backing === "carry" && teleporter !== undefined ? objects.at(teleporter) : null;
  if (frame) xorFrame(out, frame, 0);
  const sprite = cellPixels(cell, objects, episode, true);
  if (sprite) {
    for (const [i, c] of sprite.entries()) if (c !== TRANSPARENT) out[i] = c;
  }
  return out;
}

/**
 * The 16x12 pixels of one map position: its base cell as a tile on colour 15 (or on a
 * teleporter's backing, see Backing), its overlay cell as a sprite on top (see
 * renderRoom).
 */
export function renderCell(
  base: number,
  overlay: number,
  objects: ShapeTable,
  episode?: EpisodeClasses,
  backing?: Backing,
): Uint8Array {
  const out =
    (backing && episode
      ? backedPixels(base, backing, objects, episode)
      : cellPixels(base, objects, episode)) ?? new Uint8Array(TILE_SIZE).fill(TILE_BACKGROUND);
  const sprite = cellPixels(overlay, objects, episode, true);
  if (sprite) {
    for (const [i, c] of sprite.entries()) if (c !== TRANSPARENT) out[i] = c;
  }
  return out;
}

/** A number for what renderCell draws, e.g. to cache its pixels. */
export function cellKey(base: number, overlay: number, backing?: Backing): number {
  return (base * 0x10000 + overlay) * 3 + (backing ? (backing === "carry" ? 1 : 2) : 0);
}

/** Copies a cell's pixels (renderCell) to position `index` of a room image. */
export function blitCell(image: Uint8Array, index: number, pixels: Uint8Array): void {
  const x0 = (index % ROOM_WIDTH) * TILE_WIDTH;
  const y0 = Math.floor(index / ROOM_WIDTH) * TILE_HEIGHT;
  for (let y = 0; y < TILE_HEIGHT; y++) {
    image.set(pixels.subarray(y * TILE_WIDTH, (y + 1) * TILE_WIDTH), (y0 + y) * SCREEN_WIDTH + x0);
  }
}

/** Cells of this class show the backdrop room's cell (see backdropRoom). */
export const BACKDROP_CLASS = 99;
/** The cells whose class gives a room a backdrop: (0, 1) and (39, 1). */
const BACKDROP_MARKS = [ROOM_WIDTH, 2 * ROOM_WIDTH - 1];

/**
 * The room the game draws behind a room, e.g. the town around a house's interior, or
 * undefined. A room has one if its cell (0, 1) or (39, 1) is of class 99 (episode
 * vtable +0x00: 0x409d30, IV 0x40d4a0); it is room id mod 100 (Junior to III) or id - 100
 * (IV). Drawing the room (0x401af0, 0x401ba0) loads that room's map from the scene and
 * draws its cell wherever the room's own cell is of class 99, so the backdrop's actors
 * (cells until a room is entered; robots draw nothing as tiles) do not move there. The
 * originals' class 99 cells have no overlay; whether one would hide the backdrop is not
 * traced (the game's map is one layer, see STATUS), shownCells assumes it does.
 */
export function backdropRoom(
  episode: number,
  room: Room,
  rooms: readonly Room[],
  classes: EpisodeClasses,
): Room | undefined {
  const marked = BACKDROP_MARKS.some(
    (i) => classes.classes.get(resolveCell(room, room.base[i] ?? 0) & 0xff)?.id === BACKDROP_CLASS,
  );
  if (!marked) return undefined;
  const id = episode === 4 ? room.id - 100 : room.id % 100;
  return rooms.find((r) => r.id === id);
}

/**
 * The cells drawn at map position `index`: [base, overlay] of the room, logic cells
 * resolved, or of `backdrop` (backdropRoom) where the room's cell is of class 99. A
 * circuit node shows its bulb as the overlay (nodeBulb; not under an overlay object,
 * which the game would draw on top of it), lit as byte 7 is or as `lit` says. A
 * teleporter with a condition adds its backing (Backing; a forbidden GATE piece then
 * shows the record's slot as its state).
 */
export function shownCells(
  room: Room,
  index: number,
  classes?: EpisodeClasses,
  backdrop?: Room,
  lit?: (index: number) => boolean | undefined,
): [base: number, overlay: number, fromBackdrop: boolean, backing?: Backing] {
  const cell = room.base[index] ?? 0;
  const base = resolveCell(room, cell);
  const overlay = resolveCell(room, room.overlay[index] ?? 0);
  if (backdrop && overlay === 0 && classes?.classes.get(base & 0xff)?.id === BACKDROP_CLASS) {
    return [
      resolveCell(backdrop, backdrop.base[index] ?? 0),
      resolveCell(backdrop, backdrop.overlay[index] ?? 0),
      true,
    ];
  }
  if (classes && (cell & 0xff) === LOGIC_CELL) {
    const record = room.records.find((r) => r.slot === cell >> 8);
    if (overlay === 0 && record?.data[0] === CIRCUIT_NODE_RECORD) {
      const bulb = nodeBulb(classes, lit?.(index) ?? record.data[7] !== 0);
      if (bulb !== undefined) return [base, bulb, false];
    }
    const condition = record?.data[0] === TELEPORTER_RECORD && teleporterCondition(record.data);
    if (record && condition && condition !== "none") {
      const gate = condition === "not carry" && classes.classes.get(base & 0xff)?.id === GATE_CLASS;
      return [gate ? (base & 0xff) | (record.slot << 8) : base, overlay, false, condition];
    }
  }
  return [base, overlay, false];
}

/**
 * Renders a room to palette indices (SCREEN_WIDTH x SCREEN_HEIGHT, row-major).
 *
 * Base cells are drawn as tiles on colour 15, overlay cells as sprites on top, each as
 * its object class does (cellPixels; pass the episode's classes from
 * readEpisodeClasses, without them every cell uses the cellFrame rule). Not drawn:
 * actors. Logic cells show the cell their record holds (resolveCell). Class 99 cells
 * show `backdrop` (backdropRoom), if given.
 */
export function renderRoom(
  room: Room,
  objects: ShapeTable,
  episode?: EpisodeClasses,
  backdrop?: Room,
): Uint8Array {
  const out = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const cells = new Map<number, Uint8Array>(); // rooms repeat few (base, overlay) pairs
  for (let i = 0; i < ROOM_CELLS; i++) {
    const [base, overlay, , backing] = shownCells(room, i, episode, backdrop);
    const key = cellKey(base, overlay, backing);
    let pixels = cells.get(key);
    if (!pixels) {
      pixels = renderCell(base, overlay, objects, episode, backing);
      cells.set(key, pixels);
    }
    blitCell(out, i, pixels);
  }
  return out;
}

/** Converts palette indices to RGBA, e.g. for `new ImageData(rgba, SCREEN_WIDTH)`. */
export function toRgba(
  indices: Uint8Array,
  palette: readonly Rgb[],
): Uint8ClampedArray<ArrayBuffer> {
  const lut = new Uint8Array(256 * 4);
  for (let c = 0; c < 256; c++) lut[c * 4 + 3] = 255; // indices beyond the palette: black
  for (const [c, [r, g, b]] of palette.entries()) lut.set([r, g, b], c * 4);
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0, o = 0; i < indices.length; i++, o += 4) {
    const l = indices[i] * 4;
    out[o] = lut[l];
    out[o + 1] = lut[l + 1];
    out[o + 2] = lut[l + 2];
    out[o + 3] = lut[l + 3];
  }
  return out;
}
