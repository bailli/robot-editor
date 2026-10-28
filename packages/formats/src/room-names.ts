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
 * - The banner on entering a room (0x406560) shows the whole text: what follows the name
 *   is the room's description, after the backslash of a "!" entry (shown without the "!",
 *   0x4063d0) or after an empty line (episode I's "RING-PLATZ", a few of episode III's).
 *   The game fetches at most ROOM_TEXT_SIZE - 1 characters of it.
 */
import type { EpisodeClasses } from "./classes.ts";
import type { Room } from "./scene.ts";
import type { Texts } from "./texts.ts";

export const ROOM_NAME_ENTRY = 1000;
/** The banner's buffer for a room's text (0x406560). */
export const ROOM_TEXT_SIZE = 1000;
/** Rooms of this class at NAME_CELL share the name of room id - 100. */
export const SAME_NAME_CLASS = 99;
const NAME_CELL = 40;
/** Per episode the first room id without a name (0x40e640, 0x408e00, 0x40a010, 0x40b2d0; IV none). */
export const NAMED_ROOMS: readonly number[] = [200, 300, 700, 200, Infinity];

export interface RoomName {
  /** The room whose text it is (the room itself, or one 100, 200, ... below). */
  room: number;
  name: string;
  /**
   * The text after the name, its lines (hard line breaks, "\" in the text) joined by
   * "\n", the game's wrapping removed (see splitRoomText).
   */
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

/** The game's one-line name from a room's text, plus the description after it. */
export function parseRoomName(text: string): Omit<RoomName, "room"> {
  const fetched = fetchText(text);
  const described = isDescribed(fetched);
  const name = shortName(described ? fetched.slice(1) : fetched, described);
  const { description } = splitRoomText(text);
  return description ? { name, description } : { name };
}

const isDescribed = (text: string) => text.startsWith("!") && !text.startsWith("!!");

/**
 * A room's text as the part with the name (`head`) and the description after it: a "!"
 * entry's description follows the first backslash, others' the first empty line (two
 * backslashes with only spaces and line breaks between them, where 0x43bfd0 ends the
 * name). The description's lines are the text's hard line breaks; spaces and the
 * text's own line breaks collapse into single spaces, as the game fetches it.
 */
export function splitRoomText(text: string): {
  head: string;
  description: string;
  form?: "!" | "empty line";
} {
  const described = isDescribed(text);
  const end = described ? /\\/.exec(text) : /\\[ \n]*\\/.exec(text);
  if (!end) return { head: text, description: "" };
  const description = text
    .slice(end.index + end[0].length)
    .split("\\")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  return { head: text.slice(0, end.index), description, form: described ? "!" : "empty line" };
}

/** How many characters of a room's text the game fetches (at most ROOM_TEXT_SIZE - 1 fit). */
export function roomTextLength(text: string): number {
  return fetchText(text).length;
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

/** How an episode writes room names when a room has none yet (see roomNameText). */
const NAME_STYLES: readonly ("stars" | "underlined" | "plain")[] = [
  "stars",
  "underlined",
  "stars",
  "plain",
  "plain",
];

/**
 * The text of a room's name entry for `name`, in the style of the entry it replaces
 * (`old`) or else the episode's: episode I underlines its names ("DER START\" + a line
 * of "═"), Junior and II frame them with stars ("*** Die Festung ***"), III and IV write
 * them plainly. The description of `old` stays, in its form (roomDescriptionText).
 */
export function roomNameText(name: string, episode: number, old?: string): string {
  const trimmed = name.trim();
  if (old === undefined) return styledName(trimmed, NAME_STYLES[episode] ?? "plain");
  const { head } = splitRoomText(old);
  const rest = old.slice(head.length);
  if (isDescribed(head)) return `!${trimmed}${rest}`;
  const style = head.includes("═") ? "underlined" : /^\s*\*/.test(head) ? "stars" : "plain";
  return styledName(trimmed, style) + rest;
}

/**
 * The text of a room's name entry `old` with the description `description` (lines
 * joined by "\n", empty: none) after the name, which stays as it is. Entries with a
 * description keep its form, others take the episode's: episode III writes a "!" before
 * the name and the description after its backslash, the others an empty line after the
 * name (episode I's "RING-PLATZ"). Lines are wrapped at DESCRIPTION_WIDTH (the game
 * wraps them anew); an unchanged description keeps the text as it is.
 */
export function roomDescriptionText(description: string, episode: number, old: string): string {
  const split = splitRoomText(old);
  const { head, form = episode === DESCRIBED_EPISODE ? "!" : "empty line" } = split;
  const name = isDescribed(head) ? head.slice(1) : head;
  const lines = description
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  if (lines === split.description) return old; // as it is, wrapping included
  if (!lines) return name;
  const text = lines.split("\n").map(wrap).join("\\\n");
  return form === "!" ? `!${name}\\\n${text}` : `${name}\\\n\\\n${text}`;
}

/** The episode whose rooms write their descriptions after a "!" name. */
const DESCRIBED_EPISODE = 3;
/** The longest line of a description as written (the originals' are up to 78). */
const DESCRIPTION_WIDTH = 78;

function styledName(name: string, style: "stars" | "underlined" | "plain"): string {
  if (style === "underlined") return `${name}\\\n${"═".repeat(name.length)}`;
  return style === "stars" ? `*** ${name} ***` : name;
}

/** What a text entry's line must not start with (textEntryProblem). */
const HEADER_LIKE = /^\d*:/;

/**
 * A line broken into lines of at most DESCRIPTION_WIDTH characters at spaces; never
 * before a word that would start a line like a text entry's header ("12:"); a paragraph
 * starting with one gets a space before it.
 */
function wrap(line: string): string {
  let out = "";
  let width = 0;
  for (const word of line.split(" ").filter(Boolean)) {
    if (width === 0) {
      // the first line starts the paragraph, which must not look like a header either
      if (HEADER_LIKE.test(word)) {
        out += " ";
        width++;
      }
      out += word;
    } else if (width + 1 + word.length > DESCRIPTION_WIDTH && !HEADER_LIKE.test(word)) {
      out += `\n${word}`;
      width = 0;
    } else {
      out += ` ${word}`;
      width++;
    }
    width += word.length;
  }
  return out;
}
