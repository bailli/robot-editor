# The Game of Robot – data formats and editor

Reverse engineering of the data in `GameOfRobot.exe` (TOM Productions, Windows version 2018)
with the goal of a cross-platform level editor.

The game itself and everything derived from it are not part of this repository.

What is decoded, what the editor supports and what is still open: [STATUS.md](STATUS.md).

## Setup

1. Put `GameOfRobotInstall.exe` into `reference/` and unpack it:
   `7z x -oreference reference/GameOfRobotInstall.exe`
2. `pnpm install`
3. `pnpm exec playwright install --only-shell chromium` (the editor's tests run in it)
4. Optional, for the comparison test with 7-Zip's resource extraction:
   `7z x -oresources reference/GameOfRobot.exe '.rsrc/*' && mv resources/.rsrc/* resources/ && rmdir resources/.rsrc`

## Layout

- `packages/formats` – `@robot/formats`: readers and writers for the game formats
  (resources straight from `GameOfRobot.exe`, texts, scenes, shapes, object classes, room
  rendering); no dependencies, runs in Node and browsers
- `packages/editor` – `@robot/editor`: the level editor in the browser
- `packages/tools` – `@robot/tools`: command line tools (`pnpm robot ...`)
- `tools/wine/harness.py` – runs the real game under Wine for reference screenshots
- `tools/wine/proxy` – the proxy DLL (`ddraw.dll`, C) the driver uses to step the game;
  it also turns on the game's hidden command console
- `tools/linux` – the native Linux wrapper (C): runs `GameOfRobot.exe` without Wine

## Editor

Online: https://bailli.github.io/robot-editor/ (open your own `GameOfRobot.exe`; it never
leaves the browser).

