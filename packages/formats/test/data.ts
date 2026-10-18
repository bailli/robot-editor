import { existsSync, readFileSync, readdirSync } from "node:fs";

/** Repository root; game data and golden outputs are not checked in. */
const ROOT = new URL("../../../", import.meta.url);

function require(dir: string, hint: string): URL {
  const url = new URL(dir, ROOT);
  if (!existsSync(url)) {
    throw new Error(`${url.pathname} is missing: ${hint}`);
  }
  return url;
}

const RESOURCES_HINT = "extract the resources from reference/GameOfRobot.exe (see README)";
const GOLDEN_HINT = "run `pnpm golden` first";

/** All resources of one type, e.g. "CRUNCHED", across language folders. */
export function resources(type: string): { id: string; data: Uint8Array }[] {
  const root = require("resources/", RESOURCES_HINT);
  return readdirSync(root)
    .filter((lang) => existsSync(new URL(`${lang}/${type}/`, root)))
    .flatMap((lang) => {
      const dir = new URL(`${lang}/${type}/`, root);
      return readdirSync(dir).map((id) => ({
        id,
        data: new Uint8Array(readFileSync(new URL(id, dir))),
      }));
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function resource(type: string, id: string): Uint8Array {
  const found = resources(type).find((r) => r.id === id);
  if (!found) throw new Error(`resource ${type}/${id} not found`);
  return found.data;
}

export function exe(): Uint8Array {
  const reference = require("reference/", "put the unpacked game into reference/ (see README)");
  return new Uint8Array(readFileSync(new URL("GameOfRobot.exe", reference)));
}

export function golden(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, require("golden/", GOLDEN_HINT))));
}

export function goldenJson(path: string): unknown {
  return JSON.parse(new TextDecoder().decode(golden(path)));
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
