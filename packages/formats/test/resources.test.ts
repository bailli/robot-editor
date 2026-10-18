import assert from "node:assert/strict";
import { test } from "node:test";

import { DIRECTORY_SECURITY, PeFormatError, parsePe } from "../src/pe.ts";
import {
  type PeResource,
  ResourceType,
  findResource,
  readResources,
  replaceResource,
} from "../src/resources.ts";
import { assertBytesEqual, exe, extracted } from "./data.ts";

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

const SEVEN_ZIP_HINT = "resources/ is missing (optional, see README)";

test(
  "raw resources are byte-identical to the 7-Zip extraction",
  {
    skip: extracted("SCENE") ? false : SEVEN_ZIP_HINT,
  },
  () => {
    let compared = 0;
    for (const r of all) {
      const type = folder(r);
      if (type === undefined) continue; // icons, bitmaps, strings, version: converted by 7-Zip
      const expected = extracted(type)?.find(
        (e) => e.id === String(r.name) && e.language === r.language,
      );
      assert.ok(expected, `${type}/${r.name} missing in resources/`);
      assertBytesEqual(r.data, expected.data, `${type}/${r.name}`);
      compared++;
    }
    assert.equal(compared, 78);
  },
);

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

test("replaceResource writes smaller data in place and updates the size", () => {
  const image = parsePe(exe());
  const scene = findResource(readResources(image), "SCENE", 1004);
  assert.ok(scene);
  const patched = replaceResource(image, scene, Uint8Array.of(1, 2, 3));
  const after = findResource(readResources(parsePe(patched)), "SCENE", 1004);
  assert.deepEqual([...(after?.data ?? [])], [1, 2, 3]);
  assert.equal(patched.length, image.data.length);
  assert.equal(findResource(readResources(parsePe(patched)), "SCENE", 1104)?.data.length, 59988);
});

test("replaceResource moves larger data to the end of the grown resource section", () => {
  const image = parsePe(exe());
  const all = readResources(image);
  const scene = findResource(all, "SCENE", 1104);
  assert.ok(scene);
  const big = Uint8Array.from({ length: scene.data.length + 5000 }, (_, i) => i);
  const grown = parsePe(replaceResource(image, scene, big));
  const rsrc = grown.sections.at(-1);
  assert.equal(rsrc?.name, ".rsrc");
  assert.equal(rsrc.virtualSize, (image.sections.at(-1)?.virtualSize ?? 0) + big.length);
  assert.equal(grown.data.length, rsrc.rawOffset + rsrc.rawSize, "no signature left behind");
  assert.deepEqual(grown.dataDirectories[DIRECTORY_SECURITY], { rva: 0, size: 0 });
  const after = readResources(grown);
  const moved = findResource(after, "SCENE", 1104);
  assertBytesEqual(moved?.data ?? new Uint8Array(), big, "moved data");
  assert.ok(
    grown.data
      .subarray(scene.dataOffset, scene.dataOffset + scene.data.length)
      .every((b) => b === 0),
  );
  for (const r of all.filter((r) => r !== scene)) {
    assertBytesEqual(
      findResource(after, r.type, r.name, r.language)?.data ?? new Uint8Array(),
      r.data,
      `${String(r.type)}/${String(r.name)}`,
    );
  }

  // growing it again reuses its place at the end
  const again = parsePe(replaceResource(grown, moved ?? scene, new Uint8Array(big.length + 100)));
  assert.equal(again.sections.at(-1)?.virtualSize, rsrc.virtualSize + 100);
});

test("replaceResource does not grow an image with unknown data after its last section", () => {
  const image = parsePe(Uint8Array.from([...exe(), 1, 2, 3]));
  const scene = findResource(readResources(image), "SCENE", 1004);
  assert.ok(scene);
  assert.throws(
    () => replaceResource(image, scene, new Uint8Array(scene.data.length + 1)),
    PeFormatError,
  );
});
