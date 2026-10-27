/**
 * The room drawn behind a room with a backdrop (backdropRoom): two methods of the
 * episode vtable decide, +0x00 (whether a room has one and which, for drawing it,
 * 0x401af0) and +0x04 (loading a room with it, 0x432820). Junior to III point them to
 * 0x409d30 and 0x439130 (room id mod 100: 242 shows 42), IV to 0x40d4a0 and 0x40d780
 * (id - 100: 242 shows 142); both pairs check the marks (0, 1) and (39, 1) alike.
 * withBackdropRule points them to the other pair.
 */
import { type PeImage, parsePe, readVa } from "./pe.ts";
import { EPISODE_VTABLES } from "./start.ts";

export type BackdropRule = "mod100" | "minus100";
export const BACKDROP_RULES: readonly BackdropRule[] = ["mod100", "minus100"];

/** The methods (vtable +0x00, +0x04) by rule. */
const METHODS: Readonly<Record<BackdropRule, readonly [number, number]>> = {
  mod100: [0x409d30, 0x439130],
  minus100: [0x40d4a0, 0x40d780],
};

function vtable(episode: number): number {
  const va = Number.isInteger(episode) && episode >= 0 ? EPISODE_VTABLES.at(episode) : undefined;
  if (va === undefined) throw new RangeError(`no episode ${episode}`);
  return va;
}

export function readBackdropRule(image: PeImage, episode: number): BackdropRule {
  const bytes = readVa(image, vtable(episode), 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const [first, second] = [view.getUint32(0, true), view.getUint32(4, true)];
  const rule = BACKDROP_RULES.find((r) => METHODS[r][0] === first && METHODS[r][1] === second);
  if (!rule) {
    const found = [first, second].map((m) => `0x${m.toString(16)}`).join(", ");
    throw new Error(`episode ${episode}: unexpected backdrop methods ${found}`);
  }
  return rule;
}

/** A copy of the exe whose episode draws backdrops by `rule`. */
export function withBackdropRule(image: PeImage, episode: number, rule: BackdropRule): Uint8Array {
  const bytes = readVa(image, vtable(episode), 8);
  const out = image.data.slice();
  const at = bytes.byteOffset - image.data.byteOffset;
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(at, METHODS[rule][0], true);
  view.setUint32(at + 4, METHODS[rule][1], true);
  parsePe(out);
  return out;
}

/** The backdrop's room id for a room id (0x409d30, 0x40d4a0). */
export function backdropRoomId(rule: BackdropRule, id: number): number {
  return rule === "minus100" ? id - 100 : id % 100;
}
