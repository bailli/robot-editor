import { type ChildProcess, spawn } from "node:child_process";
import { type Socket, connect } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { type Rgb, SCREEN_HEIGHT, SCREEN_WIDTH } from "@robot/formats";

import { ROOT } from "./game.ts";
import { type IndexedImage, writeIndexedPng } from "./png.ts";

/**
 * Drives the real game step by step through the proxy DLL (tools/wine/proxy, built by
 * `pnpm proxy`; `harness.py serve` runs the game with it under Wine). The game runs on
 * virtual time: nothing happens between commands, a step advances the game clock by
 * `stepMs` virtual milliseconds (default 7; the clock counts 147 ticks per second), and
 * keys pressed between steps reach the game before the next one. Runs are repeatable.
 * Every answer comes when the game is idle again (the last step drawn and presented,
 * the keys sent so far handled), so reads never see a half-drawn frame.
 */

const HARNESS = fileURLToPath(new URL("tools/wine/harness.py", ROOT));

/** Windows virtual-key codes of keys the game uses (letters and digits: their ASCII codes). */
export const VK = {
  return: 13,
  shift: 16,
  control: 17,
  alt: 18,
  escape: 27,
  space: 32,
  left: 37,
  up: 38,
  right: 39,
  down: 40,
} as const;
export type Key = keyof typeof VK;

export interface Status {
  /** The game's tick counter (0x51bb38): one per clock unit; stands still while it pauses. */
  tick: number;
  /** Virtual milliseconds (what timeGetTime returns). */
  ms: number;
  /** Steps run so far. */
  steps: number;
  /** Frames presented so far. */
  frames: number;
}

/** A frame as the game presented it: palette indices of its 640 × 348 screen. */
export interface Frame {
  width: number;
  height: number;
  indices: Uint8Array;
  /** Frames presented up to this one (Status.frames). */
  frame: number;
}

/** Where the hero is: the room (0x4fe2fc) and its cell (hero object 0x53e9ac, +9/+0xa). */
export interface HeroState {
  room: number;
  x: number;
  y: number;
}

const ROOM = 0x4fe2fc;
const HERO = 0x53e9ac;

function parseStatus(answer: string): Status {
  const field = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(answer)?.[1]);
  return { tick: field("tick"), ms: field("ms"), steps: field("steps"), frames: field("frames") };
}

export class Driver {
  private readonly answers: ((line: string) => void)[] = [];
  private readonly socket: Socket;
  private readonly server: ChildProcess | undefined;

  private constructor(socket: Socket, server: ChildProcess | undefined) {
    this.socket = socket;
    this.server = server;
    socket.setEncoding("latin1");
    createInterface({ input: socket }).on("line", (line) => this.answers.shift()?.(line));
  }

  /** Starts the game with the proxy on a virtual display (needs Wine, Xvfb and the proxy). */
  static async start(options: { exe?: string; port?: number } = {}): Promise<Driver> {
    const port = options.port ?? 7531;
    const args = ["-I", HARNESS, "serve", "--port", String(port)];
    if (options.exe) args.push("--exe", options.exe);
    const server = spawn("python3", args, { stdio: ["ignore", "pipe", "inherit"] });
    const ready = new Promise<void>((resolve, reject) => {
      server.on("exit", (code) => {
        reject(new Error(`harness.py serve ended (${String(code)})`));
      });
      createInterface({ input: server.stdout }).on("line", (line) => {
        if (line.startsWith("ready ")) resolve();
      });
    });
    try {
      await ready;
      return await Driver.connect(port, server);
    } catch (error) {
      server.kill();
      throw error;
    }
  }

