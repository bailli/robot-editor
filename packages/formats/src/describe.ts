import { LETTER_CLASS } from "./circuits.ts";
import type { EpisodeClasses } from "./classes.ts";
import { TELEPORTER_RECORD } from "./exits.ts";
import { LOGIC_CELL, type Room } from "./scene.ts";

/**
 * What the game says when the hero looks at a cell (0x406ae0).
 *
 * In memory, cells hold class ids instead of tile types. The game asks the cell's class
 * (vtable +0x54, the describe method) for a variant, starting from 0, then shows variant
 * `variant` of text entry 0x4c70e0[class] (the tile type of that class, see
 * EpisodeClasses.typeOfClass) from the episode's texts (texts.ts). A negative variant is
 * a random one (0x438850: rand() % count); a variant the entry does not have shows entry
 * 510 ("no description") instead.
 *
 * The describe methods choose by the cell's state; a few depend on the game state, which
 * a static view cannot know (noted below), and some add a sentence of their own (key
 * colours, codes), which is left out here.
 */

export interface CellDescription {
  /** Text entry (texts.ts). */
  text: number;
  /** The variant shown, or the variants one of which is picked at random. */
  variant: number | readonly number[] | "random";
}

/** Entry shown when the chosen variant does not exist. */
export const NO_DESCRIPTION = 510;

/** The "expert" field (class 66, tile 0x32 in episodes I, II and IV). */
export const EXPERT_CLASS = 66;
/** Points per unit of an expert field's state. */
export const POINTS_PER_STATE = 10000;

/** Notes (Junior type 15; episodes I, II and IV type 58). */
export const NOTE_CLASS = 15;
/** Episode III's diary pages (type 58). */
export const DIARY_PAGE_CLASS = 164;
/** Packages (type 94): episode II's presents, III's chests, IV's crates. */
export const PACKAGE_CLASS = 109;
/** The first note message: a note shows message FIRST_NOTE_MESSAGE + (state & 0x7f). */
export const FIRST_NOTE_MESSAGE = 800;
/** The last note message there can be. */
export const LAST_NOTE_MESSAGE = FIRST_NOTE_MESSAGE + 0x7f;

/**
 * What a cell keeps in its state besides how it looks:
 * - package: the tile type inside (see packageContents)
 * - note: its message, read when stepped on or carried (see noteText)
 * - diary: the page, an entry of resource 1320 (see noteText)
 * - expert: the points the hero needs to cross it (see requiredPoints)
 * - letter: the character, drawn with glyph `code & 0x7f` of the game font; bit 7 draws
 *   the background in colour 0 (0x40e8f0 clears it then: episode I room 45's "[" blocks).
 *   Only A–Z are counted when taken (0x410200)
 */
export type CellData =
  | { kind: "package"; type: number }
  | { kind: "note"; message: number; read: "step" | "carry" }
  | { kind: "diary"; page: number }
  | { kind: "expert"; points: number }
  | { kind: "letter"; code: number };

/** The data a cell keeps in its state (CellData), undefined for other classes. */
export function cellData(cell: number, classes: EpisodeClasses): CellData | undefined {
  const state = cell >> 8;
  switch (classes.classes.get(cell & 0xff)?.id ?? 0) {
    case PACKAGE_CLASS:
      return { kind: "package", type: state };
    case NOTE_CLASS:
      return {
        kind: "note",
        message: FIRST_NOTE_MESSAGE + (state & 0x7f),
        read: state & 0x80 ? "step" : "carry",
      };
    case DIARY_PAGE_CLASS:
      return { kind: "diary", page: state };
    case EXPERT_CLASS:
      return { kind: "expert", points: state * POINTS_PER_STATE };
    case LETTER_CLASS:
      return { kind: "letter", code: state };
    default:
      return undefined;
  }
}

/** The state that holds `data`; throws a RangeError where no state can. */
function dataState(data: CellData): number {
  const byte = (value: number, what: string) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xff)
      throw new RangeError(`${what} ${value} does not fit in a state (0–255)`);
    return value;
  };
  switch (data.kind) {
    case "package":
      return byte(data.type, "tile type");
    case "note":
      if (
        !Number.isInteger(data.message) ||
        data.message < FIRST_NOTE_MESSAGE ||
        data.message > LAST_NOTE_MESSAGE
      )
        throw new RangeError(
          `a note shows a message from ${FIRST_NOTE_MESSAGE} to ${LAST_NOTE_MESSAGE}, not ${data.message}`,
        );
      return (data.message - FIRST_NOTE_MESSAGE) | (data.read === "step" ? 0x80 : 0);
    case "diary":
      return byte(data.page, "page");
    case "expert":
      if (data.points % POINTS_PER_STATE !== 0)
        throw new RangeError(`points go in steps of ${POINTS_PER_STATE}, not ${data.points}`);
      return byte(data.points / POINTS_PER_STATE, "points / 10,000");
    case "letter":
      return byte(data.code, "character");
  }
}

