/*
 * ddraw.dll proxy for GameOfRobot.exe: lets a test driver run the game step by step.
 *
 * Placed next to the exe and loaded instead of the system ddraw.dll (Wine:
 * WINEDLLOVERRIDES=ddraw=n,b), it forwards DirectDrawCreate to the real one. Without
 * ROBOT_PROXY_PORT in the environment it does nothing else. With it, it listens on
 * 127.0.0.1:PORT for a driver (one line per command, one line per answer, see
 * `command`) and puts the game on virtual time:
 *
 * - All game time comes from timeGetTime through 0x4016a0 (the main loop's call at
 *   0x405bde: elapsed clock units at 147 per second, at most 20 per call, then the
 *   game logic per unit). The call is redirected to `step`, which waits until the
 *   driver grants steps; each step advances the virtual clock by `step_ms`.
 * - timeGetTime, QueryPerformanceCounter and GetLocalTime return virtual time,
 *   SetTimer's timers (the window's 0x1234) fire on it.
 * - Keys and mouse are posted to the game window as messages (the window procedure
 *   reads keys only from WM_KEYDOWN/WM_KEYUP); GetAsyncKeyState and GetCursorPos
 *   report the injected state. Like Windows, the thread's keyboard state follows a key
 *   message when the game takes it from the queue (GetMessageA): GetKeyState and
 *   TranslateAccelerator, for the game's shortcuts (Ctrl+Alt+P, its screenshot, and
 *   the Alt+letter commands), see the keys as of that message.
 * - Frames: the game draws into its own buffer of palette indices and presents it in
 *   one of two ways (there is no Flip, the game runs in a window). With GDI (what it
 *   does under Wine) the window's WM_PAINT draws it with StretchDIBits (0x402220:
 *   640 × 348, the colours indices into the selected palette); with DirectDraw the
 *   display object's method 0x437620 converts the buffer (+0x4c, 640 × 400) through
 *   its colour table (+0x204) into a surface and blits that to the screen. Both are
 *   hooked: each present copies the frame and its colours (`capture`).
 *
 * Messages posted while the game waits are dispatched before the next step, so a
 * run is the same every time. Answers to `run` and reads of the game's state wait
 * until the game is idle: back in `step` after drawing, every posted message handled.
 */
#include <winsock2.h>
#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define VERSION 1
#define STEP_CALL 0x405bde /* call 0x4016a0 in the main loop */
#define STEP_TARGET 0x4016a0
#define GAME_TICK 0x51bb38 /* incremented once per clock unit by 0x4016a0 */
#define PRESENT_CALLS {0x402379, 0x437270}
#define PRESENT_TARGET 0x437620 /* display object method: present the frame buffer */
#define DD_WIDTH 640            /* its frame buffer (display +0x4c), rows 4-byte aligned */
#define DD_HEIGHT 400
#define MAX_FRAME (640 * 400)
#define STALL_MS 3000 /* `run` gives up when the game does not get idle for this long */

typedef char(__cdecl *StepFn)(void *);
typedef HRESULT(__attribute__((thiscall)) * PresentFn)(BYTE *, RECT *);

static StepFn original_step;
static PresentFn original_present;
static UINT(WINAPI *real_SetTimer)(HWND, UINT_PTR, UINT, TIMERPROC);
static int(WINAPI *real_StretchDIBits)(HDC, int, int, int, int, int, int, int, int, const void *,
                                       const BITMAPINFO *, UINT, DWORD);

static CRITICAL_SECTION lock;
static HANDLE wake; /* steps granted or input posted */
static HANDLE idle; /* the game got idle */
static volatile LONG budget;
static volatile DWORD now_ms = 10000;
static volatile DWORD steps;
static volatile LONG posted;      /* messages the driver posted */
static volatile DWORD idle_steps; /* steps and posted when the game last got idle */
static volatile LONG idle_posted = -1;
static DWORD step_ms = 7;

/* The last frame presented: palette indices, top row first, and the colours they had. */
static BYTE frame[MAX_FRAME];
static int frame_width, frame_height;
static DWORD frame_colours[256]; /* 0x00RRGGBB */
static volatile DWORD presents;
static DWORD game_thread;
static HWND window;

static FILE *log_file; /* ROBOT_PROXY_LOG: a file for debugging the proxy */

static void say(const char *format, ...) {
  if (!log_file) return;
  va_list args;
  va_start(args, format);
  vfprintf(log_file, format, args);
  va_end(args);
  fputc('\n', log_file);
  fflush(log_file);
}

