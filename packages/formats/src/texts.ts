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
 * windows (narrow boxes break lines with a backslash, words with "-") undone.
 */
export function displayText(text: string): string {
  return text
    .replace(/²./g, "")
    .replace(/-\\\n/g, "")
    .replace(/\\?\n\s*/g, " ")
    .trim();
}
