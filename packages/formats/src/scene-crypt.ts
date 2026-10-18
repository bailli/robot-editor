/**
 * SCENE resources are XOR-encrypted with a 25-byte key (applied by the reader at 0x431120).
 *
 * The key is 25 calls of the Borland-style rand() at 0x436870 after srand(0xC40C),
 * taking the low byte of each result (set up at 0x4310d0). Byte i is XORed with
 * key[i % 25]. XOR is its own inverse, so the same function encrypts and decrypts.
 */

const KEY_SEED = 0xc40c;
const KEY_LENGTH = 25;

function makeKey(): Uint8Array {
  const key = new Uint8Array(KEY_LENGTH);
  let seed = KEY_SEED;
  for (let i = 0; i < KEY_LENGTH; i++) {
    seed = (Math.imul(seed, 0x015a4e35) + 1) >>> 0;
    key[i] = (seed >>> 16) & 0xff;
  }
  return key;
}

export const SCENE_KEY: Readonly<Uint8Array> = makeKey();

/** Encrypts or decrypts a SCENE resource; returns a new array. */
export function cryptScene(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ SCENE_KEY[i % KEY_LENGTH];
  }
  return out;
}
