/** What the per-episode tables and patches of the exe have in common. */
import { type PeImage, parsePe, readVa } from "./pe.ts";

/** The episodes' vtables (0 = Junior). */
export const EPISODE_VTABLES: readonly number[] = [
  0x466cd8, 0x466458, 0x4665a8, 0x466b08, 0x466c38,
];

/** The entry of a per-episode table (0 = Junior); a RangeError for an episode without one. */
export function forEpisode<T>(table: readonly T[], episode: number): T {
  const found = Number.isInteger(episode) && episode >= 0 ? table.at(episode) : undefined;
  if (found === undefined) throw new RangeError(`no episode ${episode}`);
  return found;
}

/** The offset in the image's file of the `length` bytes at `va`. */
export function fileOffset(image: PeImage, va: number, length: number): number {
  return readVa(image, va, length).byteOffset - image.data.byteOffset;
}

/**
 * A copy of the exe changed by `write` (given a view of the copy and the file offset of
 * the `length` bytes at `va`); the result must still parse as a PE image.
 */
export function patchAt(
  image: PeImage,
  va: number,
  length: number,
  write: (view: DataView, at: number) => void,
): Uint8Array {
  const at = fileOffset(image, va, length);
  const out = image.data.slice();
  write(new DataView(out.buffer, out.byteOffset, out.byteLength), at);
  parsePe(out);
  return out;
}