static BOOL keys[256]; /* injected keys and buttons, as GetAsyncKeyState reports them */
static POINT cursor;   /* client coordinates */
static BOOL(WINAPI *real_GetMessageA)(MSG *, HWND, UINT, UINT);

#define MAX_TIMERS 8
static struct {
  HWND hwnd;
  UINT_PTR id;
  UINT interval;
  DWORD due;
  TIMERPROC proc;
} timers[MAX_TIMERS];
static int timer_count;

/* ---- virtual time and input as the game sees it ---- */

static DWORD WINAPI hook_timeGetTime(void) { return now_ms; }

static BOOL WINAPI hook_QueryPerformanceCounter(LARGE_INTEGER *count) {
  LARGE_INTEGER frequency;
  QueryPerformanceFrequency(&frequency);
  count->QuadPart = (LONGLONG)now_ms * frequency.QuadPart / 1000;
  return TRUE;
}

static void WINAPI hook_GetLocalTime(SYSTEMTIME *time) {
  DWORD s = now_ms / 1000;
  SYSTEMTIME fixed = {2026, 1, 4, 1, (WORD)(s / 3600 % 24), (WORD)(s / 60 % 60), (WORD)(s % 60),
                      (WORD)(now_ms % 1000)};
  *time = fixed;
}

static SHORT WINAPI hook_GetAsyncKeyState(int vk) { return keys[vk & 0xff] ? (SHORT)0x8000 : 0; }

/* A key message taken from the queue sets its key in the thread's keyboard state (the
 * left variant of Shift, Ctrl and Alt too), as Windows does for real input. */
static BOOL WINAPI hook_GetMessageA(MSG *msg, HWND hwnd, UINT first, UINT last) {
  BOOL result = real_GetMessageA(msg, hwnd, first, last);
  UINT m = msg->message;
  if (result > 0 && m >= WM_KEYDOWN && m <= WM_SYSKEYUP && m != WM_CHAR && m != WM_SYSCHAR) {
    BYTE state[256];
    GetKeyboardState(state);
    BYTE down = m == WM_KEYDOWN || m == WM_SYSKEYDOWN ? 0x80 : 0;
    UINT vk = msg->wParam & 0xff;
    state[vk] = down;
    if (vk >= VK_SHIFT && vk <= VK_MENU) state[VK_LSHIFT + 2 * (vk - VK_SHIFT)] = down;
    SetKeyboardState(state);
  }
  return result;
}

static BOOL WINAPI hook_GetCursorPos(POINT *point) {
  *point = cursor;
  if (window) ClientToScreen(window, point);
  return TRUE;
}

static UINT_PTR WINAPI hook_SetTimer(HWND hwnd, UINT_PTR id, UINT interval, TIMERPROC proc) {
  if (!hwnd) return real_SetTimer(hwnd, id, interval, proc);
  EnterCriticalSection(&lock);
  int i = 0;
  while (i < timer_count && !(timers[i].hwnd == hwnd && timers[i].id == id)) i++;
  if (i == MAX_TIMERS) {
    LeaveCriticalSection(&lock);
    return 0;
  }
  if (i == timer_count) timer_count++;
  timers[i].hwnd = hwnd;
  timers[i].id = id;
  timers[i].interval = interval ? interval : 1;
  timers[i].due = now_ms + timers[i].interval;
  timers[i].proc = proc;
  LeaveCriticalSection(&lock);
  return id;
}

/* Due timers post one WM_TIMER each (Windows does not queue more than one either). */
static void fire_timers(void) {
  EnterCriticalSection(&lock);
  for (int i = 0; i < timer_count; i++) {
    if ((LONG)(now_ms - timers[i].due) < 0) continue;
    PostMessageA(timers[i].hwnd, WM_TIMER, timers[i].id, (LPARAM)timers[i].proc);
    while ((LONG)(now_ms - timers[i].due) >= 0) timers[i].due += timers[i].interval;
  }
  LeaveCriticalSection(&lock);
}

static BOOL CALLBACK pick_window(HWND hwnd, LPARAM unused) {
  (void)unused;
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
  window = hwnd;
  return FALSE;
}

/* In place of the main loop's call of 0x4016a0: wait for a granted step, then let the
 * game run one step of virtual time. Returning 0 (nothing to draw) lets the loop
 * dispatch pending messages first. The main loop draws after a step and comes back
 * here, so waiting here with no message pending is idle: the frame is presented and
 * every message the driver posted before is handled. */
