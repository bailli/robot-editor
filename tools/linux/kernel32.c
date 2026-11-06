/* KERNEL32 for the wrapper: the functions of KERNEL32.DLL the game imports, on Linux.
   Every export is WINAPI with its Windows signature and static; the table at the end is the
   only thing the loader sees. Sections: modules, paths, files, memory, strings, sync, threads,
   time, resources, process. */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define _TIME_BITS 64
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "wrapper.h"

/* Error codes win32.h does not have. */
#define E_FILE_EXISTS 80
#define E_DISK_FULL 112
#define E_GEN_FAILURE 31
#define E_NEGATIVE_SEEK 131
#define E_MOD_NOT_FOUND 126
#define E_PROC_NOT_FOUND 127
#define E_ENVVAR_NOT_FOUND 203
#define E_INVALID_ADDRESS 487
#define E_RES_TYPE 1813
#define E_RES_NAME 1814

#define INFINITE 0xffffffffu
#define MAX_PATH 260

typedef WORD *LPWORD;

static __thread DWORD last_error;

static void set_error(DWORD e) { last_error = e; }

static DWORD WINAPI GetLastError(void) { return last_error; }

/* Windows error for the current errno; `host` (if given) tells a missing file from a missing
   directory. */
static DWORD error_from_errno(const char *host) {
  switch (errno) {
  case ENOENT:
    if (host) {
      char *dir = strdup(host);
      char *slash = dir ? strrchr(dir, '/') : NULL;
      int parent_missing = 0;
      if (slash && slash != dir) {
        *slash = 0;
        parent_missing = access(dir, F_OK) != 0;
      }
      free(dir);
      if (parent_missing) return ERROR_PATH_NOT_FOUND;
    }
    return ERROR_FILE_NOT_FOUND;
  case ENOTDIR: return ERROR_PATH_NOT_FOUND;
  case EACCES:
  case EPERM:
  case EISDIR:
  case EROFS: return ERROR_ACCESS_DENIED;
  case EEXIST: return E_FILE_EXISTS;
  case ENOSPC: return E_DISK_FULL;
  case EBADF: return ERROR_INVALID_HANDLE;
  case EINVAL: return ERROR_INVALID_PARAMETER;
  case ENOMEM: return ERROR_NOT_ENOUGH_MEMORY;
  default: return E_GEN_FAILURE;
  }
}

static void set_errno_error(const char *host) { set_error(error_from_errno(host)); }

static DWORD WINAPI GetVersion(void) { return 0x0A280105; } /* XP: 5.1, build 2600 */

/* ---- Modules ---- */

static const char *const module_names[] = {"kernel32.dll", "user32.dll",   "gdi32.dll",
                                           "winmm.dll",    "advapi32.dll", "version.dll",
                                           "ole32.dll",    "shell32.dll",  "comctl32.dll",
                                           "dsound.dll",   "ddraw.dll"};
#define MODULE_COUNT (sizeof module_names / sizeof *module_names)
static HANDLE module_handles[MODULE_COUNT];
static pthread_mutex_t module_lock = PTHREAD_MUTEX_INITIALIZER;

/* "C:\WINDOWS\System32\USER32" -> index into module_names, or -1. */
static int module_index(const char *name) {
  const char *base = name;
  for (const char *p = name; *p; p++)
    if (*p == '\\' || *p == '/') base = p + 1;
  char buf[64];
  if (strlen(base) + 5 > sizeof buf) return -1;
  strcpy(buf, base);
  if (!strchr(buf, '.')) strcat(buf, ".dll");
  for (size_t i = 0; i < MODULE_COUNT; i++)
    if (strcasecmp(buf, module_names[i]) == 0) return (int)i;
  return -1;
}

static HANDLE module_handle(int index) {
  pthread_mutex_lock(&module_lock);
  if (!module_handles[index])
    module_handles[index] = handle_new(HANDLE_OTHER, (void *)module_names[index], NULL);
  HANDLE h = module_handles[index];
  pthread_mutex_unlock(&module_lock);
  return h;
}

static HMODULE WINAPI GetModuleHandleA(LPCSTR name) {
  if (!name) return (HMODULE)(uintptr_t)IMAGE_BASE;
  int i = module_index(name);
  if (i < 0) {
    set_error(E_MOD_NOT_FOUND);
    return NULL;
  }
  return module_handle(i);
}

static HMODULE WINAPI LoadLibraryA(LPCSTR name) {
  int i = name ? module_index(name) : -1;
  trace("LoadLibraryA(\"%s\") -> %s", name ? name : "(null)", i < 0 ? "not found" : "ok");
  if (i < 0) {
    set_error(E_MOD_NOT_FOUND);
    return NULL;
  }
  return module_handle(i);
}

static BOOL WINAPI FreeLibrary(HMODULE module) {
  (void)module;
  return TRUE;
}

static void *WINAPI GetProcAddress(HMODULE module, LPCSTR name) {
  char key[256];
  const char *dll = NULL;
  void *data = (uintptr_t)module == IMAGE_BASE ? NULL : handle_get(module, HANDLE_OTHER);
  for (size_t i = 0; data && i < MODULE_COUNT; i++)
    if (data == module_names[i]) dll = module_names[i];
  if ((uintptr_t)name < 0x10000)
    snprintf(key, sizeof key, "#%u", (unsigned)(uintptr_t)name);
  else
    snprintf(key, sizeof key, "%s", name);
  void *fn = dll ? find_export(dll, key) : NULL;
  trace("GetProcAddress(%s, %s) -> %p", dll ? dll : "?", key, fn);
  if (!fn) set_error(E_PROC_NOT_FOUND);
  return fn;
}

/* ---- Paths ---- */

static char curdir[MAX_PATH] = "C:\\"; /* a Windows path */

static const char *exe_name(void) {
  const char *slash = strrchr(exe_host_path, '/');
  return slash ? slash + 1 : exe_host_path;
}

static int is_sep(char c) { return c == '\\' || c == '/'; }

/* Splits `path` in place into components, applying "." and ".."; appends to comps[]. */
static void add_components(char *path, char **comps, int *n) {
  char *p = path;
  while (*p) {
    while (is_sep(*p)) p++;
    char *start = p;
    while (*p && !is_sep(*p)) p++;
    if (*p) *p++ = 0;
    if (!*start || !strcmp(start, ".")) continue;
    if (!strcmp(start, "..")) {
      if (*n > 0) (*n)--;
    } else if (*n < 255) {
      comps[(*n)++] = start;
    }
  }
}

static int has_drive(const char *p) { return isalpha((unsigned char)p[0]) && p[1] == ':'; }

char *host_path(const char *windows_path) {
  char *copy = strdup(windows_path), *cur = strdup(curdir);
  if (!copy || !cur) fatal("out of memory");
  char *comps[256];
  int n = 0;
  char *p = copy;
  if (has_drive(p)) p += 2;
  if (!is_sep(*p)) add_components(cur + (has_drive(cur) ? 2 : 0), comps, &n);
  add_components(p, comps, &n);

  char *out = malloc(strlen(drive_root) + strlen(windows_path) + strlen(curdir) + 16);
  if (!out) fatal("out of memory");
  strcpy(out, drive_root);
  int missing = 0;
  for (int i = 0; i < n; i++) {
    size_t len = strlen(out);
    out[len] = '/';
    strcpy(out + len + 1, comps[i]);
    struct stat st;
    if (missing || lstat(out, &st) == 0) continue;
    /* No exact match: look for the name in the directory without regard to case. */
    out[len] = 0;
    DIR *d = opendir(out[0] ? out : "/");
    struct dirent *e;
    const char *found = NULL;
    char name[256];
    while (d && (e = readdir(d))) {
      if (strcasecmp(e->d_name, comps[i]) == 0) {
        snprintf(name, sizeof name, "%s", e->d_name);
        found = name;
        break;
      }
    }
    if (d) closedir(d);
    if (!found) {
      found = comps[i];
      missing = 1;
    }
    out[len] = '/';
    strcpy(out + len + 1, found);
  }
  free(copy);
  free(cur);
  return out;
}

/* GetXxxA convention: the length without the NUL, or the size needed (with it) if too small. */
static DWORD copy_result(const char *s, LPSTR buf, DWORD size) {
  size_t len = strlen(s);
  if (len + 1 > size) return (DWORD)len + 1;
  memcpy(buf, s, len + 1);
  return (DWORD)len;
}

static DWORD WINAPI GetCurrentDirectoryA(DWORD size, LPSTR buf) {
  return copy_result(curdir, buf, size);
}

static DWORD WINAPI GetSystemDirectoryA(LPSTR buf, UINT size) {
  return copy_result("C:\\WINDOWS\\SYSTEM32", buf, size);
}

