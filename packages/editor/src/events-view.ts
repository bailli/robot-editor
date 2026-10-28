import { EPISODES } from "@robot/formats";

import { button, element, select } from "./dom.ts";
import type { EventEntry, EventSource } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface EventsViewEvents {
  /** Makes `entry` a copy of `source`, or takes its change back (Editor.copyEvent). */
  copy(entry: number, source: EventSource | undefined): void;
}

/** An event of another episode that can be copied. */
export interface SourceEvent {
  entry: number;
  id: number;
  points: number;
  /** Its text (1800 + n), the first page; empty if it has none. */
  text: string;
}

/** What the view shows: the shown episode's changed entries and what it can copy. */
export interface EventsContext {
  episode: number;
  names: readonly string[];
  entries: readonly EventEntry[];
  /** The entries a copy can go to (Editor.eventTargets). */
  targets: readonly number[];
  /** The events of an episode that can be copied (Editor.sourceEvents). */
  sources: (episode: number) => readonly SourceEvent[];
}

/** The episodes in the form and the list, short. */
const SHORT_NAMES: readonly string[] = ["Junior", "I", "II", "III", "IV"];
const short = (episode: number) => SHORT_NAMES[episode] ?? String(episode);

const points = (n: number) => `${n} point${n === 1 ? "" : "s"}`;

/**
 * The Episode tab's events from other episodes (mod kinds events and copyTexts): the
 * event table entries the mod changes, each removable, and a form to copy an event of
 * another episode, with its points and text, to an entry the game never uses. Patched
 * in place (patchChildren); the form's choices stay while the episode does.
 */
export class EventsView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: EventsViewEvents;
  private context: EventsContext | undefined;
  /** The form's choices: source episode, source entry, target entry. */
  private choice: { episode: number; from: number; of: number; to: number } | undefined;

  /** Forgets the choices (a newly loaded exe or mod). */
  reset(): void {
    this.choice = undefined;
  }

  constructor(events: EventsViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Events");
  }

  show(context: EventsContext): void {
    this.context = context;
    patchChildren(this.element, this.render(context));
  }

  private render(context: EventsContext): Node[] {
    const { episode, names } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const list = element("ul", "dealer-goods");
    list.dataset["key"] = `entries ${episode}`;
    for (const e of context.entries) {
      const row = element("li", "dealer-good");
      row.dataset["key"] = String(e.entry);
      const source = e.text ? ` ← ${short(e.text.from)} ${e.text.of}` : "";
      const text = element(
        "span",
        "dealer-name",
        `${e.entry}${source}: event ${e.id}, ${points(e.points)}${e.sound ? `, ${e.sound}` : ""}`,
      );
      const sound = e.sound ? ` and sound ${e.sound}` : "";
      text.title = e.text
        ? `Entry ${e.entry} is entry ${e.text.of} of ${name(e.text.from)}: its event, points, text${sound}`
        : `The mod sets entry ${e.entry}: event ${e.id}, ${points(e.points)}${sound}`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      const remove = button("×", `Entry ${e.entry} as the exe has it again`, () => {
        this.events.copy(Number(row.dataset["key"]), undefined);
      });
      remove.classList.add("danger");
      row.append(text, remove);
      list.append(row);
    }
    const nodes: Node[] = [element("h3", undefined, "Events from other episodes")];
    if (context.entries.length > 0) nodes.push(list);
    else {
      const none = element("p", "hint", `${name(episode)} has no events of other episodes.`);
      none.dataset["key"] = "none";
      nodes.push(none);
    }
    nodes.push(...this.form(context));
    nodes.push(
      element(
        "p",
        "hint",
        "The game’s code raises events by number, each once per game (its points, its text in the bonus box): e.g. oracles 262–271, a lit circuit node 293. An episode whose table lacks the number gives nothing. A copy takes over an entry the game never uses (Junior and I: 190, IV: 197–200; II and III have none) with the event’s number, points and text, and its sound where this episode has that piece of music (else the entry’s own stays). Scripts award an entry with Enigma(n).",
      ),
    );
    return nodes;
  }

  /** The form: source episode and event, the entry it goes to, and the button. */
  private form(context: EventsContext): Node[] {
    const { episode } = context;
    const others = EPISODES.filter((e) => e !== episode);
    let choice = this.choice;
    if (choice?.episode !== episode) {
      const from = others[0] ?? 0;
      choice = { episode, from, of: context.sources(from)[0]?.entry ?? 0, to: -1 };
    }
    const sources = context.sources(choice.from);
    // a copied event is offered no more: the next one, to the next entry
    if (!sources.some((s) => s.entry === choice.of)) {
      choice.of = sources[0]?.entry ?? 0;
      choice.to = -1;
    }
    // the first entry no copy has, unless all have one
    if (!context.targets.includes(choice.to)) {
      const taken = new Set(context.entries.map((e) => e.entry));
      choice.to = context.targets.find((t) => !taken.has(t)) ?? context.targets.at(0) ?? -1;
    }
    this.choice = choice;
    const from = select(
      "From episode",
      others.map((e) => [String(e), short(e)]),
      String(choice.from),
    );
    const of = select(
      "Event",
      sources.map((s) => [
        String(s.entry),
        `${s.id}: ${points(s.points)}${s.text ? ` – ${s.text.slice(0, 40)}` : ""}`,
      ]),
      String(choice.of),
    );
    const to = select(
      "To entry",
      context.targets.map((t) => [
        String(t),
        `${t}${context.entries.some((e) => e.entry === t) ? " (replaces its copy)" : ""}`,
      ]),
      String(choice.to),
    );
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
        now.of = this.context?.sources(now.from)[0]?.entry ?? 0;
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
      "Make the chosen entry the event of the other episode, with its points and text",
      () => {
        const now = this.choice;
        if (now && now.to >= 0) this.events.copy(now.to, { from: now.from, of: now.of });
      },
    );
    add.disabled = context.targets.length === 0 || sources.length === 0;
    if (context.targets.length === 0) add.title = "The episode has no entry the game never uses";
    const rows: [string, Node[]][] = [
      ["from", [element("span", "record-label", "From"), from]],
      ["of", [element("span", "record-label", "Event"), of]],
      ["to", [element("span", "record-label", "To entry"), to]],
    ];
    const form = rows.map(([key, children]) => {
      const row = element("label", "record-row");
      row.dataset["key"] = key;
      row.append(...children);
      return row;
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "add";
    bar.append(add, element("span", "hint", `${context.targets.length} spare`));
    return [...form, bar];
  }
}
