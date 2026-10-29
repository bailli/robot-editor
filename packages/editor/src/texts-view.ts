import { EPISODES, EVENT_TEXT, displayText, textPieces } from "@robot/formats";

import { button, element } from "./dom.ts";
import type { TextCopy, TextEntryState, TextSource } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface TextsViewEvents {
  /** Makes entry `to` a copy of `source`, or takes its copy back (Editor.setTextCopies). */
  copy(to: number, source: TextSource | undefined): void;
  /**
   * Writes an entry of a text resource, or with `variants` undefined removes it
   * (Editor.setText); false when it was refused (the app says why).
   */
  write(resource: number, entry: number, variants: readonly string[] | undefined): boolean;
  /** The picture of a tile the game draws in a text (`@14`). */
  preview(value: number): Node;
}

/** A text resource of the episode the tab lists. */
export interface TextResource {
  id: number;
  label: string;
}

/** What the view shows: the shown episode's texts, its copies and the texts around them. */
export interface TextsContext {
  episode: number;
  names: readonly string[];
  /** The resources whose entries can be written, the episode's texts first. */
  resources: readonly TextResource[];
  /** A resource's entries as edited, with those removed here (Editor.textStates). */
  entries: (resource: number) => readonly TextEntryState[];
  /** What an entry is for, e.g. "Name of room 43". */
  role: (resource: number, entry: number) => string;
  /** Why an entry cannot be written so (Editor.textWriteProblem), undefined if it can. */
  problem: (
    resource: number,
    entry: number,
    variants: readonly string[] | undefined,
  ) => string | undefined;
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

/** A text on one line, as the game reads it. */
const line = (text: string | undefined) => displayText(text ?? "").replace(/\s+/g, " ");

/** An entry open for writing (see TextsView.open). */
interface OpenEntry {
  resource: number;
  entry: number;
  draft: string[];
  basis: readonly string[] | undefined;
}

/** The most entries listed at once; the search narrows them down. */
const MAX_LISTED = 200;

/** Whether a draft says what the entry says (trimmed, as written; nothing for none). */
function sameText(draft: readonly string[], variants: readonly string[] | undefined): boolean {
  const own = draft.map((v) => v.trim());
  if (!variants) return own.every((v) => v === "");
  return own.length === variants.length && own.every((v, i) => v === variants[i]);
}

/** Where an entry's text comes from, short, for the list. */
function mark(state: TextEntryState): string {
  if (state.written) {
    if (!state.variants) return "removed";
    return state.base ? "written" : "new";
  }
  return state.copy ? `← ${short(state.copy.from)} ${state.copy.of}` : "";
}

/**
 * The Texts tab: an episode's text entries (tile descriptions, messages, room names,
 * event texts, episode III's diary pages), searchable by number or words, each opened
 * to write its variants, to remove it or to take it back to the exe's; and the copies
 * of other episodes' texts (mod kind copyTexts) with a form to make one. Patched in
 * place (patchChildren): a draft stays while its entry is open, also across other edits.
 */
export class TextsView {
  readonly element = element("section", "start-view record-view tile-types-view texts-view");
  private readonly events: TextsViewEvents;
  private context: TextsContext | undefined;
  /** The resource listed and the search. */
  private resource: number | undefined;
  private search = "";
  /**
   * The entry open for writing, its draft (the variants as typed) and the variants the
   * draft started from: a draft not typed in follows the entry (undo, redo).
   */
  private open: OpenEntry | undefined;
  /** The copy form's choices: source episode, source entry, target entry. */
  private choice: { episode: number; from: number; of: number; to: number } | undefined;

  constructor(events: TextsViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Texts");
  }

  /** Forgets the choices, the search and the open entry (a newly loaded exe or mod). */
  reset(): void {
    this.choice = undefined;
    this.resource = undefined;
    this.search = "";
    this.open = undefined;
  }

  /** Whether an entry is open (else the list is shown). */
  get isOpen(): boolean {
    return this.open !== undefined;
  }

  /** Whether an entry is open with a draft that differs from it. */
  get drafting(): boolean {
    const open = this.open;
    return open !== undefined && !sameText(open.draft, this.state(open)?.variants);
  }

  /** Opens entry `entry` of resource `resource` (one of the shown episode's). */
  openEntry(resource: number, entry: number): void {
    const variants = this.context ? this.state({ resource, entry })?.variants : undefined;
    this.open = { resource, entry, draft: variants ? [...variants] : [""], basis: variants };
    this.resource = resource;
    this.refresh();
  }