static char __cdecl step(void *app) {
  if (!game_thread) {
    game_thread = GetCurrentThreadId();
    say("step: first call");
  }
  if (!window || !IsWindow(window)) {
    window = NULL;
    EnumThreadWindows(game_thread, pick_window, 0);
  }
  for (;;) {
    LONG seen = posted; /* read before looking: all those messages are queued */
    MSG msg;
    if (PeekMessageA(&msg, NULL, 0, 0, PM_NOREMOVE)) return 0;
    if (budget > 0) break;
    idle_steps = steps;
    idle_posted = seen;
    SetEvent(idle);
    MsgWaitForMultipleObjects(1, &wake, FALSE, INFINITE, QS_ALLINPUT);
  }
  InterlockedDecrement(&budget);
  now_ms += step_ms;
  steps++;
  fire_timers();
  return original_step(app);
}

/* Waits until the game is idle after `steps` steps (and everything posted so far). */
static BOOL settle(DWORD target) {
  while (!((LONG)(steps - target) >= 0 && idle_steps == steps && idle_posted == posted)) {
    if (WaitForSingleObject(idle, STALL_MS) == WAIT_TIMEOUT) return FALSE;
  }
  return TRUE;
}

/* Copies a presented frame of 8-bit indices (rows `stride` bytes apart; bottom-up when
 * `bottom_up`, like a DIB with a positive height). */
static void capture(const BYTE *bits, int width, int height, int stride, BOOL bottom_up) {
  if (width <= 0 || height <= 0 || width * height > MAX_FRAME) return;
  for (int y = 0; y < height; y++) {
    const BYTE *row = bits + (size_t)(bottom_up ? height - 1 - y : y) * stride;
    memcpy(frame + (size_t)y * width, row, width);
  }
  frame_width = width;
  frame_height = height;
  presents++;
}

/* GDI: the game's WM_PAINT draws its frame buffer as an 8-bit DIB. */
static int WINAPI hook_StretchDIBits(HDC dc, int x, int y, int width, int height, int src_x, int src_y,
                                     int src_width, int src_height, const void *bits, const BITMAPINFO *info,
                                     UINT usage, DWORD rop) {
  const BITMAPINFOHEADER *h = &info->bmiHeader;
  if (h->biBitCount == 8 && h->biCompression == BI_RGB) {
    PALETTEENTRY entries[256] = {{0}};
    if (usage == DIB_PAL_COLORS) GetPaletteEntries(GetCurrentObject(dc, OBJ_PAL), 0, 256, entries);
    for (int i = 0; i < 256; i++) {
      if (usage == DIB_PAL_COLORS) {
        PALETTEENTRY e = entries[((const WORD *)info->bmiColors)[i] & 0xff];
        frame_colours[i] = (DWORD)e.peRed << 16 | (DWORD)e.peGreen << 8 | e.peBlue;
      } else {
        RGBQUAD q = info->bmiColors[i];
        frame_colours[i] = (DWORD)q.rgbRed << 16 | (DWORD)q.rgbGreen << 8 | q.rgbBlue;
      }
    }
    int rows = h->biHeight < 0 ? -h->biHeight : h->biHeight;
    capture(bits, h->biWidth, rows, (h->biWidth + 3) & ~3, h->biHeight > 0);
  }
  return real_StretchDIBits(dc, x, y, width, height, src_x, src_y, src_width, src_height, bits, info, usage,
                            rop);
}

/* DirectDraw: in place of the calls of the display object's present method. */
static HRESULT __attribute__((thiscall)) present(BYTE *display, RECT *rect) {
  HRESULT result = original_present(display, rect);
  BYTE *buffer = *(BYTE **)(display + 0x4c);
  DWORD bytes_per_pixel = *(DWORD *)(display + 0x1f8);
  if (buffer && bytes_per_pixel > 1) { /* an 8-bit screen has no buffer of its own */
    if (bytes_per_pixel == 4) memcpy(frame_colours, display + 0x204, sizeof frame_colours);
    capture(buffer, DD_WIDTH, DD_HEIGHT, DD_WIDTH, FALSE);
  }
  return result;
}

/* ---- patching the exe in memory ---- */

static BOOL write_code(void *at, const void *bytes, size_t size) {
  DWORD old;
  if (!VirtualProtect(at, size, PAGE_EXECUTE_READWRITE, &old)) return FALSE;
  memcpy(at, bytes, size);
  VirtualProtect(at, size, old, &old);
  FlushInstructionCache(GetCurrentProcess(), at, size);
  return TRUE;
}

