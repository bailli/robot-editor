/* The driver protocol (`robot --serve`): what tools/wine/proxy/proxy.c does under Wine, for the
   native wrapper, so the TypeScript Driver (packages/tools/src/driver.ts) runs against either.

   A test driver connects to 127.0.0.1:PORT (one line per command, one answer line each, see
   `command`) and puts the game on virtual time:

   - The game's time comes from timeGetTime through 0x4016a0 (the main loop's call at
     0x405bde: elapsed clock units at 147 per second, at most 20 per call, then the game logic
     per unit). That call is redirected to `step`, which waits until the driver grants steps;
     each step advances the virtual clock (`clock_ms`, which timeGetTime, QueryPerformanceCounter,
     GetLocalTime, SetTimer's timers and the message times all read) by `step_ms`.
   - Keys and mouse are posted to the game window as messages. GetAsyncKeyState reports them at
     once; the thread's keyboard state (GetKeyState, accelerators) follows a key message when the
     game takes it from the queue (user32.c's key_taken), as on Windows.
   - Frames: the game presents either with GDI (gdi32.c's StretchDIBits keeps the frame) or with
     DirectDraw (display object method 0x437620, hooked here); both land in frame_pixels.
   - Answers to `run` and reads of the game's state wait until the game is idle: back in `step`
     with no message pending and no step granted, everything the driver posted handled.

   Threads: the game's thread runs the game and `step`; the server thread (`serve`) never calls
   game code: it posts messages (post_message is thread-safe), reads and writes memory, and
   waits for idle. The scheduling state (budget, steps, posted, idle_*) is under `lock`; `wake`
   tells the game's thread something changed, `idle_cv` tells the server thread. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#include "user32.h"
#include "wrapper.h"

#define VERSION 2
#define STEP_CALL 0x405bde /* call 0x4016a0 in the main loop */
#define STEP_TARGET 0x4016a0
#define GAME_TICK 0x51bb38 /* incremented once per clock unit by 0x4016a0 */
#define PRESENT_TARGET 0x437620 /* display object method: present the frame buffer */
#define DD_WIDTH 640            /* its frame buffer (display +0x4c), rows 4-byte aligned */
#define DD_HEIGHT 348           /* of its 400 rows, those presented (0x402365) */
#define STALL_MS 3000           /* `run` gives up when the game takes no step for this long */
#define VK_LBUTTON 1
#define VK_RBUTTON 2
#define VK_SHIFT 0x10
#define VK_CONTROL 0x11

extern BYTE frame_pixels[640 * 480];
extern DWORD frame_colours[256];
extern int frame_width, frame_height;
extern unsigned frame_count;

typedef char(__attribute__((cdecl)) * StepFn)(void *);
typedef HRESULT(__attribute__((thiscall)) * PresentFn)(BYTE *, RECT *);

static int active;
static int want_port;
static int show_window; /* ROBOT_SERVE_WINDOW: a real window to watch */
static int listener = -1;
static char token[17];

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake;    /* steps granted or input posted */
static pthread_cond_t idle_cv; /* the game got idle */ /* both wait on CLOCK_MONOTONIC */
static long budget;                                       /* steps granted, not yet taken */
static DWORD now_ms = 10000;                              /* the virtual clock; written under lock */
static DWORD steps;
static long posted;                  /* messages the driver posted */
static DWORD idle_steps;             /* steps and posted when the game last got idle */
static long idle_posted = -1;
static DWORD step_ms = 7;

/* Injected keys and buttons, as GetAsyncKeyState reports them. */
static volatile BYTE injected[256];
static StepFn original_step = (StepFn)STEP_TARGET;
static PresentFn original_present = (PresentFn)PRESENT_TARGET;

int driver_active(void) { return active; }

