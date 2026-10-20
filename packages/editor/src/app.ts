import {
  type Direction,
  EPISODES,
  EPISODE_NAMES,
  EVENT_TEXT,
  type ExitMode,
  Game,
  KEYWORD_FUNCTION,
  LOGIC_CELL,
  MAX_ROOMS,
  NAMED_ROOMS,
  PLACEMENT_AREAS,
  ROBOT_CLASSES,
  ROOM_WIDTH,
  type Room,
  type RoomActor,
  START_ROOMS,
  compileScript,
  cryptScene,
  describeRecord,
  disassemble,
  displayText,
  exitMode,
  parseCompiledScript,
  parseScene,
  randomPlacement,
  readEventTable,
  readOracleSymbols,
  roomActors,
  roomSaveTime,
  roomScript,
  roomSettings,
  sceneId,
  scriptActors,
  scriptArgument,
  scriptDoc,
  scriptFunctionDoc,
  scriptTextVariants,
} from "@robot/formats";

import { ActorsView, actorOrigin } from "./actors-view.ts";
import { confirmDialog } from "./confirm-dialog.ts";
import {
  type Area,
  type Clip,
  type Edit,
  Editor,
  type GridNeighbour,
  type Layer,
  MAX_RECORD_SLOTS,
  MAX_ROOM_ID,
  type NewRoomContent,
  areaBetween,
  areaCells,
  clipArea,
  fillRegion,
  recordCapacity,
  tilesOf,
  wrapsRow,
} from "./editor.ts";
import { type Connections, ExitsView, connections, fixedExit, leadsTo } from "./exits-view.ts";
import { MapView } from "./map-view.ts";
import { type NewRoomCheck, NewRoomDialog } from "./new-room-dialog.ts";
import { RecordView } from "./record-view.ts";
import {
  CellCache,
  type Highlight,
  RoomView,
  cellCanvas,
  cellsCanvas,
  drawRoom,
  spriteCanvas,
} from "./room-view.ts";
import { type ScriptName, ScriptView } from "./script-view.ts";
import { SettingsView } from "./settings-view.ts";
import { SidePanel } from "./side-panel.ts";
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

/** The cells or areas a script call names, where its arguments are plain numbers. */
export function scriptPlaces(fn: string, args: readonly (number | undefined)[]): Highlight[] {
  const places = scriptFunctionDoc(fn, args.length)?.places ?? [];
  return places.flatMap((place) => {
    const [x, y] = [args[place.x], args[place.y]];
    const w = place.w === undefined ? 1 : args[place.w];
    const h = place.h === undefined ? 1 : args[place.h];
    if (x === undefined || y === undefined || w === undefined || h === undefined) return [];
    return [{ x, y, w, h }];
  });
}

const ARROWS: Readonly<Partial<Record<string, Direction>>> = {
  ArrowUp: "north",
  ArrowDown: "south",
  ArrowLeft: "west",
  ArrowRight: "east",
};

const hex = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;

export type Tool = "paint" | "fill" | "select" | "inspect";

const TOOLS: readonly { tool: Tool; label: string; title: string }[] = [
  { tool: "paint", label: "Paint", title: "Paint cells with the tile; dragging draws lines" },
  {
    tool: "fill",
    label: "Fill",
    title:
      "Fill the cells of the clicked cell's value around it (within the selected area, if inside)",
  },
  { tool: "select", label: "Select", title: "Drag to select an area to copy, cut, clear or fill" },
  { tool: "inspect", label: "Inspect", title: "Click a cell to see or add its logic record" },
];

export interface AppOptions {
  /**
   * Runs an exe in the game (e.g. via the development server and Wine); without it,
   * "Test in game" downloads the exe.
   */
  play?: (exe: Uint8Array, episode: number) => Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The editor's user interface; everything happens in the browser, nothing is uploaded. */
export class App {
  editor: Editor | undefined;
  episode = 1;
  roomId = START_ROOMS[1] ?? 1;
  layer: Layer = "base";
  /** Paint or fill cells, select an area, or select cells to inspect their logic records. */
  tool: Tool = "paint";
  /** The selected area (Select tool), in the shown room. */
  area: Area | undefined;
  /** Copied cells, pasted with Ctrl+V (also in other rooms and episodes). */
  clip: Clip | undefined;
  /** The clip follows the mouse until a click puts it down. */
  pasting = false;
  /** The selected cell (inspect tool, or a logic cell clicked). */
  selected: { index: number; layer: Layer } | undefined;
  tile = 0;

  readonly view = new RoomView(2);
  private readonly caches = new Map<number, CellCache>();
  private fileName = "GameOfRobot.exe";
  private painting = false;
  private lastRoom: string | undefined;
  private lastPainted: number | undefined;
  /** The cell an area selection started at, while dragging. */
  private selectFrom: number | undefined;
  /** The cell the clip was last shown at. */
  private pasteCell: number | undefined;
  /** The clip drawn with an episode's tiles. */
  private clipImage: { episode: number; canvas: HTMLCanvasElement } | undefined;