  /** Back to the list, the draft dropped. */
  close(): void {
    this.open = undefined;
    this.refresh();
  }

  show(context: TextsContext): void {
    if (this.context?.episode !== context.episode) {
      this.open = undefined;
      this.resource = undefined;
    }
    this.context = context;
    if (!context.resources.some((r) => r.id === this.resource))
      this.resource = context.resources[0]?.id;
    const open = this.open;
    if (open) {
      const variants = this.state(open)?.variants;
      if (sameText(open.draft, open.basis) && !sameText(open.basis ?? [], variants))
        this.restart(open);
    }
    patchChildren(
      this.element,
      this.open ? this.entryEditor(context, this.open) : this.render(context),
    );
  }

  private refresh(): void {
    if (this.context) this.show(this.context);
  }

  private state(at: { resource: number; entry: number }): TextEntryState | undefined {
    return this.context?.entries(at.resource).find((s) => s.entry === at.entry);
  }

  /** The list of entries, then the copies of other episodes' texts. */
  private render(context: TextsContext): Node[] {
    const resource = this.resource;
    const nodes: Node[] = [element("h3", undefined, "Texts")];
    if (context.resources.length > 1) {
      const which = element("select", "record-field tile-type-field");
      which.setAttribute("aria-label", "Resource");
      for (const r of context.resources) which.append(new Option(r.label, String(r.id)));
      which.value = String(resource);
      which.addEventListener("change", () => {
        this.resource = Number(which.value);
        this.refresh();
      });
      nodes.push(labelled("resource", "Resource", which));
    }
    const find = element("input", "record-field text-search");
    find.type = "search";
    find.placeholder = "Number or words";
    find.setAttribute("aria-label", "Find text");
    find.value = this.search;
    find.addEventListener("input", () => {
      this.search = find.value;
      this.refresh();
    });
    nodes.push(labelled("find", "Find", find));
    if (resource !== undefined) nodes.push(...this.list(context, resource));
    nodes.push(...this.copiesSection(context));
    return nodes;
  }

  /** The entries matching the search, and a way to write a new one by number. */
  private list(context: TextsContext, resource: number): Node[] {
    const query = this.search.trim();
    const number = /^\d+$/.test(query) ? Number(query) : undefined;
    const words = query.toLowerCase();
    const states = context.entries(resource);
    const matching = states.filter((s) => {
      if (number !== undefined) return String(s.entry).startsWith(query);
      if (!words) return true;
      const text = (s.variants ?? s.base ?? []).map((v) => line(v)).join(" ");
      return `${text} ${context.role(resource, s.entry)}`.toLowerCase().includes(words);
    });
    const list = element("ul", "text-list");
    list.dataset["key"] = `list ${context.episode} ${resource}`;
    for (const s of matching.slice(0, MAX_LISTED)) {
      const row = element("li", "text-row");
      row.dataset["key"] = String(s.entry);
      const text = line((s.variants ?? s.base)?.[0]);
      const open = element("button", "text-entry");
      open.type = "button";
      const marked = mark(s);
      open.append(
        element("span", "text-number", String(s.entry)),
        element("span", "text-line", text),
      );
      if (marked)
        open.append(element("span", s.written ? "text-mark edited" : "text-mark", marked));
      open.title = `Text ${s.entry}: ${context.role(resource, s.entry)}${marked ? ` (${marked})` : ""}\n${text}`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      open.addEventListener("click", () => {
        this.openEntry(resource, Number(row.dataset["key"]));
      });
      row.append(open);
      list.append(row);
    }
    const nodes: Node[] = [list];
    const more = matching.length - MAX_LISTED;
    if (more > 0) nodes.push(note("more", `${more} more: narrow the search.`));
    if (matching.length === 0) nodes.push(note("none", "No text matches."));
    if (number !== undefined && !states.some((s) => s.entry === number)) {
      const problem = context.problem(resource, number, ["x"]);
      const bar = element("div", "start-bar");
      // keyed by what it opens: a kept button keeps its listener
      bar.dataset["key"] = `new ${resource} ${number}`;
      const add = button(`Write text ${number}`, "A new entry with this number", () => {
        this.openEntry(resource, number);
      });
      add.disabled = problem !== undefined;
      bar.append(add);
      nodes.push(bar);
      if (problem) nodes.push(note("new problem", `Text ${number}: ${problem}.`));
    }
    nodes.push(
      note(
        "list hint",
        "Search by number or words; a number no entry has yet can be written. Edited entries are marked: written, new, removed; ← a copy of another episode’s.",
      ),
    );
    return nodes;
  }

