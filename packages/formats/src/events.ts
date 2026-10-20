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
/** Texts of the entries: 1800 + n (episode vtable +0x38, 0x409d80). */
export const EVENT_TEXT = 1800;

export interface GameEvent {
  /** Mostly the tile type's class (entries 0-127), else an event id; the once-only key. */
  id: number;
  points: number;
}

export function readEventTable(image: PeImage, episode: number): GameEvent[] {
  const table = TABLES.at(episode);
  if (episode < 0 || !table) throw new RangeError(`no episode ${episode}`);
  const [address, count] = table;
  const bytes = readVa(image, address, count * ENTRY_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, n) => ({
    id: view.getInt32(n * ENTRY_SIZE, true),
    points: view.getInt32(n * ENTRY_SIZE + 4, true),
  }));
}
