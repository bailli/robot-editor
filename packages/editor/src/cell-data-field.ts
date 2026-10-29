import {
  type CellData,
  type EpisodeClasses,
  FIRST_NOTE_MESSAGE,
  LAST_NOTE_MESSAGE,
  POINTS_PER_STATE,
  cellData,
  displayText,
  roomNamesId,
  textsId,
  withCellData,
} from "@robot/formats";

import { button, element } from "./dom.ts";
import { hex2 } from "./format.ts";

/** An electric fence: a package holding one kills the hero (message 951). */
const FENCE_CLASS = 7;

export interface CellDataFieldEvents {
  /** The cell's value with its data changed. */
  change(value: number): void;
  /** A value the field refused, and why. */
  refused(reason: string): void;
  /** The first variant of a text entry, undefined if there is none. */
  text(resource: number, entry: number): string | undefined;
  /** Opens a text entry for writing. */
  editText(resource: number, entry: number): void;
  /** What a tile type is called (a package's contents). */
  typeName(type: number): string;
  /** A tile drawn as in the palette (a package's contents). */
  preview(value: number): HTMLElement;
}

/** The controls of one kind of data; `update` shows a cell's data in them. */
interface Controls {
  kind: CellData["kind"];
  nodes: HTMLElement[];
  update(data: CellData): void;
}

/**
 * The data a package, note, diary page, expert field or letter keeps in its state
 * (cellData), with a control for it; hidden for other cells. Its controls stay while the
 * kind does, so a change keeps the focus where it is.
 */
export class CellDataField {
  readonly element = element("div", "cell-data");
  private controls: Controls | undefined;
  private value = 0;
  private classes: EpisodeClasses | undefined;
  private episode = 0;
  private readonly events: CellDataFieldEvents;

  constructor(events: CellDataFieldEvents) {
    this.events = events;
    this.element.hidden = true;
  }

  /** Shows the data of `value`, a cell of `episode`. */
  show(value: number, classes: EpisodeClasses, episode: number): void {
    const data = cellData(value, classes);
    this.value = value;
    this.element.hidden = data === undefined;
    if (!data) return;
    if (this.classes !== classes || this.episode !== episode || this.controls?.kind !== data.kind) {
      this.classes = classes;
      this.episode = episode;
      this.controls = this.build(data.kind, classes);
      this.element.replaceChildren(...this.controls.nodes);
    }
    this.controls.update(data);
  }

  /** Writes `data` into the cell, or says why it cannot (and shows the cell's again). */
  private set(data: CellData): void {
    const classes = this.classes;
    if (!classes) return;
    let value: number;
    try {
      value = withCellData(this.value, data, classes);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.events.refused(error.message);
      this.show(this.value, classes, this.episode);
      return;
    }
    if (value !== this.value) this.events.change(value);
  }

  private build(kind: CellData["kind"], classes: EpisodeClasses): Controls {
    switch (kind) {
      case "package":
        return this.packageControls(classes);
      case "note":
        return this.noteControls();
      case "diary":
        return this.diaryControls();
      case "expert":
        return this.expertControls();
      case "letter":
        return this.letterControls();
    }
  }

  private packageControls(classes: EpisodeClasses): Controls {
    const select = element("select", "record-field tile-type-field");
    select.setAttribute("aria-label", "Package contents");
    const option = (type: number) => {
      const name = type === 0 ? "nothing" : `${hex2(type)} ${this.events.typeName(type)}`;
      const o = element("option", undefined, name.trim());
      o.value = String(type);
      return o;
    };
    // the types with a class
    const types = [...classes.classes.keys()].filter((t) => t !== 0).sort((a, b) => a - b);
    select.append(...[0, ...types].map(option));
    select.addEventListener("change", () => {
      this.set({ kind: "package", type: Number(select.value) });
    });
    const warning = element("p", "hint", "An electric fence: it kills the hero who opens it.");
    const preview = element("span", "cell-data-preview");
    return {
      kind: "package",
      nodes: [row("Holds", preview, select), warning],
      update: (data) => {
        preview.replaceChildren(this.events.preview(data.kind === "package" ? data.type : 0));
        if (data.kind !== "package") return;
        // a type without a class stays as it is
        if (![...select.options].some((o) => o.value === String(data.type)))
          select.append(option(data.type));
        select.value = String(data.type);
        warning.hidden = classes.classes.get(data.type)?.id !== FENCE_CLASS;
      },
    };
  }

