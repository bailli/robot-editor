/* --settings and --set NAME=VALUE: the game's settings (its registry values under
   HKCU\Software\TOM-Productions\Robot) listed and written from the command line, through the
   wrapper's own registry (registry.c), so nobody needs to edit the file by hand. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "wrapper.h"

#define HKEY_CURRENT_USER ((HKEY)(uintptr_t)0x80000001u)
#define REG_SZ 1
#define REG_DWORD 4
#define ROBOT_KEY "Software\\TOM-Productions\\Robot"
#define WRAPPER_KEY "Software\\robot-wrapper"

static const struct setting {
  const char *name;
  DWORD type;
  const char *fallback; /* what the game uses when the value is missing */
  const char *meaning;
  const char *key; /* NULL: the game's */
} settings[] = {
    {"SampleRate", REG_DWORD, "32000 (44100 on fast machines)",
     "sound output rate: 0 no sound, 22050, 32000, 44100", NULL},
    {"AudioVolume", REG_DWORD, "230", "volume, 0-255 (used as 10-250)", NULL},
    {"DisableOpl", REG_DWORD, "0", "1: no AdLib emulation, PC speaker sound only", NULL},
    {"NoMusic", REG_DWORD, "0", "1: no background music (Alt+M)", NULL},
    {"NoEffects", REG_DWORD, "0", "1: no sound effects (Alt+E)", NULL},
    {"NoSound", REG_DWORD, "0", "1: no walking sounds (Alt+S)", NULL},
    {"DoorNumbers", REG_DWORD, "0", "1: door numbers instead of colours (Alt+T)", NULL},
    {"GoldWarn", REG_DWORD, "1", "1: gold and wood warnings (Alt+W)", NULL},
    {"AltShapes", REG_DWORD, "0", "1: alternative graphics in Junior, I and II (Alt+G)", NULL},
    {"AltBeam", REG_DWORD, "1", "1: alternative electric beam (Alt+B)", NULL},
    {"NestWarn", REG_DWORD, "1", "1: hiding place warner in III and IV (Alt+V)", NULL},
    {"FullScreen", REG_DWORD, "0", "1: start in fullscreen (Alt+Enter)", NULL},
    {"UseTrueColor", REG_DWORD, "1", "1: fullscreen in 32 bits (0 asks for 8, refused here)", NULL},
    {"Force640x480", REG_DWORD, "0", "1: fullscreen mode 640 x 480 instead of 640 x 400", NULL},
    {"MinimizeToTray", REG_DWORD, "0", "1: F11 minimizes (to the tray on Windows)", NULL},
    {"CurrentEpisode", REG_DWORD, "0", "the episode chosen last: 0 Junior, 1-4 I-IV", NULL},
    {"WndScaleX", REG_DWORD, "-", "the game's window scaling, horizontal (untested)", NULL},
    {"WndScaleY", REG_DWORD, "-", "the game's window scaling, vertical (untested)", NULL},
    {"Licensee", REG_SZ, "-", "the registered licensee's name", NULL},
    {"RessourcePath", REG_SZ, "-", "a folder with loose .CRN text files the game asks to use", NULL},
    {"Volume", REG_DWORD, "100", "the wrapper's volume in percent (Ctrl+Shift+Up/Down)",
     WRAPPER_KEY},
    {"Mute", REG_DWORD, "0", "1: the wrapper's sound muted (Ctrl+Shift+M)", WRAPPER_KEY},
};

typedef LONG(WINAPI *create_fn)(HKEY, LPCSTR, DWORD, LPSTR, DWORD, DWORD, void *, HKEY *, DWORD *);
typedef LONG(WINAPI *query_fn)(HKEY, LPCSTR, DWORD *, DWORD *, BYTE *, DWORD *);
typedef LONG(WINAPI *set_fn)(HKEY, LPCSTR, DWORD, DWORD, const BYTE *, DWORD);
typedef LONG(WINAPI *close_fn)(HKEY);

static HKEY open_key(const char *path) {
  create_fn create = (create_fn)find_export("advapi32.dll", "RegCreateKeyExA");
  HKEY key = NULL;
  DWORD disposition;
  if (create(HKEY_CURRENT_USER, path, 0, NULL, 0, 0xf003f, NULL, &key, &disposition) != 0)
    return NULL;
  return key;
}

static void close_key(HKEY key) { ((close_fn)find_export("advapi32.dll", "RegCloseKey"))(key); }

/* Code page 1252 to UTF-8 for the terminal (Latin-1 is enough for names). */
static void print_latin1(const BYTE *s, DWORD n) {
  for (DWORD i = 0; i < n && s[i]; i++) {
    if (s[i] < 0x80)
      putchar(s[i]);
    else
      printf("%c%c", 0xc0 | s[i] >> 6, 0x80 | (s[i] & 0x3f));
  }
}

