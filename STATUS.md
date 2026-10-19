# Project status

Where the reverse engineering of `GameOfRobot.exe` and the level editor stand: what is
decoded and verified, what the editor supports, what is still open and where to pick it up.
Setup and commands are in the [README](README.md). Last updated: 2026-10-19.

## Goal and approach

A cross-platform level editor for _The Game of Robot_ (TOM Productions, Windows version
2018; episodes Junior, I, II, III, IV, numbered 0–4 in code). The game data is decoded from
the exe itself; findings are checked three ways where possible:

1. **Data:** invariants over all episodes (e.g. every exit cell has a matching one in the
   neighbouring room, scenes re-encode byte for byte).
2. **Code:** the game's own routines, read with `objdump -d -M intel` (addresses below are
   virtual addresses in the exe; `.text` file offset = address − 0x400000).
3. **The real game:** screenshots under Wine (`tools/wine/harness.py`, `pnpm robot shots`),
   compared pixel by pixel with our renderer. The harness runs the game silently and can
   press keys before the screenshot (`--keys`), e.g. to walk the hero somewhere.

## Working conventions

- **pnpm only**, never npm. Node ≥ 22.18 runs the TypeScript sources directly.
- **TypeScript: erasable syntax only** (no enums, no parameter properties, no namespaces),
  `.ts` extensions in imports, strict settings; `noUncheckedIndexedAccess` is deliberately
  off (so typescript-eslint flags `?? 0` after array indexing as unnecessary).
- **Lint/format:** ESLint (typescript-eslint strict + stylistic, type-checked), Prettier with
  the trivago import sort plugin. `pnpm check` runs typecheck, lint, format check and tests;
  it must pass before committing.
- **Tests:** Vitest. `formats` and `tools` run in Node; `editor` runs in headless Chromium
  (browser mode via Playwright, desktop viewport 1500×900). Outputs are pinned by Vitest
  snapshots in `packages/formats/test/__snapshots__/` (small values readable, large ones as
  sha256); `pnpm snapshots` re-records them, and the diff must be reviewed.
- **Git:** commit freely; subject-only messages (a body only when important), **no
  attribution footer**; linear history (`merge.ff=only`, rebase on pull), never merge
  commits. Identity: bailli.
- **No game data in the repository:** `reference/` (the installer and exe), `resources/`,
  `shots/`, `.wine/`, `renders/` etc. are ignored. Snapshots store hashes, not content.
- **Wine:** the project prefix `.wine/` is sandboxed (no links into `$HOME`, no `Z:`).
  Don't run the game in other prefixes. Sound is off (audio drivers disabled per run).

## Repository map

| Path                    | Content                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `packages/formats/src`  | `@robot/formats`: all decoders/encoders, no dependencies, Node and browser                   |
| `packages/editor`       | `@robot/editor`: the browser editor (Vite, static build)                                     |
| `packages/tools/src`    | `@robot/tools`: CLI `pnpm robot …` (render, compare, eval, patch, shots), PNG via `fast-png` |
| `tools/wine/harness.py` | the only Python: drives the real game under Wine/Xvfb/xdotool                                |
| `shots.json`            | per reference screenshot: hash, palette offset, cells where our render still differs         |

Files in `packages/formats/src`:

| File                         | What it covers                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `pe.ts`, `resources.ts`      | PE headers, resource tree; replacing a resource in place or growing it at the end of `.rsrc`  |
| `crunched.ts`, `cp437.ts`    | CRUNCHED text compression, CP437                                                              |
| `texts.ts`                   | text resources: tile descriptions, messages, object names                                     |
| `scene-crypt.ts`, `scene.ts` | SCENE encryption, the SCNV3 room format (reader and writer), `resolveCell`                    |
| `omf.ts`, `shapes.ts`        | SHAPES resources (16-bit OMF objects), shape tables and frames                                |
| `palette.ts`                 | the 16-colour palettes per episode                                                            |
| `classes.ts`                 | object classes per tile type (vtables), frame/describe methods, underlays, patterns, font     |
| `render.ts`                  | drawing cells and rooms like the game                                                         |
| `exits.ts`                   | room connections: exits, scripts, doors, stairs, oracles, teleporters, actors                 |
| `describe.ts`                | the description the game shows for a cell                                                     |
| `room-names.ts`              | the name the game shows for a room                                                            |
| `script.ts`                  | compiled room scripts: reader, disassembler, compiler, the game's keywords and constants      |
| `records.ts`                 | what logic records do                                                                         |
| `actors.ts`                  | where moving actors come from (map cells, hatcheries, bombs, scorpion sand, records, scripts) |
| `game.ts`                    | `Game`: loads an exe, episodes lazily, saves edited scenes (`withScene`)                      |

