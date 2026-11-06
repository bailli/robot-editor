/* Runs GameOfRobot.exe natively on 32-bit Linux: maps the PE image at its base (it has no
   relocations), binds its imports to the functions of our modules, gives the thread the
   information block the game's code reaches through %fs, and jumps to the entry point.

   Usage: robot [--trace] GameOfRobot.exe [ARGS...]   (ROBOT_TRACE=1 also traces) */
#define _GNU_SOURCE
#include <asm/ldt.h>
#include <ctype.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <ucontext.h>
#include <unistd.h>

#include "wrapper.h"

int tracing;
const char *exe_host_path;
const char *drive_root;
int argc_game;
char **argv_game;

void say(const char *format, ...) {
  va_list args;
  va_start(args, format);
  flockfile(stderr);
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  funlockfile(stderr);
  va_end(args);
}

void fatal(const char *format, ...) {
  va_list args;
  va_start(args, format);
  flockfile(stderr);
  fputs("robot: ", stderr);
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  funlockfile(stderr);
  va_end(args);
  _exit(70);
}

/* ---- Modules ---- */

static const struct module modules[] = {
    {"kernel32.dll", kernel32_exports},       {"user32.dll", user32_exports},
    {"user32.dll", ui_exports},
    {"gdi32.dll", gdi32_exports},             {"winmm.dll", misc_winmm_exports},
    {"advapi32.dll", misc_advapi32_exports},  {"version.dll", misc_version_exports},
    {"ole32.dll", misc_ole32_exports},        {"shell32.dll", misc_shell32_exports},
    {"comctl32.dll", misc_comctl32_exports},  {"dsound.dll", misc_dsound_exports},
    {"ddraw.dll", ddraw_exports},
};

void *find_export(const char *dll, const char *name) {
  for (size_t m = 0; m < sizeof modules / sizeof *modules; m++) {
    if (!modules[m].exports || strcasecmp(modules[m].dll, dll) != 0) continue;
    for (const struct export *e = modules[m].exports; e->name; e++)
      if (strcmp(e->name, name) == 0) return e->fn;
  }
  return NULL;
}

/* ---- Handles ---- */

#define MAX_HANDLES 4096
static struct {
  enum handle_kind kind;
  void *data;
  void (*close)(void *);
} handles[MAX_HANDLES];
static pthread_mutex_t handles_lock = PTHREAD_MUTEX_INITIALIZER;

/* Handle values: 0x1000 + 4 × slot, so they look like Windows handles (multiples of 4). */
static int slot_of(HANDLE h) {
  uintptr_t v = (uintptr_t)h;
  if (v < 0x1000 || (v & 3) || (v - 0x1000) / 4 >= MAX_HANDLES) return -1;
  return (int)((v - 0x1000) / 4);
}

HANDLE handle_new(enum handle_kind kind, void *data, void (*close)(void *)) {
  pthread_mutex_lock(&handles_lock);
  for (int i = 0; i < MAX_HANDLES; i++) {
    if (handles[i].kind) continue;
    handles[i].kind = kind;
    handles[i].data = data;
    handles[i].close = close;
    pthread_mutex_unlock(&handles_lock);
    return (HANDLE)(uintptr_t)(0x1000 + 4 * i);
  }
  pthread_mutex_unlock(&handles_lock);
  fatal("out of handles");
}

void *handle_get(HANDLE h, enum handle_kind kind) {
  int i = slot_of(h);
  if (i < 0) return NULL;
  pthread_mutex_lock(&handles_lock);
  void *data = handles[i].kind && (!kind || handles[i].kind == kind) ? handles[i].data : NULL;
  pthread_mutex_unlock(&handles_lock);
  return data;
}

void *handle_hold(HANDLE h, enum handle_kind kind, void (*hold)(void *data)) {
  int i = slot_of(h);
  if (i < 0) return NULL;
  pthread_mutex_lock(&handles_lock);
  void *data = handles[i].kind && (!kind || handles[i].kind == kind) ? handles[i].data : NULL;
  if (data) hold(data); /* before a CloseHandle can drop the handle's own reference */
  pthread_mutex_unlock(&handles_lock);
  return data;
}

