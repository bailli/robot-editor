import { type PeImage, readVa } from "./pe.ts";

/**
 * The 16 base colours (R, G, B, unused) used for all shapes. Episode objects return
 * their palette from vtable slot +0x48: the default at 0x4827f0, episode 3 overrides
 * it with 0x477c10. The game expands them into a 224-entry palette for fades, but
 * shapes and PCX images only use entries 0..15.
 */
export type Rgb = readonly [r: number, g: number, b: number];

const DEFAULT_PALETTE_VA = 0x4827f0;
const EPISODE_PALETTE_VA: Readonly<Record<number, number>> = { 3: 0x477c10 };
export const PALETTE_SIZE = 16;

export function episodePalette(exe: PeImage, episode: number): Rgb[] {
  const bytes = readVa(exe, EPISODE_PALETTE_VA[episode] ?? DEFAULT_PALETTE_VA, PALETTE_SIZE * 4);
  return Array.from({ length: PALETTE_SIZE }, (_, i): Rgb => {
    const [r = 0, g = 0, b = 0] = bytes.subarray(i * 4, i * 4 + 3);
    return [r, g, b];
  });
}

/**
 * The palette block a room is drawn with at darkness `night` (Night, the room's tag kind
 * 2; 0x42b0b0): the game redraws the screen with colour n taken from entry 16 × block + n
 * of its 224-entry palette. 0 (and 255) is no darkness, else block = the byte table at
 * 0x481974 at (1100 − 11 × min(night, 100)) / 100: 60 → 9, 100 → 12 (black).
 * Light sources (0x42b230: lamps, fires, …) brighten parts of a dark room at run time.
 */
export function darknessBlock(night: number): number {
  if (night <= 0 || night >= 0xff) return 0;
  const index = Math.trunc((1100 - 11 * Math.min(night, 100)) / 100);
  return (DARKNESS_OFFSETS[index] ?? 0) / PALETTE_SIZE;
}

/** 0x481974: palette offsets by darkness index (11: light). */
const DARKNESS_OFFSETS = [192, 192, 176, 160, 144, 128, 112, 96, 80, 64, 48, 0] as const;

/** 2/7 as the game's single-precision constant (0x466344). */
const FADE_RATE = Math.fround(2 / 7);

/** The first and last dark block (3 is the palette itself, 12 black). */
const FIRST_DARK_BLOCK = 3;
const BLACK_BLOCK = 12;

/**
 * The 16 colours of a palette block as the game builds them (0x4023d0): block 0 is the
 * palette; dark blocks 3–11 fade towards grey and black: with grey = (2R + 3G + B) / 6
 * and t = (e^(2k/7) − 1) / (e^4 − 1) for k = 17 − block, each channel c becomes
 * (c × t + (1 − t) × grey) × t, truncated; block 12 is black. (With an option bit the
 * game fades linearly instead, c × (13 − block) / 10; not modelled.) Verified against
 * the palette of the game's screenshots.
 */
export function darkPalette(palette: readonly Rgb[], block: number): Rgb[] {
  if (block === 0) return [...palette];
  if (block >= BLACK_BLOCK) return palette.map((): Rgb => [0, 0, 0]);
  if (block < FIRST_DARK_BLOCK) throw new RangeError(`palette block ${block} is not a dark one`);
  const k = 17 - block;
  const t = (Math.exp(k * FADE_RATE) - 1) / (Math.exp(4) - 1);
  return palette.map(([r, g, b]): Rgb => {
    const grey = Math.trunc((2 * r + 3 * g + b) / 6);
    // truncated like the game's float to int conversion (| 0: no -0)
    const fade = (c: number) => ((c * t + (1 - t) * grey) * t) | 0;
    return [fade(r), fade(g), fade(b)];
  });
}