static DWORD WINAPI GetModuleFileNameA(HMODULE module, LPSTR buf, DWORD size) {
  char path[MAX_PATH + 64];
  if (!module || (uintptr_t)module == IMAGE_BASE) {
    snprintf(path, sizeof path, "C:\\%s", exe_name());
  } else {
    const char *dll = handle_get(module, HANDLE_OTHER);
    snprintf(path, sizeof path, "C:\\WINDOWS\\SYSTEM32\\%s", dll ? dll : "unknown.dll");
  }
  size_t len = strlen(path);
  if (!size) return 0;
  if (len >= size) {
    memcpy(buf, path, size);
    set_error(ERROR_INSUFFICIENT_BUFFER);
    return size;
  }
  memcpy(buf, path, len + 1);
  return (DWORD)len;
}

static LPSTR WINAPI GetCommandLineA(void) {
  static char line[2048];
  if (!line[0]) {
    int n = snprintf(line, sizeof line, "\"C:\\%s\"", exe_name());
    for (int i = 0; i < argc_game && n < (int)sizeof line - 1; i++)
      n += snprintf(line + n, sizeof line - (size_t)n, " %s", argv_game[i]);
  }
  return line;
}

/* ---- Files ---- */

struct file {
  int fd;
  int owned; /* closed with the handle (not the std handles) */
};

static void file_close(void *data) {
  struct file *f = data;
  if (f->owned) close(f->fd);
  free(f);
}

static struct file *file_of(HANDLE h) {
  struct file *f = handle_get(h, HANDLE_FILE);
  if (!f) set_error(ERROR_INVALID_HANDLE);
  return f;
}

static HANDLE WINAPI CreateFileA(LPCSTR name, DWORD access, DWORD share, LPVOID security,
                                 DWORD disposition, DWORD flags, HANDLE template) {
  (void)share;
  (void)security;
  (void)template;
  if (!name) {
    set_error(ERROR_INVALID_PARAMETER);
    return INVALID_HANDLE_VALUE;
  }
  if (flags & 0x40000000) fatal("CreateFileA(\"%s\"): FILE_FLAG_OVERLAPPED is not supported", name);
  char *path = host_path(name);
  int writing = (access & 0x40000000) != 0, reading = (access & 0x80000000) != 0;
  int oflags = writing ? (reading ? O_RDWR : O_WRONLY) : O_RDONLY;
  struct stat st;
  int existed = stat(path, &st) == 0;
  switch (disposition) {
  case 1: oflags |= O_CREAT | O_EXCL; break;
  case 2: oflags |= O_CREAT | O_TRUNC; break;
  case 3: break;
  case 4: oflags |= O_CREAT; break;
  case 5: oflags |= O_TRUNC; break;
  default: set_error(ERROR_INVALID_PARAMETER); goto fail;
  }
  if (disposition == 5 && !writing) {
    set_error(ERROR_INVALID_PARAMETER);
    goto fail;
  }
  if (existed && S_ISDIR(st.st_mode) && writing) {
    set_error(ERROR_ACCESS_DENIED);
    goto fail;
  }
  int fd = open(path, oflags | O_CLOEXEC, 0666);
  if (fd < 0) {
    set_errno_error(path);
    goto fail;
  }
  trace("CreateFileA(\"%s\" -> %s, access %x, disposition %u) -> fd %d", name, path, access,
        disposition, fd);
  free(path);
  struct file *f = malloc(sizeof *f);
  if (!f) fatal("out of memory");
  f->fd = fd;
  f->owned = 1;
  set_error(existed && (disposition == 2 || disposition == 4) ? ERROR_ALREADY_EXISTS : 0);
  return handle_new(HANDLE_FILE, f, file_close);

fail:
  trace("CreateFileA(\"%s\" -> %s, access %x, disposition %u) failed: error %u", name, path, access,
        disposition, last_error);
  free(path);
  return INVALID_HANDLE_VALUE;
}

static BOOL WINAPI ReadFile(HANDLE h, LPVOID buf, DWORD count, LPDWORD read_out, LPVOID overlapped) {
  if (overlapped) fatal("ReadFile with OVERLAPPED is not supported");
  struct file *f = file_of(h);
  if (!f) return FALSE;
  ssize_t n;
  do n = read(f->fd, buf, count);
  while (n < 0 && errno == EINTR);
  if (n < 0) {
    if (read_out) *read_out = 0;
    set_errno_error(NULL);
    return FALSE;
  }
  if (read_out) *read_out = (DWORD)n;
  return TRUE;
}

static BOOL WINAPI WriteFile(HANDLE h, LPCVOID buf, DWORD count, LPDWORD written,
                             LPVOID overlapped) {
  if (overlapped) fatal("WriteFile with OVERLAPPED is not supported");
  struct file *f = file_of(h);
  if (!f) return FALSE;
  DWORD done = 0;
  while (done < count) {
    ssize_t n = write(f->fd, (const char *)buf + done, count - done);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (written) *written = done;
      set_errno_error(NULL);
      return FALSE;
    }
    done += (DWORD)n;
  }
  if (written) *written = done;
  return TRUE;
}

static DWORD WINAPI SetFilePointer(HANDLE h, LONG low, PLONG high, DWORD method) {
  struct file *f = file_of(h);
  if (!f) return 0xffffffffu;
  if (method > 2) {
    set_error(ERROR_INVALID_PARAMETER);
    return 0xffffffffu;
  }
  off_t offset = high ? (off_t)(((int64_t)*high << 32) | (uint32_t)low) : (off_t)low;
  off_t pos = lseek(f->fd, offset, method == 0 ? SEEK_SET : method == 1 ? SEEK_CUR : SEEK_END);
  if (pos < 0) {
    set_error(errno == EINVAL ? E_NEGATIVE_SEEK : error_from_errno(NULL));
    return 0xffffffffu;
  }
  if (high) *high = (LONG)((uint64_t)pos >> 32);
  set_error(0);
  return (DWORD)pos;
}

static BOOL WINAPI FlushFileBuffers(HANDLE h) {
  struct file *f = file_of(h);
  if (!f) return FALSE;
  if (fsync(f->fd) != 0 && errno != EINVAL && errno != EROFS) {
    set_errno_error(NULL);
    return FALSE;
  }
  return TRUE;
}

static DWORD WINAPI GetFileType(HANDLE h) {
  struct file *f = file_of(h);
  struct stat st;
  if (!f || fstat(f->fd, &st) != 0) return 0;
  if (S_ISCHR(st.st_mode)) return 2;
  if (S_ISFIFO(st.st_mode) || S_ISSOCK(st.st_mode)) return 3;
  return 1;
}

static HANDLE std_handles[3];
static pthread_mutex_t std_lock = PTHREAD_MUTEX_INITIALIZER;

static HANDLE WINAPI GetStdHandle(DWORD which) {
  DWORD index = which - (DWORD)-10; /* -10 input, -11 output, -12 error */
  if (index > 2) {
    set_error(ERROR_INVALID_HANDLE);
    return INVALID_HANDLE_VALUE;
  }
  pthread_mutex_lock(&std_lock);
  if (!std_handles[index]) {
    struct file *f = malloc(sizeof *f);
    if (!f) fatal("out of memory");
    f->fd = (int)index;
    f->owned = 0;
    std_handles[index] = handle_new(HANDLE_FILE, f, file_close);
  }
  HANDLE h = std_handles[index];
  pthread_mutex_unlock(&std_lock);
  return h;
}

static BOOL WINAPI SetStdHandle(DWORD which, HANDLE h) {
  DWORD index = which - (DWORD)-10;
  if (index > 2) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  pthread_mutex_lock(&std_lock);
  std_handles[index] = h;
  pthread_mutex_unlock(&std_lock);
  return TRUE;
}

/* FILETIME: 100 ns since 1601-01-01. */
#define UNIX_TO_FILETIME_SECONDS 11644473600ll

static FILETIME filetime_of(struct timespec ts) {
  uint64_t t = ((uint64_t)ts.tv_sec + UNIX_TO_FILETIME_SECONDS) * 10000000ull +
               (uint64_t)ts.tv_nsec / 100;
  FILETIME ft = {(DWORD)t, (DWORD)(t >> 32)};
  return ft;
}

typedef struct {
  DWORD dwFileAttributes;
  FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
  DWORD dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh,
      nFileIndexLow;
} BY_HANDLE_FILE_INFORMATION;
_Static_assert(sizeof(BY_HANDLE_FILE_INFORMATION) == 52, "BY_HANDLE_FILE_INFORMATION");

static DWORD attributes_of(const struct stat *st) {
  if (S_ISDIR(st->st_mode)) return 0x10;
  return (st->st_mode & S_IWUSR) ? 0x80 : 0x81;
}