enum handle_kind handle_kind(HANDLE h) {
  int i = slot_of(h);
  return i < 0 ? 0 : handles[i].kind;
}

BOOL handle_close(HANDLE h) {
  int i = slot_of(h);
  if (i < 0) return FALSE;
  pthread_mutex_lock(&handles_lock);
  if (!handles[i].kind) {
    pthread_mutex_unlock(&handles_lock);
    return FALSE;
  }
  void *data = handles[i].data;
  void (*close)(void *) = handles[i].close;
  handles[i].kind = 0;
  pthread_mutex_unlock(&handles_lock);
  if (close) close(data);
  return TRUE;
}

/* ---- Thread information block ---- */

static BYTE peb[0x1000]; /* zeroed: BeingDebugged 0 */
static int next_ldt_entry;

void thread_enter(void) {
  DWORD *teb = calloc(1, 0x1000);
  if (!teb) fatal("no memory for a thread block");
  pthread_attr_t attr;
  void *stack = NULL;
  size_t size = 0;
  if (pthread_getattr_np(pthread_self(), &attr) == 0) {
    pthread_attr_getstack(&attr, &stack, &size);
    pthread_attr_destroy(&attr);
  }
  teb[0] = 0xffffffff;                         /* +0x00 SEH chain: empty */
  teb[1] = (DWORD)(uintptr_t)stack + size;     /* +0x04 stack base (top) */
  teb[2] = (DWORD)(uintptr_t)stack;            /* +0x08 stack limit */
  teb[6] = (DWORD)(uintptr_t)teb;              /* +0x18 self */
  teb[8] = (DWORD)getpid();                    /* +0x20 process id */
  teb[9] = (DWORD)syscall(SYS_gettid);         /* +0x24 thread id */
  teb[12] = (DWORD)(uintptr_t)peb;             /* +0x30 PEB */

  struct user_desc d = {0};
  d.entry_number = (unsigned)__atomic_fetch_add(&next_ldt_entry, 1, __ATOMIC_SEQ_CST);
  d.base_addr = (unsigned)(uintptr_t)teb;
  d.limit = 0xfff;
  d.seg_32bit = 1;
  d.useable = 1;
  if (syscall(SYS_modify_ldt, 1, &d, sizeof d) != 0) fatal("modify_ldt failed");
  unsigned short selector = (unsigned short)((d.entry_number << 3) | 7); /* LDT, ring 3 */
  __asm__ volatile("movw %w0, %%fs" : : "q"(selector));
}

/* ---- Imports ---- */

/* Executable memory for the thunks. */
static BYTE *thunk_space, *thunk_next;

static BYTE *thunk_alloc(size_t size) {
  if (!thunk_space) {
    thunk_space = mmap(NULL, 0x10000, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS,
                       -1, 0);
    if (thunk_space == MAP_FAILED) fatal("no memory for thunks");
    thunk_next = thunk_space;
  }
  if (thunk_next + size > thunk_space + 0x10000) fatal("out of thunk space");
  BYTE *t = thunk_next;
  thunk_next += (size + 15) & ~(size_t)15;
  return t;
}

static void put32(BYTE *p, DWORD v) { memcpy(p, &v, 4); }

/* Called by a missing import's thunk (cdecl). The game's return address is above it. */
__attribute__((noreturn, used)) static void missing(const char *name, DWORD ret) {
  fatal("the game called %s (from 0x%08x), which the wrapper does not have yet", name, ret);
}

__attribute__((used)) static void traced(const char *name, DWORD ret) {
  say("call %s from 0x%08x", name, ret);
}

/* push [esp] (return address); push name; mov eax, fn; call eax; ... */
static void *make_missing_thunk(const char *name) {
  BYTE *t = thunk_alloc(16);
  BYTE code[] = {0xff, 0x34, 0x24, 0x68, 0, 0, 0, 0, 0xb8, 0, 0, 0, 0, 0xff, 0xd0};
  put32(code + 4, (DWORD)(uintptr_t)name);
  put32(code + 9, (DWORD)(uintptr_t)missing);
  memcpy(t, code, sizeof code);
  return t;
}

