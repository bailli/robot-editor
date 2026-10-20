import {
  type Episode,
  LOGIC_CELL,
  type PlacementArea,
  ROOM_CELLS,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type Rgb,
  type Room,
  type RoomActor,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type Shape,
  TILE_HEIGHT,
  TILE_WIDTH,
  TRANSPARENT,
  renderCell,
  resolveCell,
  shapePixels,
  toRgba,
} from "@robot/formats";

/**
 * RGBA pixels of map positions (base, overlay) of one episode, drawn once each, in the
 * episode's palette or another (e.g. a dark one, darkPalette).
 */
export class CellCache {
  private readonly cells = new Map<number, ImageData>();

  readonly episode: Episode;
  readonly palette: readonly Rgb[];

  constructor(episode: Episode, palette: readonly Rgb[] = episode.palette) {
    this.episode = episode;
    this.palette = palette;
  }

  get(base: number, overlay: number): ImageData {
    const key = base * 0x10000 + overlay;
    let image = this.cells.get(key);
    if (!image) {
      const pixels = renderCell(base, overlay, this.episode.objects, this.episode.classes);
      image = new ImageData(toRgba(pixels, this.palette), TILE_WIDTH, TILE_HEIGHT);
      this.cells.set(key, image);
    }
    return image;
  }
}

/** Draws a whole room onto a canvas of the screen's size, as the room view does. */
export function drawRoom(canvas: HTMLCanvasElement, room: Room, cache: CellCache): void {
  canvas.width = SCREEN_WIDTH;
  canvas.height = SCREEN_HEIGHT;
  const g = canvas.getContext("2d");
  if (!g) return;
  for (let i = 0; i < ROOM_CELLS; i++) {
    const image = cache.get(
      resolveCell(room, room.base[i] ?? 0),
      resolveCell(room, room.overlay[i] ?? 0),
    );
    g.putImageData(image, (i % ROOM_WIDTH) * TILE_WIDTH, Math.floor(i / ROOM_WIDTH) * TILE_HEIGHT);
  }
}

/** A rectangle of cells to outline: column, row, width and height in cells. */
export interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A room on two stacked canvases, scaled by CSS to the available width: the room at its
 * native 640x348 and, at `zoom` times that, the grid, logic cell markers and the hovered
 * cell.
 */
export class RoomView {
  readonly element: HTMLElement;
  private readonly room2d: CanvasRenderingContext2D;
  private readonly marks2d: CanvasRenderingContext2D;
  private room: Room | undefined;
  private cache: CellCache | undefined;
  private hover: number | undefined;
  private selected: number | undefined;
  private grid = false;
  private actors: readonly RoomActor[] = [];
  private areas: readonly PlacementArea[] = [];
  private highlights: readonly Highlight[] = [];
  private selection: Highlight | undefined;
  private floating: { x: number; y: number; image: HTMLCanvasElement } | undefined;
  private actorSprite: (actor: RoomActor, n: number) => HTMLCanvasElement | undefined = () =>
    undefined;

  readonly zoom: number;

  constructor(zoom = 2) {
    this.zoom = zoom;
    this.element = document.createElement("div");
    this.element.className = "room-view";
    const roomCanvas = canvas(SCREEN_WIDTH, SCREEN_HEIGHT, "room");
    const marksCanvas = canvas(SCREEN_WIDTH * zoom, SCREEN_HEIGHT * zoom, "marks");
    this.element.style.maxWidth = `${SCREEN_WIDTH * zoom}px`;
    this.element.append(roomCanvas, marksCanvas);
    this.room2d = context(roomCanvas);
    this.marks2d = context(marksCanvas);
  }

  show(room: Room, cache: CellCache): void {
    this.room = room;
    this.cache = cache;
    for (let i = 0; i < ROOM_CELLS; i++) this.drawCell(i);
    this.drawMarks();
  }

  /** Redraws cells after they changed in the shown room (which may be a new copy). */
  update(room: Room, indices: Iterable<number>): void {
    this.room = room;
    for (const i of indices) this.drawCell(i);
    this.drawMarks();
  }

