/* ADVAPI32: the registry, kept in memory and in a text file in Wine's .reg style
   ($ROBOT_REGISTRY, else $XDG_CONFIG_HOME/robot/registry.reg, else ~/.config/robot/...).
   Loaded at the first registry call, written whole after every change. */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include "wrapper.h"

#define ERROR_MORE_DATA 234
#define REG_CREATED_NEW_KEY 1
#define REG_OPENED_EXISTING_KEY 2

struct value {
  char *name; /* "" is the default value */
  DWORD type;
  BYTE *data;
  DWORD size;
};

struct key {
  char *path; /* "HKEY_CURRENT_USER\Software\..." */
  struct value *values;
  size_t count;
};

static struct key *keys;
static size_t key_count;
static int loaded;

static const char *const root_names[] = {"HKEY_CLASSES_ROOT", "HKEY_CURRENT_USER",
                                         "HKEY_LOCAL_MACHINE"};

/* ---- paths ---- */

/* "ROOT\sub" with runs of backslashes (and a leading/trailing one) in `sub` collapsed. */
static char *join_path(const char *root, const char *sub) {
  size_t n = strlen(root);
  char *p = malloc(n + strlen(sub) + 2);
  memcpy(p, root, n);
  for (const char *s = sub; *s;) {
    if (*s == '\\') {
      s++;
      continue;
    }
    if (n) p[n++] = '\\';
    while (*s && *s != '\\') p[n++] = *s++;
  }
  p[n] = 0;
  return p;
}

static struct key *find_key(const char *path) {
  for (size_t i = 0; i < key_count; i++)
    if (strcasecmp(keys[i].path, path) == 0) return &keys[i];
  return NULL;
}

/* Makes the key and its parents; *created tells if the key itself was new. keys[] may move. */
static void ensure_key(const char *path, int *created) {
  if (created) *created = 0;
  for (size_t len = 0;;) {
    const char *slash = strchr(path + len, '\\');
    size_t end = slash ? (size_t)(slash - path) : strlen(path);
    char *part = strndup(path, end);
    if (!find_key(part)) {
      keys = realloc(keys, (key_count + 1) * sizeof *keys);
      keys[key_count++] = (struct key){part, NULL, 0};
      if (!slash && created) *created = 1;
    } else
      free(part);
    if (!slash) return;
    len = end + 1;
  }
}

static struct value *find_value(struct key *k, const char *name) {
  for (size_t i = 0; i < k->count; i++)
    if (strcasecmp(k->values[i].name, name) == 0) return &k->values[i];
  return NULL;
}

static void store_value(struct key *k, const char *name, DWORD type, const BYTE *data,
                        DWORD size) {
  struct value *v = find_value(k, name);
  if (!v) {
    k->values = realloc(k->values, (k->count + 1) * sizeof *k->values);
    v = &k->values[k->count++];
    v->name = strdup(name);
    v->data = NULL;
  }
  free(v->data);
  v->type = type;
  v->size = size;
  v->data = malloc(size ? size : 1);
  memcpy(v->data, data, size);
}

/* ---- the file ---- */

static char *registry_file(void) {
  const char *env = getenv("ROBOT_REGISTRY");
  char *p;
  if (env && *env) return strdup(env);
  const char *xdg = getenv("XDG_CONFIG_HOME"), *home = getenv("HOME");
  int n = xdg && *xdg ? asprintf(&p, "%s/robot/registry.reg", xdg)
                      : asprintf(&p, "%s/.config/robot/registry.reg", home ? home : ".");
  if (n < 0) fatal("out of memory");
  return p;
}

static void make_dirs(const char *file) {
  char *dir = strdup(file);
  for (char *s = dir + 1; *s; s++) {
    if (*s != '/') continue;
    *s = 0;
    mkdir(dir, 0777);
    *s = '/';
  }
  free(dir);
}

/* Can the value be written as a "string"? Else it goes out as hex. */
static int text_value(const struct value *v) {
  if (v->type != 1 || v->size == 0 || v->data[v->size - 1] != 0) return 0;
  for (DWORD i = 0; i + 1 < v->size; i++)
    if (v->data[i] < 0x20 || v->data[i] == 0x7f) return 0;
  return 1;
}

static void put_quoted(FILE *f, const BYTE *s, size_t n) {
  fputc('"', f);
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '\\' || s[i] == '"') fputc('\\', f);
    fputc(s[i], f);
  }
  fputc('"', f);
}

