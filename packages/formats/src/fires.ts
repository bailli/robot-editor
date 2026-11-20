/**
 * Fires that burn until put out. Fire (class 117) has no task of its own: a room task
 * (0x435010) scans 25 cells a tick and steps the fires among them, by a path chosen by
 * the episode number ([0x51bb18]+4):
 *
 *   43501c  83 f8 04            cmp eax, 4
 *   43501f  0f 85 …             jne 0x4350bb
 *           (IV: a fire takes a random state 0–10 on a third of the passes; it never
 *           burns out nor lights its neighbours)
 *   4350bb  83 f8 03            cmp eax, 3
 *   4350be  0f 85 15 02 00 00   jne 0x4352d9         (0x435300: Junior, I, II)
 *   4350c4  …                   III's path
 *
 * Junior's path (0x435300) steps a fire on a third of the passes: state 0 is rekindled to
 * 5–12, any other drops by one, and at 0 the fire burns out, ash (class 136) taking its
 * cell and its four neighbours all lit (0x4343e0, new fire in state 4–15). So every fire
 * burns out within minutes and spreads as it does. III's path steps on half the passes
 * and lets a fire of state 0x80 and up never burn out (0x81 jumps back to 0xfe; state 0
 * becomes 0xff), so it burns until the bucket puts it out; fires of states 1–0x7f still
 * burn out, each neighbour then catching on a third of them.
 *
 * withLastingFires makes the episode check a test of the episode's bit in a mask: the 9
 * bytes at 0x4350bb jump to a stub in the padding of .text, after the room 255 ending's
 * (endings.ts):
 *
 *   465e80  0f a3 05 mask       bt [mask], eax
 *   465e87  0f 82 …             jc 0x4350c4          (III's path)
 *   465e8d  e9 …                jmp 0x4352d9         (Junior's)
 *   465e92  mask                bit n: episode n takes III's path
 *
 * With III's bit alone the exe's own bytes are written back, the stub zeroed. IV is
 * decided before (its own path) and has no bit.
 */
import { patchAt } from "./episode.ts";
import { type PeImage, parsePe, readVa } from "./pe.ts";

const CHECK_VA = 0x4350bb;
const CHECK = [0x83, 0xf8, 0x03, 0x0f, 0x85, 0x15, 0x02, 0x00, 0x00] as const;
/** III's path, and Junior's (the call of 0x435300). */
const LASTING_VA = 0x4350c4;
const BURNING_OUT_VA = 0x4352d9;
const STUB_VA = 0x465e80;
const MASK_VA = 0x465e92;
const STUB_LENGTH = MASK_VA + 4 - STUB_VA;
/** The originals: episode III alone. */
const ORIGINAL_MASK = 1 << 3;
/** The episodes with a bit: IV has a path of its own, checked first. */
const EPISODES_WITH_BIT = 4;
const IV = 4;

const rel32 = (from: number, to: number) => {
  const r = to - from;
  return [r & 0xff, (r >> 8) & 0xff, (r >> 16) & 0xff, (r >>> 24) & 0xff];
};
const le32 = (n: number) => rel32(0, n);

/** The jump at 0x4350bb, padded with nops to the check's length. */
const JUMP = [0xe9, ...rel32(CHECK_VA + 5, STUB_VA), 0x90, 0x90, 0x90, 0x90];

/** The stub's code (without the mask). */
const STUB = [
  ...[0x0f, 0xa3, 0x05, ...le32(MASK_VA)],
  ...[0x0f, 0x82, ...rel32(0x465e8d, LASTING_VA)],
  ...[0xe9, ...rel32(0x465e92, BURNING_OUT_VA)],
];

const same = (bytes: Uint8Array, expected: readonly number[]) =>
  expected.every((b, i) => bytes[i] === b);

/** The episodes (Junior to III) whose fires take III's path, as a mask (bit n: episode n). */
export function readLastingFires(image: PeImage): number {
  const check = readVa(image, CHECK_VA, CHECK.length);
  if (same(check, CHECK)) return ORIGINAL_MASK;
  const stub = readVa(image, STUB_VA, STUB_LENGTH);
  if (!same(check, JUMP) || !same(stub, STUB))
    throw new Error("unexpected code at the fire task's episode check (0x4350bb)");
  return new DataView(stub.buffer, stub.byteOffset + STUB.length, 4).getUint32(0, true);
}

/**
 * Whether the episode's fires burn until put out: III's path (only III's originally),
 * for fires of state 0 or 0x80 and up; IV's own path never lets one burn out.
 */
export function hasLastingFires(image: PeImage, episode: number): boolean {
  if (episode === IV) return true;
  if (!Number.isInteger(episode) || episode < 0 || episode >= EPISODES_WITH_BIT)
    throw new RangeError(`no episode ${episode}`);
  return (readLastingFires(image) & (1 << episode)) !== 0;
}

/** A copy of the exe whose episode (Junior to III) steps fires by III's path, or Junior's. */
export function withLastingFires(image: PeImage, episode: number, lasting: boolean): Uint8Array {
  if (episode === IV) throw new RangeError("episode IV's fires have a path of their own");
  const before = readLastingFires(image);
  hasLastingFires(image, episode);
  const mask = lasting ? before | (1 << episode) : before & ~(1 << episode);
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
