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
  /** The episode's walls to offer, the most used first. */
  walls(): readonly number[];
  /** A cell drawn small (with its name as title). */
  preview(value: number): HTMLCanvasElement;
  /** Adds the room; returns whether it worked (else the dialog stays open). */
  create(id: number, content: NewRoomContent, openNeighbours: boolean): boolean;
}

/**
 * Asks for a new room: its id (checked while typing: free, where it lies, which rooms it
 * borders), its content (walls with exits, empty floor or a copy of a room, the shown one
 * by default), and whether closed exits of its neighbours should open towards it.
 */
export class NewRoomDialog {
  readonly element = document.createElement("dialog");
  private readonly heading = document.createElement("h3");
  private readonly id = document.createElement("input");
  private readonly where = document.createElement("div");
  private readonly walled = document.createElement("input");
  private readonly empty = document.createElement("input");
  private readonly copy = document.createElement("input");
  private readonly copyFrom = document.createElement("input");
  private readonly copyName = document.createElement("span");
  private readonly wallChoice = document.createElement("div");
  private wall: number | undefined;
  private readonly open = document.createElement("input");
  private readonly openLabel = document.createElement("label");
  private readonly create = document.createElement("button");
  private readonly events: NewRoomDialogEvents;

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
    ] as const) {
      input.type = "radio";
      input.name = "new-room-content";
      input.value = value;
      input.addEventListener("change", () => {
        this.refresh();
      });
    }
    const walledLabel = document.createElement("label");
    walledLabel.title =
      "The episode's wall all around, with five closed exit tiles in the middle of each edge (they open once the room's robots are gone)";
    walledLabel.append(this.walled, " Walls and exits");
    this.wallChoice.className = "new-room-walls";
    this.wallChoice.setAttribute("role", "group");
    this.wallChoice.setAttribute("aria-label", "Wall");
    const walledRow = document.createElement("div");
    walledRow.className = "new-room-copy";
    walledRow.append(walledLabel, this.wallChoice);
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
    content.append(legend, walledRow, emptyLabel, copyRow);

    this.open.type = "checkbox";
    this.open.checked = true;
    this.openLabel.title =
      "Their exits byte then says 'neighbour' for that direction (one undo step with the new room)";

    const buttons = document.createElement("div");
    buttons.className = "new-room-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.element.close();
    });
    this.create.type = "submit";
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
   * Opens the dialog for an episode with `id` filled in; `from` is the shown room (offered
   * to copy). The content chosen last stays chosen.
   */
  show(episode: string, id: number | undefined, from: number): void {
    this.heading.textContent = `New room in ${episode}`;
    this.id.value = id === undefined ? "" : String(id);
    this.copyFrom.value = String(from);
    const walls = this.events.walls();
    this.wall = walls.includes(this.wall ?? -1) ? this.wall : walls[0];
    this.wallChoice.replaceChildren(
      ...walls.map((value) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset["tile"] = String(value);
        const preview = this.events.preview(value);
        button.title = preview.title;
        button.setAttribute("aria-label", `Wall 0x${value.toString(16).padStart(4, "0")}`);
        button.append(preview);
        button.addEventListener("click", () => {
          this.wall = value;
          this.walled.checked = true;
          this.refresh();
        });
        return button;
      }),
    );
    if (![this.walled, this.empty, this.copy].some((input) => input.checked))
      this.walled.checked = true;
    this.refresh();
    if (!this.element.open) this.element.showModal();
    this.id.select();
  }

  /** The content chosen, undefined for a copy of a room that does not exist. */
  private content(): NewRoomContent | undefined {
    if (this.walled.checked) return this.wall === undefined ? undefined : { walls: this.wall };
    if (this.empty.checked) return "empty";
    const from = Number(this.copyFrom.value);
    return this.events.source(from) === undefined ? undefined : { copy: from };
  }

  private refresh(): void {
    for (const button of this.wallChoice.querySelectorAll<HTMLElement>("button")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset["tile"]) === this.wall));
    }
    const source = this.events.source(Number(this.copyFrom.value));
    this.copyName.textContent = source?.replace(/^room \d+( – )?/, "") ?? "(no such room)";
    this.copyName.classList.toggle("error", source === undefined);
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
