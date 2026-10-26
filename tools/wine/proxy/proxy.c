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
 *   reads keys only from WM_KEYDOWN/WM_KEYUP); GetAsyncKeyState, GetKeyState and
 *   GetCursorPos report the injected state.
 *
 * Messages posted while the game waits are dispatched before the next step, so a
 * run is the same every time.
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
#define STALL_MS 3000      /* `run` gives up when no step completes for this long */

typedef char(__cdecl *StepFn)(void *);

static StepFn original_step;
static UINT(WINAPI *real_SetTimer)(HWND, UINT_PTR, UINT, TIMERPROC);

static CRITICAL_SECTION lock;
static HANDLE wake;     /* steps granted or input posted */
static HANDLE progress; /* a step completed */
static volatile LONG budget;
static volatile DWORD now_ms = 10000;
static volatile DWORD steps;
static DWORD step_ms = 7;
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

static BOOL keys[256];
static POINT cursor; /* client coordinates */

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
static SHORT WINAPI hook_GetKeyState(int vk) { return keys[vk & 0xff] ? (SHORT)0x8000 : 0; }

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
 * dispatch pending messages first. */
static char __cdecl step(void *app) {
  if (!game_thread) {
    game_thread = GetCurrentThreadId();
    say("step: first call");
  }
  if (!window || !IsWindow(window)) {
    window = NULL;
    EnumThreadWindows(game_thread, pick_window, 0);
  }
  while (budget == 0) {
    MsgWaitForMultipleObjects(1, &wake, FALSE, INFINITE, QS_ALLINPUT);
    MSG msg;
    if (PeekMessageA(&msg, NULL, 0, 0, PM_NOREMOVE)) return 0;
  }
  InterlockedDecrement(&budget);
  now_ms += step_ms;
  steps++;
  fire_timers();
  char drawn = original_step(app);
  SetEvent(progress);
  return drawn;
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

static BOOL patch_game(void) {
  BYTE *call = (BYTE *)STEP_CALL;
  BYTE expected[5] = {0xe8};
  LONG rel = STEP_TARGET - (STEP_CALL + 5);
  memcpy(expected + 1, &rel, 4);
  if (memcmp(call, expected, 5)) return FALSE; /* not the exe we know */
  original_step = (StepFn)STEP_TARGET;
  BYTE patched[5] = {0xe8};
  rel = (LONG)((BYTE *)step - (call + 5));
  memcpy(patched + 1, &rel, 4);
  write_code(call, patched, 5);

  hook_import("timeGetTime", hook_timeGetTime);
  hook_import("QueryPerformanceCounter", hook_QueryPerformanceCounter);
  hook_import("GetLocalTime", hook_GetLocalTime);
  hook_import("GetAsyncKeyState", hook_GetAsyncKeyState);
  hook_import("GetKeyState", hook_GetKeyState);
  hook_import("GetCursorPos", hook_GetCursorPos);
  real_SetTimer = hook_import("SetTimer", hook_SetTimer);
  return real_SetTimer != NULL;
}

/* ---- commands from the driver ---- */

static void post(UINT msg, WPARAM wparam, LPARAM lparam) {
  PostMessageA(window, msg, wparam, lparam);
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
  return snprintf(out, size, "%s tick=%lu ms=%lu steps=%lu", word, *(volatile DWORD *)GAME_TICK, now_ms,
                  steps);
}

static int hex(char c) {
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

/* One command line → one answer line ("ok …" or "error …"). Commands:
 *   hello | status                   ok tick=… ms=… steps=…
 *   run N                            N steps; "stalled … left=K" if the game stops stepping
 *   stepms MS                        virtual milliseconds per step (default 7)
 *   key VK down|up                   a key (Windows virtual-key code, decimal)
 *   mouse X Y                        move the mouse (client coordinates)
 *   button left|right down|up
 *   peek ADDR LEN                    ok HEX (ADDR in hex)
 *   poke ADDR HEX
 */
static void command(char *line, char *out, size_t size) {
  char word[16] = "", arg1[32] = "", arg2[4096] = "";
  sscanf(line, "%15s %31s %4095s", word, arg1, arg2);
  if (!strcmp(word, "hello")) {
    snprintf(out, size, "ok robot-proxy %d", VERSION);
  } else if (!strcmp(word, "status")) {
    status(out, size, "ok");
  } else if (!strcmp(word, "run")) {
    LONG n = atol(arg1);
    DWORD target = steps + n;
    InterlockedExchangeAdd(&budget, n);
    SetEvent(wake);
    while ((LONG)(steps - target) < 0) {
      if (WaitForSingleObject(progress, STALL_MS) == WAIT_TIMEOUT) {
        LONG left = InterlockedExchange(&budget, 0);
        int len = status(out, size, "stalled");
        snprintf(out + len, size - len, " left=%ld", left);
        return;
      }
    }
    status(out, size, "ok");
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
      int n = snprintf(out, size, "ok ");
      for (size_t i = 0; i < len; i++) n += snprintf(out + n, size - n, "%02x", buffer[i]);
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
  static char line[8192], answer[16384];
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
  progress = CreateEventA(NULL, FALSE, FALSE, NULL);
  BOOL patched = patch_game();
  say("attach: patched %d", patched);
  if (patched) CreateThread(NULL, 0, serve, (void *)(UINT_PTR)atoi(port), 0, NULL);
  return TRUE;
}