/* Replaces the exe's import of `name` (from any DLL) by `hook`; returns the original. */
static void *hook_import(const char *name, void *hook) {
  BYTE *base = (BYTE *)GetModuleHandleA(NULL);
  IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + ((IMAGE_DOS_HEADER *)base)->e_lfanew);
  IMAGE_DATA_DIRECTORY dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
  for (IMAGE_IMPORT_DESCRIPTOR *d = (void *)(base + dir.VirtualAddress); d->Name; d++) {
    IMAGE_THUNK_DATA *names = (void *)(base + (d->OriginalFirstThunk ? d->OriginalFirstThunk : d->FirstThunk));
    IMAGE_THUNK_DATA *slots = (void *)(base + d->FirstThunk);
    for (; names->u1.AddressOfData; names++, slots++) {
      if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
      IMAGE_IMPORT_BY_NAME *import = (void *)(base + names->u1.AddressOfData);
      if (strcmp((char *)import->Name, name)) continue;
      void *original = (void *)slots->u1.Function;
      write_code(&slots->u1.Function, &hook, sizeof hook);
      return original;
    }
  }
  return NULL;
}

/* The call instruction (e8 rel32) at `at` to `target`. */
static BYTE *call_at(DWORD at, DWORD target) {
  BYTE *call = (BYTE *)at;
  LONG rel = (LONG)(target - (at + 5));
  return call[0] == 0xe8 && !memcmp(call + 1, &rel, 4) ? call : NULL;
}

static void redirect_call(BYTE *call, void *hook) {
  LONG rel = (LONG)((BYTE *)hook - (call + 5));
  write_code(call + 1, &rel, 4);
}

static BOOL patch_game(void) {
  static const DWORD present_calls[] = PRESENT_CALLS;
  BYTE *step_call = call_at(STEP_CALL, STEP_TARGET);
  BYTE *present_call[2] = {call_at(present_calls[0], PRESENT_TARGET), call_at(present_calls[1], PRESENT_TARGET)};
  if (!step_call || !present_call[0] || !present_call[1]) return FALSE; /* not the exe we know */
  original_step = (StepFn)STEP_TARGET;
  original_present = (PresentFn)PRESENT_TARGET;
  redirect_call(step_call, step);
  for (int i = 0; i < 2; i++) redirect_call(present_call[i], present);

  hook_import("timeGetTime", hook_timeGetTime);
  hook_import("QueryPerformanceCounter", hook_QueryPerformanceCounter);
  hook_import("GetLocalTime", hook_GetLocalTime);
  hook_import("GetAsyncKeyState", hook_GetAsyncKeyState);
  real_GetMessageA = hook_import("GetMessageA", hook_GetMessageA);
  hook_import("GetCursorPos", hook_GetCursorPos);
  real_StretchDIBits = hook_import("StretchDIBits", hook_StretchDIBits);
  real_SetTimer = hook_import("SetTimer", hook_SetTimer);
  return real_SetTimer != NULL;
}

/* ---- commands from the driver ---- */

static void post(UINT msg, WPARAM wparam, LPARAM lparam) {
  PostMessageA(window, msg, wparam, lparam);
  InterlockedIncrement(&posted);
  SetEvent(wake);
}

static LPARAM key_lparam(UINT vk, BOOL up) {
  UINT scan = MapVirtualKeyA(vk, 0 /* MAPVK_VK_TO_VSC */);
  BOOL extended = (vk >= VK_PRIOR && vk <= VK_DOWN) || vk == VK_INSERT || vk == VK_DELETE;
  return 1 | (LPARAM)scan << 16 | (LPARAM)extended << 24 | (up ? 0xc0000000 : 0);
}

static WPARAM mouse_buttons(void) {
  return (keys[VK_LBUTTON] ? MK_LBUTTON : 0) | (keys[VK_RBUTTON] ? MK_RBUTTON : 0) |
         (keys[VK_SHIFT] ? MK_SHIFT : 0) | (keys[VK_CONTROL] ? MK_CONTROL : 0);
}

