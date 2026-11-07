import { EPISODES } from "@robot/formats";

import { button, element, select } from "./dom.ts";
import { type OwnType, type TileTypeCopy, ownTypeProblem, roomsOnly } from "./editor.ts";
import { hex2 } from "./format.ts";
import { patchChildren } from "./patch.ts";

export interface TileTypesViewEvents {
  /** Makes `to` a copy of `of` from episode `from`, or removes it (Editor.setTileType). */
  copy(to: number, source: { from: number; of: number } | undefined): void;
  /**
   * Replaces the type's cells in every room of the episode with `replacement` (0: empty),
   * one undo step (Editor.clearType).
   */
  clearType(type: number, replacement: number): void;
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
  /** The episode's own types and what holds on to them (Editor.ownTypes). */
  own: readonly OwnType[];
  /** The copies that replace one of the episode's own types (Editor.replacingCopies). */
  replacing: readonly number[];
  /** The name of one of the episode's own types, as in the exe as loaded. */
  ownName: (type: number) => string;
  /** The types of an episode that can be copied, with their names. */
  sources: (episode: number) => readonly SourceType[];
  /** The texts a copy's class shows that the episode lacks (Editor.classTextsToCopy). */
  classTexts: (copy: TileTypeCopy) => readonly number[];
}

