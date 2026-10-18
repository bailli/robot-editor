#!/usr/bin/env python3
"""Run GameOfRobot.exe under Wine on a virtual display and take in-game screenshots.

usage:
  harness.py setup                         create the sandboxed Wine prefix in .wine/
  harness.py shot EPISODE OUT.png [--exe PATH] [--wait SECONDS] [--keep] [--debug DIR] [--keys KEY...]

`shot` starts a new game of EPISODE (0 = Junior .. 4 = IV) and saves the game's own
screenshot (Ctrl+Alt+P) of the start room: a 640x348 PNG whose pixel values are the
game's palette indices. --exe runs a different (e.g. patched) copy of the game; --wait
is how long to wait in the room before the screenshot; --keys presses keys (held
briefly, the game polls the keyboard) before it; --keep leaves the game running.

What the screenshot shows: the start room with the status line in row 0 and the
actors (hero, robots) wherever they are at that moment; animated tiles may show any
frame. The harness closes the name dialog and the room-name banner first.

Requires Wine (WineHQ packages install to /opt/wine-stable), Xvfb and xdotool.
The prefix is sandboxed: user folders are real directories inside the prefix instead
of links into $HOME, and the Z: drive (the whole filesystem) is removed.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BASE = os.path.join(ROOT, ".wine")
PREFIX = os.path.join(BASE, "prefix")
GAME_DIR = os.path.join(PREFIX, "drive_c", "robot")
EXE = os.path.join(ROOT, "reference", "GameOfRobot.exe")
WINE_BIN = "/opt/wine-stable/bin"

# Episode buttons on the start screen, relative to the game window (640x454 client).
EPISODE_BUTTONS = {e: (148, 143 + 51 * e) for e in range(5)}


def env(display=None):
    e = dict(os.environ)
    if os.path.isdir(WINE_BIN):
        e["PATH"] = WINE_BIN + os.pathsep + e["PATH"]
    e.update(WINEPREFIX=PREFIX, WINEDEBUG="-all", WINEDLLOVERRIDES="mscoree,mshtml=")
    if display:
        e["DISPLAY"] = display
    return e


def run(*cmd, display=None, check=True, **kw):
    return subprocess.run(cmd, env=env(display), check=check, **kw)


def setup():
    if os.path.isdir(PREFIX):
        print("prefix exists:", PREFIX)
    else:
        os.makedirs(BASE, exist_ok=True)
        run("wineboot", "-i", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run("wineserver", "-w")
    sandbox()
    os.makedirs(GAME_DIR, exist_ok=True)
    print("sandboxed prefix ready:", PREFIX)


def sandbox():
    """Replace links into $HOME by real folders and drop the Z: drive (Wine may recreate them)."""
    for user_dir in glob.glob(os.path.join(PREFIX, "drive_c", "users", "*")):
        for entry in os.listdir(user_dir):
            path = os.path.join(user_dir, entry)
            if os.path.islink(path):
                os.unlink(path)
                os.makedirs(path)
    z = os.path.join(PREFIX, "dosdevices", "z:")
    if os.path.islink(z):
        os.unlink(z)


def free_display():
    for n in range(90, 120):
        if not os.path.exists(f"/tmp/.X11-unix/X{n}") and not os.path.exists(f"/tmp/.X{n}-lock"):
            return f":{n}"
    raise RuntimeError("no free X display")


def xdo(display, *args):
    return run("xdotool", *args, display=display, capture_output=True, text=True).stdout.strip()


def hold(display, key, seconds):
    """Press a key for a while: the game polls the keyboard state (GetAsyncKeyState)."""
    xdo(display, "keydown", key)
    time.sleep(seconds)
    xdo(display, "keyup", key)


def grab(display, window):
    """Raw pixels of the game window (to notice whether an input had an effect)."""
    return run("import", "-window", window, "rgb:-", display=display, capture_output=True).stdout


def changed_fraction(a, b):
    if len(a) != len(b) or not a:
        return 1.0
    return sum(1 for i in range(0, len(a), 3) if a[i:i + 3] != b[i:i + 3]) / (len(a) // 3)


def advance(display, window, key, what, tries=3, timeout=4.0, min_change=0.02):
    """Hold `key` until the window visibly changes (a menu, dialog or banner opens or
    closes); the game drops some key presses. Small changes like a blinking menu
    highlight do not count."""
    before = grab(display, window)
    for _ in range(tries):
        hold(display, key, 0.3)
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.5)
            if changed_fraction(before, grab(display, window)) >= min_change:
                time.sleep(1)  # let the new screen settle
                return
    raise RuntimeError(f"no reaction to {key} ({what})")


def click(display, window, x, y):
    geo = dict(line.split("=") for line in xdo(display, "getwindowgeometry", "--shell", window).splitlines())
    xdo(display, "mousemove", str(int(geo["X"]) + x), str(int(geo["Y"]) + y), "click", "1")


def screenshot_dir():
    pattern = os.path.join(PREFIX, "drive_c", "users", "*", "Documents", "Robot")
    return glob.glob(pattern)


def shot(episode, out, exe=EXE, wait=1.0, keep=False, debug=None, keys=()):
    if not os.path.isdir(GAME_DIR):
        sys.exit("run `harness.py setup` first")
    sandbox()
    for d in screenshot_dir():
        shutil.rmtree(d)  # only screenshots/saves the harness itself produced
    shutil.copyfile(exe, os.path.join(GAME_DIR, "GameOfRobot.exe"))
    display = free_display()
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    game = None
    try:
        time.sleep(1)
        # A Wine virtual desktop activates the game window like Windows would (Xvfb has no
        # window manager).
        game = subprocess.Popen(["wine", "explorer", "/desktop=robot,1024x768", "C:\\robot\\GameOfRobot.exe"],
                                cwd=GAME_DIR, env=env(display), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        step = 0

        def capture(name):
            nonlocal step
            if debug:
                os.makedirs(debug, exist_ok=True)
                step += 1
                run("import", "-window", "root", os.path.join(debug, f"{step:02d}-{name}.png"), display=display)

        window = xdo(display, "search", "--sync", "--name", "The Game of Robot").splitlines()[0]
        time.sleep(3)
        capture("start")
        click(display, window, *EPISODE_BUTTONS[episode])
        time.sleep(3)
        capture("title")
        # The game polls the keyboard, also in its own menus and dialogs, and sometimes
        # drops a press: each step holds Return until the screen reacts.
        # Title screen: Return opens the game menu with "Spielstart" selected, Return
        # starts. (F4, its shortcut, closes the game under Wine.)
        advance(display, window, "Return", "open the title menu")
        advance(display, window, "Return", "start the game")
        capture("name")
        advance(display, window, "Return", "accept the (empty) player name")
        capture("banner")
        advance(display, window, "Return", "close the room-name banner")
        time.sleep(wait)
        for key in keys:
            hold(display, key, 0.3)
            time.sleep(0.5)
        capture("room")
        xdo(display, "key", "ctrl+alt+p")
        deadline = time.time() + 10
        files = []
        while time.time() < deadline and not files:
            time.sleep(0.5)
            files = [f for d in screenshot_dir() for f in glob.glob(os.path.join(d, "*", "Screenshots", "*.png"))]
        capture("after-screenshot")
        if not files:
            raise RuntimeError("the game wrote no screenshot")
        shutil.copyfile(files[0], out)
        print(f"{os.path.basename(files[0])} -> {out}")
        if keep:
            print("game still running on display", display)
            return
    finally:
        if not keep:
            run("wineserver", "-k", check=False)
            if game:
                game.wait(timeout=10)
            xvfb.terminate()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup")
    s = sub.add_parser("shot")
    s.add_argument("episode", type=int, choices=range(5))
    s.add_argument("out")
    s.add_argument("--exe", default=EXE)
    s.add_argument("--wait", type=float, default=1.0)
    s.add_argument("--keep", action="store_true")
    s.add_argument("--debug", metavar="DIR", help="save the whole screen after each step")
    s.add_argument("--keys", nargs="*", default=[], help="xdotool key names to press before the screenshot")
    a = p.parse_args()
    if a.cmd == "setup":
        setup()
    else:
        shot(a.episode, os.path.abspath(a.out), a.exe, a.wait, a.keep, a.debug, a.keys)


if __name__ == "__main__":
    main()
