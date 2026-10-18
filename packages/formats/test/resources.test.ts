import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePe } from "../src/pe.ts";
import { type PeResource, ResourceType, findResource, readResources } from "../src/resources.ts";
import { assertBytesEqual, exe, resources } from "./data.ts";

const all = readResources(parsePe(exe()));

/** Folder names 7-Zip uses for numeric types it extracts unchanged. */
const RAW_NUMERIC_TYPES: Readonly<Record<number, string>> = {
  [ResourceType.CURSOR]: "CURSOR",
  [ResourceType.MENU]: "MENU",
  [ResourceType.DIALOG]: "DIALOG",
  [ResourceType.ACCELERATOR]: "ACCELERATOR",
  [ResourceType.GROUP_CURSOR]: "GROUP_CURSOR",
  [ResourceType.GROUP_ICON]: "GROUP_ICON",
};

function folder(r: PeResource): string | undefined {
  return typeof r.type === "string" ? r.type : RAW_NUMERIC_TYPES[r.type];
}

test("lists all resources of GameOfRobot.exe", () => {
  const count = new Map<string, number>();
  for (const r of all) {
    const key = String(r.type);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(count), {
    CRUNCHED: 15,
    MUSIC: 5,
    PCXBITMAP: 27,
    SCENE: 5,
    SHAPES: 12,
    "1": 1,
    "2": 1,
    "3": 2,
    "4": 3,
    "5": 7,
    "6": 7,
    "9": 1,
    "12": 1,
    "14": 1,
    "16": 1,
  });
});

test("raw resources are byte-identical to the 7-Zip extraction", () => {
  let compared = 0;
  for (const r of all) {
    const type = folder(r);
    if (type === undefined) continue; // icons, bitmaps, strings, version: converted by 7-Zip
    const expected = resources(type).find(
      (e) => e.id === String(r.name) && e.language === String(r.language),
    );
    assert.ok(expected, `${type}/${r.name} missing in resources/`);
    assertBytesEqual(r.data, expected.data, `${type}/${r.name}`);
    compared++;
  }
  assert.equal(compared, 78);
});

test("findResource finds named and numeric types, optionally by language", () => {
  const scene = findResource(all, "SCENE", 1104);
  assert.equal(scene?.language, 1033);
  assert.ok(findResource(all, ResourceType.MENU, 2010, 1031));
  assert.equal(findResource(all, ResourceType.MENU, 2010, 1033), undefined);
  assert.equal(findResource(all, "SCENE", 9999), undefined);
});

test("an image without resource directory has no resources", () => {
  const image = parsePe(exe());
  assert.deepEqual(readResources({ ...image, dataDirectories: [] }), []);
});
