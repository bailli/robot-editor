import {
  type Direction,
  EPISODE_NAMES,
  Game,
  LOGIC_CELL,
  ROBOT_CLASSES,
  ROOM_WIDTH,
  type RoomActor,
  START_ROOMS,
  describeRecord,
  roomActors,
  roomScript,
  scriptActors,
} from "@robot/formats";

import { ActorsView, actorOrigin } from "./actors-view.ts";
import { type Edit, Editor, type Layer, tilesOf } from "./editor.ts";
import { type Connections, ExitsView, connections, fixedExit } from "./exits-view.ts";
import { RecordView } from "./record-view.ts";
import { CellCache, RoomView, cellCanvas, spriteCanvas } from "./room-view.ts";
import { TileNames } from "./tile-info.ts";

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
  /** Paint cells, or select cells to inspect their logic records. */
  tool: "paint" | "inspect" = "paint";
  /** The selected cell (inspect tool, or a logic cell clicked). */
  selected: { index: number; layer: Layer } | undefined;
  tile = 0;

  readonly view = new RoomView(2);
  private readonly caches = new Map<number, CellCache>();
  private fileName = "GameOfRobot.exe";
  private painting = false;
  private lastRoom: string | undefined;
  private lastPainted: number | undefined;

  private readonly fileInput = h("input", { type: "file", accept: ".exe", hidden: true });
  private readonly saveButton = h("button", { disabled: true }, "Save exe");
  private readonly undoButton = h("button", { disabled: true, title: "Ctrl+Z" }, "Undo");
  private readonly redoButton = h("button", { disabled: true, title: "Ctrl+Y" }, "Redo");
  private readonly gridToggle = h("input", { type: "checkbox" });
  private readonly actorsToggle = h("input", { type: "checkbox", checked: true });
  private actors: RoomActor[] = [];
  private readonly robotSprites = new Map<number, HTMLCanvasElement[]>();
  readonly actorsView = new ActorsView({
    select: (cell) => {
      this.select(cell);
    },
    name: (type) => this.names().summary(type),
    icon: (type) =>
      (this.isRobot(type) ? this.robotSprite(0) : undefined) ?? this.cellPreview(type),
  });
  private readonly status = h("span", { class: "status" });
  private readonly episodeSelect = h("select", { "aria-label": "Episode" });
  private readonly roomList = h("div", { class: "room-list" });
  private readonly roomTitle = h("h2");
  private readonly backButton = h("button", { class: "history", disabled: true }, "◀");
  private readonly forwardButton = h("button", { class: "history", disabled: true }, "▶");
  /** Rooms shown, for going back and forward like in a browser. */
  private readonly history: { episode: number; room: number }[] = [];
  private historyIndex = -1;
  /** The next room replaces the browser's current history entry instead of adding one. */
  private replaceNext = false;
  /** Removes the listeners on window (dispose). */
  private readonly listeners = new AbortController();
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
  private readonly cellText = h("p", { class: "cell-text" }, "\u00a0");
  private readonly tileText = h("p", { class: "tile-text" });
  private readonly tileNames = new Map<number, TileNames>();
  private readonly tileGrid = h("div", { class: "tile-grid" });
  private readonly layerInputs = new Map<Layer, HTMLInputElement>();
  private readonly toolInputs = new Map<"paint" | "inspect", HTMLInputElement>();
  readonly recordView = new RecordView({
    change: (data) => {
      this.recordEdit((editor, room, slot) => editor.setRecord(this.episode, room, slot, data));
    },
    add: (type) => {
      const selected = this.selected;
      if (!selected) return;
      this.need().addRecord(this.episode, this.roomId, selected.layer, selected.index, type);
      this.afterRecordEdit();
    },
    remove: () => {
      const selected = this.selected;
      if (!selected) return;
      this.need().removeRecord(this.episode, this.roomId, selected.layer, selected.index);
      this.afterRecordEdit();
    },
    go: (room) => {
      if (
        this.need()
          .rooms(this.episode)
          .some((r) => r.id === room)
      )
        this.showRoom(room);
    },
    preview: (value) => this.cellPreview(value),
  });
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

    const tools = h("fieldset", { class: "layers" }, h("legend", {}, "Tool"));
    for (const tool of ["paint", "inspect"] as const) {
      const input = h("input", { type: "radio", name: "tool", value: tool });
      input.checked = tool === this.tool;
      input.addEventListener("change", () => {
        this.tool = tool;
      });
      this.toolInputs.set(tool, input);
      tools.append(h("label", {}, input, tool === "paint" ? " Paint" : " Inspect"));
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
      h(
        "main",
        {},
        h("div", { class: "room-head" }, this.backButton, this.forwardButton, this.roomTitle),
        this.exitsView.element,
        this.view.element,
        this.cellInfo,
        this.cellText,
        this.recordView.element,
        this.actorsView.element,
      ),
      h(
        "aside",
        { class: "tiles" },
        tools,
        layers,
        h("label", { class: "tile-current" }, this.tilePreview, this.tileInput),
        this.tileText,
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
        h("label", { title: "Where actors appear (A)" }, this.actorsToggle, " Actors"),
        this.status,
      ),
      this.welcome,
      this.workspace,
    );
    this.wire();
  }

  /** Stops listening to the window (keys, history, drops), e.g. before replacing the app. */
  dispose(): void {
    this.listeners.abort();
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
    this.tileNames.clear();
    this.robotSprites.clear();
    this.welcome.hidden = true;
    this.workspace.hidden = false;
    const linked = roomInAddress();
    if (
      linked &&
      this.editor.game.episode(linked.episode).rooms.some((r) => r.id === linked.room)
    ) {
      this.episode = linked.episode;
      this.roomId = linked.room;
      // after a reload: our entries in the browser's history are still there
      const state: unknown = window.history.state;
      const saved = loadHistory();
      if (isHistoryState(state) && saved.at(state.index)?.room === state.room) {
        this.history.splice(0, Infinity, ...saved);
        this.historyIndex = state.index;
      }
    }
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
    this.refreshActors();
    this.refreshRoomList();
    const shown = `${this.episode} ${id}`;
    if (this.selected && this.lastRoom !== shown) this.select(undefined);
    this.lastRoom = shown;
    this.remember(this.episode, id);
  }

  /** Goes back to the previously shown room (the browser's back, also across episodes). */
  back(): void {
    if (this.historyIndex > 0) window.history.back();
  }

  forward(): void {
    if (this.historyIndex < this.history.length - 1) window.history.forward();
  }

  /** History entry `index`, undefined outside the history. */
  private entry(index: number): { episode: number; room: number } | undefined {
    return index >= 0 ? this.history.at(index) : undefined;
  }

  /** The browser went back or forward to one of our entries: show its room. */
  private arrive(state: unknown): void {
    if (!this.editor || !isHistoryState(state)) return;
    // set first: showing the room must not record it again
    this.historyIndex = state.index;
    this.history[state.index] = { episode: state.episode, room: state.room };
    saveHistory(this.history);
    if (state.episode === this.episode) this.showRoom(state.room);
    else this.showEpisode(state.episode, state.room);
  }

  /**
   * Records a shown room in the browser's history (and the address, e.g. #3/147), dropping
   * the forward history when it is a new way.
   */
  private remember(episode: number, room: number): void {
    const current = this.entry(this.historyIndex);
    if (current?.episode !== episode || current.room !== room) {
      const first = this.historyIndex < 0;
      this.history.splice(this.historyIndex + 1, Infinity, { episode, room });
      this.historyIndex = this.history.length - 1;
      const state: HistoryState = { robot: true, episode, room, index: this.historyIndex };
      if (first || this.replaceNext) window.history.replaceState(state, "", `#${episode}/${room}`);
      else window.history.pushState(state, "", `#${episode}/${room}`);
      saveHistory(this.history);
    }
    this.replaceNext = false;
    const label = (entry: { episode: number; room: number } | undefined, what: string) =>
      entry
        ? `${what} to ${entry.episode === episode ? "" : `${EPISODE_NAMES[entry.episode] ?? ""} `}room ${entry.room}`
        : what;
    const previous = this.entry(this.historyIndex - 1);
    const next = this.entry(this.historyIndex + 1);
    this.backButton.disabled = this.historyIndex <= 0;
    this.forwardButton.disabled = this.historyIndex >= this.history.length - 1;
    this.backButton.textContent = previous ? `◀ ${previous.room}` : "◀";
    this.forwardButton.textContent = next ? `${next.room} ▶` : "▶";
    this.backButton.title = `${label(previous, "Back")} (browser back, Alt+←, Backspace)`;
    this.forwardButton.title = `${label(next, "Forward")} (browser forward, Alt+→)`;
  }

  /** Selects a cell and shows its logic record (or the offer to add one). */
  select(index: number | undefined): void {
    this.view.setSelected(index);
    if (index === undefined) {
      this.selected = undefined;
      this.recordView.hide();
      return;
    }
    const layer = this.logicLayer(index) ?? this.layer;
    this.selected = { index, layer };
    const room = this.need().room(this.episode, this.roomId);
    const cell = room[layer][index] ?? 0;
    const where = `(${index % ROOM_WIDTH}, ${Math.floor(index / ROOM_WIDTH)}) ${layer}`;
    const record =
      (cell & 0xff) === LOGIC_CELL ? room.records.find((r) => r.slot === cell >> 8) : undefined;
    if (record) this.recordView.show(record, where);
    else this.recordView.showEmpty(where);
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
    this.tileText.textContent = this.names().summary(value);
    this.tileText.title = this.names().title(value);
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
    this.actorsToggle.addEventListener("change", () => {
      this.refreshActors();
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
      else if (event.button === 0 && (this.tool === "inspect" || this.logicLayer(index))) {
        this.select(index);
      } else if (event.button === 0) {
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
    window.addEventListener(
      "mouseup",
      () => {
        if (!this.painting) return;
        this.painting = false;
        this.endStroke();
      },
      { signal: this.listeners.signal },
    );

    this.backButton.addEventListener("click", () => {
      this.back();
    });
    this.forwardButton.addEventListener("click", () => {
      this.forward();
    });
    // the browser's back and forward (buttons, Alt+arrows, mouse buttons) and ours
    window.addEventListener(
      "popstate",
      (event) => {
        this.arrive(event.state);
      },
      { signal: this.listeners.signal },
    );
    // a room typed into the address of the open page (#3/147)
    window.addEventListener(
      "hashchange",
      () => {
        const linked = roomInAddress();
        if (!this.editor || !linked || isHistoryState(window.history.state)) return;
        if (!this.editor.game.episode(linked.episode).rooms.some((r) => r.id === linked.room))
          return;
        this.replaceNext = true; // the browser made the history entry already
        if (linked.episode === this.episode) this.showRoom(linked.room);
        else this.showEpisode(linked.episode, linked.room);
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "keydown",
      (event) => {
        const target = event.target;
        if (
          !this.editor ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement
        ) {
          return;
        }
        if (event.key === "Backspace" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          this.back();
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
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "a") {
          this.actorsToggle.checked = !this.actorsToggle.checked;
          this.refreshActors();
        }
      },
      { signal: this.listeners.signal },
    );
    window.addEventListener(
      "beforeunload",
      (event) => {
        if (this.editor?.dirty) event.preventDefault();
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "dragover",
      (event) => {
        event.preventDefault();
      },
      { signal: this.listeners.signal },
    );
    window.addEventListener(
      "drop",
      (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files[0];
        if (file) void this.loadFile(file);
      },
      { signal: this.listeners.signal },
    );
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
      this.refreshActors();
    }
  }

  /** Finds the room's actors again (after painting, record edits, …) and shows them. */
  private refreshActors(): void {
    const editor = this.need();
    const room = editor.room(this.episode, this.roomId);
    this.actors = roomActors(room, editor.game.episode(this.episode).classes);
    // robots are drawn with the episode's sprites, one after the other (their look varies)
    let robots = 0;
    this.view.setActors(this.actorsToggle.checked ? this.actors : [], (actor) =>
      actor.source === "tile" && actor.type !== undefined && this.isRobot(actor.type)
        ? this.robotSprite(robots++)
        : undefined,
    );
    this.actorsView.show(this.actors, scriptActors(roomScript(room)));
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
    else if (edit.records) {
      // records change what logic cells show and where things lead: redraw everything
      this.showRoom(this.roomId);
      if (this.selected) this.select(this.selected.index);
    } else {
      this.view.update(
        editor.room(this.episode, this.roomId),
        edit.changes.map((c) => c.index),
      );
    }
    this.refreshRoomList();
    this.refreshButtons();
  }

  /** The layer whose cell at `index` is a logic cell (the current layer first). */
  private logicLayer(index: number): Layer | undefined {
    const room = this.need().room(this.episode, this.roomId);
    const other: Layer = this.layer === "base" ? "overlay" : "base";
    return [this.layer, other].find((l) => ((room[l][index] ?? 0) & 0xff) === LOGIC_CELL);
  }

  /** Applies a change to the selected cell's record. */
  private recordEdit(
    change: (editor: Editor, room: number, slot: number) => Edit | undefined,
  ): void {
    const selected = this.selected;
    if (!selected) return;
    const cell = this.need().room(this.episode, this.roomId)[selected.layer][selected.index] ?? 0;
    if ((cell & 0xff) !== LOGIC_CELL) return;
    change(this.need(), this.roomId, cell >> 8);
    this.afterRecordEdit();
  }

  private afterRecordEdit(): void {
    this.showRoom(this.roomId);
    if (this.selected) this.select(this.selected.index);
    this.refreshButtons();
  }

  private isRobot(type: number): boolean {
    const id = this.need().game.episode(this.episode).classes.classes.get(type)?.id;
    return id !== undefined && ROBOT_CLASSES.includes(id);
  }

  /** Robot sprite n (in turn through the episode's sprites), as the game draws robots. */
  private robotSprite(n: number): HTMLCanvasElement | undefined {
    let sprites = this.robotSprites.get(this.episode);
    if (!sprites) {
      const game = this.need().game;
      const palette = game.episode(this.episode).palette;
      sprites = game
        .aliens(this.episode)
        .flatMap((shape) => (shape?.frames.length ? [spriteCanvas(shape, palette)] : []));
      this.robotSprites.set(this.episode, sprites);
    }
    return sprites.at(n % Math.max(1, sprites.length));
  }

  private cellPreview(value: number): HTMLCanvasElement {
    const preview = cellCanvas(this.cache(), value);
    preview.title = this.names().title(value);
    return preview;
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
            title: this.names().title(value),
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
      this.cellText.textContent = "\u00a0";
      return;
    }
    const room = this.editor.room(this.episode, this.roomId);
    const x = index % ROOM_WIDTH;
    const y = Math.floor(index / ROOM_WIDTH);
    const base = room.base[index] ?? 0;
    const overlay = room.overlay[index] ?? 0;
    this.cellInfo.textContent = `(${x}, ${y})  base ${hex(base)}  overlay ${hex(overlay)}`;
    const record = [base, overlay]
      .filter((c) => (c & 0xff) === LOGIC_CELL)
      .map((c) => room.records.find((r) => r.slot === c >> 8))
      .find((r) => r !== undefined);
    if (record) this.cellInfo.textContent += `  · ${describeRecord(record).summary}`;
    const actor = this.actors.find((a) => a.cell === index);
    if (actor) this.cellInfo.textContent += `  · actor: ${actorOrigin(actor)}`;
    // what the hero would see: the overlay object if there is one
    this.cellText.textContent =
      this.names().summary(overlay & 0xff ? overlay : base, room) || "\u00a0";
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

  private names(): TileNames {
    let names = this.tileNames.get(this.episode);
    if (!names) {
      names = new TileNames(this.need().game, this.episode);
      this.tileNames.set(this.episode, names);
    }
    return names;
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

interface HistoryState {
  robot: true;
  episode: number;
  room: number;
  /** Position in App.history. */
  index: number;
}

function isHistoryState(state: unknown): state is HistoryState {
  return typeof state === "object" && state !== null && "robot" in state;
}

const HISTORY_KEY = "robot-editor-history";

/** Keeps the visited rooms for this tab, so a reload can label back/forward again. */
function saveHistory(history: readonly { episode: number; room: number }[]): void {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // storage unavailable: back/forward still work, only their labels are lost on reload
  }
}

function loadHistory(): { episode: number; room: number }[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(saved) ? (saved as { episode: number; room: number }[]) : [];
  } catch {
    return [];
  }
}

/** The room in the page address, e.g. #3/147 (episode 3, room 147). */
function roomInAddress(): { episode: number; room: number } | undefined {
  const match = /^#([0-4])\/(\d+)$/.exec(window.location.hash);
  return match ? { episode: Number(match[1]), room: Number(match[2]) } : undefined;
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
