import { EPISODES, EVENT_TEXT } from "@robot/formats";

import { button, element } from "./dom.ts";
import type { TextCopy, TextSource } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface TextsViewEvents {
  /** Makes entry `to` a copy of `source`, or takes its copy back (Editor.setTextCopies). */
  copy(to: number, source: TextSource | undefined): void;
}

/** What the view shows: the shown episode's text copies and the texts around them. */
export interface TextsContext {
  episode: number;
  names: readonly string[];
  copies: readonly TextCopy[];
  /** An entry of an episode's texts as loaded, on one line; undefined if it has none. */
  source: (episode: number, entry: number) => string | undefined;
  /** An entry of the shown episode's texts as edited, on one line. */
  current: (entry: number) => string | undefined;
}

function numberField(label: string, value: number): HTMLInputElement {
  const field = element("input", "record-field");
  field.type = "number";
  field.min = "0";
  field.max = String(EVENT_TEXT - 1);
  field.value = String(value);
  field.setAttribute("aria-label", label);
  return field;
}

/** The episodes in the form and the list, short. */
const SHORT_NAMES: readonly string[] = ["Junior", "I", "II", "III", "IV"];
const short = (episode: number) => SHORT_NAMES[episode] ?? String(episode);

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/**
 * The Episode tab's texts from other episodes (mod kind copyTexts, into the episode's
 * texts): the copies, each removable, and a form to copy an entry of another episode's
 * texts to an entry of this one's (the same number by default), e.g. an oracle's hints
 * and death message. Patched in place (patchChildren); the form's choices stay while the
 * episode does.
 */
export class TextsView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: TextsViewEvents;
  private context: TextsContext | undefined;
  /** The form's choices: source episode, source entry, target entry. */
  private choice: { episode: number; from: number; of: number; to: number } | undefined;

  /** Forgets the choices (a newly loaded exe or mod). */
  reset(): void {
    this.choice = undefined;
  }

  constructor(events: TextsViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Texts");
  }

  show(context: TextsContext): void {
    this.context = context;
    patchChildren(this.element, this.render(context));
  }

  private render(context: TextsContext): Node[] {
    const { episode, names } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const list = element("ul", "dealer-goods");
    list.dataset["key"] = `copies ${episode}`;
    for (const c of context.copies) {
      const row = element("li", "dealer-good");
      row.dataset["key"] = String(c.to);
      const text = context.source(c.from, c.of) ?? "";
      const line = element(
        "span",
        "dealer-name",
        `${c.to}${c.of === c.to ? ` ← ${short(c.from)}` : ` ← ${short(c.from)} ${c.of}`}: ${clip(text, 40)}`,
      );
      line.title = `Text ${c.to} is text ${c.of} of ${name(c.from)}: ${text}`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      const remove = button("×", `Text ${c.to} as the exe has it again`, () => {
        this.events.copy(Number(row.dataset["key"]), undefined);
      });
      remove.classList.add("danger");
      row.append(line, remove);
      list.append(row);
    }
    const nodes: Node[] = [element("h3", undefined, "Texts from other episodes")];
    if (context.copies.length > 0) nodes.push(list);
    else {
      const none = element("p", "hint", `${name(episode)} has no texts of other episodes.`);
      none.dataset["key"] = "none";
      nodes.push(none);
    }
    nodes.push(...this.form(context));
    nodes.push(
      element(
        "p",
        "hint",
        `Messages, hints and descriptions by number (entries below ${EVENT_TEXT}; event texts come with their events): e.g. an oracle’s hint 330 + n and its death message 945, which only II and III have. A tile type copy offers the texts its class shows (“Texts”). A text written in the editor wins over its copy.`,
      ),
    );
    return nodes;
  }

  /** The form: source episode and entry, the entry it goes to, and the button. */
  private form(context: TextsContext): Node[] {
    const { episode } = context;
    const others = EPISODES.filter((e) => e !== episode);
    let choice = this.choice;
    if (choice?.episode !== episode) {
      choice = { episode, from: others[0] ?? 0, of: 0, to: 0 };
      this.choice = choice;
    }
    const from = element("select", "record-field tile-type-field");
    from.setAttribute("aria-label", "From episode");
    for (const e of others) {
      const o = element("option", undefined, short(e));
      o.value = String(e);
      from.append(o);
    }
    from.value = String(choice.from);
    const of = numberField("Text", choice.of);
    const to = numberField("To text", choice.to);
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
      }),
    );
    // a new source entry goes to the same number
    of.addEventListener(
      "change",
      changed((now) => {
        const value = Number(of.value);
        if (Number.isInteger(value) && value >= 0) now.of = now.to = value;
      }),
    );
    to.addEventListener(
      "change",
      changed((now) => {
        const value = Number(to.value);
        if (Number.isInteger(value) && value >= 0 && value < EVENT_TEXT) now.to = value;
      }),
    );
    const text = context.source(choice.from, choice.of);
    const replaced = context.current(choice.to);
    const preview = element(
      "p",
      "hint",
      text === undefined
        ? `${context.names[choice.from] ?? ""} has no text ${choice.of}.`
        : `“${clip(text, 120)}”${replaced === undefined ? "" : ` replaces “${clip(replaced, 60)}”`}`,
    );
    preview.dataset["key"] = "preview";
    const add = button("Copy", "Make the chosen text a copy of the other episode's", () => {
      const now = this.choice;
      if (now) this.events.copy(now.to, { from: now.from, of: now.of });
    });
    add.disabled = text === undefined;
    const rows: [string, Node[]][] = [
      ["from", [element("span", "record-label", "From"), from]],
      ["of", [element("span", "record-label", "Text"), of]],
      ["to", [element("span", "record-label", "To text"), to]],
    ];
    const form = rows.map(([key, children]) => {
      const row = element("label", "record-row");
      row.dataset["key"] = key;
      row.append(...children);
      return row;
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "add";
    bar.append(add);
    return [...form, preview, bar];
  }
}
