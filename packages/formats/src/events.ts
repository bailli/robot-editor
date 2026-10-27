/**
 * The episodes' event tables (episode +0x1cc, given to the episode constructors, e.g.
 * 0x408c76): what happens the first time in a game that something happens. Entry n
 * (12 bytes: id, points, a sound filled in from line n of the sound table 1E06):
 * entries 0-127 belong to tile type n (id: mostly its class, the take event's key),
 * later ones to game events (ids from 256 on). 0x42bef0 plays the sound and, once per game (bit `id` of
 * the bitset 0x4fe324), adds the points and shows text 1800 + n with the bonus (text
 * 516, "Bonus : %ld Punkte !"). Scripts award entries with Enigma(n).
 */
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
  const table = Number.isInteger(episode) && episode >= 0 ? TABLES.at(episode) : undefined;
  if (!table) throw new RangeError(`no episode ${episode}`);
  return table;
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
  const out = image.data.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const at = readVa(image, address, count * ENTRY_SIZE).byteOffset - image.data.byteOffset;
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
  return out;
}
