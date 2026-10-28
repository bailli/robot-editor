/** A number as 0x-prefixed hex, padded to `digits` (4 by default). */
export const hex = (value: number, digits = 4) => `0x${value.toString(16).padStart(digits, "0")}`;

/** A byte-sized number as hex, two digits. */
export const hex2 = (value: number) => hex(value, 2);

/** Bytes as hex, the first `most` of them ("…" after). */
export function hexBytes(bytes: Uint8Array, most = Infinity): string {
  const shown = [...bytes.subarray(0, most)].map((b) => b.toString(16).padStart(2, "0"));
  return `${shown.join(" ")}${bytes.length > most ? " …" : ""}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
