import { expect, test } from "vitest";

import { roomScript } from "../src/exits.ts";
import { EPISODES, Game } from "../src/game.ts";
import { type ScriptHandler, scriptHandlers } from "../src/script-handlers.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

/** A handler with line numbers in place of offsets, as the editor shows them. */
function lines(source: string, h: ScriptHandler) {
  const line = (at: number) => source.slice(0, at).split("\n").length;
  return {
    lines: [line(h.at), line(h.to)],
    events: h.events,
    conditional: h.conditional,
    returns: h.returns,
    runsOn: h.runsOn === undefined ? undefined : line(h.runsOn),
    again: h.again.map(line),
  };
}

const handlers = (source: string) => scriptHandlers(source).map((h) => lines(source, h));

test("the original scripts have 27 handlers; two run on into another one", () => {
  const all = EPISODES.flatMap((episode) =>
    game
      .episode(episode)
      .rooms.flatMap((room) =>
        handlers(roomScript(room)).map((h) => ({ room: `${episode} ${room.id}`, ...h })),
      ),
  );
  expect(all.length).toBe(27);
  // the global script: the lamp lights dark rooms
  expect(all.find((h) => h.room === "1 1")).toEqual({
    room: "1 1",
    lines: [1, 13],
    events: "take · drop · entering the room",
    conditional: false,
    returns: false,
    runsOn: undefined,
    again: [],
  });
  const again = all.filter((h) => h.again.length > 0);
  expect(again.sort((a, b) => a.room.localeCompare(b.room))).toEqual([
    // if(Event(8) != 0) { beam(0, 1); beam(1, 2); } if(Event(4)) …
    expect.objectContaining({ room: "4 145", lines: [5, 9], conditional: true, again: [11] }),
    // taking anything but the cubicle runs on
    expect.objectContaining({ room: "4 156", lines: [3, 11], runsOn: 13, again: [13] }),
  ]);
  // room 157's area handler returns before its drop handler
  expect(all.filter((h) => h.room === "4 157").map((h) => [h.events, h.returns])).toEqual([
    ["walk area", true],
    ["drop", false],
  ]);
});

test("handlers name their events and say where a script runs on", () => {
  const source = [
    "SetWarea(1, 2, 3, 4);", // 1
    "if ((ev = Event(EV_TAKE | (EV_DROP + 32))))", // 2
    "   Message(1, 0);", // 3
    "if (E_Take(O_KEY) && ok)", // 4
    "   { if (x) return; else { return; } }", // 5
    "for (i = 0; i < 2; i = i + 1)", // 6
    "   if (E_Area(i)) { Score; }", // 7
    "if (E_NewRoom(12)) ; else Event(n);", // 8
    "if (!E_Slot(3)) x = 1;", // 9
    "return;", // 10
    "Event(1);", // 11
  ].join("\n");
  expect(handlers(source)).toEqual([
    {
      lines: [2, 3],
      events: "take · drop · event 32",
      conditional: false,
      returns: false,
      runsOn: 4,
      // E_Take; E_Area in the loop, E_NewRoom and the Event of its else (run when it
      // registers), E_Slot
      again: [4, 7, 8, 8, 9],
    },
    {
      lines: [4, 5],
      events: "taking O_KEY",
      conditional: true,
      returns: true,
      runsOn: undefined,
      again: [],
    },
    // in a loop: it runs on into the loop again
    {
      lines: [7, 7],
      events: "walk area i",
      conditional: false,
      returns: false,
      runsOn: 6,
      again: [7, 8, 8, 9],
    },
    // an empty statement
    {
      lines: [8, 8],
      events: "entering room 12",
      conditional: false,
      returns: false,
      runsOn: 9,
      again: [9],
    },
    // what runs on after it is a return
    {
      lines: [9, 9],
      events: "slot 3",
      conditional: true,
      returns: false,
      runsOn: undefined,
      again: [],
    },
  ]);
});

test("half-written scripts still show their handlers", () => {
  expect(handlers("if (Event(8)) {\n Message(1, 0);")).toMatchObject([
    { lines: [1, 2], events: "entering the room", runsOn: undefined },
  ]);
  expect(handlers("if (Event(")).toMatchObject([{ events: "Event()" }]);
  expect(handlers("if (Event(n))")).toMatchObject([{ events: "Event(n)", lines: [1, 1] }]);
  // masks as wide as the compiler's 32 bits
  expect(handlers("if (Event(0x80000000 | 1))")).toMatchObject([
    { events: "take · event 2147483648" },
  ]);
  expect(handlers("if (Event(0xFFFFFFFF))")[0].events.split(" · ")).toHaveLength(32);
  expect(handlers("} else if (E_Drop(O_KEY) x = 1; }")).toMatchObject([
    { events: "dropping O_KEY" },
  ]);
});
