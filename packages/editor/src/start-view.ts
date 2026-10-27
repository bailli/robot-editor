import type { EpisodeStart } from "@robot/formats";

import { patchChildren } from "./patch.ts";

export interface StartViewEvents {
  /** Start in the shown room, at the picked cell (else the start's cell; Editor.setStart). */
  here(): void;
  /** Back to the start the exe (or the opened mod's base) has. */
  reset(): void;
  go(room: number): void;
}

/** What the view shows of the episode's start. */
export interface StartContext {
  episode: string;
  start: EpisodeStart;
  /** The start as the exe (or the opened mod's base) has it. */
  original: EpisodeStart;
  /** The shown room. */
  room: number;
  /** "room 43 – DER START" */
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

/**
 * The Episode tab's start: the room the episode starts in and the hero's cell there,
 * set to the shown room and the picked cell. Patched in place (patchChildren).
 */
export class StartView {
  readonly element = element("section", "start-view record-view");
  private readonly events: StartViewEvents;

  constructor(events: StartViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Start");
  }

  show(context: StartContext): void {
    patchChildren(this.element, this.render(context));
  }

  private render(context: StartContext): Node[] {
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
}
