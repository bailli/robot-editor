/**
 * An episode's flags: the word at +8 of the episode object ([0x51bb18]+8), which the
 * base constructor 0x43b2e0 clears and each episode's constructor ORs a constant into:
 *
 *   Junior 0x40e040  81 ca imm32   or edx, 0x48012946
 *   I      0x408ca0  81 c9 imm32   or ecx, 0x48012b46
 *   II     0x409ec0  81 c9 imm32   or ecx, 0x4901ed46
 *   III    0x40b0f5  0d imm32      or eax, 0x75ce0533
 *   IV     0x40d472  0d imm32      or eax, 0x22312ccd
 *
 * Bits the code is known to read: 0x20 robots keep their sprite's colours (only III's),
 * 0x400 the arrival at an edge stays on the edge cell (0x44c5a0), 0x2000 the
 * Teleport() point is cleared on entering a room (0x439426; all but III), 0x4000 an
 * oracle vanishes after sending the hero (north), 0x8000 after its hint (east; both
 * 0x412ae0, only II's), 0x40000 changes what a door cell in a state from 9 on does in
 * rooms from 100 on (0x413d45, not traced), 0x80000 doors in need no key (0x413daa,
 * only III's).
 * withEpisodeFlags changes the constant.
 */
import { type PeImage, parsePe, readVa } from "./pe.ts";

/** Robots keep their `_Aliens` sprite's colours instead of three random ones (0x445c4b). */
export const ROBOTS_KEEP_COLOURS = 0x20;
/** An oracle walked into northwards vanishes once it has sent the hero. */
export const ORACLE_VANISHES_NORTH = 0x4000;
/** An oracle walked into eastwards vanishes once it has shown its hint. */
export const ORACLE_VANISHES_EAST = 0x8000;
/** Doors into buildings take the hero without the key 0x0f15 (0x413daa). */
export const DOORS_NEED_NO_KEY = 0x80000;

/** Per episode (0 = Junior): the OR instruction and its opcode bytes before the imm32. */
const FLAGS_CODE: readonly (readonly [va: number, opcode: readonly number[]])[] = [
  [0x40e040, [0x81, 0xca]],
  [0x408ca0, [0x81, 0xc9]],
  [0x409ec0, [0x81, 0xc9]],
  [0x40b0f5, [0x0d]],
  [0x40d472, [0x0d]],
];

/** The constructor's imm32 (checked against the expected instruction). */
function flagsCode(image: PeImage, episode: number): Uint8Array {
  const found = Number.isInteger(episode) && episode >= 0 ? FLAGS_CODE.at(episode) : undefined;
  if (!found) throw new RangeError(`no episode ${episode}`);
  const [va, opcode] = found;
  const code = readVa(image, va, opcode.length + 4);
  if (opcode.some((b, i) => code[i] !== b)) {
    throw new Error(`episode ${episode}: unexpected constructor at 0x${va.toString(16)}`);
  }
  return code.subarray(opcode.length);
}

export function readEpisodeFlags(image: PeImage, episode: number): number {
  const imm = flagsCode(image, episode);
  return new DataView(imm.buffer, imm.byteOffset, 4).getUint32(0, true);
}

/** A copy of the exe whose episode's constructor sets the flags `flags`. */
export function withEpisodeFlags(image: PeImage, episode: number, flags: number): Uint8Array {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff)
    throw new RangeError(`flags ${flags}`);
  const imm = flagsCode(image, episode);
  const out = image.data.slice();
  const at = imm.byteOffset - image.data.byteOffset;
  new DataView(out.buffer, out.byteOffset).setUint32(at, flags, true);
  parsePe(out);
  return out;
}
