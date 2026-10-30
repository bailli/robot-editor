/**
 * The game's command console (STATUS.md, "Input, time and the driver"): 0x43c2a0 creates
 * the mutex Robot32Command and turns the console on only when it existed already:
 *
 *   0x43c2ff  3d b7 00 00 00   cmp eax, 0xb7   ; GetLastError() = ERROR_ALREADY_EXISTS?
 *   0x43c304  75 23            jne 0x43c329    ; no: the console stays off
 *
 * withConsole drops the jump, so the console is always on.
 */
import { patchAt } from "./episode.ts";
import { type PeImage, readVa } from "./pe.ts";

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