  /** The room's palette indices as drawn, for tests: RGBA of the room canvas. */
  pixels(): Uint8ClampedArray {
    return this.room2d.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT).data;
  }

  setSelected(index: number | undefined): void {
    this.selected = index;
    this.drawMarks();
  }

  /** The marks canvas as RGBA (actors, grid, selection), for tests. */
  pixelsOfMarks(): Uint8ClampedArray {
    const g = this.marks2d;
    return g.getImageData(0, 0, g.canvas.width, g.canvas.height).data;
  }

  setHover(index: number | undefined): void {
    if (index === this.hover) return;
    this.hover = index;
    this.drawMarks();
  }

  /**
   * Marks where actors appear (empty: none shown); `sprite` draws an actor itself, e.g. a
   * robot (n counts the actors in the room).
   */
  setActors(
    actors: readonly RoomActor[],
    sprite: (actor: RoomActor, n: number) => HTMLCanvasElement | undefined = () => undefined,
  ): void {
    this.actors = actors;
    this.actorSprite = sprite;
    this.drawMarks();
  }

  /** Outlines areas, e.g. where RandObj places robots, labelled by how the hero enters. */
  setAreas(areas: readonly PlacementArea[]): void {
    this.areas = areas;
    this.drawMarks();
  }

  /** How many areas and highlights are outlined, for tests. */
  outlines(): number {
    return this.areas.length + this.highlights.length;
  }

  /** Outlines cells or areas a script names (empty: none). */
  setHighlights(highlights: readonly Highlight[]): void {
    this.highlights = highlights;
    this.drawMarks();
  }

  /** Outlines the selected area (undefined: none). */
  setSelection(area: Highlight | undefined): void {
    this.selection = area;
    this.drawMarks();
  }

  /**
   * Shows cells about to be pasted (`image`: drawn at the room's scale) with their top
   * left cell at (x, y); undefined hides them.
   */
  setFloating(floating: { x: number; y: number; image: HTMLCanvasElement } | undefined): void {
    this.floating = floating;
    this.drawMarks();
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.drawMarks();
  }

  /** Draws the actors that have a picture; returns their cells. */
  private drawActors(g: CanvasRenderingContext2D, w: number, h: number): Set<number> {
    g.imageSmoothingEnabled = false;
    const drawn = new Set<number>();
    this.actors.forEach((actor, n) => {
      const sprite = this.actorSprite(actor, n);
      if (!sprite) return;
      g.drawImage(
        sprite,
        (actor.cell % ROOM_WIDTH) * w,
        Math.floor(actor.cell / ROOM_WIDTH) * h,
        w,
        h,
      );
      drawn.add(actor.cell);
    });
    return drawn;
  }

  /** The actors' rings, radii and arrows, over the logic cell marks. */
  private drawActorMarks(g: CanvasRenderingContext2D, w: number, h: number): void {
    for (const actor of this.actors) drawActor(g, actor, w, h);
  }

  /** The cell index under a mouse event, or undefined outside the room. */
  cellAt(event: MouseEvent): number | undefined {
    const rect = this.element.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * ROOM_WIDTH);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * ROOM_HEIGHT);
    return x >= 0 && x < ROOM_WIDTH && y >= 0 && y < ROOM_HEIGHT ? y * ROOM_WIDTH + x : undefined;
  }

  private drawCell(i: number): void {
    if (!this.room || !this.cache) return;
    // logic cells show their record's cell, as in the game
    const image = this.cache.get(
      resolveCell(this.room, this.room.base[i] ?? 0),
      resolveCell(this.room, this.room.overlay[i] ?? 0),
    );
    this.room2d.putImageData(
      image,
      (i % ROOM_WIDTH) * TILE_WIDTH,
      Math.floor(i / ROOM_WIDTH) * TILE_HEIGHT,
    );
  }

  private drawMarks(): void {
    const g = this.marks2d;
    const w = TILE_WIDTH * this.zoom;
    const h = TILE_HEIGHT * this.zoom;
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    if (this.grid) {
      g.strokeStyle = "rgb(0 0 0 / 0.25)";
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 1; x < ROOM_WIDTH; x++) g.rect(x * w - 0.5, -1, 0, g.canvas.height + 2);
      for (let y = 1; y < ROOM_HEIGHT; y++) g.rect(-1, y * h - 0.5, g.canvas.width + 2, 0);
      g.stroke();
    }
    // actors drawn as themselves: their logic cells get only the frame, not the fill
    const drawn = this.drawActors(g, w, h);
    if (this.room) {
      // logic cells: what they show comes from their records (see the inspector)
      g.fillStyle = "rgb(255 0 255 / 0.35)";
      g.strokeStyle = "rgb(160 0 160)";
      g.lineWidth = 1;
      for (let i = 0; i < ROOM_CELLS; i++) {
        const isLogic = [this.room.base[i], this.room.overlay[i]].some(
          (c) => (c & 0xff) === LOGIC_CELL,
        );
        if (!isLogic) continue;
        const x = (i % ROOM_WIDTH) * w;
        const y = Math.floor(i / ROOM_WIDTH) * h;
        if (!drawn.has(i)) g.fillRect(x, y, w, h);
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }
    this.drawActorMarks(g, w, h);
    for (const area of this.areas) {
      const x = area.x0 * w;
      const y = area.y0 * h;
      const aw = (area.x1 - area.x0 + 1) * w;
      const ah = (area.y1 - area.y0 + 1) * h;
      g.fillStyle = "rgb(230 30 30 / 0.08)";
      g.fillRect(x, y, aw, ah);
      g.strokeStyle = ACTOR;
      g.lineWidth = 2;
      g.setLineDash([8, 4]);
      g.strokeRect(x + 1, y + 1, aw - 2, ah - 2);
      g.setLineDash([]);
      g.fillStyle = ACTOR;
      g.font = "bold 13px system-ui, sans-serif";
      // labels in different corners: the areas overlap
      const label = `hero enters from the ${area.entering}`;
      const right = area.entering === "west";
      const bottom = area.entering === "north";
      g.textAlign = right ? "right" : "left";
      g.fillText(label, right ? x + aw - 6 : x + 6, bottom ? y + ah - 8 : y + 16);
      g.textAlign = "left";
    }
    for (const area of this.highlights) {
      g.fillStyle = "rgb(0 110 255 / 0.3)";
      g.fillRect(area.x * w, area.y * h, area.w * w, area.h * h);
      g.strokeStyle = "rgb(0 90 230)";
      g.lineWidth = 3;
      g.strokeRect(area.x * w + 1.5, area.y * h + 1.5, area.w * w - 3, area.h * h - 3);
    }
    if (this.floating) {
      const { x, y, image } = this.floating;
      const [fw, fh] = [(image.width / TILE_WIDTH) * w, (image.height / TILE_HEIGHT) * h];
      g.imageSmoothingEnabled = false;
      g.globalAlpha = 0.75;
      g.drawImage(image, x * w, y * h, fw, fh);
      g.globalAlpha = 1;
      g.strokeStyle = "rgb(0 160 80)";
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.strokeRect(x * w + 1, y * h + 1, fw - 2, fh - 2);
      g.setLineDash([]);
    }
    if (this.selection) {
      const { x, y, w: sw, h: sh } = this.selection;
      g.fillStyle = "rgb(255 140 0 / 0.15)";
      g.fillRect(x * w, y * h, sw * w, sh * h);
      g.strokeStyle = "rgb(255 140 0)";
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.strokeRect(x * w + 1, y * h + 1, sw * w - 2, sh * h - 2);
      g.setLineDash([]);
    }
    if (this.selected !== undefined) {
      g.strokeStyle = "rgb(255 140 0)";
      g.lineWidth = 3;
      g.strokeRect(
        (this.selected % ROOM_WIDTH) * w + 1.5,
        Math.floor(this.selected / ROOM_WIDTH) * h + 1.5,
        w - 3,
        h - 3,
      );
    }
    if (this.hover !== undefined) {
      g.strokeStyle = "rgb(0 120 255)";
      g.lineWidth = 2;
      g.strokeRect(
        (this.hover % ROOM_WIDTH) * w + 1,
        Math.floor(this.hover / ROOM_WIDTH) * h + 1,
        w - 2,
        h - 2,
      );
    }
  }
}