DWORD clock_ms(void) {
  if (active) return __atomic_load_n(&now_ms, __ATOMIC_RELAXED);
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (DWORD)((uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000);
}

BOOL driver_async_key(int vk) { return active && injected[vk & 0xff]; }

/* ---- Stepping ---- */

/* Takes one granted step, if any (call with `lock` held). */
static int take_step(void) {
  if (budget <= 0) return 0;
  budget--;
  return 1;
}

static void wait_on(pthread_cond_t *cv, int ms) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  t.tv_sec += ms / 1000;
  t.tv_nsec += (long)(ms % 1000) * 1000000;
  if (t.tv_nsec >= 1000000000) t.tv_sec++, t.tv_nsec -= 1000000000;
  pthread_cond_timedwait(cv, &lock, &t);
}

/* In place of the main loop's call of 0x4016a0: wait for a granted step, then let the game
   run one step of virtual time. Returning 0 (nothing to draw) lets the loop dispatch pending
   messages first. The loop draws after a step and comes back here, so waiting here with no
   message pending is idle: the frame is presented and every message the driver posted before
   is handled. A due timer or a dirty window counts as a pending message (the wrapper's
   PeekMessageA makes WM_TIMER and WM_PAINT); both are gone once the loop handled them, so
   they cannot keep the game from getting idle. */
static char __attribute__((cdecl)) step(void *app) {
  for (;;) {
    pthread_mutex_lock(&lock);
    long seen = posted; /* read before looking: all those messages are queued */
    pthread_mutex_unlock(&lock);
    if (message_pending()) return 0;
    pthread_mutex_lock(&lock);
    if (take_step()) {
      pthread_mutex_unlock(&lock);
      break;
    }
    if (posted == seen) {
      idle_steps = steps;
      idle_posted = seen;
      pthread_cond_broadcast(&idle_cv);
      /* With a real window, SDL's events have no way to wake this: look again every 20 ms. */
      if (show_window)
        wait_on(&wake, 20);
      else
        pthread_cond_wait(&wake, &lock);
    }
    pthread_mutex_unlock(&lock);
  }
  pthread_mutex_lock(&lock);
  __atomic_store_n(&now_ms, now_ms + step_ms, __ATOMIC_RELAXED);
  steps++;
  pthread_mutex_unlock(&lock);
  return original_step(app);
}

long driver_posted(void) {
  pthread_mutex_lock(&lock);
  long seen = posted;
  pthread_mutex_unlock(&lock);
  return seen;
}

/* GetMessageA found nothing to take: the game waits for a message outside `step`, e.g. for
   its 200 ms timer while 0x4c5d80 counts back up after a change of the display mode
   (0x403c23); on Windows time passes meanwhile. A granted step advances the virtual clock
   without running the game (its timers come due); with none granted the game is idle, as in
   `step`. `seen`: the messages posted before GetMessageA looked (driver_posted). */
void driver_wait_message(long seen) {
  pthread_mutex_lock(&lock);
  if (take_step()) {
    __atomic_store_n(&now_ms, now_ms + step_ms, __ATOMIC_RELAXED);
    steps++;
  } else if (posted == seen) {
    idle_steps = steps;
    idle_posted = seen;
    pthread_cond_broadcast(&idle_cv);
    if (show_window)
      wait_on(&wake, 20);
    else
      pthread_cond_wait(&wake, &lock);
  }
  pthread_mutex_unlock(&lock);
}

/* Waits until the game is idle after `target` steps (and everything posted so far); false once
   it takes no step for STALL_MS (a long run that keeps stepping is no stall). */
static int settle(DWORD target) {
  pthread_mutex_lock(&lock);
  DWORD seen = steps;
  while (!((int32_t)(steps - target) >= 0 && idle_steps == steps && idle_posted == posted)) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    t.tv_sec += STALL_MS / 1000;
    if (pthread_cond_timedwait(&idle_cv, &lock, &t) != ETIMEDOUT) continue;
    if (steps == seen) {
      pthread_mutex_unlock(&lock);
      return 0;
    }
    seen = steps;
  }
  pthread_mutex_unlock(&lock);
  return 1;
}

