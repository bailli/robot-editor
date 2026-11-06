# Self-review 2026-11-06: open findings

Review of 40ac011..396297c (226 commits since the last review), by four reviewers (the
native Linux wrapper with special care; formats; editor; tools, proxy and harness).
Fixed entries are removed. "Confirmed" means a reviewer ran it or traced it in the code;
"plausible" means it was only read. Each one needs verifying before it is fixed. Delete
an entry once it is fixed or rejected; delete the file when it is empty.

## Native Linux wrapper (tools/linux, its TS side, CI)

1. **Open, low: the proxy under Wine likely deadlocks on the way back from full screen** as
   the wrapper did (fixed there, `driver_wait_message`). After Alt+Enter twice the game
   waits in GetMessage for its 200 ms timer, but the proxy's timers only fire in `step`.
   Not tried under Wine (Wine runs need the user's ok).
2. **Not run under Wine: the proxy's `hello TOKEN` check.** The wrapper's was tried
   (no hello, a wrong token, an idle squatter, busy), and the proxy has the same code
   (it builds). harness.py's probe sends the token. Run `pnpm test:game:wine` once Wine
   runs are ok.
3. **Not run yet: CI `wrapper.yml`'s new release step** (the tag moved, the file
   replaced with `--clobber`, the release created only where it is missing; the build
   as a tar with its executable bit; setup-node; package.json in the paths). It runs on
   the next push to main.

## editor

1. **Not reviewed yet:** record-view, room-view, kits-view, events-view, music-view,
   settings-view, code-view, circuit-view, dealer-view, episode-view, tile-types-view,
   help-dialog and script-view. The reviewer did not read them.

## tools, proxy, harness

3. **Plausible: `proxy.c:341-347` (`patch_game`, `call_at`) reads 0x405bde in DllMain
   of any process that loads the proxy** (DxDiag loads ddraw). That is an access
   violation if it isn't mapped. Fix: check that the module is GameOfRobot.exe first.
4. **Plausible: a race in `harness.py start_xvfb`** (~126-141) when two harnesses run.
   The socket of another display can be taken for ours. Fix: `-displayfd`, or re-check
   `poll()`.
5. **Confirmed by reading: `harness.py shot`.** `xdo search --sync` has no timeout (and
   the TS `spawnSync` has none either). There are no SIGTERM/SIGINT handlers, so Xvfb and
   wine stay behind.
6. `proxy.c:491-496 button`: any name other than "left" counts as the right button.
7. `proxy.c:481 key`: VK `& 0xff` instead of a range check.
8. **Plausible: real time leaks.** `hook_SetTimer` passes `hwnd == NULL` timers to the
   real SetTimer. Sleep, WaitFor* and waveOut aren't virtual. Unverified.
9. `driver.ts press/click/hold`: a throw between down and up leaves the key or button
   held (benign while `withGame` closes the driver).
