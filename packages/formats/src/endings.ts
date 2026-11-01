/**
 * Room 255 as an episode's end. A room change to NxtRoom 255 (0x40281a) in episode I
 * sets bit 0x100 of the game flags 0x4fe448 instead of loading a room, and the main
 * loop (0x4027ed) then clears it and calls the episode's ending method (vtable +0x6c);
 * in the other episodes 255 is a room like any other (a missing one does nothing). The
 * check is a compare with the episode number at 0x402844:
 *
 *   40283f  be 01 00 00 00   mov esi, 1           (used later)
 *   402844  39 71 04         cmp [ecx+4], esi     (ecx: the episode, +4 its number)
 *   402847  75 08            jne 0x402851         (load the room)
 *   402849  09 15 …          or [0x4fe448], edx   (edx: 0x100)
 *
 * withRoom255Ending makes it a test of the episode's bit in a mask: the 10 bytes at
 * 0x40283f jump to a stub in the padding of .text (file bytes past its virtual size;
 * the loader maps them with the section's last page, as readRva reads them):
 *
 *   465e60  be 01 00 00 00   mov esi, 1
 *   465e65  52               push edx
 *   465e66  8b 51 04         mov edx, [ecx+4]
 *   465e69  0f a3 15 mask    bt [mask], edx
 *   465e70  5a               pop edx
 *   465e71  0f 82 …          jc 0x402849
 *   465e77  e9 …             jmp 0x402851
 *   465e7c  mask             bit n: episode n ends at room 255
 *
 * With episode I's bit alone the exe's own bytes are written back, the stub zeroed.
 *
 * What the ending methods do (seen in the game, see STATUS "Endings"): Junior's only
 * returns, so nothing happens and the hero stays where he is; I's rolls the credits (the
 * cast of robots) and then ends the game, II's goes to room 600 (the ship at sea, text
 * 900), III's darkens the room to black (0x40b4a0), IV's ends the game at once (0x401430,
 * which I's calls after its credits). IV has a room 255 of its own, which the ending
 * makes unreachable.
 */
import { patchAt } from "./episode.ts";
import { type PeImage, parsePe, readVa } from "./pe.ts";

const CHECK_VA = 0x40283f;
const CHECK = [0xbe, 0x01, 0x00, 0x00, 0x00, 0x39, 0x71, 0x04, 0x75, 0x08] as const;
/** Where the episode is ended (or 0x402851, the room loaded). */
const ENDED_VA = 0x402849;
const LOADED_VA = 0x402851;
const STUB_VA = 0x465e60;
const MASK_VA = 0x465e7c;
const STUB_LENGTH = MASK_VA + 4 - STUB_VA;
/** The originals: episode I alone. */
const ORIGINAL_MASK = 1 << 1;
const EPISODE_COUNT = 5;

const rel32 = (from: number, to: number) => {
  const r = to - from;
  return [r & 0xff, (r >> 8) & 0xff, (r >> 16) & 0xff, (r >>> 24) & 0xff];
};
const le32 = (n: number) => rel32(0, n);

/** The jump at 0x40283f, padded with nops to the check's length. */
const JUMP = [0xe9, ...rel32(CHECK_VA + 5, STUB_VA), 0x90, 0x90, 0x90, 0x90, 0x90];

/** The stub's code (without the mask). */
const STUB = [
  ...[0xbe, 0x01, 0x00, 0x00, 0x00],
  0x52,
  ...[0x8b, 0x51, 0x04],
  ...[0x0f, 0xa3, 0x15, ...le32(MASK_VA)],
  0x5a,
  ...[0x0f, 0x82, ...rel32(0x465e77, ENDED_VA)],
  ...[0xe9, ...rel32(0x465e7c, LOADED_VA)],
];

const same = (bytes: Uint8Array, expected: readonly number[]) =>
  expected.every((b, i) => bytes[i] === b);

/** The episodes that end at room 255, as a mask (bit n: episode n). */
export function readRoom255Endings(image: PeImage): number {
  const check = readVa(image, CHECK_VA, CHECK.length);
  if (same(check, CHECK)) return ORIGINAL_MASK;
  const stub = readVa(image, STUB_VA, STUB_LENGTH);
  if (!same(check, JUMP) || !same(stub, STUB))
    throw new Error("unexpected code at the room 255 check (0x40283f)");
  return new DataView(stub.buffer, stub.byteOffset + STUB.length, 4).getUint32(0, true);
}

/** Whether a room change to room 255 ends the episode (only episode I's originally). */
export function endsAtRoom255(image: PeImage, episode: number): boolean {
  if (!Number.isInteger(episode) || episode < 0 || episode >= EPISODE_COUNT)
    throw new RangeError(`no episode ${episode}`);
  return (readRoom255Endings(image) & (1 << episode)) !== 0;
}

/** A copy of the exe in which room 255 ends the episode, or is a room like any other. */
export function withRoom255Ending(image: PeImage, episode: number, ends: boolean): Uint8Array {
  const before = readRoom255Endings(image);
  endsAtRoom255(image, episode);
  const mask = ends ? before | (1 << episode) : before & ~(1 << episode);
  const original = mask === ORIGINAL_MASK;
  const patched = patchAt(image, CHECK_VA, CHECK.length, (view, at) => {
    (original ? CHECK : JUMP).forEach((b, i) => {
      view.setUint8(at + i, b);
    });
  });
  return patchAt(parsePe(patched), STUB_VA, STUB_LENGTH, (view, at) => {
    const code = original ? [] : [...STUB, ...le32(mask)];
    for (let i = 0; i < STUB_LENGTH; i++) view.setUint8(at + i, code[i] ?? 0);
  });
}