## What is decoded and verified

### Resources and texts

- **PE resources** are read straight from the exe (7-Zip extraction is only an optional
  comparison). Resource ids per episode E (0–4): `1E02` shapes, `1E04` scene, `1E05` music,
  `1E06` sound table, `1E10` German texts, `1E11` English texts (Junior and I only);
  `9900`/`9901` episode list.
- **CRUNCHED** texts decode completely (all 15).
- **Texts** (`1E10`): numbered entries `N:k` with `|`-separated variants ending in `;`;
  headers without text share the next text. Entries 0–127 describe tile type N, higher
  numbers are messages (`Message(id, …)`); 510 is "no description". `displayText` removes
  colour codes (`²x`) and the wrapping of the game's message boxes.
- **Room names** (`room-names.ts`, 0x43c0b0): text entry 1000 + id (episode vtable
  +0x44); episode III keeps them in its own resource `1320` (name, then a description,
  marked by a leading `!`). A room from 100 on whose base cell (0, 1) has class 99 (tile
  0x54) shows the name of room id − 100 (caves, cellars). The text is cut to one line
  (0x43bfd0: underlines dropped, an empty line ends it; 0x438850 fetches texts without
  line breaks and with `_` as a hard space). Rooms without a name show "Szene <id>"
  (rooms 1 and 99, episode II's 600s, a few others). The game shows the whole text in
  the banner on entering a room (0x406560; episode III: name and description; seen under
  Wine for episode I room 42, underlines included) and names
  its own screenshots after the name (`R1-043-DER START.png`).
- **Sound tables** (`1E06`): `N:SOUND ;note`; the notes name objects by tile type
  (`21:QFANFARE ;O_KEY`) → `game.objectNames(e)`. Only items have names.

### Scenes (rooms)

- **SCENE** resources are XOR-encrypted (key: 25 low bytes of Borland `rand` after
  `srand(0xC40C)`). Format SCNV3 (documented in `scene.ts`): per room an id, tagged words,
  an RLE map of 4 layers (base and overlay, low/high byte) of 40×29 cells, then 11-byte
  logic records. **Re-encoding reproduces all five scenes byte for byte.**
- **Cells:** low byte = tile type, high byte = state. Type `0x7f` = logic cell, high byte
  = record slot. In memory the game converts types to class ids.
- **Room tags** (loader 0x438d10, stored at room record +0x14 …): kind 1 = exits byte,
  kind 5 = 8-character name (`BRANDUNG`, `LAVA`, … probably an ambient sound), kind 6 =
  length-prefixed payload (value 1 = script source, 2 = compiled script, 3 = a Unix time
  1993–2008 in every room, probably when the original editor saved it). Kind 2 = the
  room's darkness (Night, 20–100, read by `GetNight`), kind 4 × 10 = points for the
  first visit (0x42b640); kind 3 is not understood (see open items).
- **Saving:** `Game.withScene` writes edited rooms back. The original scenes fill their
  resources exactly, so edits usually grow them; a grown resource moves to the end of
  `.rsrc` (the last section), which grows, and the Authenticode signature is dropped.
  **Verified under Wine:** the game loads such an exe and shows the edit.

### Graphics

- **Shapes:** OMF objects with shape tables; descriptors of 12 bytes, frames of four 1-bit
  planes; pixel = 15 XOR the plane colours. `_Rob_object` is indexed by tile type,
  `_Aliens` holds the robots.
- **Palettes** per episode (16 colours; dark rooms use palette offsets at run time).
- **Object classes:** class table per episode (0x479ad8, 0x475838, 0x476e00, 0x477ca0,
  0x478c40; 128 entries); vtable +0x00 class id, +0x08 frame method, +0x28 room-load
  method (actors are created there), +0x54 describe method.
  Class 0 is the shared empty class (left out of the class→type table 0x4c70e0, 0x43b46a).
- **Renderer:** draws base cells as tiles and overlay cells as sprites with each class's
  frame method (12 methods incl. walls, terrain quarters, masks, doors, letters with the
  game font, underlays); logic cells show their record's cell. **698 cells differ** in 26
  reference screenshots (`pnpm robot eval`), most from runtime effects (see open items).
- **Reference screenshots of any room** use a patched exe (`patch.ts`): the room in the
  start room's slot, without scripts and without anything that moves or kills
  (`calmRoom`): cells whose class becomes an actor on entering the room (vtable +0x28,
  `ACTOR_LOAD_METHODS`: robots, androids, snakes, the worm, …), delayed creature sources
  (`HATCHING_LOAD_METHODS`: eggs, snake basket, "something behind the wall"), bombs
  (they release robots), sand heaps hiding scorpions (sand states 6/7) and
  spawner/creature records. Otherwise the hero can die before the
  screenshot and the death's message box covers the room.
- **The hero's start** is fixed per episode in the episode code (vtable +0x54: Junior
  0x40e1a0 (2, 14), I 0x408da0 (5, 14), II 0x409fa0 (6, 23), III 0x40b460 (8, 15), IV
  0x40d680 (13, 16)); the hero tile (type 1) in the map is cleared, not used. In a
  patched exe the hero therefore lands at that position in whatever room was put into
  the start slot (possibly in a wall or water).