void *missing_function(const char *name) { return make_missing_thunk(name); }

void fill_vtable(void **vtable, int slots, const char *interface, const char *const *methods) {
  for (int i = 0; i < slots; i++) {
    if (vtable[i]) continue;
    char *name = NULL;
    if (asprintf(&name, "%s::%s", interface, methods[i]) < 0) fatal("no memory");
    vtable[i] = missing_function(name);
  }
}

/* push [esp]; push name; mov eax, traced; call eax; add esp, 8; mov eax, fn; jmp eax */
static void *make_trace_thunk(const char *name, void *fn) {
  BYTE *t = thunk_alloc(32);
  BYTE code[] = {0xff, 0x34, 0x24, 0x68, 0, 0, 0, 0, 0xb8, 0,    0,    0,
                 0,    0xff, 0xd0, 0x83, 0xc4, 8, 0xb8, 0, 0, 0, 0, 0xff, 0xe0};
  put32(code + 4, (DWORD)(uintptr_t)name);
  put32(code + 9, (DWORD)(uintptr_t)traced);
  put32(code + 19, (DWORD)(uintptr_t)fn);
  memcpy(t, code, sizeof code);
  return t;
}

static DWORD rd32(const BYTE *p) {
  DWORD v;
  memcpy(&v, p, 4);
  return v;
}

static WORD rd16(const BYTE *p) {
  WORD v;
  memcpy(&v, p, 2);
  return v;
}

/* Whether `n` bytes at `rva` lie in the image (sums in 64 bits: no wrap). */
static int in_image(DWORD rva, uint64_t n, DWORD image_size) { return (uint64_t)rva + n <= image_size; }

/* A NUL-ended name at `rva` within the image, else fatal. */
static const char *image_name(const BYTE *image, DWORD rva, DWORD image_size) {
  if (!in_image(rva, 1, image_size) || !memchr(image + rva, 0, image_size - rva))
    fatal("the exe's imports name something outside the image");
  return (const char *)image + rva;
}

static void bind_imports(BYTE *image, DWORD directory, DWORD image_size) {
  int missing_count = 0;
  for (DWORD at = directory;; at += 20) {
    if (!in_image(at, 20, image_size)) fatal("the exe's import table runs out of the image");
    BYTE *desc = image + at;
    if (!rd32(desc + 0xc)) break;
    const char *dll = image_name(image, rd32(desc + 0xc), image_size);
    DWORD names = rd32(desc) ? rd32(desc) : rd32(desc + 0x10);
    DWORD iat_at = rd32(desc + 0x10);
    for (DWORD k = 0;; k++) {
      if (!in_image(names, 4 * ((uint64_t)k + 1), image_size) ||
          !in_image(iat_at, 4 * ((uint64_t)k + 1), image_size))
        fatal("the exe's imports of %s run out of the image", dll);
      DWORD *entry = (DWORD *)(image + names) + k, *iat = (DWORD *)(image + iat_at) + k;
      if (!*entry) break;
      char key[64];
      if (*entry & 0x80000000u)
        snprintf(key, sizeof key, "#%u", *entry & 0xffff);
      else
        snprintf(key, sizeof key, "%s", image_name(image, *entry + 2, image_size));
      char *full = NULL;
      if (asprintf(&full, "%s!%s", dll, key) < 0) fatal("no memory");
      void *fn = find_export(dll, key);
      if (!fn) {
        missing_count++;
        trace("missing import %s", full);
      }
      *iat = (DWORD)(uintptr_t)(!fn ? make_missing_thunk(full)
                                : tracing ? make_trace_thunk(full, fn)
                                          : fn);
      if (fn && !tracing) free(full);
    }
  }
  if (missing_count) trace("%d imports are missing (they stop the game when called)", missing_count);
}

