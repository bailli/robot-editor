import { EVENT_TEXT, KITS, type Kit, type KitPlan } from "@robot/formats";

import { element } from "./dom.ts";
import { hex2 } from "./format.ts";
import { patchChildren } from "./patch.ts";

export interface KitsViewEvents {
  /**
   * Adds the kit to the shown episode, the events chosen, the episode's own types given
   * up for its copies (Editor.addKit).
   */
  add(kit: Kit, events: readonly number[] | undefined, replace: readonly number[]): void;
  /** Starts pasting the kit's example into the shown room (Editor.kitExample). */
  example(kit: Kit): void;
}

/** What the view shows: the kits' plans for the shown episode. */
export interface KitsContext {
  episode: number;
  names: readonly string[];
  /**
   * What adding the kit does now, with these events chosen and these own types given up
   * (Editor.kitPlan).
   */
  plan: (kit: Kit, events?: readonly number[], replace?: readonly number[]) => KitPlan;
  /** The episode's own types a copy may replace (Editor.ownTypes, no ownTypeProblem). */
  replaceable: readonly ReplaceableType[];
  /** Whether the episode has all the kit's types, so its example can be placed. */
  hasExample: (kit: Kit) => boolean;
}

/** One of the episode's own types a kit's copy may replace. */
export interface ReplaceableType {
  type: number;
  name: string;
  /** Other classes of the episode that need it (CLASS_NEEDS), as a note. */
  note: string;
}

/**
 * The Kits tab's kits (formats' KITS), each folded to its name and what adding it to the
 * shown episode would do; opened, per kit what it copies (tile types, texts, events,
 * music, flags) and what it cannot (events without an entry), with checkboxes for the
 * events where the spare entries do not hold them all, a choice of the episode's own types
 * to give up where its free types do not suffice (II has none), and "Add". Patched in place
 * (patchChildren); the events chosen stay while the episode does, the kits opened while
 * the editor runs.
 */
