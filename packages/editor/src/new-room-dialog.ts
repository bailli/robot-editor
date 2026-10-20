import type { NewRoomContent } from "./editor.ts";

/** What the dialog shows about a room id while it is typed. */
export interface NewRoomCheck {
  /** Why the room cannot be added (Create is disabled). */
  problem?: string | undefined;
  /** Where the room would lie and what it borders, one line each. */
  lines: string[];
  /** How many neighbours have closed exits towards it (0: no offer to open them). */
  closed: number;
}

export interface NewRoomDialogEvents {
  check(id: number): NewRoomCheck;
  /** The room to copy, named ("room 43 – DER START"), undefined if there is none. */
  source(id: number): string | undefined;
  /**
   * What an interior with this id would be, or why there can be none; `ways`: how many
   * doors and stairs of the room 100 below lead in.
   */
  interior(id: number): { text: string; problem?: string | undefined; ways?: number };
  /**
   * The cell selected in the room 100 below the id, where new stairs down could lead
   * into the interior ("(12, 7)"; a problem if they cannot go there), undefined if none.
   */
  interiorStairs(
    id: number,
  ): { cell: number; at: string; problem?: string | undefined } | undefined;
  /** The episode's walls to offer, the most used first. */
  walls(): readonly number[];
  /** The cells to offer for the exits, the default first. */
  exits(): readonly number[];
  /** A cell drawn small (with its name as title). */
  preview(value: number): HTMLCanvasElement;
  /** Adds the room; returns whether it worked (else the dialog stays open). */
  create(id: number, content: NewRoomContent, openNeighbours: boolean): boolean;
}

/** A row of tile buttons to pick one of (aria-pressed marks it). */
class TileChoice {
  readonly element = document.createElement("div");
  value: number | undefined;
  private readonly name: string;
  private readonly picked: () => void;

  constructor(name: string, picked: () => void) {
    this.name = name;
    this.picked = picked;
    this.element.className = "new-room-tiles";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", name);
  }

  /** Offers `values` (drawn by `preview`), keeping the picked one if it is among them. */
  offer(values: readonly number[], preview: (value: number) => HTMLCanvasElement): void {
    this.value = values.includes(this.value ?? -1) ? this.value : values[0];
    this.element.replaceChildren(
      ...values.map((value) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset["tile"] = String(value);
        const canvas = preview(value);
        button.title = canvas.title;
        button.setAttribute("aria-label", `${this.name} 0x${value.toString(16).padStart(4, "0")}`);
        button.append(canvas);
        button.addEventListener("click", () => {
          this.value = value;
          this.picked();
        });
        return button;
      }),
    );
  }

  refresh(): void {
    for (const button of this.element.querySelectorAll<HTMLElement>("button")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset["tile"]) === this.value));
    }
  }
}

/**
 * Asks for a new room: its id (checked while typing: free, where it lies, which rooms it
 * borders), its content (walls with exits, empty floor, a copy of a room, the shown one
 * by default, or the interior of the room 100 below), and whether closed exits of its
 * neighbours should open towards it.
 */
export class NewRoomDialog {
  readonly element = document.createElement("dialog");
  private readonly heading = document.createElement("h3");
  private readonly id = document.createElement("input");
  private readonly where = document.createElement("div");
  private readonly walled = document.createElement("input");
  private readonly empty = document.createElement("input");
  private readonly copy = document.createElement("input");
  private readonly interior = document.createElement("input");
  private readonly interiorLabel = document.createElement("span");
  private readonly interiorText = document.createElement("p");
  private readonly stairs = document.createElement("input");
  private readonly stairsLabel = document.createElement("label");
  private readonly copyFrom = document.createElement("input");
  private readonly copyName = document.createElement("span");
  private readonly wall = new TileChoice("Wall", () => {
    this.walled.checked = true;
    this.refresh();
  });
  private readonly exits = new TileChoice("Exits", () => {
    this.walled.checked = true;
    this.refresh();
  });
  private readonly open = document.createElement("input");
  private readonly openLabel = document.createElement("label");
  private readonly create = document.createElement("button");
  private readonly events: NewRoomDialogEvents;
  /** The room shown when the dialog opened. */
  private from = 0;

