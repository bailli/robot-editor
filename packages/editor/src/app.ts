import {
  type Direction,
  EPISODE_NAMES,
  Game,
  LOGIC_CELL,
  ROOM_WIDTH,
  START_ROOMS,
} from "@robot/formats";

import { type Edit, Editor, type Layer, tilesOf } from "./editor.ts";
import { type Connections, ExitsView, connections, fixedExit } from "./exits-view.ts";
import { CellCache, RoomView, cellCanvas } from "./room-view.ts";

type Props = Record<string, string | boolean | ((event: Event) => void)>;

/** Creates an element: string props become attributes or properties, functions listeners. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") element.addEventListener(key, value);
    else if (typeof value === "boolean") element.toggleAttribute(key, value);
    else element.setAttribute(key, value);
  }
  element.append(...children);
  return element;
}

const ARROWS: Readonly<Partial<Record<string, Direction>>> = {
  ArrowUp: "north",
  ArrowDown: "south",
  ArrowLeft: "west",
  ArrowRight: "east",
};

const hex = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;

/** The editor's user interface; everything happens in the browser, nothing is uploaded. */
export class App {
  editor: Editor | undefined;
  episode = 1;
  roomId = START_ROOMS[1] ?? 1;
  layer: Layer = "base";
  tile = 0;

  readonly view = new RoomView(2);
  private readonly caches = new Map<number, CellCache>();
  private fileName = "GameOfRobot.exe";
  private painting = false;
  private lastPainted: number | undefined;

  private readonly fileInput = h("input", { type: "file", accept: ".exe", hidden: true });
  private readonly saveButton = h("button", { disabled: true }, "Save exe");
  private readonly undoButton = h("button", { disabled: true, title: "Ctrl+Z" }, "Undo");
  private readonly redoButton = h("button", { disabled: true, title: "Ctrl+Y" }, "Redo");
  private readonly gridToggle = h("input", { type: "checkbox" });
  private readonly status = h("span", { class: "status" });
  private readonly episodeSelect = h("select", { "aria-label": "Episode" });
  private readonly roomList = h("div", { class: "room-list" });
  private readonly roomTitle = h("h2");
  private readonly exitsView = new ExitsView((room) => {
    this.showRoom(room);
  });
  private connections: Connections | undefined;
  private readonly cellInfo = h("p", { class: "cell-info" }, " ");
  private readonly tileInput = h("input", {
    class: "tile-input",
    "aria-label": "Tile value",
    spellcheck: "false",
  });
  private readonly tilePreview = h("span", { class: "tile-preview" });
  private readonly tileGrid = h("div", { class: "tile-grid" });
  private readonly layerInputs = new Map<Layer, HTMLInputElement>();
  private readonly workspace: HTMLElement;
  private readonly welcome: HTMLElement;

  constructor(root: HTMLElement) {
    for (const [i, name] of EPISODE_NAMES.entries()) {
      this.episodeSelect.append(h("option", { value: String(i) }, name));
    }
    const layers = h("fieldset", { class: "layers" }, h("legend", {}, "Layer"));
    for (const layer of ["base", "overlay"] as const) {
      const input = h("input", { type: "radio", name: "layer", value: layer });
      input.addEventListener("change", () => {
        this.setLayer(layer);
      });
      this.layerInputs.set(layer, input);
      layers.append(h("label", {}, input, layer === "base" ? " Base" : " Overlay"));
    }

    this.welcome = h(
      "section",
      { class: "welcome" },
      h("p", {}, "Open ", h("code", {}, "GameOfRobot.exe"), " or drop it here."),
      h("p", { class: "hint" }, "The file is read in your browser and never uploaded."),
    );
    this.workspace = h(
      "div",
      { class: "workspace", hidden: true },
      h("nav", { class: "rooms" }, this.episodeSelect, this.roomList),
      h("main", {}, this.roomTitle, this.exitsView.element, this.view.element, this.cellInfo),
      h(
        "aside",
        { class: "tiles" },
        layers,
        h("label", { class: "tile-current" }, this.tilePreview, this.tileInput),
        h(
          "p",
          { class: "hint" },
          "Paint with the left button, pick with the right. Magenta cells belong to logic records and stay as they are.",
        ),
        this.tileGrid,
      ),
    );
    root.append(
      h(
        "header",
        {},
        h("h1", {}, "Robot editor"),
        h(
          "button",
          {
            click: () => {
              this.fileInput.click();
            },
          },
          "Open exe…",
        ),
        this.fileInput,
        this.saveButton,
        this.undoButton,
        this.redoButton,
        h("label", {}, this.gridToggle, " Grid"),
        this.status,
      ),
      this.welcome,
      this.workspace,
    );
    this.wire();
  }