static BOOL WINAPI GetFileInformationByHandle(HANDLE h, BY_HANDLE_FILE_INFORMATION *info) {
  struct file *f = file_of(h);
  struct stat st;
  if (!f) return FALSE;
  if (fstat(f->fd, &st) != 0) {
    set_errno_error(NULL);
    return FALSE;
  }
  memset(info, 0, sizeof *info);
  info->dwFileAttributes = attributes_of(&st);
  info->ftCreationTime = filetime_of(st.st_ctim);
  info->ftLastAccessTime = filetime_of(st.st_atim);
  info->ftLastWriteTime = filetime_of(st.st_mtim);
  info->dwVolumeSerialNumber = (DWORD)st.st_dev;
  info->nFileSizeHigh = (DWORD)((uint64_t)st.st_size >> 32);
  info->nFileSizeLow = (DWORD)st.st_size;
  info->nNumberOfLinks = (DWORD)st.st_nlink;
  info->nFileIndexHigh = (DWORD)((uint64_t)st.st_ino >> 32);
  info->nFileIndexLow = (DWORD)st.st_ino;
  return TRUE;
}

static BOOL WINAPI GetFileTime(HANDLE h, FILETIME *created, FILETIME *accessed, FILETIME *written) {
  struct file *f = file_of(h);
  struct stat st;
  if (!f) return FALSE;
  if (fstat(f->fd, &st) != 0) {
    set_errno_error(NULL);
    return FALSE;
  }
  if (created) *created = filetime_of(st.st_ctim);
  if (accessed) *accessed = filetime_of(st.st_atim);
  if (written) *written = filetime_of(st.st_mtim);
  return TRUE;
}

static uint64_t ft64(const FILETIME *ft) {
  return ((uint64_t)ft->dwHighDateTime << 32) | ft->dwLowDateTime;
}

static BOOL WINAPI FileTimeToLocalFileTime(const FILETIME *ft, FILETIME *local) {
  uint64_t t = ft64(ft);
  time_t secs = (time_t)(t / 10000000ull) - UNIX_TO_FILETIME_SECONDS;
  struct tm tm;
  long offset = localtime_r(&secs, &tm) ? tm.tm_gmtoff : 0;
  t += (uint64_t)((int64_t)offset * 10000000);
  local->dwLowDateTime = (DWORD)t;
  local->dwHighDateTime = (DWORD)(t >> 32);
  return TRUE;
}

/* Days since 1970-01-01 -> civil date (Hinnant's algorithm). */
static void civil_from_days(int64_t z, int *y, int *m, int *d) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t yy = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  *d = (int)(doy - (153 * mp + 2) / 5 + 1);
  *m = (int)(mp < 10 ? mp + 3 : mp - 9);
  *y = (int)(yy + (*m <= 2));
}

static BOOL WINAPI FileTimeToSystemTime(const FILETIME *ft, SYSTEMTIME *st) {
  uint64_t t = ft64(ft);
  if (t >> 63) {
    set_error(ERROR_INVALID_PARAMETER);
    return FALSE;
  }
  uint64_t ms = t / 10000, days = ms / 86400000ull, in_day = ms % 86400000ull;
  int y, m, d;
  civil_from_days((int64_t)days - 134774, &y, &m, &d); /* 1601 -> 1970 */
  st->wYear = (WORD)y;
  st->wMonth = (WORD)m;
  st->wDay = (WORD)d;
  st->wDayOfWeek = (WORD)((days + 1) % 7); /* 1601-01-01 was a Monday */
  st->wHour = (WORD)(in_day / 3600000);
  st->wMinute = (WORD)(in_day / 60000 % 60);
  st->wSecond = (WORD)(in_day / 1000 % 60);
  st->wMilliseconds = (WORD)(in_day % 1000);
  return TRUE;
}

typedef struct {
  DWORD dwFileAttributes;
  FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
  DWORD nFileSizeHigh, nFileSizeLow, dwReserved0, dwReserved1;
  CHAR cFileName[MAX_PATH];
  CHAR cAlternateFileName[14];
} WIN32_FIND_DATAA;
_Static_assert(sizeof(WIN32_FIND_DATAA) == 320, "WIN32_FIND_DATAA");

/* All matching names are read when the search starts. */
struct find {
  char *dir; /* host directory */
  char **names;
  int count, next;
};

static void find_free(void *data) {
  struct find *f = data;
  for (int i = 0; i < f->count; i++) free(f->names[i]);
  free(f->names);
  free(f->dir);
  free(f);
}

/* * and ? match, without regard to case; "*.*" is the same as "*". */
static int wild_match(const char *pat, const char *name) {
  if (!strcmp(pat, "*.*")) pat = "*";
  for (; *pat; pat++, name++) {
    if (*pat == '*') {
      while (pat[1] == '*') pat++;
      if (!pat[1]) return 1;
      for (; *name; name++)
        if (wild_match(pat + 1, name)) return 1;
      return wild_match(pat + 1, name);
    }
    if (!*name) return 0;
    if (*pat != '?' && tolower((unsigned char)*pat) != tolower((unsigned char)*name)) return 0;
  }
  return !*name;
}

/* "." and ".." first, then alphabetical (as NTFS lists). */
static int compare_names(const void *a, const void *b) {
  const char *x = *(char *const *)a, *y = *(char *const *)b;
  int dx = !strcmp(x, ".") ? 0 : !strcmp(x, "..") ? 1 : 2;
  int dy = !strcmp(y, ".") ? 0 : !strcmp(y, "..") ? 1 : 2;
  if (dx != dy) return dx - dy;
  return strcasecmp(x, y);
}

static void fill_find_data(struct find *f, WIN32_FIND_DATAA *data) {
  const char *name = f->names[f->next++];
  char *path = malloc(strlen(f->dir) + strlen(name) + 2);
  struct stat st;
  if (!path) fatal("out of memory");
  sprintf(path, "%s/%s", f->dir, name);
  if (stat(path, &st) != 0 && lstat(path, &st) != 0) memset(&st, 0, sizeof st);
  free(path);
  memset(data, 0, sizeof *data);
  data->dwFileAttributes = attributes_of(&st);
  data->ftCreationTime = filetime_of(st.st_ctim);
  data->ftLastAccessTime = filetime_of(st.st_atim);
  data->ftLastWriteTime = filetime_of(st.st_mtim);
  data->nFileSizeHigh = (DWORD)((uint64_t)st.st_size >> 32);
  data->nFileSizeLow = (DWORD)st.st_size;
  snprintf(data->cFileName, MAX_PATH, "%s", name);
}

static HANDLE WINAPI FindFirstFileA(LPCSTR pattern, WIN32_FIND_DATAA *data) {
  if (!pattern || !*pattern) {
    set_error(ERROR_PATH_NOT_FOUND);
    return INVALID_HANDLE_VALUE;
  }
  char *copy = strdup(pattern);
  if (!copy) fatal("out of memory");
  char *sep = NULL;
  for (char *p = copy; *p; p++)
    if (is_sep(*p)) sep = p;
  const char *leaf = sep ? sep + 1 : copy;
  char *dirpart;
  if (!sep) {
    dirpart = host_path(".");
  } else if (sep == copy || (sep == copy + 2 && copy[1] == ':')) {
    dirpart = host_path("\\"); /* "\x" or "C:\x": the drive's root */
  } else {
    char saved = *sep;
    *sep = 0;
    dirpart = host_path(copy);
    *sep = saved;
  }
  for (const char *p = copy; p < leaf; p++)
    if (*p == '*' || *p == '?')
      fatal("FindFirstFileA(\"%s\"): wildcards in the directory", pattern);

  DIR *d = opendir(dirpart);
  if (!d) {
    set_errno_error(NULL);
    if (last_error == ERROR_FILE_NOT_FOUND) set_error(ERROR_PATH_NOT_FOUND);
    free(copy);
    free(dirpart);
    return INVALID_HANDLE_VALUE;
  }
  struct find *f = calloc(1, sizeof *f);
  if (!f) fatal("out of memory");
  f->dir = dirpart;
  int at_root = strcmp(dirpart, drive_root) == 0, cap = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (at_root && (!strcmp(e->d_name, ".") || !strcmp(e->d_name, ".."))) continue;
    if (strlen(e->d_name) >= MAX_PATH || !wild_match(leaf, e->d_name)) continue;
    if (f->count == cap) {
      cap = cap ? cap * 2 : 32;
      f->names = realloc(f->names, (size_t)cap * sizeof *f->names);
      if (!f->names) fatal("out of memory");
    }
    f->names[f->count++] = strdup(e->d_name);
  }
  closedir(d);
  free(copy);
  if (!f->count) {
    find_free(f);
    set_error(ERROR_FILE_NOT_FOUND);
    return INVALID_HANDLE_VALUE;
  }
  qsort(f->names, (size_t)f->count, sizeof *f->names, compare_names);
  fill_find_data(f, data);
  set_error(0);
  return handle_new(HANDLE_FIND, f, find_free);
}

static BOOL WINAPI FindNextFileA(HANDLE h, WIN32_FIND_DATAA *data) {
  struct find *f = handle_get(h, HANDLE_FIND);
  if (!f) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  if (f->next >= f->count) {
    set_error(ERROR_NO_MORE_FILES);
    return FALSE;
  }
  fill_find_data(f, data);
  return TRUE;
}