static void *load_image(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) fatal("cannot open %s", path);
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  BYTE *file = malloc((size_t)size);
  if (!file || fread(file, 1, (size_t)size, f) != (size_t)size) fatal("cannot read %s", path);
  fclose(f);

  if (size < 0x40 || rd16(file) != 0x5a4d) fatal("%s is not an exe", path);
  /* every header field is checked against the file before it is used */
  DWORD pe_at = rd32(file + 0x3c);
  if ((uint64_t)pe_at + 24 + 0x60 + 16 * 8 > (uint64_t)size) fatal("%s is not a 32-bit PE", path);
  const BYTE *pe = file + pe_at;
  if (rd32(pe) != 0x4550 || rd16(pe + 4) != 0x14c) fatal("%s is not a 32-bit PE", path);
  WORD sections = rd16(pe + 6);
  const BYTE *opt = pe + 24;
  if (rd16(opt) != 0x10b) fatal("%s: not PE32", path);
  if ((uint64_t)pe_at + 24 + rd16(pe + 20) + 40 * (uint64_t)sections > (uint64_t)size)
    fatal("%s: the section table runs out of the file", path);
  DWORD entry = rd32(opt + 16);
  DWORD base = rd32(opt + 28);
  DWORD image_size = rd32(opt + 56);
  DWORD headers_size = rd32(opt + 60);
  DWORD imports = rd32(opt + 96 + 8);
  if (base != IMAGE_BASE) fatal("%s: image base 0x%x, expected 0x%x", path, base, IMAGE_BASE);
  if (headers_size > (DWORD)size || headers_size > image_size || entry >= image_size ||
      !in_image(imports, 20, image_size))
    fatal("%s: bad headers", path);

  BYTE *image = mmap((void *)(uintptr_t)base, image_size, PROT_READ | PROT_WRITE | PROT_EXEC,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
  if (image != (BYTE *)(uintptr_t)base) fatal("cannot map the image at 0x%x", base);
  memcpy(image, file, headers_size);
  const BYTE *section = opt + rd16(pe + 20);
  for (WORD i = 0; i < sections; i++, section += 40) {
    DWORD va = rd32(section + 12), raw_size = rd32(section + 16), raw = rd32(section + 20);
    DWORD virtual_size = rd32(section + 8);
    /* As Windows maps it: the raw data up to the section's virtual size rounded up to whole
       pages. Code patched in after the used part of .text (mods put new code there, e.g.
       0x465e60) lies beyond VirtualSize but within that page. */
    DWORD mapped = (virtual_size + 0xfff) & ~0xfffu;
    DWORD n = raw_size < mapped || !virtual_size ? raw_size : mapped;
    if ((uint64_t)va + n > image_size || (uint64_t)raw + n > (uint64_t)size)
      fatal("%s: bad section %d", path, i);
    memcpy(image + va, file + raw, n);
  }
  free(file);
  bind_imports(image, imports, image_size);
  return image + entry;
}

/* ---- Faults ---- */