static int status(char *out, size_t size, const char *word) {
  return snprintf(out, size, "%s tick=%lu ms=%lu steps=%lu frames=%lu", word, *(volatile DWORD *)GAME_TICK,
                  now_ms, steps, presents);
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
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

/* One command line → one answer line ("ok …" or "error …"). Commands:
 *   hello                            ok robot-proxy VERSION
 *   status                           ok tick=… ms=… steps=… frames=… (frames presented)
 *   run N                            N steps; "stalled … left=K" if the game stops stepping
 *   stepms MS                        virtual milliseconds per step (default 7)
 *   key VK down|up                   a key (Windows virtual-key code, decimal)
 *   mouse X Y                        move the mouse (client coordinates)
 *   button left|right down|up
 *   peek ADDR LEN                    ok HEX (ADDR in hex)
 *   poke ADDR HEX
 *   frame                            ok WIDTH HEIGHT FRAMES HEX: the last frame presented,
 *                                    palette indices row by row, top row first
 *   palette                          ok HEX: the 256 colours the frame was presented with,
 *                                    00RRGGBB each as 8 hex digits
 * Everything but key, mouse and button first waits until the game is idle.
 */
static void command(char *line, char *out, size_t size) {
  char word[16] = "", arg1[32] = "", arg2[4096] = "";
  sscanf(line, "%15s %31s %4095s", word, arg1, arg2);
  BOOL input = !strcmp(word, "key") || !strcmp(word, "mouse") || !strcmp(word, "button");
  if (!strcmp(word, "hello")) {
    snprintf(out, size, "ok robot-proxy %d", VERSION);
  } else if (!strcmp(word, "run")) {
    LONG n = atol(arg1);
    DWORD target = steps + n;
    InterlockedExchangeAdd(&budget, n);
    SetEvent(wake);
    if (!settle(target)) {
      LONG left = InterlockedExchange(&budget, 0);
      int len = status(out, size, "stalled");
      snprintf(out + len, size - len, " left=%ld", left);
      return;
    }
    status(out, size, "ok");
  } else if (!input && !settle(steps)) {
    status(out, size, "error the game is not idle:");
  } else if (!strcmp(word, "status")) {
    status(out, size, "ok");
  } else if (!strcmp(word, "frame") || !strcmp(word, "palette")) {
    if (!presents) {
      snprintf(out, size, "error no frame presented yet");
    } else if (word[0] == 'f') {
      int n = snprintf(out, size, "ok %d %d %lu ", frame_width, frame_height, presents);
      hex_bytes(out + n, size - n, frame, (size_t)frame_width * frame_height);
    } else {
      int n = snprintf(out, size, "ok ");
      for (int i = 0; i < 256; i++) n += snprintf(out + n, size - n, "%08lx", frame_colours[i]);
    }
  } else if (!strcmp(word, "stepms")) {
    step_ms = strtoul(arg1, NULL, 10);
    snprintf(out, size, "ok");
  } else if (!window) {
    snprintf(out, size, "error no game window yet");
  } else if (!strcmp(word, "key")) {
    UINT vk = strtoul(arg1, NULL, 10) & 0xff;
    BOOL up = !strcmp(arg2, "up");
    keys[vk] = !up;
    post(up ? WM_KEYUP : WM_KEYDOWN, vk, key_lparam(vk, up));
    snprintf(out, size, "ok");
  } else if (!strcmp(word, "mouse")) {
    cursor.x = atol(arg1);
    cursor.y = atol(arg2);
    post(WM_MOUSEMOVE, mouse_buttons(), MAKELPARAM(cursor.x, cursor.y));
    snprintf(out, size, "ok");
  } else if (!strcmp(word, "button")) {
    BOOL left = !strcmp(arg1, "left"), up = !strcmp(arg2, "up");
    keys[left ? VK_LBUTTON : VK_RBUTTON] = !up;
    UINT msg = left ? (up ? WM_LBUTTONUP : WM_LBUTTONDOWN) : (up ? WM_RBUTTONUP : WM_RBUTTONDOWN);
    post(msg, mouse_buttons(), MAKELPARAM(cursor.x, cursor.y));
    snprintf(out, size, "ok");
  } else if (!strcmp(word, "peek")) {
    BYTE *at = (BYTE *)strtoul(arg1, NULL, 16);
    size_t len = strtoul(arg2, NULL, 10);
    if (len > (size - 4) / 2) len = (size - 4) / 2;
    BYTE *buffer = malloc(len);
    SIZE_T read = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), at, buffer, len, &read) || read != len) {
      snprintf(out, size, "error cannot read %p", (void *)at);
    } else {
      hex_bytes(out + snprintf(out, size, "ok "), size - 3, buffer, len);
    }
    free(buffer);
  } else if (!strcmp(word, "poke")) {
    BYTE *at = (BYTE *)strtoul(arg1, NULL, 16);
    size_t len = strlen(arg2) / 2;
    BYTE bytes[2048];
    for (size_t i = 0; i < len; i++) bytes[i] = (BYTE)(hex(arg2[2 * i]) << 4 | hex(arg2[2 * i + 1]));
    snprintf(out, size, write_code(at, bytes, len) ? "ok" : "error cannot write %p", (void *)at);
  } else {
    snprintf(out, size, "error unknown command %s", word);
  }
}

