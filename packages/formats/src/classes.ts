import { type PeImage, readVa } from "./pe.ts";

/**
 * Object classes of an episode, read from GameOfRobot.exe.
 *
 * Every episode passes a table of 128 entries (class object, unknown) to the episode
 * constructor (0x43b2e0); entry t handles map tile type t. Class objects are static
 * instances whose vtable is set at startup by `mov dword ptr [object], vtable` (C7 05
 * imm32 imm32). vtable +0x00 returns the class id, +0x08 prepares a map cell for drawing:
 * its address identifies how the cell is drawn (see FrameMethod and render.ts).
 */

/** Addresses of the vtable +0x08 methods the renderer knows. */
export const FrameMethod = {
  /** frame = state & 0xf (0x41faa0) */
  NIBBLE: 0x41fad0,
  /** as NIBBLE (colour 0 cleared when state bit 7 is set, not modelled) */
  NIBBLE_ALT: 0x41faf0,
  /** walls: as NIBBLE, state >> 4 selects an underlay */
  WALL: 0x4200a0,
  ZERO: 0x41fb20,
  /** frame = state */
  STATE: 0x41fb50,
  /** as NIBBLE, state >> 5 selects an underlay if the frame is below 6 (0x4201e0) */
  UNDERLAY5: 0x4273d0,
  /** four 8x6 quarters by pattern, underlay (state >> 5) + 15 */
  TERRAIN: 0x41fd20,
  /** four quarters cut by mask frames */
  MASKED: 0x41fb80,
  /** frame 0, colour 0 = state & 0xf */
  DOOR: 0x41ff50,
  /** frame 0 plus a font glyph (character = state & 0x7f) */
  LETTER: 0x40e8f0,
  /** base frame plus frames 8 and 9 as add-ons */
  ADDONS: 0x426bf0,
  /** frame planes cut by a mask frame */
  CUT: 0x426dc0,
} as const;

export interface ObjectClass {
  /** Class id (vtable +0x00 returns a constant), undefined if it does not. */
  id: number | undefined;
  frameMethod: number;
  /** vtable +0x54: picks the description variant (see describe.ts). */
  describeMethod: number;
  /** vtable +0x28: called for each cell when a room is entered (0x42b6f0). */
  loadMethod: number;
}

/**
 * Room-load methods (vtable +0x28) that turn their cell into a moving actor (they clear
 * the cell and call 0x44dc60/0x44dd60): robots, androids, snakes, the worm and the
 * episodes' other creatures. The hero's own method (0x420960) only clears its cell.
 */
export const ACTOR_LOAD_METHODS: ReadonlySet<number> = new Set([
  0x40a8e0, 0x4244f0, 0x41b190, 0x4104d0, 0x4106f0, 0x412050, 0x412260, 0x412330, 0x412650,
  0x417df0, 0x417f70, 0x41b370, 0x41b590, 0x41c570,
]);

/** The bomb's room-load method: it starts the fuse; the explosion lets robots appear. */
export const BOMB_LOAD_METHOD = 0x421f80;

/**
 * Room-load methods that start a timer (0x408ae0) after which creatures appear: hatching
 * eggs, the snake basket, "something behind the wall" (tile types 0x30, 0x3c, 0x22 in
 * Junior), and episode IV's cylinders (0x68, "don't leave too many lying around").
 */
/**
 * Sand (describe method 0x413430, every episode): states 6 and 7 are small heaps hiding
 * scorpions ("Unter diesen kleinen Häufchen verbergen sich stachelige, giftige Gesellen")
 * that come out when disturbed.
 */
export const SAND_DESCRIBE_METHOD = 0x413430;
export const SAND_SCORPION_STATES: ReadonlySet<number> = new Set([6, 7]);

export const HATCHING_LOAD_METHODS: ReadonlySet<number> = new Set([0x426330, 0x4237e0, 0x41b030]);