### Room connections (`exits.ts`)

- **Grid:** north/south = id ∓ 10, west/east = id ∓ 1. The exits byte (tag kind 1, 2 bits
  per direction N, S, W, E at 0x439590): 0 = grid neighbour if it exists, 1 = room 2 (the
  "outside", e.g. episode III's sea), 2/3 = none. Walking off the map arrives on the
  opposite edge, same row/column (0x427a9b); row 0 lies under the status line.
- **Exit tiles** `0x0017` in walls are **closed** ("…still closed: first get rid of all
  robots"). Once the room has no robots left, task 0x66 (0x433a60, every 147 ms) opens
  them on edges whose direction leads somewhere (RoomNorth… ≠ 0), one tile per run and
  tick, into `0x0110` (north/south) or `0x0010` (west/east, drawn as arrows), and closes
  open ones on edges that lead nowhere. **Verified under Wine** (episode I room 43 without
  its robots, the editor's `withExitMode`): east "none" keeps its exit tiles closed,
  otherwise they open; west "neighbour" opens the west tile and walking out arrives in
  room 42 (its banner, its darkness, 1000 points = its tag kind 4 × 10); west "outside"
  arrives in room 2; the original byte (west "none") keeps the hero in the room. The exits
  byte (tag kind 1) is present only when not 0 and is then the room's first tag; mode 3
  works like 2 but no original uses it.
- **Scripts** (plain text, C-like) change `RoomNorth`…`RoomWest` and `BusWest`/`BusEast`
  (bus line in episode II); parsed with fixed vs. state-dependent marking.
  `Teleport(room, x, y)` does not move the hero: it sets the point returning teleporters
  (records with flag 0x02) lead to (0x4fe358/35a/35b, 0x407900).
- **Passages ±100** ("further in": building interiors, caves): door in = class 98 (tile
  0x53, state 6/7, a roof's door) → +100; door out = class 105 (0x5a) → −100; stairs =
  class 71 (0x3d), state bit 0 clear → +100 (down), set → −100 (up). All have their
  counterpart at the same place except 5 recorded one-way stairs.
- **Logic records with targets:** oracles (type 12, taken walking north), teleporters
  (13), travelling actors (8); target = room in bits 0–9 + x in bits 10–15 of offset 4,
  y at offset 6 (actors: x, y at bytes 6, 7).
- **Reachability** from each start room: everything except debug room 99 and the rooms
  listed under open items (snapshot in `exits.test.ts`).

### Room scripts (`script.ts`)

- **The game runs the compiled script** (tag 6/2); the source (6/1) is only text.
  **Verified under Wine:** a new compiled script in episode I's start room (a `for` loop
  placing keys with `SetObj`, source left unchanged) runs in the game.
- **Bytecode** (interpreter 0x4080e0, documented in `script.ts`): bits 4–5 of an
  instruction give the size of a signed operand (0/1/2/4 bytes), `b & 0xcf` the
  operation (push, load, store, arg, drop, call, end, jumps relative to the next
  instruction); bytes 0x80–0x96 are C operators. Values live on a ring of 30 entries,
  jumps and stores leave the top in place; arguments go to a separate stack.
- **Symbol table** at the start (`1e nn`, 14-byte entries: name, kind 1 variable /
  3 function, argument count). The loader (0x406da0) links it in place (`1e` → `1f`):
  names starting with an upper-case letter are looked up case-insensitively in the
  keyword table 0x4750d8 (62 records of 24 bytes: name, flags 0x40 function / 0x8n
  variable of width n, handler or address, arguments; `Area` exists with 3 and 4
  arguments); the others are local variables stored in the entry (0 on scene load).
- **Compiler** (`compileScript`): reproduces **all 128 compiled scripts byte for byte**
  from their sources: symbols in order of appearance, smallest operands, no constant
  folding, `&&`/`||` evaluate both sides, jump sizes from a first layout with 2-byte
  jumps. Statements: expressions, `if`/`else`, `for`, `return`, `?:`. Unknown functions,
  wrong argument counts and unknown `O_` constants are compile errors.
- **Constants** (`O_KEY`, …) are tile types: the sound table names plus
  `SCRIPT_OBJECT_CLASSES`, read from the compiled scripts and stored **by class** (their
  tile type differs per episode: `O_SAND` is class 39, tile 39 in Junior and 49
  elsewhere).
- **When scripts run** (0x4392e0…): on entering a room its script runs once from the
  top (after Newroom, RoomTime = 0, Night and the exits are set). The event functions
  (`Event(mask)`, `E_Take(type)`, `E_Drop`, `E_Area(n)`, `E_NewRoom(room)`, `E_Slot(n)`)
  register the code after their call as a handler (0x407b30; 20 handlers at 0x4c5df8)
  and return 0, so `if (Event(…)) { … return; }` is skipped then. When the event
  happens (0x408970) the script continues at that block with E_Value set, until
  `return` (without one it runs on into the code after the block). Events: 1 take,
  2 drop (filter: tile type, E_Value: the object), 4 walk areas from `SetWarea` (E_Value
  +n entering, −n leaving), 8 entering the room, 16 slots. **Verified under Wine:** in
  episode I's start room the top-level code and an `Event(8)` block both run. Room 1's script is the
  global one (episode start, game load); its handlers run when no room handler matches.
- **Functions and variables:** all 62 keywords are described in `script-docs.ts`
  (decoded from their handlers; a few meanings are guesses, marked there): e.g.
  `Message(text, delay)` shows a text after `delay` seconds in the room (all its `|`
  variants as pages one after another; with delay 0 at once and one variant at random), `SetObj(obj, x, y,
mode)` places objects, `Possess(obj)` tests the inventory (a state selects the exact
  variant), `SetMan` sends the dealer somewhere, `Enigma(n)` awards a solved puzzle once,
  `Wizzard(…)` places episode I's wizard. RoomTime counts seconds (147 ticks each);
  Val1…Val8 are free variables kept across rooms.
- `pnpm robot script E ROOM` shows a script and its disassembly; with a source file and
  an output exe it writes the script into the room (`withRoomScript`).

### Descriptions and logic records

- **Descriptions** (`describe.ts`, 0x406ae0): the cell's class picks the variant (37
  describe methods, all modelled), the text is the entry of the class's tile type; a
  negative variant is random (0x438850), a missing one shows entry 510.
- **Logic records** (`records.ts`), all 1177 in the game classified: 1 stacked (object on
  another cell, e.g. drawbridges), 3 buried (dug up with the shovel), 5 spawner (creature
  near the hero), 7 creature, 8 travelling actor, 11 logic-gate circuit node (episode I),
  12 oracle, 13 teleporter.
- **Travelling actors** (record type 8, `SetMan`): byte 8 is converted on scene load
  (0x432728): with bit 0x80 an index into the episode's actor kinds (episode +0x34, e.g.
  episode I 0x475c38: 0x100…0x105), else a tile type (its class); the originals use 0x83
  = kind 0x103 = **the dealer** (class 0x2c, buys platinum for points, sells items for
  gold, 0x448440) and 0x85 = kind 0x105 = **the thief** (class 0x4a, tile 0x40 in
  episodes I/II, "helps poor people": takes about half of the hero's items, 0x41f470).
  The actor walks towards the hero and stops next to it (no pathfinding; 0x4480d0).
  Once the hero dealt with it (trade, theft) it wanders at random, and stepping into an
  edge wall it vanishes and leaves a teleporter there for 1–2 s (0x420c30, task 0x8a) to
  the record's room at (x, y): following it at once takes the hero there. The actor is
  not moved into that room. **Verified under Wine:** a type-8 record added to episode I
  room 43 lets the dealer appear and walk up to the hero (bytes 0x03 and 0x83 alike;
  tile 3 is class 3, which happens to map to the dealer's kind). Leaving through the
  wall is from the code only.

## The editor (`pnpm editor`)

A static web page (Vite build, relative paths, no server; module scripts need any static
web server, not `file://`). The exe is read in the browser and never uploaded.

Supported:

- open/drop an exe (in development `reference/GameOfRobot.exe` opens by itself)
- episode and room selection, room list with edited rooms marked
- room drawn exactly as the renderer draws it (cell image cache, per-cell redraws)
- painting base or overlay with a tile from the episode's tiles (robots, which draw
  nothing as tiles, show their first sprite; other invisible tiles a hatching) or any hex
  value; right
  click picks; dragging fills lines; undo/redo per stroke; grid (G)
- exits line: N/S/W/E targets incl. script changes, doors/stairs, bus, oracles,
  teleporters, actors; arrow keys follow fixed exits; per direction the exits byte's
  setting (neighbour / outside / none) can be changed, undoably (`withExitMode`)
- map (button "Map", key M): the episode's rooms as thumbnails on their grid (row =
  tens, column = ones of the id, one block per hundred), named; between grid
  neighbours one arrow per direction: green open (exits byte), orange open but with exit
  tiles that do not arrive on exit tiles of the neighbour, dashed opened only by the
  script, grey closed; clicking an arrow opens or closes that exit (undoable); badges
  for the other links (doors, stairs, teleporters, oracles, actors, outside, far script
  exits) go to their room; clicking a room opens it
- visited rooms go into the browser's history and address (`#3/147`): the browser's
  back/forward (buttons, Alt+←/→, mouse buttons), the editor's own ◀/▶ buttons (showing
  the room they lead to) and Backspace move between them, across episodes; loading the
  page with a room in the address opens that room
