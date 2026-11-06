/**
 * The hero's states (STATUS, "Axe and hammer"): 13 state objects (table 0x4830f0, set by
 * 0x4477f0, the state at hero+0x10) decide how he moves, what his hit does and which
 * frame of his shape (tile type 1) is drawn. Some classes put him into one when used or
 * touched; two things about a state are per episode:
 * - the status line's icon (indicator 0x51bcf0, 0x435c90): class 135's tile type in
 *   state `icon - 1`, icon from the table at 0x4831a8 (6 bytes per state: Junior, I, II,
 *   III, IV and a sixth list). An icon of 0 makes the type 0xFF, whose class 0x43a5f0
 *   reads unchecked from past the class table: 0 in Junior, I and II (no icon), 0x7D0 in
 *   IV, which crashes the game;
 * - the hero's frames: states 10-12 draw frames 6-11, which only III's and IV's hero
 *   shapes have (Junior's, I's and II's have 6: the hero is not drawn).
 */
import { fileOffset, patchAt } from "./episode.ts";
import type { PeImage } from "./pe.ts";

export const HERO_STATE_ICONS = 0x4831a8;
export const HERO_STATES = 13;
const ICON_COLUMNS = 6;
/** The class whose tile type, in a state, is a hero state's icon. */
export const HERO_ICON_CLASS = 135;
/** The hero's tile type; its shape holds his frames. */
export const HERO_TYPE = 1;

/**
 * Hero states a class sets (calls of 0x4477f0 with a constant, traced to the classes;
 * returning to state 0 left out): Junior's 0x2a, the 0x11 of all but III, the 0x14 of
 * Junior, I and II, II's and IV's 0x19, II's 0x70 and 0x72, II's and III's 0x58, III's
 * bridle 0x3e, axe 0x61 and hammer 0x62, IV's 0x4a.
 */
export const CLASS_HERO_STATES: ReadonlyMap<number, readonly number[]> = new Map([
  [17, [3]],
  [20, [2]],
  [25, [6]],
  [42, [8]],
  [103, [1]],
  [127, [4]],
  [129, [5]],
  [166, [12]],
  [179, [10]],
  [180, [11]],
  [221, [9]],
]);

/**
 * The hero frames a state draws beyond his own (vtable +0x20): the axe's 6 and 7
 * (0x4471f0), the hammer's 8 and 9 (0x447330), the bridle's 10 and 11 (0x447590), by the
 * step's parity or direction; the others draw the episode's.
 */
export const HERO_STATE_FRAMES: ReadonlyMap<number, readonly number[]> = new Map([
  [10, [6, 7]],
  [11, [8, 9]],
  [12, [10, 11]],
]);

function iconAt(state: number, episode: number): number {
  if (!Number.isInteger(state) || state < 0 || state >= HERO_STATES) {
    throw new RangeError(`hero state ${state}`);
  }
  if (!Number.isInteger(episode) || episode < 0 || episode >= ICON_COLUMNS - 1) {
    throw new RangeError(`episode ${episode}`);
  }
  return HERO_STATE_ICONS + ICON_COLUMNS * state + episode;
}

/** The episode's icon per hero state: 0 none, else 1 + the state of class 135's type. */
export function readHeroStateIcons(exe: PeImage, episode: number): number[] {
  return Array.from({ length: HERO_STATES }, (_, state) => {
    const at = fileOffset(exe, iconAt(state, episode), 1);
    return exe.data[at] ?? 0;
  });
}

/** A copy of the exe whose icons for `episode` are `icons` (state -> icon, 0-255). */
export function withHeroStateIcons(
  exe: PeImage,
  episode: number,
  icons: ReadonlyMap<number, number>,
): Uint8Array {
  return patchAt(exe, HERO_STATE_ICONS, ICON_COLUMNS * HERO_STATES, (view, at) => {
    for (const [state, icon] of icons) {
      if (!Number.isInteger(icon) || icon < 0 || icon > 0xff) throw new RangeError(`icon ${icon}`);
      view.setUint8(at + iconAt(state, episode) - HERO_STATE_ICONS, icon);
    }
  });
}