export interface EpisodeClasses {
  /** Class per tile type, for the types that have one. */
  classes: ReadonlyMap<number, ObjectClass>;
  /**
   * Class id -> tile type (the game's 0x4c70e0 table, 0x43b46a: the last type with that id
   * wins; class 0, shared by unused types, is left out, so it means type 0).
   */
  typeOfClass: ReadonlyMap<number, number>;
  /** Underlay table (episode +0x10): entry k-1 = [class id, state] of underlay k. */
  underlays: readonly (readonly [classId: number, state: number])[];
  /** 0x47f238: quarter frames for FrameMethod.TERRAIN, indexed by state & 0xf. */
  terrainPatterns: readonly number[];
  /** 0x47f20c: quarter frames for FrameMethod.MASKED, indexed by state & 0x1f. */
  maskedPatterns: readonly number[];
  /** 8x8 font at 0x481170, 8 bytes per character code. */
  font: Uint8Array;
}

const CLASS_TABLES: readonly number[] = [0x479ad8, 0x475838, 0x476e00, 0x477ca0, 0x478c40];
const UNDERLAY_TABLES: readonly (number | undefined)[] = [
  undefined,
  0x466434,
  0x466524,
  0x466678,
  0x466c08,
];
const UNDERLAY_ENTRIES = 23;
const TYPES = 128;
const TERRAIN_PATTERNS = 0x47f238;
const MASKED_PATTERNS = 0x47f20c;
const FONT = 0x481170;

function u16s(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 2 }, (_, i) => view.getUint16(i * 2, true));
}

function u32(exe: PeImage, va: number): number {
  const b = readVa(exe, va, 4);
  return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
}

/** Class object -> vtable, from every `mov dword ptr [object], vtable` in the image. */
function vtables(exe: PeImage): Map<number, number> {
  const out = new Map<number, number>();
  const d = exe.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0; i + 10 <= d.length; i++) {
    if (d[i] !== 0xc7 || d[i + 1] !== 0x05) continue;
    const object = view.getUint32(i + 2, true);
    const vtable = view.getUint32(i + 6, true);
    if (object >= 0x4c0000 && object < 0x520000 && vtable >= 0x466000 && vtable < 0x474000) {
      if (!out.has(object)) out.set(object, vtable);
    }
  }
  return out;
}

function classId(exe: PeImage, vtable: number): number | undefined {
  const code = readVa(exe, u32(exe, vtable), 6);
  if (code[0] === 0x33 && code[1] === 0xc0 && code[2] === 0xc3) return 0; // xor eax, eax
  if (code[0] !== 0xb8 || code[5] !== 0xc3) return undefined;
  return new DataView(code.buffer, code.byteOffset + 1, 4).getUint32(0, true);
}

export function readEpisodeClasses(exe: PeImage, episode: number): EpisodeClasses {
  const table = episode >= 0 ? CLASS_TABLES.at(episode) : undefined;
  if (table === undefined) throw new RangeError(`no episode ${episode}`);
  const vts = vtables(exe);
  const classes = new Map<number, ObjectClass>();
  const typeOfClass = new Map<number, number>();
  for (let type = 0; type < TYPES; type++) {
    const vtable = vts.get(u32(exe, table + 8 * type));
    if (vtable === undefined) continue;
    const id = classId(exe, vtable);
    classes.set(type, {
      id,
      frameMethod: u32(exe, vtable + 8),
      describeMethod: u32(exe, vtable + 0x54),
      loadMethod: u32(exe, vtable + 0x28),
    });
    if (id) typeOfClass.set(id, type); // the game skips class 0, the shared empty class
  }
  const underlayTable = UNDERLAY_TABLES.at(episode);
  const underlayBytes =
    underlayTable === undefined ? undefined : readVa(exe, underlayTable, 2 * UNDERLAY_ENTRIES);
  return {
    classes,
    typeOfClass,
    underlays: underlayBytes
      ? Array.from(
          { length: UNDERLAY_ENTRIES },
          (_, i) => [underlayBytes[2 * i], underlayBytes[2 * i + 1]] as const,
        )
      : [],
    terrainPatterns: u16s(readVa(exe, TERRAIN_PATTERNS, 32)),
    maskedPatterns: u16s(readVa(exe, MASKED_PATTERNS, 64)),
    font: readVa(exe, FONT, 128 * 8).slice(),
  };
}
