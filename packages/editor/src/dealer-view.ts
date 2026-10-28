import {
  type Dealer,
  type DealerGood,
  MAX_PRICE,
  MAX_SHOWN,
  MIN_SHOWN,
  sameDealer,
} from "@robot/formats";

import { button, element } from "./dom.ts";
import { hex } from "./format.ts";
import { patchChildren } from "./patch.ts";

export interface DealerViewEvents {
  /** The user changed the goods or the most shown (Editor.setDealer). */
  change(dealer: Dealer): void;
  /** A canvas showing a cell value. */
  preview(value: number): HTMLCanvasElement;
  /** A short name for a cell value (an unnamed one: what the game says about it). */
  name(value: number): string;
  /** The tile the editor paints with. */
  tile(): number;
  /** Makes a cell value the tile the editor paints with. */
  useTile(value: number): void;
  /** The cell the game makes of a good (goodTile), undefined if the episode has none. */
  goodTile(good: Pick<DealerGood, "classId" | "state">): number | undefined;
  /** What a cell is sold as (cellGood): its class and state, undefined if it has no class. */
  cellGood(cell: number): Pick<DealerGood, "classId" | "state"> | undefined;
  /** Says why something cannot be done (e.g. selling a tile without a class). */
  refuse(message: string): void;
  go(room: number): void;
}

/** What the view shows of the episode's dealer. */
export interface DealerContext {
  episode: string;
  /** undefined: the episode has no dealer. */
  dealer: Dealer | undefined;
  /** The goods as the exe (or the opened mod's base) has them. */
  original: Dealer | undefined;
  /** How many goods the table holds. */
  capacity: number;
  /** Rooms with a dealer record (a travelling actor that is the dealer). */
  rooms: readonly number[];
}

/**
 * The Episode tab's dealer: the goods every dealer of the episode sells, their prices and
 * how many he offers at once. Each change is one undo step; the view is patched in place
 * (patchChildren), so focus stays and Tab goes on to the next price.
 */
export class DealerView {
  readonly element = element("section", "dealer-view record-view");
  private readonly events: DealerViewEvents;
  private context: DealerContext | undefined;

  constructor(events: DealerViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Dealer");
  }

  show(context: DealerContext): void {
    this.context = context;
    patchChildren(this.element, this.render(context));
  }

  private get dealer(): Dealer | undefined {
    return this.context?.dealer;
  }

  /** Sends the goods changed by `edit` (a copy) and the most shown, kept within bounds. */
  private change(edit: (goods: DealerGood[]) => void, most = this.dealer?.most): void {
    const dealer = this.dealer;
    if (!dealer || most === undefined) return;
    const goods = dealer.goods.map((g) => ({ ...g }));
    edit(goods);
    const bound = Math.min(MAX_SHOWN, goods.length);
    this.events.change({ goods, most: Math.max(MIN_SHOWN, Math.min(most, bound)) });
  }

  private render(context: DealerContext): Node[] {
    const heading = element("h3", undefined, "Dealer");
    const { dealer, capacity } = context;
    if (!dealer) {
      return [
        heading,
        element(
          "p",
          "hint",
          `${context.episode} has no dealer: its goods method hands out no table (the base method 0x40be40), so a dealer record shows no one there.`,
        ),
      ];
    }
    const nodes: Node[] = [
      heading,
      element(
        "p",
        "hint",
        `Every dealer of ${context.episode} sells from this list at these prices. Each time one appears he offers ${MIN_SHOWN} to “shown at most” of them, picked at random, whatever the hero owns.`,
      ),
      this.roomsLine(context.rooms),
    ];
    const most = element("input", "record-field");
    most.type = "number";
    most.min = String(MIN_SHOWN);
    most.max = String(Math.min(MAX_SHOWN, dealer.goods.length));
    most.value = String(dealer.most);
    most.setAttribute("aria-label", "Shown at most");
    most.addEventListener("change", () => {
      const value = Number(most.value);
      if (Number.isInteger(value)) this.change(() => undefined, value);
      else most.value = String(this.dealer?.most ?? "");
    });
    const mostRow = element("label", "record-row");
    mostRow.dataset["key"] = "most";
    mostRow.title = `How many goods he offers at most (${MIN_SHOWN}–${MAX_SHOWN}, no more than there are goods; the originals show 8, episode I 10)`;
    mostRow.append(element("span", "record-label", "Shown at most"), most);
    nodes.push(mostRow);

    const list = element("ol", "dealer-goods");
    list.dataset["key"] = "goods";
    list.append(...dealer.goods.map((good, n) => this.goodRow(good, n, dealer.goods.length)));
    nodes.push(list);

    const full = dealer.goods.length >= capacity;
    const add = button(
      "Add the current tile",
      full
        ? `The table holds ${capacity} goods: other data follows it in the exe. Replace one instead (click its picture).`
        : "Add the tile the editor paints with, for 10 gold",
      () => {
        const good = this.currentGood();
        if (good) this.change((goods) => goods.push({ ...good, price: 10 }));
      },
    );
    add.disabled = full;
    const reset = button("Original goods", "The goods, prices and number shown of the exe", () => {
      const original = this.context?.original;
      if (original) this.events.change(original);
    });
    reset.disabled = context.original === undefined || sameDealer(dealer, context.original);
    const bar = element("div", "dealer-bar");
    bar.dataset["key"] = "bar";
    bar.append(add, element("span", "hint", `${dealer.goods.length} of ${capacity}`), reset);
    nodes.push(bar);
    nodes.push(
      element(
        "p",
        "hint",
        `Click a picture to sell the current tile instead, right-click to paint with it. At least ${MIN_SHOWN} goods; whether the hero can carry a tile is not checked (what the inventory does not take lands on the dealer's cell).`,
      ),
    );
    return nodes;
  }