int settings_list(void) {
  query_fn query = (query_fn)find_export("advapi32.dll", "RegQueryValueExA");
  char *path = registry_path();
  printf("Settings in %s (game default in brackets):\n\n", path);
  free(path);
  for (size_t i = 0; i < sizeof settings / sizeof *settings; i++) {
    const struct setting *s = &settings[i];
    BYTE data[512];
    DWORD type = 0, size = sizeof data - 1;
    HKEY key = open_key(s->key ? s->key : ROBOT_KEY);
    if (!key) return 1;
    LONG found = query(key, s->name, NULL, &type, data, &size);
    close_key(key);
    if (s->key && (i == 0 || !settings[i - 1].key))
      printf("\nThe wrapper's own (HKEY_CURRENT_USER\\%s):\n\n", s->key);
    printf("  %-15s ", s->name);
    if (found == 0) {
      if (type == REG_DWORD && size == 4) {
        DWORD v;
        memcpy(&v, data, 4);
        printf("%-10u", v);
      } else {
        data[size] = 0;
        putchar('"');
        print_latin1(data, size);
        printf("\"  ");
      }
    } else {
      printf("%-10s", "-");
    }
    printf(" [%s] %s\n", s->fallback, s->meaning);
  }
  return 0;
}

/* NAME=VALUE: a number for the DWORD settings (decimal or 0x hex), text for the others
   (UTF-8 from the command line, kept in code page 1252 as the game reads it). */
int settings_set(const char *assignment) {
  const char *eq = strchr(assignment, '=');
  if (!eq || eq == assignment) {
    fprintf(stderr, "robot: --set wants NAME=VALUE, not \"%s\"\n", assignment);
    return 1;
  }
  size_t n = (size_t)(eq - assignment);
  const struct setting *s = NULL;
  for (size_t i = 0; i < sizeof settings / sizeof *settings; i++)
    if (strlen(settings[i].name) == n && strncasecmp(settings[i].name, assignment, n) == 0)
      s = &settings[i];
  if (!s) {
    fprintf(stderr, "robot: no setting \"%.*s\" (see --settings)\n", (int)n, assignment);
    return 1;
  }
  const char *text = eq + 1;
  BYTE data[512];
  DWORD size;
  if (s->type == REG_DWORD) {
    char *end;
    unsigned long v = strtoul(text, &end, 0);
    if (!*text || *end) {
      fprintf(stderr, "robot: %s wants a number, not \"%s\"\n", s->name, text);
      return 1;
    }
    DWORD d = (DWORD)v;
    memcpy(data, &d, 4);
    size = 4;
  } else {
    size = 0;
    for (const BYTE *p = (const BYTE *)text; *p && size < sizeof data - 1;) {
      unsigned c = *p++;
      if (c >= 0xc0 && c < 0xe0 && (*p & 0xc0) == 0x80) c = (c & 0x1f) << 6 | (*p++ & 0x3f);
      if (c >= 0x100) {
        fprintf(stderr, "robot: %s: only Latin-1 characters fit\n", s->name);
        return 1;
      }
      data[size++] = (BYTE)c;
    }
    data[size++] = 0;
  }
  HKEY key = open_key(s->key ? s->key : ROBOT_KEY);
  if (!key) return 1;
  set_fn set = (set_fn)find_export("advapi32.dll", "RegSetValueExA");
  LONG result = set(key, s->name, 0, s->type, data, size);
  close_key(key);
  if (result != 0) {
    fprintf(stderr, "robot: could not write %s (error %d)\n", s->name, result);
    return 1;
  }
  printf("%s=%s\n", s->name, text);
  return 0;
}

DWORD wrapper_setting(const char *name, DWORD fallback) {
  HKEY key = open_key(WRAPPER_KEY);
  if (!key) return fallback;
  DWORD type = 0, value = fallback, size = 4;
  query_fn query = (query_fn)find_export("advapi32.dll", "RegQueryValueExA");
  LONG found = query(key, name, NULL, &type, (BYTE *)&value, &size);
  close_key(key);
  return found == 0 && type == REG_DWORD && size == 4 ? value : fallback;
}

void wrapper_setting_set(const char *name, DWORD value) {
  HKEY key = open_key(WRAPPER_KEY);
  if (!key) return;
  set_fn set = (set_fn)find_export("advapi32.dll", "RegSetValueExA");
  set(key, name, 0, REG_DWORD, (const BYTE *)&value, 4);
  close_key(key);
}
