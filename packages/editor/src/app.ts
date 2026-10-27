import {
  ACTOR_RECORD,
  CIRCUIT_NODE_RECORD,
  DEALER_CLASS,
  type Direction,
  EPISODES,
  EPISODE_NAMES,
  EVENT_TEXT,
  type ExitMode,
  GATE_CLASS,
  Game,
  KEYWORD_FUNCTION,
  LETTER_CLASS,
  LOGIC_CELL,
  MAX_ROOMS,
  NAMED_ROOMS,
  PLACEMENT_AREAS,
  ROBOT_CLASSES,
  ROOM_WIDTH,
  type Room,
  type RoomActor,
  SCRIPT_EVENTS,
  START_ROOMS,
  actorKindClass,
  backdropRoom,
  cellGood,
  compileScript,
  cryptScene,
  darkPalette,
  darknessBlock,
  describeRecord,
  disassemble,
  displayText,
  eventTextsId,
  exitMode,
  goodTile,
  modJson,
  nodeBulb,
  parseCompiledScript,
  parseMod,
  parseScene,
  randomPlacement,
  readDealer,
  readEventTable,
  readOracleSymbols,
  recordActorKind,
  roomActors,
  roomCircuit,
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
import { CircuitView } from "./circuit-view.ts";
import { confirmDialog } from "./confirm-dialog.ts";
import { DealerView } from "./dealer-view.ts";
import {
  type Area,
  type Clip,
  type Edit,
  Editor,
  type GridNeighbour,
  type Interior,
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
import { showHelp } from "./help-dialog.ts";
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
import { type SettingsContext, SettingsView } from "./settings-view.ts";
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

/** The tools; `key` chooses one (see the help). */
const TOOLS: readonly { tool: Tool; label: string; key: string; title: string }[] = [
  {
    tool: "paint",
    label: "Paint",
    key: "p",
    title: "Paint cells with the tile; dragging draws lines (P)",
  },
  {
    tool: "fill",
    label: "Fill",
    key: "f",
    title:
      "Fill the cells of the clicked cell's value around it (within the selected area, if inside) (F)",
  },
  {
    tool: "select",
    label: "Select",
    key: "s",
    title: "Drag to select an area to copy, cut, clear or fill (S)",
  },
  {
    tool: "inspect",
    label: "Inspect",
    key: "i",
    title:
      "Click a cell to see what is there: its logic record, else its actor or circuit, in their tab (I)",
  },
];

/** Tiles kept per episode in the Tiles tab's row of recent ones. */
const RECENT_TILES = 12;

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
  private readonly caches = new Map<string, CellCache>();
  private fileName = "GameOfRobot.exe";
  /** The mod being edited (its file name), once one was opened or saved. */
  private modFile: string | undefined;
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
  private readonly modInput = h("input", { type: "file", accept: ".json", hidden: true });
  private readonly openModButton = h(
    "button",
    {
      disabled: true,
      title:
        "Open a mod (.robotmod.json): the changes it makes to the exe, which saving the mod writes back with the edits",
    },
    "Open mod…",
  );
  private readonly saveModButton = h(
    "button",
    {
      disabled: true,
      title: "Save the edits, and the opened mod's changes, as a mod for this exe",
    },
    "Save mod",
  );
  private readonly testButton = h(
    "button",
    {
      disabled: true,
      title:
        "Start the game in this room, with all edits: the hero starts at the cell picked with Select or Inspect, else where the episode puts it",
    },
    "Test in game",
  );
  private readonly undoButton = h("button", { disabled: true, title: "Ctrl+Z" }, "Undo");
  private readonly redoButton = h("button", { disabled: true, title: "Ctrl+Y" }, "Redo");
  private readonly gridToggle = h("input", { type: "checkbox" });
  /** Draws rooms as dark as the game does on entering them (their darkness setting). */
  private readonly darkToggle = h("input", { type: "checkbox" });
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
    exists: (room) => this.need().hasRoom(this.episode, room),
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
  /** The room's records, shown while no cell is selected. */
  private readonly recordList = h("div", { class: "record-list" });
  private readonly recordTab = h(
    "div",
    {},
    this.recordList,
    h(
      "p",
      { class: "hint record-hint" },
      "Click a magenta cell, or any cell with the Inspect tool, to see its logic record here (Escape: back to this list).",
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
  readonly circuitView = new CircuitView({
    select: (cell) => {
      this.select(cell);
    },
    open: (cell) => {
      this.select(cell);
      this.sidePanel.show("record");
    },
    piece: (value) => {
      this.setTile(value);
      this.setTool("paint");
    },
    preview: (value) => this.cellPreview(value),
    signals: () => {
      this.refreshCircuit();
    },
    addNode: () => {
      this.addRecord(CIRCUIT_NODE_RECORD);
    },
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
      this.need().hasRoom(this.episode, id) ? this.roomLabel(this.episode, id) : undefined,
    interior: (id) => this.describeInterior(id),
    interiorStairs: (id) => this.interiorStairs(id),
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
  /** The tiles painted with last, per episode, most recent first. */
  private readonly recentTiles = new Map<number, number[]>();
  private readonly recentRow = h("div", {
    class: "tile-recent",
    role: "group",
    "aria-label": "Recent tiles",
  });
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
      const constants = [...SCRIPT_EVENTS.keys(), ...game.scriptConstants(this.episode).keys()].map(
        (name): ScriptName => ({ name, kind: "constant" }),
      );
      return [...keywords, ...constants];
    },
    drafted: () => {
      if (!this.editor) return;
      this.refreshScriptTab();
      this.markDrafts();
    },
  });
  readonly recordView = new RecordView({
    change: (data) => {
      this.recordEdit((editor, room, slot) => editor.setRecord(this.episode, room, slot, data));
    },
    add: (type) => {
      this.addRecord(type);
    },
    remove: () => {
      const selected = this.selected;
      if (!selected) return;
      this.need().removeRecord(this.episode, this.roomId, selected.layer, selected.index);
      this.afterRecordEdit();
    },
    go: (room) => {
      if (this.need().hasRoom(this.episode, room)) this.showRoom(room);
    },
    preview: (value) => this.cellPreview(value),
    tile: () => this.tile,
    useTile: (value) => {
      this.setTile(value);
    },
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
    describe: (description) => {
      try {
        this.need().setRoomDescription(this.episode, this.roomId, description);
      } catch (error) {
        this.setStatus(`Cannot change the description: ${message(error)}`, true);
      }
      this.showRoom(this.roomId);
      this.refreshButtons();
    },
  });
  readonly dealerView = new DealerView({
    change: (dealer) => {
      try {
        this.need().setDealer(this.episode, this.roomId, dealer);
      } catch (error) {
        this.setStatus(`Cannot change the dealer: ${message(error)}`, true);
      }
      this.refreshDealer();
      this.refreshButtons();
    },
    preview: (value) => this.cellPreview(value),
    // the item's name; unnamed ones by what the game says about them
    name: (value) => this.names().info(value).name ?? (this.names().summary(value) || hex(value)),
    tile: () => this.tile,
    useTile: (value) => {
      this.setTile(value);
    },
    goodTile: (good) => goodTile(good, this.need().game.episode(this.episode).classes),
    cellGood: (cell) => cellGood(cell, this.need().game.episode(this.episode).classes),
    refuse: (text) => {
      this.setStatus(text, true);
    },
    go: (room) => {
      if (this.need().hasRoom(this.episode, room)) this.showRoom(room);
    },
  });
  /** Per episode: the pieces of its MUSIC resource. */
  private readonly musicPieces = new Map<number, string[]>();
  /** The pieces some room of the loaded exe plays. */
  private roomMusic: Set<string> | undefined;
  /**
   * The column right of the room: tiles, the selected record, the actors, the script,
   * the room's settings, the episode's (the dealer).
   */
  readonly sidePanel: SidePanel = new SidePanel(
    [
      { name: "tiles", label: "Tiles", content: this.tilesTab },
      { name: "record", label: "Record", content: this.recordTab },
      { name: "actors", label: "Actors", content: this.actorsView.element },
      { name: "circuit", label: "Circuit", content: this.circuitView.element },
      { name: "script", label: "Script", content: this.scriptView.element },
      { name: "room", label: "Room", content: this.settingsView.element },
      { name: "episode", label: "Episode", content: this.dealerView.element },
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
    // segmented buttons (radio buttons underneath), one row each: the column keeps its height
    const layers = h("fieldset", { class: "segmented" }, h("legend", {}, "Layer"));
    for (const layer of ["base", "overlay"] as const) {
      const input = h("input", { type: "radio", name: "layer", value: layer });
      input.addEventListener("change", () => {
        this.setLayer(layer);
      });
      this.layerInputs.set(layer, input);
      const title = `Paint and pick in the ${layer} layer (L switches)`;
      layers.append(h("label", { title }, input, layer === "base" ? "Base" : "Overlay"));
    }

    const tools = h("fieldset", { class: "segmented" }, h("legend", {}, "Tool"));
    for (const { tool, label, title } of TOOLS) {
      const input = h("input", { type: "radio", name: "tool", value: tool });
      input.checked = tool === this.tool;
      input.addEventListener("change", () => {
        this.setTool(tool);
      });
      this.toolInputs.set(tool, input);
      tools.append(h("label", { title }, input, label));
    }
    const areaTools = h(
      "div",
      { class: "area-tools", role: "group", "aria-label": "Area" },
      h("span", { class: "hint", "aria-hidden": "true" }, "Area"),
      ...Object.values(this.areaButtons),
    );

    this.welcome = h(
      "section",
      { class: "welcome" },
      h("p", {}, "Open ", h("code", {}, "GameOfRobot.exe"), " or drop it here."),
      h("p", { class: "hint" }, "The file is read in your browser and never uploaded."),
      h("p", { class: "hint" }, "A mod (.robotmod.json) can be opened once the exe is."),
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
      this.recentRow,
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
        this.openModButton,
        this.modInput,
        this.saveModButton,
        this.testButton,
        this.undoButton,
        this.redoButton,
        h("label", {}, this.gridToggle, " Grid"),
        h(
          "label",
          {
            title:
              "Draw rooms as dark as the game does on entering them (their darkness, tab Room; scripts and lamps can change it in the game) (D)",
          },
          this.darkToggle,
          " Dark",
        ),
        h("label", { title: "Where actors appear (A)" }, this.actorsToggle, " Actors"),
        this.mapButton,
        this.status,
        h("button", { title: "Keyboard and mouse (?)", click: showHelp }, "Shortcuts"),
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
    let editor: Editor;
    try {
      const game = new Game(bytes);
      game.episode(this.episode);
      editor = new Editor(game);
    } catch (error) {
      this.setStatus(`Cannot read ${name}: ${String(error)}`, true);
      throw error;
    }
    this.fileName = name;
    this.modFile = undefined;
    this.use(editor, `${name} loaded`);
  }

  /**
   * Opens a mod (its JSON file, see mod.ts) for the loaded exe: editing starts from its
   * rooms and texts. Throws (and shows) what is wrong with it.
   */
  loadMod(text: string, name = "mod.robotmod.json"): void {
    let editor: Editor;
    try {
      editor = new Editor(this.need().pristine, parseMod(text));
    } catch (error) {
      this.setStatus(`Cannot open ${name}: ${message(error)}`, true);
      throw error;
    }
    this.modFile = name;
    this.use(editor, `${name} opened`);
  }

  /** Saves the edits as a mod (downloaded as JSON) and returns its text. */
  saveMod(): string | undefined {
    const editor = this.need();
    try {
      const text = modJson(editor.saveMod());
      const name = this.modFile ?? this.fileName.replace(/(\.exe)?$/i, ".robotmod.json");
      download(new TextEncoder().encode(text), name, "application/json");
      this.modFile = name;
      this.setStatus(`Saved ${name}${this.draftsNote()}`);
      this.refreshButtons();
      return text;
    } catch (error) {
      this.setStatus(`Saving the mod failed: ${message(error)}`, true);
      return undefined;
    }
  }

  /** Shows the editor's state: a newly loaded exe or mod. */
  private use(editor: Editor, status: string): void {
    this.editor = editor;
    this.scriptView.dropDrafts();
    this.recentTiles.clear();
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
    this.lastRoom = undefined; // nothing stays selected from the exe before
    this.welcome.hidden = true;
    this.workspace.hidden = false;
    this.testButton.disabled = false;
    this.openModButton.disabled = false;
    this.saveModButton.disabled = false;
    const linked = roomInAddress();
    if (linked && this.editor.hasRoom(linked.episode, linked.room)) {
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
    // a mod may have removed the room shown before
    this.showEpisode(
      this.episode,
      editor.hasRoom(this.episode, this.roomId) ? this.roomId : undefined,
    );
    this.refreshButtons();
    this.setStatus(status);
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
    this.roomTitle.textContent = `${EPISODE_NAMES[this.episode] ?? ""} – room ${id}`;
    const room = editor.room(this.episode, id);
    // outlines shown while hovering the actor list or the script belong to the old room:
    // their rows are replaced without a mouseleave
    this.view.setAreas([]);
    this.view.setHighlights([]);
    this.view.show(room, this.roomCache(room), this.backdrop(room));
    this.refreshConnections();
    const key = `${this.episode} ${id}`;
    if (this.scriptView.drafting && this.lastRoom !== undefined && this.lastRoom !== key) {
      this.setStatus(
        `The script draft of room ${this.lastRoom.split(" ")[1] ?? ""} is kept: Apply or Cancel it there`,
      );
    }
    this.scriptView.show(roomScript(room), key);
    this.refreshScriptTab();
    this.showSettings(room);
    this.refreshActors();
    this.refreshCircuit();
    this.refreshDealer();
    this.refreshRoomList();
    const shown = `${this.episode} ${id}`;
    if (this.lastRoom !== shown) {
      if (this.selected) this.select(undefined);
      this.setArea(undefined);
    }
    this.refreshRecordTab();
    this.lastRoom = shown;
    this.remember(this.episode, id);
    if (this.mapShown) this.refreshMap();
  }

  /** Draws rooms (and the map) as dark as in the game, or as they are. */
  setDark(dark: boolean): void {
    this.darkToggle.checked = dark;
    if (!this.editor) return;
    if (this.mapShown) this.refreshMap();
    else this.showRoom(this.roomId);
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
    const settings = roomSettings(room);
    this.sidePanel.setState("room", {
      title: [
        `darkness ${settings.darkness}`,
        `${settings.points} points for the first visit`,
        settings.music ? `music ${settings.music}` : "no music",
      ].join(", "),
    });
    this.settingsView.show(settings, {
      episode: this.episode,
      pieces,
      roomMusic: this.roomMusic,
      saved: roomSaveTime(room),
      ...this.descriptionContext(room.id),
    });
  }

  /** The description field of the Room tab: the description of the name the room shows. */
  private descriptionContext(id: number): Pick<SettingsContext, "description" | "descriptionNote"> {
    const editor = this.need();
    const named = editor.nameRoom(this.episode, id);
    const name = editor.roomName(this.episode, id);
    if (named === undefined)
      return {
        description: undefined,
        descriptionNote: `The game shows no names or descriptions for rooms from ${String(NAMED_ROOMS[this.episode])} on.`,
      };
    if (!name) return { description: undefined, descriptionNote: "Give the room a name first." };
    return {
      description: name.description ?? "",
      descriptionNote: [
        named === id ? "" : `The description of room ${named}, whose name this room shows.`,
        "The banner on entering the room shows it below the name. Enter breaks a line, the game wraps the rest; Ctrl+Enter applies, Escape reverts.",
      ]
        .filter(Boolean)
        .join(" "),
    };
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
    this.showSettings(this.need().room(this.episode, this.roomId)); // the description field
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
    const opened = (edit.parts ?? []).filter((p) => p.tags).map((p) => p.room);
    const exits = opened.length ? `, exits of ${opened.join(", ")} opened towards it` : "";
    const stairs =
      typeof content === "object" && "interior" in content ? content.interior.stairs : undefined;
    const added =
      typeof content === "object" && "copy" in content
        ? `Room ${content.copy} copied to room ${id}`
        : content === "interior" || stairs !== undefined
          ? `Room ${id} added: the interior of room ${id - 100}${stairs === undefined ? "" : `, stairs at ${cellAt(stairs)}`}`
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
      id !== undefined,
    );
  }

  /** What the new room dialog says about room `id` as an interior (Editor.interiorOf). */
  describeInterior(id: number): { text: string; problem?: string; ways?: number } {
    let interior: Interior;
    try {
      interior = this.need().interiorOf(this.episode, id);
    } catch (error) {
      return { text: "", problem: `${capitalize(message(error))}.` };
    }
    const { above, backdrop, doors, stairs } = interior;
    const ways = [
      doors ? `${doors} door${doors === 1 ? "" : "s"} out` : "",
      stairs ? `stairs up at its ${stairs === 1 ? "stairs" : `${stairs} stairs`}` : "",
    ].filter((w) => w !== "");
    const lead = ways.length
      ? `Room ${above} leads in: ${ways.join(", ")} at the same cell${doors + stairs > 1 ? "s" : ""}.`
      : `Room ${above} has no doors into buildings or stairs down yet: pick a cell there (Select or Inspect tool) for new stairs, or put a door there (tile 0x0753 or 0x0653) and a door out (0x005a) here at the same cell.`;
    const around =
      backdrop === undefined
        ? "No room shows around it: the game draws room id mod 100 (episode IV: id − 100), which does not exist."
        : backdrop === above
          ? `Room ${backdrop} shows around it.`
          : `Room ${backdrop} shows around it, not room ${above}: the game takes id mod 100.`;
    // the door's handler (0x413d30) asks for the key unless the episode's flag 0x80000 is set
    const key =
      this.episode === 2 && doors > 0
        ? " The hero needs the key 0x0f15 to go in (episode II: it lies in room 42)."
        : "";
    return { text: `${lead} ${around}${key}`, ways: doors + stairs };
  }

  /**
   * The cell picked in the shown room (pickedCell), if it is room `id` - 100: new stairs
   * into `id`.
   */
  interiorStairs(id: number): { cell: number; at: string; problem?: string } | undefined {
    const cell = this.pickedCell();
    if (cell === undefined || this.roomId !== id - 100) return undefined;
    const at = cellAt(cell);
    const problem = this.need().interiorStairsProblem(this.episode, id, cell);
    return problem === undefined ? { cell, at } : { cell, at, problem };
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
    if (this.need().hasRoom(this.episode, id)) {
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
    const editor = this.need();
    const seen = this.history
      .slice(0, this.historyIndex + 1)
      .reverse()
      .filter((entry) => entry.episode === episode)
      .map((entry) => entry.room);
    return [first, ...seen].find((id) => id !== undefined && editor.hasRoom(episode, id));
  }

  /**
   * The one cell picked in the shown room: an area of a single cell (Select tool), else
   * the selected cell (Inspect tool, a logic cell clicked).
   */
  private pickedCell(): number | undefined {
    const area = this.area;
    if (area?.w === 1 && area.h === 1) return area.y * ROOM_WIDTH + area.x;
    return this.selected?.index;
  }

  /**
   * Starts the game in the shown room with all edits (Editor.testExe): the hero at the
   * picked cell (pickedCell), else where the episode puts it. Without a way to run the
   * game the exe is downloaded.
   */
  async testInGame(): Promise<void> {
    const editor = this.need();
    const index = this.pickedCell();
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
    const name = editor.hasRoom(episode, id) ? editor.roomName(episode, id) : undefined;
    return name ? `room ${id} – ${name.name}` : `room ${id}`;
  }

  /** Goes back to the previously shown room (the browser's back, also across episodes). */
  back(): void {
    const to = this.nearest(this.historyIndex, -1);
    if (to !== undefined) window.history.go(to - this.historyIndex);
  }

  forward(): void {
    const to = this.nearest(this.historyIndex, 1);
    if (to !== undefined) window.history.go(to - this.historyIndex);
  }

  /** History entry `index`, undefined outside the history. */
  private entry(index: number): { episode: number; room: number } | undefined {
    return index >= 0 ? this.history.at(index) : undefined;
  }

  /**
   * The next history entry from `index` in direction `step` whose room still exists
   * (rooms are deleted, or added and undone again) and is not the one shown: after a
   * deletion, the room shown instead can be on both sides of the deleted one.
   */
  private nearest(index: number, step: -1 | 1): number | undefined {
    const shown = this.entry(this.historyIndex);
    for (let i = index + step; i >= 0 && i < this.history.length; i += step) {
      const entry = this.history[i];
      if (entry.episode === shown?.episode && entry.room === shown.room) continue;
      if (this.editor?.hasRoom(entry.episode, entry.room)) return i;
    }
    return undefined;
  }

  /** The browser went back or forward to one of our entries: show its room. */
  private arrive(state: unknown): void {
    if (!this.editor || !isHistoryState(state)) return;
    if (!this.editor.hasRoom(state.episode, state.room)) {
      // the room is gone: on in the same direction, else back to where the browser came from
      const step = state.index < this.historyIndex ? -1 : 1;
      const to = this.nearest(state.index, step) ?? this.historyIndex;
      window.history.go(to - state.index);
      return;
    }
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
    const back = this.nearest(this.historyIndex, -1);
    const forward = this.nearest(this.historyIndex, 1);
    const previous = back === undefined ? undefined : this.entry(back);
    const next = forward === undefined ? undefined : this.entry(forward);
    this.backButton.disabled = back === undefined;
    this.forwardButton.disabled = forward === undefined;
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
      this.refreshRecordTab();
      this.actorsView.highlight(undefined);
      this.refreshCircuit();
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
    this.refreshRecordTab();
    this.actorsView.highlight(index);
    // where a node can be added
    this.refreshCircuit();
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
    this.markTile();
  }

  /** Marks the current tile in the palette and the recent ones. */
  private markTile(): void {
    for (const grid of [this.tileGrid, this.recentRow]) {
      for (const button of grid.querySelectorAll<HTMLElement>("button")) {
        button.classList.toggle("selected", Number(button.dataset["tile"]) === this.tile);
      }
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
    if (changed.length > 0) this.updateView(changed);
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
      this.setStatus(`Saved ${this.fileName}${this.draftsNote()}`);
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
    this.openModButton.addEventListener("click", () => {
      this.modInput.click();
    });
    this.modInput.addEventListener("change", () => {
      const file = this.modInput.files?.[0];
      if (file) void this.loadFile(file);
      this.modInput.value = "";
    });
    this.saveModButton.addEventListener("click", () => this.saveMod());
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
    this.darkToggle.addEventListener("change", () => {
      this.setDark(this.darkToggle.checked);
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
        this.sidePanel.show(this.tabFor(index));
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
        if (!this.editor.hasRoom(linked.episode, linked.room)) return;
        this.replaceNext = true; // the browser made the history entry already
        if (linked.episode === this.episode) this.showRoom(linked.room);
        else this.showEpisode(linked.episode, linked.room);
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "keydown",
      (event) => {
        // a modal dialog keeps its keys, also when nothing in it has the focus
        if (document.querySelector("dialog[open]")) return;
        const target = event.target;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          // also while typing; as with the Save button, the field hands over its value first
          event.preventDefault();
          if (target instanceof HTMLElement && !target.isContentEditable) target.blur();
          if (this.editor) this.save();
          return;
        }
        // checkboxes and radio buttons (the tools, the layers) keep their arrow keys only
        const toggle =
          target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type);
        if (
          (target instanceof HTMLInputElement && !toggle) ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (toggle && event.key.startsWith("Arrow")) ||
          (target instanceof HTMLElement && target.isContentEditable) // the script editor
        ) {
          return;
        }
        if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          showHelp();
          return;
        }
        if (!this.editor) return;
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
          else if (this.area) this.setArea(undefined);
          else if (this.selected) this.select(undefined);
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
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "g") {
          this.gridToggle.checked = !this.gridToggle.checked;
          this.view.setGrid(this.gridToggle.checked);
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "d") {
          this.setDark(!this.darkToggle.checked);
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "a") {
          this.actorsToggle.checked = !this.actorsToggle.checked;
          this.refreshActors();
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "m") {
          this.setMap(!this.mapShown);
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "l") {
          this.setLayer(this.layer === "base" ? "overlay" : "base");
        } else if (!ctrl && !event.altKey && TOOLS.some((t) => t.key === key)) {
          const tool = TOOLS.find((t) => t.key === key)?.tool;
          if (tool) this.setTool(tool);
        } else if (!ctrl && !event.altKey && /^[1-9]$/.test(event.key)) {
          // the side panel's tabs in their order
          const tab = this.sidePanel.names.at(Number(event.key) - 1);
          if (tab) this.sidePanel.show(tab);
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

  /** Opens an exe, or a mod (.json) for the loaded exe. */
  private async loadFile(file: File): Promise<void> {
    const isMod = file.name.toLowerCase().endsWith(".json");
    if (isMod && !this.editor) {
      this.setStatus("Open the exe first, then the mod", true);
      return;
    }
    const question = `Open ${isMod ? "a mod" : "another exe"} and discard the unsaved changes?`;
    if (
      this.editor?.dirty &&
      !(await confirmDialog(question, { action: "Discard changes", danger: true }))
    )
      return;
    try {
      if (isMod) this.loadMod(await file.text(), file.name);
      else this.load(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch {
      // shown in the status line
    }
  }

  private beginStroke(): void {
    this.need().beginStroke(this.episode, this.roomId, this.layer);
    this.lastPainted = undefined;
    this.noteRecent(this.tile);
  }

  /** Puts a tile painted with first in the row of recent tiles. */
  private noteRecent(tile: number): void {
    const recent = this.recentTiles.get(this.episode) ?? [];
    if (recent.at(0) === tile) return;
    this.recentTiles.set(
      this.episode,
      [tile, ...recent.filter((t) => t !== tile)].slice(0, RECENT_TILES),
    );
    this.showRecent();
  }

  /** The Tiles tab's row of recent tiles (hidden while there are none). */
  private showRecent(): void {
    const recent = this.recentTiles.get(this.episode) ?? [];
    this.recentRow.hidden = recent.length === 0;
    this.recentRow.replaceChildren(
      ...recent.map((value) =>
        h(
          "button",
          {
            "data-tile": String(value),
            title: `${this.tileTitle(value)}\n(painted with recently)`,
            click: () => {
              this.setTile(value);
            },
          },
          this.tileCanvas(value),
        ),
      ),
    );
    this.markTile();
  }

  /** Paints up to `index`, filling the cells between the previous and this one. */
  private paintTo(index: number): void {
    const editor = this.need();
    if (!editor.stroking) {
      // undone or saved during the drag: the drag paints no more
      this.painting = false;
      return;
    }
    const cells = this.lastPainted === undefined ? [index] : line(this.lastPainted, index);
    this.lastPainted = index;
    const changed = cells.filter((i) => editor.paint(i, this.tile));
    if (changed.length > 0) this.updateView(changed);
  }

  private endStroke(): void {
    if (this.need().endStroke()) {
      this.refreshRoomList();
      this.refreshButtons();
      this.refreshConnections();
      this.refreshActors();
      this.refreshCircuit();
    }
  }

  /**
   * Finds the room's exits and its name again (painted doors, stairs and exit tiles lead
   * elsewhere; class 99 cells change which room's name the game shows).
   */
  private refreshConnections(): void {
    const editor = this.need();
    const room = editor.room(this.episode, this.roomId);
    this.connections = connections(
      room,
      new Set(editor.rooms(this.episode).map((r) => r.id)),
      editor.game.episode(this.episode).classes,
    );
    this.exitsView.show(this.connections);
    this.showRoomName(this.roomId);
  }

  /** Finds the room's actors again (after painting, record edits, …) and shows them. */
  private refreshActors(): void {
    const editor = this.need();
    const room = editor.room(this.episode, this.roomId);
    this.actors = roomActors(room, editor.game.episode(this.episode).classes);
    // robots are drawn with the episode's sprites, one after the other (their look varies);
    // actors from records (the dealer, the thief, natives) with the tile that names them
    // (assigned once here: the view redraws its marks on every mouse move)
    let robots = 0;
    const sprites = this.actors.map((actor) => {
      if (actor.type === undefined) return undefined;
      if (actor.source === "tile")
        return this.isRobot(actor.type) ? this.robotSprite(robots++) : undefined;
      if (actor.source === "travelling" || actor.source === "creature") {
        // a tile that draws nothing leaves just the marks
        return this.drawsNothing(actor.type, 0) ? undefined : cellCanvas(this.cache(), actor.type);
      }
      return undefined;
    });
    this.view.setActors(this.actorsToggle.checked ? this.actors : [], (_, n) => sprites[n]);
    const classes = editor.game.episode(this.episode).classes;
    const constants = editor.game.scriptConstants(this.episode);
    const calls = scriptActors(roomScript(room));
    this.actorsView.show(
      this.actors,
      calls.map((call) => ({
        call,
        placement: randomPlacement(call, room, classes, constants),
      })),
    );
    const count = this.actors.length + calls.length;
    this.sidePanel.setState("actors", {
      ...(count > 0 ? { badge: String(count) } : {}),
      empty: count === 0,
      title:
        count === 0
          ? "No actors in this room"
          : [
              plural(this.actors.length, "actor"),
              calls.length ? plural(calls.length, "RandObj call") : "",
            ]
              .filter(Boolean)
              .join(", "),
    });
  }

  /** Evaluates the room's circuit again (after painting, record edits, …) and shows it. */
  private refreshCircuit(): void {
    const editor = this.need();
    const room = editor.room(this.episode, this.roomId);
    const classes = editor.game.episode(this.episode).classes;
    const circuit = roomCircuit(room, classes);
    const shown = circuit.nodes.length > 0 && this.circuitView.signals;
    this.view.setCircuit(shown ? circuit : undefined);
    const selected = this.selected;
    const free =
      selected && ((room.base[selected.index] ?? 0) & 0xff) !== LOGIC_CELL
        ? selected.index
        : undefined;
    const letter = classes.typeOfClass.get(LETTER_CLASS);
    const gate = classes.typeOfClass.get(GATE_CLASS);
    const bulb = nodeBulb(classes, false);
    const on = circuit.nodes.filter((n) => n.signal === 1).length;
    const problems = circuit.problems.length;
    this.sidePanel.setState("circuit", {
      ...(circuit.nodes.length > 0 ? { badge: `${on}/${circuit.nodes.length}` } : {}),
      empty: circuit.nodes.length === 0,
      note: problems > 0,
      title:
        circuit.nodes.length === 0
          ? "No circuit nodes in this room"
          : `${on} of ${plural(circuit.nodes.length, "node")} on${problems ? `, ${plural(problems, "problem")}` : ""}`,
    });
    this.circuitView.show(circuit, {
      room: this.roomId,
      ids: new Set(editor.rooms(this.episode).map((r) => r.id)),
      ...(letter === undefined ? {} : { letter }),
      ...(gate === undefined ? {} : { gate }),
      ...(bulb === undefined ? {} : { bulb }),
      ...(free === undefined ? {} : { free }),
    });
  }

  /**
   * The Record tab: with no cell selected the room's records (a click selects one's
   * cell); its button counts them and names the selected one.
   */
  private refreshRecordTab(): void {
    const editor = this.need();
    const room = editor.room(this.episode, this.roomId);
    const classes = editor.game.episode(this.episode).classes;
    // the first cell (base layer first) showing each record
    const cells = new Map<number, number>();
    for (const layer of [room.base, room.overlay]) {
      layer.forEach((cell, i) => {
        if ((cell & 0xff) === LOGIC_CELL && !cells.has(cell >> 8)) cells.set(cell >> 8, i);
      });
    }
    const records = room.records.toSorted(
      (a, b) => (cells.get(a.slot) ?? Infinity) - (cells.get(b.slot) ?? Infinity),
    );
    this.recordList.replaceChildren(
      h("h3", {}, records.length ? plural(records.length, "logic record") : "No logic records"),
      ...records.map((record) => {
        const cell = cells.get(record.slot);
        const { summary } = describeRecord(record, classes);
        const button = h(
          "button",
          {
            title: `Slot ${record.slot}, type ${record.data[0]}`,
            click: () => {
              if (cell === undefined) return;
              this.select(cell);
              this.sidePanel.show("record");
            },
          },
          cell === undefined ? "no cell" : cellAt(cell),
        );
        button.disabled = cell === undefined;
        const row = h("div", { class: "record-list-row" }, button, h("span", {}, summary));
        if (cell !== undefined) {
          // its cell outlined in the room while hovered
          const place = { x: cell % ROOM_WIDTH, y: Math.floor(cell / ROOM_WIDTH), w: 1, h: 1 };
          row.addEventListener("mouseenter", () => {
            this.view.setHighlights([place]);
          });
          row.addEventListener("mouseleave", () => {
            this.view.setHighlights([]);
          });
        }
        return row;
      }),
    );
    const selected = this.selected;
    const value = selected ? (room[selected.layer][selected.index] ?? 0) : 0;
    const record =
      selected && (value & 0xff) === LOGIC_CELL
        ? room.records.find((r) => r.slot === value >> 8)
        : undefined;
    const count = plural(room.records.length, "logic record");
    this.sidePanel.setState("record", {
      ...(room.records.length > 0 ? { badge: String(room.records.length) } : {}),
      empty: room.records.length === 0 && !record,
      title: selected
        ? `${cellAt(selected.index)}: ${record ? describeRecord(record, classes).summary : "no record (one can be added here)"}`
        : `${count} in this room`,
    });
  }

  /**
   * The tab about a cell: its logic record, else the actor placed there, else the
   * circuit it is part of, else the Record tab (where a record can be added).
   */
  private tabFor(index: number): string {
    if (this.logicLayer(index)) return "record";
    if (this.actors.some((a) => a.cell === index && !a.record)) return "actors";
    const editor = this.need();
    const room = editor.room(this.episode, this.roomId);
    const circuit = roomCircuit(room, editor.game.episode(this.episode).classes);
    if (circuit.cells.some((c) => c.cell === index)) return "circuit";
    return "record";
  }

  /** The Script tab's button: whether the room has a script, a draft not applied. */
  private refreshScriptTab(): void {
    const source = roomScript(this.need().room(this.episode, this.roomId));
    const drafting = this.scriptView.drafting;
    const lines = source === "" ? 0 : source.trimEnd().split("\n").length;
    this.sidePanel.setState("script", {
      ...(drafting ? { badge: "✎" } : source ? { badge: "●" } : {}),
      empty: source === "" && !drafting,
      note: drafting,
      title: [
        source ? `A script of ${plural(lines, "line")}` : "No script",
        drafting ? "edited, not applied" : "",
      ]
        .filter(Boolean)
        .join(", "),
    });
  }

  /** The Episode tab: the episode's dealer, the rooms he appears in. */
  private refreshDealer(): void {
    const editor = this.need();
    const dealer = editor.dealer(this.episode);
    const edited = editor.isDealerEdited(this.episode);
    this.dealerView.show({
      episode: EPISODE_NAMES[this.episode] ?? `episode ${this.episode}`,
      dealer,
      original: readDealer(editor.game.image, this.episode),
      capacity: editor.dealerCapacity(this.episode),
      rooms: this.dealerRooms(),
    });
    this.sidePanel.setState("episode", {
      ...(edited ? { badge: "●" } : {}),
      empty: dealer === undefined,
      note: edited,
      title: dealer
        ? `The dealer sells ${plural(dealer.goods.length, "good")}${edited ? " (edited)" : ""}`
        : "No dealer in this episode",
    });
  }

  /** The rooms of the episode with a dealer record (a travelling actor that is the dealer). */
  private dealerRooms(): number[] {
    const editor = this.need();
    const classes = editor.game.episode(this.episode).classes;
    const isDealer = (data: Uint8Array) => {
      if (data[0] !== ACTOR_RECORD) return false;
      const kind = recordActorKind(data[8], classes);
      return kind !== undefined && actorKindClass(kind) === DEALER_CLASS;
    };
    return editor
      .rooms(this.episode)
      .filter((r) => r.records.some((record) => isDealer(record.data)))
      .map((r) => r.id);
  }

  /** Adds a logic record of `type` at the selected cell. */
  private addRecord(type: number): void {
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
  }

  private pick(index: number): void {
    const cell = this.need().room(this.episode, this.roomId)[this.layer][index] ?? 0;
    if ((cell & 0xff) !== LOGIC_CELL) this.setTile(cell);
  }

  /** Shows the room of an undone or redone edit. */
  private revisit(edit: Edit | undefined): void {
    if (!edit) return;
    if (edit.added || edit.removed) {
      // the room list changes: show the room, or the last room seen that still exists
      this.showEpisode(edit.episode, this.lastSeen(edit.episode, edit.room));
    } else if (edit.episode !== this.episode) this.showEpisode(edit.episode, edit.room);
    else if (edit.room !== this.roomId) this.showRoom(edit.room);
    else if (edit.records || edit.tags || edit.text || edit.dealer) {
      // records change what logic cells show and where things lead: redraw everything
      this.showRoom(this.roomId);
      if (this.selected) this.select(this.selected.index);
    } else {
      this.updateView(edit.changes.map((c) => c.index));
      // as at the end of a stroke: painted cells may be passages or actors
      this.refreshConnections();
      this.refreshActors();
      this.refreshCircuit();
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
    const cells = this.roomCache(room);
    const backdrop = this.backdrop(room);
    const key = [
      roomKey(room),
      backdrop ? roomKey(backdrop) : "",
      cells.palette.map((c) => c.join()).join(),
    ].join(" ");
    const known = cache.get(id);
    if (known?.key === key) return known.canvas;
    const canvas = known?.canvas ?? h("canvas", { class: "map-thumbnail" });
    cache.set(id, { key, canvas });
    setTimeout(() => {
      drawRoom(canvas, room, cells, backdrop);
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
    this.showRecent();
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
    // actors from a record: the record's summary above says what they do
    const actor = this.actors.find((a) => a.cell === index && !a.record);
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
    this.markDrafts();
    this.roomList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  /** Marks the rooms in the list whose script has a draft not applied. */
  private markDrafts(): void {
    const drafts = new Set(this.scriptView.draftRooms);
    for (const button of this.roomList.querySelectorAll<HTMLElement>("button")) {
      const drafted = drafts.has(`${this.episode} ${button.dataset["room"] ?? ""}`);
      button.classList.toggle("drafted", drafted);
      const title = button.title.replace(DRAFT_NOTE, "");
      button.title = drafted ? title + DRAFT_NOTE : title;
    }
  }

  /** What saving says about script drafts not applied (they are not saved). */
  private draftsNote(): string {
    const rooms = this.scriptView.draftRooms.map((key) => {
      const [episode = "", room = ""] = key.split(" ");
      return Number(episode) === this.episode
        ? room
        : `${room} (${EPISODE_NAMES[Number(episode)] ?? ""})`;
    });
    return rooms.length === 0
      ? ""
      : ` – script drafts not applied (not saved) in room${rooms.length === 1 ? "" : "s"} ${rooms.join(", ")}`;
  }

  private refreshButtons(): void {
    const editor = this.need();
    this.undoButton.disabled = !editor.canUndo;
    this.redoButton.disabled = !editor.canRedo;
    // with a mod, the exe is made from it at any time
    this.saveButton.disabled = !editor.dirty && this.modFile === undefined;
    // unsaved changes: saving is the thing to do, the mod once there is one
    this.saveButton.classList.toggle("primary", editor.dirty && this.modFile === undefined);
    this.saveModButton.classList.toggle("primary", editor.dirty && this.modFile !== undefined);
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
      const text = game.texts(eventTextsId(this.episode))?.entries.get(EVENT_TEXT + value)?.[0];
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

  /** The episode's cells, in the palette block `block` (darknessBlock; 0: as they are). */
  private cache(block = 0): CellCache {
    const key = `${this.episode} ${block}`;
    let cache = this.caches.get(key);
    if (!cache) {
      const episode = this.need().game.episode(this.episode);
      cache = new CellCache(episode, darkPalette(episode.palette, block));
      this.caches.set(key, cache);
    }
    return cache;
  }

  /** The room the game draws in a room's class 99 cells (e.g. the town around a house). */
  private backdrop(room: Room): Room | undefined {
    const editor = this.need();
    const classes = editor.game.episode(this.episode).classes;
    return backdropRoom(this.episode, room, editor.rooms(this.episode), classes);
  }

  /** Redraws cells of the shown room after an edit. */
  private updateView(indices: readonly number[]): void {
    const room = this.need().room(this.episode, this.roomId);
    this.view.update(room, indices, this.backdrop(room));
  }

  /** The cells a room is drawn with: as dark as in the game with the Dark toggle on. */
  private roomCache(room: Room): CellCache {
    const dark = this.darkToggle.checked;
    return this.cache(dark ? darknessBlock(roomSettings(room).darkness) : 0);
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

/** A cell index as "(x, y)". */
function cellAt(index: number): string {
  return `(${index % ROOM_WIDTH}, ${Math.floor(index / ROOM_WIDTH)})`;
}

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

/** Added to the tooltip of a room with a script draft not applied. */
const DRAFT_NOTE = "\nscript draft not applied";

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "1 node", "3 nodes". */
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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
function download(
  bytes: Uint8Array,
  name: string,
  type = "application/vnd.microsoft.portable-executable",
): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
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