/**
 * `cell` holding `data` in its state (the class byte stays); throws a RangeError where no
 * state can hold it or the cell's class keeps other data.
 */
export function withCellData(cell: number, data: CellData, classes: EpisodeClasses): number {
  const kind = cellData(cell, classes)?.kind;
  if (kind !== data.kind)
    throw new RangeError(
      `cell 0x${cell.toString(16)} holds ${kind ?? "no data"}, not ${data.kind}`,
    );
  return (cell & 0xff) | (dataState(data) << 8);
}

/**
 * The points the hero needs to cross a cell, if it is an expert field: its state × 10,000
 * (0x4264f0: score / 10000 ≥ state; else message 508, "Du brauchst mindestens %ld
 * Punkte…").
 */
export function requiredPoints(cell: number, classes: EpisodeClasses): number | undefined {
  const data = cellData(cell, classes);
  return data?.kind === "expert" ? data.points : undefined;
}

/** What a note or diary page says (see noteText). */
export interface NoteText {
  /** Entry in the episode's texts; for a diary page in its room-name texts (resource 1320). */
  text: number;
  /**
   * "step": read when the hero steps on it, which removes it; "carry": picked up and read
   * from the rucksack, in Junior, I and II without vowels unless the hero carries the
   * dictionary (class 8; 300 points each time), then leaving the rucksack; in IV a
   * micro-cassette that stays and needs the recorder (class 0xbf, messages 973/974);
   * "diary": a page added to episode III's diary.
   */
  read: "step" | "carry" | "diary";
}

/**
 * The text of a note: message 800 + state. Notes with state bit 7 (drawn and described as
 * a note rather than old handwriting or a cassette) are read on the spot (0x421660, touch
 * table 0x47f948), the others picked up and read with "Benutzen" (0x4216e0, 0x4217f0;
 * 0x4066a0 shows them). Diary pages show entry `state` of resource 1320 (0x416400,
 * 0x40b370) and mark it read (bit `state` of 0x4fe3c8).
 */
export function noteText(cell: number, classes: EpisodeClasses): NoteText | undefined {
  const data = cellData(cell, classes);
  if (data?.kind === "diary") return { text: data.page, read: "diary" };
  return data?.kind === "note" ? { text: data.message, read: data.read } : undefined;
}

/**
 * What a package holds: the tile type in its state. Used from the rucksack, it becomes
 * that object (state 0) on the hero's cell, or the actor it stands for (robots, 0x433420);
 * an electric fence (class 7) kills the hero (message 951). 0x414150.
 */
export function packageContents(cell: number, classes: EpisodeClasses): number | undefined {
  const data = cellData(cell, classes);
  return data?.kind === "package" ? data.type : undefined;
}

type Rule = (state: number, episode: number) => number | readonly number[] | "random";

