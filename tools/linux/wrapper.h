/* What the loader (loader.c) and the DLL modules (kernel32.c, user32.c, ...) share. */
#ifndef WRAPPER_H
#define WRAPPER_H

#include <stddef.h>

#include "win32.h"

/* One function a module provides for the game's imports. `name` is the export name, or
   "#N" for an import by ordinal N. Every `fn` is WINAPI (stdcall) with the Windows
   signature, except the C-variadic ones (wsprintfA), which are cdecl as on Windows. */
struct export {
  const char *name;
  void *fn;
};

struct module {
  const char *dll; /* lower case, e.g. "kernel32.dll" */
  const struct export *exports; /* ends with { NULL, NULL } */
};

extern const struct export kernel32_exports[];
extern const struct export user32_exports[];
extern const struct export ui_exports[] __attribute__((weak)); /* more of USER32 (ui.c) */
extern const struct export gdi32_exports[];
extern const struct export misc_winmm_exports[];
extern const struct export misc_advapi32_exports[];
extern const struct export misc_version_exports[];
extern const struct export misc_ole32_exports[];
extern const struct export misc_shell32_exports[];
extern const struct export misc_comctl32_exports[];
extern const struct export misc_dsound_exports[];
extern const struct export ddraw_exports[];

/* Looks a function up by DLL (any case) and name or "#N": for GetProcAddress. */
void *find_export(const char *dll, const char *name);

/* The game's image (mapped at its base, 0x400000) and the host paths. */
#define IMAGE_BASE 0x400000u
extern const char *exe_host_path; /* the exe as given on the command line */
extern const char *drive_root;    /* host directory that C:\ stands for (the exe's directory) */
extern int argc_game;             /* the arguments after the exe */
extern char **argv_game;

/* Logging: `say` always writes to stderr; `trace` only with ROBOT_TRACE set. */
extern int tracing;
void say(const char *format, ...) __attribute__((format(printf, 1, 2)));
#define trace(...)                                                                                 \
  do {                                                                                             \
    if (tracing) say(__VA_ARGS__);                                                                 \
  } while (0)
/* Stops the program: a function the game called that is not there or not done yet. */
__attribute__((noreturn)) void fatal(const char *format, ...) __attribute__((format(printf, 1, 2)));

/* Code that stops the program naming `name` when the game calls it (for COM methods not
   written yet; `name` must stay valid). */
void *missing_function(const char *name);

/* Handles: kernel objects behind an opaque HANDLE (never 0 or INVALID_HANDLE_VALUE).
   `data` belongs to the module that made the handle; `close` (may be NULL) frees it when
   the handle is closed (CloseHandle, FindClose, ...). */
enum handle_kind {
  HANDLE_FILE = 1,
  HANDLE_FIND,
  HANDLE_EVENT,
  HANDLE_MUTEX,
  HANDLE_THREAD,
  HANDLE_HEAP,
  HANDLE_OTHER,
};
HANDLE handle_new(enum handle_kind kind, void *data, void (*close)(void *data));
/* The data of a live handle of this kind (any kind: 0), or NULL. */
void *handle_get(HANDLE h, enum handle_kind kind);
enum handle_kind handle_kind(HANDLE h); /* 0 if not a live handle */
BOOL handle_close(HANDLE h);            /* FALSE if not a live handle */

/* Threads: each thread that runs game code needs its own thread information block (the
   game's code reaches it through %fs: SEH chain, stack limits). The main thread gets one in
   the loader; a thread made by CreateThread must call thread_enter() first thing. */
void thread_enter(void);

/* Host path for a Windows path: "C:\a\B.txt" and "\a\b.txt" (any drive) map below
   drive_root, a relative path below the current directory; each component matched without
   regard to case when the exact name does not exist. Returns a malloc'd string. */
char *host_path(const char *windows_path);

/* The registry file (registry.c): ROBOT_REGISTRY, else ~/.config/robot/registry.reg;
   malloc'd. */
char *registry_path(void);

/* The command line's --settings and --set NAME=VALUE (settings.c): they list or write the
   game's settings in the registry file; 0 on success. */
int settings_list(void);
int settings_set(const char *assignment);

/* The wrapper's own settings (settings.c), as DWORDs under HKCU\Software\robot-wrapper in the
   same file: read with a fallback, written. */
DWORD wrapper_setting(const char *name, DWORD fallback);
void wrapper_setting_set(const char *name, DWORD value);

/* A resource of the game's exe (kernel32.c): `type` and `name` as FindResourceA takes them
   (an integer id below 0x10000, "#123", or a name, any case); the first language found.
   Returns its data in the mapped image and its size, or NULL. */
const void *resource_find(LPCSTR type, LPCSTR name, DWORD *size);

/* The driver protocol (driver.c, `--serve`): a test driver steps the game on a virtual clock. */
int driver_active(void);
/* One clock for the whole wrapper: virtual ms in serve mode, else CLOCK_MONOTONIC ms. */
DWORD clock_ms(void);
void driver_enable(int port);  /* the command line's --serve [--port N]; before anything else */
void driver_start(void);       /* once the image is loaded: patch it, listen, say `ready` */
BOOL driver_async_key(int vk); /* a key or button the driver injected is down */
long driver_posted(void);      /* how many messages the driver posted so far */
/* GetMessageA with nothing to take under the driver: a granted step passes as time, or idle */
void driver_wait_message(long seen);

#endif
