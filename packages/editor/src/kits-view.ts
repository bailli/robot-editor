import { KITS, type Kit, type KitPlan } from "@robot/formats";

import { element } from "./dom.ts";
import { hex2 } from "./format.ts";
import { patchChildren } from "./patch.ts";

export interface KitsViewEvents {
  /** Adds the kit to the shown episode, the events chosen (Editor.addKit). */
  add(kit: Kit, events: readonly number[] | undefined): void;
  /** Starts pasting the kit's example into the shown room (Editor.kitExample). */
  example(kit: Kit): void;
}

/** What the view shows: the kits' plans for the shown episode. */
export interface KitsContext {
  episode: number;
  names: readonly string[];
  /** What adding the kit does now, with these events chosen (Editor.kitPlan). */
  plan: (kit: Kit, events?: readonly number[]) => KitPlan;
  /** Whether the episode has all the kit's types, so its example can be placed. */
  hasExample: (kit: Kit) => boolean;
}

/**
 * The Episode tab's kits (formats' KITS): per kit what adding it to the shown episode
 * copies (tile types, texts, events, music) and what it cannot (events without an entry),
 * with checkboxes for the events where the spare entries do not hold them all, and
 * "Add". Patched in place (patchChildren); the events chosen stay while the episode does.
 */
export class KitsView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: KitsViewEvents;
  private context: KitsContext | undefined;
  /** The events chosen per kit, for the episode shown. */
  private chosen = new Map<string, number[]>();
  private chosenEpisode = -1;

  constructor(events: KitsViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Kits");
  }

  /** Forgets the choices (a newly loaded exe or mod). */
  reset(): void {
    this.chosen.clear();
    this.chosenEpisode = -1;
  }

  show(context: KitsContext): void {
    this.context = context;
    if (context.episode !== this.chosenEpisode) {
      this.chosen.clear();
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
        "A kit copies what a feature of another episode needs in one undo step: its tile types (to free types), the texts its classes show, the events its code raises (to entries the game never uses) and the pieces of music their sounds need. Kits share the spare entries (IV has four: oracles and circuits together). The parts show below, each removable on its own.",
      ),
    ];
  }

  private renderKit(context: KitsContext, kit: Kit): HTMLElement {
    const { episode, names } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const box = element("div", "kit");
    box.dataset["key"] = kit.key;
    // the default plan holds as many events as fit: the most that can be chosen
    const fit = context.plan(kit);
    // ids that are not lacking (any more) are dropped
    const chosen = this.chosen.get(kit.key)?.filter((id) => fit.lacking.includes(id));
    const plan = chosen ? context.plan(kit, chosen) : fit;
    box.append(element("h4", undefined, `${kit.name} from ${name(kit.from)}`));
    const line = (key: string, text: string) => {
      const p = element("p", "kit-line", text);
      p.dataset["key"] = key;
      return p;
    };
    const typeName = (of: number) => kit.types.find(([t]) => t === of)?.[1] ?? hex2(of);
    const label = (id: number) => (kit.eventLabel ? `${kit.eventLabel(id)} (${id})` : String(id));
    const own = plan.present.length === kit.types.length && plan.lacking.length === 0;
    if (own && plan.texts.length === 0) {
      box.append(line("own", `${name(episode)} has ${kit.name.toLowerCase()} already.`));
      box.append(this.exampleBar(context, kit));
      return box;
    }
    const types = plan.types.map(([to, of]) => `${hex2(to)} ← ${typeName(of)}`);
    const present = plan.present.map(typeName);
    box.append(
      line(
        "types",
        `Tile types: ${types.length > 0 ? types.join(", ") : "none to copy"}${present.length > 0 ? ` (has: ${present.join(", ")})` : ""}`,
      ),
    );
    if (plan.texts.length > 0) box.append(line("texts", `Texts: ${plan.texts.join(", ")}`));
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
    const empty = plan.types.length + plan.texts.length + plan.events.length === 0;
    const add = element("button", undefined, `Add ${kit.name.toLowerCase()}`);
    add.type = "button";
    add.disabled = empty || plan.problem !== undefined;
    add.title = plan.problem ?? (empty ? "Nothing left to add" : kit.note);
    add.addEventListener("click", () => {
      // the events not chosen stay lacking: the next plan starts from its default
      const events = this.chosen.get(kit.key);
      this.chosen.delete(kit.key);
      this.events.add(kit, events);
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "add";
    bar.append(add);
    if (plan.problem) bar.append(element("span", "hint", plan.problem));
    box.append(bar, this.exampleBar(context, kit));
    return box;
  }

  /** "Place example": the kit's working setup to put into the shown room. */
  private exampleBar(context: KitsContext, kit: Kit): HTMLElement {
    const place = element("button", undefined, "Place example");
    place.type = "button";
    place.disabled = !context.hasExample(kit);
    place.title = place.disabled ? `Add the ${kit.name.toLowerCase()} first` : kit.example;
    place.addEventListener("click", () => {
      this.events.example(kit);
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "example";
    bar.append(place);
    return bar;
  }
}
