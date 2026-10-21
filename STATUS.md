# Project status

Where the reverse engineering of `GameOfRobot.exe` and the level editor stand: what is
decoded and verified, what the editor supports, what is still open and where to pick it up.
Setup and commands are in the [README](README.md). Last updated: 2026-10-20.

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

What the game itself says helps too: its help texts (text 995 in each episode: controls,
the rucksack) and the official info booklets (see Resources in the README) with hints
for episodes I–IV.

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
  sha256); `pnpm snapshots` re-records them, and the diff must be reviewed. Almost all
  tests need `reference/GameOfRobot.exe`; the few that don't are listed in
  `pnpm test:without-game` (add new data-free test files there), which is what CI runs.
- **Git:** commit freely; subject-only messages (a body only when important), **no
  attribution footer**; linear history (`merge.ff=only`, rebase on pull), never merge
  commits. Identity: bailli. **Never push**: only the user pushes to `origin` (GitHub).
- **CI:** `.github/workflows/ci.yml` (typecheck, lint, format, `test:without-game`, editor
  build) deploys `packages/editor/dist` to GitHub Pages from `main`.
- **No game data in the repository:** `reference/` (the installer and exe), `resources/`,
  `shots/`, `.wine/`, `renders/` etc. are ignored. Snapshots store hashes, not content.
- **Wine:** the project prefix `.wine/` is sandboxed (no links into `$HOME`, no `Z:`).
  Don't run the game in other prefixes. Sound is off for screenshots (audio drivers
  disabled per run); `harness.py play` keeps it on unless `--mute`.

## Repository map

| Path                    | Content                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `packages/formats/src`  | `@robot/formats`: all decoders/encoders, no dependencies, Node and browser                    |
| `packages/editor`       | `@robot/editor`: the browser editor (Vite, static build; CodeMirror 6 for the script source)  |
| `packages/tools/src`    | `@robot/tools`: CLI `pnpm robot …` (render, compare, eval, patch, shots, script, start, play) |
| `tools/wine/harness.py` | the only Python: drives the real game under Wine/Xvfb/xdotool                                 |
| `shots.json`            | per reference screenshot: hash, palette offset, cells where our render still differs          |

Files in `packages/formats/src`:

| File                         | What it covers                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `pe.ts`, `resources.ts`      | PE headers, resource tree; replacing a resource in place or growing it at the end of `.rsrc`   |
| `crunched.ts`, `cp437.ts`    | CRUNCHED text compression (decoder and encoder), CP437                                         |
| `texts.ts`                   | text resources: tile descriptions, messages, object names; setting an entry                    |
| `scene-crypt.ts`, `scene.ts` | SCENE encryption, the SCNV3 room format (reader and writer), `resolveCell`                     |
| `omf.ts`, `shapes.ts`        | SHAPES resources (16-bit OMF objects), shape tables and frames                                 |
| `palette.ts`                 | the 16-colour palettes per episode                                                             |
| `classes.ts`                 | object classes per tile type (vtables), frame/describe methods, underlays, patterns, font      |
| `render.ts`                  | drawing cells and rooms like the game                                                          |
| `exits.ts`                   | room connections: exits, scripts, doors, stairs, oracles, teleporters, actors                  |
| `describe.ts`                | the description the game shows for a cell                                                      |
| `room-names.ts`              | the name the game shows for a room; a name's text in the episode's style                       |
| `room-tags.ts`               | a room's darkness, points for the first visit, music and episode III flags; changing them      |
| `music.ts`                   | MUSIC resources: the names of their pieces                                                     |
| `start.ts`                   | the room and cell an episode starts in, and patching them                                      |
| `script.ts`                  | compiled room scripts: reader, disassembler, compiler, the game's keywords and constants       |
| `script-docs.ts`             | what the script functions and variables do, how scripts and events run                         |
| `records.ts`                 | what logic records do                                                                          |
| `circuits.ts`                | logic circuits: the game's trace and evaluation, what each node gets, problems                 |
| `events.ts`                  | the episodes' event tables: first takes and events, their points (`Enigma`)                    |
| `actors.ts`                  | where moving actors come from (map cells, hatcheries, bombs, scorpion sand, records, scripts)  |
| `game.ts`                    | `Game`: loads an exe, episodes lazily, saves edited scenes and texts (`withScene`, `withText`) |

## What is decoded and verified

### Resources and texts

- **PE resources** are read straight from the exe (7-Zip extraction is only an optional
  comparison). Resource ids per episode E (0–4): `1E02` shapes, `1E04` scene, `1E05` music,
  `1E06` sound table, `1E10` German texts, `1E11` English texts (Junior and I only);
  `9900`/`9901` episode list.
- **CRUNCHED** texts decode completely (all 15) and are encoded again (`crunch`): the 90
  most frequent characters in the table (the originals' order of equally frequent ones is
  not reproduced, the code lengths and sizes are). The game reads bytes until the
  resource ends and decodes a symbol only while more than 8 bits are left (0x4314b0), so
  the originals lose their last line feed or letters; `crunch` adds line feeds at the end
  so nothing of the text is lost. The text loader (0x438710) ignores the size, allocates
  size + 8 × entries and indexes every line starting with digits and a colon (0x431300,
  `countEntries`; equal to the header's count in all 13 texts, the sound tables are read
  elsewhere); lookups are linear (0x438850), so the order of entries does not matter.
  **Verified under Wine:** a re-encoded episode I text with a new room name entry shows
  that name in the banner and the screenshot's name.
- **Texts** (`1E10`): numbered entries `N:k` with `|`-separated variants ending in `;`;
  headers without text share the next text. Entries 0–127 describe tile type N, higher
  numbers are messages (`Message(id, …)`); 510 is "no description". `displayText` removes
  colour codes (`²x`) and the wrapping of the game's message boxes; `_` is a hard space.
  **Tiles in texts** (`textPieces`, drawn by 0x42a56b): `@` + 1–4 hex digits is a tile
  (type | state << 8, e.g. "bei der Bank @14") drawn as a cell, two characters wide;
  `*0`/`*1`/`*2` after it draw it three times enlarged, one 12-pixel slice per line;
  `@@` is `@`; `@~` + up to 8 hex digits is a game object filled in by the code. Menu
  texts also use letters (`@S`, `@M`, `@T`, …; not traced). The editor draws the tiles in
  the hover line and the tile text, tooltips name them (`[Sickle]`).
