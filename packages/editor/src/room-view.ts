import {
  type Episode,
  LOGIC_CELL,
  ROOM_CELLS,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type Room,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  renderCell,
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
  private grid = false;

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

  setHover(index: number | undefined): void {
    if (index === this.hover) return;
    this.hover = index;
    this.drawMarks();
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.drawMarks();
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
    const image = this.cache.get(this.room.base[i] ?? 0, this.room.overlay[i] ?? 0);
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
      // logic cells: drawn by their records, which the editor does not show yet
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
