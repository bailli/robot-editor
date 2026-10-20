import { expect, test } from "vitest";

import { EPISODES, Game, roomNamesId } from "../src/game.ts";
import { ROOM_NAME_ENTRY, parseRoomName, roomNameText } from "../src/room-names.ts";
import { parseTexts } from "../src/texts.ts";
import { exe, sha256 } from "./data.ts";

const game = new Game(exe());

test("the game cuts room texts down to one line", () => {
  expect(parseRoomName("*** Das Versteck ***")).toEqual({ name: "Das Versteck" });
  // underlines dropped, "_" indents underlines, an empty line ends the name
  expect(parseRoomName("_RAUM DES\\\n_════════\\\nZAUBERSTABS\\\n═══════════")).toEqual({
    name: "RAUM DES ZAUBERSTABS",
  });
  expect(parseRoomName("KAMPFPLATZ\\\n══════════\\\n\\\nBaue Fallen!")).toEqual({
    name: "KAMPFPLATZ",
  });
  // "!": a name and a description
  expect(parseRoomName("!Der Binnensee\\\nDies ist ein\nBinnensee.")).toEqual({
    name: "Der Binnensee",
    description: "Dies ist ein Binnensee.",
  });
});

test("rooms have names, caves share the name of the room above", () => {
  expect(game.roomName(0, 31)).toEqual({ room: 31, name: "Das Versteck" });
  expect(game.roomName(1, 43)).toEqual({ room: 43, name: "DER START" });
  expect(game.roomName(2, 143)).toEqual({ room: 43, name: "Die Waldpyramiden" });
  expect(game.roomName(3, 111)?.room).toBe(11);
  expect(game.roomName(4, 275)?.room).toBe(175);
  // the game shows "Szene <id>" for these
  const unnamed = EPISODES.map((e) =>
    game
      .episode(e)
      .rooms.filter((r) => !game.roomName(e, r.id))
      .map((r) => r.id)
      .sort((a, b) => a - b)
      .join(" "),
  );
  expect(unnamed).toMatchInlineSnapshot(`
    [
      "1",
      "1 99",
      "1 99 600 601 611 623 624 631 633 634 642 643 644 651 652 654 661 662 663 664 672 673 674",
      "1 3 99",
      "1 2 99",
    ]
  `);
  const names = EPISODES.map((e) =>
    game
      .episode(e)
      .rooms.map((r) => JSON.stringify(game.roomName(e, r.id)))
      .join("\n"),
  );
  expect(names.map(sha256)).toMatchSnapshot();
});

test("new names are written like the episode writes its names", () => {
  for (const episode of EPISODES) {
    for (const room of game.episode(episode).rooms) {
      const name = game.roomName(episode, room.id);
      if (name?.room !== room.id) continue;
      const texts = parseTexts(game.textSource(roomNamesId(episode)) ?? "");
      const old = texts.entries.get(ROOM_NAME_ENTRY + room.id)?.[0];
      // the game's name of the rewritten text is the name
      expect(parseRoomName(roomNameText(name.name, episode, old)).name).toBe(name.name);
    }
  }
  expect(roomNameText("DER START", 1)).toBe("DER START\\\n═════════");
  expect(roomNameText(" Die Festung", 0)).toBe("*** Die Festung ***");
  expect(roomNameText("Der Landeplatz", 4)).toBe("Der Landeplatz");
  expect(roomNameText("Der See", 3, "!Der Binnensee\\\nDies ist ein\nBinnensee.")).toBe(
    "!Der See\\\nDies ist ein\nBinnensee.",
  );
  expect(roomNameText("Neu", 1, "*** Alt ***")).toBe("*** Neu ***");
});
