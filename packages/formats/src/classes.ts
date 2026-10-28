import { type BackdropRule, readBackdropRule } from "./episode-methods.ts";
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
  /**
   * vtable +0x0c: what happens when an actor steps on the cell (0x44c6f0); the classes'
   * methods mostly pick a handler from a table by the actor's kind (0x100 + n: entry n).
   */
  touchMethod: number;
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
 * Sand (describe method 0x413430, every episode): states 6 and 7 are small heaps hiding
 * scorpions ("Unter diesen kleinen Häufchen verbergen sich stachelige, giftige Gesellen").
 * Each episode has its own sand class object; in Junior and I (vtable 0x46bd00, touch
 * table 0x48011c) and II and III (0x467c70, table 0x47bcd4) the hero (in II and III also
 * a native) stepping on such a heap turns it into plain sand and lets a scorpion out
 * (0x41f9d0: a robot with the scorpion flag, 0x44dcf0); robots may not step on it. Episode IV's sand (0x469e70,
 * table 0x47df58) only lets the hero walk on: its states 6 and 7 are "Noch mehr Sand".
 */
export const SAND_DESCRIBE_METHOD = 0x413430;
export const SAND_SCORPION_STATES: ReadonlySet<number> = new Set([6, 7]);
/** The touch methods (vtable +0x0c) of the sand classes that hide scorpions. */
export const SCORPION_SAND_TOUCH_METHODS: ReadonlySet<number> = new Set([0x423de0, 0x4134c0]);

/**
 * Room-load methods that start a timer (0x408ae0) after which creatures appear: hatching
 * eggs, the snake basket, "something behind the wall" (tile types 0x30, 0x3c, 0x22 in
 * Junior).
 */
export const HATCHING_LOAD_METHODS: ReadonlySet<number> = new Set([0x426330, 0x4237e0]);

/**
 * The room-load method of episode IV's cylinders (tile 0x68, class 0xeb): it starts a
 * timer too, but its task (vtable 0x46a5f0, tick 0x419dd0) only makes the cell blink,
 * flipping state bit 0x200 every 0x28 ticks; it creates no actor.
 */
export const BLINK_LOAD_METHOD = 0x41b030;

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
  /**
   * The episode's actor kinds (episode +0x34, 8-byte entries, the kind in the second
   * dword): logic records name an actor by an index into it (see recordActorKind).
   */
  actorKinds: readonly number[];
  /** Which room the episode draws behind a room with a backdrop (backdrop.ts). */
  backdropRule: BackdropRule;
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
/** Per episode the actor table and its length (arguments of the episode constructor). */
const ACTOR_TABLES: readonly (readonly [number, number])[] = [
  [0x479ed8, 4],
  [0x475c38, 6],
  [0x477200, 6],
  [0x4780a0, 7],
  [0x479040, 5],
];

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

/**
 * One entry of an episode's class table: what tile type t is (see readClassTable).
 */
export interface ClassEntry {
  /** The class object (a static instance whose vtable is set at startup, see vtables). */
  object: number;
  /**
   * The entry's second dword. No reader found in the game (the episode constructor and
   * 0x43a5f0 read only the object); mostly the class id, 0x33 in unused entries.
   */
  extra: number;
}

/** The oracles' class (tile 0x51 in episodes II and III). */
export const ORACLE_CLASS = 0x60;

/**
 * Entries of the episode's texts (textsId) a class shows beyond its description and
 * first take, by class id: the oracle its hints (message 330 + n, n from its record,
 * walked into eastwards) and its death message 945 (southwards). Known from the code
 * and tried in the game; other classes' messages exist in every episode or are not traced.
 */
const CLASS_TEXTS: ReadonlyMap<number, readonly number[]> = new Map([
  [ORACLE_CLASS, [...Array.from({ length: 16 }, (_, n) => 330 + n), 945]],
]);

/** The text entries class `id` shows beyond its description and first take (CLASS_TEXTS). */
export function classTexts(id: number): readonly number[] {
  return CLASS_TEXTS.get(id) ?? [];
}

/** The shared empty class object (class 0) that unused tile types point to. */
export const EMPTY_CLASS_OBJECT = 0x4c777c;
/** The second dword of unused entries. */
const EMPTY_EXTRA = 0x33;

function classTable(episode: number): number {
  const table = Number.isInteger(episode) && episode >= 0 ? CLASS_TABLES.at(episode) : undefined;
  if (table === undefined) throw new RangeError(`no episode ${episode}`);
  return table;
}

/** The episode's class table, entry t for tile type t (128 entries). */
export function readClassTable(exe: PeImage, episode: number): ClassEntry[] {
  const table = classTable(episode);
  return Array.from({ length: TYPES }, (_, type) => ({
    object: u32(exe, table + 8 * type),
    extra: u32(exe, table + 8 * type + 4),
  }));
}

/**
 * Tile types without a class (pointing to EMPTY_CLASS_OBJECT): free for a class from
 * another episode (Junior 69, I 47, II none, III 18, IV 15).
 */
export function freeTileTypes(exe: PeImage, episode: number): number[] {
  return readClassTable(exe, episode).flatMap((entry, type) =>
    entry.object === EMPTY_CLASS_OBJECT ? [type] : [],
  );
}

/**
 * A copy of the exe whose class table for `episode` holds `entries` at the given tile
 * types (null: unused, as the game's unused entries). Any class object works in any
 * episode, e.g. readClassTable(exe, 2)[0x51] puts episode II's oracle into another; it
 * also needs shapes (withShapes) and texts there, and some class code checks the episode.
 */
export function withClassEntries(
  exe: PeImage,
  episode: number,
  entries: ReadonlyMap<number, ClassEntry | null>,
): Uint8Array {
  const table = classTable(episode);
  const objects = vtables(exe);
  const out = exe.data.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const at = readVa(exe, table, 8 * TYPES).byteOffset - exe.data.byteOffset;
  for (const [type, entry] of entries) {
    if (!Number.isInteger(type) || type < 0 || type >= TYPES) {
      throw new RangeError(`tile type ${type}`);
    }
    const { object, extra } = entry ?? { object: EMPTY_CLASS_OBJECT, extra: EMPTY_EXTRA };
    if (!objects.has(object)) throw new RangeError(`0x${object.toString(16)} is no class object`);
    if (!Number.isInteger(extra) || extra < 0 || extra > 0xffffffff) {
      throw new RangeError(`extra ${extra}`);
    }
    view.setUint32(at + 8 * type, object, true);
    view.setUint32(at + 8 * type + 4, extra, true);
  }
  return out;
}

export function readEpisodeClasses(exe: PeImage, episode: number): EpisodeClasses {
  const table = classTable(episode);
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
      touchMethod: u32(exe, vtable + 0x0c),
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
    actorKinds: actorKinds(exe, episode),
    backdropRule: readBackdropRule(exe, episode),
  };
}

function actorKinds(exe: PeImage, episode: number): number[] {
  const table = ACTOR_TABLES.at(episode);
  if (!table) return [];
  const [va, count] = table;
  return Array.from({ length: count }, (_, i) => u32(exe, va + 8 * i + 4) & 0xffff);
}