  /** Loads an exe; throws (and shows) what went wrong if it is not the game. */
  load(bytes: Uint8Array, name = "GameOfRobot.exe"): void {
    try {
      const game = new Game(bytes);
      game.episode(this.episode);
      this.editor = new Editor(game);
    } catch (error) {
      this.setStatus(`Cannot read ${name}: ${String(error)}`, true);
      throw error;
    }
    this.fileName = name;
    this.caches.clear();
    this.welcome.hidden = true;
    this.workspace.hidden = false;
    this.showEpisode(this.episode, this.roomId);
    this.setStatus(`${name} loaded`);
  }

  showEpisode(episode: number, roomId?: number): void {
    const editor = this.need();
    this.episode = episode;
    this.episodeSelect.value = String(episode);
    const rooms = editor.rooms(episode);
    const id = roomId ?? START_ROOMS[episode] ?? rooms.at(0)?.id ?? 1;
    this.roomList.replaceChildren(
      ...rooms.map((r) =>
        h(
          "button",
          {
            "data-room": String(r.id),
            click: () => {
              this.showRoom(r.id);
            },
          },
          String(r.id),
        ),
      ),
    );
    this.showTiles();
    this.showRoom(id);
  }

  showRoom(id: number): void {
    const editor = this.need();
    this.roomId = id;
    this.roomTitle.textContent = `${EPISODE_NAMES[this.episode] ?? ""} – room ${id}`;
    const room = editor.room(this.episode, id);
    this.view.show(room, this.cache());
    this.connections = connections(
      room,
      new Set(editor.rooms(this.episode).map((r) => r.id)),
      editor.game.episode(this.episode).classes,
    );
    this.exitsView.show(this.connections);
    this.refreshRoomList();
  }

  setLayer(layer: Layer): void {
    this.layer = layer;
    const input = this.layerInputs.get(layer);
    if (input) input.checked = true;
    this.showTiles();
  }

  setTile(value: number): void {
    this.tile = value;
    this.tileInput.value = hex(value);
    this.tilePreview.replaceChildren(this.tileCanvas(value));
    for (const button of this.tileGrid.querySelectorAll<HTMLElement>("button")) {
      button.classList.toggle("selected", Number(button.dataset["tile"]) === value);
    }
  }

  /** Paints the current tile at a cell of the shown room (as one stroke). */
  paintCell(index: number): void {
    this.beginStroke();
    this.paintTo(index);
    this.endStroke();
  }

  undo(): void {
    this.revisit(this.editor?.undo());
  }

  redo(): void {
    this.revisit(this.editor?.redo());
  }

