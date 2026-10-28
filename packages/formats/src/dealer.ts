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
 * anew at each appearance; an entry is 4 bytes: class id, state and the price in gold
 * (word). Class and state are what the game's map holds at run time (class | state << 8):
 * the offer line names the class's tile type (0x4c70e0[class], 0x4485af) and buying hands
 * class | state to the inventory (0x42c010) or lays it on the dealer's cell (0x433300).
 * A package (class 0x6d) keeps a class in its state too, turned into its tile type when
 * offered (0x448565), as packages hold their contents at run time.
 */
import { u32le } from "./bytes.ts";
import type { EpisodeClasses } from "./classes.ts";
import { PACKAGE_CLASS } from "./describe.ts";
import { EPISODE_VTABLES, fileOffset, forEpisode, patchAt } from "./episode.ts";
import { type PeImage, readVa } from "./pe.ts";

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
  /** The class id of what is sold (not its tile type). */
  classId: number;
  /** Its state; a package's: the class of its contents. */
  state: number;
  price: number;
}

export interface Dealer {
  goods: readonly DealerGood[];
  /** The most goods offered at once (at least MIN_SHOWN, at most the number of goods). */
  most: number;
}

interface GoodsMethod {
  /** The method's address. */
  va: number;
  /** The method's code (a view into the image). */
  code: Uint8Array;
  table: number;
  count: number;
  most: number;
}

/** The episode's goods method, undefined if it hands out no table (episode III). */
function goodsMethod(image: PeImage, episode: number): GoodsMethod | undefined {
  const method = u32le(readVa(image, forEpisode(EPISODE_VTABLES, episode) + GOODS_METHOD, 4));
  const code = readVa(image, method, CODE.length);
  if (CODE.some((b, i) => b >= 0 && code[i] !== b)) {
    // the base method: xor eax, eax instead of a table
    return undefined;
  }
  return {
    va: method,
    code,
    table: u32le(code, TABLE_AT),
    count: u32le(code, COUNT_AT),
    most: u32le(code, MOST_AT),
  };
}

/** The episode's dealer goods, undefined if the episode has no dealer (episode III). */
export function readDealer(image: PeImage, episode: number): Dealer | undefined {
  const method = goodsMethod(image, episode);
  if (!method) return undefined;
  const bytes = readVa(image, method.table, method.count * ENTRY_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const goods = Array.from({ length: method.count }, (_, n) => ({
    classId: view.getUint8(n * ENTRY_SIZE),
    state: view.getUint8(n * ENTRY_SIZE + 1),
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

/**
 * The cell the game makes of a good (as it lies in a room: tile type | state << 8),
 * undefined if the episode has no tile of its class (or of a package's contents).
 */
export function goodTile(good: Pick<DealerGood, "classId" | "state">, classes: EpisodeClasses) {
  const type = classes.typeOfClass.get(good.classId);
  const state = good.classId === PACKAGE_CLASS ? classes.typeOfClass.get(good.state) : good.state;
  return type === undefined || state === undefined ? undefined : type | (state << 8);
}

/** The good a cell would be sold as (goodTile's inverse), undefined if it has no class. */
export function cellGood(
  cell: number,
  classes: EpisodeClasses,
): Pick<DealerGood, "classId" | "state"> | undefined {
  const classId = classes.classes.get(cell & 0xff)?.id;
  const state = classId === PACKAGE_CLASS ? classes.classes.get(cell >> 8)?.id : (cell >> 8) & 0xff;
  return classId === undefined || classId === 0 || state === undefined
    ? undefined
    : { classId, state };
}

/**
 * Why the dealer cannot be given to an episode whose table holds `capacity` goods; with
 * the episode's classes also goods it has no tile for.
 */
export function dealerProblem(
  dealer: Dealer,
  capacity: number,
  classes?: EpisodeClasses,
): string | undefined {
  const { goods, most } = dealer;
  if (capacity === 0) return "the episode has no dealer";
  if (goods.length > capacity) return `the table holds at most ${capacity} goods`;
  if (goods.length < MIN_SHOWN) return `the dealer needs at least ${MIN_SHOWN} goods`;
  if (!Number.isInteger(most) || most < MIN_SHOWN || most > Math.min(MAX_SHOWN, goods.length)) {
    return `at most ${MIN_SHOWN}–${Math.min(MAX_SHOWN, goods.length)} shown, not ${most}`;
  }
  const byte = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xff;
  for (const [n, good] of goods.entries()) {
    const { classId, state, price } = good;
    if (!byte(classId) || !byte(state) || classId === 0) {
      return `good ${n + 1}: class ${classId}, state ${state} (bytes, class not 0)`;
    }
    if (classes && goodTile(good, classes) === undefined) {
      return `good ${n + 1}: the episode has no tile of class 0x${classId.toString(16)}`;
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
 * `dealer.most` at once. Throws a RangeError naming what does not fit (dealerProblem;
 * with `classes`, the episode's, also goods without a tile).
 */
export function withDealer(
  image: PeImage,
  episode: number,
  dealer: Dealer,
  classes?: EpisodeClasses,
): Uint8Array {
  const method = goodsMethod(image, episode);
  const capacity = dealerCapacity(image, episode);
  const problem = dealerProblem(dealer, capacity, classes);
  if (!method || problem) throw new RangeError(problem ?? "the episode has no dealer");
  return patchAt(image, method.va, CODE.length, (view, at) => {
    view.setUint32(at + COUNT_AT, dealer.goods.length, true);
    view.setUint32(at + MOST_AT, dealer.most, true);
    const tableAt = fileOffset(image, method.table, capacity * ENTRY_SIZE);
    for (const [n, { classId, state, price }] of dealer.goods.entries()) {
      view.setUint8(tableAt + n * ENTRY_SIZE, classId);
      view.setUint8(tableAt + n * ENTRY_SIZE + 1, state);
      view.setUint16(tableAt + n * ENTRY_SIZE + 2, price, true);
    }
  });
}

export function sameDealer(a: Dealer | undefined, b: Dealer | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.most === b.most &&
    a.goods.length === b.goods.length &&
    a.goods.every((g, n) => {
      const h = b.goods[n];
      return g.classId === h.classId && g.state === h.state && g.price === h.price;
    })
  );
}