  private readonly fileInput = h("input", { type: "file", accept: ".exe", hidden: true });
  private readonly saveButton = h("button", { disabled: true }, "Save exe");
  private readonly testButton = h(
    "button",
    {
      disabled: true,
      title:
        "Start the game in this room, with all edits: the hero starts at the selected cell, else where the episode puts it",
    },
    "Test in game",
  );
  private readonly undoButton = h("button", { disabled: true, title: "Ctrl+Z" }, "Undo");
  private readonly redoButton = h("button", { disabled: true, title: "Ctrl+Y" }, "Redo");
  private readonly gridToggle = h("input", { type: "checkbox" });
  private readonly actorsToggle = h("input", { type: "checkbox", checked: true });
  private readonly mapButton = h("button", {
    title: "The episode's rooms on their grid, with the exits between them (M)",
    "aria-pressed": "false",
  });
  readonly mapView = new MapView({
    open: (room) => {
      this.setMap(false, room);
    },
    toggle: (room, direction) => {
      const editor = this.need();
      const open = exitMode(editor.room(this.episode, room), direction) === "neighbour";
      editor.setExitMode(this.episode, room, direction, open ? "none" : "neighbour");
      this.refreshMap();
      this.refreshRoomList();
      this.refreshButtons();
    },
    exists: (room) =>
      this.need()
        .rooms(this.episode)
        .some((r) => r.id === room),
    thumbnail: (room) => this.thumbnail(room),
    name: (room) => {
      const editor = this.need();
      return editor.roomName(this.episode, room)?.name;
    },
    edited: (room) => this.need().isEdited(this.episode, room),
    add: (room) => {
      this.newRoom(room);
    },
    canAdd: () => this.need().rooms(this.episode).length < MAX_ROOMS,
  });
  /** Per episode: room id -> a drawing of the room and what it was drawn from. */
  private readonly thumbnails = new Map<
    number,
    Map<number, { key: string; canvas: HTMLCanvasElement }>
  >();
  private readonly roomPane = h("div", { class: "room-pane" });
  private readonly tilesTab = h("div", { class: "tiles" });
  private readonly recordTab = h(
    "div",
    {},
    h(
      "p",
      { class: "hint record-hint" },
      "Click a magenta cell, or any cell with the Inspect tool, to see its logic record here.",
    ),
  );
  private mapShown = false;
  private actors: RoomActor[] = [];
  private readonly robotSprites = new Map<number, HTMLCanvasElement[]>();
  readonly actorsView = new ActorsView({
    select: (cell) => {
      this.select(cell);
    },
    name: (type) => this.names().summary(type),
    areas: (show) => {
      this.view.setAreas(show ? PLACEMENT_AREAS : []);
    },
    icon: (type) =>
      (this.isRobot(type) ? this.robotSprite(0) : undefined) ?? this.cellPreview(type),
  });
  private readonly status = h("span", { class: "status" });
  private readonly episodeSelect = h("select", { "aria-label": "Episode" });
  private readonly roomList = h("div", { class: "room-list" });
  private readonly roomTitle = h("h2");
  private readonly roomName = h("input", {
    class: "room-name",
    "aria-label": "Room name",
    spellcheck: "false",
  });
  private readonly goInput = h("input", {
    type: "number",
    min: "1",
    max: String(MAX_ROOM_ID),
    class: "go-room",
    placeholder: "Go to room",
    "aria-label": "Go to room",
    title: "Type a room id and press Enter to open it",
  });
  readonly newRoomDialog = new NewRoomDialog({
    check: (id) => this.checkNewRoom(id),
    source: (id) =>
      this.need()
        .rooms(this.episode)
        .some((r) => r.id === id)
        ? this.roomLabel(this.episode, id)
        : undefined,
    create: (id, content, openNeighbours) => this.addRoom(id, content, openNeighbours),
    walls: () => this.need().wallCells(this.episode),
    exits: () => this.need().exitCells(this.episode),
    preview: (value) => this.cellPreview(value),
  });
  private readonly backButton = h("button", { class: "history", disabled: true }, "◀");
  private readonly forwardButton = h("button", { class: "history", disabled: true }, "▶");
  /** Rooms shown, for going back and forward like in a browser. */
  private readonly history: { episode: number; room: number }[] = [];
  private historyIndex = -1;
  /** The next room replaces the browser's current history entry instead of adding one. */
  private replaceNext = false;
  /** Removes the listeners on window (dispose). */
  private readonly listeners = new AbortController();
  private readonly exitsView: ExitsView = new ExitsView(
    {
      go: (room) => {
        this.showRoom(room);
      },
      label: (room) => this.roomLabel(this.episode, room),
      setMode: (direction, mode) => {
        this.need().setExitMode(this.episode, this.roomId, direction, mode);
        this.showRoom(this.roomId);
        this.refreshButtons();
      },
    },
    this.view.element,
  );
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
  private readonly toolInputs = new Map<Tool, HTMLInputElement>();
  private readonly areaButtons = {
    copy: areaButton("Copy", "Copy the selected area, both layers and its records (Ctrl+C)"),
    cut: areaButton("Cut", "Copy the selected area and clear it (Ctrl+X)"),
    paste: areaButton(
      "Paste",
      "Put the copied cells down where you click (Ctrl+V; Shift+click: again; Esc: stop)",
    ),
    clear: areaButton("Clear", "Empty the selected area in both layers (Delete)"),
    fill: areaButton("Fill", "Fill the selected area's cells of this layer with the tile"),
  };
  private readonly tileFilter = h("input", {
    type: "search",
    class: "tile-filter",
    placeholder: "Filter tiles: name, text or hex",
    "aria-label": "Filter tiles",
    spellcheck: "false",
  });
  readonly scriptView = new ScriptView({
    explain: (name) => this.explain(name),
    argument: (fn, index, args) => this.explainArgument(fn, index, args),
    compile: (source) => {
      const game = this.need().game;
      const options = {
        constants: game.scriptConstants(this.episode),
        keywords: game.scriptKeywords(),
      };
      return disassemble(parseCompiledScript(compileScript(source, options)));
    },
    apply: (source) => {
      this.need().setScript(this.episode, this.roomId, source);
      this.showRoom(this.roomId);
      this.refreshButtons();
    },
    hover: (fn, args) => {
      this.view.setHighlights(fn === undefined ? [] : scriptPlaces(fn, args));
    },
    names: () => {
      const game = this.need().game;
      const keywords = game.scriptKeywords().map((k): ScriptName => {
        if (!(k.flags & KEYWORD_FUNCTION)) return { name: k.name, kind: "variable" };
        const args =
          scriptFunctionDoc(k.name, k.args)?.args ??
          Array.from({ length: k.args }, (_, i) => `arg${i + 1}`);
        return { name: k.name, kind: "function", args };
      });
      const constants = [...game.scriptConstants(this.episode).keys()].map((name): ScriptName => ({
        name,
        kind: "constant",
      }));
      return [...keywords, ...constants];
    },
  });
  readonly recordView = new RecordView({
    change: (data) => {
      this.recordEdit((editor, room, slot) => editor.setRecord(this.episode, room, slot, data));
    },
    add: (type) => {
      const selected = this.selected;
      if (!selected) return;
      const editor = this.need();
      const room = editor.room(this.episode, this.roomId);
      if (
        editor.addRecord(this.episode, this.roomId, selected.layer, selected.index, type) ===
        undefined
      ) {
        this.setStatus(
          recordCapacity(room) < 1
            ? `No room for another record: the game holds ${MAX_RECORD_SLOTS} records and overlay objects per room`
            : "Cannot add a record here",
          true,
        );
        return;
      }
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
    text: (id) => {
      const texts = this.need().game.episodeTexts(this.episode)?.entries.get(id);
      const tile = (v: number) => this.names().tileName(v);
      return texts?.map((t) => displayText(t, tile)).join(" – or – ");
    },
  });
  readonly settingsView = new SettingsView({
    change: (settings) => {
      try {
        this.need().setRoomSettings(this.episode, this.roomId, settings);
      } catch (error) {
        this.setStatus(`Cannot change the room: ${message(error)}`, true);
      }
      this.showRoom(this.roomId);
      this.refreshButtons();
    },
  });
  /** Per episode: the pieces of its MUSIC resource. */
  private readonly musicPieces = new Map<number, string[]>();
  /** The pieces some room of the loaded exe plays. */
  private roomMusic: Set<string> | undefined;
  /**
   * The column right of the room: tiles, the selected record, the actors, the script,
   * the room's settings.
   */
  readonly sidePanel: SidePanel = new SidePanel(
    [
      { name: "tiles", label: "Tiles", content: this.tilesTab },
      { name: "record", label: "Record", content: this.recordTab },
      { name: "actors", label: "Actors", content: this.actorsView.element },
      { name: "script", label: "Script", content: this.scriptView.element },
      { name: "room", label: "Room", content: this.settingsView.element },
    ],
    (width) => {
      this.workspace.style.setProperty("--side-width", `${width}px`);
    },
  );
  private readonly workspace: HTMLElement;
  private readonly welcome: HTMLElement;

  private readonly options: AppOptions;

  constructor(root: HTMLElement, options: AppOptions = {}) {
    this.options = options;
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
    for (const { tool, label, title } of TOOLS) {
      const input = h("input", { type: "radio", name: "tool", value: tool });
      input.checked = tool === this.tool;
      input.addEventListener("change", () => {
        this.setTool(tool);
      });
      this.toolInputs.set(tool, input);
      tools.append(h("label", { title }, input, ` ${label}`));
    }
    const areaTools = h(
      "fieldset",
      { class: "layers area-tools" },
      h("legend", {}, "Area"),
      ...Object.values(this.areaButtons),
    );

    this.welcome = h(
      "section",
      { class: "welcome" },
      h("p", {}, "Open ", h("code", {}, "GameOfRobot.exe"), " or drop it here."),
      h("p", { class: "hint" }, "The file is read in your browser and never uploaded."),
    );
    this.workspace = h(
      "div",
      { class: "workspace", hidden: true },
      h(
        "nav",
        { class: "rooms" },
        this.episodeSelect,
        h(
          "div",
          { class: "room-add" },
          this.goInput,
          h(
            "button",
            {
              title: "Add a room: empty or a copy of the shown one (also from the map's + slots)",
              click: () => {
                this.newRoom();
              },
            },
            "New room…",
          ),
        ),
        this.roomList,
      ),
      h(
        "main",
        {},
        h(
          "div",
          { class: "room-head" },
          this.backButton,
          this.forwardButton,
          this.roomTitle,
          this.roomName,
          h(
            "button",
            {
              class: "room-delete danger",
              title: "Delete the shown room (asks first, naming the rooms that lead to it)",
              click: () => {
                void this.removeRoom();
              },
            },
            "Delete room…",
          ),
        ),
        this.roomPane,
        this.mapView.element,
      ),
      this.sidePanel.element,
    );
    this.sidePanel.setHeader(tools, layers, areaTools);
    this.tilesTab.append(
      h("label", { class: "tile-current" }, this.tilePreview, this.tileInput),
      this.tileText,
      h(
        "p",
        { class: "hint" },
        "Paint with the left button, pick with the right. Magenta cells belong to logic records and stay as they are.",
      ),
      this.tileFilter,
      this.tileGrid,
    );
    const width = SidePanel.savedWidth();
    if (width !== undefined) this.workspace.style.setProperty("--side-width", `${width}px`);
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
        this.testButton,
        this.undoButton,
        this.redoButton,
        h("label", {}, this.gridToggle, " Grid"),
        h("label", { title: "Where actors appear (A)" }, this.actorsToggle, " Actors"),
        this.mapButton,
        this.status,
      ),
      this.welcome,
      this.workspace,
      this.newRoomDialog.element,
    );
    this.roomPane.append(this.exitsView.element, this.cellInfo, this.cellText);
    this.recordTab.append(this.recordView.element);
    this.mapButton.textContent = "Map";
    this.mapView.element.hidden = true;
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
    this.stopPasting();
    this.clip = undefined;
    this.clipImage = undefined;
    this.refreshAreaButtons();
    this.tileNames.clear();
    this.robotSprites.clear();
    this.thumbnails.clear();
    this.musicPieces.clear();
    this.roomMusic = undefined;
    this.welcome.hidden = true;
    this.workspace.hidden = false;
    this.testButton.disabled = false;
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
            title: this.roomLabel(episode, r.id),
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
    this.showRoomName(id);
    this.roomTitle.textContent = `${EPISODE_NAMES[this.episode] ?? ""} – room ${id}`;
    const room = editor.room(this.episode, id);
    // outlines shown while hovering the actor list or the script belong to the old room:
    // their rows are replaced without a mouseleave
    this.view.setAreas([]);
    this.view.setHighlights([]);
    this.view.show(room, this.cache());
    this.connections = connections(
      room,
      new Set(editor.rooms(this.episode).map((r) => r.id)),
      editor.game.episode(this.episode).classes,
    );
    this.exitsView.show(this.connections);
    this.scriptView.show(roomScript(room), `${this.episode} ${id}`);
    this.showSettings(room);
    this.refreshActors();
    this.refreshRoomList();
    const shown = `${this.episode} ${id}`;
    if (this.lastRoom !== shown) {
      if (this.selected) this.select(undefined);
      this.setArea(undefined);
    }
    this.lastRoom = shown;
    this.remember(this.episode, id);
    if (this.mapShown) this.refreshMap();
  }

