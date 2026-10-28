/**
 * Where an episode starts. The episode's start method (vtable +0x54; Junior 0x40e1a0,
 * I 0x408da0, II 0x409fa0, III 0x40b460, IV 0x40d680) sets the hero's arrival cell, the
 * room to enter next and the rucksack's capacity with four plain instructions:
 *
 *   c6 05 09 e3 4f 00 xx         mov byte [0x4fe309], x       arrival x
 *   c6 05 0a e3 4f 00 yy         mov byte [0x4fe30a], y       arrival y
 *   66 c7 05 f6 e2 4f 00 rr rr   mov word [0x4fe2f6], room    NxtRoom
 *   66 c7 05 c0 e0 4f 00 nn nn   mov word [0x4fe0c0], n       the rucksack
 *
 * withEpisodeStart and withRucksack change their operands, e.g. to try out a room in the
 * game.
 *
 * The rucksack holds n slots (words class | state << 8 from 0x4fe0c2) and at most a
 * weight below n: taking an item (0x42c010) needs a free slot and the weights carried
 * plus the item's to stay below n; a weight is the item's shape frame's word (Frame.word
 * of its state; 0 counts as 4). Junior 38, I 50, II 60, III 200, IV 120; the items of
 * Junior, I, II and IV weigh 1 (but a few 2 or 3), III's up to 10 (a tree), so there the
 * weight matters. With its second argument set, 0x42c010 skips the weight (a slot is
 * still needed).
 */
import { u32le } from "./bytes.ts";
import { EPISODE_VTABLES, forEpisode, patchAt } from "./episode.ts";
import { type PeImage, readVa } from "./pe.ts";
import { ROOM_HEIGHT, ROOM_WIDTH } from "./scene.ts";

const START_METHOD = 0x54;

const CODE = [
  [0xc6, 0x05, 0x09, 0xe3, 0x4f, 0x00, -1],
  [0xc6, 0x05, 0x0a, 0xe3, 0x4f, 0x00, -1],
  [0x66, 0xc7, 0x05, 0xf6, 0xe2, 0x4f, 0x00, -1, -1],
  [0x66, 0xc7, 0x05, 0xc0, 0xe0, 0x4f, 0x00, -1, -1],
].flat();
const X_AT = 6;
const Y_AT = 13;
const ROOM_AT = 21;
const RUCKSACK_AT = 30;

/** The most slots: they end where the letters' count lies (0x4fe2b6). */
export const MAX_RUCKSACK = (0x4fe2b6 - 0x4fe0c2) / 2;

export interface EpisodeStart {
  room: number;
  /** The hero's cell. */
  x: number;
  y: number;
}

/** The start method's address and code (checked against the expected instructions). */
function startCode(image: PeImage, episode: number): { va: number; code: Uint8Array } {
  const vtable = forEpisode(EPISODE_VTABLES, episode);
  const va = u32le(readVa(image, vtable + START_METHOD, 4));
  const code = readVa(image, va, CODE.length);
  if (CODE.some((b, i) => b >= 0 && code[i] !== b)) {
    throw new Error(`episode ${episode}: unexpected start method at 0x${va.toString(16)}`);
  }
  return { va, code };
}

export function readEpisodeStart(image: PeImage, episode: number): EpisodeStart {
  const { code } = startCode(image, episode);
  return { room: code[ROOM_AT] | (code[ROOM_AT + 1] << 8), x: code[X_AT], y: code[Y_AT] };
}

/** The rucksack's capacity: its slots, and the weight it holds is below it. */
export function readRucksack(image: PeImage, episode: number): number {
  const { code } = startCode(image, episode);
  return code[RUCKSACK_AT] | (code[RUCKSACK_AT + 1] << 8);
}

/** A copy of the exe whose episode's rucksack has the capacity `capacity`. */
export function withRucksack(image: PeImage, episode: number, capacity: number): Uint8Array {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_RUCKSACK)
    throw new RangeError(`a rucksack holds 1 to ${MAX_RUCKSACK}`);
  const { va } = startCode(image, episode);
  return patchAt(image, va, CODE.length, (view, at) => {
    view.setUint16(at + RUCKSACK_AT, capacity, true);
  });
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
  const { va } = startCode(image, episode);
  return patchAt(image, va, CODE.length, (view, at) => {
    view.setUint8(at + X_AT, x);
    view.setUint8(at + Y_AT, y);
    view.setUint16(at + ROOM_AT, room, true);
  });
}
