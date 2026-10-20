/**
 * Where an episode starts. The episode's start method (vtable +0x54; Junior 0x40e1a0,
 * I 0x408da0, II 0x409fa0, III 0x40b460, IV 0x40d680) sets the hero's arrival cell and
 * the room to enter next with three plain instructions, then a word at 0x4fe0c0
 * (unknown):
 *
 *   c6 05 09 e3 4f 00 xx         mov byte [0x4fe309], x       arrival x
 *   c6 05 0a e3 4f 00 yy         mov byte [0x4fe30a], y       arrival y
 *   66 c7 05 f6 e2 4f 00 rr rr   mov word [0x4fe2f6], room    NxtRoom
 *
 * withEpisodeStart changes their operands, e.g. to try out a room in the game.
 */
import { type PeImage, parsePe, readVa } from "./pe.ts";
import { ROOM_HEIGHT, ROOM_WIDTH } from "./scene.ts";

/** The episodes' vtables (0 = Junior). */
export const EPISODE_VTABLES: readonly number[] = [
  0x466cd8, 0x466458, 0x4665a8, 0x466b08, 0x466c38,
];
const START_METHOD = 0x54;

const CODE = [
  [0xc6, 0x05, 0x09, 0xe3, 0x4f, 0x00, -1],
  [0xc6, 0x05, 0x0a, 0xe3, 0x4f, 0x00, -1],
  [0x66, 0xc7, 0x05, 0xf6, 0xe2, 0x4f, 0x00, -1, -1],
].flat();
const X_AT = 6;
const Y_AT = 13;
const ROOM_AT = 21;

export interface EpisodeStart {
  room: number;
  /** The hero's cell. */
  x: number;
  y: number;
}

/** The start method's code (checked against the expected instructions). */
function startCode(image: PeImage, episode: number): Uint8Array {
  if (!Number.isInteger(episode) || episode < 0 || episode >= EPISODE_VTABLES.length) {
    throw new RangeError(`no episode ${episode}`);
  }
  const vtable = EPISODE_VTABLES[episode];
  const pointer = readVa(image, vtable + START_METHOD, 4);
  const method = new DataView(pointer.buffer, pointer.byteOffset).getUint32(0, true);
  const code = readVa(image, method, CODE.length);
  if (CODE.some((b, i) => b >= 0 && code[i] !== b)) {
    throw new Error(`episode ${episode}: unexpected start method at 0x${method.toString(16)}`);
  }
  return code;
}

export function readEpisodeStart(image: PeImage, episode: number): EpisodeStart {
  const code = startCode(image, episode);
  return { room: code[ROOM_AT] | (code[ROOM_AT + 1] << 8), x: code[X_AT], y: code[Y_AT] };
}

/** A copy of the exe whose episode starts in `start.room` with the hero at (x, y). */
export function withEpisodeStart(image: PeImage, episode: number, start: EpisodeStart): Uint8Array {
  const { room, x, y } = start;
  if (!Number.isInteger(room) || room < 1 || room > 0xffff) throw new RangeError(`room ${room}`);
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= ROOM_WIDTH ||
    y >= ROOM_HEIGHT
  )
    throw new RangeError(`cell (${x}, ${y}) outside the room`);
  const code = startCode(image, episode);
  const out = image.data.slice();
  const at = code.byteOffset - image.data.byteOffset;
  out[at + X_AT] = x;
  out[at + Y_AT] = y;
  out[at + ROOM_AT] = room & 0xff;
  out[at + ROOM_AT + 1] = room >> 8;
  parsePe(out);
  return out;
}
