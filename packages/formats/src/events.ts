/**
 * The episodes' event tables (episode +0x1cc, given to the episode constructors, e.g.
 * 0x408c76): what happens the first time in a game that something happens. Entry n
 * (12 bytes: id, points, a sound filled in from line n of the sound table 1E06):
 * entries 0-127 belong to tile type n (id: mostly its class, the take event's key),
 * later ones to game events (ids from 256 on). 0x42bef0 plays the sound and, once per game (bit `id` of
 * the bitset 0x4fe324), adds the points and shows text 1800 + n with the bonus (text
 * 516, "Bonus : %ld Punkte !"). Scripts award entries with Enigma(n): the entry's id.
 */
import { TILE_TYPES, classVtables } from "./classes.ts";
import { EPISODE_VTABLES, forEpisode, patchAt } from "./episode.ts";
import { type PeImage, readVa } from "./pe.ts";
import type { Room } from "./scene.ts";
import { Op, parseCompiledScript, roomCompiledScript } from "./script.ts";

/** Per episode (0 = Junior): the table and its number of entries. */
const TABLES: readonly (readonly [address: number, entries: number])[] = [
  [0x479ef8, 192],
  [0x475c68, 192],
  [0x477230, 192],
  [0x4780d8, 187],
  [0x479068, 201],
];
const ENTRY_SIZE = 12;
/** Texts of the entries: 1800 + n (episode vtable +0x38, 0x409d80; eventTextsId). */
export const EVENT_TEXT = 1800;

export interface GameEvent {
  /** Mostly the tile type's class (entries 0-127), else an event id; the once-only key. */
  id: number;
  points: number;
}

function eventTable(episode: number): readonly [address: number, entries: number] {
  return forEpisode(TABLES, episode);
}

/** The number of entries in the episode's event table (fixed by its constructor). */
export function eventTableLength(episode: number): number {
  return eventTable(episode)[1];
}

/**
 * Ids of entries from 128 on: the episode constructor maps id -> entry in 0x4c70e0
 * (0x43b4bf, no bounds check), shared with class -> type below 256 and 0x188 long.
 */
export const FIRST_EVENT_ID = 256;
export const EVENT_IDS_END = 0x188;

/** Entries from 128 on: game events, the rest of the table belongs to tile types. */
export const FIRST_EVENT_ENTRY = TILE_TYPES;

const ENGINE = "engine";

/**
 * Event ids the game's code uses (research/event-entries, 2026-11-08): it raises them
 * (0x42bef0; at all 117 calls the id is a constant, but for the script's Enigma, the
 * oracle's 262 + n, first takes below 256 or III's gems' 321 + state (0x42c1a1) and the
 * console's ENIGMA; two calls take a second id from a jump, the slot machine's 315)
 * or plays their sound (0x43a780). The oracle's 262-277 (0x106 + the state's low 4 bits,
 * 0x412c14) count wherever the oracle class is, whatever states its rooms' oracles have. Per id the vtables of the classes whose code does it (their methods
 * and touch tables; the hero states 10-12 of the classes that set them, 331, 335, 337;
 * the computer's programs, 290, 310-313, 317; the rucksack's joker action, 276; the
 * magic words' wizard door, 287), an episode's vtable for its own methods (I's 298), or
 * ENGINE: code every episode runs. Branches only one episode takes are not told apart
 * (e.g. 363, 366 and 367 in the exits' code), which only makes entries look used.
 */
const CODE_EVENT_USES: ReadonlyMap<number, readonly number[] | typeof ENGINE> = new Map<
  number,
  readonly number[] | typeof ENGINE
