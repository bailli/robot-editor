/* The small imports: WINMM, VERSION, ole32, SHELL32, COMCTL32 (ADVAPI32 is registry.c,
   DDRAW is ddraw.c, DSOUND is dsound.c). Some of them report "not available", which the
   game handles: no COM. */
#define _GNU_SOURCE
#include <ctype.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "wrapper.h"

/* ---- WINMM ---- */

static DWORD WINAPI timeGetTime(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (DWORD)((uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000);
}

#define MMSYSERR_NODRIVER 6

int dsound_audio_available(void); /* dsound.c */

/* WAVEOUTCAPSA (52 bytes), asked for the sound card's name in the game's system information
   (0x42d549; without a card that line stays out): the card is SDL's audio. */
static UINT WINAPI waveOutGetDevCapsA(UINT_PTR device, void *caps, UINT size) {
  (void)device;
  if (!dsound_audio_available() || size < 52) return MMSYSERR_NODRIVER;
  BYTE *c = caps; /* ids, driver version, szPname[32] at 8, formats, channels at 44, support */
  memset(c, 0, 52);
  strcpy((char *)c + 8, "SDL audio");
  c[44] = 2;
  return 0;
}

const struct export misc_winmm_exports[] = {
    {"timeGetTime", timeGetTime},
    {"waveOutGetDevCapsA", waveOutGetDevCapsA},
    {NULL, NULL},
};

/* ---- VERSION ----
   The game's DirectX check (the DirectX SDK's GetDXVersion: DxDiag over COM, else the file
   versions of the system's DirectX DLLs) must find DirectX: those DLLs report 4.09.00.0904,
   DirectX 9.0c. The exe gives its own version resource. */

/* VS_VERSIONINFO with just the fixed part: header, L"VS_VERSION_INFO", padding, the 52-byte
   VS_FIXEDFILEINFO at offset 40. */
#define FIXED_INFO_OFFSET 40
static BYTE directx_version[FIXED_INFO_OFFSET + 52];

static const BYTE *version_block(LPCSTR file, DWORD *size) {
  const char *base = file;
  for (const char *p = file; *p; p++)
    if (*p == '\\' || *p == '/' || *p == ':') base = p + 1;
  static const char *const directx[] = {"ddraw.dll", "d3drg8x.dll", "dplayx.dll", "dinput.dll",
                                        "d3d8.dll",  "mpg2splt.ax", "dpnet.dll",  "d3d9.dll",
                                        "dsound.dll", "dxdiagn.dll"};
  for (size_t i = 0; i < sizeof directx / sizeof *directx; i++) {
    if (strcasecmp(base, directx[i]) != 0) continue;
    if (!directx_version[0]) {
      BYTE *b = directx_version;
      b[0] = sizeof directx_version; /* wLength */
      b[2] = 52;                     /* wValueLength */
      const char *key = "VS_VERSION_INFO";
      for (int k = 0; key[k]; k++) b[6 + 2 * k] = (BYTE)key[k];
      DWORD fixed[13] = {0xfeef04bd, 0x10000, 0x00040009, 0x00000384, 0x00040009, 0x00000384,
                         0x3f, 0, 0x40004 /* VOS_NT_WINDOWS32 */, 2 /* VFT_DLL */, 0, 0, 0};
      memcpy(b + FIXED_INFO_OFFSET, fixed, sizeof fixed);
    }
    *size = sizeof directx_version;
    return directx_version;
  }
  /* The exe itself: its RT_VERSION resource. */
  const char *exe = strrchr(exe_host_path, '/');
  if (exe && strcasecmp(base, exe + 1) == 0)
    return resource_find((LPCSTR)16, (LPCSTR)1, size);
  return NULL;
}

static DWORD WINAPI GetFileVersionInfoSizeA(LPCSTR file, DWORD *handle) {
  DWORD size = 0;
  const BYTE *block = version_block(file, &size);
  trace("GetFileVersionInfoSizeA %s: %u", file, block ? size : 0);
  if (handle) *handle = 0;
  return block ? size : 0;
}

static BOOL WINAPI GetFileVersionInfoA(LPCSTR file, DWORD handle, DWORD size, void *data) {
  (void)handle;
  DWORD n = 0;
  const BYTE *block = version_block(file, &n);
  if (!block) return FALSE;
  memcpy(data, block, n < size ? n : size);
  return TRUE;
}

/* A node of the version tree: wLength, wValueLength (in characters for text), wType (1 text),
   the key (UTF-16), then value and children, each aligned to 4 bytes. */
static WORD word_at(const BYTE *p) { return (WORD)(p[0] | p[1] << 8); }

static size_t key_end(const BYTE *node) {
  size_t i = 6;
  while (word_at(node + i)) i += 2;
  return (i + 2 + 3) & ~(size_t)3;
}

static int key_is(const BYTE *node, const char *key, size_t n) {
  size_t i = 0;
  for (; i < n; i++) {
    WORD c = word_at(node + 6 + 2 * i);
    if (c >= 0x80 || tolower(c) != tolower((unsigned char)key[i])) return 0;
  }
  return word_at(node + 6 + 2 * i) == 0;
}

static BOOL WINAPI VerQueryValueA(const void *block, LPCSTR sub, void **out, UINT *size) {
  const BYTE *node = block;
  for (const char *p = sub; *p;) {
    while (*p == '\\') p++;
    if (!*p) break;
    size_t n = strcspn(p, "\\");
    const BYTE *end = node + word_at(node);
    size_t value = key_end(node);
    size_t value_bytes = word_at(node + 4) == 1 ? 2u * word_at(node + 2) : word_at(node + 2);
    const BYTE *child = node + ((value + value_bytes + 3) & ~(size_t)3);
    const BYTE *found = NULL;
    while (child + 6 <= end && word_at(child)) {
      if (key_is(child, p, n)) {
        found = child;
        break;
      }
      child += (word_at(child) + 3) & ~3u;
    }
    if (!found) {
      trace("VerQueryValueA %s: not found", sub);
      return FALSE;
    }
    node = found;
    p += n;
  }
  const BYTE *value = node + key_end(node);
  if (word_at(node + 4) == 1) { /* text: an ANSI copy, as the A function gives */
    size_t chars = word_at(node + 2);
    char *text = malloc(chars + 1);
    for (size_t i = 0; i < chars; i++) {
      WORD c = word_at(value + 2 * i);
      text[i] = c < 0x100 ? (char)c : '?';
    }
    text[chars] = 0;
    *out = text;
    *size = (UINT)(chars ? chars - (text[chars - 1] == 0) : 0);
  } else {
    *out = (void *)value;
    *size = word_at(node + 2);
  }
  return *size > 0;
}

const struct export misc_version_exports[] = {
    {"GetFileVersionInfoA", GetFileVersionInfoA},
    {"GetFileVersionInfoSizeA", GetFileVersionInfoSizeA},
    {"VerQueryValueA", VerQueryValueA},
    {NULL, NULL},
};

/* ---- ole32: no COM classes ---- */

#define REGDB_E_CLASSNOTREG ((HRESULT)0x80040154)

static HRESULT WINAPI CoInitialize(void *reserved) {
  (void)reserved;
  return 0;
}

static void WINAPI CoUninitialize(void) {}

static HRESULT WINAPI CoCreateInstance(const BYTE *clsid, void *outer, DWORD context,
                                       const BYTE *iid, void **out) {
  (void)outer, (void)context, (void)iid;
  DWORD d1;
  memcpy(&d1, clsid, 4);
  trace("CoCreateInstance {%08x-...}: not registered", d1);
  *out = NULL;
  return REGDB_E_CLASSNOTREG;
}

const struct export misc_ole32_exports[] = {
    {"CoCreateInstance", CoCreateInstance},
    {"CoInitialize", CoInitialize},
    {"CoUninitialize", CoUninitialize},
    {NULL, NULL},
};

/* ---- SHELL32 ---- */

/* Starts xdg-open on `target` without waiting (SIGCHLD is ignored, so no zombies). */
static int open_with_xdg(const char *target) {
  static int sigchld_ignored;
  if (!sigchld_ignored) {
    signal(SIGCHLD, SIG_IGN);
    sigchld_ignored = 1;
  }
  pid_t pid = fork();
  if (pid < 0) return 0;
  if (pid == 0) {
    for (int fd = 3; fd < 1024; fd++) close(fd);
    char *argv[] = {"xdg-open", (char *)target, NULL};
    execvp("xdg-open", argv);
    _exit(127);
  }
  return 1;
}

/* The game opens web links (the TOM Productions site, forum, registration: "open" with a
   URL it decodes at run time). Folders and files work too, as Windows paths. */
static HINSTANCE WINAPI ShellExecuteA(HWND hwnd, LPCSTR op, LPCSTR file, LPCSTR params,
                                      LPCSTR dir, INT show) {
  (void)hwnd, (void)params, (void)dir, (void)show;
  if (!file) return (HINSTANCE)2;
  if (op && strcasecmp(op, "open") != 0 && strcasecmp(op, "explore") != 0)
    fatal("ShellExecuteA: operation %s (%s) is not supported", op, file);
  int url = strncasecmp(file, "http:", 5) == 0 || strncasecmp(file, "https:", 6) == 0 ||
            strncasecmp(file, "mailto:", 7) == 0;
  char *target = url ? strdup(file) : host_path(file);
  struct stat st;
  HINSTANCE result = (HINSTANCE)33;
  if (!url && stat(target, &st) != 0)
    result = (HINSTANCE)2; /* SE_ERR_FNF */
  else if (!open_with_xdg(target))
    result = (HINSTANCE)31; /* SE_ERR_NOASSOC: cannot start the opener */
  trace("ShellExecuteA %s %s: %s", op ? op : "open", file,
        (uintptr_t)result > 32 ? "xdg-open" : "failed");
  free(target);
  return result;
}

static BOOL WINAPI Shell_NotifyIconA(DWORD message, void *data) {
  (void)data;
  trace("Shell_NotifyIconA %u: no tray", message);
  return TRUE;
}

const struct export misc_shell32_exports[] = {
    {"ShellExecuteA", ShellExecuteA},
    {"Shell_NotifyIconA", Shell_NotifyIconA},
    {NULL, NULL},
};

/* ---- COMCTL32 ---- */

static void WINAPI InitCommonControls(void) {}

const struct export misc_comctl32_exports[] = {
    {"#17", InitCommonControls}, /* InitCommonControls */
    {NULL, NULL},
};