static DWORD WINAPI serve(void *param) {
  WSADATA wsa;
  say("serve: thread");
  WSAStartup(MAKEWORD(2, 2), &wsa);
  say("serve: winsock");
  SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((u_short)(UINT_PTR)param);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(server, (struct sockaddr *)&address, sizeof address) || listen(server, 1)) return 1;
  static char line[8192], answer[1 << 20];
  for (;;) {
    SOCKET client = accept(server, NULL, NULL);
    say("serve: accept %d", (int)client);
    if (client == INVALID_SOCKET) continue;
    size_t used = 0;
    int got;
    while ((got = recv(client, line + used, (int)(sizeof line - 1 - used), 0)) > 0) {
      say("serve: recv %d", got);
      used += got;
      line[used] = 0;
      char *end;
      while ((end = strchr(line, '\n'))) {
        *end = 0;
        if (end > line && end[-1] == '\r') end[-1] = 0;
        command(line, answer, sizeof answer - 1);
        strcat(answer, "\n");
        send(client, answer, (int)strlen(answer), 0);
        used -= end + 1 - line;
        memmove(line, end + 1, used + 1);
      }
      if (used == sizeof line - 1) used = 0; /* an overlong line: dropped */
    }
    closesocket(client);
  }
}

/* ---- the DLL ---- */

/* Every export of the real ddraw.dll (proxy.def), forwarded by a jump: not only the game loads
 * ddraw, Wine's DxDiag (the game's DirectX check) does too. */
#define FORWARDED(X)                                                                                         \
  X(0, AcquireDDThreadLock)                                                                                  \
  X(1, DirectDrawCreate)                                                                                     \
  X(2, DirectDrawCreateClipper)                                                                              \
  X(3, DirectDrawCreateEx)                                                                                   \
  X(4, DirectDrawEnumerateA)                                                                                 \
  X(5, DirectDrawEnumerateExA)                                                                               \
  X(6, DirectDrawEnumerateExW)                                                                               \
  X(7, DirectDrawEnumerateW)                                                                                 \
  X(8, DllCanUnloadNow)                                                                                      \
  X(9, DllGetClassObject)                                                                                    \
  X(10, GetSurfaceFromDC)                                                                                    \
  X(11, ReleaseDDThreadLock)

#define NAME(i, name) #name,
static const char *const forwarded_names[] = {FORWARDED(NAME)};
FARPROC forwarded[sizeof forwarded_names / sizeof *forwarded_names];

/* Called by the stubs (keeps the arguments on the stack untouched). */
void resolve_forwarded(void) {
  if (forwarded[1]) return;
  char path[MAX_PATH];
  GetSystemDirectoryA(path, MAX_PATH - 16);
  strcat(path, "\\ddraw.dll");
  HMODULE module = LoadLibraryA(path);
  for (size_t i = 0; module && i < sizeof forwarded / sizeof *forwarded; i++)
    forwarded[i] = GetProcAddress(module, forwarded_names[i]);
}

#define STUB(i, name)                                                                                        \
  __attribute__((naked)) void forward_##name(void) {                                                         \
    __asm__("call _resolve_forwarded\n\tjmp *_forwarded+" #i "*4");                                          \
  }
FORWARDED(STUB)

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
  (void)reserved;
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  DisableThreadLibraryCalls(instance);
  char port[16];
  if (!GetEnvironmentVariableA("ROBOT_PROXY_PORT", port, sizeof port)) return TRUE;
  char log_path[MAX_PATH];
  if (GetEnvironmentVariableA("ROBOT_PROXY_LOG", log_path, sizeof log_path)) log_file = fopen(log_path, "w");
  InitializeCriticalSection(&lock);
  wake = CreateEventA(NULL, FALSE, FALSE, NULL);
  idle = CreateEventA(NULL, FALSE, FALSE, NULL);
  BOOL patched = patch_game();
  say("attach: patched %d", patched);
  if (patched) CreateThread(NULL, 0, serve, (void *)(UINT_PTR)atoi(port), 0, NULL);
  return TRUE;
}