const ACTOR = "rgb(230 30 30)";

/**
 * Actor marks: a ring for actors placed in the map, a dashed ring for sources that let
 * them appear later (hatcheries, bombs, scorpion sand, spawners, records), the spawner's
 * radius as a dashed ellipse and an arrow for actors heading somewhere.
 */
function drawActor(g: CanvasRenderingContext2D, actor: RoomActor, w: number, h: number) {
  const cx = ((actor.cell % ROOM_WIDTH) + 0.5) * w;
  const cy = (Math.floor(actor.cell / ROOM_WIDTH) + 0.5) * h;
  g.strokeStyle = ACTOR;
  g.lineWidth = 2;
  g.setLineDash(actor.source === "tile" ? [] : [3, 2]);
  g.beginPath();
  g.ellipse(cx, cy, w / 2 - 1, h / 2 - 1, 0, 0, 2 * Math.PI);
  g.stroke();
  if (actor.radius !== undefined) {
    g.lineWidth = 1;
    g.setLineDash([6, 4]);
    g.beginPath();
    g.ellipse(cx, cy, actor.radius * w, actor.radius * h, 0, 0, 2 * Math.PI);
    g.stroke();
  }
  if (actor.target) {
    g.setLineDash([]);
    g.fillStyle = ACTOR;
    g.beginPath();
    g.moveTo(cx + w / 2, cy);
    g.lineTo(cx + w / 2 - 6, cy - 5);
    g.lineTo(cx + w / 2 - 6, cy + 5);
    g.fill();
  }
  g.setLineDash([]);
}