  save(): Uint8Array | undefined {
    const editor = this.need();
    try {
      const bytes = editor.save();
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: "application/vnd.microsoft.portable-executable" }),
      );
      const link = h("a", { href: url, download: this.fileName });
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
      this.setStatus(`Saved ${this.fileName}`);
      this.refreshButtons();
      return bytes;
    } catch (error) {
      this.setStatus(`Saving failed: ${String(error)}`, true);
      return undefined;
    }
  }

  private wire(): void {
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.loadFile(file);
      this.fileInput.value = "";
    });
    this.saveButton.addEventListener("click", () => this.save());
    this.undoButton.addEventListener("click", () => {
      this.undo();
    });
    this.redoButton.addEventListener("click", () => {
      this.redo();
    });
    this.gridToggle.addEventListener("change", () => {
      this.view.setGrid(this.gridToggle.checked);
    });
    this.episodeSelect.addEventListener("change", () => {
      this.showEpisode(Number(this.episodeSelect.value));
    });
    this.tileInput.addEventListener("change", () => {
      const value = Number.parseInt(this.tileInput.value.replace(/^0x/i, ""), 16);
      if (
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 0xffff &&
        (value & 0xff) !== LOGIC_CELL
      ) {
        this.setTile(value);
      } else {
        this.setTile(this.tile);
      }
    });

    const view = this.view.element;
    view.addEventListener("mousedown", (event) => {
      const index = this.view.cellAt(event);
      if (index === undefined) return;
      event.preventDefault();
      if (event.button === 2 || event.altKey) this.pick(index);
      else if (event.button === 0) {
        this.painting = true;
        this.beginStroke();
        this.paintTo(index);
      }
    });
    view.addEventListener("mousemove", (event) => {
      const index = this.view.cellAt(event);
      this.view.setHover(index);
      this.showCellInfo(index);
      if (this.painting && index !== undefined) this.paintTo(index);
    });
    view.addEventListener("mouseleave", () => {
      this.view.setHover(undefined);
      this.showCellInfo(undefined);
    });
    view.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    window.addEventListener("mouseup", () => {
      if (!this.painting) return;
      this.painting = false;
      this.endStroke();
    });

    window.addEventListener("keydown", (event) => {
      const target = event.target;
      if (
        !this.editor ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      const direction = ARROWS[event.key];
      if (direction && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // follow the exit that does not depend on the game state
        event.preventDefault();
        const room = this.connections ? fixedExit(this.connections, direction) : 0;
        if (room !== 0) this.showRoom(room);
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        this.redo();
      } else if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        this.save();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "g") {
        this.gridToggle.checked = !this.gridToggle.checked;
        this.view.setGrid(this.gridToggle.checked);
      }
    });
    window.addEventListener("beforeunload", (event) => {
      if (this.editor?.dirty) event.preventDefault();
    });

    window.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    window.addEventListener("drop", (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file) void this.loadFile(file);
    });
    this.setLayer("base");
  }

  private async loadFile(file: File): Promise<void> {
    if (this.editor?.dirty && !window.confirm("Discard the unsaved changes?")) return;
    try {
      this.load(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch {
      // shown in the status line
    }
  }

  private beginStroke(): void {
    this.need().beginStroke(this.episode, this.roomId, this.layer);
    this.lastPainted = undefined;
  }

  /** Paints up to `index`, filling the cells between the previous and this one. */
  private paintTo(index: number): void {
    const editor = this.need();
    const cells = this.lastPainted === undefined ? [index] : line(this.lastPainted, index);
    this.lastPainted = index;
    const changed = cells.filter((i) => editor.paint(i, this.tile));
    if (changed.length > 0) this.view.update(editor.room(this.episode, this.roomId), changed);
  }

  private endStroke(): void {
    if (this.need().endStroke()) {
      this.refreshRoomList();
      this.refreshButtons();
    }
  }

  private pick(index: number): void {
    const cell = this.need().room(this.episode, this.roomId)[this.layer][index] ?? 0;
    if ((cell & 0xff) !== LOGIC_CELL) this.setTile(cell);
  }

  /** Shows the room of an undone or redone edit. */
  private revisit(edit: Edit | undefined): void {
    if (!edit) return;
    const editor = this.need();
    if (edit.episode !== this.episode) this.showEpisode(edit.episode, edit.room);
    else if (edit.room !== this.roomId) this.showRoom(edit.room);
    else {
      this.view.update(
        editor.room(this.episode, this.roomId),
        edit.changes.map((c) => c.index),
      );
    }
    this.refreshRoomList();
    this.refreshButtons();
  }

  private showTiles(): void {
    if (!this.editor) return;
    const tiles = tilesOf(this.editor.game.episode(this.episode).rooms, this.layer);
    this.tileGrid.replaceChildren(
      ...tiles.map((value) =>
        h(
          "button",
          {
            "data-tile": String(value),
            title: hex(value),
            click: () => {
              this.setTile(value);
            },
          },
          this.tileCanvas(value),
        ),
      ),
    );
    this.setTile(tiles.includes(this.tile) ? this.tile : 0);
  }

  private showCellInfo(index: number | undefined): void {
    if (index === undefined || !this.editor) {
      this.cellInfo.textContent = " ";
      return;
    }
    const room = this.editor.room(this.episode, this.roomId);
    const x = index % ROOM_WIDTH;
    const y = Math.floor(index / ROOM_WIDTH);
    this.cellInfo.textContent = `(${x}, ${y})  base ${hex(room.base[index] ?? 0)}  overlay ${hex(room.overlay[index] ?? 0)}`;
  }

  private refreshRoomList(): void {
    const editor = this.need();
    for (const button of this.roomList.querySelectorAll<HTMLElement>("button")) {
      const id = Number(button.dataset["room"]);
      button.classList.toggle("current", id === this.roomId);
      button.classList.toggle("edited", editor.isEdited(this.episode, id));
    }
    this.roomList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  private refreshButtons(): void {
    const editor = this.need();
    this.undoButton.disabled = !editor.canUndo;
    this.redoButton.disabled = !editor.canRedo;
    this.saveButton.disabled = !editor.dirty;
  }

  private tileCanvas(value: number): HTMLCanvasElement {
    return this.layer === "base"
      ? cellCanvas(this.cache(), value)
      : cellCanvas(this.cache(), 0, value);
  }

  private cache(): CellCache {
    let cache = this.caches.get(this.episode);
    if (!cache) {
      cache = new CellCache(this.need().game.episode(this.episode));
      this.caches.set(this.episode, cache);
    }
    return cache;
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("error", error);
  }

  private need(): Editor {
    if (!this.editor) throw new Error("no exe loaded");
    return this.editor;
  }
}

/** The cells on a straight line from cell a to cell b (both included). */
export function line(a: number, b: number): number[] {
  let [x, y] = [a % ROOM_WIDTH, Math.floor(a / ROOM_WIDTH)];
  const [x1, y1] = [b % ROOM_WIDTH, Math.floor(b / ROOM_WIDTH)];
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let error = dx + dy;
  const cells = [y * ROOM_WIDTH + x];
  while (x !== x1 || y !== y1) {
    const e2 = 2 * error;
    if (e2 >= dy) {
      error += dy;
      x += sx;
    }
    if (e2 <= dx) {
      error += dx;
      y += sy;
    }
    cells.push(y * ROOM_WIDTH + x);
  }
  return cells;
}