`pnpm editor` starts it at http://localhost:5173 and opens `reference/GameOfRobot.exe`
by itself; otherwise open or drop an exe (it never leaves the browser). Pick an episode
and a room, then paint the base or overlay layer: left button paints, right button picks
the tile under the cursor, Ctrl+Z / Ctrl+Y undo and redo, G shows the grid, P F S I
choose the tool, L the layer, 1–8 the side panel's tab (? or the "Shortcuts" button
lists all keys). The Fill
tool fills connected cells; with the Select tool an area is copied (Ctrl+C), cut
(Ctrl+X), cleared (Delete) and pasted (Ctrl+V, then click), logic records included. The
side panel's tabs: Tiles; Record (a logic record's fields); Room (the description shown
under the room's name on entering, the darkness, the points for the first visit, the
music); Script (a room's script, source and disassembly); Episode (the start room and cell,
the rucksack's capacity, the episode rules such as flags, the backdrop rule and diagonal
moves, whether room 255 ends the episode, what the dealer sells and for how much, copies of tile types and events from other
episodes, the music they brought along and pieces copied by themselves for a room to
play (each piece removable), the mod's code patches,
and kits: "Add oracles" / "Add circuits" / "Add goal" with "Place example"); Texts (every text entry of the episode, found by number or words, written,
added or removed, and copies of texts from other episodes); Actors (robots and other
actors of the room); Circuit (the room's logic circuit).
"Map" shows all rooms and their links, "Dark" draws rooms as dark as in the game.
"Save exe" downloads a copy with the edits (scenes, texts, the Episode tab's settings).
A mod is the same edits as a JSON file against the pristine exe: "Open mod…" loads one,
"Save mod" writes the edits (and the opened mod's changes) as one; the format is in
[STATUS.md](STATUS.md). Scenes that grow move to the end of
the resource section (the exe's signature is dropped). Logic cells (magenta) refer to
the room's logic records and cannot be painted over (the inspector and the area tools change them). The room's name is edited in the
field next to the title, where "Delete room…" deletes it; "New room…" (or a + on the map)
adds a room with walls and exits, empty or as a copy of another room. "Test in game" starts the game in the shown room with all
edits (the hero at the selected cell): under `pnpm editor` with the native wrapper on this
display (after `pnpm wrapper`; `ROBOT_WINE=1 pnpm editor`: in Wine, after `python3
tools/wine/harness.py setup`; choose the episode in the game), otherwise the exe is
downloaded. One game at a time (a new test ends the one before); it runs in
`.native/play/`, where saves and screenshots stay, with your settings; the wrapper's
messages are in `.native/play/wrapper.log`. With the Console chip next to it, that exe has the
game's command console on (`SCENE 42 20 14`, `TAKE KEY(3)`, `ROBOTOFF`, …; the ? next to it lists the commands). `pnpm --filter @robot/editor build`
makes a static build in `packages/editor/dist/`.

## Command line

    pnpm robot render EPISODE ROOM OUT.png [--zoom N]       render a room (palette PNG)
    pnpm robot compare EPISODE ROOM SHOT.png [--diff OUT.png]
    pnpm robot eval [--types]                               where renders still differ from the game
    pnpm robot patch EPISODE ROOM OUT.exe                   exe that starts in (a copy of) ROOM
    pnpm robot shots [EPISODE ...]                          screenshot start rooms (the game)
    pnpm robot shots --room EPISODE ROOM ...                screenshot any rooms (the game)
    pnpm robot shots --update                               recompute shots.json
    pnpm robot script EPISODE ROOM                          a room's script: source and disassembly
    pnpm robot script EPISODE ROOM SOURCE OUT.exe           exe whose ROOM runs the script in SOURCE
    pnpm robot start EPISODE ROOM OUT.exe [--at X,Y]        exe whose episode starts in ROOM
    pnpm robot play EPISODE ROOM [--at X,Y] [--mute] [--console]
                                                            play the episode from ROOM
    pnpm robot mod apply MOD OUT.exe                        the exe a mod (JSON, see STATUS) makes

The commands that run the game (`shots`, `play`, the game tests) use the native Linux
wrapper (`pnpm wrapper`, see below); `ROBOT_WINE=1` runs them under Wine instead (see the
next sections). `play` runs the game on this display in `.native/play/` (saves and
screenshots stay there) with your settings; `--mute` plays it silently without changing
them, `--console` turns the game's command console on.

## Reference screenshots from the real game

`pnpm robot shots` runs `GameOfRobot.exe` with the native wrapper through the driver (on
virtual time, no window) and saves the game's own screenshot (Ctrl+Alt+P): palette
indices, so comparisons are exact. With `ROBOT_WINE=1` it uses `tools/wine/harness.py`
instead, the game under Wine (WineHQ `wine-stable`) on a virtual display (`Xvfb`,
`xdotool`), which deletes the prefix's saves and screenshots first. Set that up once with
`python3 tools/wine/harness.py setup`; the prefix in `.wine/` does not link into `$HOME`
and has no `Z:` drive. In rooms with actors or animated tiles the two catch them at other
moments (Wine after real-time waits, the wrapper after virtual steps); static rooms give
the same file.

`pnpm robot shots` stores screenshots in `shots/` (not committed) and records in
`shots.json` (committed) where our renderer still differs from the game. Any room can be
screenshot: a patched copy of the exe holds only the title screens and the wanted room
(without its scripts and enemies) in the start room's slot (an interior drawn over
another room keeps its id and that room). The game runs silently. The tests compare against the screenshots
when present and fail whenever the set of differing cells changes. Actors (hero, robots),
animations and other runtime effects differ from a static render by nature.

## Driving the game step by step

`packages/tools/src/driver.ts` runs the real game for tests: on virtual time (nothing
happens between commands, so runs repeat exactly), with keys and clicks sent between
steps, reading where the hero is and in which room. By default it runs the native Linux
wrapper (`tools/linux/robot --serve`, below), with a copy of the exe in a fresh directory:

    pnpm wrapper          build tools/linux/robot
    pnpm test:game        the tests that run the game

Under Wine (`ROBOT_WINE=1`, the cross-check) it needs the proxy DLL, a `ddraw.dll` placed
next to the exe that Wine loads instead of its own (it also copies every frame the game
presents: its palette indices, as in the game's screenshots); build it once with the
mingw-w64 cross-compiler (`apt install gcc-mingw-w64-i686`):

    pnpm proxy            build tools/wine/proxy/ddraw.dll
    pnpm test:game:wine   the same tests under Wine (Xvfb, harness.py setup)
    pnpm test:game:cross  the same input on both: the same frames, tick and hero

`python3 tools/wine/harness.py serve` starts the game with the proxy on a virtual
display and prints `ready PORT DISPLAY TOKEN` once the game waits for its first step;
`Driver.start()` does that and connects, `Driver.connect(PORT)` connects to a game
served by hand (the protocol is one text line per command, see `proxy.c`).

The native wrapper speaks the same protocol: `tools/linux/robot --serve GAME.exe` prints
`ready PORT - TOKEN`.

`python3 tools/wine/harness.py play --console` runs the game to be played with the
proxy holding the mutex that turns on the game's command console: type e.g.
`SCENE 42 20 14`, `TAKE GOLD` or `ROBOTOFF` and Return (the commands are in STATUS.md;
while the console is on, letter keys go to it).

```ts
const d = await Driver.start();
await d.startEpisode(1); // { room: 43, x: 5, y: 14 }
await d.hold("right", 60); // 60 steps of 7 ms
await d.hero(); // { room: 43, x: 11, y: 14 }
await d.walk("up", (h) => h.y <= 10); // holds Up until the hero is there
await d.pickUp("left", (h) => h.x <= 8); // walks onto an item, closes its first-take box
await d.putDown("use"); // the rucksack's only item onto the hero's cell ("Benutzen")
await d.screenshot("room.png"); // the last frame presented, 640 × 348
await d.close();
```

## Native Linux wrapper

`tools/linux` runs the unchanged `GameOfRobot.exe` as a 32-bit Linux program in an SDL
window, with sound: it maps the exe at its base and supplies the Windows functions it
imports itself (state in [STATUS.md](STATUS.md), "Native Linux wrapper"). It needs the
32-bit toolchain and SDL2 (`apt install gcc-multilib libsdl2-dev:i386`):

    pnpm wrapper                                         build tools/linux/robot
    tools/linux/robot [--trace] GAME_DIR/GameOfRobot.exe
    tools/linux/robot --settings                         the settings and what they do
    tools/linux/robot --set NAME=VALUE [...] [GAME_DIR/GameOfRobot.exe]

`C:\` is the exe's directory: the game keeps its saves and screenshots there (`ROBOT
I\Saves`, `ROBOT Junior\Screenshots`, …), so run a copy of the exe in a directory of its
own rather than `reference/`. Settings (the game's registry values) are kept in
`~/.config/robot/registry.reg` (`ROBOT_REGISTRY=FILE` for another), a text file in the
style of Wine's `.reg`. `--settings` lists them with their values and meanings (the
configuration dialog's `SampleRate`, `AudioVolume`, `DisableOpl`, `Force640x480`,
`UseTrueColor`, `MinimizeToTray`, the Alt+letter options, …), `--set` writes them (e.g.
`--set SampleRate=44100`; read at the game's start). `ROBOT_IMPORT_REG=PREFIX/user.reg`
takes the game's values from a Wine prefix when that file does not exist yet.

Keys are the game's own (its help: F1; its menu: Return on the title screen; Alt+S, E, M,
T, W, G, B, V toggle the options of the Windows menu, Alt+Enter fullscreen, Ctrl+Alt+P a
screenshot). The Windows menu bar is not shown; its other commands are Ctrl+Shift+key:

| Keys               | Command                                        |
| ------------------ | ---------------------------------------------- |
| Ctrl+Shift+1 … 5   | episode Junior, I, II, III, IV                 |
| Ctrl+Shift+K       | configuration (runs unseen, see settings)      |
| Ctrl+Shift+O       | open the game's files (`xdg-open`)             |
| Ctrl+Shift+A, T, S | about ROBOT, TOM Productions, shareware        |
| Ctrl+Shift+W, F, R | web site, forum, registration (`xdg-open`)     |
| Ctrl+Shift+I       | system information (traced, runs unseen)       |
| Ctrl+Shift+Q       | quit (as the menu's "Ende"; closing works too) |
| Ctrl+Shift+Up/Down | the wrapper's volume, in steps of 10 % (kept)  |
| Ctrl+Shift+M       | sound off and on (kept)                        |

Options are environment variables: `ROBOT_SCALE=N` (window size, default 2 × 640 × 348),
`ROBOT_FULLSCREEN=1`, `ROBOT_CONSOLE=1` (the game's command console), `ROBOT_HEADLESS=1`
(message boxes answered with their default button), `ROBOT_DIALOG_OK=2041` (the dialogs
with these ids are confirmed instead of cancelled). For debugging: `--trace` (or
`ROBOT_TRACE=1`) logs every call into the wrapper; `ROBOT_SHOT=FILE.ppm` writes the last
picture shown when the wrapper is stopped (Ctrl+C); `SDL_VIDEODRIVER=dummy` runs without a
window, `SDL_AUDIODRIVER=disk` (with `SDL_DISKAUDIOFILE=FILE`) writes the sound to a file
instead of playing it. A function the wrapper does not have yet stops it, naming the function and the
caller's address.

## Resources

- The official info booklets ("Infohefte", German) for episodes I–IV, with very specific
  hints: https://www.game-of-robot.de/infohefte.htm (PDFs by TOM Productions:
  [I](https://www.tom-games.de/games/Infoheft_Robot1.pdf),
  [II](https://www.tom-games.de/games/Infoheft_Robot2.pdf),
  [III](https://www.tom-games.de/games/Infoheft_Robot3.pdf),
  [IV](https://www.tom-games.de/games/Infoheft_Robot4.pdf)). Not part of this repository.

## Scripts

- `pnpm check` – typecheck, lint, format check and tests (ESLint and Prettier keep a
  cache in `node_modules/.cache`; a changed type can leave an unchanged file's cached
  lint result stale, `rm -r node_modules/.cache/eslint` lints everything again)
- `pnpm test` – tests only (Vitest; `pnpm exec vitest` to watch)
- `pnpm typecheck`, `pnpm lint` – the type check and ESLint alone
- `pnpm test:game` – the tests that run the game (the native wrapper, `pnpm wrapper`)
- `pnpm test:game:wine` – the same tests under Wine (proxy; see above)
- `pnpm test:game:cross` – the wrapper against Wine: the same frames for the same input
- `pnpm proxy` – build the proxy DLL (see above)
- `pnpm wrapper` – build the native Linux wrapper (see above)
- `pnpm test:without-game` – the tests that need no game data (what CI runs)
- `pnpm snapshots` – record changed outputs in `packages/formats/test/__snapshots__/`
  (review the diff)
- `pnpm format` – apply Prettier

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, lint, format check,
`pnpm test:without-game`, the editor's build and a syntax
check of `harness.py` on every push to `main` and every pull request, and publishes the
editor's static build from `main` on GitHub Pages at https://bailli.github.io/robot-editor/
(Settings → Pages → Source: GitHub Actions). `.github/workflows/wrapper.yml` builds the
native Linux wrapper when `tools/linux/` or `package.json` changes (pushes to `main`, pull
requests) and keeps it as the artifact `robot-linux-i386` of that run (inside it
`robot-linux-i386.tar.gz`, the program executable); from `main` it also replaces the file
of the rolling pre-release `linux-wrapper` (Releases: always the latest build; there
`chmod +x robot-linux-i386` first). It is a 32-bit program; it runs where SDL2 for i386 is
installed, e.g. `apt install libsdl2-2.0-0:i386` after `dpkg --add-architecture i386`.

TypeScript is restricted to erasable syntax, so Node.js (>= 22.18) runs the sources directly
without a build step.
