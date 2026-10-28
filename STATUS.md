# Project status

Where the reverse engineering of `GameOfRobot.exe` and the level editor stand: what is
decoded and verified, what the editor supports, what is still open and where to pick it up.
Setup and commands are in the [README](README.md). Last updated: 2026-10-28.

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
   press keys before the screenshot (`--keys`), e.g. to walk the hero somewhere. The
   **driver** (`packages/tools/src/driver.ts`, see "Input, time and the driver") runs the
   game step by step on virtual time instead and reads its memory: where the hero is,
   in which room, the score.

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
  `pnpm test:game` runs the tests that start the real game through the driver (opt-in:
  they need Wine, Xvfb and the proxy DLL; about 4 s per game start).
- **Git:** commit freely; subject within ~72 characters, a short body when more
  needs saying (not a longer subject), **no attribution footer**; linear history
  (`merge.ff=only`, rebase on pull), never merge commits. Identity: bailli. **Never push**: only the user pushes to `origin` (GitHub).
- **CI:** `.github/workflows/ci.yml` (typecheck, lint, format, `test:without-game`, editor
  build) deploys `packages/editor/dist` to GitHub Pages from `main`.
- **No game data in the repository:** `reference/` (the installer and exe), `resources/`,
  `shots/`, `.wine/`, `renders/` etc. are ignored. Snapshots store hashes, not content.
- **Wine:** the project prefix `.wine/` is sandboxed (no links into `$HOME`, no `Z:`).
  Don't run the game in other prefixes. Sound is off for screenshots (audio drivers
  disabled per run); `harness.py play` keeps it on unless `--mute`.

## Repository map