- the room's name next to the title (and in the room list's, exits' and history's
  tooltips; episode III's descriptions in the name's tooltip)
- tile names (items) and the game's descriptions in tooltips and the hover line; logic
  cells say what their record does
- logic records: clicking a magenta cell (or any cell with the Inspect tool) opens an
  inspector with the record's fields per type (cells with previews, target room with
  "Go", arrival position, spawner radius/period, …) and the raw bytes; change the type,
  add a record to a plain cell (it shows the cell it replaces, lowest free slot < 200),
  remove one (the cell becomes what it showed); all undoable
- actors (toggle "Actors", key A): marks where actors appear (ring: placed in the map;
  dashed: appear later or from a record; spawner radius; arrow: heading somewhere),
  robots drawn with the episode's `_Aliens` sprites in turn (their look and colours vary
  in the game); a list below the map groups them with name, origin and positions (click
  to select), plus what the script's `RandObj(…)` does with the room's current number
- the room's script below the map: names explain themselves on hover (functions,
  game variables, `O_` constants as tiles, message ids as their text, room numbers as
  room names), calls with plain coordinates (`SetWarea`, `SetObj`, `Area`, …) outline
  their cells on the map; the bytecode on request; Edit compiles while typing (errors
  with line and column) and Apply sets source and compiled script as one undo step
