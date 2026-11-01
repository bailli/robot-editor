/**
 * The game's command console (STATUS.md, "Input, time and the driver"): 0x43c2a0 creates
 * the mutex Robot32Command and turns the console on only when it existed already:
 *
 *   0x43c2ff  3d b7 00 00 00   cmp eax, 0xb7   ; GetLastError() = ERROR_ALREADY_EXISTS?
 *   0x43c304  75 23            jne 0x43c329    ; no: the console stays off
 *
 * withConsole drops the jump, so the console is always on.
 *
 * The console's words and the objects' names (each class's vtable +4, `mov eax, imm32;
 * ret`) are obfuscated (0x431d60): a 0x06 lead byte, then each byte XORed with Borland
 * `rand() & 0x1f` after srand of the low 16 bits of a key that starts at 0x53654375 and
 * adds every decoded byte; the last byte decodes to the NUL. A name may end in ":" and
 * the states the console takes for it (0x43c390): a range (`KEY:0-15`, `LETTER:A-Z`),
 * one state given for it (`MONEY:2`), `d` any number to 255, `L` a word of 4 letters.
 */
import { patchAt } from "./episode.ts";
import { type PeImage, readRva, readVa } from "./pe.ts";

const CHECK = 0x43c2ff;
const COMPARE = [0x3d, 0xb7, 0x00, 0x00, 0x00];
const JUMP = [0x75, 0x23];
const NOPS = [0x90, 0x90];

/** Whether the exe's console is always on (withConsole's patch). */
export function readConsole(image: PeImage): boolean {
  const code = Array.from(readVa(image, CHECK, COMPARE.length + JUMP.length));
  const same = (bytes: readonly number[], from: number) =>
    bytes.every((b, i) => code[from + i] === b);
  if (same(COMPARE, 0) && same(NOPS, COMPARE.length)) return true;
  if (same(COMPARE, 0) && same(JUMP, COMPARE.length)) return false;
  throw new Error(`unexpected console check at 0x${CHECK.toString(16)}`);
}

/** A copy of the exe whose command console is on without the mutex. */
export function withConsole(image: PeImage): Uint8Array {
  readConsole(image);
  return patchAt(image, CHECK + COMPARE.length, NOPS.length, (view, at) => {
    NOPS.forEach((b, i) => {
      view.setUint8(at + i, b);
    });
  });
}

const LEAD = 0x06;
const KEY = 0x53654375;

/** An obfuscated string (from its lead byte to before the NUL) decoded; undefined if none. */
export function decodeConsoleString(bytes: Uint8Array): string | undefined {
  if (bytes[0] !== LEAD) return undefined;
  let key = KEY;
  let text = "";
  for (let p = 0; p + 1 < bytes.length; p++) {
    const seed = (Math.imul(key & 0xffff, 0x015a4e35) + 1) >>> 0;
    const mask = (seed >>> 16) & 0x1f;
    if (bytes[p] === mask) return undefined;
    const c = (bytes[p + 1] ?? 0) ^ mask;
    if (c === 0) return p + 2 === bytes.length ? text : undefined;
    text += String.fromCharCode(c);
    key = (key + c) >>> 0;
  }
  return undefined;
}

/** An object as the console names it, e.g. `KEY(0-15)`, `NOTE(0-255)`, `LCARD(word)`. */
export interface ConsoleObject {
  name: string;
  /** How to write it with a state (`TAKE KEY(3)`); the name alone when it takes none. */
  usage: string;
}

const NAME = /^([A-Z][A-Z0-9]*)(?::([A-Z]-[A-Z]|\d+-\d+|\d+|d|L))?$/;

/** The names of the objects the console knows (every class's name in the exe), by name. */
export function readConsoleObjects(image: PeImage): ConsoleObject[] {
  const text = image.sections.find((s) => s.name === ".text");
  if (!text) throw new Error("no .text section");
  const code = readRva(image, text.virtualAddress, text.rawSize);
  const found = new Map<string, ConsoleObject>();
  for (let i = 0; i + 6 <= code.length; i++) {
    if (code[i] !== 0xb8 || code[i + 5] !== 0xc3) continue; // mov eax, imm32; ret
    const va = new DataView(code.buffer, code.byteOffset + i + 1, 4).getUint32(0, true);
    const name = nameAt(image, va);
    const match = name === undefined ? null : NAME.exec(name);
    if (!match) continue;
    const [, object = "", states = ""] = match;
    const usage =
      states === "" || /^\d+$/.test(states)
        ? object
        : `${object}(${states === "d" ? "0-255" : states === "L" ? "word" : states})`;
    found.set(object, { name: object, usage });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The obfuscated string at `va`, if one is there. */
function nameAt(image: PeImage, va: number): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = readVa(image, va, 64);
  } catch {
    return undefined;
  }
  const end = bytes.indexOf(0);
  return end < 0 ? undefined : decodeConsoleString(bytes.subarray(0, end));
}
