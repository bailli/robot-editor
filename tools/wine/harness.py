#!/usr/bin/env python3
"""Run GameOfRobot.exe under Wine on a virtual display and take in-game screenshots.

usage:
  harness.py setup                         create the sandboxed Wine prefix in .wine/
  harness.py shot EPISODE OUT.png [--exe PATH] [--wait SECONDS] [--keep] [--debug DIR] [--keys KEY...]
  harness.py play [EPISODE] [--exe PATH] [--mute]
  harness.py serve [--exe PATH] [--port PORT]

`shot` starts a new game of EPISODE (0 = Junior .. 4 = IV) and saves the game's own
screenshot (Ctrl+Alt+P) of the start room: a 640x348 PNG whose pixel values are the
game's palette indices. --exe runs a different (e.g. patched) copy of the game; --wait
is how long to wait in the room before the screenshot; --keys presses keys (held
briefly; KEY:SECONDS holds one longer or shorter,
wait:SECONDS pauses) before it, with --debug a capture after each; --keep leaves the game running.

What the screenshot shows: the start room with the status line in row 0 and the
actors (hero, robots) wherever they are at that moment; animated tiles may show any
frame. The harness closes the name dialog and the room-name banner first.

`play` runs the game on this display (DISPLAY) to be played, with sound unless --mute,
in a window of its own (a Wine virtual desktop). It presses nothing: choose the episode
in the game (its number is only printed). It ends when the game ends; a game started
by an earlier `play` is ended first. Screenshots and saved games stay in the prefix
until the next `shot`, which deletes them.

`serve` runs the game on a virtual display with the proxy DLL (tools/wine/proxy, built
by `pnpm proxy`) on virtual time and prints "ready PORT DISPLAY TOKEN" once the game
waits in its main loop for the first step; a driver (packages/tools/src/driver.ts) then
connects to 127.0.0.1:PORT, steps the game, presses keys and reads memory. The port is
a free one unless --port is given; the proxy's `hello` names TOKEN, so a game of another
checkout listening on the same port is not taken for this one. It stops when the game
ends, on SIGTERM/SIGINT, or when its stdin is a pipe (a driver's) that closes.

Requires Wine (WineHQ packages install to /opt/wine-stable), Xvfb and xdotool. `shot`
and `serve` run the game silently (Wine's audio drivers are disabled for them).
The prefix is sandboxed: user folders are real directories inside the prefix instead
of links into $HOME, and the Z: drive (the whole filesystem) is removed.
"""
import argparse
import glob
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BASE = os.path.join(ROOT, ".wine")
PREFIX = os.path.join(BASE, "prefix")
GAME_DIR = os.path.join(PREFIX, "drive_c", "robot")
EXE = os.path.join(ROOT, "reference", "GameOfRobot.exe")
WINE_BIN = "/opt/wine-stable/bin"
PROXY = os.path.join(ROOT, "tools", "wine", "proxy", "ddraw.dll")

# Episode buttons on the start screen, in screen coordinates of the 1024x768 Wine virtual
# desktop (which centres the game window).
EPISODE_BUTTONS = {e: (340, 313 + 51 * e) for e in range(5)}


def env(display=None, sound=False, proxy=None):
    e = dict(os.environ)
    if os.path.isdir(WINE_BIN):
        e["PATH"] = WINE_BIN + os.pathsep + e["PATH"]
    # Silent: without audio drivers the game plays neither sounds nor (MIDI) music.
    audio = "" if sound else ";winepulse.drv,winealsa.drv,wineoss.drv=d"
    e.update(WINEPREFIX=PREFIX, WINEDEBUG="-all", WINEDLLOVERRIDES="mscoree,mshtml=" + audio)
    if proxy:  # (port, token): the proxy ddraw.dll next to the exe, see `serve`
        e["WINEDLLOVERRIDES"] += ";ddraw=n,b"
        e["ROBOT_PROXY_PORT"], e["ROBOT_PROXY_TOKEN"] = str(proxy[0]), proxy[1]
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


