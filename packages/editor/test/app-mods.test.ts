import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { type Mod, NO_CHANGES, emptyMod, modJson, parseMod } from "@robot/formats";

import { app, bytes, game, useApp } from "./app-setup.ts";

useApp();

// saving offers a download: a link is clicked
beforeEach(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const status = () => document.querySelector(".status")?.textContent;
const button = (name: string) => page.getByRole("button", { name, exact: true });

/** A mod giving episode I's room 44 a new name and making room 45 a copy of 43. */
function aMod(): Mod {
  return {
    ...emptyMod(bytes, "test"),
    changes: {
      ...NO_CHANGES,
      texts: [{ resource: 1110, entry: 1044, variants: ["DER GANG\\\n════════"] }],
      rooms: [{ episode: 1, id: 45, room: { ...game.room(1, 43), id: 45 } }],
    },
  };
}

test("a mod opens on top of the exe, edits save into it, the exe is made from it", async () => {
  await expect.element(button("Open mod…")).toBeEnabled();
  app.loadMod(modJson(aMod()), "test.robotmod.json");
  expect(status()).toBe("test.robotmod.json opened");
  expect(app.editor?.roomName(1, 44)?.name).toBe("DER GANG");
  expect(app.editor?.isEdited(1, 45)).toBe(true);
  expect(app.editor?.dirty).toBe(false);
  // with a mod the exe can be saved at any time
  await expect.element(button("Save exe")).toBeEnabled();
  app.editor?.setRoomName(1, 43, "NEUER START");
  const saved = parseMod(app.saveMod() ?? "");
  expect(status()).toBe("Saved test.robotmod.json");
  expect(saved.changes.texts.map((c) => c.entry)).toEqual([1043, 1044]);
  expect(saved.changes.rooms.map((c) => c.id)).toEqual([45]);
  expect(app.editor?.dirty).toBe(false);
});

test("without a mod, saving one names it after the exe", () => {
  app.editor?.setRoomName(1, 43, "NEUER START");
  const saved = parseMod(app.saveMod() ?? "");
  expect(status()).toBe("Saved GameOfRobot.robotmod.json");
  expect(saved.changes.texts.map((c) => [c.resource, c.entry])).toEqual([[1110, 1043]]);
});

test("a broken mod or one for another exe changes nothing", () => {
  const before = app.editor;
  expect(() => {
    app.loadMod("{", "broken.json");
  }).toThrow();
  expect(status()).toMatch(/^Cannot open broken\.json: not JSON/);
  const other = { ...aMod(), base: "0".repeat(64) };
  expect(() => {
    app.loadMod(modJson(other), "other.json");
  }).toThrow();
  expect(status()).toBe("Cannot open other.json: base: the mod is for another exe");
  expect(app.editor).toBe(before);
});
