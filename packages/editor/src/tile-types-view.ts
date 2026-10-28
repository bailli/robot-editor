import { EPISODES } from "@robot/formats";

import type { TileTypeCopy } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface TileTypesViewEvents {
  /** Makes `to` a copy of `of` from episode `from`, or removes it (Editor.setTileType). */
  copy(to: number, source: { from: number; of: number } | undefined): void;
  /** Copies texts of the copy's source episode its class shows (Editor.setTextCopies). */
  copyTexts(copy: TileTypeCopy, entries: readonly number[]): void;
  /** A canvas showing tile type `type` of episode `episode` (state 0), in its palette. */
  preview(episode: number, type: number): HTMLCanvasElement;
}

/** A type of another episode that can be copied. */
export interface SourceType {
  type: number;
  name: string;
}

/** What the view shows: the shown episode's copies and what it can copy. */
export interface TileTypesContext {
  episode: number;
  names: readonly string[];
  copies: readonly TileTypeCopy[];
  /** The types a copy can go to (Editor.freeTileTypes). */
  free: readonly number[];
  /** The types of an episode that can be copied, with their names. */
  sources: (episode: number) => readonly SourceType[];
  /** The texts a copy's class shows that the episode lacks (Editor.classTextsToCopy). */
  classTexts: (copy: TileTypeCopy) => readonly number[];
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, title: string, click: () => void): HTMLButtonElement {
  const b = element("button", undefined, text);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", click);
  return b;
}