- save: downloads the exe with all edited episodes (warns about unsaved changes on leave)

Not supported (yet):

- painting over logic cells (use the inspector); records are edited field by field, no
  copy/paste of records between rooms
- editing the other tags (darkness, points, ambient name, kind 3); adding, deleting or
  copying rooms; painting exit tiles is plain painting (0x0017 in the base layer)
- fill, copy/paste of areas, tile search/filter
- English UI texts / English descriptions (German only; English exists for Junior and I)
- remembering the last exe or unsaved work across reloads
- any check that an edited room is still playable

## Open items and leads

Roughly by value for the editor.

1. **Logic records in play.** The inspector edits all record types. Verified in the real
   game: a teleporter added next to the hero's start (episode I room 43, (6, 14), to room
   11 at (20, 15)) takes the hero exactly there. Other record types are only
   round-tripped through the scene writer. Fields of types 7 and 11 are only partly
   understood. **How to test an edit in the game:** build the exe (`Game.withScene`, or
   the editor's "Save exe"), put the change next to the hero's start (see "The hero's
   start" above) and run `python3 -I tools/wine/harness.py shot E OUT.png --exe EXE --keys
Right` (`--debug DIR` saves every step); the game's screenshot file name tells the room
   it ended in. There is no CLI command for this yet (the teleporter test was a one-off
   script).
2. **Actors.** Known: creation (0x44dc60, kinds 0x100 + n → class via 0x47ec98, 20
   factories registered by class id, 0x44d4e0), which tiles and records produce actors,
   robots' sprites (`_Aliens`, `1E01`) and random colours. Open: the exact sprite order
   (which actors count before a robot), sprites of the other actors (androids etc. use
   their tile graphic in the editor), and the six dwords
   after the class id in each 0x47ec98 entry. Kinds found so far: 0x100 hero, 0x101
   robot, 0x102 the hero's double (class 3), 0x103 the dealer (class 0x2c), 0x104
   android (episode III: snake), 0x105 the thief (class 74, tile 0x40), 0x106 turtle,
   0x107 friendly native, 0x108 wild boar (the last three episode III), 0x109 episode IV
   robot, 0x10a episode IV tile 0x0c. **Robot-free room** (0x4fe3bc, a word in the
   saved game state, episode code +0x158): in that room no robots (kind 0x101 / class 2),
   androids (0x104 / class 0x2d) or worms (class 0x45, tile 0x37) are created (0x44dc60,
   0x44d520), and hatching sources (0x4237e0's task 0x433e80) release nothing. It is set
   by episode II's **telephone** (tile 0x5f, class 110, 12 rooms): using it asks for a
   number (text 400, 4 digits, 0x41e4d0), dialled numbers are looked up in the table at
   0x47efe0 (32-byte entries: number +0x08, text +0x0c, handler +0x18; 1141 wake-up call
   402, 1131 telegrams 403, 1191 time 404, 110 police 405, 112 fire brigade 406, 3786
   travel agency 407, 9991 "Ghostbusters" 408). The Ghostbusters (0x41e100) ask for a
   room number and then a credit card number; `atol` of it = 0x32a079 (**3317881**)
   stores the room for good (later calls say "still busy in room %d"), any other
   number stores −1; the next call ("you again, the number was wrong") then probably
   resets to 0 (its prompts have no input fields and the room is read from an empty
   buffer), a wrong number in that path stores −2 (never again). From the code only,
   not tried in the game; not modelled (it is game state, not level data).
   `RandObj(O_X, min, max)` (0x4073a0, `randomPlacement`) keeps the room's number of
   tile type O_X between min and max: it counts what is there, removes random ones above
   and adds missing ones on empty cells (20 tries each), robots and androids within ±10
   columns / ±5 rows of a reference point on the far side from where the hero entered
   (0x4fe30b/0x4fe30c, set when walking off an edge, 0x44c5a0: entering from the west
   (25, 14), east (15, 14), north (20, 22), south (20, 7); the bus (20, 14); teleporters
   and stairs keep the old one), other objects anywhere. The script's
   `Teleport(room, x, y)` only sets where returning teleporters lead (0x407900). Script
   object names are tile types (`scriptConstants`, see room scripts above). The editor's `RandObj` counts
   (`randomPlacement`) look at map cells only; the game also counts actors standing on
   cells (0x407650 via 0x433230), e.g. those from records.
3. **Scripts.** Decoded, compiled and editable (see room scripts above). Open: a few
   functions in detail (`ShiftArea`, what triggers `Area(x, y, size)`, `Phone`'s third
   argument, `Enigma`'s table at episode +0x1cc), how E_Value (a class id in memory) is
   compared with tile types, StationBOff/NoSwim, and whether `while`, `break` or compound
   assignments existed in the original language (no script uses them). Of edited scripts
   only `SetObj`, `for` and an `Event(8)` handler are verified in the game.
4. **Room tag kind 3** (record +0x16 byte, values 2/3): meaning unknown. (Kind 2 is the
   darkness, kind 4 × 10 the first visit's points, see room tags above.)
5. **Rooms not reached** by any decoded connection: episode I 228 (runs `Wizzard(…)`),
   episode II 242 (only one-way stairs out), episode III 149 and 3; room 99 is a debug room
   in every episode. Probably entered via game code (e.g. 0x44bd2b takes a room from a
   table). The episode II jump to room 600 at 0x40a820 is not understood either.
6. **Renderer gaps** (`pnpm robot eval --types`): empty floor in episodes I/II (runtime:
   actors, hero, animations), episode IV types 95/106/79/99/70, episode III types 83, 37,
   49, 76, episode II 85/77/110/25, Junior 23/25 (animated). Some are runtime effects that
   a static render cannot match. Logic cells in some dark rooms (episode I room 11's
   teleporters) are drawn on black in the game but on colour 15 by us.
7. **Description extras:** key colours (strings 0x9c50/0x9c51 from the exe's string
   table), messages 200/201 added by two classes, codes formatted by 0x41d2c0/0x40ff80, and
   four describe methods that depend on game flags/options.
8. **Not decoded at all:** MUSIC and PCXBITMAP resources, the obfuscated command strings
   near 0x4828d4 ("Command %s unknown!", probably cheats; two jump ±100 rooms).
9. **Saving details:** the PE checksum is not updated (Windows does not check it for
   exes); a moved resource leaves zeroed space behind.
10. **The game's map in memory is one layer** (0x5197f8 + 0xc, 40×29 words, followed by
    the actor grid at + 0x91c), while scenes store base and overlay. How the two are
    merged on loading is not known; "empty cell" (RandObj, the free-cell check 0x433230)
    is approximated as base and overlay both 0.
11. **Two edge-exit code paths:** 0x427a9b (arrival only) and 0x44c5a0 (also sets the
    RandObj reference point; with game flag bit 10 of [0x51bb18]+8 clear, the arrival
    moves one cell further in). Which one runs when is not known.
12. **Scorpion sand** (sand states 6/7) is confirmed by the texts in episodes II and III
    only; in episode IV those states read "Noch mehr Sand" (one cell in the game, still
    treated as scorpions by `cellActorSource`).

## Limits and what is shared between episodes

- **Rooms:** at most 200 per episode (scene loader 0x438d10). Room ids are free 16-bit
  numbers; the game finds rooms by id (0x4390f0). Practical limits: targets in records
  have 10 bits (≤ 1023); room names are text entries 1000 + id (e.g. 1043 "DER START",
  episode III: resource 1320),
  and new names need a CRUNCHED **encoder**, which does not exist yet. Start rooms are
  fixed in the episode code (+0x54 of the episode vtable). Adding a room to an episode
  is therefore possible (new id, link it by grid id, stairs ±100 or a teleporter).
- **Episodes** are objects with their own vtables (Junior 0x466cd8, I 0x466458, II
  0x4665a8, III 0x466b08, IV 0x466c38, base 0x46cdf0); 22 of 28 slots are overridden
  somewhere (start position, special events, episode II's jump to room 600, …).
- **Engine-wide:** logic record handling (lookup, step-on 0x44cb60, room load 0x42b6f0,
  the spawner tick 0x435650 in the global task list 0x46cc24…) and the class code itself.
  Any record type works in any episode, as far as the classes and actors it refers to
  exist there.
- **Per episode:** the tile type → class table (128 entries, fixed data in the exe), the
  shapes (`1E02`), texts (`1E10`), sound table (`1E06`) and palette. Classes only one
  episode maps: Junior 5, I 3, II 28, III 46, IV 50. Using such a class elsewhere would
  need a patched class table (an unused tile type), new shapes in that episode's SHAPES
  resource (OMF) and texts; some class code also checks the episode number (e.g. describe
  method 0x4145b0).

## Useful addresses

| Address                      | What                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| 0x438d10                     | scene loader (tags → room record +0x14…)                                       |
| 0x439590                     | exit target per direction from the exits byte                                  |
| 0x427a9b                     | hero leaves the map → `NxtRoom` (0x4fe2f6), arrival x/y 0x4fe309/0x4fe30a      |
| 0x433a60, 0x433c30           | open/close exit tiles on the edges (task 0x66, started on entering a room)     |
| 0x413d30, 0x4140d0, 0x426880 | door in, door out, stairs                                                      |
| 0x412ae0, 0x44cc30           | oracle, teleporter (step-on handler 0x44cb60)                                  |
| 0x42b6f0                     | room load: records 7/8 spawn actors                                            |
| 0x432fd0, 0x433110           | logic record lookup; a cell's effective value                                  |
| 0x406ae0, 0x438850           | describe a cell; fetch a text variant                                          |
| 0x43c0b0, 0x43bfd0           | a room's name; cut a text down to one line                                     |
| 0x43b2e0, 0x43b46a           | episode constructor; class tables 0x4c6ce0 (objects) / 0x4c70e0 (class → type) |
| 0x4fe2fc, 0x4fe35e…0x4fe364  | current room; RoomNorth/South/West/East                                        |
| 0x44c5a0, 0x44c680           | hero walks off an edge (sets the RandObj reference point); pending room change |
| 0x44dc60, 0x44d520           | create an actor (kind, x, y); factory lookup by class                          |
| 0x4073a0, 0x407650           | script RandObj; count a tile type in the room                                  |
| 0x41e4d0, 0x47efe0, 0x41e100 | telephone (episode II): dial; numbers → handlers; Ghostbusters (robot-free)    |
| 0x4827f0                     | base palette (episode III: 0x477c10)                                           |
| 0x481170                     | 8×8 font                                                                       |
| 0x4750d8                     | script keywords (functions and variables)                                      |
| 0x406da0, 0x4080e0, 0x407fa4 | link a compiled script; run it; clear a room's handlers                        |
| 0x407b30, 0x408970           | register an event handler; raise an event                                      |
| 0x4394f3                     | entering a room runs its script                                                |

## Gotchas

- Tile type 0x53 is the **roof** (state 6/7 its door), not a staircase; real stairs are 0x3d.
- Records store cells as tile types (like the map), even though the game holds class ids
  in memory.
- Vitest browser tests: `page.getByTitle` did not match multi-line titles; query the DOM
  instead. Failure screenshots go to `.vitest/` (ignored).
- `pkill -f "<pattern>"` in a shell whose command line contains the pattern kills that
  shell; use `pkill -f "[v]ite …"`.
- The game names its screenshots after the room; a name with `_` (a hard space, 0x1f)
  makes that fail ("Screenshot ERROR 123", e.g. episode I room 42), so the harness gets
  no file in such rooms (its `--debug` captures still show the screen).
- Wine harness: the game sometimes does not come up in time ("xdotool search …" fails);
  just run the shot again. Debug room 99 shows no room banner on a repeated start (the
  harness only warns). After the dialogs the harness presses Return until nothing
  reacts; a Return that opens something in the room would end up in the screenshot
  (not seen so far, review finding).
- Each `App` in the editor listens on `window`; tests must `dispose()` old instances,
  or they react to history and key events too.
