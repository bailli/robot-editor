/**
 * Code page 437, the character set of all game texts.
 *
 * Bytes 0x00-0x7f map to the same code points; 0x80-0xff map to the characters below.
 * The mapping is a bijection, so decode/encode round-trips every byte sequence.
 * The game uses 0xfc ("ⁿ") and 0xfd ("²") as prefixes of formatting codes.
 */
const HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const TO_CHAR: readonly string[] = Array.from({ length: 256 }, (_, b) =>
  b < 0x80 ? String.fromCharCode(b) : HIGH.charAt(b - 0x80),
);

const TO_BYTE: ReadonlyMap<string, number> = new Map(TO_CHAR.map((c, b) => [c, b]));

export function decodeCp437(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s += TO_CHAR[b];
  }
  return s;
}

/** Throws if the string contains a character that CP437 cannot represent. */
export function encodeCp437(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  let i = 0;
  for (const c of text) {
    const b = TO_BYTE.get(c);
    if (b === undefined) {
      throw new RangeError(`character ${JSON.stringify(c)} is not in code page 437`);
    }
    out[i++] = b;
  }
  return out.subarray(0, i);
}