  private noteControls(): Controls {
    const message = numberInput("Message", FIRST_NOTE_MESSAGE, LAST_NOTE_MESSAGE, 1);
    const step = element("input");
    step.type = "checkbox";
    const read = () => {
      this.set({
        kind: "note",
        message: Number(message.value),
        read: step.checked ? "step" : "carry",
      });
    };
    message.addEventListener("change", read);
    step.addEventListener("change", read);
    const stepLabel = element("label", "cell-data-check");
    stepLabel.append(step, "Read when stepped on");
    stepLabel.title =
      "Drawn as a note and read on the spot; otherwise the hero picks it up (old writing, in IV a cassette)";
    const edit = this.editButton();
    return {
      kind: "note",
      nodes: [row("Message", message, edit.button), stepLabel],
      update: (data) => {
        if (data.kind !== "note") return;
        message.value = String(data.message);
        step.checked = data.read === "step";
        edit.update(textsId(this.episode), data.message);
      },
    };
  }

  private diaryControls(): Controls {
    const page = numberInput("Page", 0, 0xff, 1);
    page.addEventListener("change", () => {
      this.set({ kind: "diary", page: Number(page.value) });
    });
    const edit = this.editButton();
    return {
      kind: "diary",
      nodes: [row("Page", page, edit.button)],
      update: (data) => {
        if (data.kind !== "diary") return;
        page.value = String(data.page);
        edit.update(roomNamesId(this.episode), data.page);
      },
    };
  }

  private expertControls(): Controls {
    const points = numberInput("Points", 0, 0xff * POINTS_PER_STATE, POINTS_PER_STATE);
    points.addEventListener("change", () => {
      this.set({ kind: "expert", points: Number(points.value) });
    });
    return {
      kind: "expert",
      nodes: [row("Points", points)],
      update: (data) => {
        if (data.kind === "expert") points.value = String(data.points);
      },
    };
  }

  private letterControls(): Controls {
    const char = element("input", "record-field");
    char.setAttribute("aria-label", "Character");
    char.maxLength = 1;
    char.spellcheck = false;
    let code = 0;
    char.addEventListener("change", () => {
      const typed = char.value.toUpperCase().charCodeAt(0);
      // the game font's printable glyphs; bit 7 (meaning unknown) stays as it was
      if (typed >= 0x20 && typed < 0x7f) this.set({ kind: "letter", code: (code & 0x80) | typed });
      else {
        this.events.refused("a letter is one character, from the space to ~");
        char.value = String.fromCharCode(code & 0x7f);
      }
    });
    return {
      kind: "letter",
      nodes: [row("Character", char)],
      update: (data) => {
        if (data.kind !== "letter") return;
        code = data.code;
        char.value = String.fromCharCode(code & 0x7f);
      },
    };
  }

  /** A button that opens a note's message or a diary page in the Texts tab. */
  private editButton(): {
    button: HTMLButtonElement;
    update(resource: number, entry: number): void;
  } {
    let at = { resource: 0, entry: 0 };
    const edit = button("✎", "", () => {
      this.events.editText(at.resource, at.entry);
    });
    edit.className = "text-jump";
    return {
      button: edit,
      update: (resource, entry) => {
        at = { resource, entry };
        const text = this.events.text(resource, entry);
        const flat = text === undefined ? "(none yet)" : displayText(text).replace(/\s+/g, " ");
        edit.title = `Write text ${entry} (the Texts tab): ${flat}`;
        edit.setAttribute("aria-label", `Write text ${entry}`);
      },
    };
  }
}

function numberInput(label: string, min: number, max: number, step: number): HTMLInputElement {
  const input = element("input", "record-field");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.setAttribute("aria-label", label);
  return input;
}

function row(label: string, ...fields: HTMLElement[]): HTMLElement {
  const line = element("label", "record-row");
  line.append(element("span", "record-label", label), ...fields);
  return line;
}