/** The episodes in the form and the list, short. */
const SHORT_NAMES: readonly string[] = ["Junior", "I", "II", "III", "IV"];
const short = (episode: number) => SHORT_NAMES[episode] ?? String(episode);

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
  /** What cleared cells become (clearType), for the episode shown. */
  private replacement: { episode: number; value: number } | undefined;

  /** Forgets the choices (a newly loaded exe or mod). */
  reset(): void {
    this.choice = undefined;
    this.replacement = undefined;
  }

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
        `${hex2(c.to)} ← ${short(c.from)} ${hex2(c.of)} ${source}`,
      );
      const replaced = context.replacing.includes(c.to);
      text.title = `Type ${hex2(c.to)} is type ${hex2(c.of)} of ${name(c.from)}: its class, shape, description, sound and first take${replaced ? `; it replaces ${name(episode)}’s ${context.ownName(c.to)}` : ""}`;
      if (replaced) text.textContent += ` (replaces ${context.ownName(c.to)})`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      const undo = replaced
        ? `Give type ${hex2(c.to)} its own class back (${context.ownName(c.to)})`
        : `Make type ${hex2(c.to)} free again`;
      const remove = button("×", undo, () => {
        this.events.copy(Number(row.dataset["key"]), undefined);
      });
      remove.classList.add("danger");
      // keyed: "Texts" comes and goes before it, and a kept button keeps its listener
      remove.dataset["key"] = "remove";
      remove.setAttribute("aria-label", undo);
      row.append(this.events.preview(episode, c.to), text);
      const texts = context.classTexts(c);
      if (texts.length > 0) {
        const copyTexts = button(
          "Texts",
          `Copy the texts its class shows from ${name(c.from)}: ${texts.join(", ")}`,
          () => {
            // the copy as shown now: a kept button keeps its listener
            const now = this.context;
            const copy = now?.copies.find((k) => k.to === Number(row.dataset["key"]));
            if (now && copy) this.events.copyTexts(copy, now.classTexts(copy));
          },
        );
        copyTexts.dataset["key"] = "texts";
        row.append(copyTexts);
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
        "Copied: the class (what it does), the shape, the description, the sound (with its piece of music where this episode lacks it) the first take with its points and text, and what a state the class puts the hero in needs where this episode lacks it (its status-line icon, his frames for it: III’s axe, hammer and bridle). Other texts the class shows (an oracle’s hints and death message, the timber’s “enough wood”, the hammer’s “not in this direction”) come with “Texts” where this episode lacks them. Not copied: English texts, code that checks the episode; the shape keeps its colour numbers, drawn in this episode’s palette. A type rooms use stays a copy.",
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
    const replaceable = context.own.filter((t) => ownTypeProblem(t) === undefined);
    const chosenOwn = replaceable.find((t) => t.type === choice.to);
    if (!context.free.includes(choice.to) && !chosenOwn) {
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
      sources.map((s) => [String(s.type), `${hex2(s.type)} ${s.name}`]),
      String(choice.of),
    );
    const to = select(
      "To type",
      context.free.map((t) => [
        String(t),
        `${hex2(t)}${context.copies.some((c) => c.to === t) ? " (replaces its copy)" : ""}`,
      ]),
      String(choice.to),
    );
    // the episode's own types nothing holds on to: given up for the copy
    if (replaceable.length > 0) {
      const group = element("optgroup");
      group.label = "Replace one of this episode’s types";
      for (const t of replaceable) {
        const option = element(
          "option",
          undefined,
          `${hex2(t.type)} ${context.ownName(t.type)}${t.neededBy.length > 0 ? " ⚠" : ""}`,
        );
        option.value = String(t.type);
        group.append(option);
      }
      to.append(group);
    }
    if (choice.to < 0) {
      const none = element("option", undefined, "— choose a type to replace —");
      none.value = "-1";
      none.disabled = true;
      to.prepend(none);
    }
    to.value = String(choice.to);
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
    add.disabled = choice.to < 0 || sources.length === 0;
    if (choice.to < 0) add.title = "The episode has no free tile type and none to replace";
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
    bar.append(
      add,
      element("span", "hint", `${context.free.length} free, ${replaceable.length} to replace`),
    );
    const nodes: Node[] = [...form, bar];
    // the note's place is always there: the list after it keeps its element (and whether
    // it is open; patchChildren matches by position)
    if (chosenOwn) nodes.push(this.giveUpNote(context, chosenOwn));
    else {
      const none = element("div", "give-up");
      none.dataset["key"] = "give up";
      none.hidden = true;
      nodes.push(none);
    }
    nodes.push(this.heldTypes(context));
    return nodes;
  }

  /** What replacing one of the episode's own types means, and what needs it. */
  private giveUpNote(context: TileTypesContext, own: OwnType): HTMLElement {
    const episode = context.names[context.episode] ?? `episode ${context.episode}`;
    const note = element("div", "give-up");
    note.dataset["key"] = "give up";
    note.append(
      element(
        "p",
        "hint warning",
        `Gives up ${episode}’s ${context.ownName(own.type)} (${hex2(own.type)}, class ${own.classId}): it is gone from ${episode} for good while the copy stays; no room, record, script or dealer may use it again. Removing the copy brings it back.`,
      ),
    );
    if (own.neededBy.length > 0) {
      const list = element("ul", "give-up-needs");
      for (const n of own.neededBy) {
        list.append(
          element(
            "li",
            undefined,
            `${hex2(n.type)} ${context.ownName(n.type)} needs it (${n.how})${n.used ? ": rooms or scripts use it" : ""}`,
          ),
        );
      }
      note.append(element("p", "hint warning", "Classes of the episode that need it:"), list);
    }
    return note;
  }

  /**
   * The episode's own types only rooms hold on to (roomsOnly), folded, the cheapest
   * first (records last), each with a button that clears its cells out of all rooms (one undo step);
   * the others (scripts, the dealer, copies, the game's code) only counted.
   */
  private heldTypes(context: TileTypesContext): HTMLElement {
    const { episode } = context;
    const held = context.own.filter((t) => ownTypeProblem(t) !== undefined);
    const clearable = held.filter(roomsOnly).sort(
      (a, b) =>
        // records are changed by hand, packages need a replacement: those last
        Number(a.records.length > 0) - Number(b.records.length > 0) ||
        Number(a.packages.length > 0) - Number(b.packages.length > 0) ||
        a.cells - b.cells ||
        a.rooms.length - b.rooms.length ||
        a.type - b.type,
    );
    if (this.replacement?.episode !== episode) this.replacement = { episode, value: 0 };
    const replacement = this.replacement.value;
    const box = element("details", "held-types");
    box.dataset["key"] = `held ${episode}`;
    box.append(
      element(
        "summary",
        undefined,
        `${clearable.length} own types only rooms hold: clear one out of them to replace it`,
      ),
    );
    const others = held.length - clearable.length;
    box.append(
      element(
        "p",
        "hint",
        `Clearing replaces the type’s cells in every room (both layers, any state) in one undo step; records that show it stay, change those in their rooms. Packages that hold it get the type the cells become inside; while that is “empty” they keep it. Room 99 is the debug room, which the game never enters. ${others} other own types are held by scripts, the dealer, copies in other episodes or the game’s code and are left out.`,
      ),
    );
    const name = (t: number) => `${hex2(t)} ${context.ownName(t)}`;
    const into = select(
      "Cleared cells become",
      [["0", "empty"], ...context.own.map((t): [string, string] => [String(t.type), name(t.type)])],
      String(replacement),
    );
    into.addEventListener("change", () => {
      this.replacement = { episode, value: Number(into.value) };
      if (this.context) this.show(this.context);
    });
    const row = element("label", "record-row");
    row.dataset["key"] = "into";
    row.append(element("span", "record-label", "Cleared cells become"), into);
    box.append(row);
    const list = element("ul", "held-list");
    for (const t of clearable) {
      const item = element("li", "held-type");
      item.dataset["key"] = String(t.type);
      const rooms = t.cellRooms;
      const where =
        t.cells > 0
          ? `${t.cells} cell${t.cells === 1 ? "" : "s"} in ${rooms.length === 1 && rooms[0] === 99 ? "the debug room 99" : `room${rooms.length > 1 ? "s" : ""} ${rooms.join(", ")}`}`
          : "no cells";
      const text = element("span", "held-name", `${name(t.type)}: ${where}`);
      if (t.records.length > 0) text.textContent += `; records in ${t.records.join(", ")} show it`;
      if (t.packages.length > 0) {
        text.textContent += `; packages in ${t.packages.join(", ")} hold it`;
      }
      if (t.neededBy.length > 0) {
        text.textContent += ` ⚠ ${t.neededBy.map((n) => `${hex2(n.type)} needs it`).join(", ")}`;
      }
      const label = `Clear type ${hex2(t.type)} out of all rooms`;
      const clear = button(
        "Clear",
        `${label}: its cells become ${replacement === 0 ? "empty" : name(replacement)}`,
        () => {
          // read when clicked: a kept button keeps its listener (patchChildren)
          const now = this.replacement?.value ?? 0;
          this.events.clearType(Number(item.dataset["key"]), now);
        },
      );
      clear.dataset["key"] = "clear";
      clear.setAttribute("aria-label", label);
      clear.disabled =
        replacement === t.type || (t.cells === 0 && (replacement === 0 || t.packages.length === 0));
      item.append(this.events.preview(episode, t.type), text, clear);
      list.append(item);
    }
    box.append(list);
    return box;
  }
}