  /** An open entry: its variants to write, where it comes from, and the actions. */
  private entryEditor(context: TextsContext, open: OpenEntry): Node[] {
    const { resource, entry, draft } = open;
    const state = this.state(open);
    const role = context.role(resource, entry);
    const back = button("← All texts", "Back to the list (the draft is dropped)", () => {
      this.close();
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "back";
    bar.append(back);
    const nodes: Node[] = [bar, element("h3", undefined, `Text ${entry}`), note("role", role)];
    nodes.push(note("origin", origin(state, context.names)));

    const dirty = !sameText(draft, state?.variants);
    draft.forEach((variant, i) => {
      const field = element("textarea", "record-field text-variant");
      field.rows = Math.min(10, Math.max(3, variant.split("\n").length + 1));
      field.spellcheck = false;
      field.value = variant;
      field.setAttribute("aria-label", draft.length > 1 ? `Variant ${i + 1}` : "Text");
      field.dataset["key"] = `variant ${i}`;
      field.addEventListener("input", () => {
        const now = this.open;
        if (!now) return;
        now.draft[i] = field.value;
        this.refresh();
      });
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          this.apply();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          if (this.drafting) this.revert();
          else this.close();
        }
      });
      const head = element("div", "text-variant-head");
      head.dataset["key"] = `head ${i}`;
      if (draft.length > 1) {
        head.append(element("span", "record-label", `Variant ${i + 1}`));
        const remove = button("×", `Remove variant ${i + 1}`, () => {
          this.open?.draft.splice(i, 1);
          this.refresh();
        });
        remove.classList.add("danger");
        remove.setAttribute("aria-label", `Remove variant ${i + 1}`);
        head.append(remove);
        nodes.push(head);
      }
      nodes.push(field, this.preview(variant, i));
    });
    const add = button("Add variant", "Another text the game picks from", () => {
      this.open?.draft.push("");
      this.refresh();
    });
    const addBar = element("div", "start-bar");
    addBar.dataset["key"] = "add variant";
    addBar.append(add);
    nodes.push(addBar);

    const problem = dirty ? context.problem(resource, entry, draft) : undefined;
    if (problem) {
      const shown = note("problem", `Cannot write it: ${problem}.`);
      shown.classList.add("error");
      nodes.push(shown);
    }
    const actions = element("div", "start-bar");
    actions.dataset["key"] = "actions";
    const cancel = button("Cancel", "Drop the changes typed (Escape)", () => {
      this.revert();
    });
    cancel.disabled = !dirty;
    const buttons = [cancel];
    if (state?.written && state.base) {
      buttons.push(
        button("Original", "The text as the exe has it (with the mod's copies)", () => {
          const now = this.open && this.state(this.open);
          if (now?.base) this.write(now.base);
        }),
      );
    }
    if (state?.variants) {
      const remove = button("Remove", "Take the entry out of the texts", () => {
        this.write(undefined);
      });
      remove.classList.add("danger");
      buttons.push(remove);
    }
    const apply = button("Apply", "Write the text (Ctrl+Enter)", () => {
      this.apply();
    });
    apply.classList.add("primary");
    apply.disabled = !dirty || problem !== undefined;
    buttons.push(apply);
    // kept by their text only: each keeps its own listener (patchChildren)
    for (const b of buttons) b.dataset["key"] = b.textContent;
    actions.append(...buttons);
    nodes.push(actions);
    nodes.push(
      note(
        "format",
        "As the game stores it: a line break reads as a space, “\\” at the end of a line breaks it in the box, “_” is a hard space, “²” and a character a colour, “@” and hex digits a tile (“@14”), “@@” an “@”. “|” and “;” cannot be used. Lines longer than 254 characters are wrapped.",
      ),
    );
    return nodes;
  }

  /** How a variant reads in the game, its tiles drawn. */
  private preview(variant: string, i: number): HTMLElement {
    const shown = element("p", "hint text-preview");
    shown.dataset["key"] = `preview ${i}`;
    for (const piece of textPieces(line(variant))) {
      if (piece.kind === "text") shown.append(piece.text);
      else {
        const tile = this.events.preview(piece.value);
        if (tile instanceof HTMLElement) tile.classList.add("text-tile");
        shown.append(tile);
      }
    }
    return shown;
  }