| Path                    | Content                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/formats/src`  | `@robot/formats`: all decoders/encoders, no dependencies, Node and browser                         |
| `packages/editor`       | `@robot/editor`: the browser editor (Vite, static build; CodeMirror 6 for the script source)       |
| `packages/tools/src`    | `@robot/tools`: CLI `pnpm robot …` (render, compare, eval, patch, shots, script, start, play, mod) |
| `tools/wine/harness.py` | the only Python: drives the real game under Wine/Xvfb/xdotool; `serve` runs it for the driver      |
| `tools/wine/proxy`      | the only C: proxy `ddraw.dll` for the driver (mingw-w64, `pnpm proxy`)                             |
| `shots.json`            | per reference screenshot: hash, palette offset, cells where our render still differs               |

Files in `packages/formats/src`:

| File                         | What it covers                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `pe.ts`, `resources.ts`      | PE headers, resource tree; replacing a resource in place or growing it at the end of `.rsrc`     |
| `crunched.ts`, `cp437.ts`    | CRUNCHED text compression (decoder and encoder), CP437                                           |
| `texts.ts`                   | text resources: tile descriptions, messages, object names; setting an entry                      |
| `scene-crypt.ts`, `scene.ts` | SCENE encryption, the SCNV3 room format (reader and writer), `resolveCell`                       |
| `omf.ts`, `shapes.ts`        | SHAPES resources (16-bit OMF objects: reader and writer), shape tables and frames                |
| `palette.ts`                 | the 16-colour palettes per episode                                                               |
| `classes.ts`                 | object classes per tile type (vtables), frame/describe methods, underlays, patterns, font        |
| `render.ts`                  | drawing cells and rooms like the game                                                            |
| `exits.ts`                   | room connections: exits, scripts, doors, stairs, oracles, teleporters, actors                    |
| `describe.ts`                | the description the game shows for a cell                                                        |
| `room-names.ts`              | the name the game shows for a room; a name's text in the episode's style                         |
| `room-tags.ts`               | a room's darkness, points for the first visit, music and episode III flags; changing them        |
| `music.ts`                   | MUSIC resources: the names of their pieces                                                       |
| `start.ts`                   | the room and cell an episode starts in, the rucksack's capacity, and patching them               |
| `episode-flags.ts`           | the flags each episode's constructor sets (oracles that vanish, …), and patching them            |
| `episode-methods.ts`         | rules by the episode vtable's methods: the backdrop room (mod 100, − 100), diagonal moves        |
| `script.ts`                  | compiled room scripts: reader, disassembler, compiler, the game's keywords and constants         |
| `script-docs.ts`             | what the script functions and variables do, how scripts and events run                           |
| `script-handlers.ts`         | a script's handlers from its source: their events, whether they return or run on                 |
| `records.ts`                 | what logic records do                                                                            |
| `circuits.ts`                | logic circuits: the game's trace and evaluation, what each node gets, problems                   |
| `events.ts`                  | the episodes' event tables: first takes and events, their points (`Enigma`); patching them       |
| `dealer.ts`                  | the dealer's goods per episode: classes, prices, how many shown; patching them                   |
| `mod.ts`, `sha256.ts`        | mods: keyed changes to the pristine exe, their JSON file, compiled to a patch and applied        |
| `kits.ts`                    | kits: an episode's feature (oracles, circuits) planned into another as tile types, texts, events |
| `actors.ts`                  | where moving actors come from (map cells, hatcheries, bombs, scorpion sand, records, scripts)    |
| `game.ts`                    | `Game`: loads an exe, episodes lazily, saves scenes, texts, tile types from other episodes       |

## What is decoded and verified

### Resources and texts

- **PE resources** are read straight from the exe (7-Zip extraction is only an optional
  comparison). Resource ids per episode E (0–4): `1E02` shapes, `1E04` scene, `1E05` music,
  `1E06` sound table, `1E10` German texts, `1E11` English texts (Junior and I only);
  `9900`/`9901` episode list.
- **Text language:** the episode constructor (0x43b317) loads `1E10` and `1E11` into
  episode +0x18 and +0x1c; without `1E11` both hold the German texts. Lookups pick the
  table by the index at 0x4c5d84 (e.g. 0x408e22); 20 reads, no direct write found, so
  where the language is set is open.
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
  colour codes (`²x`) and the wrapping of the game's message boxes (a backslash breaks a
  line, also without a line feed after it); `_` is a hard space.
  **Tiles in texts** (`textPieces`, drawn by 0x42a56b): `@` + 1–4 hex digits is a tile
  (type | state << 8, e.g. "bei der Bank @14") drawn as a cell, two characters wide;
  `*0`/`*1`/`*2` after it draw it three times enlarged, one 12-pixel slice per line;
  `@@` is `@`; `@~` + up to 8 hex digits is a game object filled in by the code. Menu
  texts also use letters (`@S`, `@M`, `@T`, …; not traced). The editor draws the tiles in
  the hover line and the tile text, tooltips name them (`[Sickle]`).
- **Room names** (`room-names.ts`, 0x43c0b0): text entry 1000 + id (episode vtable
  +0x44); episode III keeps them in its own resource `1320` (name, then a description,
  marked by a leading `!`), as its diary pages and the texts of first takes and events
  (1800 + n: vtable +0x38 is 0x40b310 there, 0x409d80 elsewhere; `eventTextsId`). A
  room from 100 on whose base cell (0, 1) has class 99 (tile 0x54) shows the name of
  room id − 100 (caves, cellars). The text is cut to one line
  (0x43bfd0: underlines dropped, an empty line ends it; 0x438850 fetches texts without
  line breaks and with `_` as a hard space). Rooms without a name show "Szene <id>"
  (rooms 1 and 99, episode II's 600s, a few others). The game shows the whole text in
  the banner on entering a room (0x406560; seen under
  Wine for episode I room 42, underlines included) and names
  its own screenshots after the name (`R1-043-DER START.png`). Styles: episode I
  underlines (`DER START\` + a line of `═`), Junior and II frame with stars
  (`*** Die Festung ***`), III and IV write plainly; `roomNameText` writes new names so.
- **Room descriptions** (`splitRoomText`, `roomDescriptionText`): the text after the
  name. Two forms: a leading `!` (40 rooms of episode III) puts the description after
  the first backslash, and the banner (0x4063d0, message box flag 0x200) shows the name
  in the box's title bar; otherwise an empty line ends the name and the rest follows it
  inside the box (episode I's 27 "RING-PLATZ" and 74, episode III's 43, 48, 66, 76).
  `\` breaks lines, the game wraps the rest; it fetches at most 999 characters
  (0x438850, the banner's 1000-byte buffer). New descriptions take episode III's `!`
  form there and the empty line elsewhere. **Verified under Wine:** a new description
  for episode I room 43 (empty line, two paragraphs) and III room 41 (`!`, name in the
  title bar) show in the banner as written, wrapped anew.
- **MUSIC** (`1E05`, `music.ts`): "MUC1" at 0x1a, the number of instruments (u32 at
  0x22, 32-byte entries from 0x30, name first), the number of pieces (u16 at 0x2e), then
  86-byte piece entries starting with an 8-byte CP437 name (sorted; songs and sound
  effects alike: 26, 48, 72, 55, 64 pieces), then the music data (not decoded). Every
  room's music names a piece of its episode, but for `HUMBA`.
- **Sound tables** (`1E06`): `N:SOUND ;note`; the notes name objects by tile type
  (`21:QFANFARE ;O_KEY`) → `game.objectNames(e)`. Only items have names. The game reads
  them line by line by number (0x4389b0: `;` ends the line, the number before `:` must
  be positive and is not checked against the table's length; the order does not
  matter): the sound (a MUSIC piece of the episode; a leading `!` sets bit 7) goes into
  event table entry N +8 (see events). Every name is a piece of its episode's MUSIC
  (IV: one odd line).
- **Where resources come from** (opener 0x430d20, used by all resource reads; read from
  the code, not tried in the game): first a loose file, then the exe, then
  `WorldOfRobot.DLL`. Loose files only for CRUNCHED texts: if the registry value
  `RessourcePath` (HKCU `Software\TOM-Productions\Robot`) is set, `1E10`/`1E11` are read
  from `<path>\ITEM<E>GEN.CRN`/`ITEM<E>E.CRN` (E = `J` for Junior, else the digit),
  `1320` from `DIARY3GEN.CRN`, `9900`/`9901` from `INTROGEN.CRN`/`INTROE.CRN`. The
  first file found asks once (message box, texts 0x9c4c/0x9c4d, flag 0x4821dc: 2 ask,
  1 yes, 0 no). The DLL (0x405960) is only loaded when the exe has no `SHAPES` 1001
  (the shipped exe has it, so system info says "embedded"); it must export
  `R32Version` returning exactly 0x132 and `R32DateTime`, and serves only resources the
  exe lacks (handle 0x4c5d78, after the exe's 0x4c5d74).

### Input, time and the driver

- **Keys** reach the game only as window messages: the window procedure turns
  WM_KEYDOWN (0x404677) into a DOS-style key code (0x42cd40, table 0x481b68: per virtual
  key the code plain, with Alt, Ctrl, Shift) and hands it to the key handler 0x43bc90;
  WM_KEYUP clears the held keys 0x51bb1c/0x51bb1e. GetAsyncKeyState and GetKeyState
  only check Alt and the mouse buttons, GetCursorPos the mouse. The shortcuts are an
  accelerator table (resource type 9, id 1005; the main loop's TranslateAcceleratorA):
  Ctrl+Alt+P is command 4015, the screenshot (0x404190: named after the room, the frame
  buffer from 0x401210, written as a 640 × 348 palette PNG by 0x433710); Alt+B, E, G,
  M, S, T, V, W, Alt+Return and Alt+F8 are commands 4003–4013, F11 is 4201 (not traced).
- **Frames:** the game draws into a buffer of palette indices (0x401210 returns it) and
  shows it in a window, without Flip. With GDI, which it uses under Wine, WM_PAINT
  (0x402100) draws it with StretchDIBits (0x402220: 640 × 348, top-down, the colours
  indices into its palette, bitmap info at app+0x7d8). With DirectDraw, the display
  object (app+0x14: IDirectDraw2 +0x58, primary surface +0x5c, offscreen surface
  +0x60, scale +0x44/+0x48 in 1/256, depth +0x1e4) keeps the buffer at +0x4c (640 × 400
  when the screen has more than 8 bits) and presents it with 0x437620: converted
  through the colour table +0x204 into the offscreen surface, then BltFast (or a scaled
  Blt) to the primary.
- **Time:** the main loop (0x405bb4) dispatches messages; when none are waiting it
  calls 0x4016a0, which reads the game clock (0x42cf70: timeGetTime since 0x51bb40 ×
  147 / 1000, i.e. 147 units per second) and runs the game once per elapsed unit (at most
  20 per call), counting the tick 0x51bb38; then it draws (0x402740), otherwise it
  sleeps 1 ms. Every game timing comes from this clock; the window's only timer (id
  0x1234, 200 ms) comes from SetTimer. The clock stands still while a dialog is open
  (the player-name prompt, banners): the tick does not advance.
- **The hero** is the actor object at 0x53e9ac (vtable 0x46d8d8; cell x at +9, y at
  +0xa); 0x53e9a8 is the first actor of the room. 0x51a114 holds a pointer per cell (40
  per row) to the actor standing there. The player's name is at 0x4fe311.
- **Walking:** the held key (0x51bb1c, DOS codes: arrows 0x148/0x14b/0x14d/0x150, Home
  0x147, PgUp 0x149, End 0x14f, PgDn 0x151) gives the hero's step (0x4478e0, jump
  table 0x447b14); a diagonal one is checked by the episode vtable +0x1c (with the
  hero, both steps and a diagonal mark): Junior, I and II have 0x408d20, which drops
  one of the two, III and IV 0x40be60, which allows it (`readDiagonalMoves`,
  `withDiagonalMoves`). The episode flags play no part: Junior with III's whole flags
  word still does not walk diagonally. Flag 0x20000000 (III, IV) does the same for
  steering while a current carries the hero (the task 0x46cb20, 0x4274fc), and flag
  0x1000000 (II, III) gives that drift larger steps (both from the code only). **Verified under Wine**
  (`pnpm test:game`): PgDn moves Junior's hero 2 cells down and right with III's step
  method, without it not at all; in III Home, End and PgDn move him diagonally, in IV
  PgDn.
- **The driver** (`driver.ts`, the proxy `tools/wine/proxy/proxy.c`, started by
  `harness.py serve`): the proxy replaces the system ddraw.dll next to the exe
  (`WINEDLLOVERRIDES=ddraw=n,b`; it forwards every export, as Wine's DxDiag, the game's
  DirectX check, loads ddraw too). It redirects the main loop's call of 0x4016a0
  (0x405bde) so that the game runs only the steps the driver grants, each advancing
  the virtual clock (timeGetTime, QueryPerformanceCounter, GetLocalTime, SetTimer's
  timers) by 7 ms; keys and clicks are posted as messages between steps, and a key
  message sets the thread's keyboard state when the game takes it (GetMessageA), so
  the accelerators work. Each present (StretchDIBits, or the calls of 0x437620 at
  0x402379 and 0x437270) is copied with its colours: `frame()` and `screenshot()`.
  Answers wait until the game is idle (back in the step after drawing, every posted
  message handled). Runs repeat exactly (same steps, same tick and hero cell).
  **Verified with the driver** (`pnpm test:game`): every episode starts in the room and
  cell `readEpisodeStart` reads; in episode I room 43 without robots and with west
  "neighbour", walking out west arrives in room 42 at (38, 15); a captured frame equals
  the game's own screenshot (Ctrl+Alt+P) pixel for pixel. From launch to the hero in
  the start room takes about 1 s once Wine is up.

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
  silence; Junior and I have none; **verified by playing:** Junior's start room given
  `INTRO` played it at the start and again on coming back into the room), kind 6 = length-prefixed payload (value 2 = compiled script, the only
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
  **Verified under Wine:** the game loads such an exe and shows the edit. The PE
  checksum is not updated (Windows does not check it for exes); a moved resource
  leaves zeroed space behind.
- **The map in memory is one layer** (0x5197f8 + 0xc, 40×29 words of class | state
  << 8, followed by the actor grid at + 0x91c), while scenes store base and overlay: on
  loading, each overlay object becomes a type 1 record on its base cell (0x432cd0: lower
  cell at +2, the object at +4; an overlay logic cell makes none and is dropped), see
  logic records. A cell's **effective value** (0x433110) follows logic cells down to a
  plain word: a type 1 record's +4, any other record's +2. Setting the top (0x4331a0)
  writes there, so an object put on another record's cell replaces the cell the record
  shows (the record stays); taking the object of a type 1 record frees the record and
  its lower cell comes back. 0x433230 gives a cell's top with actors: the class of the
  actor standing there (0x0d for one whose byte 8 is neither 0 nor 1; byte 8 = 0 is
  ignored, not seen), else the effective value.

### Graphics

- **Shapes:** OMF objects with shape tables; descriptors of 12 bytes, frames of four 1-bit
  planes; pixel = 15 XOR the plane colours. `_Rob_object` is indexed by tile type,
  `_Aliens` holds the robots. The files are as SED93 wrote them: THEADR, one COMENT
  ("TOM Productions Shape editor SED93"), LNAMES, SEGDEFs `_TEXT` (frames), `_DATA`
  (descriptors, tables), `_BSS`, GRPDEF DGROUP, one PUBDEF per table, then per shape an
  LEDATA of frames, one of descriptors and a FIXUPP (descriptors → frames: far
  pointers, frame = target), the tables last (near offsets in DGROUP), MODEND; no
  displacements, every checksum set. `writeOmf` writes a parsed module back: **all 12
  SHAPES resources come out byte for byte** (test). `withShapes` puts shapes (from any
  resource) into a table: frames and planes appended, slots inside rewritten in place,
  a slot beyond the end moves the grown table to the end of its segment (its public
  with it). **Verified under Wine:** episode II's tangram (0x50) and oracle (0x51)
  shapes in Junior's grown `_Rob_object` are drawn by the game, cell for cell as our
  renderer draws them.
- **Robots in the map:** the cells that become robots on entering (`leavingRobots`, by
  `roomActors`' rules) are drawn without them (`shownCells`, so `renderRoom`, the room
  view, thumbnails and the map): Junior to III's robot tile draws nothing anyway, IV's
  (type 2, class 0xbd) is a grey "?" the game never shows there (46 cells in 25 rooms,
  5 of them the tile catalogue room 2). The tile itself keeps its shape (texts,
  palette). Other actors are drawn with their tile's shape, as the map shows them.
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
  **745 cells differ** in 31
  reference screenshots (`pnpm robot eval`), most from runtime effects (see open items).
- **Reference screenshots of any room** use a patched exe (`patch.ts`): the room in the
  start room's slot, without scripts and without anything that moves or kills
  (`calmRoom`): cells whose class becomes an actor on entering the room (vtable +0x28,
  `ACTOR_LOAD_METHODS`: robots, androids, snakes, the worm, …), delayed creature sources
  (`HATCHING_LOAD_METHODS`: eggs, snake basket, "something behind the wall"), bombs
  (they release robots), sand heaps hiding scorpions (sand states 6/7) and the records
  that let actors appear (spawners, natives, travelling actors). IV's cylinders (tile
  0x68) go too, though no actor comes from them: their task (`BLINK_LOAD_METHOD`
  0x41b030 → tick 0x419dd0) only flips state bit 0x200 of class 0xeb every 0x28 ticks,
  so the shot would depend on the frame. Otherwise the hero can
  die before the screenshot and the death's message box covers the room. A room with a
  backdrop keeps its id and its backdrop room (calm as well), and the episode starts in
  it (`withEpisodeStart`): in the start room's slot it would be its own backdrop.
- **The start room and the hero's start** are fixed per episode in the episode code
  (vtable +0x54: Junior 0x40e1a0 room 43 (2, 14), I 0x408da0 43 (5, 14), II 0x409fa0
  43 (6, 23), III 0x40b460 41 (8, 15), IV 0x40d680 53 (13, 16)): three `mov`s set the
  arrival cell (0x4fe309/0x4fe30a) and NxtRoom (0x4fe2f6), then the rucksack's capacity
  at 0x4fe0c0 (below). `start.ts` reads and patches them (`robot start`,
  the editor's "Test in game"; **verified under Wine** for episode I: a copied room 250
  and another start cell). The hero tile (type 1) in the map is cleared, not used. In
  a `robot patch` exe the hero lands at the episode's position in whatever room was put
  into the start slot (possibly in a wall or water).
- **The rucksack's capacity** is the word at 0x4fe0c0 (Junior 38, I 50, II 60, III 200,
  IV 120), set by the start method's fourth `mov` (`readRucksack`, `withRucksack`). It
  is both the number of slots (words class | state << 8 from 0x4fe0c2; the letters'
  count 0x4fe2b6 follows, so at most 250) and a weight limit: taking an item (0x42c010)
  needs a free slot and the weights carried plus the item's to stay **below** it, else
  the hero steps onto the item, it stays there, and message 998 says so ("Zum Tragen
  ist das mindestens eins zu viel.", one of three variants; the box waits for Return).
  An item's weight is the word of its shape's frame
  for its state (`Frame.word`, read through 0x43a990; 0 counts as 4); with the second
  argument set 0x42c010 skips the weight. Junior's, I's, II's and IV's items weigh 1
  (ammunition 2 or 3 in its fuller states, Junior's magnet in state 1: 2); III's up to
  10 (tools 2, the ladder 3, chests 4, wood 5, the tree and the magic pipes 10), so only
  there the weight matters. **Verified under Wine:** in III with capacity 6 the hero
  takes two of five tools of weight 2 and leaves the third, with message 998
  (`pnpm test:game`); with 200 he takes all five; in I with capacity 4 three of five
  items of weight 1, with 50 all five.
- **Episode flags** are the word at +8 of the episode object ([0x51bb18]+8): the base
  constructor 0x43b2e0 clears it, each episode's constructor ORs in a constant (Junior
  0x48012946 at 0x40e042, I 0x48012b46 at 0x408ca2, II 0x4901ed46 at 0x409ec2, III
  0x75ce0533 at 0x40b0f6, IV 0x22312ccd at 0x40d473; `readEpisodeFlags`,
  `withEpisodeFlags`). Bits the code is known to read: 0x20 robots keep their sprite's
  colours (only III; else the constructor 0x445bd0 rolls three distinct colours 8–14
  into actor +0x30), 0x400 the arrival at an edge (see open item 5), 0x2000 the
  Teleport() point is cleared on entering a room (all but III), 0x4000 and 0x8000
  oracles vanish after north and after east (only II), 0x40000 house cells (class 98,
  tile 0x53) in states from 9 on block in rooms from 100 on (only III, whose caves
  have the void around them in state 10; the step-on handler 0x413d30 lets the hero on
  such cells otherwise), 0x80000 doors into buildings need no key (only III). The others are not traced. **Verified under
  Wine** (`pnpm test:game`): the oracle bits in Junior (see the oracles); with 0x20
  Junior's robots have their sprites' colours, without it three distinct ones from
  8–14; with 0x80000 the hero walks through episode II room 15's door into 115 without
  the key, without it he stays in 15; with 0x2000 (episode I) the Teleport() point a
  room's script set is room 0 after walking into the next room (x and y stay), without
  it it stays; with 0x40000 the hero stops in front of a state 10 house cell in III
  room 114, without it he walks over it, and in room 41 he walks over it with it.

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
  used, unless redirected (episode III: texts 1201–1207, "Du betrittst einen engen
  Gang…").
- **Teleporters with a condition** (record byte 7, `teleporterCondition`; 0x44c6f0, the
  check whether an actor may step on a cell): 1 lets the hero on only while he carries
  an object of the class of the cell the teleporter shows (any state; 0x42bd40 counts
  the inventory slots by class; gold, class 0x0a, counts the gold, 0x4fe30e; letters,
  class 0x3b, any letter, 0x4fe2b6), 2 only while he carries none; otherwise he cannot
  step on it. The game draws the first kind on colour 15 with the teleporter's frame 0
  (class 0x43) XORed in, the second on black, the cell on top as a sprite (0x4328f0's
  case 0x432a27, fill 0x428ea0); a forbidden GATE piece (class 76, I 128) is drawn as
  its frame by the record's slot, white on black, without the cell. 48 records need
  their object, 72 forbid it, 152 ask nothing (Junior has no teleporters). Robots never
  step on teleporters. Without a condition, byte 1 bit 0 ("Always enterable" in the
  editor) lets the hero always step on it and first step onto the shown cell as if it
  lay there (taking an item); without the bit the shown cell stays and decides whether
  he may step on it (a wall blocks). The originals' five use it for ways through what
  would block: III 14's whirlpool (water to 114), III 14's mossy stairs (back into the
  room with message 1206), III 144's cave exit to 143, III 151's invisible one on the
  floor, IV 185's wall to 285; none has bit 3. **Verified under Wine** (episode I room 21, the teleporter at (1, 2) showing
  a grain, the hero carrying nothing): with 1 he cannot step on it, with 2 he arrives in
  room 44 at (2, 15); with 0 and bit 0 he takes the grain (bonus 500) and then arrives
  there. Byte 1 bit 3 makes a teleporter a light source, in episode III only: on
  entering a room the hook of class 0xba (tile 0x72, only in III; 0x416ef0) adds a light
  (0x42b230) at every teleporter with the bit. **Verified under Wine:** in III room 13
  at darkness 100 its two teleporters glow with the bit and stay dark without it; in I
  room 21 the bit lights nothing. The renders of the screenshots of I 11, 14, 21, 99, 128 and II 4, 99 match the
  game at all their teleporters.
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
  Both setters (and 0x42b640, which adds) leave the result in plain at +0x258
  (0x4fe2f0): the score shown (watched at 0x51bce0) and the scripts' `Score`. A script
  writing `Score` changes only that copy: the display, and the scripts' tests, until the
  next points are added to the hidden value; the game's own checks read the hidden one.
  No original script writes `Score`.
  **Verified under Wine** in episode II room 15: without the key the hero stops at
  the door, with it he enters 115.
- **Backdrops** (`backdropRoom`, `shownCells`): a room whose cell (0, 1) or (39, 1) is
  of class 99 (tile 0x54; episode vtable +0x00: 0x409d30, IV 0x40d4a0) is drawn over
  another room: room id mod 100 in Junior to III (242 shows 42, not 142), id − 100 in
  IV. The rule is the episode vtable's +0x00 (which room, for drawing, 0x401af0) and
  +0x04 (loading the room with it, 0x432820: 0x439130, IV 0x40d780) together
  (`episode-methods.ts`, `readBackdropRule`, `withBackdropRule`; `classes.backdropRule`, which
  `backdropRoom` follows). **Verified under Wine** (`pnpm test:game`): II with both
  pointers switched to IV's draws a room 244 (a copy of 115) over 144, as our render
  does but for 144's type 0x4d (a renderer gap); with only +0x00 switched it still drew 44. Drawing the room (0x401af0, 0x401ba0) loads that room's map from the scene and
  draws its cell wherever the room's own cell is of class 99, so the house's interior
  sits in the town around it; the backdrop's actors stay cells (robots draw nothing as
  tiles but in IV, whose robot tile is a "?", so a robot in IV's backdrop shows one; from
  the code, not seen). 22 rooms in episodes II–IV, e.g. II 115 over 15, III 147 over 47, IV 441 over
  341 (marked at (39, 1) only). The name rule (`SAME_NAME_CLASS`) looks at (0, 1) alone.
  Marks and cells are the game's one-layer map word, compared with 0x0063 exactly
  (`showsBackdrop`): class 99 in state 0 and no logic cell. An overlay object turns its
  cell into a type 1 record on loading, so it, like class 99 in any other state, shows
  class 99's own drawing (white, the object on it) instead of the backdrop, and marks so
  give no backdrop at all. Entering a room draws with the map word (0x401ba0, the
  backdrop map passed in); only a redraw after a display option is toggled (0x401af0,
  from 0x404064) takes the effective value (0x433110), where a logic cell whose record
  shows class 99 in state 0 would show the backdrop. **Verified under Wine**
  (`pnpm test:game`, II 115 without its script): a key on a class 99 cell, class 99 in
  state 0x10 and a buried record showing class 99 show no backdrop, as our render draws
  them, and marks in state 0x10 leave the room without one. The originals have one class
  99 cell in another state (IV 453 at (17, 28), state 8) and none under an object.
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
- **Reachability** from each start room, counting all of the above (snapshot in
  `exits.test.ts`): everything except room 99, a debug room in every episode, and
  episode III room 3 (no records, no script, plain terrain; its exits lead to 13 and the
  sea, but nothing leads there: probably a leftover). Room 2 is left out: in episode I
  only the title room and the wizard's hidden door in 228 (registered only) lead there.
  Some connections need a registered game (see registration).
- **Episode I's upper level** (from code and data, not played through): room 26's
  script places the stairs down to 126 on the first visit or with ≥ 225000 points
  (`if(NewRoom || (Score >= 225000))`), and they are the only way from the upper level
  down (room 38's teleporter to 128 is redirected back by its script from every upper
  room). With the colour-7 key from room 16 (next door) the door to the stairs'
  corridor opens on the first visit, so the points gate can be skipped.

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
  its handlers run when no room handler matches. From the code (0x407b30, 0x408970):
  every matching handler of the room runs; the call's value in the handler is the
  event when its mask names several, else E_Value (room 1's `ev == 8`); registering
  does not check for doubles, so a handler without `return` that runs on into another
  event function registers that one again (episode IV: entering room 145 and every
  take in room 156 add another area handler; not yet tried in the game; room 157
  returns just before its next handler).
  Starting a script clears its own handlers (room or global, 0x407fb4). Room 1's global
  script (Junior, I, II, IV; III has none): on take, drop or entering a room, Night
  becomes the room's darkness, or 20 in a dark room while the hero carries the lamp in
  state 1 (`SetNight` redraws at once on take and drop).
- **Event names:** `EV_TAKE` 1, `EV_DROP` 2, `EV_AREA` 4, `EV_ROOM` 8, `EV_SLOT` 16
  (`SCRIPT_EVENTS`) are ours, compiled to their numbers like the `O_` names; the
  original sources write numbers. `scriptHandlers` (`script-handlers.ts`) finds the
  handlers in a source: what each waits for, whether it returns, what it registers
  again when it runs on.
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
  events; points, a sound, text 1800 + n with the bonus text 516; a class's first take
  is the entry of the type its class maps to, 0x43a710) once per game, the same
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
- **Circuits** (`circuits.ts`, episodes I and II; in III too with I's classes, see fan
  episodes): nothing but cells. LETTER cells (class 59) `1`/`0` are the sources, GATE
  cells (class 76, items the hero carries) the wiring by state (0–8 a gate's operator:
  OR, AND, NOR, NAND, XOR and the four with an inverted input; 9 NOT; 0x0a ─, 0x0b │; 0x0c ┐ and 0x0d ┘, turning west; 0x0e a
  gate's inputs half, west of its operator, A from above it, B from below), circuit
  nodes (logic records of type 11) the outputs. Taking or putting down a GATE piece
  (0x40fdf0, 0x40fc50; not letters, not entering the room) makes the game evaluate every
  node in columns 1–37, rows 2–26 (0x40f700), row by row: it traces from the cell west
  of the node (0x40f9a0, comparing class | state << 8 of the one-layer map, so pieces
  put down on other objects count) and stops at the first cell that does not continue
  the trace; anything but a `1`/`0` at the end counts as 0. Cells are found as
  x + y * 40 without a column check: west of column 0 the trace goes on at column 39 of
  the row above (read from the code, as `traceCircuit` does). In I 128 this cannot be
  used (**verified under Wine** with the driver): the hero takes a GATE piece by walking
  onto it (first take: 100 points) and both rucksack actions, "Ablegen" and "Benutzen",
  put it on his own cell, so the only column-0 cell he could reach, the west exit
  (0, 15), takes him to room 127 instead; the `1`/`0` letters there are not taken when
  he walks onto them. A node that changes places
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
  into), 13 teleporter (every byte decoded, `records.ts`: byte 7 its condition, byte 1
  bits 4–5 are set only by the game for the exit a type 8 actor leaves open, bit 2 and
  byte 9 are never read; episode III's teleporters with a condition hold 157 or 158 in
  byte 9). On loading a room the game converts the record cells to classes
  and old types (0x432e70: 2, 10 → 13; 6, 9 → 12; 2 and 6 with the room in byte 4 and x
  in byte 5; none in the originals, which use only types 1, 3, 5, 7, 8, 11, 12 and 13;
  other types show their cell and do nothing, type 4 draws nothing, code only), then turns every **overlay object into a type 1 record** on its base cell, in a
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
  nothing happens. Every byte of an oracle record is decoded: once found, the symbol
  is remembered in bit 4 of the oracle's state (set by 0x412860, written back to the
  record by the step-on handler; **verified under Wine:** with the bit preset the oracle
  works without any pieces laid out); the rest from the code only: n from 10 on reads past the 10 symbols (pointers, no
  pieces match). Only episode II's oracles vanish after north and east (episode flags
  0x4000 and 0x8000, see "Episode flags"; III's stay; **verified under Wine** in II
  room 43 for north). Vanishing sets the cell the logic cell shows to 0 (0x4332a0 →
  0x4331a0): the record stays, showing an empty cell, which the hero walks onto.
  Oracles that stay can be used again and again (sent once more, the hint again)
  before the hero turns one into its object, which changes how an episode plays. Every use is event 262 + n (0x42bef0: 3500 points
  once per game; **verified:** a use gives 3500 points). Byte 7 is never read (III's hold 0,
  6, 7); byte 1 only for what every record type has: bits 6–7 a level (the step-on
  check's default case 0x44c8d2), bit 5 dissolves the record into its cell when the
  room is stored on leaving (0x431f20; all originals 0; **verified under Wine** in II
  room 43: after leaving and coming back the oracle was a plain cell that blocks the
  hero and does nothing, even with its symbol laid; likewise a teleporter). The editor shows the symbol,
  the hint (its message id editable, 330–345, which sets n) and "Symbol found".
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
  left through the bottom wall, which stood open briefly. **Verified by playing** (the
  original game, many times): following a leaving actor through that opening takes the
  hero to the record's room.
- **Actors** (`actors.ts`): entering a room (0x42b6f0) goes through rows 1–28 (row 0
  is never loaded) cell by cell: a native or travelling actor record lets its actor
  appear and leaves its cell in the map, then the cell's class gets its room-load
  method, from the top of the cell down (0x433110: an overlay object is a type 1 record
  on the base cell). Clearing the top of such a cell brings up the cell below
  (0x4331a0), which is loaded too if it differs from what was there in class or state
  (0x42b8cf): a robot under an object that stays, or under a robot in the same state,
  never appears; under a robot in another state it does. **A robot cell's state does
  nothing else** (code only): the load method (0x40a8e0) takes only x and y and creates
  kind 0x101 without it, the describe method (0x40e6d0) always gives text 2, the frame
  method (`NIBBLE`) has no shape to pick from in I, and `RandObj` compares states only
  for an argument with one (the originals use plain `O_ALIEN`). The originals have
  states 0–8, 0x0c and 0x0e (I: 0x0102 in rooms 23 and 53, 0x0202 in 53, 65 and 99,
  0x0302 and 0x0502 only in the debug room 99; II room 51: 1–8 side by side), perhaps
  left from an older version. Every actor but the hero joins the
  room's actor list (0x53e9a8, appended by 0x44c140). **Robots' sprites:** a robot takes
  `_Aliens` sprite (length of the list, itself included) mod episode +0x2c (0x445bd0 →
  0x445b60; IV's robot 0x44ac70), so a room's first actor, if a robot, takes sprite 1;
  +0x2c counts the sprites before the one with frame count 0xff, and Junior to III
  decrement it (0x40e049, 0x408ca6, 0x409ec6, 0x40b12f): 7 there, 5 in IV. Their 8th
  sprite is the scorpions' (robots from sand heaps, 0x44dcf0 with flag 1: sprite number
  +0x2c, its own colours). **Colours:** three distinct random colours 8–14 unless the
  episode flags (+8) have bit 0x20 (only III's constructor sets it) or the robot is a
  scorpion (0x445c4b: three draws of random(8, 14), each repeated while it equals an
  earlier one; `randomRobotColours`); IV's robot (class 0xbd, 0x44ac70) always copies
  its sprite's colours and reads no flag (`robotsTakeRandomColours`). The colours are
  the XOR colours of the sprite's three planes (descriptor +8, drawn by 0x428f70).
  **Other actors** are drawn with their
  class's shape (episode vtable +0xc): `_Rob_object` of the class's tile type, as the
  map; in Junior, I and II the registry option `AltShapes` (bit 4 of 0x4c5d88, off by
  default) replaces a list of types (0x4757a0, 0x476d68, 0x479a70) with the shapes of
  SHAPES 1003 (Junior) or 1903 (I, II), 0x43b220; IV draws class 0xdc (tile 0x74, in no
  room) with `_Bond`. `_Dealer`, `_Android` and `_Hero1` in 1003 are never looked up.
  **Verified with the driver** (`pnpm test:game`, episode III's start room with robots,
  turtles, boars, snakes and a native, rows 0, 3 and 5, stacked robots): the game's actor
  list (class +0x16, sprite +0x28) is the order and the sprites `roomActors` and
  `robotSprite` give; the robots' colours were their sprites' own.
- **Actor kinds:** creation (0x44dc60) maps kind 0x100 + n to a class via 0x47ec98
  (the other six dwords per entry are never read; 20 factories registered by class id,
  0x44d4e0). Kinds: 0x100 hero, 0x101 robot, 0x102 the hero's double (class 3), 0x103
  the dealer (class 0x2c), 0x104 android (episode III: snake), 0x105 the thief (class
  74, tile 0x40), 0x106 turtle, 0x107 friendly native, 0x108 wild boar (the last three
  episode III), 0x109 episode IV robot, 0x10a episode IV tile 0x0c.
- **`RandObj(O_X, min, max)`** (0x4073a0, `randomPlacement`) keeps the room's number of
  tile type O_X between min and max: it counts what is there (0x407650: per cell of
  rows 1–28 the class of the actor standing there, else of the top of the cell, 0x433230,
  compared with the object's class and its state, if the argument has one; the script
  runs once the room's actors are there, so natives, the dealer and the thief count too,
  and a cell with an overlay object counts once), removes random ones above and adds
  missing ones on empty cells, 20 tries each. Empty means 0x433230 gives 0: no actor and
  an effective value of exactly 0, class 0 in state 0, which includes tile types
  without a class of their own (the shared empty class) and logic cells whose record
  shows such a cell, i.e. records on floor (actors aside, 7–111 cells per episode more
  than "base and overlay 0"; the hero's arrival cell is not known to `randomPlacement`).
  Robots and androids go within ±10 columns / ±5 rows of a reference point on the far
  side from where the hero entered (0x4fe30b/0x4fe30c, set when walking off an edge,
  0x44c5a0: entering from the west (25, 14), east (15, 14), north (20, 22), south (20,
  7); the bus (20, 14); teleporters and stairs keep the old one), other objects anywhere
  (x 0–39, y 1–28).
- **Robot-free room** (code only; 0x4fe3bc, a word in the saved game state, episode
  code +0x158): in that room no robots (kind 0x101 / class 2), androids (0x104 / class
  0x2d) or worms (class 0x45, tile 0x37) are created (0x44dc60, 0x44d520), and hatching
  sources (0x4237e0's task 0x433e80) release nothing. It is set by episode II's
  **telephone** (tile 0x5f, class 110, 12 rooms): using it asks for a number (text 400,
  4 digits, 0x41e4d0), dialled numbers are looked up in the table at 0x47efe0 (32-byte
  entries: number +0x08, text +0x0c, handler +0x18; 1141 wake-up call 402, 1131
  telegrams 403, 1191 time 404, 110 police 405, 112 fire brigade 406, 3786 travel agency
  407, 9991 "Ghostbusters" 408). The Ghostbusters (0x41e100) ask for a room number and
  then a credit card number; `atol` of it = 0x32a079 (**3317881**) stores the room for
  good (later calls say "still busy in room %d"), any other number stores −1; the next
  call ("you again, the number was wrong") then probably resets to 0 (its prompts have
  no input fields and the room is read from an empty buffer), a wrong number in that
  path stores −2 (never again). Not modelled (game state, not level data).
- **Scorpion sand** (sand, class 39, states 6 and 7: "Unter diesen kleinen Häufchen
  verbergen sich stachelige, giftige Gesellen"). An actor stepping on a cell calls its
  class's vtable +0x0c (0x44c6f0 → 0x44c98d; `touchMethod`), which for sand picks a
  handler from a table by the actor's kind (0x100 + n: entry n). Each episode group has
  its own sand class object: Junior and I vtable 0x46bd00 (table 0x48011c), II and III
  0x467c70 (0x47bcd4), IV 0x469e70 (0x47df58). In the first two the hero's entry (and in
  II and III a native's) is 0x41f9d0: the heap becomes plain sand and a scorpion comes
  out (0x44dcf0: a robot with the scorpion flag, at the cell stepped on); robots may not
  step on it. In IV every kind gets 0x41eca0 or 0x446f10, so its heaps are only sand
  ("Noch mehr Sand", text 49 there). **Verified under Wine** (`pnpm test:game`, a heap
  next to each episode's start): in Junior to III the hero stepping on it leaves class
  0x27 there and one actor in the room's list, in IV the heap stays and no actor
  appears (first seen playing IV). `cellActorSource` and `calmRoom` follow
  it; IV's one heap (state 6) is no longer an actor source. **Known from playing:** a
  scorpion walks around and can kill the hero, and after a while burrows into the sand
  again, whatever it is doing; with the driver, about 2 s after it came out it was gone
  from the actor list and the cell was a heap again (state 6 or 7). Where the game
  decides that is not traced.
- **The dealer's goods** (code only): both constructors (record 0x448ad5, `SetMan`
  0x448c8b) take the goods table from the episode (vtable +0x10: address, entry count,
  most goods shown) and then build the offer once (0x448440, the only caller): a count
  `random(5, most)` (0x436890, inclusive) and that many distinct random entries (a
  128-bit used set); nothing in the record chooses goods, so every dealer of an episode
  sells from the same table at the same prices, rolled anew at each appearance, whatever
  the hero owns. An entry is 4 bytes: **class id** (not tile type), state, price in gold
  (word): the game's run-time form of an object (class | state << 8). The offer line
  names the class's tile type (0x4c70e0[class], 0x4485af), buying hands class | state
  to the inventory (0x42c010); a package (class 0x6d) holds a class in its state, turned
  into its tile type when offered (0x448565). (Corrected 2026-10-27: read as tile types,
  episode I's class 0x40, a BARRIER item, became the thief, II's 0x66, FOOD, fire.)
  Junior 0x479a20 (19 entries, 5–8 shown; 0x40e1e0), I 0x475730 (27, 5–10; 0x408de0), II
  0x476ce8 (31, 5–8; 0x409fe0), IV 0x478bf8 (18, 5–8; 0x40d6c0); III has none (the base
  method 0x40be40 returns null and the constructor gives up, so no dealer there). By
  the tiles of their classes (unnamed ones as tile type), all four sell SLING 14, GARLIC
  2, TREE (0x0b) 20, BOTTLE 10, 0x09 5, SUIT (55 in Junior, else 85), AMMU 5, MAGNET
  10, 0x1c 15, TONIC 30/32, SAVE 28/48; all but IV 0x0c 22 and PUZZLE 0–3 at 8; Junior
  also FLY 25 and KEY 9, 3; I SICKLE 27, 0x39 1, NOTE/0x1c 4, BARRIER 7, 0x12/2 12, LAMP
  15 and KEY 2, 5, 9, 7, 8 (10–14); II like I (no NOTE, no 0x12) with KEY 6, 3, 1, 15
  (25–35), WAND 60, FOOD 15 and 5, GIFT (holding class 0x71) 30, MONEY 3, KOMPASS 17,
  AMMUL 25; IV KEY 6, 3, 1, 15, LAMP and FOOD twice. More
  entries need a code patch (the count is an immediate); a table of fewer than 5 would
  hang the distinct pick. Esc pays (0x4487d0): marked goods costing more than the hero's
  gold (0x4fe30e) take all of it and give nothing (text 507 entry 4); otherwise event
  0x101, the gold is paid, and goods the inventory does not take (0x42c010) are placed
  on the dealer's cell (0x433300; then text 507 entry 5).
  **Editable** (`dealer.ts`, code only, not tried in the game): the goods method is
  `mov [eax], count; mov [ecx], most; mov eax, table` (immediates at +0x0b, +0x11,
  +0x16), so `withDealer` rewrites the table's entries in place and both counts. The
  table has no room to grow (a 4-byte pad, then other data): at most as many goods as
  the original (`dealerCapacity`), fewer are fine; at least 5 (the distinct pick);
  most shown 5–10 (the offer holds 20, 0x448458; more than I's 10 not tried) and no
  more than there are goods. Giving III a dealer would need a goods method of its own
  (a vtable entry and code).

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
- painting base or overlay with a tile from the episode's tiles (those its rooms use in
  that layer, and the tile types copied from other episodes in each state their shape
  has a frame for; the base layer's also those only logic records hold, e.g. IV 185's
  teleporter wall 0xd044; robots show their first sprite on an empty cell (Junior to
  III draw nothing as tiles, IV's tile is a "?" the game never shows), in random colours
  where the game rolls them (fixed per palette and per cell, following the flag); other invisible tiles a hatching; a filter
  by name, text or hex value) or any hex value; right click picks; dragging fills lines;
  the last 12 tiles painted with (per episode, kept until the page reloads or another
  exe or mod is opened) in a row above the palette; undo/redo
  per stroke; grid (G); Dark (D) draws the room and the map as dark as the game
  on entering (the darkness setting; scripts and light sources are not modelled)
- tools Paint (P), Fill (F; the connected cells of the clicked value, 4 neighbours,
  within the selected area if clicked inside it), Select (S; drag a rectangle) and
  Inspect (I; opens the tab of what is at the cell: its logic record, else the actor
  placed there, its row marked, else the circuit it belongs to, else the Record tab);
  L switches the layer; tools and layers are segmented buttons (radio buttons
  underneath), so the header takes three short rows; the Area
  buttons and keys work on the selection in both layers: Copy (Ctrl+C), Cut (Ctrl+X),
  Clear (Delete), Fill (the area's cells of the current layer); Paste (Ctrl+V) shows the
  clip under the mouse until a click puts it down (Shift+click: again, Esc or right click:
  stop), in any room or episode; logic cells take their records along (new slots, the
  same ones where free), the records of covered logic cells go, a paste beyond the game's
  200 records and overlay objects is refused; each one undo step
- layout: the room fits the window's height with its exits around it (north above, south
  below, west and east written vertically at the sides; doors, stairs, bus, oracles,
  teleporters and actors in a line above); the column right of it has the tool and layer
  settings (always visible) and tabs (Tiles, Record, Actors, Circuit, Script, Room,
  Episode; keys 1–7) that scroll on their own, its width can be dragged (remembered in
  the browser); clicking a logic cell opens the Record tab, which with no cell selected
  lists the room's records (click selects the cell, hover outlines it; Escape drops the
  selected cell and goes back to the list); the tab buttons tell what is there without
  opening them (`SidePanel.setState`): dimmed and dashed when empty for the shown room
  (no records, no actors, no circuit nodes, no script, no dealer), a badge with the
  number of records, of actors and RandObj calls, the circuit's nodes on of all (orange
  with problems), ● for a script (✎ in orange while a draft is not applied), ● in
  orange for an edited dealer; the tooltip says it in words, with the tab's key
- help (button "Shortcuts", key ?): a dialog listing the keys and mouse buttons
  (`help-dialog.ts`); keys typed in a dialog do not reach the room
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
  tooltips; the description in the name's tooltip), editable in place: written
  in the episode's style into the German texts (episode III: resource 1320, keeping a
  description), saved CRUNCHED; rooms showing the name of the room 100 below rename
  that room; empty removes the name; undoable
- the description of the room's name in the Room tab (rooms with a name; caves and
  cellars that of the room above): lines as typed, applied on leaving the field or
  Ctrl+Enter (Escape reverts), in the entry's form or the episode's (see Room
  descriptions above); empty removes it; undoable
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
  at the picked cell (Select tool, one cell, or Inspect) or the episode's (edited) start cell; `pnpm editor` runs it under Wine
  (`/play` on the dev server, only for requests from the editor's own page;
  `harness.py play`, the game window on this display; the episode is chosen by hand;
  when the harness refuses, e.g. without DISPLAY, the editor says why and downloads the
  exe), the static build downloads it
- tile names (items) and the game's descriptions in tooltips and the hover line; logic
  cells say what their record does, notes and diary pages their message, packages what
  they hold (drawn in the hover line)
- logic records: clicking a magenta cell (or any cell with the Inspect tool) opens an
  inspector with the record's fields per type (cells with previews: click takes the
  current tile, right-click paints with the cell; target room with
  "Go", arrival position, a travelling actor picked from the episode's actors, spawner radius/period, a native's object, price and chatter,
  circuit stairs, an oracle's symbol, hint id and text, "Symbol found", a teleporter's condition and message,
  …, "Gone after leaving" (byte 1 bit 5, every type)) and the raw
  bytes; change the type (listed by number), add a record to a plain cell
  (in the base layer, where the game keeps them; it shows the cell it replaces, lowest
  free slot, refused once records and overlay objects fill the game's 200), remove one
  (the cell becomes what it showed); all undoable; an edit keeps the inspector's
  controls (`patch.ts`), so focus stays and Tab goes on to the next field
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
  robots drawn with the `_Aliens` sprite the game gives them (by their place among the
  room's actors; Junior, I and II roll random colours for them, here picked by room and
  cell, so they stay while the editor runs; the flag 0x20 gives their sprite's), actors from records (dealer 0x2c, thief 0x40, natives) with the tile
  that names them, their logic cell then only framed; the hover line describes such an
  actor once (by its record); a list (tab Actors) groups them with name, origin and positions (click
  to select), plus what the script's `RandObj(…)` does with the room's current number
- the room's settings (tab Room): darkness, points for the first visit, music (the
  episode's pieces, the ones rooms play first), episode III's flags (dizzy, labyrinth),
  each change one undo step; the original editor's save date
- the room's script (tab Script): names explain themselves on hover (functions,
  game variables, `O_` constants as tiles, message ids as their text, room numbers as
  room names, `Enigma` entries as their points and text), calls with plain coordinates (`SetWarea`, `SetObj`, `Area`, …) outline
  their cells on the map; the bytecode on request; Edit (CodeMirror, marked up the same
  way while typing, its own undo, completion of the game's functions with their arguments
  as fields, variables, constants and the script's own variables) compiles while typing (errors with line and column,
  syntax errors underlined where they are) and Apply sets source and compiled script as
  one undo step; a draft not applied stays with its room when another is shown (status
  line, ✎ in the room list) and comes back there until Apply or Cancel; saving says
  which drafts are not saved; another exe or mod drops them; handlers are marked (a bar along their lines, a line above naming the
  events, a warning below one that has no `return` and runs on, naming the handlers it
  registers again)
- buttons: in every dialog and editor Cancel comes first, the confirming action last and
  filled (Create, Apply, Delete room); actions that remove something are red; "Save
  exe" (once a mod is in use "Save mod") is filled while there are unsaved changes;
  questions (deleting a room, discarding changes) use the editor's own dialog, not the
  browser's
- save: downloads the exe with all edited episodes and texts (warns about unsaved changes
  on leave)
- tile types from other episodes (tab Episode, `tile-types-view.ts`; mod kind
  `tileTypes`): the copies, each with its picture in this episode, removable (×, not
  while rooms use the type); a form: the episode (Junior … IV), a type with a class
  there (named, its picture in its own palette), the free type it goes to (the same
  number where free, else the first that is no copy yet; free: no class in the exe as loaded and no room uses it, or a
  copy already, which it then replaces); "Copy". Each one undo step, which makes a new
  base (`Editor.setTileType`): text entries edited before stay as they are, the copied
  description comes along; refused: a copy of a copy, a type without a class, a type
  an edited dealer then lacks. The tiles, names and drawings follow at once; the tile
  list offers a copy in each state its shape has a frame for and each state its type has
  in the source episode's rooms (a letter's state is its character: I's 0 and 1, A–Z). A copy
  whose class shows texts of its own (`classTexts`, so far the oracle: hints 330 + n and 945) that the episode lacks gets "Texts", which copies those its source has (II's
  oracle: 331, 332, 334, 339, 945) in one undo step. **Tried in
  the game** (by hand): Junior's book copied to IV and placed next to the start, taken:
  its first-take box came and its points were added
- events from other episodes (tab Episode, `events-view.ts`; mod kinds `events` and
  `copyTexts`): the entries the mod sets (entry ← episode and entry whose text it
  copies: event id, points), each removable (×: the entry as the exe has it, its text
  copy gone too); a form: the episode, one of its events (entries from 128 on, not its
  spare ones, as loaded) whose id this episode's table lacks, the spare entry it goes to
  (`spareEventEntries`: Junior and I 190, IV 197–200, II and III none; the first no
  copy has); "Copy" sets the entry's id and points and copies text 1800 + n
  (`Editor.copyEvent`). Each one undo step, which makes a new base like a tile type
  copy; refused: an id the table has already, an entry that is not spare. Not copied:
  the sound (the target's sound table line stays). II's oracle events 263 and 266 into
  IV's 197 and 198 save as the mod the oracle game test uses (verified under Wine)
- texts from other episodes (tab Episode, `texts-view.ts`; mod kind `copyTexts` into the
  episode's texts, `textsId`): the copies (entry ← episode and entry, the text's start),
  each removable (×); a form: the episode, an entry of its texts as loaded (number),
  the entry it goes to (below 1800, the same number by default), what it says and what
  it replaces; "Copy" (`Editor.setTextCopies`, one undo step, a new base like a tile
  type copy). Refused: a text the source lacks, an entry from 1800 on (event texts come
  with their events). A text written in the editor wins over its copy (saveMod drops
  the copy). Copies into other resources (III's 1320) are kept from a mod but not listed
- kits (tab Episode, `kits-view.ts`; `kits.ts`: `KITS`, `planKit`, `kitChanges`): oracles
  (II's tangram 0x50 and oracle 0x51, events 262–271) and circuits (I's letter 0x25,
  gate 0x42, bulb 0x43, stairs 0x3d; event 293). Per kit what adding it to the shown
  episode copies: the types whose class the episode lacks (stairs only to Junior; II
  and III have oracles, I and II circuits: "has … already"), each at the same number
  where free, else the first free type no copy has; the texts the kit's classes show
  that the episode lacks (`classTexts`, for classes it does not have by itself, so a
  type copied by hand still gets them); the events its table lacks, in spare entries
  the mod does not set yet (`Editor.kitPlan`). Where they do not all fit (IV: four
  entries for ten oracle symbols) checkboxes pick which (the first ones by default),
  the rest give no points; kits share the spare entries (IV's oracles and circuits
  together). "Add oracles" / "Add circuits" (`Editor.addKit`) is one undo step making a
  new base; the parts then show in the lists of tile types, events and texts, each
  removable there. **Verified under Wine** (`pnpm test:game`, the circuit and oracle
  game tests now build their mods with `planKit` and `kitChanges`): circuits in III
  (types 0x0e, 0x0f, 0x43), IV and Junior, oracles in Junior, I and IV
- the episode's settings (tab Episode, `episode-view.ts`): the rucksack's capacity
  (1–250); the rules, episode flags as checkboxes: oracles vanish after north, after
  east (0x4000, 0x8000), doors into buildings open without the key (0x80000), robots
  keep their sprite's colours (0x20), Teleport() points last only in their room
  (0x2000), house cells in states 9+ block from room 100 on (0x40000); diagonal moves;
  backdrops show the room 100 below (else id mod 100; the room and the map draw by it
  at once); one undo step each, saved into the exe and the mod (`rucksack`, `flags`,
  `backdrop`, `moves`)
- the episode's start (tab Episode, `episode-view.ts`): the room and the hero's cell
  there; "Start here" sets the shown room and the picked cell (Select tool, one cell,
  or Inspect; else the start's cell), "Original start" goes back to the exe's; one undo
  step each; not room 1, nor a cell under the status line (row 0); the cell is marked
  with a green S in the room, the hover line says so; opening an episode shows its
  start room; saved into the exe and the mod (`start`); the start room cannot be deleted
- the episode's dealer (tab Episode, `dealer-view.ts`): the goods every dealer of the
  episode sells, with picture and name (the tile the game makes of the class,
  `goodTile`; a picked tile becomes its class, `cellGood`, tiles without one are
  refused) and price, the most shown at once, the rooms with
  a dealer record (links); a picture click sells the current tile instead, right-click
  paints with it; prices typed, goods moved, removed (at least 5) or added (the current
  tile, up to the table's size), "Original goods"; each change one undo step (patched
  in place: focus stays, Tab goes on); saved into the exe and the mod (`dealer`)
- mods (see "The mod format"): "Open mod…" (or dropping a `.json`) opens a mod for the
  loaded exe, "Save mod" downloads the edits as one (named after the opened mod, else
  the exe); with a mod "Save exe" makes the exe from it at any time

Not supported (yet):

- painting over logic cells (use the inspector or the area tools); records are edited
  field by field
- painting exit tiles is plain painting (0x0017 in the base layer)
- English texts: room names and descriptions are edited in the German texts only
  (Junior and I also have English ones, which keep the old names, or none for new rooms)
- copying areas between editor windows or exes (the clip lives in the page)
- English UI texts / English descriptions (German only; English exists for Junior and I)
- remembering the last exe or unsaved work across reloads
- any check that an edited room is still playable

## Fan episodes: plan and decisions

Where the work towards fan episodes (new content beyond the original episodes' toolkit)
stands, decided 2026-10-27; details in the sections named.

- **Delivery stays exe patching.** A new episode needs more than resources: the start
  (code, `start.ts`), class table entries (data), maybe code patches. Planned: a mod
  format, changes applied to a pristine exe (checked by hash), shared as a file holding
  only its own data; see "The mod format" below.
- **Rejected:** `WorldOfRobot.DLL` for episode data (see "Where resources come from":
  the exe only falls back to it for resources it lacks, and code-side changes need the
  exe anyway). **Deferred:** a native Linux wrapper instead of Wine (keys, time, DirectDraw
  and GDI are few imports, but worth it only to run without Wine), a decompilation
  (only if playing in the editor in the browser becomes a goal; incremental path: a
  loader that replaces functions one by one), the proxy as an in-memory mod loader
  (the mod format is designed for it, see below).
  Untried: the `RessourcePath` loose text files.
- **Done:** the driver (proxy DLL, `driver.ts`, `pnpm test:game`) to verify edits in the
  game; the OMF writer and `withShapes`; `withClassEntries`; the **pilot: oracles in
  Junior**, working and visible (see "A class table entry" under Limits): class table
  entries, texts and shapes copied from episode II. The **pilot: circuits in episode
  III**, **verified under Wine** (`pnpm test:game`): `Game.withTileTypes(3, 1, …)`
  makes III's free types 0x40, 0x59, 0x43 episode I's LETTER, GATE and BULB (0x25,
  0x42, 0x43); in room 41 three circuits of 1 and 1 (AND; XOR then NOT; NAND) lit
  the first two nodes, which placed their stairs, once the hero took a spare piece; the
  frames before and after equal our render (bulbs lit or not, stairs, the piece gone),
  and the first take showed I's text with its 100 points. The circuit code works by
  class (the map holds class | state << 8), none of it checks the episode. **Both
  pilots in other episodes, as mods, verified under Wine** (`pnpm test:game`, the
  episode's start room): circuits in III, IV and Junior (with I's stairs, which Junior
  lacks), oracles in Junior, I and IV (north sends to the target cell, east shows the
  copied hint 331).
- **`Game.withTileTypes(episode, from, types)`** copies what belongs to a tile type:
  the class table entry, the `_Rob_object` shape, the description (entry n), the sound
  table line (I's sound only where the episode has that MUSIC piece, else its own:
  III has no FANFA2, so its GATE takes nothing) and the first take (event table entry
  n, its text 1800 + n, in III in resource 1320). Not covered: other texts a class
  shows (the oracle's hints and messages: the editor offers them, `classTexts`), English
  texts, code that checks the episode.
- **Cross-episode classes in general:** free tile types per episode (no class): Junior
  69 (0x39–0x7d), I 47, II **none**, III 18, IV 15. Some of them lie in rooms anyway
  (cells without a class): Junior 0x39 (room 51, 12 cells), I 0x53 (room 14), III 0x11
  (room 99, one cell), IV 0x03 (room 2), so a copy should not go there (the editor
  leaves them out). II would need a type that none of its rooms uses. Copied shapes keep their colour indices, and palettes
  differ per episode (I's BULB uses colours 1 and 6, which differ in III: the game draws
  them with III's colours, as we do; remap if it matters). Some class code checks the
  episode number (e.g. describe method 0x4145b0): every class needs a try in its new
  episode. **Circuits** need 3 free types and stairs (a lit node places class 71):
  Junior has **no stairs class** (I's 0x3d as a fourth type works), IV has them. Their
  code checks no episode. Lighting nodes is event 293 (0x125): 4000 points and "Na also,
  wieder etwas gelernt…" in I and II, 4000 points without a text in Junior, nothing in
  III and IV (no entry; seen in the game: the event's bit is set, no points); with I's
  entry copied to IV's spare entry 197 (the circuits kit) IV gives the 4000 points too
  (**verified under Wine**: taking the piece adds its first take and 4000). **Oracles**
  need 2 types (tangram, oracle; I has 0x50 and 0x51 free), their texts (`copyTexts`;
  Junior, I and IV have nothing at 331, 334, 945) and, for their 3500 points, events
  262–271: Junior, I, II and III have them, **IV not** (no points there, seen in the
  game; with `events` giving IV's entries 197 and 198 ids 263 and 266, and II's texts
  1935 and 1938 copied to 1997 and 1998, the oracles give 3500 points and their bonus
  box, **verified**; the box comes before the oracle sends the hero). Junior and I have
  no texts for those events (no box, the points still count). Their code checks
  the episode only for the flags 0x4000/0x8000 (0x412ae0). After the east hint the
  hero stands on the oracle's cell (in II it vanishes; elsewhere it stays under him).
- **Oracles that vanish** elsewhere than in II: the mod kind `flags` with 0x4000/0x8000
  set; **verified under Wine** (`pnpm test:game`): in Junior with them both oracles
  are drawn as empty floor after north and east and walking north into the first
  again goes on north; without them it sends the hero once more.
- **Next:** "place an example" for the kits (a working oracle with its symbol laid out,
  a small circuit with its stairs, next to the start in the shown room); the proxy as
  an in-memory loader; the `code` kind in the editor; an event's sound line with its
  copy. Both pilots are kits in the Episode tab now ("Add oracles", "Add circuits").
- **Deferred:** English texts for classes from episodes II–IV. Those episodes have no
  English texts (`1E11` exists only for Junior and I), so there is nothing to copy:
  English would be our own translations (for the oracles in Junior: 80, 81, 331, 334,
  945), better carried by the mod format.

### The mod format

Drafted 2026-10-27 from the two pilots and the editor as it is. **Implemented** in
`mod.ts` (all kinds, the file, compiling and applying; tested, and the circuits pilot's
game test now runs an exe made from a mod), `robot mod apply` and the editor (`Editor`
with a mod, `saveMod`; "Open mod…", "Save mod"); **not yet** the proxy loader.

- **A mod is a set of keyed changes, not a log.** Each change has a key (below) and
  appears once; changing the same thing again replaces it. Applying a mod replays the
  changes through the functions the editor and the pilots already use, in a **fixed
  order of kinds**, so the file needs no ordering and a later kind wins over an earlier
  one (a text change beats the description `tileTypes` copied). Within a kind the
  changes apply in key order, the file's, so the result does not depend on the order
  they were made in (new text entries, sound lines and shapes are appended). Later
  kinds as needed: sound table lines of events, shapes of the mod's own.
  1. `tileTypes` (key: episode, target type): `{ episode, from, types: [[to, of], …] }`
     → `Game.withTileTypes`. `events` (key: episode, entry): `{ episode, entry, id,
points }` → `withEventEntries`, after the tile types (it may override a copied
     first take). From entry 128 on the id is 0 or 256–391: the constructor maps id →
     entry in 0x4c70e0 (0x43b4bf, shared with class → type below 256, 0x188 long, no
     bounds check); applying refuses two entries with one id. The tables are full
     (Junior and I: entry 190 free, nothing else), so a new event takes over an entry
     the episode never uses: IV's 197–200 (ids 388–391, no note, text or points; IV's
     scripts award 180–196, no code raises those ids). III has no such spare entry.
  2. `code` (key: address): `{ va, expect, bytes }` (hex) → bytes written at `va` only
     if the exe holds `expect` there (e.g. the oracle flags in Junior).
  3. `dealer` (key: episode): `{ episode, most, goods: [[class, state, price], …] }` →
     `withDealer` (see "The dealer's goods"): the episode's whole list, at most as many
     goods as its table has room for, each of a class the episode has a tile of.
  4. `texts` (key: resource id, entry): `{ resource, entry, variants | null }` →
     `withTextEntry`, entry by entry (room names, descriptions, hints, messages), never
     whole resources: the file holds only what the mod wrote, and two changes to one
     resource compose. `copyTexts` (same keys: an entry is either copied or written):
     `{ resource, from, entries: [[to, of], …] }` copies entries of resource `from` (as
     kinds 1–3 left the exe) into `resource`, e.g. episode II's oracle hints and death
     message (1210: 331, 334, 945) into Junior's 1010, so the mod carries no text of
     the game's own.
  5. `rooms` (key: episode, room id): the room as its SCNV3 bytes (id, tags with the
     script, map, records; as `serializeScene` writes one room), base64; `null` removes
     the room. Others keep their place; once a room is added or removed, the episode's
     rooms are sorted by id, as the editor keeps them → `withScene`.
  6. `start` (key: episode): `{ episode, room, x, y }` → `withEpisodeStart`.
  7. `rucksack` (key: episode): `{ episode, capacity }` → `withRucksack` (1–250).
  8. `flags` (key: episode): `{ episode, flags }` (the whole word, hex in the file) →
     `withEpisodeFlags`.
  9. `backdrop` (key: episode): `{ episode, rule }` ("mod100", "minus100") →
     `withBackdropRule`. `moves` (key: episode): `{ episode, diagonal }` →
     `withDiagonalMoves`.
- **File:** one JSON file (`*.robotmod.json`) with `format` (1), `name`, `author`,
  `description`, `base` (`{ sha256 }`) and `changes` (`tileTypes`, `events`, `code`,
  `dealer`, `copyTexts`, `texts`, `rooms`, `start`, `rucksack`, `flags`, `backdrop`, `moves`: arrays of the
  changes above; a kind left out is empty). `base` is the sha256 of the whole
  pristine exe (the Windows version 2018, `reference/GameOfRobot.exe`); applying
  refuses any other exe. A changed room carries the original content it keeps (a fan
  episode's rooms are mostly new; cell diffs only if that matters).
- **Two forms.** The mod above is what authors write and share. Applying it first
  **compiles** it against the user's own pristine exe into a low-level patch: byte
  writes in the image (`va`, bytes: class and event tables, the start method, code)
  and whole replaced resources (type, id → bytes: scenes, texts, shapes). Both delivery
  paths apply that patch and nothing else: the **exe writer** (`replaceResource`, byte
  writes; what "Save exe" and "Test in game" use) and later the **proxy as an
  in-memory loader**. That one needs no TypeScript logic in C: `DDRAW.dll` is a static
  import, so the proxy's `DllMain` runs before the game's startup code and the episode
  constructors; it writes the bytes (`VirtualProtect`) and hooks `FindResourceA`,
  `SizeofResource`, `LoadResource` and `LockResource` (imported; every resource read
  goes through the opener 0x430d20) to serve the replaced resources. The compiled patch
  holds whole original resources, so it stays on the user's machine; only the mod is
  shared. The game reads its own file only for its date (0x4058c0, `GetFileTime`, for
  system info) and version info (0x428b20, `GetFileVersionInfoA`), neither of which a
  mod changes; its other `CreateFileA` calls open loose resource files, savegames and
  screenshots by name.
- **Code:** `mod.ts`: the types, `checkMod` (value ranges, `textEntryProblem`, keys
  changed twice; messages name the change), `parseMod` and `modJson` (the file; arrays of
  numbers on one line), `compileMod(image, mod)` (checks the base, applies the changes
  through the editing functions, then diffs: writes outside `.rsrc`, changed resources),
  `applyPatch` and `applyMod`; `sha256.ts` (synchronous, for the browser too);
  `serializeRoom`/`parseRoom` in `scene.ts`. On the command line
  `robot mod apply MOD OUT.exe`, later `robot mod compile MOD OUT.patch` for the proxy.
- **The editor** works on two images: the **base** (pristine + kinds 1–2 and the text
  copies: the tile types, events and text copies, which it edits by making a new base
  (`BaseChanges`; events copied with their texts), and code, which it does not edit) and
  the **edited** state on top (kinds 3–9: the dealers, rooms, texts, the start, the
  rucksack, the flags, the backdrop rule and diagonal moves). Opening takes an exe and, optionally, a
  mod; "Save mod" writes the tile types, events and text copies as edited, code as loaded plus kinds
  3–9 as the difference between the edited state and the base (dealers, starts,
  rucksacks, flags, backdrop rules and moves that differ, rooms that
  differ byte for byte, text entries that differ), so text copied by `tileTypes` never shows up as an edit; a text entry
  written in the editor replaces its copy in `copyTexts`. "Save exe" and "Test in
  game" stay, built from the base and the edits. Undo/redo, dirty state (either save
  clears it) and the room list work as now; rooms the mod changes show as edited.
- **Invariants for tests:** for any editor state, applying `saveMod()` to the pristine
  exe gives the exe the editor saves: the same rooms byte for byte, the same text
  entries (their order in a resource may differ), all else byte for byte; a mod opened
  and saved unchanged gives the same file; later, the game state through the proxy loader equals the one
  from the written exe (the driver can read both).
- **Out of scope:** a sixth episode (the episode list and factories are code: a mod
  builds a fan episode in the slot of one of the five), mods on top of mods, other exe
  versions.
- **Decided 2026-10-27:** whole rooms (no cell diffs); no editor UI for `tileTypes`
  and code at first (the file and the command line); English texts later. The start,
  then the tile types got their UI the same day (Episode tab), events copied from other
  episodes on 2026-10-28.
  Open: the patch file's format for the proxy (only when the loader is built).

## Trying edits in the game

The driver tests (`packages/tools/test/driver.test.ts`, `pnpm test:game`) verify an
edit repeatably: a mod or patched exe, the change next to the hero's start, then the
game's memory (hero, map, actor list, score) or a frame compared with our render.
By hand or with the screenshot harness:

- Build the exe (`Game.withScene`, or the editor's "Save exe"), put the change next to
  the hero's start (see "The hero's start" above) and run
  `python3 -I tools/wine/harness.py shot E OUT.png --exe EXE --keys Right:0.1 wait:2`
  (`--debug DIR` saves every step and a capture after each key); the game's screenshot
  file name tells the room it ended in, and the cells that differ from our render show
  where the hero and what changed are.
- `robot start E ROOM OUT.exe --at X,Y` makes an exe starting the hero anywhere (the
  whole episode stays as it is); `robot play` and the editor's "Test in game" run one
  to be played by hand.
- Exits open only once a room's robots are gone, so tests of walking out remove them
  (`calmRoom`); a 0.1 s key press moves the hero 2 cells, 0.3 s several (the game
  misses presses now and then). Message boxes (first takes, bonuses) stay until Return.
- The rucksack: Return opens it, a letter key or the arrows pick an item (letters first
  appear as one "?" item to choose with Return), Down picks the action, Return does it
  ("Benutzen" puts a letter down next to the hero).
- `PrintVal(x)` in a script shows a value in a box. Put objects the hero needs on the
  map to be taken: a shovel given by `Take()` in a script did not show up in the
  rucksack. Episode IV's status line shows the room and the hero's cell
  (`[183,26/15]`); `SetNight(0)` lights a dark room.

## Open items and leads

Roughly by value for the editor.

1. **Logic records in play** (see logic records above): the thief (not tried), circuits
   with OR, NOR and the inverted-input gates (AND, NAND, XOR and NOT tried; the code and
   the GATE texts agree on all of them), a final node waiting for itself (from the
   code), records in rooms whose objects and records exceed the table.
2. **Actors** (see actors above): the robot-free room and the telephone (code only;
   what the Ghostbusters' second call stores), RandObj's empty cell (code only).
3. **Scripts** (see room scripts above): what `Phone`'s n limits (still
   answered after 60 s), whether `Area`/`ShiftArea` settings survive leaving the room,
   RIGHT and the wand words. Possibly worth adding to the compiler: `while`,
   `break`, compound assignments (they compile to existing operations).
4. **Room tags** (see room tags above): bit 0 of kind 3 not tried in the game (the
   labyrinth: entering room 144 from 146 generates a new maze of teleporters, 0x40c910;
   the booklet confirms the labyrinth "changes its size and its paths"; a test starting
   in 146 could not reach its teleporters, which lie in the cave wall).
5. **Rooms and connections:** not tried in the game: the old mechanism raising 149 into
   49 (needs a licensee and a matching number in the harness's prefix), the wizard's
   door. Episode II's jump to room 600 at 0x40a820 is not understood. Two edge-exit
   code paths: 0x427a9b (arrival only) and 0x44c5a0 (also sets the RandObj reference
   point; with game flag bit 10 of [0x51bb18]+8 clear, the arrival moves one cell
   further in); which one runs when is not known.
6. **Renderer gaps** (`pnpm robot eval --types`): empty floor in episodes I/II (runtime:
   actors, hero, animations), episode IV types 95/106/79/99/70, episode III types 83, 37,
   49, 76, episode II 85/77/110/25, Junior 23/25 (animated). Some are runtime effects that
   a static render cannot match. The game draws a logic cell by its record's type
   (0x4328f0, jump table 0x432c90 by type − 1), of which we follow circuit nodes (the
   bulb) and teleporters (their condition, see above): type 1 adds the stacked cell
   (offset 4) as a sprite unless word 0 bits 14–15 are set, type 5 class 0x34 in state
   byte 7 − 1 while byte 7 is set, type 8 depends on byte 8 (0x103: class 0x2c, the
   dealer). Not traced further. A teleporter with byte 1 bits 6–7 (a level) and no
   condition is not drawn there (no original has one). A state whose frame the shape
   lacks: we draw frame 0, the game reads past the shape's frames (class 99, one frame,
   in state 1: specks in the game, seen with the driver; IV 453's state 8 cell).
7. **Description extras:** key colours (strings 0x9c50/0x9c51 from the exe's string
   table), messages 200/201 added by two classes, codes formatted by 0x41d2c0/0x40ff80, and
   four describe methods that depend on game flags/options.
8. **Not decoded at all:** MUSIC (only its instrument and piece names) and PCXBITMAP
   resources, the obfuscated command strings
   near 0x4828d4 ("Command %s unknown!", probably cheats; two jump ±100 rooms).
9. **Notes and packages in the game** (see Descriptions above, decoded from code and
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
- **A class table entry** is 8 bytes: a pointer to the class object (a vtable pointer
  set at startup for every episode, so any episode may point to any class) and a
  second dword that is mostly the class id but not always (455 of 640 entries; 0x33 in
  unused ones) and that nothing in the game seems to read (the constructor 0x43b46a and
  0x43a5f0 read only the object); unused types point to the empty class object
  0x4c777c (class 0). `readClassTable`, `freeTileTypes` and `withClassEntries`
  (`classes.ts`) read and patch them; the test redoes the pilot's patch byte for byte. What a
  cell does when walked into is its class's method: the oracle class (0x60, object
  0x4c6754, vtable 0x467d90) dispatches through 0x47be24 (0x412ae0, the oracle handler)
  and 0x47bdf4 (0x412860, the symbol check); a record showing a cell of another class
  does nothing. **Verified under Wine (oracles in Junior):** Junior's entries for 0x50
  and 0x51 copied from II's (tangram 0x5f at 0x4c6758, oracle 0x60; 16 bytes at
  0x479d58), the texts 80, 81, 331, 334 and 945 copied from II, and five oracle
  records in room 43: with the symbol preset, north led to room 42, east showed hint
  331, west turned it into a key, south killed; one without it showed hint 334 once
  symbol 4 lay as tangram pieces in the map. As in III, they stay after north and east
  (only II's constructor sets the flags 0x4000/0x8000). Without shapes both are
  invisible: Junior's `_Rob_object` has 57 entries (types 0–0x38), II's 127 (0x50: 5
  frames, 0x51: 10), and the game draws nothing past the end. With II's shapes added
  (`withShapes`, the table grown to 0x52) the game draws them, the laid symbol as
  solved pieces (**verified**, captured frame equal to our render but for runtime
  effects).

## Useful addresses

| Address                      | What                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| 0x438d10                     | scene loader (tags → room record +0x14…)                                       |
| 0x439590                     | exit target per direction from the exits byte                                  |
| 0x427a9b                     | hero leaves the map → `NxtRoom` (0x4fe2f6), arrival x/y 0x4fe309/0x4fe30a      |
| 0x433a60, 0x433c30           | open/close exit tiles on the edges (task 0x66, started on entering a room)     |
| 0x413d30, 0x4140d0, 0x426880 | door in, door out, stairs                                                      |
| 0x412ae0, 0x44cc30           | oracle, teleporter (step-on handler 0x44cb60)                                  |
| 0x44c6f0, 0x42bd40           | may an actor step on a cell (teleporter conditions); count a class carried     |
| 0x42b6f0                     | room load: records 7/8 spawn actors                                            |
| 0x432fd0, 0x433110           | logic record lookup; a cell's effective value                                  |
| 0x433230, 0x4331a0           | a cell's top with actors (RandObj: 0 = empty); set the top of a cell           |
| 0x44c98d, 0x41f9d0, 0x44dcf0 | class vtable +0x0c on stepping; sand heap → scorpion; create a scorpion        |
| 0x401af0, 0x409d30, 0x439130 | draw a room over its backdrop; which room; load it (IV 0x40d4a0, 0x40d780)     |
| 0x406ae0, 0x438850           | describe a cell; fetch a text variant                                          |
| 0x43c0b0, 0x43bfd0           | a room's name; cut a text down to one line                                     |
| 0x43b2e0, 0x43b46a           | episode constructor; class tables 0x4c6ce0 (objects) / 0x4c70e0 (class → type) |
| 0x4fe2fc, 0x4fe35e…0x4fe364  | current room; RoomNorth/South/West/East                                        |
| 0x53e9ac, 0x53e9a8, 0x51a114 | the hero (x +9, y +0xa); the room's first actor; actor per cell (40 per row)   |
| 0x405bb4, 0x4016a0, 0x42cf70 | main loop; run the game per elapsed clock unit (tick 0x51bb38); clock 147/s    |
| 0x404677, 0x42cd40, 0x43bc90 | WM_KEYDOWN; virtual key → DOS key code (table 0x481b68); the key handler       |
| 0x401210, 0x402100, 0x437620 | the frame buffer; WM_PAINT (StretchDIBits); DirectDraw present (display obj.)  |
| 0x404190, 0x433710           | the screenshot command (4015, Ctrl+Alt+P); write a palette PNG                 |
| 0x44c5a0, 0x44c680           | hero walks off an edge (sets the RandObj reference point); pending room change |
| 0x44dc60, 0x44d520           | create an actor (kind, x, y); factory lookup by class                          |
| 0x4073a0, 0x407650           | script RandObj; count a class in the room (actors, else the top of each cell)  |
| 0x445bd0, 0x445b60, 0x44ac70 | robot constructor; its sprite and colours; episode IV's robot                  |
| 0x41e4d0, 0x47efe0, 0x41e100 | telephone (episode II): dial; numbers → handlers; Ghostbusters (robot-free)    |
| 0x4827f0                     | base palette (episode III: 0x477c10)                                           |
| 0x4314b0, 0x438710, 0x431300 | CRUNCHED: next character; load a text resource; parse an entry header          |
| 0x432560, 0x4327c4, 0x432e06 | room load: convert records; overlay objects → type 1 records; allocate one     |
| 0x42bef0, 0x407aa0           | an event's first time (sound, points, text 1800 + n); script Enigma            |
| 0x4389b0, 0x43a710           | read the sound table into the event table; a class's event table entry         |
| 0x4393d8, 0x4393e8, 0x439537 | entering a room: episode III kind 3 bit 0; background music; kind 3 bit 1      |
| 0x40f700, 0x40f9a0           | circuits: evaluate the nodes (after taking or putting down a piece); trace     |
| 0x4328f0, 0x432c90           | draw a map cell (classes; logic cells by record type); its jump table          |
| 0x412860, 0x47be54           | an oracle's symbol check; the 10 symbols                                       |
| 0x431f20                     | storing a room: records with byte 1 bit 5 dissolve into their cell             |
| 0x42ca90, 0x430110, 0x430210 | read a word laid with letters; turn the Area square left, right                |
| 0x42fdc0, 0x4302f0           | ShiftArea's shift; turn a punch card's square                                  |
| 0x4130b0, 0x41f730, 0x448440 | dig (shovel); level tiles and bridges; the dealer's offer (goods)              |
| 0x4487d0, episode +0x10      | the dealer's trade keys (Esc pays); the episode's goods table                  |
| 0x408da0 (per episode)       | episode start: arrival cell, start room, rucksack (vtable +0x54, `start.ts`)   |
| 0x4fe0c0, 0x4fe0c2, 0x42c010 | the rucksack's capacity; its slots; take an item (slot and weight)             |
| 0x408ca0 (per episode)       | the constructor's flags ([0x51bb18]+8, `episode-flags.ts`)                     |
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
- `harness.py play`, `shot` and `serve` share the prefix: each ends a game another
  started (`wineserver -k`), and `shot` deletes `Documents/Robot` in the prefix, i.e.
  also the screenshots and saved games of played games. A worktree of the repository
  has its own `.wine/` (run `harness.py setup` there), so its games do not collide.
  `Driver.close()` resolves only after `serve` has cleaned up, so the next game is not
  ended by the previous one's `wineserver -k`: await it.
- The proxy does nothing but forward unless `ROBOT_PROXY_PORT` is set;
  `ROBOT_PROXY_LOG=C:\…` makes it write a log (a path in the prefix, e.g.
  `C:\robot-drive\proxy.log`), including a port it could not listen on. `serve` picks a
  free port and a token the proxy's `hello` must name, so two checkouts' games never
  get mixed up; it reports ready only once the game waits for its first step.
- `run` answers "stalled" when the game stops stepping for 3 s: a message box or a
  modal dialog, or a crash (Wine's crash dialog is then on the virtual display).