def stop_process(process):
    """Ends a process we started (if any), killing it when it does not end by itself."""
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def start_xvfb():
    """Xvfb on a free display from :90 on, once it listens: the process and the display.
    Another one taking the display first (between looking and starting) makes ours end,
    and the next display is tried."""
    for n in range(90, 120):
        if os.path.exists(f"/tmp/.X11-unix/X{n}") or os.path.exists(f"/tmp/.X{n}-lock"):
            continue
        xvfb = subprocess.Popen(["Xvfb", f":{n}", "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 10
        while xvfb.poll() is None:
            if os.path.exists(f"/tmp/.X11-unix/X{n}"):
                return xvfb, f":{n}"
            if time.time() > deadline:
                stop_process(xvfb)
                raise RuntimeError("Xvfb did not start")
            time.sleep(0.05)
    raise RuntimeError("no free X display")


def xdo(display, *args):
    return run("xdotool", *args, display=display, capture_output=True, text=True).stdout.strip()


def hold(display, key, seconds):
    """Press a key for a while (the game sees WM_KEYDOWN, then WM_KEYUP)."""
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


def advance(display, window, action, what, tries=3, timeout=4.0, min_change=0.02):
    """Repeat `action` until the window visibly changes (a menu, dialog or banner opens
    or closes): the game drops some key presses and clicks. Small changes like a
    blinking menu highlight do not count. `action` is a key name or a callable."""
    if isinstance(action, str):
        key = action
        action = lambda: hold(display, key, 0.3)  # noqa: E731
    before = grab(display, window)
    for _ in range(tries):
        action()
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.5)
            if changed_fraction(before, grab(display, window)) >= min_change:
                time.sleep(1)  # let the new screen settle
                return
    raise RuntimeError(f"no reaction ({what})")


def click(display, x, y):
    """Press the left button at screen coordinates, held briefly like keys."""
    xdo(display, "mousemove", str(x), str(y))
    xdo(display, "mousedown", "1")
    time.sleep(0.3)
    xdo(display, "mouseup", "1")


def screenshot_dir():
    pattern = os.path.join(PREFIX, "drive_c", "users", "*", "Documents", "Robot")
    return glob.glob(pattern)


def shot(episode, out, exe=EXE, wait=1.0, keep=False, debug=None, keys=()):
    if not os.path.isdir(GAME_DIR):
        sys.exit("run `harness.py setup` first")
    sandbox()
    for d in screenshot_dir():
        shutil.rmtree(d)  # screenshots and saves, also those of games played with `play`
    shutil.copyfile(exe, os.path.join(GAME_DIR, "GameOfRobot.exe"))
    xvfb, display = start_xvfb()
    game = None
    try:
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
        advance(display, window, lambda: click(display, *EPISODE_BUTTONS[episode]),
                f"choose episode {episode}", timeout=6.0)
        capture("title")
        # The game sometimes misses a press here, also in its own menus and dialogs:
        # each step holds Return until the screen reacts.
        # Title screen: Return opens the game menu with "Spielstart" selected, Return
        # starts. (F4, its shortcut, closes the game under Wine.)
        advance(display, window, "Return", "open the title menu")
        advance(display, window, "Return", "start the game")
        # Then Return until nothing reacts: closes the player-name dialog (shown when an
        # episode is started for the first time) and the room-name banner.
        closed = 0
        while closed < 4:
            capture(f"overlay{closed}")
            try:
                advance(display, window, "Return", "close a dialog", tries=2, timeout=3.0)
            except RuntimeError:
                break
            closed += 1
        if closed == 0:  # e.g. a room without a name (debug room 99) on a later start
            print("warning: neither a name dialog nor a room banner appeared", file=sys.stderr)
        time.sleep(wait)
        for key in keys:
            # KEY, KEY:SECONDS (held that long, default 0.3) or wait:SECONDS
            name, _, seconds = key.partition(":")
            if name == "wait":
                time.sleep(float(seconds or 1))
                continue
            hold(display, name, float(seconds or 0.3))
            time.sleep(0.5)
            if debug:
                capture(f"key-{name}")
        capture("room")
        files = []
        for _ in range(3):  # Ctrl+Alt+P: the game's screenshot command; held like all keys
            for key in ("ctrl", "alt", "p"):
                xdo(display, "keydown", key)
            time.sleep(0.3)
            for key in ("p", "alt", "ctrl"):
                xdo(display, "keyup", key)
            deadline = time.time() + 4
            while time.time() < deadline and not files:
                time.sleep(0.5)
                files = [f for d in screenshot_dir() for f in glob.glob(os.path.join(d, "*", "Screenshots", "*.png"))]
            if files:
                break
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
            stop_process(game)
            stop_process(xvfb)


PLAY_DIR = os.path.join(PREFIX, "drive_c", "robot-play")
EPISODE_NAMES = ["Robot Junior", "Robot I", "Robot II", "Robot III", "Robot IV"]


def play(episode=None, exe=EXE, mute=False):
    """Run the game on this display to be played (see the module doc)."""
    if not os.path.isdir(GAME_DIR):
        sys.exit("run `harness.py setup` first")
    if not os.environ.get("DISPLAY"):
        sys.exit("no DISPLAY to show the game on")
    sandbox()
    run("wineserver", "-k", check=False)  # an earlier game (also one of `shot`)
    os.makedirs(PLAY_DIR, exist_ok=True)
    shutil.copyfile(exe, os.path.join(PLAY_DIR, "GameOfRobot.exe"))
    if episode is not None:
        print(f"choose {EPISODE_NAMES[episode]} in the game")
    subprocess.run(["wine", "explorer", "/desktop=robot,1024x768", "C:\\robot-play\\GameOfRobot.exe"],
                   cwd=PLAY_DIR, env=env(sound=not mute), stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=False)


DRIVE_DIR = os.path.join(PREFIX, "drive_c", "robot-drive")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def proxy_ready(port, token):
    """Whether our game's proxy answers on `port` and the game waits for its first step
    (the proxy answers `status` once the game is idle, or an error after 3 s)."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
            f = s.makefile("rw", newline="\n")
            f.write("hello\n")
            f.flush()
            if f.readline().split()[3:] != [token]:  # ok robot-proxy VERSION TOKEN
                return False
            f.write("status\n")
            f.flush()
            return f.readline().startswith("ok ")
    except OSError:
        return False


def serve(exe=EXE, port=None):
    """Run the game with the proxy DLL for a driver (see the module doc)."""
    if not os.path.isdir(GAME_DIR):
        sys.exit("run `harness.py setup` first")
    if not os.path.isfile(PROXY):
        sys.exit("build the proxy first: pnpm proxy")
    sandbox()
    os.makedirs(DRIVE_DIR, exist_ok=True)
    shutil.copyfile(exe, os.path.join(DRIVE_DIR, "GameOfRobot.exe"))
    shutil.copyfile(PROXY, os.path.join(DRIVE_DIR, "ddraw.dll"))
    xvfb = game = None

    def stop(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    mode = os.fstat(sys.stdin.fileno()).st_mode
    if stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode):
        # a driver's pipe: when it closes (the driver ended, also by a crash), so do we
        def watch():
            # os.read, not sys.stdin: a thread blocked in the buffered reader makes Python
            # abort at exit (it cannot take the reader's lock)
            while os.read(0, 4096):
                pass
            os.kill(os.getpid(), signal.SIGTERM)

        threading.Thread(target=watch, daemon=True).start()
    try:
        xvfb, display = start_xvfb()
        port = port or free_port()
        token = os.urandom(8).hex()
        game = subprocess.Popen(["wine", "explorer", "/desktop=robot,1024x768", "C:\\robot-drive\\GameOfRobot.exe"],
                                cwd=DRIVE_DIR, env=env(display, proxy=(port, token)),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 60
        while not proxy_ready(port, token):
            if time.time() > deadline or game.poll() is not None:
                raise RuntimeError(f"the game's proxy did not answer on port {port}")
            time.sleep(0.2)
        print("ready", port, display, token, flush=True)
        game.wait()
    finally:
        # A signal now (the driver ends us as the game ends) must not cut this short.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if game:  # not before: it would end a game of `play` for nothing
            run("wineserver", "-k", check=False)
        stop_process(game)
        stop_process(xvfb)


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
    s.add_argument("--keys", nargs="*", default=[], help="xdotool key names to press before the screenshot: KEY, KEY:SECONDS "
                   "(held that long, default 0.3), wait:SECONDS")
    s = sub.add_parser("play")
    s.add_argument("episode", type=int, choices=range(5), nargs="?")
    s.add_argument("--exe", default=EXE)
    s.add_argument("--mute", action="store_true")
    s = sub.add_parser("serve")
    s.add_argument("--exe", default=EXE)
    s.add_argument("--port", type=int, help="the proxy's port (default: a free one)")
    a = p.parse_args()
    if a.cmd == "setup":
        setup()
    elif a.cmd == "serve":
        serve(os.path.abspath(a.exe), a.port)
    elif a.cmd == "play":
        play(a.episode, os.path.abspath(a.exe), a.mute)
    else:
        shot(a.episode, os.path.abspath(a.out), a.exe, a.wait, a.keep, a.debug, a.keys)


if __name__ == "__main__":
    main()
