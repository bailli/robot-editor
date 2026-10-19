/**
 * Room names, as the game builds them (0x43c0b0):
 *
 * - A room from id 100 on whose base cell (0, 1) has class 99 (tile type 0x54 in episodes
 *   II-IV, 0x4323f0) takes the name of room id - 100, repeatedly: caves and cellars share
 *   the name of the room above them.
 * - The text is entry 1000 + id (episode vtable +0x44) of the episode's texts, episode III
 *   uses its own resource 1320. Ids from a limit on have no name (see NAMED_ROOMS).
 * - Without a text the game shows "Szene <id>".
 * - The game fetches the text without line breaks and with "_" as a hard space (0x438850),
 *   then cuts it down to one line (0x43bfd0): a leading "!" (not "!!") marks a name
 *   followed by a description, so the name ends at the first backslash; otherwise
 *   backslashes become spaces and two in a row (an empty line) end it. "═" underlines
 *   are dropped, spaces and "*" collapse into single spaces, and the ends are trimmed.
 *   Where the game shows the descriptions is not known.
 */
import type { EpisodeClasses } from "./classes.ts";
import type { Room } from "./scene.ts";
import { type Texts, displayText } from "./texts.ts";

export const ROOM_NAME_ENTRY = 1000;
/** Rooms of this class at NAME_CELL share the name of room id - 100. */
export const SAME_NAME_CLASS = 99;
const NAME_CELL = 40;
/** Per episode the first room id without a name (0x40e640, 0x408e00, 0x40a010, 0x40b2d0; IV none). */
export const NAMED_ROOMS: readonly number[] = [200, 300, 700, 200, Infinity];

export interface RoomName {
  /** The room whose text it is (the room itself, or one 100, 200, ... below). */
  room: number;
  name: string;
  /** The text after the name of a "!" entry (episode III), as one paragraph. */
  description?: string;
}

/** The room whose name `id` shows. */
export function nameRoom(id: number, rooms: readonly Room[], classes: EpisodeClasses): number {
  while (id >= 100) {
    const room = rooms.find((r) => r.id === id);
    if (!room || classes.classes.get(room.base[NAME_CELL] & 0xff)?.id !== SAME_NAME_CLASS) break;
    id -= 100;
  }
  return id;
}

/** The game's one-line name from a room's text, plus a "!" entry's description. */
export function parseRoomName(text: string): Omit<RoomName, "room"> {
  const fetched = fetchText(text);
  const described = fetched.startsWith("!") && !fetched.startsWith("!!");
  const name = shortName(described ? fetched.slice(1) : fetched, described);
  const end = text.indexOf("\\");
  const description = described && end >= 0 ? displayText(text.slice(end + 1)) : "";
  return description ? { name, description } : { name };
}

/**
 * The copy of a text the game makes when it fetches one (0x438850): line breaks and
 * spaces become one space after a word (none after a backslash), "_" a hard space (0x1f).
 */
function fetchText(text: string): string {
  let out = "";
  let word = false;
  for (const c of text) {
    if (c === "\n" || c === " ") {
      if (word) out += " ";
      word = false;
    } else {
      out += c === "_" ? HARD_SPACE : c;
      word = c !== "\\";
    }
  }
  return out;
}

const HARD_SPACE = "\x1f";

/** 0x43bfd0 on a fetched text, then hard spaces and colour codes as plain text. */
function shortName(text: string, described: boolean): string {
  let out = "";
  let blank = true; // the last character written is a space (or nothing yet)
  let backslash = false;
  for (const c of text) {
    if (c === "═") {
      backslash = false;
      continue;
    }
    if (c === "\\") {
      if (backslash || described) break;
      backslash = true;
    } else {
      backslash = false;
      if (c !== " " && c !== "*") {
        out += c;
        blank = false;
        continue;
      }
    }
    if (!blank) out += " ";
    blank = true;
  }
  return out.replace(/²./g, "").replaceAll(HARD_SPACE, " ").replace(/ +/g, " ").trim();
}

export function roomName(
  texts: Texts | undefined,
  episode: number,
  id: number,
  rooms: readonly Room[],
  classes: EpisodeClasses,
): RoomName | undefined {
  const room = nameRoom(id, rooms, classes);
  if (room >= (NAMED_ROOMS[episode] ?? Infinity)) return undefined;
  const text = texts?.entries.get(ROOM_NAME_ENTRY + room)?.[0];
  return text === undefined ? undefined : { room, ...parseRoomName(text) };
}
