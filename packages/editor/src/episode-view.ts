import {
  type BackdropRule,
  DOORS_NEED_NO_KEY,
  type EpisodeStart,
  HOUSE_EDGES_BLOCK_INSIDE,
  MAX_RUCKSACK,
  ORACLE_VANISHES_EAST,
  ORACLE_VANISHES_NORTH,
  ROBOTS_KEEP_COLOURS,
  TELEPORT_POINT_CLEARED,
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
  /** Another backdrop rule (Editor.setBackdropRule). */
  backdrop(rule: BackdropRule): void;
  /** Diagonal moves on or off (Editor.setDiagonalMoves). */
  diagonal(diagonal: boolean): void;
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
  backdrop: BackdropRule;
  originalBackdrop: BackdropRule;
  diagonal: boolean;
  originalDiagonal: boolean;
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
/** A rule's checkbox: [now, as the exe has it]; `change` gets the new state. */
function ruleRow(
  key: string,
  label: string,
  title: string,
  [checked, original]: readonly [boolean, boolean],
  change: (on: boolean) => void,
): HTMLElement {
  const box = element("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => {
    change(box.checked);
  });
  const row = element("label", "record-row");
  row.dataset["key"] = key;
  row.title = title;
  row.append(box, element("span", undefined, `${label}${checked !== original ? " (edited)" : ""}`));
  return row;
}

/** The episode flags the view offers: the bit, its label and what it does. */
const FLAGS = [
  [
    ORACLE_VANISHES_NORTH,
    "Oracles vanish after sending the hero (north)",
    "Only episode II's do. Oracles that stay can send the hero again and again.",
  ],
  [
    ORACLE_VANISHES_EAST,
    "Oracles vanish after their hint (east)",
    "Only episode II's do. Oracles that stay give their hint again and again.",
  ],
  [
    DOORS_NEED_NO_KEY,
    "Doors into buildings open without the key",
    "Only episode III's do; elsewhere the hero needs the key (0x0f15) to go in.",
  ],
  [
    ROBOTS_KEEP_COLOURS,
    "Robots keep their sprite's colours",
    "Only episode III's do; elsewhere each robot gets three random colours.",
  ],
  [
    TELEPORT_POINT_CLEARED,
    "Teleport() points last only in their room",
    "All but episode III: entering a room sends teleporters a script redirected (Teleport(), record flag 0x02) to their own target again.",
  ],
  [
    HOUSE_EDGES_BLOCK_INSIDE,
    "House cells in states 9+ block from room 100 on",
    "Only episode III: there tile 0x53 in state 10 is the void around the caves. Without it the hero walks onto such cells, as he does below room 100.",
  ],
] as const;

/**
 * The Episode tab's settings: the room the episode starts in and the hero's cell there
 * (set to the shown room and the picked cell), the rucksack's capacity and the episode
 * flags (oracles that vanish, doors without the key, robots' colours). Patched in place
 * (patchChildren), so focus stays.
 */
export class EpisodeView {
  readonly element = element("div", "episode-view");
  private readonly start = element("section", "start-view record-view");
  private readonly rucksack = element("section", "start-view record-view");
  private readonly flags = element("section", "start-view record-view");
  private readonly events: EpisodeViewEvents;
  private context: EpisodeContext | undefined;

  constructor(events: EpisodeViewEvents) {
    this.events = events;
    this.start.setAttribute("aria-label", "Start");
    this.rucksack.setAttribute("aria-label", "Rucksack");
    this.flags.setAttribute("aria-label", "Flags");
    this.element.append(this.start, this.rucksack, this.flags);
  }

  show(context: EpisodeContext): void {
    this.context = context;
    patchChildren(this.start, this.renderStart(context));
    patchChildren(this.rucksack, this.renderRucksack(context));
    patchChildren(this.flags, this.renderFlags(context));
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

  private renderFlags(context: EpisodeContext): Node[] {
    const rows = FLAGS.map(([flag, label, title]) =>
      ruleRow(
        String(flag),
        label,
        `${title} (flag 0x${flag.toString(16)})`,
        [(context.flags & flag) !== 0, (context.originalFlags & flag) !== 0],
        (on) => {
          const flags = this.context?.flags;
          if (flags !== undefined)
            this.events.flags(on ? (flags | flag) >>> 0 : (flags & ~flag) >>> 0);
        },
      ),
    );
    const diagonal = ruleRow(
      "diagonal",
      "Diagonal moves",
      "Only episodes III and IV: Home, PgUp, End and PgDn move the hero diagonally (episode vtable +0x1c: 0x40be60, else 0x408d20)",
      [context.diagonal, context.originalDiagonal],
      (on) => {
        this.events.diagonal(on);
      },
    );
    const backdrop = ruleRow(
      "backdrop",
      "Backdrops show the room 100 below",
      "Only episode IV: a room with a backdrop (class 99 at (0, 1) or (39, 1)) shows room id − 100 in its class 99 cells, so a floor shows the one below (242 shows 142); else id mod 100, the town around every floor (242 shows 42)",
      [context.backdrop === "minus100", context.originalBackdrop === "minus100"],
      (on) => {
        this.events.backdrop(on ? "minus100" : "mod100");
      },
    );
    return [
      element("h3", undefined, "Rules"),
      diagonal,
      backdrop,
      ...rows,
      element(
        "p",
        "hint",
        "What the episode’s code sets (its constructor’s flags, the methods it points to; each box’s tooltip says more). Only III and IV walk diagonally, only IV’s backdrops show the room 100 below. Only II’s oracles vanish once used; oracles that stay can be used again and again, to be sent or hear the hint once more, before the hero turns one into its object (west). Only III’s doors open without the key, its robots keep their colours, its caves’ void blocks and its Teleport() points last beyond their room.",
      ),
    ];
  }
}