- **Room names** (`room-names.ts`, 0x43c0b0): text entry 1000 + id (episode vtable
  +0x44); episode III keeps them in its own resource `1320` (name, then a description,
  marked by a leading `!`). A room from 100 on whose base cell (0, 1) has class 99 (tile
  0x54) shows the name of room id − 100 (caves, cellars). The text is cut to one line
  (0x43bfd0: underlines dropped, an empty line ends it; 0x438850 fetches texts without
  line breaks and with `_` as a hard space). Rooms without a name show "Szene <id>"
  (rooms 1 and 99, episode II's 600s, a few others). The game shows the whole text in
  the banner on entering a room (0x406560; episode III: name and description; seen under
  Wine for episode I room 42, underlines included) and names
  its own screenshots after the name (`R1-043-DER START.png`). Styles: episode I
  underlines (`DER START\` + a line of `═`), Junior and II frame with stars
  (`*** Die Festung ***`), III and IV write plainly; `roomNameText` writes new names so.
- **MUSIC** (`1E05`, `music.ts`): "MUC1" at 0x1a, the number of instruments (u32 at
  0x22, 32-byte entries from 0x30, name first), the number of pieces (u16 at 0x2e), then
  86-byte piece entries starting with an 8-byte CP437 name (sorted; songs and sound
  effects alike: 26, 48, 72, 55, 64 pieces), then the music data (not decoded). Every
  room's music names a piece of its episode, but for `HUMBA`.
- **Sound tables** (`1E06`): `N:SOUND ;note`; the notes name objects by tile type
  (`21:QFANFARE ;O_KEY`) → `game.objectNames(e)`. Only items have names.

### Scenes (rooms)

- **SCENE** resources are XOR-encrypted (key: 25 low bytes of Borland `rand` after
  `srand(0xC40C)`). Format SCNV3 (documented in `scene.ts`): per room an id, tagged words,
  an RLE map of 4 layers (base and overlay, low/high byte) of 40×29 cells, then 11-byte
  logic records. **Re-encoding reproduces all five scenes byte for byte.**
- **Cells:** low byte = tile type, high byte = state. Type `0x7f` = logic cell, high byte
  = record slot. In memory the game converts types to class ids.
- **Room tags** (loader 0x438d10; room records of 0x28 bytes, zeroed, sorted by id, so
  a missing tag is 0 and the order of rooms does not matter; documented in `scene.ts`):
  kind 1 = exits byte (+0x15), kind 2 = the room's darkness (Night, 40–100, read by
  `GetNight`; +0x14), kind 4 × 10 = points for the first visit (+0x18, 0x42b640; at most
  40,950), kind 5 = the **background music** (8 characters, +0x1c: a piece of the
  episode's MUSIC resource 1E05, started looping on entering, 0x4393e8; a piece already
  playing goes on, no tag or an unknown name (episode III's title room 1: `HUMBA`) is
  silence; Junior and I have none), kind 6 = length-prefixed payload (value 2 = compiled script, the only
  one read; 1 = script source, 3 = a Unix time 1993–2008 in every room, probably when the
  original editor saved it). Kind 3 (+0x16) holds two **episode III flags** (rooms
  136, 143–146, 154, 155; the other episodes ignore it): bit 0 (only room 144) builds the
  labyrinth anew when the room is entered from room 146: a random maze of walls and
  teleporters over an n × n block of rooms from 144 on, n = 1 on the first visit, 2
  later (vtable +0x5c, 0x40ca30 → 0x40c910; not tried in the game), bit 1
  makes the hero dizzy: message 944 ("…Dir wird plötzlich schwindelig…") after 15 s in
  the room, once per game unless three herb tubers were eaten (vtable +0x60, 0x40ca70;
  **verified under Wine:** in room 41 with the tag, not without; the controls still
  worked normally right after). **Verified under Wine** (episode I room 43, the start
  room, which has neither tag): darkness 100 shows the room black, 60 dimmed; 5000 points
  for the first visit are on the status line at the start. Kinds 1–3 are bytes (higher values are cut). Payloads
  and map bodies longer than 19,998 bytes overflow the loader's stack buffer
  (`MAX_ROOM_DATA`, refused by the scene writer).
- **Saving:** `Game.withScene` writes edited rooms back. The original scenes fill their
  resources exactly, so edits usually grow them; a grown resource moves to the end of
  `.rsrc` (the last section), which grows, and the Authenticode signature is dropped.
  **Verified under Wine:** the game loads such an exe and shows the edit.

### Graphics

- **Shapes:** OMF objects with shape tables; descriptors of 12 bytes, frames of four 1-bit
  planes; pixel = 15 XOR the plane colours. `_Rob_object` is indexed by tile type,
  `_Aliens` holds the robots.
- **Palettes** per episode (16 colours, `palette.ts`). The game expands them into 14
  blocks of 16 (0x4023d0; its screenshots carry them all): 0 the palette, 1 brighter
  (+64), 2 grey, 3–11 darker and greyer (`darkPalette`), 12 black, 13 a grey ramp.
  **Darkness** (Night) redraws the screen in one block (0x42b170, 0x42b0b0,
  `darknessBlock`): 0 none, else the table at 0x481974 at (1100 − 11 × min(Night, 100)) /
  100, e.g. 40 → 7, 60 → 9, 80 → 11, 100 → 12 (black); light sources (0x42b230: up to 10,
  added by lamps, fires and other objects at run time) brighten circles of radius 50.
  **Verified:** the dark blocks match the game's screenshot palette exactly, and episode I
  room 43 at darkness 60 differs from its screenshot only where the actors are.
- **Object classes:** class table per episode (0x479ad8, 0x475838, 0x476e00, 0x477ca0,
  0x478c40; 128 entries); vtable +0x00 class id, +0x08 frame method, +0x28 room-load
  method (actors are created there), +0x54 describe method.
  Class 0 is the shared empty class (left out of the class→type table 0x4c70e0, 0x43b46a).
- **Renderer:** draws base cells as tiles and overlay cells as sprites with each class's
  frame method (12 methods incl. walls, terrain quarters, masks, doors, letters with the
  game font, underlays); logic cells show their record's cell, circuit nodes with a
  BULB on top (see circuits), class 99 cells the backdrop's (see room connections).
  **763 cells differ** in 31
  reference screenshots (`pnpm robot eval`), most from runtime effects (see open items).
- **Reference screenshots of any room** use a patched exe (`patch.ts`): the room in the
  start room's slot, without scripts and without anything that moves or kills
  (`calmRoom`): cells whose class becomes an actor on entering the room (vtable +0x28,
  `ACTOR_LOAD_METHODS`: robots, androids, snakes, the worm, …), delayed creature sources
  (`HATCHING_LOAD_METHODS`: eggs, snake basket, "something behind the wall"), bombs
  (they release robots), sand heaps hiding scorpions (sand states 6/7) and the records
  that let actors appear (spawners, natives, travelling actors). Otherwise the hero can
  die before the screenshot and the death's message box covers the room. A room with a
  backdrop keeps its id and its backdrop room (calm as well), and the episode starts in
  it (`withEpisodeStart`): in the start room's slot it would be its own backdrop.
- **The start room and the hero's start** are fixed per episode in the episode code
  (vtable +0x54: Junior 0x40e1a0 room 43 (2, 14), I 0x408da0 43 (5, 14), II 0x409fa0
  43 (6, 23), III 0x40b460 41 (8, 15), IV 0x40d680 53 (13, 16)): three `mov`s set the
  arrival cell (0x4fe309/0x4fe30a) and NxtRoom (0x4fe2f6), then a word at 0x4fe0c0
  (50, 38, 60, 200, 120; probably the number of inventory slots, see open item 4). `start.ts` reads and patches them (`robot start`,
  the editor's "Test in game"; **verified under Wine** for episode I: a copied room 250
  and another start cell). The hero tile (type 1) in the map is cleared, not used. In
  a `robot patch` exe the hero lands at the episode's position in whatever room was put
  into the start slot (possibly in a wall or water).

### Room connections (`exits.ts`)

- **Grid:** north/south = id ∓ 10, west/east = id ∓ 1. The exits byte (tag kind 1, 2 bits
  per direction N, S, W, E at 0x439590): 0 = grid neighbour if it exists, 1 = room 2 (the
  "outside", e.g. episode III's sea), 2/3 = none. Walking off the map arrives on the
  opposite edge, same row/column (0x427a9b); row 0 lies under the status line. The step
  is plain arithmetic, rows and hundreds do not matter: **verified under Wine** (episode I,
  new rooms as copies of room 42): west of room 51 is 50, west of 50 is **49**, the end of
  the row above. No original room id ends in 0 (but episode II's 600, which no grid exit
  reaches), so rows never join at their ends; ids ending in 9 are common. Across hundreds
  the grid is used on purpose: episode IV's 194/195 (south) and 204/205 (north) are
  neighbours. The originals leave the exits byte at "neighbour" towards missing rooms,
  so a room added there is entered from its neighbours at once.
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
  works like 2 but no original uses it. Both depend on the byte 0x4fe308: exit tiles
  stay closed while it is above 0 (enemies about; it counts down by one per run).
- **Barriers** (tile 0x55, class 100, "Eine Barriere für unvorsichtige Abenteurer",
  state 0 open, 1 closed; on room edges in episodes II–IV, III's only exits) work like
  exit tiles but on every edge: while the flag 0x4c7270 is set, the same task scans one
  map row per run and turns open barriers (class value 0x64 in the game's map) into closed
  ones (0x164) while 0x4fe308 is above 0, closed into open ones otherwise. **Verified under
  Wine** (a walled episode III room without enemies, barriers placed closed): the game
  shows them open and the hero walks out. Where 0x4c7270 is set is not traced (it is
  written through a pointer).
- **Scripts** (plain text, C-like) change `RoomNorth`…`RoomWest` and `BusWest`/`BusEast`
  (bus line in episode II); parsed with fixed vs. state-dependent marking.
  `Teleport(room, x, y)` does not move the hero: it stores a point (0x4fe358/35a/35b,
  0x407900) that replaces the target of teleporters whose record has flag 0x02 ("script
  may set the target", 0x44ccb1); room 0 gives them their own target back. Episodes
  whose flags (episode +8) have bit 0x2000 clear that point on every room entry, before
  the script runs (0x439426): Junior, I, II and IV set it in their constructors, III does
  not. So in episode I a redirect lasts only while the hero stays in the room (episode
  I's teleport hubs 36 and 38 send their teleporters back to where the hero came from,
  by `LastRoom`). A teleporter record's byte 8, if not 0, shows message 1200 + it when
  used (episode III: texts 1201–1207, "Du betrittst einen engen Gang…").
- **Passages ±100** ("further in": building interiors, caves): door in = class 98 (tile
  0x53, state 6/7, a roof's door) → +100; door out = class 105 (0x5a) → −100; stairs =
  class 71 (0x3d), state bit 0 clear → +100 (down), set → −100 (up). The hero arrives
  at the same (x, y) in the target room (0x426880), so all have their counterpart at the
  same place, except 5 recorded one-way stairs. Stairs need nothing but the tile (no
  record, script or tag); both layers are used (episode IV mostly the overlay); Junior
  has no stairs. A door in (0x413d30) takes only the hero walking north (state 6) or
  south (state 7), who then moves on two cells; unless the episode's flag 0x80000
  (`[0x51bb18]+8`) is set, he must carry the key 0x0f15 (0x42bcd0 searches the
  inventory slots, their count at 0x4fe0c0; in episode II it lies in room 42 at
  (16, 19)), and the score must pass the registration check (0x42f7c0, below). The
  score is kept obfuscated at 0x4fe098: 0x42b600 reads it as ~[+4] ^ [+0] ^ 0x7895321e,
  0x42b610 sets it ([+4] = [+4] × 0xbb38435 + 0x3619636b, then [+0] to match).
  **Verified under Wine** in episode II room 15: without the key the hero stops at
  the door, with it he enters 115.
- **Backdrops** (`backdropRoom`, `shownCells`): a room whose cell (0, 1) or (39, 1) is
  of class 99 (tile 0x54; episode vtable +0x00: 0x409d30, IV 0x40d4a0) is drawn over
  another room: room id mod 100 in Junior to III (242 shows 42, not 142), id − 100 in
  IV. Drawing the room (0x401af0, 0x401ba0) loads that room's map from the scene and
  draws its cell wherever the room's own cell is of class 99, so the house's interior
  sits in the town around it; the backdrop's actors stay cells (robots draw nothing as
  tiles). 22 rooms in episodes II–IV, e.g. II 115 over 15, III 147 over 47, IV 441 over
  341 (marked at (39, 1) only). The name rule (`SAME_NAME_CLASS`) looks at (0, 1) alone.
  Nothing ties an interior to the outline of a building: III 149 is the land under the
  lake of 49, drawn over its shore. Class 99 cells block the hero (**verified under
  Wine** in 149: walking from (17, 3) east or north into them does not move him, west
  along the floor does).
  **Verified under Wine:** shots of II 115, III 147 and IV 441 differ from our render
  only where the renderer differs anyway (current arrows on water, doors, the hero; the
  74 backdrop cells with overlay objects in 441 match), II 242 shows room 42 around it
  (seen in the harness's capture: the game wrote no screenshot of that room).
- **Logic records with targets:** oracles (type 12, walked into northwards once their
  symbol is laid, see logic records), teleporters
  (13), travelling actors (8); target = room in bits 0–9 + x in bits 10–15 of offset 4,
  y at offset 6 (actors: x, y at bytes 6, 7).
- **Circuit stairs** (`roomCircuitStairs`): lit circuit nodes place stairs (see logic
  records), episode I 128 → 228 at (22, 27), II 142 → 242 at (25, 18) onto the stairs
  back at the same place. Room 228 has no way back: no exits, stairs or records; its only
  way out is the wizard's door to room 2, which needs a registered game (see
  registration).
- **The old mechanism** (episode III, `raisedRoom`, see below): room 49 takes the cells
  of room 149, which the hero never enters.
- **Reachability** from each start room, counting all of the above: everything except
  debug room 99 and episode III room 3 (snapshot in `exits.test.ts`; see open items).
  Some connections need a registered game (see registration).

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
  (`Event(mask)`, `E_Take(class)`, `E_Drop(class)`, `E_Area(n)`, `E_NewRoom(room)`,
  `E_Slot(n)`)
  register the code after their call as a handler (0x407b30; 20 handlers at 0x4c5df8)
  and return 0, so `if (Event(…)) { … return; }` is skipped then. When the event
  happens (0x408970) the script continues at that block with E_Value set, until
  `return` (without one it runs on into the code after the block). Events: 1 take,
  2 drop (filter and E_Value: the object's **class**, with its state in the high byte,
  0x42c1e6), 4 walk areas from `SetWarea` (E_Value +n entering, −n leaving), 8 entering
  the room, 16 slots. Scripts name objects by tile type, so `E_Take(O_X)` and
  `E_Value == O_X` only work where class and tile type agree (O_KEY 21 yes, O_LAMP 27 =
  class 56 no): episode IV room 156's `E_Value == (O_LAMP|0x0100)` and room 157's
  `E_Value == O_SAVE` never match. **Verified under Wine:** in episode I's start room the
  top-level code and an `Event(8)` block both run; taking a key runs `Event(1)` and
  `E_Take(O_KEY)` handlers (there `E_Value == O_KEY` and `Possess(O_KEY)` hold); taking
  the lamp gives E_Value 56 (`PrintVal`); a `SetWarea` area raises `E_Area(1)` with
  E_Value 1 on entering. Room 1's script is the global one (episode start, game load);
  its handlers run when no room handler matches.
- **NewRoom** is 1 only on the first visit of a room in a game: entering a room whose
  record lacks the visited flag (+4 bit 2) sets it, sets NewRoom = 1 and awards the
  first-visit points; any later entry sets NewRoom = 0 (0x4392dc). `HaveSeen(room)`
  reads the same flag. A savegame stores every visited room (with its current state,
  0x4397d0) and loading marks them visited again (0x439e78), so visits survive saving;
  it also stores NewRoom itself, so the room saved in runs its script on loading with
  the value it had then (a game saved on a room's first visit sees NewRoom = 1 again).
- **Functions and variables:** all 62 keywords are described in `script-docs.ts`
  (decoded from their handlers): e.g.
  `Message(text, delay)` shows a text after `delay` seconds in the room (all its `|`
  variants as pages one after another; with delay 0 at once and one variant at random),
  `SetObj(obj, x, y, mode)` places objects, `Possess(obj)` tests the inventory (a state
  selects the exact variant), `SetMan` sends the dealer somewhere, `Wizzard(x, y, room,
rx, ry, …)` sets up episode I's wizard: the hidden door behind his throne at (x, y)
  leads to `room` at (rx, ry) (see registration).
  RoomTime counts seconds (147 ticks each); Val1…Val8 are free variables kept across
  rooms. Decoded in detail (0x407aa0…): `Enigma(n)` awards entry n of the episode's
  **event table** (`events.ts`, episode +0x1cc: per tile type the first take, then game
  events; points, a sound, text 1800 + n with the bonus text 516) once per game, the same
  mechanism as the first take of an object (the key's 500 points; **verified:**
  `Enigma(112)` twice in episode II gives 5000 points once and returns 0 the second
  time); `Phone(text, delay, n)` rings from `delay` seconds on, walking into the phone
  then shows `text` (**verified**; by the code n + 1 rings, but it still answered after 60
  s with n = 3); `Area(x, y, size)` is the square that
  the magic words LEFT/RIGHT (LINKS/RECHTS) rotate: the player lays them with letters
  from the rucksack (words of text 514, some only with the wand in the rucksack; placing
  letters with `SetObj` does not count; **verified:** putting down L, E, F, T turns the
  square's rings a quarter anticlockwise); `Area(x, y, size, key)` the squares episode
  IV's punch cards turn a quarter clockwise when used next to a card reader;
  `ShiftArea(x, y, w, h, d)` the area episode IV's remote control shifts once with
  wrap-around when used (d 0 up, 1 left, 2 down, 3 right; both **verified**, each with a
  bonus box: "Sieh' an, da hat sich etwas gedreht!", "Bravo, das hast Du richtig
  gemacht!"). Items are used from the rucksack ("Benutzen"). StationBOff counts
  episode IV's switched power station groups (from 4 spawners stop: **verified**),
  NoSwim (episode II) forbids swimming until the ship ticket is used. The interpreter
  knows no operations beyond those our compiler emits (opcodes 0x01–0x09, 0x0e/0x0f,
  0x41–0x43, operators 0x80–0x8e and 0x91–0x96), so `while`, `break` or compound
  assignments, if the original language had them, compiled to the same forms.
- `pnpm robot script E ROOM` shows a script and its disassembly; with a source file and
  an output exe it writes the script into the room (`withRoomScript`).

### Descriptions and logic records

- **Descriptions** (`describe.ts`, 0x406ae0): the cell's class picks the variant (37
  describe methods, all modelled), the text is the entry of the class's tile type; a
  negative variant is random (0x438850), a missing one shows entry 510.
- **Expert fields** (class 66, tile 0x32 in episodes I, II and IV; Junior's 0x32 is the
  goal, III's a stool): the hero may cross only with at least **state × 10,000 points**
  (0x4264f0: score / 10000 ≥ state, else message 508 "Du brauchst mindestens %ld
  Punkte…"; e.g. 0x0c32 = 120,000). `requiredPoints`; the editor says it in the tile's
  description. Passing also goes through the registration check (below) with that
  number instead of the score.
- **Notes** (class 15: Junior tile 15, episodes I, II and IV tile 58; `noteText`): the
  state is the message, **800 + (state & 0x7f)**. With bit 7 set the tile looks and is
  described as a note ("Ein Zettel. Geh' einmal hin…") and is read on stepping onto it,
  which removes it (0x421660, entry 0 of the touch table 0x47f948). Without it, it is old
  writing (Junior–II) or a micro-cassette (IV): picked up (0x41ef00) and read with
  "Benutzen" (0x4216e0 / 0x4217f0 → 0x4066a0). In episodes with the dictionary (class 8,
  BOOK) the text loses its vowels (`aeiouyAEIOUY`, 0x475058) unless the hero carries it,
  and then gives 300 points; in IV, which has the recorder (class 0xbf), it plays only
  with the recorder (messages 973/974). Every note in the played rooms has its message
  (test); e.g. Junior's 15 notes are messages 801–815, episode II room 105's six notes
  the file listings 833–842. Not yet tried in the game.
- **Diary pages** (episode III, class 164, tile 58): page = entry `state` of resource
  1320 (with the room names; date and title, then the text; 0x416400 → 0x4067b0 →
  episode method +0x40, 0x40b370), which marks bit `state` of 0x4fe3c8 as read; the
  page goes into the diary (class 164 in the rucksack).
- **Packages** (class 109, tile 94: episode II's presents, III's chests, IV's crates;
  `packageContents`): the state is the tile type inside. "Benutzen" from the rucksack
  (0x414150) turns it into that class (0x43a5f0) on the hero's cell (0x433420: as an
  actor where the type is one, e.g. robots in II's "poisoned" presents); an electric
  fence (class 7) kills the hero (message 951). Used: robots, walls, gold, bottles,
  garlic, ammunition, suits, tonic, save clocks, jokers, food, fins, shovels, …
  From the code and data; not yet tried in the game.
- **The old mechanism** (episode III, class 157, tile 0x2a; text 42: states 0 pipes,
  1 boiler, 2 pistons, 3 and 7–10 the drive anchor, 4–6 steam): on entering a room every
  class's hook at vtable +0x1c runs (0x439455); this one (0x4158e0) looks for steam (state
  4–6) and an anchor (7–10) below row 0 and, if room id + 100 exists, starts a task with
  that room's map (0x4155d0). Cold steam (4) waits until episode III's lamp (class 56,
  vtable 0x46c1a0, handler 0x424d20 at +0x38; its text: "…auch noch andere Dienste")
  turns it into 5; then it puffs (5, 6) and, **only in a registered game** (0x42f910),
  counts ticks. After about 128, with pipes, boiler and pistons in a row above the steam
  (x … x + 2, y − 1), the anchor turns and the room's water cells (classes 55, 82) take
  the other room's cells where those are not class 99, row by row from the shores
  (event 0x148). Oracle hint 335: "Ein Mechanismus im fernen Osten läßt Versunkenes
  wieder auftauchen." Room 49 holds the steam at (5, 25) and anchor cells at (7, 25),
  (8, 25); the pipes, boiler and pistons lie elsewhere (room 43 at (10, 6), records in
  rooms 21 and 61; debug room 99 has all three in a row). Nothing in this depends on the
  room or the episode, but only episode III maps class 157 to a tile type (the hook
  table 0x4c6ce0 holds only the episode's classes, 0x43b46a), and the other episodes'
  lamps (0x46c200, IV 0x4698d0) do not light the steam. From the code; not yet tried in
  the game.
- **Registration (shareware limit, 0x42f7c0):** every room change (edges 0x44c6b9, doors,
  stairs) and every expert field checks a number: the score, or the field's threshold.
  Below a random limit it passes: episode method +0x28, I/II/IV 70,000–100,000 points,
  III 90,000–120,000, Junior always passes; with episode +4 set, once more than half the
  episode's rooms are visited (0x4390c0) the number counts as 500,000. Above it the game
  wants a registration: the licensee name (registry `HKCU\Software\TOM-Productions\Robot`,
  value `Licensee`, asked for on the first start, message 515) and a registration number
  (0x4fe2ec, typed into a dialog, 0x42f550, and kept in savegames) that must match a
  checksum of the name and an episode constant (0x42f910; episode vtable +0x2c: Junior and
  I 0 (base 0x44c9c0), II 0x01967385, III 0x00534542, IV 0x01436363; the high and low
  halves XORed seed the random generator 0x436850). Otherwise message
  999 ("…lass' Dich bitte registrieren", www.tom-games.de) and the room change does not
  happen. Not tried in the game (no test went above these limits).
  **Registered only**, whatever the score (the name must be set and the number match,
  0x42f910): episode I's hidden door behind the wizard's throne (`Wizzard()`, 0x407ec0:
  room 228's `Wizzard(23, 4, 2, 12, 12, …)` = the door at (23, 4) to room 2, the cinema,
  at (12, 12)). The magic word KILLHIM (text 514, needs the wand; 0x42c820) laid with the
  wizard (class 78) in the 7 cells two rows above it lets 0x410050 place class 80,
  WIZDOOR, there (event 0x11f), elsewhere message 992 ("…nicht der richtige Platz für
  diesen Spruch"); the door's state 0 handler (0x4100c0, vtable 0x467410 +0x10) sends
  the hero on. Room 228 has no other way out. Then episode II's bus east to a room
  of 100 or more (0x44a845: room 6's `BusEast = 683`; unregistered it goes to room 53)
  and episode III's old mechanism (above). The other uses of 0x42f910 are the room
  change check itself and its dialog (0x42f4f0, 0x42f660 resume the blocked room change);
  the episodes' code only keeps the number in savegames.
- **Circuits** (`circuits.ts`, episodes I and II): nothing but cells. LETTER cells
  (class 59) `1`/`0` are the sources, GATE cells (class 76, items the hero carries) the
  wiring by state (0–8 a gate's operator: OR, AND, NOR, NAND, XOR and the four with an
  inverted input; 9 NOT; 0x0a ─, 0x0b │; 0x0c ┐ and 0x0d ┘, turning west; 0x0e a
  gate's inputs half, west of its operator, A from above it, B from below), circuit
  nodes (logic records of type 11) the outputs. Taking or putting down a GATE piece
  (0x40fdf0, 0x40fc50; not letters, not entering the room) makes the game evaluate every
  node in columns 1–37, rows 2–26 (0x40f700), row by row: it traces from the cell west
  of the node (0x40f9a0, comparing class | state << 8 of the one-layer map, so pieces
  put down on other objects count) and stops at the first cell that does not continue
  the trace; anything but a `1`/`0` at the end counts as 0. A node that changes places
  or empties its stairs cell (0x433300: not on water, stacked on what lies there;
  turned off, the cell becomes empty) and casts or drops a light (byte 8 holds it at run
  time). A node is drawn as its record's cell with a BULB on top (class 77, lit while
  byte 7 is 1; 0x4328f0's case 0x4329f2). **Verified under Wine:** the bulbs in I 128,
  II 142 and I 99 match the game's screenshots. The final node (the last with byte 1
  bit 0 in the scan) waits until every scanned node is on, **itself included**, then
  places its stairs (event 0x127; bit 1 remembers it) and takes them away when one goes
  off. The gates' outputs match the truth tables in the GATE tile's own texts (test).
  In the originals every node is open: the hero builds the circuits from pieces lying in
  the room (I 128: spare pieces in racks, a final node behind an electric fence that
  pieces can be laid over; II 142: `1` and `0` legs that meet where a gate's inputs half
  belongs).
- **Logic records** (`records.ts`, every byte the game reads), all 1177 in the game
  classified: 1 stacked (object on another cell; byte 1 its level, e.g. bridges), 3
  buried (dug up with the shovel), 5 spawner (robots near the hero), 7 native (episode
  III's friendly native, selling an object for gold), 8 travelling actor, 11 circuit node
  (episodes I, II; lit nodes place stairs, episode I room 128's final node the stairs to
  228, II 142's node those to 242), 12 oracle (one effect per direction it is walked
  into), 13 teleporter. On loading a room the game converts the record cells to classes
  and old types (2, 10 → 13; 6, 9 → 12), then turns every **overlay object into a type 1 record** on its base cell, in a
  table of 200 records (0x4327c4, 0x432e06; so records plus overlay objects ≤ 200, the
  originals reach 114); a logic cell in the overlay is dropped. **Verified under Wine**
  (episode I room 43 and the others' start rooms, records next to the hero): a stacked
  key is taken (`Possess`) and leaves the lower cell; a teleporter with flag 0x02 follows
  `Teleport()`, one to a missing room does nothing, one in the overlay does nothing; a
  spawner lets robots appear that kill the hero within seconds, not with StationBOff 4;
  a native record lets a native appear. **Oracles** work only once their symbol lies in
  the room: a 2×2 block of tangram pieces (tile 0x50, items the player collects and lays
  out) whose states are the oracle's pattern (`readOracleSymbols`, 0x47be54, 10 patterns;
  0x412860, which then draws the pieces as solved). **Verified under Wine** (episode II
  room 43): with the symbol, an oracle walked into northwards sends the hero to its target,
  eastwards it shows its hint, message 330 + n, and vanishes (the tested
  oracle 0 has none in episode II, which has 331, 332, 334 and 339), westwards it turns
  into its object, southwards it vanishes and kills (text 945); with one piece wrong
  nothing happens. The editor shows the symbol and the hint in the record inspector.
  Also **verified:** using the shovel on a buried record digs it up (bonus "…gelernt,
  die Schaufel zu benutzen!"); a circuit of letters 1/0, wires and an AND gate lights
  its nodes, which place their stairs, once a circuit piece is taken (the game evaluates
  circuits only then); the hero walks up a ramp and along an episode IV bridge over a
  canal, and across under its deck.
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
  tile 3 is class 3, which happens to map to the dealer's kind); walked into, he offers
  his items (cursor keys, Enter buys, Esc ends); after the purchase he wandered off and
  left through the bottom wall, which stood open briefly.

## The editor (`pnpm editor`)

A static web page (Vite build, relative paths, no server; module scripts need any static
web server, not `file://`). The exe is read in the browser and never uploaded.

Supported:

- open/drop an exe (in development `reference/GameOfRobot.exe` opens by itself)
- episode and room selection, room list with edited rooms marked
- room drawn exactly as the renderer draws it (cell image cache, per-cell redraws); a
  room with a backdrop (house interiors, see room connections) shows the backdrop room
  slightly dimmed in its class 99 cells, in the view and on the map; painting over its
  marks at (0, 1) and (39, 1) removes it
- painting base or overlay with a tile from the episode's tiles (robots, which draw
  nothing as tiles, show their first sprite; other invisible tiles a hatching; a filter
  by name, text or hex value) or any hex value; right click picks; dragging fills lines;
  undo/redo per stroke; grid (G); Dark (D) draws the room and the map as dark as the game
  on entering (the darkness setting; scripts and light sources are not modelled)
- tools Paint, Fill (the connected cells of the clicked value, 4 neighbours, within the
  selected area if clicked inside it), Select (drag a rectangle) and Inspect; the Area
  buttons and keys work on the selection in both layers: Copy (Ctrl+C), Cut (Ctrl+X),
  Clear (Delete), Fill (the area's cells of the current layer); Paste (Ctrl+V) shows the
  clip under the mouse until a click puts it down (Shift+click: again, Esc or right click:
  stop), in any room or episode; logic cells take their records along (new slots, the
  same ones where free), the records of covered logic cells go, a paste beyond the game's
  200 records and overlay objects is refused; each one undo step
- layout: the room fits the window's height with its exits around it (north above, south
  below, west and east at the sides; doors, stairs, bus, oracles, teleporters and actors
  in a line above); the column right of it has the tool and layer settings (always
  visible) and tabs (Tiles, Record, Actors, Script, Room) that
  scroll on their own, its width can be dragged (remembered in the browser); clicking a
  logic cell opens the Record tab
- exits: N/S/W/E targets incl. script changes; arrow keys follow fixed exits; per
  direction the exits byte's setting (neighbour / outside / none) can be changed,
  undoably (`withExitMode`)
- map (button "Map", key M): the episode's rooms as thumbnails on their grid (row =
  tens, column = ones of the id, one block per hundred), named; between grid
  neighbours one arrow per direction: green open (exits byte), orange open but with exit
  tiles that do not arrive on exit tiles of the neighbour, dashed opened only by the
  script, grey closed; clicking an arrow opens or closes that exit (undoable); badges
  for the other links (doors, stairs, teleporters, oracles, actors, outside, far script
  exits) go to their room; clicking a room opens it; free spots next to rooms (not in
  column 0) show a + that adds a room there; the map scrolls on its own, within the window