/** Describe methods by address; each gets the state byte of the cell. */
const RULES: Readonly<Partial<Record<number, Rule>>> = {
  0x40e6d0: () => "random", // most classes
  0x4205a0: () => "random", // the hero
  0x418a90: () => 0,
  0x418f90: () => [0, 1, 2, 3, 4], // episode IV robots (5 while a robot stands on it)
  0x409e20: () => 0, // episode II robots (4 while a robot stands on it)
  0x4260c0: (s) => (s >= 2 ? [1, 2] : 0),
  0x414c70: (s) => s & 0xf,
  0x416970: (s) => s,
  0x4225d0: (s) => s & 3,
  0x41b160: (s) => (s & 0xf ? 1 : 0),
  0x41b270: (s) => s & 1,
  0x410900: (s) => s & 1,
  0x418d60: (s) => (s & 6 ? 1 : 0),
  0x4195e0: (s) => (s & 8 ? 1 : 0),
  0x41c9f0: (s) => (s & 2 ? 1 : 0),
  0x41c890: (s) => (s ? 1 : 0),
  0x421750: (s) => (s > 0x7f ? 1 : 0),
  0x426ee0: (s) => (s === 0x28 ? 1 : 0),
  0x4185c0: (s) => (s === 9 ? 2 : 0),
  0x413430: (s) => (s < 6 ? 0 : s < 8 ? 1 : 2),
  0x4146a0: (s) => (s < 6 ? 0 : s < 8 ? 1 : s === 8 ? 2 : 3), // roof: roof, door, chimney, shadow
  0x414e50: (s) => (s === 0 ? 0 : s <= 3 ? 1 : 2),
  0x418b40: (s) => (s < 4 ? 0 : s === 4 ? 1 : 2),
  0x418c10: (s) => (s >= 10 ? 2 : s >= 6 ? 1 : 0),
  0x417b70: (s) => (s === 3 ? 2 : s >= 4 && s <= 6 ? 1 : s >= 7 && s <= 10 ? 3 : 0),
  0x41b9c0: (s) => ((s & 0x1f) === 0x13 ? 2 : (s & 0x1f) >= 0x10 && (s & 0x1f) <= 0x12 ? 1 : 0),
  0x41bbb0: (s) => ((s & 0xf) >= 4 ? 2 : s & 2 ? 1 : 0),
  0x4145b0: (s, e) => (s === 4 || s === 5 ? 1 : e === 3 && s === 0 ? 2 : s === 10 ? 3 : 0),
  // with a game option set these pick by state; off, variant 0 (the only one there is)
  0x4272f0: () => 0,
  // depends on a game flag
  0x415350: () => 0,
  // variant 0 plus a sentence of their own: key colours, messages 200/201
  0x41ff20: () => 0,
  0x414950: () => 0,
  0x413630: () => 0,
  // a text of their own (codes from the game state); the entry is the closest
  0x41d2c0: () => 0,
  0x40ff80: () => 0,
};

/** describe method 0x41bc80: describes the cell as class 200. */
const AS_CLASS_200 = 0x41bc80;
/** describe method 0x420280 of logic cells: by the logic record. */
const LOGIC = 0x420280;
const SPAWNER_RECORD = 5;

/** Whether describeCell models a describe method (vtable +0x54). */
export function knowsDescribeMethod(address: number): boolean {
  return address in RULES || address === AS_CLASS_200 || address === LOGIC;
}

/**
 * What the game would say about `cell` (a map value: tile type and state) in an episode.
 * `room` resolves logic cells to their records. Undefined for cells without a class.
 */
export function describeCell(
  cell: number,
  classes: EpisodeClasses,
  episode: number,
  room?: Room,
): CellDescription | undefined {
  const type = cell & 0xff;
  const state = cell >> 8;
  const cls = classes.classes.get(type);
  if (cls?.id === undefined) return undefined;
  const textOf = (classId: number) => classes.typeOfClass.get(classId) ?? 0; // the game's table starts zeroed
  if (cls.describeMethod === LOGIC || type === LOGIC_CELL) {
    const record = room?.records.find((r) => r.slot === state);
    // teleporters: class 0x43's text, variant from the record; spawners: class 0x34's
    if (record?.data[0] === TELEPORTER_RECORD) {
      return { text: textOf(0x43), variant: record.data[7] };
    }
    if (record?.data[0] === SPAWNER_RECORD) return { text: textOf(0x34), variant: "random" };
    return { text: textOf(cls.id), variant: 0 };
  }
  if (cls.describeMethod === AS_CLASS_200) return { text: textOf(200), variant: 0 };
  const rule = RULES[cls.describeMethod];
  return { text: textOf(cls.id), variant: rule ? rule(state, episode) : 0 };
}

/**
 * The texts a description can show (one, or the random choices), with entry 510 for
 * variants the entry does not have.
 */
export function descriptionTexts(
  description: CellDescription,
  entries: ReadonlyMap<number, readonly string[]>,
): string[] {
  const variants = entries.get(description.text) ?? [];
  const chosen =
    description.variant === "random"
      ? variants.map((_, i) => i)
      : typeof description.variant === "number"
        ? [description.variant]
        : description.variant;
  const texts = chosen.filter((i) => i < variants.length).map((i) => variants[i] ?? "");
  return texts.length > 0 ? texts : [...(entries.get(NO_DESCRIPTION) ?? [])];
}
