import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { expect } from "vitest";

import { parsePe } from "../src/pe.ts";
import { readResources } from "../src/resources.ts";

/** Repository root; the game and everything derived from it are not checked in. */
export const ROOT = new URL("../../../", import.meta.url);

let exeBytes: Uint8Array | undefined;

/** reference/GameOfRobot.exe (see README). */
export function exe(): Uint8Array {
  if (!exeBytes) {
    const path = new URL("reference/GameOfRobot.exe", ROOT);
    if (!existsSync(path)) throw new Error(`${path.pathname} is missing: see README`);
    exeBytes = new Uint8Array(readFileSync(path));
  }
  return exeBytes;
}

export interface TestResource {
  id: string;
  language: number;
  data: Uint8Array;
}

/** All resources of one named type, e.g. "CRUNCHED", read from the exe. */
export function resources(type: string): TestResource[] {
  return readResources(parsePe(exe()))
    .filter((r) => r.type === type)
    .map((r) => ({ id: String(r.name), language: r.language, data: r.data }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function resource(type: string, id: string): Uint8Array {
  const found = resources(type).find((r) => r.id === id);
  if (!found) throw new Error(`resource ${type}/${id} not found`);
  return found.data;
}

/**
 * Resources as extracted by 7-Zip into resources/<language>/<TYPE>/<name> (optional;
 * only the comparison test in resources.test.ts uses them).
 */
export function extracted(type: string): (TestResource & { languageFolder: string })[] | undefined {
  const root = new URL("resources/", ROOT);
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((lang) => existsSync(new URL(`${lang}/${type}/`, root)))
    .flatMap((lang) => {
      const dir = new URL(`${lang}/${type}/`, root);
      return readdirSync(dir).map((id) => ({
        id,
        language: Number(lang),
        languageFolder: lang,
        data: new Uint8Array(readFileSync(new URL(id, dir))),
      }));
    });
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Byte-array equality that reports the first difference. (assert.deepEqual builds a
 * full diff of large arrays, which exhausts memory for scenes and renders.)
 */
export function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  const n = Math.min(actual.length, expected.length);
  let i = 0;
  while (i < n && actual[i] === expected[i]) i++;
  if (i === n && actual.length === expected.length) return;
  const at = (a: Uint8Array) => (i < a.length ? `0x${a[i].toString(16).padStart(2, "0")}` : "end");
  assert.fail(
    `${label}: first difference at offset ${i} (actual ${at(actual)}, expected ${at(expected)}; ` +
      `lengths ${actual.length} / ${expected.length})`,
  );
}

/** JSON for snapshots: byte arrays as hex. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (v instanceof Uint8Array ? hex(v) : v));
}

/**
 * Matches an output against its snapshot in test/__snapshots__ (committed): a change
 * fails the test and shows up in review once recorded (`pnpm snapshots`). Small values
 * are stored as they are, large ones (and byte arrays) as sha256.
 */
export function snapshot(name: string, value: unknown): void {
  const json = toJson(value);
  expect(
    value instanceof Uint8Array || json.length > 200
      ? `sha256:${sha256(value instanceof Uint8Array ? value : json)}`
      : JSON.parse(json),
  ).toMatchSnapshot(name);
}