/* ---- Frames ---- */

/* DirectDraw: in place of the calls of the display object's present method. */
static HRESULT __attribute__((thiscall)) present(BYTE *display, RECT *rect) {
  HRESULT result = original_present(display, rect);
  BYTE *buffer = *(BYTE **)(display + 0x4c);
  DWORD bytes_per_pixel = *(DWORD *)(display + 0x1f8);
  if (buffer && bytes_per_pixel > 1) { /* an 8-bit screen has no buffer of its own */
    if (bytes_per_pixel == 4) memcpy(frame_colours, display + 0x204, sizeof frame_colours);
    memcpy(frame_pixels, buffer, (size_t)DD_WIDTH * DD_HEIGHT);
    frame_width = DD_WIDTH;
    frame_height = DD_HEIGHT;
    frame_count++;
  }
  return result;
}

/* The call instruction (e8 rel32) at `at` to `target`, or NULL. */
static BYTE *call_at(DWORD at, DWORD target) {
  BYTE *call = (BYTE *)(uintptr_t)at;
  int32_t rel = (int32_t)(target - (at + 5));
  return call[0] == 0xe8 && !memcmp(call + 1, &rel, 4) ? call : NULL;
}

static void redirect_call(BYTE *call, void *hook) {
  int32_t rel = (int32_t)((BYTE *)hook - (call + 5)); /* the image is mapped read-write-exec */
  memcpy(call + 1, &rel, 4);
}

/* ---- Commands from the driver ---- */

static void post(HWND window, UINT msg, WPARAM wparam, LPARAM lparam) {
  post_message(window, msg, wparam, lparam);
  pthread_mutex_lock(&lock);
  posted++;
  pthread_cond_signal(&wake);
  pthread_mutex_unlock(&lock);
}

/* Set-1 scan codes of the keys the tests use (0: none known). */
static unsigned scan_code(unsigned vk) {
  static const unsigned char top[] = {0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
                                      0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c};
  if (vk >= 'A' && vk <= 'Z') return top[vk - 'A'];
  if (vk >= '1' && vk <= '9') return 2 + vk - '1';
  if (vk == '0') return 0x0b;
  if (vk >= 0x70 && vk <= 0x79) return 0x3b + vk - 0x70; /* F1-F10 */
  if (vk == 0x7a) return 0x57;
  if (vk == 0x7b) return 0x58;
  if (vk >= 0x60 && vk <= 0x69) { /* keypad 0-9 */
    static const unsigned char pad[] = {0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49};
    return pad[vk - 0x60];
  }
  switch (vk) {
  case 0x08: return 0x0e; /* back */
  case 0x09: return 0x0f; /* tab */
  case 0x0d: return 0x1c; /* return */
  case 0x10: return 0x2a; /* shift */
  case 0x11: return 0x1d; /* control */
  case 0x12: return 0x38; /* menu (alt) */
  case 0x1b: return 0x01; /* escape */
  case 0x20: return 0x39; /* space */
  case 0x21: return 0x49; /* prior */
  case 0x22: return 0x51; /* next */
  case 0x23: return 0x4f; /* end */
  case 0x24: return 0x47; /* home */
  case 0x25: return 0x4b; /* left */
  case 0x26: return 0x48; /* up */
  case 0x27: return 0x4d; /* right */
  case 0x28: return 0x50; /* down */
  case 0x2d: return 0x52; /* insert */
  case 0x2e: return 0x53; /* delete */
  case 0xbb: return 0x0d; /* = */
  case 0xbc: return 0x33; /* , */
  case 0xbd: return 0x0c; /* - */
  case 0xbe: return 0x34; /* . */
  }
  return 0;
}

static LPARAM key_lparam(unsigned vk, int up) {
  int extended = (vk >= 0x21 && vk <= 0x28) || vk == 0x2d || vk == 0x2e;
  return 1 | (LPARAM)scan_code(vk) << 16 | (LPARAM)extended << 24 | (up ? (LPARAM)0xc0000000 : 0);
}

