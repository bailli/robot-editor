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