static void write_keys(FILE *f) {
  fputs("; The game's registry in Wine .reg style; strings are Windows-1252 bytes\n", f);
  for (size_t i = 0; i < key_count; i++) {
    const struct key *k = &keys[i];
    if (!strchr(k->path, '\\') && !k->count) continue; /* an empty root */
    fprintf(f, "\n[%s]\n", k->path);
    for (size_t j = 0; j < k->count; j++) {
      const struct value *v = &k->values[j];
      if (*v->name)
        put_quoted(f, (const BYTE *)v->name, strlen(v->name));
      else
        fputc('@', f);
      fputc('=', f);
      if (text_value(v)) {
        put_quoted(f, v->data, v->size - 1);
      } else if (v->type == 4 && v->size == 4) {
        fprintf(f, "dword:%08x",
                v->data[0] | v->data[1] << 8 | v->data[2] << 16 | (unsigned)v->data[3] << 24);
      } else {
        if (v->type == 3)
          fputs("hex:", f);
        else
          fprintf(f, "hex(%x):", v->type);
        for (DWORD b = 0; b < v->size; b++) fprintf(f, b ? ",%02x" : "%02x", v->data[b]);
      }
      fputc('\n', f);
    }
  }
}

/* Whole file to a temp file, then renamed over it: a crash leaves the old one. */
static void save(void) {
  char *path = registry_file(), *tmp;
  if (asprintf(&tmp, "%s.tmp", path) < 0) fatal("out of memory");
  make_dirs(path);
  FILE *f = fopen(tmp, "wb");
  if (!f) {
    say("robot: cannot write the registry %s: %s", tmp, strerror(errno));
  } else {
    write_keys(f);
    if (fflush(f) != 0 || ferror(f) || fsync(fileno(f)) != 0) {
      say("robot: cannot write the registry %s: %s", tmp, strerror(errno));
      fclose(f);
      unlink(tmp);
    } else {
      fclose(f);
      if (rename(tmp, path) != 0)
        say("robot: cannot write the registry %s: %s", path, strerror(errno));
      else
        trace("registry: wrote %s", path);
    }
  }
  free(tmp);
  free(path);
}

/* A quoted string at *p (after the opening quote), unescaped into a malloc'd buffer with a
   NUL after it; leaves *p after the closing quote. Escapes: \\ \" and Wine's \xHHHH (one
   byte, '?' beyond Latin-1). */
static BYTE *parse_quoted(const char **p, size_t *len) {
  const char *s = *p;
  BYTE *out = malloc(strlen(s) + 1);
  size_t n = 0;
  while (*s && *s != '"') {
    if (*s == '\\' && s[1]) {
      s++;
      if (*s == 'x' && isxdigit((unsigned char)s[1])) {
        unsigned v = 0;
        int digits = 0;
        s++;
        for (; digits < 4 && isxdigit((unsigned char)*s); s++, digits++)
          v = v * 16 + (unsigned)(*s <= '9' ? *s - '0' : (*s | 32) - 'a' + 10);
        out[n++] = v < 0x100 ? (BYTE)v : '?';
        continue;
      }
    }
    out[n++] = (BYTE)*s++;
  }
  if (*s == '"') s++;
  out[n] = 0;
  *p = s;
  if (len) *len = n;
  return out;
}

static void parse_value(struct key *k, const char *line) {
  const char *p = line;
  BYTE *name;
  if (*p == '@') {
    name = (BYTE *)strdup("");
    p++;
  } else {
    p++;
    name = parse_quoted(&p, NULL);
  }
  if (*p++ != '=') {
    free(name);
    return;
  }
  if (*p == '"') {
    size_t n;
    p++;
    BYTE *s = parse_quoted(&p, &n);
    store_value(k, (char *)name, 1, s, (DWORD)n + 1); /* s[n] is the NUL */
    free(s);
  } else if (strncasecmp(p, "dword:", 6) == 0) {
    DWORD v = (DWORD)strtoul(p + 6, NULL, 16);
    BYTE b[4] = {(BYTE)v, (BYTE)(v >> 8), (BYTE)(v >> 16), (BYTE)(v >> 24)};
    store_value(k, (char *)name, 4, b, 4);
  } else if (strncasecmp(p, "hex", 3) == 0) {
    DWORD type = 3;
    p += 3;
    if (*p == '(') {
      char *end;
      type = (DWORD)strtoul(p + 1, &end, 16);
      p = end + (*end == ')');
    }
    if (*p++ == ':') {
      BYTE *b = malloc(strlen(p) / 2 + 1);
      DWORD n = 0;
      for (;;) {
        while (*p == ',' || *p == ' ' || *p == '\t') p++;
        if (!isxdigit((unsigned char)*p)) break;
        b[n++] = (BYTE)strtoul((char[3]){p[0], p[1], 0}, NULL, 16);
        p += isxdigit((unsigned char)p[1]) ? 2 : 1;
      }
      store_value(k, (char *)name, type, b, n);
      free(b);
    }
  }
  free(name);
}