  /** Writes the draft. */
  private apply(): void {
    const open = this.open;
    if (!open || !this.drafting) return;
    this.write(open.draft);
  }

  /** Writes the open entry: variants, or undefined to remove it. */
  private write(variants: readonly string[] | undefined): void {
    const open = this.open;
    if (!open) return;
    if (!this.events.write(open.resource, open.entry, variants)) return;
    // the draft starts again from the entry as written (trimmed, wrapped)
    this.restart(open);
    this.refresh();
  }

  /** The draft back to the entry as it is. */
  private revert(): void {
    const open = this.open;
    if (!open) return;
    this.restart(open);
    this.refresh();
  }

  /** Starts the draft of the open entry again from the entry as it is now. */
  private restart(open: OpenEntry): void {
    const variants = this.state(open)?.variants;
    open.draft = variants ? [...variants] : [""];
    open.basis = variants;
  }

  /** The copies of other episodes' texts, and the form to make one. */
  private copiesSection(context: TextsContext): Node[] {
    const { episode, names } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const written = new Set(
      context
        .entries(context.resources[0]?.id ?? -1)
        .filter((s) => s.written)
        .map((s) => s.entry),
    );
    const list = element("ul", "dealer-goods");
    list.dataset["key"] = `copies ${episode}`;
    for (const c of context.copies) {
      const row = element("li", "dealer-good");
      row.dataset["key"] = String(c.to);
      const text = context.source(c.from, c.of) ?? "";
      const over = written.has(c.to) ? " (written here)" : "";
      const shown = element(
        "span",
        "dealer-name",
        `${c.to}${c.of === c.to ? ` ← ${short(c.from)}` : ` ← ${short(c.from)} ${c.of}`}${over}: ${clip(text, 40)}`,
      );
      shown.title = `Text ${c.to} is text ${c.of} of ${name(c.from)}${over ? "; the text written here wins" : ""}: ${text}`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      const remove = button("×", `Text ${c.to} as the exe has it again`, () => {
        this.events.copy(Number(row.dataset["key"]), undefined);
      });
      remove.classList.add("danger");
      row.append(shown, remove);
      list.append(row);
    }
    const nodes: Node[] = [element("h3", undefined, "Texts from other episodes")];
    if (context.copies.length > 0) nodes.push(list);
    else nodes.push(note("none copied", `${name(episode)} has no texts of other episodes.`));
    nodes.push(...this.form(context));
    nodes.push(
      note(
        "copies hint",
        `Messages, hints and descriptions by number (entries below ${EVENT_TEXT}; event texts come with their events): e.g. an oracle’s hint 330 + n and its death message 945, which only II and III have. A tile type copy offers the texts its class shows (“Texts”). An entry written here takes no copy; written over a copy, the written text wins.`,
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
      if (!now) return;
      edit(now);
      this.refresh();
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
    const preview = note(
      "preview",
      text === undefined
        ? `${context.names[choice.from] ?? ""} has no text ${choice.of}.`
        : `“${clip(text, 120)}”${replaced === undefined ? "" : ` replaces “${clip(replaced, 60)}”`}`,
    );
    const add = button("Copy", "Make the chosen text a copy of the other episode's", () => {
      const now = this.choice;
      if (now) this.events.copy(now.to, { from: now.from, of: now.of });
    });
    add.disabled = text === undefined;
    const form = [
      labelled("from", "From", from),
      labelled("of", "Text", of),
      labelled("to", "To text", to),
    ];
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "copy";
    bar.append(add);
    return [...form, preview, bar];
  }
}

/** Where an entry's text comes from, in words. */
function origin(state: TextEntryState | undefined, names: readonly string[]): string {
  const copy = state?.copy && `text ${state.copy.of} of ${names[state.copy.from] ?? ""}`;
  if (!state) return "A new entry: the exe has no such text.";
  if (!state.written) return copy ? `A copy of ${copy}.` : "As the exe has it.";
  if (!state.variants) return "Removed here; “Original” brings it back.";
  if (!state.base) return "New here: the exe has no such text.";
  return copy ? `Written here over the copy of ${copy}.` : "Written here; “Original” is the exe’s.";
}

function labelled(key: string, text: string, control: HTMLElement): HTMLElement {
  const row = element("label", "record-row");
  row.dataset["key"] = key;
  row.append(element("span", "record-label", text), control);
  return row;
}

function note(key: string, text: string): HTMLElement {
  const p = element("p", "hint", text);
  p.dataset["key"] = key;
  return p;
}