static WPARAM mouse_buttons(void) {
  return (injected[VK_LBUTTON] ? MK_LBUTTON : 0) | (injected[VK_RBUTTON] ? MK_RBUTTON : 0) |
         (injected[VK_SHIFT] ? MK_SHIFT : 0) | (injected[VK_CONTROL] ? MK_CONTROL : 0);
}

static int status(char *out, size_t size, const char *word) {
  pthread_mutex_lock(&lock);
  int n = snprintf(out, size, "%s tick=%u ms=%u steps=%u frames=%u", word, *(volatile DWORD *)GAME_TICK, now_ms,
                   steps, frame_count);
  pthread_mutex_unlock(&lock);
  return n;
}

static int hex_bytes(char *out, size_t size, const BYTE *bytes, size_t len) {
  static const char digits[] = "0123456789abcdef";
  size_t n = 0;
  for (size_t i = 0; i < len && n + 2 < size; i++) {
    out[n++] = digits[bytes[i] >> 4];
    out[n++] = digits[bytes[i] & 15];
  }
  out[n] = 0;
  return (int)n;
}

static int hex(char c) {
  return c >= '0' && c <= '9'   ? c - '0'
         : c >= 'a' && c <= 'f' ? c - 'a' + 10
         : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                : -1;
}

/* "up" -> 1, "down" -> 0, anything else -> -1. */
static int up_or_down(const char *word) { return !strcmp(word, "up") ? 1 : !strcmp(word, "down") ? 0 : -1; }

/* Our own memory, without crashing on a bad address: the kernel refuses what is not mapped
   (or, for writes, not writable) with an error instead of a fault. */
static int memory_read(const void *at, void *to, size_t len) {
  struct iovec local = {to, len}, remote = {(void *)at, len};
  return process_vm_readv(getpid(), &local, 1, &remote, 1, 0) == (ssize_t)len;
}

static int memory_write(void *at, const void *from, size_t len) {
  struct iovec local = {(void *)from, len}, remote = {at, len};
  return process_vm_writev(getpid(), &local, 1, &remote, 1, 0) == (ssize_t)len;
}

/* A virtual-key code given in decimal, 1-254; 0 if it is none (not cut to a byte). */
static UINT virtual_key(const char *text) {
  char *end;
  unsigned long vk = strtoul(text, &end, 10);
  return *text && !*end && vk >= 1 && vk <= 254 ? (UINT)vk : 0;
}

/* One command line -> one answer line ("ok ..." or "error ..."). Commands:
     hello TOKEN                      ok robot-proxy VERSION (first, see `serve`)
     status                           ok tick=... ms=... steps=... frames=... (frames presented)
     run N                            N steps; "stalled ... left=K" if the game stops stepping
     stepms MS                        virtual milliseconds per step (default 7)
     key VK down|up                   a key (Windows virtual-key code, decimal)
     mouse X Y                        move the mouse (client coordinates)
     button left|right down|up
     peek ADDR LEN                    ok HEX (ADDR in hex)
     poke ADDR HEX
     frame                            ok WIDTH HEIGHT FRAMES HEX: the last frame presented,
                                      palette indices row by row, top row first
     palette                          ok HEX: the 256 colours the frame was presented with,
                                      00RRGGBB each as 8 hex digits
   Everything but key, mouse and button first waits until the game is idle. */