static void on_fault(int sig, siginfo_t *info, void *context) {
  const greg_t *r = ((ucontext_t *)context)->uc_mcontext.gregs;
  say("robot: %s at eip 0x%08x (address 0x%08x)", strsignal(sig), (unsigned)r[REG_EIP],
      (unsigned)(uintptr_t)info->si_addr);
  say("  eax %08x ebx %08x ecx %08x edx %08x", (unsigned)r[REG_EAX], (unsigned)r[REG_EBX],
      (unsigned)r[REG_ECX], (unsigned)r[REG_EDX]);
  say("  esi %08x edi %08x ebp %08x esp %08x", (unsigned)r[REG_ESI], (unsigned)r[REG_EDI],
      (unsigned)r[REG_EBP], (unsigned)r[REG_ESP]);
  /* Return addresses into the game's code found on the stack (a rough backtrace). */
  const DWORD *sp = (const DWORD *)(uintptr_t)r[REG_ESP];
  char line[256];
  int n = snprintf(line, sizeof line, "  stack:");
  for (int i = 0, found = 0; i < 256 && found < 10 && n < (int)sizeof line - 12; i++) {
    if (sp[i] >= IMAGE_BASE + 0x1000 && sp[i] < 0x466000) {
      n += snprintf(line + n, sizeof line - (size_t)n, " %08x", sp[i]);
      found++;
    }
  }
  say("%s", line);
  /* The words at the stack pointer, and the chain of frame pointers with their returns. */
  n = snprintf(line, sizeof line, "  at esp-32..:");
  for (int i = -8; i < 12; i++) n += snprintf(line + n, sizeof line - (size_t)n, " %08x", sp[i]);
  say("%s", line);
  n = snprintf(line, sizeof line, "  frames:");
  const DWORD *bp = (const DWORD *)(uintptr_t)r[REG_EBP];
  for (int i = 0; i < 8 && bp && (uintptr_t)bp > (uintptr_t)sp - 0x10000 &&
                  (uintptr_t)bp < (uintptr_t)sp + 0x100000 && n < (int)sizeof line - 12;
       i++, bp = (const DWORD *)(uintptr_t)bp[0])
    n += snprintf(line + n, sizeof line - (size_t)n, " %08x", bp[1]);
  say("%s", line);
  _exit(71);
}

void screen_write(const char *path);
extern unsigned frame_count;

static void on_stop(int sig) {
  const char *shot = getenv("ROBOT_SHOT");
  if (shot && frame_count) {
    screen_write(shot);
    say("robot: %u frames, the last written to %s", frame_count, shot);
  }
  _exit(128 + sig);
}

/* ---- Main ---- */

int main(int argc, char **argv) {
  int a = 1, list = 0, set = 0, serve = 0, port = 0;
  if (getenv("ROBOT_TRACE")) tracing = 1;
  for (; a < argc && argv[a][0] == '-'; a++) {
    if (!strcmp(argv[a], "--trace")) {
      tracing = 1;
    } else if (!strcmp(argv[a], "--settings")) {
      list = 1;
    } else if (!strcmp(argv[a], "--serve")) {
      serve = 1;
    } else if (!strcmp(argv[a], "--port") && a + 1 < argc) {
      port = atoi(argv[++a]);
    } else if (!strcmp(argv[a], "--set") && a + 1 < argc) {
      if (settings_set(argv[++a])) return 64;
      set = 1;
    } else {
      fprintf(stderr, "robot: unknown option %s\n", argv[a]);
      return 64;
    }
  }
  if (list) return settings_list();
  if (a >= argc) {
    if (set) return 0; /* only settings written */
    fprintf(stderr, "usage: robot [--trace] [--set NAME=VALUE]... GameOfRobot.exe [ARGS...]\n"
                    "       robot --serve [--port N] GameOfRobot.exe   run for a test driver (driver.c)\n"
                    "       robot --settings          the game's settings and what they do\n");
    return 64;
  }
  if (serve) driver_enable(port); /* before anything touches SDL or the clock */
  static char exe[PATH_MAX], root[PATH_MAX];
  if (!realpath(argv[a], exe)) fatal("cannot find %s", argv[a]);
  exe_host_path = exe;
  strcpy(root, exe);
  *strrchr(root, '/') = 0;
  drive_root = root;
  argc_game = argc - a - 1;
  argv_game = argv + a + 1;

  struct sigaction sa = {0};
  sa.sa_sigaction = on_fault;
  sa.sa_flags = SA_SIGINFO;
  sigaction(SIGSEGV, &sa, NULL);
  sigaction(SIGILL, &sa, NULL);
  sigaction(SIGFPE, &sa, NULL);
  sigaction(SIGBUS, &sa, NULL);
  signal(SIGINT, on_stop);
  signal(SIGTERM, on_stop);

  typedef void(WINAPI * entry_fn)(void);
  entry_fn entry = (entry_fn)load_image(exe);
  thread_enter();
  if (serve) driver_start();
  trace("entering the game at 0x%08x", (unsigned)(uintptr_t)entry);
  entry();
  return 0; /* the game ends with ExitProcess */
}