- visited rooms go into the browser's history and address (`#3/147`): the browser's
  back/forward (buttons, Alt+←/→, mouse buttons), the editor's own ◀/▶ buttons (showing
  the room they lead to) and Backspace move between them, across episodes; loading the
  page with a room in the address opens that room
- the room's name next to the title (and in the room list's, exits' and history's
  tooltips; episode III's descriptions in the name's tooltip), editable in place: written
  in the episode's style into the German texts (episode III: resource 1320, keeping a
  description), saved CRUNCHED; rooms showing the name of the room 100 below rename
  that room; empty removes the name; undoable
- rooms added ("New room…" below the episode, or a map's + slot) in a dialog: the id
  (1–1023, at most 200 per episode; a free one after the shown room is offered, never one
  ending in 0), checked while typing (taken, out of range; its grid neighbours and how
  their exits stand, also across a row's end or a hundred; rooms ± 100); the content:
  walls and exits (a wall chosen from the episode's wall tiles most used on the originals'
  edges, by class: 6, 199 walls, 93 rock, 215/216 episode IV's walls; five exit cells in
  the middle of each edge, like most Junior and I rooms: exit tiles, or the barriers
  the originals have on edges (class 100, tile 0x55, closed like exit tiles while
  enemies are about, see room connections; the default in episode III, whose rooms
  have no exit tiles); **verified under Wine**
  in episodes I, III and IV: the tiles towards existing rooms open, walking out arrives
  there; III's originals use no exit tiles at all), empty floor,
  a copy of any room (the shown one by default; cells, records, tags, script), or the
  interior of the room 100 below (episodes II–IV, `interiorCells`: class 99 everywhere,
  so that room shows around it; at each of its doors into buildings a door out at the
  same cell with walls beside it and two cells of floor where the hero walks on, at its
  stairs down stairs up; picking it moves an offered id to the shown room + 100; with a
  cell picked there (Select tool, one cell, or Inspect), new stairs down at it and up in the interior, in the same undo
  step, e.g. for a floor above an interior (episode II's 244 over 144 shows 44 around
  it, like 242 over 142); the dialog names the room drawn around it and episode II's
  key; **verified under Wine**: a generated 115 under room 15 is entered with the key
  and left northwards, a generated 244 by new stairs in 144); and
  whether closed exits of its neighbours open towards it; one undo step. "Go to room"
  opens a room by id. Rooms deleted ("Delete room…" next to the name; not room 1, the
  title screen with the global script, nor the start room; the confirmation names the
  rooms whose exits, passages, records or scripts lead there, which then lead nowhere;
  the name stays in the texts); undoable
- "Test in game": the edited exe with the episode starting in the shown room, the hero
  at the picked cell (Select tool, one cell, or Inspect) or the episode's start cell; `pnpm editor` runs it under Wine
  (`/play` on the dev server, `harness.py play`, the game window on this display; the
  episode is chosen by hand), the static build downloads it
- tile names (items) and the game's descriptions in tooltips and the hover line; logic
  cells say what their record does, notes and diary pages their message, packages what
  they hold (drawn in the hover line)
- logic records: clicking a magenta cell (or any cell with the Inspect tool) opens an
  inspector with the record's fields per type (cells with previews, target room with
  "Go", arrival position, spawner radius/period, a native's object, price and chatter,
  circuit stairs, an oracle's symbol and hint, a teleporter's message, …) and the raw
  bytes; change the type, add a record to a plain cell
  (in the base layer, where the game keeps them; it shows the cell it replaces, lowest
  free slot, refused once records and overlay objects fill the game's 200), remove one
  (the cell becomes what it showed); all undoable
- circuit (tab Circuit): the room's circuit evaluated as the cells are now
  (`roomCircuit`): how many nodes are on, the final node's stairs and what they wait for,
  per node on/off/no signal with where its trace stops, problems (nodes the game never
  evaluates, broken pieces, extra final nodes, stairs on water or on top of objects, the
  bytes the game keeps at run time not 0);
  in the room each traced cell framed in its signal's colour (amber on, blue off, grey
  dashed none), the nodes' bulbs lit as the circuit lights them (in the list too), nodes
  the game never evaluates framed red, broken ends as crosses, the stairs nodes place; a palette of the pieces (`1`, `0`, every GATE state with the game's
  graphics) to paint with, and "Add node" at the cell selected with the Inspect tool
- actors (toggle "Actors", key A): marks where actors appear (ring: placed in the map;
  dashed: appear later or from a record; spawner radius; arrow: heading somewhere),
  robots drawn with the episode's `_Aliens` sprites in turn (their look and colours vary
  in the game), actors from records (dealer 0x2c, thief 0x40, natives) with the tile
  that names them, their logic cell then only framed; the hover line describes such an
  actor once (by its record); a list below the map groups them with name, origin and positions (click
  to select), plus what the script's `RandObj(…)` does with the room's current number
- the room's settings (tab Room): darkness, points for the first visit, music (the
  episode's pieces, the ones rooms play first), episode III's flags (dizzy, labyrinth),
  each change one undo step; the original editor's save date
- the room's script below the map: names explain themselves on hover (functions,
  game variables, `O_` constants as tiles, message ids as their text, room numbers as
  room names, `Enigma` entries as their points and text), calls with plain coordinates (`SetWarea`, `SetObj`, `Area`, …) outline
  their cells on the map; the bytecode on request; Edit (CodeMirror, marked up the same
  way while typing, its own undo, completion of the game's functions with their arguments
  as fields, variables, constants and the script's own variables) compiles while typing (errors with line and column,
  syntax errors underlined where they are) and Apply sets source and compiled script as
  one undo step
