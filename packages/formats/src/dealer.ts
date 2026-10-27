/**
 * The dealer's goods (STATUS, "The dealer's goods"). The episode's goods method (vtable
 * +0x10; Junior 0x40e1e0, I 0x408de0, II 0x409fe0, IV 0x40d6c0) hands out the table, its
 * number of entries and the most goods shown at once, all three as immediates:
 *
 *   55 8b ec 8b 45 08 8b 4d 0c   push ebp; mov ebp, esp; mov eax, [ebp+8]; mov ecx, [ebp+0xc]
 *   c7 00 nn nn nn nn            mov dword [eax], count
 *   c7 01 mm mm mm mm            mov dword [ecx], most
 *   b8 aa aa aa aa               mov eax, table
 *
 * Episode III's is the base method 0x40be40 (count and most 0, no table): no dealer there.
 * The dealer's offer (0x448440) is `random(5, most)` distinct entries of the table, rolled
 * anew at each appearance; an entry is 4 bytes: tile type, state (a cell value) and the
 * price in gold (word).
 */
import { type PeImage, parsePe, readVa } from "./pe.ts";
import { EPISODE_VTABLES } from "./start.ts";

const GOODS_METHOD = 0x10;
const CODE = [
  [0x55, 0x8b, 0xec, 0x8b, 0x45, 0x08, 0x8b, 0x4d, 0x0c],
  [0xc7, 0x00, -1, -1, -1, -1],
  [0xc7, 0x01, -1, -1, -1, -1],
  [0xb8, -1, -1, -1, -1],
].flat();
const COUNT_AT = 11;
const MOST_AT = 17;
const TABLE_AT = 22;
const ENTRY_SIZE = 4;
/** The pristine tables and their entries, by table address: the room they have. */
const TABLES = new Map([
  [0x479a20, 19],
  [0x475730, 27],
  [0x476ce8, 31],
  [0x478bf8, 18],
]);

/** The fewest goods the dealer offers (0x4484a2: random(5, most)). */
export const MIN_SHOWN = 5;
/**
 * The most goods shown at once that the originals use (episode I). The offer holds 20
 * (0x448458 clears 30 dwords of 6-byte entries); whether more than 10 fit the screen is
 * not tried.
 */
export const MAX_SHOWN = 10;
/** The highest price: a word, kept below the sign bit. */
export const MAX_PRICE = 0x7fff;

export interface DealerGood {
  /** Tile type | state << 8, as a cell (tile 0x6d's state is remapped through 0x4c70e0). */
  tile: number;
  price: number;
}

export interface Dealer {
  goods: readonly DealerGood[];
  /** The most goods offered at once (at least MIN_SHOWN, at most the number of goods). */
  most: number;
}

interface GoodsMethod {
  /** The method's code (a view into the image). */
  code: Uint8Array;
  table: number;
  count: number;
  most: number;
}

const u32 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);

/** The episode's goods method, undefined if it hands out no table (episode III). */
function goodsMethod(image: PeImage, episode: number): GoodsMethod | undefined {
  if (!Number.isInteger(episode) || episode < 0 || episode >= EPISODE_VTABLES.length) {
    throw new RangeError(`no episode ${episode}`);
  }
  const method = u32(readVa(image, EPISODE_VTABLES[episode] + GOODS_METHOD, 4), 0);
  const code = readVa(image, method, CODE.length);
  if (CODE.some((b, i) => b >= 0 && code[i] !== b)) {
    // the base method: xor eax, eax instead of a table
    return undefined;
  }
  return { code, table: u32(code, TABLE_AT), count: u32(code, COUNT_AT), most: u32(code, MOST_AT) };
}

/** The episode's dealer goods, undefined if the episode has no dealer (episode III). */
export function readDealer(image: PeImage, episode: number): Dealer | undefined {
  const method = goodsMethod(image, episode);
  if (!method) return undefined;
  const bytes = readVa(image, method.table, method.count * ENTRY_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const goods = Array.from({ length: method.count }, (_, n) => ({
    tile: view.getUint16(n * ENTRY_SIZE, true),
    price: view.getUint16(n * ENTRY_SIZE + 2, true),
  }));
  return { goods, most: method.most };
}

/**
 * The number of goods the episode's table has room for: as many as the pristine exe
 * holds there (other data follows; more need the table moved), also after withDealer
 * gave it fewer; 0 without a dealer.
 */
export function dealerCapacity(image: PeImage, episode: number): number {
  const method = goodsMethod(image, episode);
  return method ? Math.max(TABLES.get(method.table) ?? 0, method.count) : 0;
}

/** Why the dealer cannot be given to an episode whose table holds `capacity` goods. */
export function dealerProblem(dealer: Dealer, capacity: number): string | undefined {
  const { goods, most } = dealer;
  if (capacity === 0) return "the episode has no dealer";
  if (goods.length > capacity) return `the table holds at most ${capacity} goods`;
  if (goods.length < MIN_SHOWN) return `the dealer needs at least ${MIN_SHOWN} goods`;
  if (!Number.isInteger(most) || most < MIN_SHOWN || most > Math.min(MAX_SHOWN, goods.length)) {
    return `at most ${MIN_SHOWN}–${Math.min(MAX_SHOWN, goods.length)} shown, not ${most}`;
  }
  for (const [n, { tile, price }] of goods.entries()) {
    const type = tile & 0xff;
    if (!Number.isInteger(tile) || tile < 0 || tile > 0xffff || type === 0 || type >= 0x7f) {
      return `good ${n + 1}: no item tile (0x${tile.toString(16)})`;
    }
    if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) {
      return `good ${n + 1}: price ${price} (0–${MAX_PRICE})`;
    }
  }
  return undefined;
}

/**
 * A copy of the exe whose dealer in `episode` sells `dealer.goods` (in place of the
 * table's first entries; the rest stay but are never offered) and shows at most
 * `dealer.most` at once. Throws a RangeError naming what does not fit (dealerProblem).
 */
export function withDealer(image: PeImage, episode: number, dealer: Dealer): Uint8Array {
  const method = goodsMethod(image, episode);
  const capacity = dealerCapacity(image, episode);
  const problem = dealerProblem(dealer, capacity);
  if (!method || problem) throw new RangeError(problem ?? "the episode has no dealer");
  const out = image.data.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const at = method.code.byteOffset - image.data.byteOffset;
  view.setUint32(at + COUNT_AT, dealer.goods.length, true);
  view.setUint32(at + MOST_AT, dealer.most, true);
  const table = readVa(image, method.table, capacity * ENTRY_SIZE);
  const tableAt = table.byteOffset - image.data.byteOffset;
  for (const [n, { tile, price }] of dealer.goods.entries()) {
    view.setUint16(tableAt + n * ENTRY_SIZE, tile, true);
    view.setUint16(tableAt + n * ENTRY_SIZE + 2, price, true);
  }
  parsePe(out);
  return out;
}

export function sameDealer(a: Dealer | undefined, b: Dealer | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.most === b.most &&
    a.goods.length === b.goods.length &&
    a.goods.every((g, n) => g.tile === b.goods[n]?.tile && g.price === b.goods[n]?.price)
  );
}