  private roomsLine(rooms: readonly number[]): HTMLElement {
    const line = element("p", "hint dealer-rooms");
    line.dataset["key"] = "rooms";
    if (rooms.length === 0) {
      line.textContent =
        "No room has a dealer: a travelling actor record (type 8) with actor 0x83 brings one.";
      return line;
    }
    line.append(rooms.length === 1 ? "A dealer appears in room " : "Dealers appear in rooms ");
    rooms.forEach((room, i) => {
      if (i > 0) line.append(", ");
      // read when clicked: a kept button keeps its listener (patchChildren)
      const link = button(String(room), `Go to room ${room}`, () => {
        this.events.go(Number(link.textContent));
      });
      link.className = "link";
      line.append(link);
    });
    line.append(".");
    return line;
  }

  /** The current tile as a good; refused (undefined) if it has no class. */
  private currentGood(): Pick<DealerGood, "classId" | "state"> | undefined {
    const tile = this.events.tile();
    const good = this.events.cellGood(tile);
    if (!good) this.events.refuse(`The tile ${hex(tile)} has no class: the dealer cannot sell it`);
    return good;
  }

  private goodRow(good: DealerGood, n: number, count: number): HTMLElement {
    const row = element("li", "dealer-good");
    row.dataset["key"] = String(n);
    // read when used: a kept row keeps its listeners (patchChildren)
    const index = () => Number(row.dataset["key"]);
    const edit = (fields: Partial<DealerGood>) => {
      this.change((goods) => {
        const i = index();
        if (i < goods.length) goods[i] = { ...goods[i], ...fields };
      });
    };
    // the tile the game makes of it: class 0x25 is the TONIC, tile 0x33 in episode I
    const tile = this.events.goodTile(good);
    const what = `class 0x${good.classId.toString(16)}, state ${good.state}`;
    const preview = this.events.preview(tile ?? 0);
    preview.classList.add("pickable");
    preview.title += `\n(${what})\nClick: sell the current tile instead · Right-click: paint with this one`;
    preview.addEventListener("click", () => {
      const current = this.currentGood();
      if (current) edit(current);
    });
    preview.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const at = this.dealer?.goods[index()];
      const cell = at && this.events.goodTile(at);
      if (cell !== undefined) this.events.useTile(cell);
    });
    const name = element(
      "span",
      "dealer-name",
      tile === undefined ? `no tile of ${what}` : this.events.name(tile),
    );
    name.title = tile === undefined ? what : `${hex(tile)}: ${name.textContent} (${what})`;
    const price = element("input", "record-field dealer-price");
    price.type = "number";
    price.min = "0";
    price.max = String(MAX_PRICE);
    price.value = String(good.price);
    price.setAttribute("aria-label", `Price of good ${n + 1}`);
    price.title = "Price in gold";
    price.addEventListener("change", () => {
      const value = Number(price.value);
      if (Number.isInteger(value) && value >= 0 && value <= MAX_PRICE) {
        edit({ price: value });
      } else price.value = String(this.dealer?.goods[index()]?.price ?? "");
    });
    const move = (by: number) => () => {
      this.change((goods) => {
        const i = index();
        goods.splice(i + by, 0, ...goods.splice(i, 1));
      });
    };
    const up = button("↑", "Move up (the order matters only for the list here)", move(-1));
    up.disabled = n === 0;
    const down = button("↓", "Move down", move(1));
    down.disabled = n === count - 1;
    const remove = button("×", "Stop selling it", () => {
      this.change((goods) => goods.splice(index(), 1));
    });
    remove.classList.add("danger");
    remove.disabled = count <= MIN_SHOWN;
    if (remove.disabled) remove.title = `The dealer needs at least ${MIN_SHOWN} goods`;
    row.append(preview, name, price, up, down, remove);
    return row;
  }
}