- buttons: in every dialog and editor Cancel comes first, the confirming action last and
  filled (Create, Apply, Delete room); actions that remove something are red; "Save
  exe" is filled while there are unsaved changes; questions (deleting a room,
  discarding changes) use the editor's own dialog, not the browser's
- save: downloads the exe with all edited episodes and texts (warns about unsaved changes
  on leave)

Not supported (yet):

- painting over logic cells (use the inspector or the area tools); records are edited
  field by field
- painting exit tiles is plain painting (0x0017 in the base layer)
- English texts: room names are edited in the German texts only (Junior and I also
  have English ones, which keep the old names, or none for new rooms)
- copying areas between editor windows or exes (the clip lives in the page)
- English UI texts / English descriptions (German only; English exists for Junior and I)
- remembering the last exe or unsaved work across reloads
- any check that an edited room is still playable

## Open items and leads

Roughly by value for the editor.

1. **Logic records in play.** All types are decoded byte by byte and most are tried in
   the game (see logic records above). Open: the thief (not tried), following a leaving
   actor through its wall opening, circuits with the other gates and NOT (only AND
   tried; the code and the GATE texts agree on all of them), a final node waiting for
   itself (from the code), records in rooms whose objects and records exceed the table. **How to test
   an edit in the game:** build the exe (`Game.withScene`, or the editor's "Save exe"),
   put the change next to the hero's start (see "The hero's start" above) and run
   `python3 -I tools/wine/harness.py shot E OUT.png --exe EXE --keys Right:0.1 wait:2`
   (`--debug DIR` saves every step and a capture after each key); the game's screenshot
   file name tells the room it ended in, and the cells that differ from our render show
   where the hero and what changed are. Exits open only once a room's robots are gone,
   so tests of walking out remove them (`calmRoom`); a 0.1 s key press moves the hero 2
   cells, 0.3 s several (the game misses presses now and then). Message boxes (first
   takes, bonuses) stay until Return. The rucksack: Return opens it, a letter key or the
   arrows pick an item (letters first appear as one "?" item to choose with Return), Down
   picks the action, Return does it ("Benutzen" puts a letter down next to the hero).
   `PrintVal(x)` in a script shows a value in a box. Put objects the hero needs on the
   map to be taken: a shovel given by `Take()` in a script did not show up in the
   rucksack. Episode IV's status line shows the room and the hero's cell
   (`[183,26/15]`); `SetNight(0)` lights a dark room.
   `robot start E ROOM OUT.exe --at X,Y` makes an exe starting the hero anywhere (the
   whole episode stays as it is), `robot play` and the editor's "Test in game" run one
   to be played by hand.
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
   `Teleport(room, x, y)` only redirects teleporters that allow it (0x407900). Script
   object names are tile types (`scriptConstants`, see room scripts above). The editor's `RandObj` counts
   (`randomPlacement`) look at map cells only; the game also counts actors standing on
   cells (0x407650 via 0x433230), e.g. those from records.
3. **Scripts.** Decoded, compiled and editable; every function is decoded (see room
   scripts above) and most are tried in the game. Open: what `Phone`'s n limits (still
   answered after 60 s), whether `Area`/`ShiftArea` settings survive leaving the room,
   RIGHT and the wand words. Possibly worth adding to the compiler: `while`,
   `break`, compound assignments (they compile to existing operations).