static BOOL WINAPI FindClose(HANDLE h) {
  if (handle_kind(h) != HANDLE_FIND) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  return handle_close(h);
}

static BOOL WINAPI CreateDirectoryA(LPCSTR name, LPVOID security) {
  (void)security;
  char *path = host_path(name);
  int ok = mkdir(path, 0777) == 0;
  if (!ok) set_error(errno == EEXIST ? ERROR_ALREADY_EXISTS : error_from_errno(path));
  trace("CreateDirectoryA(\"%s\" -> %s) -> %d", name, path, ok);
  free(path);
  return ok;
}

static BOOL WINAPI DeleteFileA(LPCSTR name) {
  char *path = host_path(name);
  int ok = unlink(path) == 0;
  if (!ok) set_errno_error(path);
  trace("DeleteFileA(\"%s\" -> %s) -> %d", name, path, ok);
  free(path);
  return ok;
}

/* CloseHandle for every kind of handle; the pseudo handles of the current process/thread
   count as valid. */
static BOOL WINAPI CloseHandle(HANDLE h) {
  if (h == (HANDLE)(intptr_t)-1 || h == (HANDLE)(intptr_t)-2) return TRUE;
  if (!handle_close(h)) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  return TRUE;
}

/* ---- Memory ---- */

/* Heap blocks have a 16-byte header with the size, so HeapReAlloc can zero the grown part. */
#define HEAP_ZERO_MEMORY 8
#define HEAP_REALLOC_IN_PLACE_ONLY 0x10
#define HEADER 16

static int heap_dummy;

static HANDLE WINAPI HeapCreate(DWORD options, SIZE_T initial, SIZE_T maximum) {
  (void)options;
  (void)initial;
  (void)maximum;
  return handle_new(HANDLE_HEAP, &heap_dummy, NULL);
}

static BOOL WINAPI HeapDestroy(HANDLE heap) {
  if (handle_kind(heap) != HANDLE_HEAP) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  return handle_close(heap);
}

