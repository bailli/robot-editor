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
4. `pnpm golden` – exports the reference output of the Python tools to `golden/`

## Layout

- `tools/` – Python reference tools (decoders, renderers, golden export)
- `packages/formats` – `@robot/formats`, TypeScript readers for the game formats,
  tested against the Python output

## Scripts

- `pnpm check` – typecheck, lint, format check and tests
- `pnpm test` – tests only
- `pnpm format` – apply Prettier

TypeScript is restricted to erasable syntax, so Node.js (>= 22.18) runs the sources directly
without a build step.
