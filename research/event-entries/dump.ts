// Scratch: per episode classes (vtable per type), event table, script Enigma calls.
import { readFileSync, writeFileSync } from "node:fs";

import {
  Game,
  disassemble,
  parseCompiledScript,
  readEventTable,
  roomCompiledScript,
} from "../../packages/formats/src/index.ts";
import { readClassTable } from "../../packages/formats/src/classes.ts";
import { readVa } from "../../packages/formats/src/pe.ts";

const exe = new URL("../../reference/GameOfRobot.exe", import.meta.url);
const game = new Game(new Uint8Array(readFileSync(exe)));
const u32 = (va: number) => {
  const b = readVa(game.image, va, 4);
  return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] * 0x1000000);
};
const out: unknown[] = [];
for (let e = 0; e < 5; e++) {
  const ep = game.episode(e);
  const table = readClassTable(game.image, e);
  const types = [];
  for (const [type, c] of ep.classes.classes) {
    types.push({ type, id: c.id, object: table[type].object, touch: c.touchMethod, load: c.loadMethod });
  }
  const events = readEventTable(game.image, e);
  const scripts: { room: number; enigma: (number | string)[]; text: string }[] = [];
  for (const room of ep.rooms) {
    const compiled = roomCompiledScript(room);
    if (!compiled) continue;
    const dis = disassemble(parseCompiledScript(compiled));
    const lines = dis.split("\n");
    const enigma: (number | string)[] = [];
    lines.forEach((l, i) => {
      if (/CALL ENIGMA\b/i.test(l)) enigma.push(lines.slice(Math.max(0, i - 3), i).join(" ; "));
    });
    if (enigma.length) scripts.push({ room: room.id, enigma, text: "" });
  }
  out.push({ episode: e, types, events, scripts, recordCount: ep.rooms.reduce((n, r) => n + r.records.length, 0) });
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
void u32;
