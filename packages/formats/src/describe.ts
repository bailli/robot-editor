import type { EpisodeClasses } from "./classes.ts";
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
const TELEPORTER_RECORD = 13;
const GATED_RECORD = 5;

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
  const textOf = (classId: number) => classes.typeOfClass.get(classId) ?? classId;
  if (cls.describeMethod === LOGIC || type === LOGIC_CELL) {
    const record = room?.records.find((r) => r.slot === state);
    // teleporters: class 0x43's text, variant from the record; item-gated cells: 0x34
    if (record?.data[0] === TELEPORTER_RECORD) {
      return { text: textOf(0x43), variant: record.data[7] };
    }
    if (record?.data[0] === GATED_RECORD) return { text: textOf(0x34), variant: "random" };
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
