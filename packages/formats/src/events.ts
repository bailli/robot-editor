/**
 * The episodes' event tables (episode +0x1cc, given to the episode constructors, e.g.
 * 0x408c76): what happens the first time in a game that something happens. Entry n
 * (12 bytes: id, points, a sound filled in from line n of the sound table 1E06):
 * entries 0-127 belong to tile type n (id: mostly its class, the take event's key),
 * later ones to game events (ids from 256 on). 0x42bef0 plays the sound and, once per game (bit `id` of
 * the bitset 0x4fe324), adds the points and shows text 1800 + n with the bonus (text
 * 516, "Bonus : %ld Punkte !"). Scripts award entries with Enigma(n).
 */
import { TILE_TYPES } from "./classes.ts";
import { forEpisode, patchAt } from "./episode.ts";
import { type PeImage, readVa } from "./pe.ts";

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

/**
 * Per episode (0 = Junior): the entries the game never uses, which a new event can take
 * over. The tables are full: Junior and I have entry 190 (id 0), IV entries 197-200
 * (ids 388-391: no points, text or sound; IV's scripts award 180-196, no code raises
 * those ids); II and III have none.
 */
const SPARE_ENTRIES: readonly (readonly number[])[] = [[190], [190], [], [], [197, 198, 199, 200]];

/** The episode's entries the game never uses (see SPARE_ENTRIES). */
export function spareEventEntries(episode: number): readonly number[] {
  eventTable(episode);
  return SPARE_ENTRIES[episode] ?? [];
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