function canvas(width: number, height: number, className: string): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  element.className = className;
  return element;
}

function context(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = element.getContext("2d");
  if (!g) throw new Error("no 2D canvas");
  return g;
}

/**
 * Cells of both layers, `w` wide, as a canvas (e.g. a clip to paste); logic cells show the
 * cells of `records`.
 */
export function cellsCanvas(
  cache: CellCache,
  w: number,
  base: Uint16Array,
  overlay: Uint16Array,
  records: Room["records"],
): HTMLCanvasElement {
  const h = Math.ceil(base.length / Math.max(1, w));
  const element = canvas(w * TILE_WIDTH, h * TILE_HEIGHT, "cells");
  const g = context(element);
  for (let i = 0; i < base.length; i++) {
    const image = cache.get(
      resolveCell({ records }, base[i] ?? 0),
      resolveCell({ records }, overlay[i] ?? 0),
    );
    g.putImageData(image, (i % w) * TILE_WIDTH, Math.floor(i / w) * TILE_HEIGHT);
  }
  return element;
}

/** A single cell (e.g. a palette entry) as a canvas. */
export function cellCanvas(cache: CellCache, base: number, overlay = 0): HTMLCanvasElement {
  const element = canvas(TILE_WIDTH, TILE_HEIGHT, "cell");
  context(element).putImageData(cache.get(base, overlay), 0, 0);
  return element;
}

/** A shape's frame as a canvas, transparent where the shape does not draw. */
export function spriteCanvas(shape: Shape, palette: readonly Rgb[], frame = 0): HTMLCanvasElement {
  const element = canvas(shape.width, shape.height, "cell");
  const pixels = shapePixels(shape, frame);
  const rgba = new Uint8ClampedArray(toRgba(pixels, palette));
  pixels.forEach((c, i) => {
    if (c === TRANSPARENT) rgba[i * 4 + 3] = 0;
  });
  context(element).putImageData(new ImageData(rgba, shape.width, shape.height), 0, 0);
  return element;
}