  constructor(events: NewRoomDialogEvents) {
    this.events = events;
    this.element.className = "new-room";
    this.element.setAttribute("aria-label", "New room");
    const form = document.createElement("form");
    form.method = "dialog";
    this.id.type = "number";
    this.id.min = "1";
    this.id.setAttribute("aria-label", "Room id");
    this.id.addEventListener("input", () => {
      this.refresh();
    });
    const idRow = document.createElement("label");
    idRow.className = "new-room-id";
    idRow.append("Room id ", this.id);
    this.where.className = "new-room-where";
    this.where.setAttribute("aria-live", "polite");

    const content = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Content";
    for (const [input, value] of [
      [this.walled, "walls"],
      [this.empty, "empty"],
      [this.copy, "copy"],
      [this.interior, "interior"],
    ] as const) {
      input.type = "radio";
      input.name = "new-room-content";
      input.value = value;
      input.addEventListener("change", () => {
        this.refresh();
      });
    }
    this.interior.addEventListener("change", () => {
      this.moveInside();
      this.refresh();
    });
    const walledLabel = document.createElement("label");
    walledLabel.title =
      "A wall all around, with five exit cells in the middle of each edge (exit tiles and barriers are closed while the room has enemies, exit tiles only open on edges that lead somewhere)";
    walledLabel.append(this.walled, " Walls and exits");
    const tiles = document.createElement("div");
    tiles.className = "new-room-tile-rows";
    for (const [label, choice] of [
      ["Wall", this.wall],
      ["Exits", this.exits],
    ] as const) {
      const row = document.createElement("div");
      row.className = "new-room-copy";
      const name = document.createElement("span");
      name.className = "new-room-tile-label";
      name.textContent = label;
      row.append(name, choice.element);
      tiles.append(row);
    }
    const walledRow = document.createElement("div");
    walledRow.append(walledLabel, tiles);
    const emptyLabel = document.createElement("label");
    emptyLabel.append(this.empty, " Empty floor");
    this.copyFrom.type = "number";
    this.copyFrom.min = "1";
    this.copyFrom.setAttribute("aria-label", "Copy from room");
    this.copyFrom.addEventListener("input", () => {
      this.copy.checked = true;
      this.refresh();
    });
    this.copyName.className = "new-room-source";
    const copyLabel = document.createElement("label");
    copyLabel.title = "Cells, records, settings and script";
    copyLabel.append(this.copy, " Copy of room ");
    const copyRow = document.createElement("div");
    copyRow.className = "new-room-copy";
    copyRow.append(copyLabel, this.copyFrom, this.copyName);
    const interiorLabel = document.createElement("label");
    interiorLabel.title =
      "Filled with the tile that shows the room behind it and blocks the hero (class 99); a door out at each door into a building of the room 100 below, stairs up at its stairs down";
    interiorLabel.append(this.interior, " ", this.interiorLabel);
    this.interiorText.className = "new-room-interior";
    const interiorRow = document.createElement("div");
    this.stairs.type = "checkbox";
    this.stairs.addEventListener("change", () => {
      this.refresh();
    });
    this.stairsLabel.className = "new-room-interior";
    this.stairsLabel.title =
      "The room below gets stairs down at the cell selected there, this room stairs up at the same cell (one undo step)";
    interiorRow.append(interiorLabel, this.interiorText, this.stairsLabel);
    content.append(legend, walledRow, emptyLabel, copyRow, interiorRow);

    this.open.type = "checkbox";
    this.open.checked = true;
    this.openLabel.title =
      "Their exits byte then says 'neighbour' for that direction (one undo step with the new room)";

    const buttons = document.createElement("div");
    buttons.className = "dialog-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.element.close();
    });
    this.create.type = "submit";
    this.create.className = "primary";
    this.create.textContent = "Create";
    buttons.append(cancel, this.create);
    form.addEventListener("submit", (event) => {
      const id = Number(this.id.value);
      const content = this.content();
      if (this.events.check(id).problem !== undefined || content === undefined) {
        event.preventDefault();
        return;
      }
      if (!this.events.create(id, content, this.open.checked && !this.openLabel.hidden))
        event.preventDefault();
    });
    form.append(this.heading, idRow, this.where, content, this.openLabel, buttons);
    this.element.append(form);
  }

  /**
   * Opens the dialog for an episode with `id` filled in (`fixed`: asked for, e.g. by the
   * map, else only offered); `from` is the shown room (offered to copy). The content
   * chosen last stays chosen: an interior then moves the offered id to `from` + 100.
   */
  show(episode: string, id: number | undefined, from: number, fixed = false): void {
    this.heading.textContent = `New room in ${episode}`;
    this.from = from;
    this.id.value = id === undefined ? "" : String(id);
    if (this.interior.checked && !fixed) this.moveInside();
    this.copyFrom.value = String(from);
    const preview = (value: number) => this.events.preview(value);
    this.wall.offer(this.events.walls(), preview);
    this.exits.offer(this.events.exits(), preview);
    if (![this.walled, this.empty, this.copy, this.interior].some((input) => input.checked))
      this.walled.checked = true;
    this.refresh();
    if (!this.element.open) this.element.showModal();
    this.id.select();
  }

  /**
   * An interior lies 100 above the room it is entered from: moves the id to the shown
   * room + 100 if that can be one; new stairs are offered where the room has no way in.
   */
  private moveInside(): void {
    const inside = this.from + 100;
    if (
      this.events.check(inside).problem === undefined &&
      this.events.interior(inside).problem === undefined
    ) {
      this.id.value = String(inside);
    }
    this.stairs.checked = this.events.interior(Number(this.id.value)).ways === 0;
  }

  /** The content chosen, undefined for a copy of a room that does not exist. */
  private content(): NewRoomContent | undefined {
    if (this.walled.checked) {
      const [walls, exits] = [this.wall.value, this.exits.value];
      return walls === undefined || exits === undefined ? undefined : { walls, exits };
    }
    if (this.empty.checked) return "empty";
    if (this.interior.checked) {
      const id = Number(this.id.value);
      if (this.events.interior(id).problem !== undefined) return undefined;
      const stairs = this.events.interiorStairs(id);
      if (!stairs || this.stairsLabel.hidden || !this.stairs.checked) return "interior";
      return stairs.problem === undefined ? { interior: { stairs: stairs.cell } } : undefined;
    }
    const from = Number(this.copyFrom.value);
    return this.events.source(from) === undefined ? undefined : { copy: from };
  }

  private refresh(): void {
    this.wall.refresh();
    this.exits.refresh();
    const source = this.events.source(Number(this.copyFrom.value));
    this.copyName.textContent = source?.replace(/^room \d+( – )?/, "") ?? "(no such room)";
    this.copyName.classList.toggle("error", source === undefined);
    const id = Number(this.id.value);
    const interior = this.events.interior(id);
    this.interiorLabel.textContent = `Interior of room ${id - 100}`;
    this.interiorText.textContent = interior.problem ?? interior.text;
    this.interiorText.classList.toggle("error", interior.problem !== undefined);
    const stairs = interior.problem === undefined ? this.events.interiorStairs(id) : undefined;
    this.stairsLabel.hidden = !stairs || !this.interior.checked;
    this.stairsLabel.replaceChildren(
      this.stairs,
      stairs
        ? ` Stairs down at ${stairs.at} of room ${id - 100}, up here${stairs.problem ? `: ${stairs.problem}` : ""}`
        : "",
    );
    this.stairsLabel.classList.toggle(
      "error",
      stairs?.problem !== undefined && this.stairs.checked,
    );
    const check = this.events.check(Number(this.id.value));
    const lines = check.problem === undefined ? check.lines : [check.problem, ...check.lines];
    this.where.replaceChildren(
      ...lines.map((line, i) => {
        const p = document.createElement("p");
        p.textContent = line;
        if (i === 0 && check.problem !== undefined) p.className = "error";
        return p;
      }),
    );
    this.create.disabled = check.problem !== undefined || this.content() === undefined;
    this.openLabel.hidden = check.problem !== undefined || check.closed === 0;
    this.openLabel.replaceChildren(
      this.open,
      ` Open the closed exit${check.closed === 1 ? "" : "s"} of ${check.closed === 1 ? "its neighbour" : "its neighbours"} towards it`,
    );
  }
}
