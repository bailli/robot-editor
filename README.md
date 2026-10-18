# The Game of Robot – data formats and editor

Reverse engineering of the data in `GameOfRobot.exe` (TOM Productions, Windows version 2018)
with the goal of a cross-platform level editor.

The game itself and everything derived from it are not part of this repository.

## Setup

1. Put `GameOfRobotInstall.exe` into `reference/` and unpack it:
   `7z x -oreference reference/GameOfRobotInstall.exe`
2. `pnpm install`
3. Optional, for the comparison test with 7-Zip's resource extraction:
   `7z x -oresources reference/GameOfRobot.exe '.rsrc/*' && mv resources/.rsrc/* resources/ && rmdir resources/.rsrc`

## Layout

- `packages/formats` – `@robot/formats`: readers and writers for the game formats
  (resources straight from `GameOfRobot.exe`, texts, scenes, shapes, object classes, room
  rendering); no dependencies, runs in Node and browsers
- `packages/tools` – `@robot/tools`: command line tools (`pnpm robot ...`)
- `tools/wine/harness.py` – runs the real game under Wine for reference screenshots

## Command line

    pnpm robot render EPISODE ROOM OUT.png [--zoom N]       render a room (palette PNG)
    pnpm robot compare EPISODE ROOM SHOT.png [--diff OUT.png]
    pnpm robot eval [--types]                               where renders still differ from the game
    pnpm robot patch EPISODE ROOM OUT.exe                   exe that starts in (a copy of) ROOM
    pnpm robot shots [EPISODE ...]                          screenshot start rooms (needs Wine)
    pnpm robot shots --room EPISODE ROOM ...                screenshot any rooms (needs Wine)
    pnpm robot shots --update                               recompute shots.json

## Reference screenshots from the real game

`tools/wine/harness.py` runs `GameOfRobot.exe` under Wine (WineHQ `wine-stable`) on a
virtual display (`Xvfb`, `xdotool`) and saves the game's own screenshot: palette indices,
so comparisons are exact. Set it up once with `python3 tools/wine/harness.py setup`; the
prefix in `.wine/` does not link into `$HOME` and has no `Z:` drive.

`pnpm robot shots` stores screenshots in `shots/` (not committed) and records in
`shots.json` (committed) where our renderer still differs from the game. Any room can be
screenshot: a patched copy of the exe holds only the title screens and the wanted room
(without its scripts) in the start room's slot. The tests compare against the screenshots
when present and fail whenever the set of differing cells changes. Actors (hero, robots),
animations and other runtime effects differ from a static render by nature.

## Scripts

- `pnpm check` – typecheck, lint, format check and tests
- `pnpm test` – tests only (Vitest; `pnpm exec vitest` to watch)
- `pnpm snapshots` – record changed outputs in `packages/formats/test/__snapshots__/`
  (review the diff)
- `pnpm format` – apply Prettier

TypeScript is restricted to erasable syntax, so Node.js (>= 22.18) runs the sources directly
without a build step.
