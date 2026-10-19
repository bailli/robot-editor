import {
  type Episode,
  LOGIC_CELL,
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

/** RGBA pixels of map positions (base, overlay) of one episode, drawn once each. */
export class CellCache {
  private readonly cells = new Map<number, ImageData>();

  readonly episode: Episode;

  constructor(episode: Episode) {
    this.episode = episode;
  }

  get(base: number, overlay: number): ImageData {
    const key = base * 0x10000 + overlay;
    let image = this.cells.get(key);
    if (!image) {
      const pixels = renderCell(base, overlay, this.episode.objects, this.episode.classes);
      image = new ImageData(toRgba(pixels, this.episode.palette), TILE_WIDTH, TILE_HEIGHT);
      this.cells.set(key, image);
    }
    return image;
  }
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

  setGrid(on: boolean): void {
    this.grid = on;
    this.drawMarks();
  }

  private drawActors(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.imageSmoothingEnabled = false;
    this.actors.forEach((actor, n) => {
      const sprite = this.actorSprite(actor, n);
      const x = (actor.cell % ROOM_WIDTH) * w;
      const y = Math.floor(actor.cell / ROOM_WIDTH) * h;
      if (sprite) g.drawImage(sprite, x, y, w, h);
      drawActor(g, actor, w, h);
    });
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
    if (this.room) {
      // logic cells: what they show comes from their records (see the inspector)
      g.fillStyle = "rgb(255 0 255 / 0.35)";
      g.strokeStyle = "rgb(160 0 160)";
      for (let i = 0; i < ROOM_CELLS; i++) {
        const isLogic = [this.room.base[i], this.room.overlay[i]].some(
          (c) => (c & 0xff) === LOGIC_CELL,
        );
        if (!isLogic) continue;
        const x = (i % ROOM_WIDTH) * w;
        const y = Math.floor(i / ROOM_WIDTH) * h;
        g.fillRect(x, y, w, h);
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }
    this.drawActors(g, w, h);
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