export class KitsView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: KitsViewEvents;
  private context: KitsContext | undefined;
  /** The events chosen per kit, for the episode shown. */
  private chosen = new Map<string, number[]>();
  /** The own types given up per kit, for the episode shown. */
  private replaced = new Map<string, number[]>();
  private chosenEpisode = -1;
  /** The kits shown opened. */
  private readonly opened = new Set<string>();

  constructor(events: KitsViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Kits");
  }

  /** Forgets the choices (a newly loaded exe or mod). */
  reset(): void {
    this.chosen.clear();
    this.replaced.clear();
    this.chosenEpisode = -1;
  }

  show(context: KitsContext): void {
    this.context = context;
    if (context.episode !== this.chosenEpisode) {
      this.chosen.clear();
      this.replaced.clear();
      this.chosenEpisode = context.episode;
    }
    patchChildren(this.element, this.render(context));
  }

  private render(context: KitsContext): Node[] {
    return [
      element("h3", undefined, "Kits"),
      ...KITS.map((kit) => this.renderKit(context, kit)),
      element(
        "p",
        "hint",
        "A kit copies what a feature of another episode needs in one undo step: its tile types (to free types), the episode flags it needs, the texts its classes show, the events its code raises (to entries the game never uses) and the pieces of music their sounds need. Kits share the spare entries (IV has four: oracles and circuits together). The parts show below, each removable on its own.",
      ),
    ];
  }

  private renderKit(context: KitsContext, kit: Kit): HTMLElement {
    const { episode, names } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const box = element("details", "kit");
    box.dataset["key"] = kit.key;
    if (this.opened.has(kit.key)) box.setAttribute("open", "");
    // a kept element keeps this listener: it reads the element, not the state it was built in
    box.addEventListener("toggle", () => {
      if (box.open) this.opened.add(kit.key);
      else this.opened.delete(kit.key);
    });
    // own types given up: those still replaceable
    const replace = (this.replaced.get(kit.key) ?? []).filter((t) =>
      context.replaceable.some((r) => r.type === t),
    );
    // the default plan holds as many events as fit: the most that can be chosen
    const fit = context.plan(kit, undefined, replace);
    // ids that are not lacking (any more) are dropped
    const chosen = this.chosen.get(kit.key)?.filter((id) => fit.lacking.includes(id));
    // kept as shown: Add sends what the view showed
    if (chosen) this.chosen.set(kit.key, chosen);
    if (this.replaced.has(kit.key)) this.replaced.set(kit.key, replace);
    const plan = chosen ? context.plan(kit, chosen, replace) : fit;
    const summary = element("summary");
    summary.append(
      element("span", "kit-name", `${kit.name} from ${name(kit.from)}`),
      element("span", "kit-summary", kitSummary(plan, kit)),
    );
    box.append(summary);
    const line = (key: string, text: string) => {
      const p = element("p", "kit-line", text);
      p.dataset["key"] = key;
      return p;
    };
    // what the feature does, shown, not only as the Add button's tooltip
    const note = element("p", "hint", kit.note);
    note.dataset["key"] = "note";
    box.append(note);
    const typeName = (of: number) => kit.types.find(([t]) => t === of)?.[1] ?? hex2(of);
    const label = (id: number) => (kit.eventLabel ? `${kit.eventLabel(id)} (${id})` : String(id));
    const own = plan.present.length === kit.types.length && plan.lacking.length === 0;
    const quiet =
      plan.moved.length + plan.silenced.length + plan.code.length + plan.textCopies.length;
    if (own && plan.texts.length === 0 && quiet === 0 && plan.flags === undefined) {
      box.append(line("own", `${name(episode)} has ${kit.name.toLowerCase()} already.`));
      box.append(this.exampleBar(context, kit));
      return box;
    }
    const replacedName = (to: number) => {
      const own = context.replaceable.find((r) => r.type === to && replace.includes(to));
      return own ? ` (replaces ${own.name})` : "";
    };
    const types = plan.types.map(([to, of]) => `${hex2(to)} ← ${typeName(of)}${replacedName(to)}`);
    const present = plan.present.map(typeName);
    box.append(
      line(
        "types",
        `Tile types: ${types.length > 0 ? types.join(", ") : "none to copy"}${present.length > 0 ? ` (has: ${present.join(", ")})` : ""}`,
      ),
    );
    const short = kit.types.length - plan.present.length - plan.types.length;
    const given = replace.filter((t) => plan.types.some(([to]) => to === t));
    if (short > 0 || given.length > 0) box.append(this.replacePicker(context, kit, given, short));
    if (plan.texts.length > 0) {
      // the kit's own texts (Kit.texts) say when the game shows them
      const own = plan.texts.filter((n) => kit.texts?.includes(n));
      const note = own.length > 0 && kit.textsNote ? ` (${own.join(", ")}: ${kit.textsNote})` : "";
      box.append(line("texts", `Texts: ${plan.texts.join(", ")}${note}`));
    }
    if (plan.flags !== undefined && kit.flags !== undefined) {
      box.append(
        line("flags", `Episode flags: sets 0x${kit.flags.toString(16)} (${kit.flagsNote ?? ""})`),
      );
    }
    // a text the code shows by number, moved to one no episode has (textMove)
    for (const c of plan.textCopies) {
      const into = c.resource === c.from ? "its own" : "this episode’s";
      const entries = c.entries.map(([to, of]) => `${to} ← ${of}`).join(", ");
      box.append(line(`copy ${c.resource}`, `Text ${entries} into ${into} ${c.resource}`));
    }
    for (const c of plan.code) {
      box.append(
        line(
          "code",
          `Code at 0x${c.va.toString(16)}: shows text ${new DataView(c.bytes.buffer).getUint32(0, true)} instead of ${new DataView(c.expect.buffer).getUint32(0, true)} (all episodes)`,
        ),
      );
    }
    // events whose bonus box would come first: moved off their text, or the text removed
    for (const m of plan.moved) {
      box.append(
        line(
          `moved ${m.id}`,
          `Event ${m.id} moves from entry ${m.from} to ${m.entry}, without the bonus box of text ${EVENT_TEXT + m.from}`,
        ),
      );
    }
    if (plan.silenced.length > 0) {
      const texts = plan.silenced.map((n) => EVENT_TEXT + n).join(", ");
      box.append(line("silenced", `Removes text ${texts} (a bonus box that would come first)`));
    }
    if (plan.music.length > 0) box.append(line("music", `Music: ${plan.music.join(", ")}`));
    // more events than spare entries: the player picks
    const picking = plan.lacking.length > fit.events.length && fit.events.length > 0;
    if (picking) {
      const picked = chosen ?? fit.events.map((e) => e.id);
      const boxes = element("div", "kit-events");
      boxes.dataset["key"] = "pick";
      boxes.append(
        element(
          "span",
          "record-label",
          `Events: ${fit.events.length} spare entries; those not ticked give no points`,
        ),
      );
      for (const id of plan.lacking) {
        const check = element("input");
        check.type = "checkbox";
        check.checked = picked.includes(id);
        check.disabled = !check.checked && picked.length >= fit.events.length;
        // the plan as shown now: a kept checkbox keeps its listener (patchChildren)
        check.addEventListener("change", () => {
          const shown = this.context;
          if (!shown) return;
          const now = shown.plan(kit);
          const current = this.chosen.get(kit.key) ?? now.events.map((e) => e.id);
          const next = check.checked ? [...current, id] : current.filter((k) => k !== id);
          this.chosen.set(
            kit.key,
            now.lacking.filter((k) => next.includes(k)),
          );
          this.show(shown);
        });
        const row = element("label", "kit-event");
        row.dataset["key"] = String(id);
        row.append(check, label(id));
        boxes.append(row);
      }
      box.append(boxes);
    } else if (plan.events.length > 0) {
      box.append(
        line(
          "events",
          `Events: ${plan.events.map((e) => `${label(e.id)} in entry ${e.entry}`).join(", ")}`,
        ),
      );
    }
    // with the picker the boxes not ticked are the events without points
    if (plan.without.length > 0 && !picking) {
      box.append(
        line("without", `Without points (no entry left): ${plan.without.map(label).join(", ")}`),
      );
    }
    const empty =
      plan.types.length +
        plan.texts.length +
        plan.events.length +
        quiet +
        (plan.flags === undefined ? 0 : 1) ===
      0;
    const add = element("button", undefined, `Add ${kit.name.toLowerCase()}`);
    add.type = "button";
    add.disabled = empty || plan.problem !== undefined;
    const why = plan.problem ?? (empty ? "Nothing left to add" : undefined);
    if (why !== undefined) add.title = why;
    add.addEventListener("click", () => {
      // the events not chosen stay lacking: the next plan starts from its default
      const events = this.chosen.get(kit.key);
      const replace = this.replaced.get(kit.key) ?? [];
      this.chosen.delete(kit.key);
      this.replaced.delete(kit.key);
      this.events.add(kit, events, replace);
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "add";
    bar.append(add);
    if (plan.problem) bar.append(element("span", "hint", plan.problem));
    box.append(bar, this.exampleBar(context, kit));
    return box;
  }

  /**
   * Where the episode's free types do not suffice: a choice per type still lacking of
   * one of its own types to give up (gone from the episode while the copy stays), and
   * the ones given up so far.
   */
  private replacePicker(
    context: KitsContext,
    kit: Kit,
    given: readonly number[],
    short: number,
  ): HTMLElement {
    const box = element("div", "kit-replace");
    box.dataset["key"] = "replace";
    const episode = context.names[context.episode] ?? `episode ${context.episode}`;
    box.append(
      element(
        "p",
        "hint warning",
        `${episode} has too few free tile types: give up types of its own for the copies. A type given up is gone from ${episode} for good while the copy stays; no room, record, script or dealer may use it again.`,
      ),
    );
    const slots = [...given, ...Array<number>(Math.max(0, short)).fill(-1)];
    slots.forEach((value, k) => {
      const choice = element("select", "record-field tile-type-field");
      choice.setAttribute("aria-label", `Own type to give up ${k + 1}`);
      const none = element("option", undefined, "— choose a type to give up —");
      none.value = "-1";
      choice.append(none);
      for (const r of context.replaceable) {
        if (r.type !== value && given.includes(r.type)) continue;
        const option = element(
          "option",
          undefined,
          `${hex2(r.type)} ${r.name}${r.note ? ` ⚠ ${r.note}` : ""}`,
        );
        option.value = String(r.type);
        choice.append(option);
      }
      choice.value = String(value);
      // the choices as shown now: a kept select keeps its listener (patchChildren)
      choice.addEventListener("change", () => {
        const shown = this.context;
        if (!shown) return;
        const now = [...box.querySelectorAll("select")].map((s) => Number(s.value));
        this.replaced.set(
          kit.key,
          now.filter((t) => t >= 0),
        );
        this.show(shown);
      });
      const row = element("label", "record-row");
      row.dataset["key"] = `slot ${k}`;
      row.append(element("span", "record-label", "Give up"), choice);
      box.append(row);
    });
    if (context.replaceable.length === 0) {
      box.append(element("p", "hint", `None of ${episode}’s own types is unused yet.`));
    }
    return box;
  }

  /** "Place example": the kit's working setup to put into the shown room. */
  private exampleBar(context: KitsContext, kit: Kit): HTMLElement {
    const place = element("button", undefined, "Place example");
    place.type = "button";
    place.disabled = !context.hasExample(kit);
    if (place.disabled) place.title = `Add the ${kit.name.toLowerCase()} first`;
    place.addEventListener("click", () => {
      this.events.example(kit);
    });
    const bar = element("div", "start-bar");
    bar.append(place);
    // what the example holds and how to try it, shown below its button
    const text = element("p", "hint", `Example: ${kit.example}`);
    const block = element("div");
    block.dataset["key"] = "example";
    block.append(bar, text);
    return block;
  }
}

/** What adding the kit would do, in a few words, for its folded line. */
function kitSummary(plan: KitPlan, kit: Kit): string {
  if (plan.problem) return "cannot be added";
  const own = plan.present.length === kit.types.length && plan.lacking.length === 0;
  const quiet =
    plan.moved.length + plan.silenced.length + plan.code.length + plan.textCopies.length;
  const parts = [
    plan.types.length > 0 ? `${plan.types.length} type${plan.types.length > 1 ? "s" : ""}` : "",
    plan.texts.length > 0 ? `${plan.texts.length} text${plan.texts.length > 1 ? "s" : ""}` : "",
    plan.events.length > 0 ? `${plan.events.length} event${plan.events.length > 1 ? "s" : ""}` : "",
    plan.flags === undefined ? "" : "a flag",
    quiet > 0 ? "a moved text" : "",
  ].filter((p) => p !== "");
  if (parts.length === 0) return own ? "has it" : "nothing left to add";
  return `adds ${parts.join(", ")}`;
}