  /** Connects to a game already served on `port` (e.g. by `harness.py serve` by hand). */
  static connect(port = 7531, server?: ChildProcess): Promise<Driver> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        resolve(new Driver(socket, server));
      });
      socket.once("error", reject);
    });
  }

  /** Sends one command line and returns the answer after "ok" (throws on "error"). */
  async command(line: string): Promise<string> {
    const answer = await new Promise<string>((resolve) => {
      this.answers.push(resolve);
      this.socket.write(`${line}\n`);
    });
    if (answer.startsWith("error")) throw new Error(`proxy: ${answer} (for ${line})`);
    return answer.replace(/^ok ?/, "");
  }

  async status(): Promise<Status> {
    return parseStatus(await this.command("status"));
  }

  /** Runs `steps` steps; throws when the game stops stepping (a modal window, a crash). */
  async run(steps: number): Promise<Status> {
    const answer = await this.command(`run ${String(steps)}`);
    if (answer.startsWith("stalled")) throw new Error(`the game stopped stepping: ${answer}`);
    return parseStatus(answer);
  }

  /** Virtual milliseconds per step from now on. */
  async stepMs(ms: number): Promise<void> {
    await this.command(`stepms ${String(ms)}`);
  }

  /** Presses (down) or releases a key: a name or a virtual-key code. */
  async key(key: Key | number, down: boolean): Promise<void> {
    const code = typeof key === "number" ? key : VK[key];
    await this.command(`key ${String(code)} ${down ? "down" : "up"}`);
  }

  /** Holds a key for `steps` steps. */
  async hold(key: Key | number, steps: number): Promise<void> {
    await this.key(key, true);
    await this.run(steps);
    await this.key(key, false);
  }

  /** A short press, then `after` steps for the game to react. */
  async press(key: Key | number, after = 50): Promise<void> {
    await this.hold(key, 5);
    await this.run(after);
  }

  /** A left click at client coordinates of the game window. */
  async click(x: number, y: number, after = 50): Promise<void> {
    await this.command(`mouse ${String(x)} ${String(y)}`);
    await this.command("button left down");
    await this.run(5);
    await this.command("button left up");
    await this.run(after);
  }

  async peek(address: number, length: number): Promise<Uint8Array> {
    const hex = await this.command(`peek ${address.toString(16)} ${String(length)}`);
    return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  }

  async poke(address: number, bytes: Uint8Array): Promise<void> {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await this.command(`poke ${address.toString(16)} ${hex}`);
  }

  /**
   * The last frame presented: the game's own frame buffer (palette indices, like its
   * screenshots), cut to the screen it shows.
   */
  async frame(): Promise<Frame> {
    const [width, height, frame, hex] = (await this.command("frame")).split(" ");
    if (Number(width) !== SCREEN_WIDTH || Number(height) < SCREEN_HEIGHT) {
      throw new Error(`unexpected frame buffer ${width}x${height}`);
    }
    const all = Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
    const indices = all.subarray(0, SCREEN_WIDTH * SCREEN_HEIGHT);
    return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, indices, frame: Number(frame) };
  }

  /** The colours the last frame was presented with (the game changes them, e.g. in the dark). */
  async palette(): Promise<Rgb[]> {
    const hex = await this.command("palette");
    return Array.from(hex.match(/.{8}/g) ?? [], (entry): Rgb => {
      const rgb = parseInt(entry, 16);
      return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
    });
  }

  /** The last frame with its colours. */
  async image(): Promise<IndexedImage> {
    const { width, height, indices } = await this.frame();
    return { width, height, indices, palette: await this.palette() };
  }

  /** Writes the last frame as a palette PNG (pixel values are the game's indices). */
  async screenshot(path: URL | string, zoom = 1): Promise<void> {
    writeIndexedPng(path, await this.image(), zoom);
  }

  async u32(address: number): Promise<number> {
    const b = await this.peek(address, 4);
    return new DataView(b.buffer).getUint32(0, true);
  }

  /** The hero's room and cell, undefined while there is no hero (menus, title screens). */
  async hero(): Promise<HeroState | undefined> {
    const hero = await this.u32(HERO);
    if (!hero) return undefined;
    const [x, y] = await this.peek(hero + 9, 2);
    const room = new DataView((await this.peek(ROOM, 2)).buffer).getUint16(0, true);
    return { room, x, y };
  }

  /**
   * Runs `every` steps at a time until `done` holds; throws after `maxSteps`.
   */
  async until(done: () => Promise<boolean>, maxSteps = 5000, every = 10): Promise<void> {
    for (let steps = 0; !(await done()); steps += every) {
      if (steps >= maxSteps) throw new Error(`condition not reached in ${String(maxSteps)} steps`);
      await this.run(every);
    }
  }

  /** Whether the game clock advances (it stands still in dialogs and banners). */
  async running(steps = 20): Promise<boolean> {
    const before = await this.status();
    return (await this.run(steps)).tick > before.tick;
  }

  /**
   * From the episode menu (after start) to the hero standing in the start room: clicks the
   * episode, then Return through the title menu, the player-name dialog and the room's
   * banner until the game clock runs with a hero.
   */
  async startEpisode(episode: number): Promise<HeroState> {
    await this.until(async () => (await this.status()).tick > 100); // the menu is up
    await this.click(147, 124 + 51 * episode, 100);
    for (let presses = 0; presses < 8; presses++) {
      const hero = await this.hero();
      if (hero && (await this.running())) return hero;
      await this.press("return", 150);
    }
    throw new Error(`episode ${String(episode)} did not start`);
  }

  /** Closes the connection and, if this driver started it, the game. */
  close(): void {
    this.socket.end();
    this.server?.kill();
  }
}