4. **Room tags:** all kinds decoded (see room tags above) and editable. Not tried in the
   game: room music in Junior and I (their MUSIC resources have pieces, their rooms none), bit 0 of
   kind 3 (the labyrinth: entering room 144 from 146 generates a new maze of teleporters,
   0x40c910; the booklet confirms the labyrinth "changes its size and its paths"; a test
   starting in 146 could not reach its teleporters, which lie in the cave wall), the
   music (the harness is silent; listen with `robot play`). The word 0x4fe0c0 each episode's start method sets is probably the
   number of inventory slots (50, 38, 60, 200, 120; compared by the debug tracer
   0x439170).
5. **Rooms not reached** by any connection the reachability analysis models: only
   episode III room 3 (no records, no script, plain terrain; its exits lead to 13 and the
   sea, but nothing leads there: probably a leftover); room 99 is a debug room in every
   episode. Room 2 is left out of the analysis: in episode I only the title room and the
   wizard's hidden door in 228 (registered only) lead there. Not tried in the game: the
   old mechanism raising 149 into 49 (needs a licensee and a matching number in the
   harness's prefix), the wizard's door. The episode II jump to room 600 at 0x40a820 is
   not understood. (0x44bd2b, once thought to take a room from a table, belongs to an
   actor leaving through an edge: current room ± 1 or ± 10.)
6. **Renderer gaps** (`pnpm robot eval --types`): empty floor in episodes I/II (runtime:
   actors, hero, animations), episode IV types 95/106/79/99/70, episode III types 83, 37,
   49, 76, episode II 85/77/110/25, Junior 23/25 (animated). Some are runtime effects that
   a static render cannot match. Logic cells in some dark rooms (episode I room 11's
   teleporters) are drawn on black in the game but on colour 15 by us. Lead: the game
   draws a logic cell by its record's type (0x4328f0, jump table 0x432c90 by type − 1),
   of which we only follow circuit nodes (the bulb): type 1 adds the stacked cell
   (offset 4) as a sprite unless word 0 bits 14–15 are set, type 5 class 0x34 in state
   byte 7 − 1 while byte 7 is set, type 13 clears the cell first (0x428ea0, colour 0 or
   15 by byte 7 and the episode flag at 0x51bb18 + 8) and draws its cell as a sprite,
   type 8 depends on byte 8 (0x103: class 0x2c, the dealer). Not traced further.
7. **Description extras:** key colours (strings 0x9c50/0x9c51 from the exe's string
   table), messages 200/201 added by two classes, codes formatted by 0x41d2c0/0x40ff80, and
   four describe methods that depend on game flags/options.
8. **Not decoded at all:** MUSIC (only its instrument and piece names) and PCXBITMAP
   resources, the obfuscated command strings
   near 0x4828d4 ("Command %s unknown!", probably cheats; two jump ±100 rooms).
9. **Saving details:** the PE checksum is not updated (Windows does not check it for
   exes); a moved resource leaves zeroed space behind.
10. **The game's map in memory is one layer** (0x5197f8 + 0xc, 40×29 words, followed by
    the actor grid at + 0x91c), while scenes store base and overlay: on loading, each
    overlay object becomes a type 1 record on its base cell (see logic records). "Empty
    cell" (RandObj, the free-cell check 0x433230) is approximated as base and overlay
    both 0; how the free-cell check treats such records is not traced. Likewise whether
    an overlay object on a class 99 cell hides the backdrop there (0x401af0 checks the
    cell's effective value, 0x433110; 0x401ba0 the raw word): the originals have none,
    `shownCells` assumes it does.
11. **Two edge-exit code paths:** 0x427a9b (arrival only) and 0x44c5a0 (also sets the
    RandObj reference point; with game flag bit 10 of [0x51bb18]+8 clear, the arrival
    moves one cell further in). Which one runs when is not known.
12. **A level quirk in episode I room 26:** its script places the stairs down to 126 on
    the first visit or with ≥ 225000 points (`if(NewRoom || (Score >= 225000))`), and the
    stairs are the only way from the upper level down (room 38's teleporter to 128 is
    redirected back by its script from every upper room). With the colour-7 key from
    room 16 (next door) the door to the stairs' corridor opens on the first visit, so the
    points gate can be skipped. From code and data, not played through.
13. **Scorpion sand** (sand states 6/7) is confirmed by the texts in episodes II and III
    only; in episode IV those states read "Noch mehr Sand" (one cell in the game, still
    treated as scorpions by `cellActorSource`).
14. **Notes and packages in the game** (see Descriptions above, decoded from code and
    data only): to try a note with state bit 7 (read on stepping onto it, 800 + state &
    0x7f), one without (picked up; no vowels without the dictionary, IV: recorder
    needed), a diary page and a package (its object appears on opening, a robot from
    one in episode II).

## Limits and what is shared between episodes

- **Rooms:** at most 200 per episode (scene loader 0x438d10). Room ids are free 16-bit
  numbers; the game finds rooms by id (0x4390f0). Practical limits: targets in records
  have 10 bits (≤ 1023); room names are text entries 1000 + id (e.g. 1043 "DER START",
  episode III: resource 1320) below a limit per episode (`NAMED_ROOMS`: 200, 300, 700,
  200, none), written with `crunch`. Start rooms are fixed in the episode code (+0x54
  of the episode vtable, `start.ts`). Adding a room to an episode is therefore possible
  (new id, link it by grid id, stairs ±100 or a teleporter); the editor does it.
- **Episodes** are objects with their own vtables (Junior 0x466cd8, I 0x466458, II
  0x4665a8, III 0x466b08, IV 0x466c38, base 0x46cdf0, whose constructor 0x43b2e0 each
  episode's constructor calls first); each registers a factory at startup (0x43bc00, a
  list at 0x51bfc0 sorted by episode number); 22 of 28 slots are overridden
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
| 0x401af0, 0x409d30           | draw a room over its backdrop (class 99 cells); which room (IV 0x40d4a0)       |
| 0x406ae0, 0x438850           | describe a cell; fetch a text variant                                          |
| 0x43c0b0, 0x43bfd0           | a room's name; cut a text down to one line                                     |
| 0x43b2e0, 0x43b46a           | episode constructor; class tables 0x4c6ce0 (objects) / 0x4c70e0 (class → type) |
| 0x4fe2fc, 0x4fe35e…0x4fe364  | current room; RoomNorth/South/West/East                                        |
| 0x44c5a0, 0x44c680           | hero walks off an edge (sets the RandObj reference point); pending room change |
| 0x44dc60, 0x44d520           | create an actor (kind, x, y); factory lookup by class                          |
| 0x4073a0, 0x407650           | script RandObj; count a tile type in the room                                  |
| 0x41e4d0, 0x47efe0, 0x41e100 | telephone (episode II): dial; numbers → handlers; Ghostbusters (robot-free)    |
| 0x4827f0                     | base palette (episode III: 0x477c10)                                           |
| 0x4314b0, 0x438710, 0x431300 | CRUNCHED: next character; load a text resource; parse an entry header          |
| 0x432560, 0x4327c4, 0x432e06 | room load: convert records; overlay objects → type 1 records; allocate one     |
| 0x42bef0, 0x407aa0           | an event's first time (sound, points, text 1800 + n); script Enigma            |
| 0x4393d8, 0x4393e8, 0x439537 | entering a room: episode III kind 3 bit 0; background music; kind 3 bit 1      |
| 0x40f700, 0x40f9a0           | circuits: evaluate the nodes (after taking or putting down a piece); trace     |
| 0x4328f0, 0x432c90           | draw a map cell (classes; logic cells by record type); its jump table          |
| 0x412860, 0x47be54           | an oracle's symbol check; the 10 symbols                                       |
| 0x42ca90, 0x430110, 0x430210 | read a word laid with letters; turn the Area square left, right                |
| 0x42fdc0, 0x4302f0           | ShiftArea's shift; turn a punch card's square                                  |
| 0x4130b0, 0x41f730, 0x448440 | dig (shovel); level tiles and bridges; the dealer's trade                      |
| 0x408da0 (per episode)       | episode start: arrival cell, start room (vtable +0x54, see `start.ts`)         |
| 0x481170                     | 8×8 font                                                                       |
| 0x4750d8                     | script keywords (functions and variables)                                      |
| 0x406da0, 0x4080e0, 0x407fa4 | link a compiled script; run it; clear a room's handlers                        |
| 0x407b30, 0x408970           | register an event handler; raise an event                                      |
| 0x4392dc, 0x4394f3           | entering a room: visited flag and NewRoom; runs its script                     |
| 0x439426, 0x44ccb1           | clear the Teleport() point on entering (flag 0x2000); teleporter uses it       |
| 0x421660, 0x4216e0, 0x4066a0 | note: step on (bit 7), read from the rucksack; show message (dictionary/tape)  |
| 0x416400, 0x414150           | episode III diary page; open a package (its state = the tile type inside)      |
| 0x439455                     | entering a room: every class's hook (vtable +0x1c)                             |
| 0x4158e0, 0x4155d0, 0x424d20 | old mechanism (III): start (room + 100); its task; the lamp lights the steam   |
| 0x42f910, 0x42f3a0           | registration: checksum of name and episode value; licensee name set            |
| 0x407ec0, 0x42c820, 0x410050 | script Wizzard; the word KILLHIM; place the wizard's door (registered only)    |
| 0x44a831                     | the bus: BusWest, or BusEast (≥ 100 only registered, else room 53)             |

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
- The game evaluates circuits only when a circuit piece is taken or put down, not on
  entering the room: a test needs the hero to move a piece.
- Each `App` in the editor listens on `window`; tests must `dispose()` old instances,
  or they react to history and key events too.
- `harness.py play` and `shot` share the prefix: each ends a game the other started
  (`wineserver -k`), and `shot` deletes `Documents/Robot` in the prefix, i.e. also the
  screenshots and saved games of played games.
