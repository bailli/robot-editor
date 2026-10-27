import {
  type EpisodeStart,
  MAX_RUCKSACK,
  ORACLE_VANISHES_EAST,
  ORACLE_VANISHES_NORTH,
} from "@robot/formats";

import { patchChildren } from "./patch.ts";

export interface EpisodeViewEvents {
  /** Start in the shown room, at the picked cell (else the start's cell; Editor.setStart). */
  here(): void;
  /** Back to the start the exe (or the opened mod's base) has. */
  reset(): void;
  go(room: number): void;
  /** A new capacity for the rucksack (Editor.setRucksack). */
  rucksack(capacity: number): void;
  /** New flags for the episode (Editor.setEpisodeFlags). */
  flags(flags: number): void;
}

/** What the view shows of the episode: its start, rucksack and flags. */
export interface EpisodeContext {
  episode: string;
  start: EpisodeStart;
  /** The start as the exe (or the opened mod's base) has it; likewise the others. */
  original: EpisodeStart;
  rucksack: number;
  originalRucksack: number;
  flags: number;
  originalFlags: number;
  /** The shown room. */
  room: number;
  /** "Go to room 43 – DER START" */
  label: (room: number) => string;
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

const cell = (start: EpisodeStart) => `(${start.x}, ${start.y})`;

/** The oracle flags the view offers, with their labels. */
const ORACLE_FLAGS = [
  [ORACLE_VANISHES_NORTH, "Vanish after sending the hero (north)"],
  [ORACLE_VANISHES_EAST, "Vanish after their hint (east)"],
] as const;

/**
 * The Episode tab's settings: the room the episode starts in and the hero's cell there
 * (set to the shown room and the picked cell), the rucksack's capacity and whether
 * oracles vanish. Patched in place (patchChildren), so focus stays.
 */
export class EpisodeView {
  readonly element = element("div", "episode-view");
  private readonly start = element("section", "start-view record-view");
  private readonly rucksack = element("section", "start-view record-view");
  private readonly oracles = element("section", "start-view record-view");
  private readonly events: EpisodeViewEvents;
  private context: EpisodeContext | undefined;

  constructor(events: EpisodeViewEvents) {
    this.events = events;
    this.start.setAttribute("aria-label", "Start");
    this.rucksack.setAttribute("aria-label", "Rucksack");
    this.oracles.setAttribute("aria-label", "Oracles");
    this.element.append(this.start, this.rucksack, this.oracles);
  }

  show(context: EpisodeContext): void {
    this.context = context;
    patchChildren(this.start, this.renderStart(context));
    patchChildren(this.rucksack, this.renderRucksack(context));
    patchChildren(this.oracles, this.renderOracles(context));
  }

  private renderStart(context: EpisodeContext): Node[] {
    const { start, original } = context;
    const edited = start.room !== original.room || start.x !== original.x || start.y !== original.y;
    const line = element("p", "start-line");
    line.dataset["key"] = "line";
    // read when clicked: a kept button keeps its listener (patchChildren)
    const link = button(String(start.room), context.label(start.room), () => {
      this.events.go(Number(link.textContent));
    });
    link.className = "link";
    line.append(
      `${context.episode} starts in room `,
      link,
      `, the hero at ${cell(start)}${edited ? " (edited)" : ""}.`,
    );
    const here = button(
      "Start here",
      `Start in the shown room ${context.room}, the hero at the cell picked with Select (one cell) or Inspect, else at ${cell(start)}`,
      () => {
        this.events.here();
      },
    );
    const reset = button(
      "Original start",
      `Room ${original.room}, the hero at ${cell(original)}, as the exe has it`,
      () => {
        this.events.reset();
      },
    );
    reset.disabled = !edited;
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "bar";
    bar.append(here, reset);
    return [
      element("h3", undefined, "Start"),
      line,
      bar,
      element(
        "p",
        "hint",
        "Where a new game of the episode begins (its start method). The room shows the cell with a green S; the start room cannot be deleted. “Test in game” starts in the shown room instead and leaves this as it is.",
      ),
    ];
  }

  private renderRucksack(context: EpisodeContext): Node[] {
    const field = element("input", "record-field");
    field.type = "number";
    field.min = "1";
    field.max = String(MAX_RUCKSACK);
    field.value = String(context.rucksack);
    field.setAttribute("aria-label", "Capacity");
    field.addEventListener("change", () => {
      const value = Number(field.value);
      if (Number.isInteger(value) && value >= 1 && value <= MAX_RUCKSACK) {
        this.events.rucksack(value);
      } else field.value = String(this.context?.rucksack ?? "");
    });
    const row = element("label", "record-row");
    row.dataset["key"] = "capacity";
    row.title = `1–${MAX_RUCKSACK}; the exe has ${context.originalRucksack}`;
    const edited = context.rucksack !== context.originalRucksack;
    row.append(element("span", "record-label", `Capacity${edited ? " (edited)" : ""}`), field);
    return [
      element("h3", undefined, "Rucksack"),
      row,
      element(
        "p",
        "hint",
        "As many slots, and the weight carried stays below it: an item is taken only while the weights plus its own are less, else it stays where it lies (“Zum Tragen ist das mindestens eins zu viel.”). Most items weigh 1, episode III’s up to 10 (tools 2, a ladder 3, chests 4, wood 5, a tree 10). The originals: Junior 38, I 50, II 60, III 200, IV 120.",
      ),
    ];
  }

  private renderOracles(context: EpisodeContext): Node[] {
    const rows = ORACLE_FLAGS.map(([flag, label]) => {
      const box = element("input");
      box.type = "checkbox";
      box.checked = (context.flags & flag) !== 0;
      box.addEventListener("change", () => {
        const flags = this.context?.flags;
        if (flags === undefined) return;
        this.events.flags(box.checked ? (flags | flag) >>> 0 : (flags & ~flag) >>> 0);
      });
      const row = element("label", "record-row");
      row.dataset["key"] = String(flag);
      const edited = ((context.flags ^ context.originalFlags) & flag) !== 0;
      row.append(box, element("span", undefined, `${label}${edited ? " (edited)" : ""}`));
      return row;
    });
    return [
      element("h3", undefined, "Oracles"),
      ...rows,
      element(
        "p",
        "hint",
        "Only episode II’s oracles vanish once used (episode flags 0x4000 and 0x8000). Oracles that stay can be used again and again, to be sent or hear the hint once more, before the hero turns one into its object (west).",
      ),
    ];
  }
}