static void command(char *line, char *out, size_t size) {
  char word[16] = "", arg1[32] = "", arg2[4096] = "";
  int at1 = 0, at2 = 0;
  sscanf(line, " %*s %n%*s %n", &at1, &at2);
  sscanf(line, "%15s %31s %4095s", word, arg1, arg2);
  /* longer words were cut by sscanf: refused rather than taken shortened */
  if (strcspn(line + strspn(line, " \t"), " \t") >= sizeof word ||
      (at1 && strcspn(line + at1, " \t") >= sizeof arg1) || (at2 && strcspn(line + at2, " \t") >= sizeof arg2)) {
    snprintf(out, size, "error a word of the command is too long");
    return;
  }
  int input = !strcmp(word, "key") || !strcmp(word, "mouse") || !strcmp(word, "button");
  HWND window = main_window();
  char *rest;
  if (!strcmp(word, "hello")) {
    snprintf(out, size, "ok robot-proxy %d", VERSION);
  } else if (!strcmp(word, "run")) {
    long n = strtol(arg1, &rest, 10);
    if (n <= 0 || *rest) {
      snprintf(out, size, "error run needs a positive number of steps");
      return;
    }
    pthread_mutex_lock(&lock);
    DWORD target = steps + (DWORD)n;
    budget += n;
    pthread_cond_signal(&wake);
    pthread_mutex_unlock(&lock);
    if (!settle(target)) {
      pthread_mutex_lock(&lock);
      long left = budget;
      budget = 0;
      pthread_mutex_unlock(&lock);
      int len = status(out, size, "stalled");
      snprintf(out + len, size - (size_t)len, " left=%ld", left);
      return;
    }
    status(out, size, "ok");
  } else if (!input && !settle(steps)) {
    status(out, size, "error the game is not idle:");
  } else if (!strcmp(word, "status")) {
    status(out, size, "ok");
  } else if (!strcmp(word, "frame") || !strcmp(word, "palette")) {
    if (!frame_count) {
      snprintf(out, size, "error no frame presented yet");
    } else if (word[0] == 'f') {
      int n = snprintf(out, size, "ok %d %d %u ", frame_width, frame_height, frame_count);
      hex_bytes(out + n, size - (size_t)n, frame_pixels, (size_t)frame_width * (size_t)frame_height);
    } else {
      int n = snprintf(out, size, "ok ");
      for (int i = 0; i < 256; i++) n += snprintf(out + n, size - (size_t)n, "%08x", frame_colours[i]);
    }
  } else if (!strcmp(word, "stepms")) {
    unsigned long ms = strtoul(arg1, &rest, 10);
    if (ms == 0 || *rest || ms > 1000) {
      snprintf(out, size, "error stepms needs 1 to 1000 milliseconds");
      return;
    }
    pthread_mutex_lock(&lock);
    step_ms = (DWORD)ms;
    pthread_mutex_unlock(&lock);
    snprintf(out, size, "ok");
  } else if (!window) {
    snprintf(out, size, "error no game window yet");
  } else if ((!strcmp(word, "key") || !strcmp(word, "button")) && up_or_down(arg2) < 0) {
    snprintf(out, size, "error %s needs down or up", word);
  } else if (!strcmp(word, "key") && !virtual_key(arg1)) {
    snprintf(out, size, "error key needs a virtual-key code 1-254");
  } else if (!strcmp(word, "button") && strcmp(arg1, "left") && strcmp(arg1, "right")) {
    snprintf(out, size, "error button needs left or right");
  } else if (!strcmp(word, "key")) {
    UINT vk = virtual_key(arg1);
    int up = up_or_down(arg2);
    injected[vk] = !up;
    post(window, up ? WM_KEYUP : WM_KEYDOWN, vk, key_lparam(vk, up));
    snprintf(out, size, "ok");
  } else if (!strcmp(word, "mouse")) {
    mouse_client.x = atol(arg1); /* client coordinates, as the proxy takes them */
    mouse_client.y = atol(arg2);
    post(window, WM_MOUSEMOVE, mouse_buttons(), (LPARAM)((mouse_client.y & 0xffff) << 16 | (mouse_client.x & 0xffff)));
    snprintf(out, size, "ok");
  } else if (!strcmp(word, "button")) {
    int left = !strcmp(arg1, "left"), up = up_or_down(arg2);
    injected[left ? VK_LBUTTON : VK_RBUTTON] = !up;
    UINT msg = left ? (up ? WM_LBUTTONUP : WM_LBUTTONDOWN) : (up ? WM_RBUTTONUP : WM_RBUTTONDOWN);
    post(window, msg, mouse_buttons(), (LPARAM)((mouse_client.y & 0xffff) << 16 | (mouse_client.x & 0xffff)));
    snprintf(out, size, "ok");
  } else if (!strcmp(word, "peek")) {
    BYTE *at = (BYTE *)(uintptr_t)strtoul(arg1, NULL, 16);
    size_t len = strtoul(arg2, &rest, 10);
    if (len == 0 || *rest || len > (size - 4) / 2) {
      snprintf(out, size, "error peek reads 1 to %u bytes", (unsigned)((size - 4) / 2));
      return;
    }
    BYTE *buffer = malloc(len);
    if (!buffer || !memory_read(at, buffer, len)) {
      snprintf(out, size, "error cannot read %p", (void *)at);
    } else {
      hex_bytes(out + snprintf(out, size, "ok "), size - 3, buffer, len);
    }
    free(buffer);
  } else if (!strcmp(word, "poke")) {
    BYTE *at = (BYTE *)(uintptr_t)strtoul(arg1, NULL, 16);
    size_t digits = strlen(arg2), len = digits / 2;
    BYTE bytes[sizeof arg2 / 2];
    int valid = digits > 0 && digits % 2 == 0;
    for (size_t i = 0; valid && i < len; i++) {
      int high = hex(arg2[2 * i]), low = hex(arg2[2 * i + 1]);
      valid = high >= 0 && low >= 0;
      bytes[i] = (BYTE)(high << 4 | low);
    }
    if (!valid) {
      snprintf(out, size, "error poke needs bytes as hex digits");
    } else {
      snprintf(out, size, memory_write(at, bytes, len) ? "ok" : "error cannot write %p", (void *)at);
    }
  } else {
    snprintf(out, size, "error unknown command %s", word);
  }
}