>([
  [256, [0x46a8b0, 0x46b0c8, 0x46b990]],
  [257, [0x46bef0]],
  [258, [0x46bfb0]],
  [259, [0x4680a0]],
  [260, [0x46bab0]],
  [261, [0x468580, 0x46b9f0]],
  [262, [0x467d90]],
  [263, [0x467d90]],
  [264, [0x467d90]],
  [265, [0x467d90]],
  [266, [0x467d90]],
  [267, [0x467d90]],
  [268, [0x467d90]],
  [269, [0x467d90]],
  [270, [0x467d90]],
  [271, [0x467d90]],
  [272, [0x467d90, 0x4698d0, 0x46c1a0, 0x46c200]],
  [273, [0x467d90, 0x468948, 0x46b310]],
  [274, [0x467d90, 0x46c9a0, 0x46ca00, 0x46ca60, 0x46cac0]],
  [275, [0x467d90, 0x467f80, 0x467fe0]],
  [276, [0x467d90, 0x46c5e0]],
  [277, [0x467d90, 0x468040]],
  [278, [0x468460]],
  [279, [0x467e00]],
  [280, [0x46b9f0]],
  [281, [0x46ba50]],
  [282, [0x46b370]],
  [283, [0x46b750]],
  [284, [0x46bc40]],
  [285, ENGINE],
  [286, ENGINE],
  [287, [0x467350]],
  [288, [0x46bab0, 0x46bb10]],
  [289, [0x466e88]],
  [290, [0x466e88]],
  [291, ENGINE],
  [292, ENGINE],
  [293, [0x467290]],
  [294, [0x467290]],
  [295, [0x467290]],
  [298, [0x466458, 0x46ab50, 0x46abb0]],
  [299, [0x46c1a0, 0x46c200]],
  [300, [0x4671d0, 0x46aee8]],
  [301, [0x46b0c8]],
  [302, [0x466fc8]],
  [303, [0x4698d0, 0x46c1a0, 0x46c200]],
  [304, [0x467a90]],
  [305, [0x46b0c8]],
  [306, [0x46c130]],
  [307, [0x46b430]],
  [308, [0x467720]],
  [310, [0x466e88]],
  [311, [0x466e88]],
  [312, [0x466e88]],
  [313, [0x466e88]],
  [314, [0x467110]],
  [315, [0x467110]],
  [317, ENGINE],
  [318, ENGINE],
  [319, [0x4674d0, 0x469a50]],
  [320, [0x46b0c8]],
  [321, [0x469750]],
  [322, [0x469750]],
  [323, [0x469750]],
  [324, [0x469750]],
  [325, [0x4695d0]],
  [326, [0x468a08]],
  [327, [0x469750]],
  [328, ENGINE],
  [329, [0x46c9a0, 0x46ca00, 0x46ca60, 0x46cac0]],
  [330, [0x4689a8]],
  [331, [0x469450]],
  [332, [0x468a08]],
  [333, [0x468be8]],
  [334, [0x468d30]],
  [335, [0x4693f0]],
  [336, [0x46c1a0, 0x46c200]],
  [337, [0x468f70]],
  [338, [0x468d30]],
  [339, [0x469090]],
  [340, [0x467f80, 0x467fe0]],
  [341, [0x468d90]],
  [342, ENGINE],
  [343, [0x468820]],
  [344, [0x4686a0]],
  [345, [0x468fd0]],
  [346, [0x4683a0]],
  [347, [0x46a8b0]],
  [350, [0x46a910]],
  [351, [0x46a590]],
  [352, [0x46a590, 0x46a910]],
  [353, [0x46a910]],
  [354, [0x46a910]],
  [355, [0x46a910]],
  [356, [0x46a8b0, 0x46b0c8, 0x46b990]],
  [357, [0x46aee8]],
  [359, [0x469ed0]],
  [360, [0x469c90]],
  [361, [0x469c90]],
  [362, [0x469c90]],
  [363, [0x46bab0, 0x46bb10]],
  [364, [0x46a910]],
  [365, [0x46a910]],
  [366, [0x46bab0, 0x46bb10]],
  [367, [0x46bab0, 0x46bb10]],
  [368, [0x46a8b0]],
  [369, [0x466548, 0x467e60, 0x4697b0, 0x469870, 0x46b128, 0x46b248, 0x46b8d0]],
  [370, [0x46a790]],
]);