function select(label: string, options: readonly [string, string][], value: string) {
  const s = element("select", "record-field tile-type-field");
  s.setAttribute("aria-label", label);
  for (const [v, text] of options) {
    const o = element("option", undefined, text);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  return s;
}

/** The episodes in the form and the list, short. */
const SHORT_NAMES: readonly string[] = ["Junior", "I", "II", "III", "IV"];
const short = (episode: number) => SHORT_NAMES[episode] ?? String(episode);

const hex = (type: number) => `0x${type.toString(16).padStart(2, "0")}`;

/**
 * The Episode tab's tile types from other episodes (mod kind tileTypes): the copies, each
 * removable, and a form to copy a type of another episode to a free type. Patched in
 * place (patchChildren); the form's choices stay while the episode does.
 */
export class TileTypesView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: TileTypesViewEvents;
  private context: TileTypesContext | undefined;
  /** The form's choices: source episode, source type, target type. */
  private choice: { episode: number; from: number; of: number; to: number } | undefined;

  constructor(events: TileTypesViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Tile types");
  }

  show(context: TileTypesContext): void {
    this.context = context;
    patchChildren(this.element, this.render(context));
  }

  private render(context: TileTypesContext): Node[] {
    const { episode, names } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const list = element("ul", "dealer-goods");
    list.dataset["key"] = `copies ${episode}`;
    for (const c of context.copies) {
      const row = element("li", "dealer-good");
      row.dataset["key"] = String(c.to);
      const source = context.sources(c.from).find((s) => s.type === c.of)?.name ?? "";
      const text = element(
        "span",
        "dealer-name",
        `${hex(c.to)} ← ${short(c.from)} ${hex(c.of)} ${source}`,
      );
      text.title = `Type ${hex(c.to)} is type ${hex(c.of)} of ${name(c.from)}: its class, shape, description, sound and first take`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      const remove = button("×", `Make type ${hex(c.to)} free again`, () => {
        this.events.copy(Number(row.dataset["key"]), undefined);
      });
      remove.classList.add("danger");
      row.append(this.events.preview(episode, c.to), text);
      const texts = context.classTexts(c);
      if (texts.length > 0) {
        row.append(
          button(
            "Texts",
            `Copy the texts its class shows from ${name(c.from)}: ${texts.join(", ")}`,
            () => {
              // the copy as shown now: a kept button keeps its listener
              const now = this.context;
              const copy = now?.copies.find((k) => k.to === Number(row.dataset["key"]));
              if (now && copy) this.events.copyTexts(copy, now.classTexts(copy));
            },
          ),
        );
      }
      row.append(remove);
      list.append(row);
    }
    const nodes: Node[] = [element("h3", undefined, "Tile types from other episodes")];
    if (context.copies.length > 0) nodes.push(list);
    else {
      const none = element("p", "hint", `${name(episode)} has no tile types of other episodes.`);
      none.dataset["key"] = "none";
      nodes.push(none);
    }
    nodes.push(...this.form(context));
    nodes.push(
      element(
        "p",
        "hint",
        "Copied: the class (what it does), the shape, the description, the sound and the first take with its points and text. Other texts the class shows (an oracle’s hints and death message) come with “Texts”. Not copied: English texts, code that checks the episode; the shape keeps its colour numbers, drawn in this episode’s palette. A type rooms use stays a copy.",
      ),
    );
    return nodes;
  }

  /** The form: source episode and type, the free type it goes to, and the button. */
  private form(context: TileTypesContext): Node[] {
    const { episode } = context;
    const others = EPISODES.filter((e) => e !== episode);
    let choice = this.choice;
    if (choice?.episode !== episode) {
      const from = others[0] ?? 0;
      choice = { episode, from, of: context.sources(from)[0]?.type ?? 0, to: -1 };
    }
    const sources = context.sources(choice.from);
    if (!sources.some((s) => s.type === choice.of)) choice.of = sources[0]?.type ?? 0;
    // the same number where it is free, else the first free one: not yet a copy, unless
    // all are
    if (!context.free.includes(choice.to)) {
      const copied = new Set(context.copies.map((c) => c.to));
      const unused = context.free.filter((t) => !copied.has(t));
      choice.to = unused.includes(choice.of)
        ? choice.of
        : (unused.at(0) ?? context.free.at(0) ?? -1);
    }
    this.choice = choice;
    const from = select(
      "From episode",
      others.map((e) => [String(e), short(e)]),
      String(choice.from),
    );
    const of = select(
      "Type",
      sources.map((s) => [String(s.type), `${hex(s.type)} ${s.name}`]),
      String(choice.of),
    );
    const to = select(
      "To type",
      context.free.map((t) => [
        String(t),
        `${hex(t)}${context.copies.some((c) => c.to === t) ? " (replaces its copy)" : ""}`,
      ]),
      String(choice.to),
    );
    // a new source gets the default target again (the same number where free)
    const changed = (edit: (now: NonNullable<typeof this.choice>) => void) => () => {
      const now = this.choice;
      const shown = this.context;
      if (!now || !shown) return;
      edit(now);
      this.show(shown);
    };
    from.addEventListener(
      "change",
      changed((now) => {
        now.from = Number(from.value);
        now.of = this.context?.sources(now.from)[0]?.type ?? 0;
        now.to = -1;
      }),
    );
    of.addEventListener(
      "change",
      changed((now) => {
        now.of = Number(of.value);
        now.to = -1;
      }),
    );
    to.addEventListener(
      "change",
      changed((now) => {
        now.to = Number(to.value);
      }),
    );
    const add = button(
      "Copy",
      "Make the chosen type a copy of the type of the other episode",
      () => {
        const now = this.choice;
        if (now && now.to >= 0) this.events.copy(now.to, { from: now.from, of: now.of });
      },
    );
    add.disabled = context.free.length === 0 || sources.length === 0;
    if (context.free.length === 0) add.title = "The episode has no free tile type";
    const preview = this.events.preview(choice.from, choice.of);
    const rows: [string, Node[]][] = [
      ["from", [element("span", "record-label", "From"), from]],
      ["of", [element("span", "record-label", "Type"), of, preview]],
      ["to", [element("span", "record-label", "To type"), to]],
    ];
    const form = rows.map(([key, children]) => {
      const row = element("label", "record-row");
      row.dataset["key"] = key;
      row.append(...children);
      return row;
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "add";
    bar.append(add, element("span", "hint", `${context.free.length} free`));
    return [...form, bar];
  }
}