/* ---- The server ---- */

static void send_all(int to, const char *text) {
  for (size_t sent = 0, len = strlen(text); sent < len;) {
    ssize_t n = send(to, text + sent, len - sent, MSG_NOSIGNAL);
    if (n <= 0) break;
    sent += (size_t)n;
  }
}

/* Whether the peer closed `s` (it is readable with nothing to read). */
static int peer_closed(int s) {
  struct pollfd p = {s, POLLIN, 0};
  char c;
  return poll(&p, 1, 0) > 0 && recv(s, &c, 1, MSG_PEEK | MSG_DONTWAIT) <= 0;
}

static void *serve(void *unused) {
  (void)unused;
  /* One driver at a time; another connection gets "error busy" at once instead of waiting
     unanswered, unless the one before has gone (e.g. a probe, which closes just before the
     driver connects). */
  static char line[8192], answer[1 << 20];
  int client = -1;
  size_t used = 0;
  int overlong = 0; /* dropping a line too long for `line`, up to its end */
  int authed = 0;   /* the client said `hello TOKEN` */
  for (;;) {
    struct pollfd fds[2] = {{listener, POLLIN, 0}, {client, POLLIN, 0}};
    if (poll(fds, client >= 0 ? 2 : 1, -1) <= 0) {
      usleep(10000); /* an error: not spinning on it */
      continue;
    }
    if (fds[0].revents) {
      int other = accept(listener, NULL, NULL);
      trace("driver: connection %d", other);
      if (other < 0) usleep(10000); /* e.g. out of descriptors: not spinning on it */
      if (client >= 0 && other >= 0 && (!authed || peer_closed(client))) {
        close(client);
        client = -1;
      }
      if (client < 0) {
        client = other;
        used = 0;
        overlong = 0;
        authed = 0;
      } else if (other >= 0) {
        send_all(other, "error busy: another driver is connected\n");
        close(other);
      }
    }
    if (client < 0 || !fds[1].revents) continue;
    ssize_t got = recv(client, line + used, sizeof line - 1 - used, 0);
    if (got <= 0) {
      close(client);
      client = -1;
      continue;
    }
    used += (size_t)got;
    line[used] = 0;
    char *end;
    while ((end = memchr(line, '\n', used))) {
      *end = 0;
      if (end > line && end[-1] == '\r') end[-1] = 0;
      if (overlong) {
        send_all(client, "error the command line is too long\n");
        overlong = 0;
      } else if (!authed) {
        /* the first command proves the driver started this game (it read TOKEN from our
           output): anyone else on this machine is dropped before reading or writing it */
        char word[16] = "", given[64] = "";
        sscanf(line, "%15s %63s", word, given);
        if (strcmp(word, "hello") || strcmp(given, token)) {
          send_all(client, "error hello TOKEN first\n");
          close(client);
          client = -1;
          used = 0;
          break;
        }
        authed = 1;
        snprintf(answer, sizeof answer, "ok robot-proxy %d\n", VERSION);
        send_all(client, answer);
      } else {
        command(line, answer, sizeof answer - 2);
        strcat(answer, "\n");
        send_all(client, answer);
      }
      used -= (size_t)(end + 1 - line);
      memmove(line, end + 1, used + 1);
    }
    if (used == sizeof line - 1) {
      used = 0; /* no line end in the whole buffer: the rest of this line goes too */
      overlong = 1;
    }
  }
  return NULL;
}