const ENIGMA = "ENIGMA";

/**
 * The entries a room's script awards with Enigma(n) (PUSH n, ARG, CALL Enigma), undefined
 * if one call's n is not a constant (it could be any entry).
 */
export function scriptEnigmaEntries(room: Room): number[] | undefined {
  const compiled = roomCompiledScript(room);
  if (!compiled) return [];
  const { code, symbols } = parseCompiledScript(compiled);
  const entries: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const call = code[i];
    if (call.op !== Op.CALL || symbols[call.operand]?.name.toUpperCase() !== ENIGMA) continue;
    if (i < 2) return undefined;
    const [push, arg] = [code[i - 2], code[i - 1]];
    if (push.op !== Op.PUSH || arg.op !== Op.ARG) return undefined;
    entries.push(push.operand);
  }
  return entries;
}

/**
 * The episode's entries from 128 on that a new event can take over: entries whose event
 * nothing in the episode uses, judged by the event each holds in `pristine` (so an entry
 * a mod already gave a new event stays one). An event is used when code that runs in the
 * episode raises it or plays its sound (CODE_EVENT_USES: the classes of its class table as
 * `image` holds it, copies included; its own methods; engine code), or when one of `rooms`
 * awards the entry by script (Enigma(n) takes the entry, then raises its id, 0x407aa0;
 * a script whose n is not a constant takes every entry).
 * Entries with id 0 are unused. An event no entry holds falls back on entry 0's sound,
 * points and text, and saving keeps the events raised by entry (0x438ca0), so its
 * once-only state is lost on loading: every event an episode raises needs an entry.
 * `running`: vtables of classes about to join the episode (a kit's), counted as present.
 */
export function freeEventEntries(
  image: PeImage,
  episode: number,
  rooms: readonly Room[],
  pristine: PeImage = image,
  running: Iterable<number> = [],
): number[] {
  const vtables = new Set([
    ...classVtables(image, episode),
    ...running,
    forEpisode(EPISODE_VTABLES, episode),
  ]);
  const awarded = new Set<number>();
  for (const room of rooms) {
    const entries = scriptEnigmaEntries(room);
    if (entries === undefined) return [];
    for (const n of entries) awarded.add(n);
  }
  const usedId = (id: number) => {
    if (id === 0) return false;
    if (id < FIRST_EVENT_ID) return true;
    const use = CODE_EVENT_USES.get(id);
    return use === ENGINE || (use?.some((vtable) => vtables.has(vtable)) ?? false);
  };
  return readEventTable(pristine, episode).flatMap(({ id }, n) =>
    n >= FIRST_EVENT_ENTRY && !awarded.has(n) && !usedId(id) ? [n] : [],
  );
}

export function readEventTable(image: PeImage, episode: number): GameEvent[] {
  const [address, count] = eventTable(episode);
  const bytes = readVa(image, address, count * ENTRY_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, n) => ({
    id: view.getInt32(n * ENTRY_SIZE, true),
    points: view.getInt32(n * ENTRY_SIZE + 4, true),
  }));
}

/**
 * A copy of the exe whose event table for `episode` holds `entries` at the given entry
 * numbers (the sound stays as the game fills it in, from the sound table).
 */
export function withEventEntries(
  image: PeImage,
  episode: number,
  entries: ReadonlyMap<number, GameEvent>,
): Uint8Array {
  const [address, count] = eventTable(episode);
  return patchAt(image, address, count * ENTRY_SIZE, (view, at) => {
    for (const [n, { id, points }] of entries) {
      if (!Number.isInteger(n) || n < 0 || n >= count) throw new RangeError(`no entry ${n}`);
      for (const value of [id, points]) {
        if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
          throw new RangeError(`${value} is no 32-bit value`);
        }
      }
      view.setInt32(at + n * ENTRY_SIZE, id, true);
      view.setInt32(at + n * ENTRY_SIZE + 4, points, true);
    }
  });
}