  /** The Room tab: the shown room's tags (darkness, points, music, flags). */
  private showSettings(room: Room): void {
    const game = this.need().game;
    let pieces = this.musicPieces.get(this.episode);
    if (!pieces) {
      try {
        pieces = game.musicPieces(this.episode);
      } catch {
        pieces = []; // a MUSIC resource that is not understood: offer no pieces
      }
      this.musicPieces.set(this.episode, pieces);
    }
    // from the scenes only: loading every episode (shapes, classes) would take long
    this.roomMusic ??= new Set(
      EPISODES.flatMap((e) =>
        parseScene(cryptScene(game.resource("SCENE", sceneId(e)).data)).map(
          (r) => roomSettings(r).music,
        ),
      ),
    );
    this.settingsView.show(roomSettings(room), {
      episode: this.episode,
      pieces,
      roomMusic: this.roomMusic,
      saved: roomSaveTime(room),
    });
  }

  /** The name field: the name the game shows, editable where the game shows names. */
  private showRoomName(id: number): void {
    const editor = this.need();
    const name = editor.roomName(this.episode, id);
    const named = editor.nameRoom(this.episode, id);
    this.roomName.value = name?.name ?? "";
    this.roomName.placeholder = named === undefined ? `Szene ${id}` : `Szene ${id} (no name)`;
    this.roomName.disabled = named === undefined;
    this.roomName.title = [
      named !== undefined && named !== id ? `the name of room ${named}` : "",
      name?.description ?? "",
      named === undefined
        ? `The game shows no names for rooms from ${String(NAMED_ROOMS[this.episode])} on.`
        : "Type a new name and press Enter (empty: none).",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** Renames the shown room (see Editor.setRoomName). */
  setRoomName(name: string): void {
    try {
      if (this.need().setRoomName(this.episode, this.roomId, name)) this.afterRename();
    } catch (error) {
      this.setStatus(`Cannot rename: ${message(error)}`, true);
    }
    this.showRoomName(this.roomId);
  }

  private afterRename(): void {
    this.refreshRoomList();
    this.refreshButtons();
    this.remember(this.episode, this.roomId); // labels of back/forward
    if (this.mapShown) this.refreshMap();
  }

  /**
   * Adds room `id` (empty, walled or a copy, see Editor.addRoom), optionally opening the
   * closed exits of its neighbours towards it, and shows it; returns whether it worked.
   */
  addRoom(id: number, content: NewRoomContent = "empty", openNeighbours = false): boolean {
    let edit: Edit;
    try {
      edit = this.need().addRoom(this.episode, id, content, openNeighbours);
    } catch (error) {
      this.setStatus(`Cannot add room ${id}: ${message(error)}`, true);
      return false;
    }
    this.showEpisode(this.episode, id);
    this.refreshButtons();
    const opened = (edit.parts ?? []).slice(1).map((p) => p.room);
    const exits = opened.length ? `, exits of ${opened.join(", ")} opened towards it` : "";
    const added =
      typeof content === "object" && "copy" in content
        ? `Room ${content.copy} copied to room ${id}`
        : `Room ${id} added`;
    this.setStatus(`${added}${exits}`);
    return true;
  }

  /**
   * Asks for a new room (NewRoomDialog): `id` filled in (else a free one after the shown
   * room), the shown room offered as a copy.
   */
  newRoom(id?: number): void {
    const editor = this.need();
    this.newRoomDialog.show(
      EPISODE_NAMES[this.episode] ?? "",
      id ?? editor.freeRoomId(this.episode, this.roomId),
      this.roomId,
    );
  }

  /** What the new room dialog says about an id: free or not, where, what it borders. */
  checkNewRoom(id: number): NewRoomCheck {
    const editor = this.need();
    const problem = editor.roomIdProblem(this.episode, id);
    if (problem !== undefined) {
      return { problem: `${capitalize(problem)}.`, lines: [], closed: 0 };
    }
    const neighbours = editor.gridNeighbours(this.episode, id);
    const state: Record<ExitMode, string> = {
      neighbour: "its exit leads here",
      none: "its exit is closed",
      outside: "its exit leads outside (room 2)",
    };
    const floor = (room: number) => Math.floor(room / 100);
    // grid neighbours the map does not draw next to it (the game adds ±1, ±10 to the id)
    const far = (n: GridNeighbour) =>
      floor(n.room) !== floor(id)
        ? `, in rooms ${floor(n.room) * 100}–${floor(n.room) * 100 + 99}`
        : (n.direction === "west" || n.direction === "east") &&
            Math.floor(n.room / 10) !== Math.floor(id / 10)
          ? `, at the ${n.direction === "west" ? "end of the row above" : "start of the row below"}`
          : "";
    const lines = neighbours.map(
      (n) =>
        `${capitalize(n.direction)}: ${this.roomLabel(this.episode, n.room)} (${state[n.mode]}${far(n)})`,
    );
    if (lines.length === 0) {
      lines.push(
        "No room next to it: reach it by stairs or a door (room ± 100), a teleporter or the script.",
      );
    }
    const ids = new Set(editor.rooms(this.episode).map((r) => r.id));
    const levels = [id - 100, id + 100].filter((r) => ids.has(r));
    if (levels.length) {
      lines.push(
        `Stairs or doors can lead here from ${levels.map((r) => `room ${r}`).join(" and ")}.`,
      );
    }
    if (wrapsRow(id)) {
      lines.unshift(
        `No original room id ends in 0: walking west from room ${id} leads to room ${id - 1} at the end of the row above, east from room ${id - 1} leads here.`,
      );
    }
    return { lines, closed: neighbours.filter((n) => n.mode === "none").length };
  }

  /** Opens room `id` if the episode has it (the Go to room field). */
  goTo(id: number): void {
    if (
      this.need()
        .rooms(this.episode)
        .some((r) => r.id === id)
    ) {
      this.setMap(false, id);
      this.goInput.value = "";
    } else {
      this.setStatus(
        `${EPISODE_NAMES[this.episode] ?? ""} has no room ${id} (New room… adds rooms)`,
        true,
      );
    }
  }

  /** The rooms of the episode with an exit, passage, record or script line to room `id`. */
  roomsLeadingTo(id: number): number[] {
    const editor = this.need();
    const rooms = editor.rooms(this.episode);
    const ids = new Set(rooms.map((r) => r.id));
    const classes = editor.game.episode(this.episode).classes;
    return rooms
      .filter((r) => r.id !== id && leadsTo(connections(r, ids, classes), id))
      .map((r) => r.id);
  }

  /** Deletes the shown room (after asking, naming the rooms that lead to it). */
  async removeRoom(): Promise<void> {
    const id = this.roomId;
    const from = this.roomsLeadingTo(id);
    const links = from.length
      ? `\nRooms leading to it (they would lead nowhere): ${from.join(", ")}.`
      : "";
    const question = `Delete ${this.roomLabel(this.episode, id)}?${links}\nUndo brings it back.`;
    if (!(await confirmDialog(question, { action: "Delete room", danger: true }))) return;
    try {
      this.need().removeRoom(this.episode, id);
    } catch (error) {
      this.setStatus(`Cannot delete room ${id}: ${message(error)}`, true);
      return;
    }
    this.showEpisode(this.episode, this.lastSeen(this.episode));
    this.refreshButtons();
    this.setStatus(`Room ${id} deleted`);
  }

  /** The room shown last in an episode that still exists. */
  private lastSeen(episode: number, first?: number): number | undefined {
    const rooms = this.need().rooms(episode);
    const seen = this.history
      .slice(0, this.historyIndex + 1)
      .reverse()
      .filter((entry) => entry.episode === episode)
      .map((entry) => entry.room);
    return [first, ...seen].find((id) => rooms.some((r) => r.id === id));
  }

  /**
   * Starts the game in the shown room with all edits (Editor.testExe): the hero at the
   * selected cell, else where the episode puts it. Without a way to run the game the
   * exe is downloaded.
   */
  async testInGame(): Promise<void> {
    const editor = this.need();
    const index = this.selected?.index;
    const at =
      index === undefined
        ? undefined
        : { x: index % ROOM_WIDTH, y: Math.floor(index / ROOM_WIDTH) };
    let exe: Uint8Array;
    try {
      exe = editor.testExe(this.episode, this.roomId, at);
    } catch (error) {
      this.setStatus(`Cannot build the exe: ${message(error)}`, true);
      return;
    }
    const episode = EPISODE_NAMES[this.episode] ?? "";
    const where = `${episode} starts in room ${this.roomId}${at ? ` at (${at.x}, ${at.y})` : ""}`;
    if (this.options.play) {
      try {
        await this.options.play(exe, this.episode);
        this.setStatus(`Game started: choose ${episode}, it ${where.slice(episode.length + 1)}`);
        return;
      } catch (error) {
        this.setStatus(`Cannot start the game (${message(error)}), downloading the exe`, true);
      }
    }
    const name = this.fileName.replace(/(\.exe)?$/i, `-room${this.roomId}.exe`);
    download(exe, name);
    if (!this.options.play) this.setStatus(`Saved ${name}: ${where}`);
  }

  /** "room 43 – DER START": a room with the name the game shows for it. */
  private roomLabel(episode: number, id: number): string {
    const editor = this.need();
    const name = editor.rooms(episode).some((r) => r.id === id)
      ? editor.roomName(episode, id)
      : undefined;
    return name ? `room ${id} – ${name.name}` : `room ${id}`;
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
    // a room deleted, or added and undone again
    if (!this.editor.rooms(state.episode).some((r) => r.id === state.room)) return;
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
        ? `${what} to ${entry.episode === episode ? "" : `${EPISODE_NAMES[entry.episode] ?? ""} `}${this.roomLabel(entry.episode, entry.room)}`
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
    // new records go into the base layer: the game drops logic cells in the overlay
    const layer = this.logicLayer(index) ?? "base";
    this.selected = { index, layer };
    const room = this.need().room(this.episode, this.roomId);
    const cell = room[layer][index] ?? 0;
    const where = `(${index % ROOM_WIDTH}, ${Math.floor(index / ROOM_WIDTH)}) ${layer}`;
    const record =
      (cell & 0xff) === LOGIC_CELL ? room.records.find((r) => r.slot === cell >> 8) : undefined;
    const game = this.need().game;
    if (record) {
      const classes = game.episode(this.episode).classes;
      this.recordView.show(record, where, classes, readOracleSymbols(game.image));
    } else this.recordView.showEmpty(where);
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
    // one inline element: the line clamp (-webkit-box) would put each child on a line
    this.tileText.replaceChildren(
      h(
        "span",
        {},
        ...this.names().summaryNodes(value, undefined, (v) => cellCanvas(this.cache(), v)),
      ),
    );
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

  setTool(tool: Tool): void {
    this.tool = tool;
    const input = this.toolInputs.get(tool);
    if (input) input.checked = true;
    if (tool !== "select") this.setArea(undefined);
  }

  /** Selects an area of the shown room (undefined: none). */
  setArea(area: Area | undefined): void {
    this.area = area && clipArea(area);
    this.view.setSelection(this.area);
    this.refreshAreaButtons();
    if (this.area) {
      const { x, y, w, h } = this.area;
      this.setStatus(`Area ${w}×${h} at (${x}, ${y}): Ctrl+C copy, Ctrl+X cut, Delete clear`);
    }
  }

  /** Copies the selected area (both layers, the records of its logic cells). */
  copyArea(): void {
    if (!this.area) return;
    this.clip = this.need().copyArea(this.episode, this.roomId, this.area);
    this.clipImage = undefined;
    this.refreshAreaButtons();
    const records = this.clip.records.length;
    this.setStatus(
      `Copied ${this.clip.w}×${this.clip.h} cells${records ? ` with ${records} record${records > 1 ? "s" : ""}` : ""}: Ctrl+V pastes`,
    );
  }

  cutArea(): void {
    if (!this.area) return;
    this.copyArea();
    this.clearArea();
  }

  /** Empties the selected area in both layers. */
  clearArea(): void {
    const area = this.area;
    if (!area) return;
    this.areaEdit(() => this.need().clearArea(this.episode, this.roomId, area));
  }

  /** Fills the selected area's cells of the current layer with the tile (one stroke). */
  fillArea(): void {
    if (!this.area) return;
    this.paintCells(areaCells(this.area));
  }

  /** Fills the cells of the clicked value around a cell (within the area, if inside). */
  fill(index: number): void {
    const room = this.need().room(this.episode, this.roomId);
    const area = this.area && areaCells(this.area).includes(index) ? this.area : undefined;
    this.paintCells(fillRegion(room, this.layer, index, area));
  }

  /** The clip follows the mouse; a click puts it down. */
  startPasting(): void {
    if (!this.clip || !this.editor) return;
    this.pasting = true;
    this.areaButtons.paste.classList.add("pressed");
    const from =
      this.clip.episode === this.episode
        ? ""
        : ` (from ${EPISODE_NAMES[this.clip.episode] ?? ""}: its tiles may mean other things here)`;
    this.setStatus(
      `Click where the top left cell goes (Shift+click: paste again, Esc: stop)${from}`,
    );
    if (this.pasteCell !== undefined) this.showPaste(this.pasteCell);
  }

  stopPasting(): void {
    this.pasting = false;
    this.areaButtons.paste.classList.remove("pressed");
    this.view.setFloating(undefined);
  }

  /** Puts the clip down with its top left cell at `index`; `again` keeps pasting. */
  pasteClip(index: number, again = false): void {
    const clip = this.clip;
    if (!clip) return;
    const [x, y] = [index % ROOM_WIDTH, Math.floor(index / ROOM_WIDTH)];
    try {
      this.areaEdit(() => this.need().pasteArea(this.episode, this.roomId, x, y, clip));
    } catch (error) {
      this.setStatus(`Cannot paste: ${message(error)}`, true);
      return;
    }
    if (!again) this.stopPasting();
    this.setArea({ x, y, w: clip.w, h: clip.h });
    if (again) this.showPaste(index);
  }

  private showPaste(index: number): void {
    const clip = this.clip;
    this.pasteCell = index;
    if (!clip) return;
    if (this.clipImage?.episode !== this.episode) {
      const canvas = cellsCanvas(this.cache(), clip.w, clip.base, clip.overlay, clip.records);
      this.clipImage = { episode: this.episode, canvas };
    }
    const [x, y] = [index % ROOM_WIDTH, Math.floor(index / ROOM_WIDTH)];
    this.view.setFloating({ x, y, image: this.clipImage.canvas });
  }

  /** Applies an area edit (cells of both layers and records) and redraws the room. */
  private areaEdit(change: () => Edit | undefined): void {
    if (!change()) return;
    const area = this.area;
    this.showRoom(this.roomId);
    this.setArea(area);
    if (this.selected) this.select(this.selected.index);
    this.refreshButtons();
  }

  /** Paints the tile into cells as one stroke. */
  private paintCells(cells: readonly number[]): void {
    const editor = this.need();
    this.beginStroke();
    const changed = cells.filter((i) => editor.paint(i, this.tile));
    if (changed.length > 0) this.view.update(editor.room(this.episode, this.roomId), changed);
    this.endStroke();
  }

  private refreshAreaButtons(): void {
    for (const button of [
      this.areaButtons.copy,
      this.areaButtons.cut,
      this.areaButtons.clear,
      this.areaButtons.fill,
    ]) {
      button.disabled = !this.area;
    }
    this.areaButtons.paste.disabled = !this.clip;
  }

  /** Shows the palette tiles whose hex value, name or text contain the filter. */
  private filterTiles(): void {
    const query = this.tileFilter.value.trim().toLowerCase();
    for (const button of this.tileGrid.querySelectorAll<HTMLElement>("button")) {
      const value = Number(button.dataset["tile"]);
      const text = `${hex(value)} ${button.title}`.toLowerCase();
      button.hidden = query !== "" && !text.includes(query);
    }
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
      download(bytes, this.fileName);
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
    this.testButton.addEventListener("click", () => {
      void this.testInGame();
    });
    this.roomName.addEventListener("change", () => {
      this.setRoomName(this.roomName.value);
    });
    this.roomName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.roomName.blur();
      else if (event.key === "Escape") {
        this.showRoomName(this.roomId);
        this.roomName.blur();
      }
    });
    this.goInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      this.goTo(Number(this.goInput.value));
    });
    this.areaButtons.copy.addEventListener("click", () => {
      this.copyArea();
    });
    this.areaButtons.cut.addEventListener("click", () => {
      this.cutArea();
    });
    this.areaButtons.paste.addEventListener("click", () => {
      this.startPasting();
    });
    this.areaButtons.clear.addEventListener("click", () => {
      this.clearArea();
    });
    this.areaButtons.fill.addEventListener("click", () => {
      this.fillArea();
    });
    this.tileFilter.addEventListener("input", () => {
      this.filterTiles();
    });
    this.undoButton.addEventListener("click", () => {
      this.undo();
    });
    this.redoButton.addEventListener("click", () => {
      this.redo();
    });
    this.mapButton.addEventListener("click", () => {
      this.setMap(!this.mapShown);
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
      if (this.pasting) {
        if (event.button === 0) this.pasteClip(index, event.shiftKey);
        else this.stopPasting();
      } else if (event.button === 2 || event.altKey) this.pick(index);
      else if (event.button !== 0) return;
      else if (this.tool === "select") {
        this.selectFrom = index;
        this.setArea(areaBetween(index, index));
      } else if (this.tool === "inspect" || this.logicLayer(index)) {
        this.select(index);
        this.sidePanel.show("record");
      } else if (this.tool === "fill") this.fill(index);
      else {
        this.painting = true;
        this.beginStroke();
        this.paintTo(index);
      }
    });
    view.addEventListener("mousemove", (event) => {
      const index = this.view.cellAt(event);
      this.view.setHover(index);
      this.showCellInfo(index);
      if (index === undefined) return;
      if (this.painting) this.paintTo(index);
      if (this.selectFrom !== undefined) this.setArea(areaBetween(this.selectFrom, index));
      if (this.pasting) this.showPaste(index);
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
        this.selectFrom = undefined;
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
        if (!this.editor.rooms(linked.episode).some((r) => r.id === linked.room)) return;
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
        // checkboxes and radio buttons (the tools, the layers) keep their arrow keys only
        const toggle =
          target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type);
        if (
          !this.editor ||
          (target instanceof HTMLInputElement && !toggle) ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (toggle && event.key.startsWith("Arrow")) ||
          (target instanceof HTMLElement && target.isContentEditable) // the script editor
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
        const ctrl = event.ctrlKey || event.metaKey;
        if (event.key === "Escape") {
          if (this.pasting) this.stopPasting();
          else this.setArea(undefined);
        } else if (event.key === "Delete" && !ctrl) {
          this.clearArea();
        } else if (ctrl && !event.shiftKey && !event.altKey && key === "c") {
          if (this.area) {
            event.preventDefault();
            this.copyArea();
          }
        } else if (ctrl && !event.shiftKey && !event.altKey && key === "x") {
          if (this.area) {
            event.preventDefault();
            this.cutArea();
          }
        } else if (ctrl && !event.shiftKey && !event.altKey && key === "v") {
          event.preventDefault();
          this.startPasting();
        } else if ((event.ctrlKey || event.metaKey) && key === "z") {
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
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "m") {
          this.setMap(!this.mapShown);
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
    this.refreshAreaButtons();
  }

  private async loadFile(file: File): Promise<void> {
    const question = "Open another exe and discard the unsaved changes?";
    if (
      this.editor?.dirty &&
      !(await confirmDialog(question, { action: "Discard changes", danger: true }))
    )
      return;
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
    // (assigned once here: the view redraws its marks on every mouse move)
    let robots = 0;
    const sprites = this.actors.map((actor) =>
      actor.source === "tile" && actor.type !== undefined && this.isRobot(actor.type)
        ? this.robotSprite(robots++)
        : undefined,
    );
    this.view.setActors(this.actorsToggle.checked ? this.actors : [], (_, n) => sprites[n]);
    const classes = editor.game.episode(this.episode).classes;
    const constants = editor.game.scriptConstants(this.episode);
    this.actorsView.show(
      this.actors,
      scriptActors(roomScript(room)).map((call) => ({
        call,
        placement: randomPlacement(call, room, classes, constants),
      })),
    );
  }

  private pick(index: number): void {
    const cell = this.need().room(this.episode, this.roomId)[this.layer][index] ?? 0;
    if ((cell & 0xff) !== LOGIC_CELL) this.setTile(cell);
  }

  /** Shows the room of an undone or redone edit. */
  private revisit(edit: Edit | undefined): void {
    if (!edit) return;
    const editor = this.need();
    if (edit.added || edit.removed) {
      // the room list changes: show the room, or the last room seen that still exists
      this.showEpisode(edit.episode, this.lastSeen(edit.episode, edit.room));
    } else if (edit.episode !== this.episode) this.showEpisode(edit.episode, edit.room);
    else if (edit.room !== this.roomId) this.showRoom(edit.room);
    else if (edit.records || edit.tags || edit.text) {
      // records change what logic cells show and where things lead: redraw everything
      this.showRoom(this.roomId);
      if (this.selected) this.select(this.selected.index);
    } else {
      this.view.update(
        editor.room(this.episode, this.roomId),
        edit.changes.map((c) => c.index),
      );
      // painted cells may be actors (as at the end of a stroke)
      this.refreshActors();
    }
    this.refreshRoomList();
    this.refreshButtons();
    if (this.mapShown) this.refreshMap();
  }

  /**
   * Shows the episode's map instead of the room, or a room again (`room`, else the shown
   * one): drawn anew, as edits on the map may have changed it.
   */
  setMap(shown: boolean, room = this.roomId): void {
    if (!this.editor) return;
    this.mapShown = shown;
    this.mapButton.setAttribute("aria-pressed", String(shown));
    this.mapButton.classList.toggle("pressed", shown);
    this.roomPane.hidden = shown;
    this.mapView.element.hidden = !shown;
    this.workspace.classList.toggle("map-mode", shown);
    if (shown) this.refreshMap();
    else this.showRoom(room);
  }

  private refreshMap(): void {
    const editor = this.need();
    const classes = editor.game.episode(this.episode).classes;
    this.mapView.show(editor.rooms(this.episode), this.roomId, classes);
  }

  /**
   * A drawing of a room for the map: kept while the room's cells and records stay the
   * same, drawn a little later (rooms are many) when new.
   */
  private thumbnail(id: number): HTMLCanvasElement {
    const editor = this.need();
    const room = editor.room(this.episode, id);
    let cache = this.thumbnails.get(this.episode);
    if (!cache) {
      cache = new Map();
      this.thumbnails.set(this.episode, cache);
    }
    const key = roomKey(room);
    const known = cache.get(id);
    if (known?.key === key) return known.canvas;
    const canvas = known?.canvas ?? h("canvas", { class: "map-thumbnail" });
    cache.set(id, { key, canvas });
    const cells = this.cache();
    setTimeout(() => {
      drawRoom(canvas, room, cells);
    });
    return canvas;
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
            title: this.tileTitle(value),
            click: () => {
              this.setTile(value);
            },
          },
          this.tileCanvas(value),
        ),
      ),
    );
    this.setTile(tiles.includes(this.tile) ? this.tile : 0);
    this.filterTiles();
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
    if (record) {
      const classes = this.editor.game.episode(this.episode).classes;
      this.cellInfo.textContent += `  · ${describeRecord(record, classes).summary}`;
    }
    const actor = this.actors.find((a) => a.cell === index);
    if (actor) this.cellInfo.textContent += `  · actor: ${actorOrigin(actor)}`;
    // what the hero would see: the overlay object if there is one
    const nodes = this.names().summaryNodes(overlay & 0xff ? overlay : base, room, (v) =>
      cellCanvas(this.cache(), v),
    );
    if (nodes.length) this.cellText.replaceChildren(...nodes);
    else this.cellText.textContent = "\u00a0";
  }

  private refreshRoomList(): void {
    const editor = this.need();
    for (const button of this.roomList.querySelectorAll<HTMLElement>("button")) {
      const id = Number(button.dataset["room"]);
      button.classList.toggle("current", id === this.roomId);
      button.classList.toggle("edited", editor.isEdited(this.episode, id));
      button.title = this.roomLabel(this.episode, id);
    }
    this.roomList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  private refreshButtons(): void {
    const editor = this.need();
    this.undoButton.disabled = !editor.canUndo;
    this.redoButton.disabled = !editor.canRedo;
    this.saveButton.disabled = !editor.dirty;
    // unsaved changes: saving is the thing to do
    this.saveButton.classList.toggle("primary", editor.dirty);
  }

  /**
   * A tile for the palette. Tiles that draw nothing show what they are instead: robots
   * their first sprite (the game turns them into actors), others a hatching (invisible in
   * the game, e.g. the marker 0x54 of rooms named after the room 100 below).
   */
  private tileCanvas(value: number): HTMLCanvasElement {
    const [base, overlay] = this.layer === "base" ? [value, 0] : [0, value];
    const element = cellCanvas(this.cache(), base, overlay);
    if (value === 0 || !this.drawsNothing(base, overlay)) return element;
    const g = element.getContext("2d");
    const sprite = this.isRobot(value & 0xff) ? this.robotSprite(0) : undefined;
    if (g && sprite) {
      g.drawImage(sprite, 0, 0, element.width, element.height);
    } else if (g) {
      g.strokeStyle = "rgb(150 150 150)";
      g.lineWidth = 1;
      for (let x = -element.height; x < element.width; x += 4) {
        g.beginPath();
        g.moveTo(x, element.height);
        g.lineTo(x + element.height, 0);
        g.stroke();
      }
    }
    return element;
  }

  /** Whether a cell looks like an empty one. */
  private drawsNothing(base: number, overlay: number): boolean {
    const cell = this.cache().get(base, overlay).data;
    const empty = this.cache().get(0, 0).data;
    return cell.every((v, i) => v === empty[i]);
  }

  /** What a palette tile is, with a note on tiles drawn differently in the palette. */
  private tileTitle(value: number): string {
    const title = this.names().title(value);
    const [base, overlay] = this.layer === "base" ? [value, 0] : [0, value];
    if (value === 0 || !this.drawsNothing(base, overlay)) return title;
    const note = this.isRobot(value & 0xff)
      ? "(a robot: the game turns it into an actor with one of its robot sprites)"
      : "(draws nothing in the game)";
    const [head, ...rest] = title.split("\n");
    return [`${head} ${note}`, ...rest].join("\n");
  }

  /** What a name in a script means: a function, a game variable or an object. */
  private explain(name: string): string | undefined {
    const game = this.need().game;
    const type = game.scriptConstants(this.episode).get(name);
    if (type !== undefined) {
      const what = this.names().summary(type);
      return `tile type ${type} (0x${type.toString(16)})${what ? `: ${what}` : ""}`;
    }
    return scriptDoc(name, game.scriptKeywords());
  }

  /** What a number passed to a script function refers to (a text, a room), if known. */
  private explainArgument(
    fn: string,
    index: number,
    args: readonly (number | undefined)[],
  ): string | undefined {
    const value = args[index];
    if (value === undefined) return undefined;
    const kind = scriptArgument(fn, index, args.length);
    const game = this.need().game;
    if (kind === "room") return this.roomLabel(this.episode, value);
    if (kind === "enigma") {
      const entry = readEventTable(game.image, this.episode).at(value);
      if (!entry || value < 0) return `entry ${value} (missing)`;
      const text = game.episodeTexts(this.episode)?.entries.get(EVENT_TEXT + value)?.[0];
      const shown = text === undefined ? "" : `, text ${EVENT_TEXT + value}:\n${displayText(text)}`;
      return `entry ${value}: ${entry.points} points${shown}`;
    }
    if (kind !== "text") return undefined;
    const variants = game
      .episodeTexts(this.episode)
      ?.entries.get(value)
      ?.map((t) => displayText(t, (v) => this.names().tileName(v)));
    if (!variants) return `text ${value} (missing)`;
    if (variants.length === 1) return variants[0];
    const shown = scriptTextVariants(fn, args);
    if (shown === "random") return `One of these at random:\n${variants.join("\n– or –\n")}`;
    const pages = variants.map((v, i) => `[${i + 1}/${variants.length}] ${v}`).join("\n\n");
    if (shown === "pages") return `${variants.length} pages, one after another:\n${pages}`;
    const how =
      fn.toUpperCase() === "MESSAGE"
        ? "pages one after another, or one of them at random if the delay is 0"
        : "how the game shows them is not decoded";
    return `${variants.length} parts (${how}):\n${pages}`;
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

/** A short fingerprint of what a room looks like (its cells and records). */
function roomKey(room: Room): string {
  let hash = 0x811c9dc5;
  const mix = (v: number) => {
    hash = Math.imul(hash ^ v, 0x01000193);
  };
  for (const v of room.base) mix(v);
  for (const v of room.overlay) mix(v);
  for (const r of room.records) {
    mix(r.slot);
    for (const b of r.data) mix(b);
  }
  return `${hash >>> 0} ${room.records.length}`;
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A button of the Area tools, named "<label> area" for screen readers. */
function areaButton(label: string, title: string): HTMLButtonElement {
  return h("button", { title, "aria-label": `${label} area` }, label);
}

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

/** Offers bytes as a file download. */
function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/vnd.microsoft.portable-executable" }),
  );
  h("a", { href: url, download: name }).click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
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