/* The driver went away when stdin (a pipe or socket) reaches its end: so does the game. */
static void *watch_stdin(void *unused) {
  (void)unused;
  char buffer[256];
  for (;;) {
    ssize_t n = read(0, buffer, sizeof buffer);
    if (n == 0) {
      trace("driver: stdin closed, exiting");
      _exit(0);
    }
    if (n < 0 && errno != EINTR) return NULL;
  }
}

/* ---- Start ---- */

void driver_enable(int port) {
  active = 1;
  pthread_condattr_t attr;
  pthread_condattr_init(&attr);
  pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
  pthread_cond_init(&wake, &attr);
  pthread_cond_init(&idle_cv, &attr);
  want_port = port;
  show_window = getenv("ROBOT_SERVE_WINDOW") != NULL;
  if (!show_window) setenv("SDL_VIDEODRIVER", "dummy", 1);
}

void driver_start(void) {
  static const DWORD present_calls[] = {0x402379, 0x437270};
  BYTE *step_call = call_at(STEP_CALL, STEP_TARGET);
  BYTE *present_call[2] = {call_at(present_calls[0], PRESENT_TARGET), call_at(present_calls[1], PRESENT_TARGET)};
  if (!step_call || !present_call[0] || !present_call[1]) fatal("--serve: this is not the exe the driver knows");
  redirect_call(step_call, step);
  for (int i = 0; i < 2; i++) redirect_call(present_call[i], present);

  unsigned char random[8];
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd < 0 || read(fd, random, sizeof random) != (ssize_t)sizeof random) fatal("--serve: no random token");
  close(fd);
  for (int i = 0; i < 8; i++) snprintf(token + 2 * i, 3, "%02x", random[i]);

  listener = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)want_port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t length = sizeof address;
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 1) ||
      getsockname(listener, (struct sockaddr *)&address, &length))
    fatal("--serve: cannot listen on 127.0.0.1:%d: %s", want_port, strerror(errno));

  pthread_t thread;
  if (pthread_create(&thread, NULL, serve, NULL)) fatal("--serve: cannot start the server thread");
  pthread_detach(thread);
  struct stat st;
  if (fstat(0, &st) == 0 && (S_ISFIFO(st.st_mode) || S_ISSOCK(st.st_mode))) {
    if (pthread_create(&thread, NULL, watch_stdin, NULL)) fatal("--serve: cannot start the stdin watcher");
    pthread_detach(thread);
  }
  printf("ready %d - %s\n", ntohs(address.sin_port), token);
  fflush(stdout);
  trace("driver: serving on port %d", ntohs(address.sin_port));
}
