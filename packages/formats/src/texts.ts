/**
 * The episodes' texts (CRUNCHED resources, decoded with uncrunch and decodeCp437).
 *
 * 1E10 (German) and 1E11 (English, Junior and episode I only): a version line, then
 * numbered entries
 *   N:k            k = number of variants (empty: 1)
 *   text|          variants, separated by "|", the last one ends with ";"
 *   text;
 * Consecutive headers without text share the next text. Entries 0-127 describe tile
 * type N: the game shows one variant when the hero looks at a tile. Higher numbers are
 * messages (Message(id, ...) in room scripts). Texts contain "\" + line break where
 * narrow message boxes wrap and "²" + a character for colours (see displayText).
 *
 * 1E06: per tile type (0-127) and game event (128 on) the sound to play, "N:SOUND ;note".
 * The notes name the objects as the scripts know them, e.g. "21:QFANFARE ;O_KEY".
 */

export interface Texts {
  version: string;
  entries: Map<number, string[]>;
}

const HEADER = /^(\d+):(\d*)[ \t]*$/gm;

export function parseTexts(text: string): Texts {
  const version = text.slice(0, text.indexOf("\n")).trim();
  const entries = new Map<number, string[]>();
  const headers = [...text.matchAll(HEADER)];
  let next: string[] = [];
  for (const [i, header] of [...headers.entries()].reverse()) {
    const start = header.index + header[0].length + 1;
    const end = headers.at(i + 1)?.index ?? text.length;
    const body = text.slice(start, end).trimEnd();
    const variants =
      body === ""
        ? next
        : body
            .replace(/;$/, "")
            .split("|")
            .map((v) => v.trim());
    entries.set(Number(header[1]), variants);
    next = variants;
  }
  return { version, entries: new Map([...entries].sort((a, b) => a[0] - b[0])) };
}

/** Script names of objects by tile type, from a 1E06 sound table ("KEY" for "O_KEY"). */
export function parseObjectNames(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const match of text.matchAll(/^(\d+):[^\n]*?;\s*O_(\w+)/gm)) {
    const type = Number(match[1]);
    if (type < 128) names.set(type, match[2]);
  }
  return names;
}

/**
 * A text as one plain paragraph: colours removed, the line wrapping of the game's text
 * windows (narrow boxes break lines with a backslash, words with "-") undone, `_` (a hard
 * space) as a non-breaking space. Tile codes (`@14`, see textPieces) stay as they are, or
 * become `[name]` with `tileName`.
 */
export function displayText(text: string, tileName?: (value: number) => string): string {
  const plain = text
    .replace(/²./g, "")
    .replace(/-\\\n/g, "")
    .replace(/\\?\n\s*/g, " ")
    .replaceAll("_", "\u00a0")
    .trim();
  if (!tileName) return plain;
  return textPieces(plain)
    .map((p) => (p.kind === "text" ? p.text : `[${tileName(p.value)}]`))
    .join("");
}

/**
 * Text and the tiles the game draws inside it (0x42a56b): `@` and 1-4 hex digits is a
 * tile (type | state << 8) drawn as a cell, two characters wide; `*0`, `*1`, `*2` after it
 * draw it three times enlarged, slice by slice on three lines (slice 0 here stands for the
 * whole tile, 1 and 2 are left out); `@@` is an `@`; `@~` and up to 8 hex digits names a
 * game object (filled in by the game, dropped here).
 */
export type TextPiece =
  { kind: "text"; text: string } | { kind: "tile"; value: number; slice?: number };

const TILE_CODE = /@@|@~[0-9a-fA-F]{0,8}|@([0-9a-fA-F]{1,4})(?:\*([0-2]))?/g;

export function textPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  const add = (t: string) => {
    if (!t) return;
    const last = pieces.at(-1);
    if (last?.kind === "text") last.text += t;
    else pieces.push({ kind: "text", text: t });
  };
  let at = 0;
  for (const m of text.matchAll(TILE_CODE)) {
    add(text.slice(at, m.index));
    at = m.index + m[0].length;
    // the groups are absent (undefined) when they did not take part in the match
    const [whole, digits, slice] = m as unknown as [string, string?, string?];
    if (whole === "@@") add("@");
    else if (digits !== undefined) {
      const value = Number.parseInt(digits, 16);
      if (slice === undefined) pieces.push({ kind: "tile", value });
      else if (slice === "0") pieces.push({ kind: "tile", value, slice: 0 });
    }
  }
  add(text.slice(at));
  return pieces;
}