/* "[HKEY_CURRENT_USER\a\b] 17000" or Wine's "[Software\\a] 17000" (no root: HKCU), as a
   malloc'd full path. */
static char *parse_header(char *line) {
  char *end = strrchr(line, ']');
  if (!end) return NULL;
  *end = 0;
  char *inner = join_path("x", line + 1); /* collapses backslashes; "x\" prefix dropped below */
  char *rest = inner + (inner[1] ? 2 : 1);
  char *full = strncasecmp(rest, "HKEY_", 5) == 0 ? strdup(rest)
                                                  : join_path("HKEY_CURRENT_USER", rest);
  free(inner);
  return full;
}

#define IMPORT_PREFIX "HKEY_CURRENT_USER\\Software\\TOM-Productions\\Robot"

/* Reads a .reg file; `only` (a path) limits it to that key and its subkeys. */
static int read_reg(const char *file, const char *only) {
  FILE *f = fopen(file, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  rewind(f);
  char *text = malloc((size_t)size + 1);
  size = (long)fread(text, 1, (size_t)size, f);
  text[size] = 0;
  fclose(f);

  struct key *cur = NULL;
  size_t values = 0, only_len = only ? strlen(only) : 0;
  char *joined = NULL; /* a hex line gathered over backslash continuations */
  size_t joined_size = 0;
  char *save_ptr = NULL;
  for (char *line = strtok_r(text, "\n", &save_ptr); line; line = strtok_r(NULL, "\n", &save_ptr)) {
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
    if (n && line[n - 1] == '\\' && (joined || (*line != '[' && strstr(line, "hex")))) {
      joined = realloc(joined, joined_size + n);
      memcpy(joined + joined_size, line, n - 1);
      joined_size += n - 1;
      joined[joined_size] = 0;
      continue;
    }
    if (joined) {
      joined = realloc(joined, joined_size + n + 1);
      memcpy(joined + joined_size, line, n + 1);
      line = joined;
    }
    if (*line == '[') {
      char *path = parse_header(line);
      cur = NULL;
      if (path && (!only || (strncasecmp(path, only, only_len) == 0 &&
                             (!path[only_len] || path[only_len] == '\\')))) {
        ensure_key(path, NULL);
        cur = find_key(path);
      }
      free(path);
    } else if (cur && (*line == '"' || *line == '@')) {
      parse_value(cur, line);
      values++;
    }
    free(joined);
    joined = NULL, joined_size = 0;
  }
  free(text);
  trace("registry: read %s (%zu keys, %zu values)", file, key_count, values);
  return 1;
}

static void load(void) {
  if (loaded) return;
  loaded = 1;
  char *file = registry_file();
  if (!read_reg(file, NULL)) {
    const char *imp = getenv("ROBOT_IMPORT_REG");
    if (imp && *imp && read_reg(imp, IMPORT_PREFIX))
      trace("registry: imported from %s", imp);
    else
      trace("registry: %s does not exist yet", file);
  }
  free(file);
}

/* ---- keys and handles ---- */

/* The game's key handles: a list of the live ones, so a handle is checked before it is used
   (handle_get(HANDLE_OTHER) might also give another module's data). */
struct key_ref {
  struct key_ref *next;
  char *path;
};
static struct key_ref *refs;

static void ref_free(void *data) {
  struct key_ref *r = data;
  for (struct key_ref **p = &refs; *p; p = &(*p)->next)
    if (*p == r) {
      *p = r->next;
      break;
    }
  free(r->path);
  free(r);
}

static int is_root(HKEY h) {
  uintptr_t v = (uintptr_t)h;
  return v >= 0x80000000u && v <= 0x80000002u;
}

/* The full path of an open key handle or predefined root, or NULL. */
static const char *key_path(HKEY h) {
  if (is_root(h)) return root_names[(uintptr_t)h - 0x80000000u];
  struct key_ref *r = handle_get(h, HANDLE_OTHER);
  for (struct key_ref *p = refs; p; p = p->next)
    if (p == r) return r->path;
  return NULL;
}

static HKEY new_ref(const char *path) {
  struct key_ref *r = malloc(sizeof *r);
  r->path = strdup(path);
  r->next = refs;
  refs = r;
  return handle_new(HANDLE_OTHER, r, ref_free);
}

static LONG WINAPI RegOpenKeyExA(HKEY key, LPCSTR sub, DWORD options, DWORD access, HKEY *out) {
  (void)options, (void)access;
  load();
  const char *base = key_path(key);
  if (!base) return ERROR_INVALID_HANDLE;
  char *path = join_path(base, sub ? sub : "");
  struct key *k = find_key(path);
  LONG result = ERROR_FILE_NOT_FOUND;
  if (k || !strchr(path, '\\')) { /* the roots exist without being created */
    *out = new_ref(k ? k->path : path);
    result = ERROR_SUCCESS;
  }
  trace("RegOpenKeyExA %s: %s", path, result ? "not found" : "ok");
  free(path);
  return result;
}

static LONG WINAPI RegCreateKeyExA(HKEY key, LPCSTR sub, DWORD reserved, LPSTR cls, DWORD options,
                                   DWORD access, void *security, HKEY *out, DWORD *disposition) {
  (void)reserved, (void)cls, (void)options, (void)access, (void)security;
  load();
  const char *base = key_path(key);
  if (!base) return ERROR_INVALID_HANDLE;
  char *path = join_path(base, sub ? sub : "");
  int created;
  ensure_key(path, &created);
  *out = new_ref(find_key(path)->path);
  if (disposition) *disposition = created ? REG_CREATED_NEW_KEY : REG_OPENED_EXISTING_KEY;
  trace("RegCreateKeyExA %s: %s", path, created ? "created" : "existing");
  free(path);
  if (created) save();
  return ERROR_SUCCESS;
}

static LONG WINAPI RegQueryValueExA(HKEY key, LPCSTR name, DWORD *reserved, DWORD *type,
                                    BYTE *data, DWORD *size) {
  (void)reserved;
  load();
  const char *path = key_path(key);
  if (!path) return ERROR_INVALID_HANDLE;
  struct key *k = find_key(path);
  struct value *v = k ? find_value(k, name ? name : "") : NULL;
  if (!v) {
    trace("RegQueryValueExA %s\\%s: not found", path, name ? name : "");
    return ERROR_FILE_NOT_FOUND;
  }
  if (type) *type = v->type;
  if (data && !size) return ERROR_INVALID_PARAMETER;
  LONG result = ERROR_SUCCESS;
  if (data) {
    if (*size < v->size)
      result = ERROR_MORE_DATA;
    else
      memcpy(data, v->data, v->size);
  }
  if (size) *size = v->size;
  trace("RegQueryValueExA %s\\%s: type %u, %u bytes%s", path, v->name, v->type, v->size,
        result ? " (buffer too small)" : "");
  return result;
}

static LONG WINAPI RegSetValueExA(HKEY key, LPCSTR name, DWORD reserved, DWORD type,
                                  const BYTE *data, DWORD size) {
  (void)reserved;
  load();
  const char *path = key_path(key);
  if (!path) return ERROR_INVALID_HANDLE;
  ensure_key(path, NULL); /* a root holding values */
  store_value(find_key(path), name ? name : "", type, data, size);
  trace("RegSetValueExA %s\\%s: type %u, %u bytes", path, name ? name : "", type, size);
  save();
  return ERROR_SUCCESS;
}

static LONG WINAPI RegCloseKey(HKEY key) {
  if (is_root(key)) return ERROR_SUCCESS;
  return key_path(key) && handle_close(key) ? ERROR_SUCCESS : ERROR_INVALID_HANDLE;
}

const struct export misc_advapi32_exports[] = {
    {"RegCloseKey", RegCloseKey},       {"RegCreateKeyExA", RegCreateKeyExA},
    {"RegOpenKeyExA", RegOpenKeyExA},   {"RegQueryValueExA", RegQueryValueExA},
    {"RegSetValueExA", RegSetValueExA}, {NULL, NULL},
};
