# The Game of Robot – data formats and editor

Reverse engineering of the data in `GameOfRobot.exe` (TOM Productions, Windows version 2018)
with the goal of a cross-platform level editor.

The game itself and everything derived from it are not part of this repository.

## Setup

1. Put `GameOfRobotInstall.exe` into `reference/` and unpack it:
   `7z x -oreference reference/GameOfRobotInstall.exe`
2. Extract the PE resources of the game:
   `7z x -oresources reference/GameOfRobot.exe '.rsrc/*' && mv resources/.rsrc/* resources/ && rmdir resources/.rsrc`
3. `pnpm install`
4. `pnpm golden` – exports the reference output of the Python tools to `golden/`; their
   hashes are committed in `golden.sha256`, so changes to the reference output show up
   in review

## Layout

- `tools/` – Python reference tools (decoders, renderers, golden export)
- `packages/formats` – `@robot/formats`, TypeScript readers for the game formats
  (resources straight from `GameOfRobot.exe`, texts, scenes, shapes, room rendering),
  tested against the Python output

## Reference screenshots from the real game

`tools/wine/harness.py` runs `GameOfRobot.exe` under Wine (WineHQ `wine-stable`) on a
virtual display (`Xvfb`, `xdotool`) and saves the game's own screenshot of an episode's
start room: palette indices, so comparisons are exact.

    python3 tools/wine/harness.py setup                  # once: sandboxed prefix in .wine/
    python3 tools/wine/harness.py shot 1 .wine/ep1.png    # episode 1 start room
    python3 tools/compare_shot.py 1 43 .wine/ep1.png

The prefix does not link into `$HOME` and has no `Z:` drive. Actors (hero, robots) and
animated tiles differ from a static render by nature.

## Scripts

- `pnpm check` – typecheck, lint, format check and tests
- `pnpm test` – tests only
- `pnpm format` – apply Prettier

TypeScript is restricted to erasable syntax, so Node.js (>= 22.18) runs the sources directly
without a build step.
