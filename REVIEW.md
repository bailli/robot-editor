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
   - Related, low: the wrapper's `synthesize` returns WM_TIMER before WM_PAINT, but
     Windows gives WM_PAINT priority. `InvalidateRect(NULL, …)` (0x437373) is a no-op.
2. **Not run under Wine: the proxy's `hello TOKEN` check.** The wrapper's was tried
   (no hello, a wrong token, an idle squatter, busy), and the proxy has the same code
   (it builds). harness.py's probe sends the token. Run `pnpm test:game:wine` once Wine
   runs are ok.
3. **Low: expose in fullscreen** (`sdl.c:435`).
   - `SDL_WINDOWEVENT_EXPOSED` always calls `screen_present()`, which shows the GDI frame
     during DirectDraw fullscreen, resizes the texture to 640×348 and switches the mouse
     mapping.
   - Fix: re-show what is shown, or skip it while `showing_rgb`.
4. **Low, plausible: `ExitProcess`** (`kernel32.c:1796`) calls `exit()` while the sound
   and SDL audio threads still run. Fix: `fflush(NULL); _exit(code);`.
5. **Low: a closed handle can be freed under a waiter** (`kernel32.c:1471-1527`).
   - `wait_objects` takes no reference. dsound's `signal_send` runs after unlocking.
   - The game never triggers this today.
6. **Low: the PE loader trusts header fields** (`loader.c:261-303`, `bind_imports`
   233-259, `res_lookup` in `kernel32.c`).
   - `e_lfanew`, `SizeOfHeaders` (the memcpy at 287), the section table, `va + n` wrap,
     the imports and the resource offsets are unchecked.
   - Reachable only with a malformed exe (e.g. one posted to "Test in game").
   - Fix: validate every offset with 64-bit sums.
7. **Low, semantics:**
   - TranslateMessage appends WM_CHAR behind queued input (Windows reads posted messages
     first).
   - FOCUS_LOST (`sdl.c:438`) posts WM_KEYUP for VK 0xa0-0xa5 plus duplicates, and
     WM_KEYUP instead of WM_SYSKEYUP for Alt.
   - `ui_key` swallows only the key-down of a Ctrl+Shift shortcut.
   - `LB_INSERTSTRING(-1)` (`ui.c:319`) returns -1, not the index.
   - `serve()` spins if `accept` fails (EMFILE).
8. **Low: `--settings` writes the registry file** (`settings.c:55`: `open_key` uses
   RegCreateKeyExA). Fix: RegOpenKeyExA for reading.
9. **Low: DirectX version** (`misc.c:69`). FileVersionLS 0x384 means 4.09.00.0900
   (9.0), but STATUS and the comment say 0904 (9.0c, 0x388). Change one of them.
10. **Low: CI `wrapper.yml`.**
    - It has no setup-node (Node 22).
    - The path filter lacks `package.json`.
    - Deleting and then creating the release leaves none if create fails. Use
      `gh release upload --clobber` and a moved tag instead.
    - The zip drops the executable bit (the README says to chmod).
11. **Simplification:**
    - The CP1252 table is in five copies (kernel32, user32, sdl, ui, settings).
    - `ddraw.c fill_vtable` is the same as `dsound.c fill`.
    - The `dsound.c:180` comment says libm is not linked, but `-lm` is, so `powf` would
      do.
    - `user32.c:341 min_max` has a dead `if (!width)`.

## formats

## editor

5. **Smaller:**
   - `save()` (`app.ts:2247`) marks the editor saved before `modJson(asMod())`, which can
     throw.
   - When `keepExe` fails (`app.ts:1374`), later `keepWork` still writes work for the new
     exe, so a reload pairs it with the old exe.
   - `work-store.ts`: no onblocked/onversionchange.
   - `cell-data-field.ts` ~170: "New" opens the text editor even when `set()` refused the
     value.
   - `side-panel.ts`: the resize handle is mouse-only; tabs lack aria-controls and
     aria-labelledby.
   - Escape (`app.ts:2441`) closes the texts view and drops a draft without asking.
   - Not read by the reviewer: record-view, room-view, kits-view, events-view,
     music-view, settings-view, code-view, circuit-view, dealer-view, episode-view,
     tile-types-view, help-dialog, script-view.

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