static LPVOID WINAPI HeapAlloc(HANDLE heap, DWORD flags, SIZE_T size) {
  (void)heap;
  if (size > 0x7fffffffu - HEADER) {
    set_error(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  BYTE *block = malloc(size + HEADER);
  if (!block) {
    set_error(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  *(SIZE_T *)block = size;
  if (flags & HEAP_ZERO_MEMORY) memset(block + HEADER, 0, size);
  return block + HEADER;
}

static BOOL WINAPI HeapFree(HANDLE heap, DWORD flags, LPVOID p) {
  (void)heap;
  (void)flags;
  if (p) free((BYTE *)p - HEADER);
  return TRUE;
}

static LPVOID WINAPI HeapReAlloc(HANDLE heap, DWORD flags, LPVOID p, SIZE_T size) {
  (void)heap;
  if (!p) return NULL;
  BYTE *block = (BYTE *)p - HEADER;
  SIZE_T old = *(SIZE_T *)block;
  if (flags & HEAP_REALLOC_IN_PLACE_ONLY) {
    if (size > old) {
      set_error(ERROR_NOT_ENOUGH_MEMORY);
      return NULL;
    }
    *(SIZE_T *)block = size;
    return p;
  }
  if (size > 0x7fffffffu - HEADER) {
    set_error(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  BYTE *grown = realloc(block, size + HEADER);
  if (!grown) {
    set_error(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  *(SIZE_T *)grown = size;
  if ((flags & HEAP_ZERO_MEMORY) && size > old) memset(grown + HEADER + old, 0, size - old);
  return grown + HEADER;
}

static HGLOBAL WINAPI GlobalAlloc(UINT flags, SIZE_T bytes) {
  void *p = flags & 0x40 ? calloc(1, bytes ? bytes : 1) : malloc(bytes ? bytes : 1);
  if (!p) set_error(ERROR_NOT_ENOUGH_MEMORY);
  return p;
}

static HLOCAL WINAPI LocalAlloc(UINT flags, SIZE_T bytes) { return GlobalAlloc(flags, bytes); }

static LPVOID WINAPI GlobalLock(HGLOBAL h) { return h; }

static BOOL WINAPI GlobalUnlock(HGLOBAL h) {
  (void)h;
  return TRUE;
}

static HLOCAL WINAPI LocalFree(HLOCAL h) {
  free(h);
  return NULL;
}

typedef struct {
  DWORD dwLength, dwMemoryLoad, dwTotalPhys, dwAvailPhys, dwTotalPageFile, dwAvailPageFile,
      dwTotalVirtual, dwAvailVirtual;
} MEMORYSTATUS;
_Static_assert(sizeof(MEMORYSTATUS) == 32, "MEMORYSTATUS");

static void WINAPI GlobalMemoryStatus(MEMORYSTATUS *ms) {
  ms->dwLength = sizeof *ms;
  ms->dwMemoryLoad = 50;
  ms->dwTotalPhys = 512u << 20;
  ms->dwAvailPhys = 256u << 20;
  ms->dwTotalPageFile = 1024u << 20;
  ms->dwAvailPageFile = 512u << 20;
  ms->dwTotalVirtual = 0x7ffe0000u;
  ms->dwAvailVirtual = 0x70000000u;
}

/* VirtualAlloc/VirtualFree: reservations are PROT_NONE mappings aligned to 64 KiB; committing
   is mprotect, decommitting gives the pages back (they read as zero when committed again). */
#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define MEM_DECOMMIT 0x4000
#define MEM_RELEASE 0x8000
#define PAGE 4096u
#define GRANULARITY 0x10000u

struct region {
  uintptr_t base;
  size_t size;
  struct region *next;
};
static struct region *regions;
static pthread_mutex_t region_lock = PTHREAD_MUTEX_INITIALIZER;

static uintptr_t round_down(uintptr_t v, uintptr_t a) { return v & ~(a - 1); }
static uintptr_t round_up(uintptr_t v, uintptr_t a) { return (v + a - 1) & ~(a - 1); }

static int protection(DWORD protect) {
  switch (protect & 0xff) {
  case 0x01: return PROT_NONE;
  case 0x02: return PROT_READ;
  case 0x04:
  case 0x08: return PROT_READ | PROT_WRITE;
  case 0x10: return PROT_EXEC;
  case 0x20: return PROT_READ | PROT_EXEC;
  case 0x40:
  case 0x80: return PROT_READ | PROT_WRITE | PROT_EXEC;
  default: return PROT_READ | PROT_WRITE;
  }
}

static void region_add(uintptr_t base, size_t size) {
  struct region *r = malloc(sizeof *r);
  if (!r) fatal("out of memory");
  r->base = base;
  r->size = size;
  pthread_mutex_lock(&region_lock);
  r->next = regions;
  regions = r;
  pthread_mutex_unlock(&region_lock);
}

static int region_contains(uintptr_t start, uintptr_t end) {
  int found = 0;
  pthread_mutex_lock(&region_lock);
  for (struct region *r = regions; r; r = r->next)
    if (start >= r->base && end <= r->base + r->size) found = 1;
  pthread_mutex_unlock(&region_lock);
  return found;
}

/* Reserves `size` bytes (at `want` if non-zero); returns the base or 0. */
static uintptr_t reserve(uintptr_t want, size_t size) {
  uintptr_t base;
  if (want) {
    base = round_down(want, GRANULARITY);
    size = (size_t)round_up(size + (want - base), PAGE);
    void *m = mmap((void *)base, size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
                   -1, 0);
    if (m != (void *)base) {
      if (m != MAP_FAILED) munmap(m, size);
      set_error(E_INVALID_ADDRESS);
      return 0;
    }
  } else {
    size = (size_t)round_up(size, PAGE);
    void *m = mmap(NULL, size + GRANULARITY, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (m == MAP_FAILED) {
      set_error(ERROR_NOT_ENOUGH_MEMORY);
      return 0;
    }
    base = round_up((uintptr_t)m, GRANULARITY);
    if (base > (uintptr_t)m) munmap(m, base - (uintptr_t)m);
    uintptr_t tail = base + size, end = (uintptr_t)m + size + GRANULARITY;
    if (end > tail) munmap((void *)tail, end - tail);
  }
  region_add(base, size);
  return base;
}

static LPVOID WINAPI VirtualAlloc(LPVOID address, SIZE_T size, DWORD type, DWORD protect) {
  uintptr_t addr = (uintptr_t)address;
  if (!size || !(type & (MEM_RESERVE | MEM_COMMIT))) {
    set_error(ERROR_INVALID_PARAMETER);
    return NULL;
  }
  if ((type & MEM_RESERVE) || !addr) {
    addr = reserve(addr, size);
    if (!addr) return NULL;
  }
  if (type & MEM_COMMIT) {
    uintptr_t start = round_down(addr, PAGE), end = round_up(addr + size, PAGE);
    if (!region_contains(start, end) && !reserve(start, end - start)) return NULL;
    if (mprotect((void *)start, end - start, protection(protect)) != 0) {
      set_errno_error(NULL);
      return NULL;
    }
    return (LPVOID)start;
  }
  return (LPVOID)addr;
}

static BOOL WINAPI VirtualFree(LPVOID address, SIZE_T size, DWORD type) {
  uintptr_t addr = (uintptr_t)address;
  if (type == MEM_DECOMMIT) {
    uintptr_t start = round_down(addr, PAGE), end = round_up(addr + size, PAGE);
    if (!region_contains(start, end)) {
      set_error(ERROR_INVALID_PARAMETER);
      return FALSE;
    }
    madvise((void *)start, end - start, MADV_DONTNEED);
    mprotect((void *)start, end - start, PROT_NONE);
    return TRUE;
  }
  if (type == MEM_RELEASE && size == 0) {
    pthread_mutex_lock(&region_lock);
    for (struct region **p = &regions; *p; p = &(*p)->next) {
      if ((*p)->base == addr) {
        struct region *r = *p;
        *p = r->next;
        pthread_mutex_unlock(&region_lock);
        munmap((void *)r->base, r->size);
        free(r);
        return TRUE;
      }
    }
    pthread_mutex_unlock(&region_lock);
  }
  set_error(ERROR_INVALID_PARAMETER);
  return FALSE;
}

static BOOL WINAPI IsBadReadPtr(LPCVOID p, UINT size) { return !p && size; }
static BOOL WINAPI IsBadWritePtr(LPVOID p, UINT size) { return !p && size; }
static BOOL WINAPI IsBadCodePtr(LPVOID p) { return !p; }

/* ---- Strings and locale ---- */

static UINT WINAPI GetACP(void) { return 1252; }
static UINT WINAPI GetOEMCP(void) { return 437; }

static const WORD cp437_high[128] = {
    0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef,
    0x00ee, 0x00ec, 0x00c4, 0x00c5, 0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
    0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192, 0x00e1, 0x00ed, 0x00f3, 0x00fa,
    0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557,
    0x255d, 0x255c, 0x255b, 0x2510, 0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
    0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567, 0x2568, 0x2564, 0x2565, 0x2559,
    0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
    0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4,
    0x221e, 0x03c6, 0x03b5, 0x2229, 0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
    0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
};

static const WORD cp1252_high[32] = {
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
    0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
};

/* The code page behind a CP_* value: 1252 or 437. */
static int code_page(UINT cp) {
  switch (cp) {
  case 0:
  case 3:
  case 1252: return 1252;
  case 1:
  case 437: return 437;
  default: fatal("unsupported code page %u", cp);
  }
}

static WCHAR byte_to_wide(int page, BYTE b) {
  if (b < 0x80) return b;
  if (page == 437) return cp437_high[b - 0x80];
  return b < 0xa0 ? cp1252_high[b - 0x80] : b;
}

static int wide_to_byte(int page, WCHAR w) {
  if (w < 0x80) return w;
  if (page == 1252 && w >= 0xa0 && w < 0x100) return w;
  for (int i = 0; i < (page == 437 ? 128 : 32); i++)
    if ((page == 437 ? cp437_high[i] : cp1252_high[i]) == w) return 0x80 + i;
  return -1;
}

static int WINAPI MultiByteToWideChar(UINT cp, DWORD flags, LPCSTR src, int src_len, LPWSTR dst,
                                      int dst_len) {
  (void)flags;
  if (!src || src_len == 0 || dst_len < 0) {
    set_error(ERROR_INVALID_PARAMETER);
    return 0;
  }
  int page = code_page(cp);
  if (src_len < 0) src_len = (int)strlen(src) + 1;
  if (dst_len == 0) return src_len;
  if (dst_len < src_len) {
    set_error(ERROR_INSUFFICIENT_BUFFER);
    return 0;
  }
  for (int i = 0; i < src_len; i++) dst[i] = byte_to_wide(page, (BYTE)src[i]);
  return src_len;
}

static int wide_length(LPCWSTR s) {
  int n = 0;
  while (s[n]) n++;
  return n;
}

static int WINAPI WideCharToMultiByte(UINT cp, DWORD flags, LPCWSTR src, int src_len, LPSTR dst,
                                      int dst_len, LPCSTR default_char, BOOL *used_default) {
  (void)flags;
  if (!src || src_len == 0 || dst_len < 0) {
    set_error(ERROR_INVALID_PARAMETER);
    return 0;
  }
  int page = code_page(cp);
  if (src_len < 0) src_len = wide_length(src) + 1;
  if (used_default) *used_default = FALSE;
  if (dst_len == 0) return src_len;
  if (dst_len < src_len) {
    set_error(ERROR_INSUFFICIENT_BUFFER);
    return 0;
  }
  for (int i = 0; i < src_len; i++) {
    int b = wide_to_byte(page, src[i]);
    if (b < 0) {
      b = default_char ? (BYTE)*default_char : '?';
      if (used_default) *used_default = TRUE;
    }
    dst[i] = (char)b;
  }
  return src_len;
}

typedef struct {
  UINT MaxCharSize;
  BYTE DefaultChar[2];
  BYTE LeadByte[12];
} CPINFO;
_Static_assert(sizeof(CPINFO) == 20, "CPINFO");

static BOOL WINAPI GetCPInfo(UINT cp, CPINFO *info) {
  if (cp != 0 && cp != 1 && cp != 3 && cp != 1252 && cp != 437) {
    set_error(ERROR_INVALID_PARAMETER);
    return FALSE;
  }
  memset(info, 0, sizeof *info);
  info->MaxCharSize = 1;
  info->DefaultChar[0] = '?';
  return TRUE;
}

/* Character classes (code page 1252, by Unicode value). */
#define C1_UPPER 1
#define C1_LOWER 2
#define C1_DIGIT 4
#define C1_SPACE 8
#define C1_PUNCT 0x10
#define C1_CNTRL 0x20
#define C1_BLANK 0x40
#define C1_XDIGIT 0x80
#define C1_ALPHA 0x100

static WORD ctype1(WCHAR c) {
  if (c < 0x80) {
    if (c == 9) return C1_SPACE | C1_CNTRL | C1_BLANK;
    if (c >= 10 && c <= 13) return C1_SPACE | C1_CNTRL;
    if (c < 32 || c == 127) return C1_CNTRL;
    if (c == 32) return C1_SPACE | C1_BLANK;
    if (c >= '0' && c <= '9') return C1_DIGIT | C1_XDIGIT;
    if (c >= 'A' && c <= 'Z') return (WORD)(C1_UPPER | C1_ALPHA | (c <= 'F' ? C1_XDIGIT : 0));
    if (c >= 'a' && c <= 'z') return (WORD)(C1_LOWER | C1_ALPHA | (c <= 'f' ? C1_XDIGIT : 0));
    return C1_PUNCT;
  }
  if (c < 0xa0) return C1_CNTRL;
  if (c == 0xa0) return C1_SPACE | C1_BLANK;
  if (c < 0x100) {
    if (c == 0xaa || c == 0xba || c == 0xb5) return C1_LOWER | C1_ALPHA;
    if (c >= 0xc0 && c != 0xd7 && c != 0xf7)
      return (WORD)((c <= 0xde ? C1_UPPER : C1_LOWER) | C1_ALPHA);
    return C1_PUNCT;
  }
  switch (c) {
  case 0x160:
  case 0x152:
  case 0x17d:
  case 0x178: return C1_UPPER | C1_ALPHA;
  case 0x161:
  case 0x153:
  case 0x17e:
  case 0x192: return C1_LOWER | C1_ALPHA;
  case 0x2c6:
  case 0x2dc: return C1_PUNCT;
  }
  if (c < 0x250) return C1_ALPHA;
  return c >= 0x2000 && c < 0x2c00 ? C1_PUNCT : 0;
}

static BOOL WINAPI GetStringTypeW(DWORD type, LPCWSTR src, int len, LPWORD out) {
  if (type != 1) fatal("GetStringTypeW: only CT_CTYPE1 is supported (type %u)", type);
  if (len < 0) len = wide_length(src) + 1;
  for (int i = 0; i < len; i++) out[i] = ctype1(src[i]);
  return TRUE;
}

static BOOL WINAPI GetStringTypeA(DWORD locale, DWORD type, LPCSTR src, int len, LPWORD out) {
  (void)locale;
  if (type != 1) fatal("GetStringTypeA: only CT_CTYPE1 is supported (type %u)", type);
  if (len < 0) len = (int)strlen(src) + 1;
  for (int i = 0; i < len; i++) out[i] = ctype1(byte_to_wide(1252, (BYTE)src[i]));
  return TRUE;
}

static WCHAR to_lower(WCHAR c) {
  if (c >= 'A' && c <= 'Z') return c + 32;
  if (c >= 0xc0 && c <= 0xde && c != 0xd7) return c + 32;
  if (c == 0x178) return 0xff;
  if (c == 0x160 || c == 0x152 || c == 0x17d) return c + 1;
  return c;
}

static WCHAR to_upper(WCHAR c) {
  if (c >= 'a' && c <= 'z') return c - 32;
  if (c >= 0xe0 && c <= 0xfe && c != 0xf7) return c - 32;
  if (c == 0xff) return 0x178;
  if (c == 0x161 || c == 0x153 || c == 0x17e) return c - 1;
  return c;
}

#define LCMAP_LOWERCASE 0x100
#define LCMAP_UPPERCASE 0x200

static WCHAR map_char(DWORD flags, WCHAR c) {
  if (flags & LCMAP_LOWERCASE) return to_lower(c);
  if (flags & LCMAP_UPPERCASE) return to_upper(c);
  return c;
}

static int WINAPI LCMapStringW(DWORD locale, DWORD flags, LPCWSTR src, int len, LPWSTR dst,
                               int dst_len) {
  (void)locale;
  if (len < 0) len = wide_length(src) + 1;
  if (dst_len == 0) return len;
  if (dst_len < len) {
    set_error(ERROR_INSUFFICIENT_BUFFER);
    return 0;
  }
  for (int i = 0; i < len; i++) dst[i] = map_char(flags, src[i]);
  return len;
}

static int WINAPI LCMapStringA(DWORD locale, DWORD flags, LPCSTR src, int len, LPSTR dst,
                               int dst_len) {
  (void)locale;
  if (len < 0) len = (int)strlen(src) + 1;
  if (dst_len == 0) return len;
  if (dst_len < len) {
    set_error(ERROR_INSUFFICIENT_BUFFER);
    return 0;
  }
  for (int i = 0; i < len; i++) {
    int b = wide_to_byte(1252, map_char(flags, byte_to_wide(1252, (BYTE)src[i])));
    dst[i] = (char)(b < 0 ? (BYTE)src[i] : b);
  }
  return len;
}

static LPSTR WINAPI lstrcpyA(LPSTR dst, LPCSTR src) { return strcpy(dst, src); }

/* Windows semantics: at most n-1 characters, always terminated. */
static LPSTR WINAPI lstrcpynA(LPSTR dst, LPCSTR src, int n) {
  if (n <= 0) return NULL;
  int i = 0;
  for (; i < n - 1 && src[i]; i++) dst[i] = src[i];
  dst[i] = 0;
  return dst;
}

static int WINAPI lstrlenA(LPCSTR s) { return s ? (int)strlen(s) : 0; }

/* ---- Environment and start-up ---- */

static const char environment[] = "PATH=C:\\WINDOWS\0windir=C:\\WINDOWS\0";

static LPSTR WINAPI GetEnvironmentStrings(void) { return (LPSTR)environment; }

static LPWSTR WINAPI GetEnvironmentStringsW(void) {
  static WCHAR wide[sizeof environment];
  if (!wide[0])
    for (size_t i = 0; i < sizeof environment; i++) wide[i] = (BYTE)environment[i];
  return wide;
}

static BOOL WINAPI FreeEnvironmentStringsA(LPSTR block) {
  (void)block;
  return TRUE;
}

static BOOL WINAPI FreeEnvironmentStringsW(LPWSTR block) {
  (void)block;
  return TRUE;
}

static DWORD WINAPI GetEnvironmentVariableA(LPCSTR name, LPSTR buf, DWORD size) {
  size_t len = strlen(name);
  for (const char *e = environment; *e; e += strlen(e) + 1)
    if (strncasecmp(e, name, len) == 0 && e[len] == '=') return copy_result(e + len + 1, buf, size);
  set_error(E_ENVVAR_NOT_FOUND);
  return 0;
}

typedef struct {
  DWORD cb;
  BYTE rest[64];
} STARTUPINFOA;
_Static_assert(sizeof(STARTUPINFOA) == 68, "STARTUPINFOA");

static void WINAPI GetStartupInfoA(STARTUPINFOA *si) {
  memset(si, 0, sizeof *si);
  si->cb = sizeof *si;
}

static UINT WINAPI SetHandleCount(UINT n) { return n; }

typedef struct {
  DWORD dwOSVersionInfoSize, dwMajorVersion, dwMinorVersion, dwBuildNumber, dwPlatformId;
  CHAR szCSDVersion[128];
} OSVERSIONINFOA;
_Static_assert(sizeof(OSVERSIONINFOA) == 148, "OSVERSIONINFOA");

static BOOL WINAPI GetVersionExA(OSVERSIONINFOA *vi) {
  if (vi->dwOSVersionInfoSize != sizeof *vi) {
    set_error(ERROR_INSUFFICIENT_BUFFER);
    return FALSE;
  }
  memset(vi->szCSDVersion, 0, sizeof vi->szCSDVersion);
  vi->dwMajorVersion = 5;
  vi->dwMinorVersion = 1;
  vi->dwBuildNumber = 2600;
  vi->dwPlatformId = 2;
  strcpy(vi->szCSDVersion, "Service Pack 3");
  return TRUE;
}

/* ---- Synchronisation ---- */

/* Events, mutexes and threads are one kind of object; all waits share one lock and condition
   variable. */
struct obj {
  enum handle_kind kind;
  int refs;
  int manual, signaled; /* events; threads: signaled when finished */
  pthread_t owner;      /* mutexes */
  int count;            /* mutex recursion count (0: free) */
  DWORD exit_code;      /* threads */
  char *name;           /* named objects are in `named` while a handle is open */
  struct obj *next_named;
};

static pthread_mutex_t sync_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t sync_cond;
static pthread_once_t sync_once = PTHREAD_ONCE_INIT;
static struct obj *named;
static int console_checked;

static void sync_init(void) {
  pthread_condattr_t attr;
  pthread_condattr_init(&attr);
  pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
  pthread_cond_init(&sync_cond, &attr);
}

static struct obj *obj_new(enum handle_kind kind) {
  pthread_once(&sync_once, sync_init);
  struct obj *o = calloc(1, sizeof *o);
  if (!o) fatal("out of memory");
  o->kind = kind;
  o->refs = 1;
  return o;
}

/* As on Windows, a named object goes away with its last handle (and its name with it: the
   game creates and closes "Robot32Command" before checking whether it already exists). */
static void obj_release(void *data) {
  struct obj *o = data;
  pthread_mutex_lock(&sync_lock);
  int gone = --o->refs == 0;
  if (gone && o->name)
    for (struct obj **p = &named; *p; p = &(*p)->next_named)
      if (*p == o) {
        *p = o->next_named;
        break;
      }
  pthread_mutex_unlock(&sync_lock);
  if (gone) {
    free(o->name);
    free(o);
  }
}

/* The named object `name` (sync_lock held). The first call also creates the console mutex when
   ROBOT_CONSOLE is set: the game turns its console on if "Robot32Command" already exists. */
static struct obj *find_named(const char *name) {
  if (!console_checked) {
    console_checked = 1;
    if (getenv("ROBOT_CONSOLE")) {
      struct obj *m = obj_new(HANDLE_MUTEX);
      m->name = strdup("Robot32Command");
      m->refs = 1; /* held for good, like the proxy holds it under Wine */
      m->next_named = named;
      named = m;
    }
  }
  for (struct obj *o = named; o; o = o->next_named)
    if (!strcmp(o->name, name)) return o;
  return NULL;
}

/* Creates (or opens, for a name already taken) an event or mutex; sets the last error. */
static HANDLE create_object(enum handle_kind kind, const char *name, int manual, int initial) {
  pthread_once(&sync_once, sync_init);
  pthread_mutex_lock(&sync_lock);
  struct obj *o = name ? find_named(name) : NULL;
  DWORD err = 0;
  if (o) {
    if (o->kind != kind) {
      pthread_mutex_unlock(&sync_lock);
      set_error(ERROR_INVALID_HANDLE);
      return NULL;
    }
    o->refs++;
    err = ERROR_ALREADY_EXISTS;
  } else {
    o = obj_new(kind);
    o->manual = manual;
    if (kind == HANDLE_EVENT) {
      o->signaled = initial;
    } else if (initial) {
      o->owner = pthread_self();
      o->count = 1;
    }
    if (name) {
      o->name = strdup(name);
      o->next_named = named;
      named = o;
    }
  }
  pthread_mutex_unlock(&sync_lock);
  set_error(err);
  return handle_new(kind, o, obj_release);
}

static HANDLE WINAPI CreateEventA(LPVOID security, BOOL manual, BOOL initial, LPCSTR name) {
  (void)security;
  return create_object(HANDLE_EVENT, name, manual, initial);
}

static HANDLE WINAPI CreateMutexA(LPVOID security, BOOL initial_owner, LPCSTR name) {
  (void)security;
  HANDLE h = create_object(HANDLE_MUTEX, name, 0, initial_owner);
  trace("CreateMutexA(\"%s\") -> error %u", name ? name : "", last_error);
  return h;
}

static BOOL WINAPI SetEvent(HANDLE h) {
  struct obj *o = handle_get(h, HANDLE_EVENT);
  if (!o) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  pthread_mutex_lock(&sync_lock);
  o->signaled = 1;
  pthread_cond_broadcast(&sync_cond);
  pthread_mutex_unlock(&sync_lock);
  return TRUE;
}

static BOOL WINAPI ResetEvent(HANDLE h) {
  struct obj *o = handle_get(h, HANDLE_EVENT);
  if (!o) {
    set_error(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  pthread_mutex_lock(&sync_lock);
  o->signaled = 0;
  pthread_mutex_unlock(&sync_lock);
  return TRUE;
}

static int obj_ready(const struct obj *o, pthread_t self) {
  if (o->kind == HANDLE_MUTEX) return o->count == 0 || pthread_equal(o->owner, self);
  return o->signaled;
}

static void obj_take(struct obj *o, pthread_t self) {
  if (o->kind == HANDLE_MUTEX) {
    o->owner = self;
    o->count++;
  } else if (o->kind == HANDLE_EVENT && !o->manual) {
    o->signaled = 0;
  }
}

#define WAIT_TIMEOUT 0x102u
#define WAIT_FAILED 0xffffffffu

static DWORD wait_objects(DWORD n, const HANDLE *handles, BOOL all, DWORD ms) {
  struct obj *objs[64];
  if (n == 0 || n > 64) {
    set_error(ERROR_INVALID_PARAMETER);
    return WAIT_FAILED;
  }
  for (DWORD i = 0; i < n; i++) {
    enum handle_kind k = handle_kind(handles[i]);
    objs[i] = (k == HANDLE_EVENT || k == HANDLE_MUTEX || k == HANDLE_THREAD)
                  ? handle_get(handles[i], k)
                  : NULL;
    if (!objs[i]) {
      if (handles[i] == (HANDLE)(intptr_t)-2) fatal("waiting on the current thread");
      set_error(ERROR_INVALID_HANDLE);
      return WAIT_FAILED;
    }
  }
  pthread_once(&sync_once, sync_init);
  pthread_t self = pthread_self();
  struct timespec deadline;
  if (ms != INFINITE && ms != 0) {
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += ms / 1000;
    deadline.tv_nsec += (long)(ms % 1000) * 1000000;
    if (deadline.tv_nsec >= 1000000000) {
      deadline.tv_sec++;
      deadline.tv_nsec -= 1000000000;
    }
  }
  DWORD result = WAIT_TIMEOUT;
  pthread_mutex_lock(&sync_lock);
  for (;;) {
    int hit = -1;
    if (all) {
      hit = 0;
      for (DWORD i = 0; i < n; i++)
        if (!obj_ready(objs[i], self)) hit = -1;
      if (hit == 0)
        for (DWORD i = 0; i < n; i++) obj_take(objs[i], self);
    } else {
      for (DWORD i = 0; i < n && hit < 0; i++)
        if (obj_ready(objs[i], self)) hit = (int)i;
      if (hit >= 0) obj_take(objs[hit], self);
    }
    if (hit >= 0) {
      result = (DWORD)hit; /* WAIT_OBJECT_0 + i */
      break;
    }
    if (ms == 0) break;
    if (ms == INFINITE)
      pthread_cond_wait(&sync_cond, &sync_lock);
    else if (pthread_cond_timedwait(&sync_cond, &sync_lock, &deadline) == ETIMEDOUT)
      break;
  }
  pthread_mutex_unlock(&sync_lock);
  return result;
}

static DWORD WINAPI WaitForSingleObject(HANDLE h, DWORD ms) {
  return wait_objects(1, &h, FALSE, ms);
}

static DWORD WINAPI WaitForMultipleObjects(DWORD n, const HANDLE *handles, BOOL all, DWORD ms) {
  return wait_objects(n, handles, all, ms);
}

/* CRITICAL_SECTION: the game's 24 bytes; the first field holds our recursive mutex. */
typedef struct {
  pthread_mutex_t *mutex;
  LONG lock_count, recursion_count;
  HANDLE owning_thread, lock_semaphore;
  ULONG spin_count;
} CRITICAL_SECTION;
_Static_assert(sizeof(CRITICAL_SECTION) == 24, "CRITICAL_SECTION");

static void WINAPI InitializeCriticalSection(CRITICAL_SECTION *cs) {
  pthread_mutexattr_t attr;
  pthread_mutex_t *m = malloc(sizeof *m);
  if (!m) fatal("out of memory");
  pthread_mutexattr_init(&attr);
  pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
  pthread_mutex_init(m, &attr);
  pthread_mutexattr_destroy(&attr);
  memset(cs, 0, sizeof *cs);
  cs->lock_count = -1;
  cs->mutex = m;
}

static pthread_mutex_t *cs_mutex(CRITICAL_SECTION *cs) {
  if (!cs->mutex) fatal("critical section %p used before InitializeCriticalSection", (void *)cs);
  return cs->mutex;
}

static void WINAPI EnterCriticalSection(CRITICAL_SECTION *cs) { pthread_mutex_lock(cs_mutex(cs)); }
static void WINAPI LeaveCriticalSection(CRITICAL_SECTION *cs) { pthread_mutex_unlock(cs_mutex(cs)); }

/* ---- Threads ---- */

struct thread_start {
  DWORD(WINAPI *fn)(LPVOID);
  LPVOID param;
  struct obj *obj;
};

static void *thread_main(void *arg) {
  struct thread_start ts = *(struct thread_start *)arg;
  free(arg);
  thread_enter();
  DWORD code = ts.fn(ts.param);
  pthread_mutex_lock(&sync_lock);
  ts.obj->exit_code = code;
  ts.obj->signaled = 1;
  pthread_cond_broadcast(&sync_cond);
  pthread_mutex_unlock(&sync_lock);
  obj_release(ts.obj);
  return NULL;
}

static HANDLE WINAPI CreateThread(LPVOID security, SIZE_T stack, DWORD(WINAPI *start)(LPVOID),
                                  LPVOID param, DWORD flags, LPDWORD id) {
  (void)security;
  static DWORD next_id = 1000;
  if (flags & 4) fatal("CreateThread(CREATE_SUSPENDED) is not supported");
  struct obj *o = obj_new(HANDLE_THREAD);
  o->refs = 2; /* the handle's and the running thread's */
  struct thread_start *ts = malloc(sizeof *ts);
  if (!ts) fatal("out of memory");
  ts->fn = start;
  ts->param = param;
  ts->obj = o;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_attr_setstacksize(&attr, stack > 0x100000 ? stack : 0x100000);
  pthread_t t;
  int rc = pthread_create(&t, &attr, thread_main, ts);
  pthread_attr_destroy(&attr);
  if (rc != 0) {
    free(ts);
    free(o);
    set_error(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (id) *id = __atomic_add_fetch(&next_id, 1, __ATOMIC_SEQ_CST);
  trace("CreateThread(start %p) started", (void *)start);
  return handle_new(HANDLE_THREAD, o, obj_release);
}

static HANDLE WINAPI GetCurrentThread(void) { return (HANDLE)(intptr_t)-2; }
static HANDLE WINAPI GetCurrentProcess(void) { return (HANDLE)(intptr_t)-1; }

static BOOL WINAPI SetThreadPriority(HANDLE thread, int priority) {
  (void)thread;
  (void)priority;
  return TRUE;
}

/* ---- Time ---- */

static void WINAPI Sleep(DWORD ms) {
  if (ms == 0) {
    sched_yield();
    return;
  }
  if (ms == INFINITE)
    for (;;) pause();
  struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000};
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
}

static void WINAPI GetLocalTime(SYSTEMTIME *st) {
  struct timespec ts;
  struct tm tm;
  clock_gettime(CLOCK_REALTIME, &ts);
  time_t secs = ts.tv_sec;
  localtime_r(&secs, &tm);
  st->wYear = (WORD)(tm.tm_year + 1900);
  st->wMonth = (WORD)(tm.tm_mon + 1);
  st->wDayOfWeek = (WORD)tm.tm_wday;
  st->wDay = (WORD)tm.tm_mday;
  st->wHour = (WORD)tm.tm_hour;
  st->wMinute = (WORD)tm.tm_min;
  st->wSecond = (WORD)tm.tm_sec;
  st->wMilliseconds = (WORD)(ts.tv_nsec / 1000000);
}

static BOOL WINAPI QueryPerformanceFrequency(LARGE_INTEGER *f) {
  f->QuadPart = 1000000;
  return TRUE;
}

static BOOL WINAPI QueryPerformanceCounter(LARGE_INTEGER *c) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  c->QuadPart = (LONGLONG)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
  return TRUE;
}

/* ---- Resources ---- */

#define RES_HIGH 0x80000000u

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

/* Looks `key` (id, "#id" or name) up in the resource directory at `dir`; returns the entry's
   offset field (high bit: a subdirectory) or 0 if absent. */
static DWORD res_entry(const BYTE *root, DWORD root_size, DWORD dir, LPCSTR key) {
  if (dir + 16 > root_size) return 0;
  long id = -1;
  if ((uintptr_t)key < 0x10000) {
    id = (long)(uintptr_t)key;
  } else if (key[0] == '#') {
    char *end;
    long v = strtol(key + 1, &end, 10);
    if (end != key + 1 && !*end) id = v;
  }
  int named_count = rd16(root + dir + 12), id_count = rd16(root + dir + 14);
  if (dir + 16 + 8u * (DWORD)(named_count + id_count) > root_size) return 0;
  const BYTE *entries = root + dir + 16;
  for (int i = 0; i < named_count + id_count; i++) {
    DWORD name = rd32(entries + 8 * i), data = rd32(entries + 8 * i + 4);
    if (id >= 0) {
      if (i >= named_count && name == (DWORD)id) return data;
      continue;
    }
    if (i >= named_count || !(name & RES_HIGH)) continue;
    DWORD off = name & ~RES_HIGH;
    if (off + 2 > root_size) continue;
    size_t len = rd16(root + off);
    if (off + 2 + 2 * len > root_size || len != strlen(key)) continue;
    size_t k = 0;
    for (; k < len; k++) {
      WORD c = rd16(root + off + 2 + 2 * k);
      if (c > 0x7f || tolower((int)c) != tolower((unsigned char)key[k])) break;
    }
    if (k == len) return data;
  }
  return 0;
}

/* The IMAGE_RESOURCE_DATA_ENTRY for type/name, first language; sets `error` if absent. */
static const BYTE *res_lookup(LPCSTR type, LPCSTR name, DWORD *error) {
  const BYTE *image = (const BYTE *)(uintptr_t)IMAGE_BASE;
  const BYTE *opt = image + rd32(image + 0x3c) + 24;
  DWORD rva = rd32(opt + 96 + 16), size = rd32(opt + 96 + 20);
  *error = E_RES_TYPE;
  if (!rva) return NULL;
  const BYTE *root = image + rva;
  DWORD t = res_entry(root, size, 0, type);
  if (!t || !(t & RES_HIGH)) return NULL;
  *error = E_RES_NAME;
  DWORD n = res_entry(root, size, t & ~RES_HIGH, name);
  if (!n || !(n & RES_HIGH)) return NULL;
  DWORD lang = n & ~RES_HIGH;
  if (lang + 16 > size || rd16(root + lang + 12) + rd16(root + lang + 14) == 0) return NULL;
  DWORD data = rd32(root + lang + 16 + 4);
  if ((data & RES_HIGH) || data + 16 > size) return NULL;
  return root + data;
}

static void describe(char *buf, size_t size, LPCSTR key) {
  if ((uintptr_t)key < 0x10000)
    snprintf(buf, size, "#%u", (unsigned)(uintptr_t)key);
  else
    snprintf(buf, size, "\"%s\"", key);
}

/* Note the argument order: name before type. */
static HRSRC WINAPI FindResourceA(HMODULE module, LPCSTR name, LPCSTR type) {
  DWORD error = E_RES_TYPE;
  const BYTE *entry = NULL;
  if (!module || (uintptr_t)module == IMAGE_BASE) entry = res_lookup(type, name, &error);
  if (!entry) {
    char t[80], n[80];
    describe(t, sizeof t, type);
    describe(n, sizeof n, name);
    trace("FindResourceA(type %s, name %s) not found", t, n);
    set_error(error);
  }
  return (HRSRC)entry;
}

const void *resource_find(LPCSTR type, LPCSTR name, DWORD *size) {
  DWORD error;
  const BYTE *entry = res_lookup(type, name, &error);
  if (!entry) return NULL;
  if (size) *size = rd32(entry + 4);
  return (const BYTE *)(uintptr_t)IMAGE_BASE + rd32(entry);
}

static HGLOBAL WINAPI LoadResource(HMODULE module, HRSRC res) {
  (void)module;
  return res ? (HGLOBAL)((const BYTE *)(uintptr_t)IMAGE_BASE + rd32(res)) : NULL;
}

static LPVOID WINAPI LockResource(HGLOBAL h) { return h; }

static DWORD WINAPI SizeofResource(HMODULE module, HRSRC res) {
  (void)module;
  return res ? rd32((const BYTE *)res + 4) : 0;
}

/* ---- Process end and exceptions ---- */

__attribute__((noreturn)) static void WINAPI ExitProcess(UINT code) {
  fflush(NULL);
  exit((int)code);
}

static BOOL WINAPI TerminateProcess(HANDLE process, UINT code) {
  if (process != (HANDLE)(intptr_t)-1) fatal("TerminateProcess on another process");
  ExitProcess(code);
}

typedef LONG(WINAPI *TOP_LEVEL_FILTER)(LPVOID);
static TOP_LEVEL_FILTER unhandled_filter;

static TOP_LEVEL_FILTER WINAPI SetUnhandledExceptionFilter(TOP_LEVEL_FILTER filter) {
  TOP_LEVEL_FILTER old = unhandled_filter;
  unhandled_filter = filter;
  return old;
}

static LONG WINAPI UnhandledExceptionFilter(LPVOID info) {
  (void)info;
  return 0; /* EXCEPTION_CONTINUE_SEARCH */
}

static void WINAPI RaiseException(DWORD code, DWORD flags, DWORD n, const DWORD *args) {
  (void)flags;
  (void)n;
  (void)args;
  fatal("the game raised exception 0x%08x (from %p)", code, __builtin_return_address(0));
}

static void WINAPI RtlUnwind(LPVOID frame, LPVOID target, LPVOID record, LPVOID value) {
  (void)frame;
  (void)target;
  (void)record;
  (void)value;
  fatal("RtlUnwind is not supported (called from %p)", __builtin_return_address(0));
}

/* ---- Exports ---- */

#define X(name) {#name, (void *)name}
const struct export kernel32_exports[] = {
    X(CloseHandle), X(CreateDirectoryA), X(CreateEventA), X(CreateFileA), X(CreateMutexA),
    X(CreateThread), X(DeleteFileA), X(EnterCriticalSection), X(ExitProcess),
    X(FileTimeToLocalFileTime), X(FileTimeToSystemTime), X(FindClose), X(FindFirstFileA),
    X(FindNextFileA), X(FindResourceA), X(FlushFileBuffers), X(FreeEnvironmentStringsA),
    X(FreeEnvironmentStringsW), X(FreeLibrary), X(GetACP), X(GetCommandLineA), X(GetCPInfo),
    X(GetCurrentDirectoryA), X(GetCurrentProcess), X(GetCurrentThread), X(GetEnvironmentStrings),
    X(GetEnvironmentStringsW), X(GetEnvironmentVariableA), X(GetFileInformationByHandle),
    X(GetFileTime), X(GetFileType), X(GetLastError), X(GetLocalTime), X(GetModuleFileNameA),
    X(GetModuleHandleA), X(GetOEMCP), X(GetProcAddress), X(GetStartupInfoA), X(GetStdHandle),
    X(GetStringTypeA), X(GetStringTypeW), X(GetSystemDirectoryA), X(GetVersion), X(GetVersionExA),
    X(GlobalAlloc), X(GlobalLock), X(GlobalMemoryStatus), X(GlobalUnlock), X(HeapAlloc),
    X(HeapCreate), X(HeapDestroy), X(HeapFree), X(HeapReAlloc), X(InitializeCriticalSection),
    X(IsBadCodePtr), X(IsBadReadPtr), X(IsBadWritePtr), X(LCMapStringA), X(LCMapStringW),
    X(LeaveCriticalSection), X(LoadLibraryA), X(LoadResource), X(LocalAlloc), X(LocalFree),
    X(LockResource), X(lstrcpyA), X(lstrcpynA), X(lstrlenA), X(MultiByteToWideChar),
    X(QueryPerformanceCounter), X(QueryPerformanceFrequency), X(RaiseException), X(ReadFile),
    X(ResetEvent), X(RtlUnwind), X(SetEvent), X(SetFilePointer), X(SetHandleCount), X(SetStdHandle),
    X(SetThreadPriority), X(SetUnhandledExceptionFilter), X(SizeofResource), X(Sleep),
    X(TerminateProcess), X(UnhandledExceptionFilter), X(VirtualAlloc), X(VirtualFree),
    X(WaitForMultipleObjects), X(WaitForSingleObject), X(WideCharToMultiByte), X(WriteFile),
    {NULL, NULL}};
