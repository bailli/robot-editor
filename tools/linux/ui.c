/* What stands in for Windows' own UI: message boxes (SDL's), dialogs that run without being
   shown, the popup menu (none) and the wrapper's shortcuts for menu commands the game has no
   accelerator for.

   A dialog is made from its DIALOG resource as real windows (the dialog, a child per control
   holding its state), gets WM_INITDIALOG, and is then closed the way the user would: by
   cancelling (or by pressing OK for the dialogs named in ROBOT_DIALOG_OK). What it shows is
   traced. Settings the dialogs would edit live in the registry file instead. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "ui.h"

/* ---- Constants ---- */

typedef int32_t INT_PTR;

#define MB_TYPEMASK 0x0f
#define MB_ICONMASK 0xf0
#define MB_DEFMASK 0xf00
#define MB_OK 0
#define MB_OKCANCEL 1
#define MB_ABORTRETRYIGNORE 2
#define MB_YESNOCANCEL 3
#define MB_YESNO 4
#define MB_RETRYCANCEL 5
#define MB_ICONHAND 0x10
#define MB_ICONQUESTION 0x20
#define MB_ICONEXCLAMATION 0x30
#define MB_ICONASTERISK 0x40

#define BM_GETCHECK 0xf0
#define BM_SETCHECK 0xf1
#define BM_GETSTATE 0xf2
#define BM_SETSTATE 0xf3
#define BM_CLICK 0xf5
#define BN_CLICKED 0

#define EM_SETSEL 0xb1
#define EM_GETSEL 0xb0
#define EM_REPLACESEL 0xc2
#define EM_SETTABSTOPS 0xcb
#define EM_SETREADONLY 0xcf

#define LB_ADDSTRING 0x180
#define LB_INSERTSTRING 0x181
#define LB_DELETESTRING 0x182
#define LB_RESETCONTENT 0x184
#define LB_SETCURSEL 0x186
#define LB_GETCURSEL 0x188
#define LB_GETTEXT 0x189
#define LB_GETTEXTLEN 0x18a
#define LB_GETCOUNT 0x18b
#define CB_GETCOUNT 0x146
#define CB_GETCURSEL 0x147
#define CB_GETLBTEXT 0x148
#define CB_GETLBTEXTLEN 0x149
#define CB_INSERTSTRING 0x14a
#define CB_RESETCONTENT 0x14b
#define CB_ADDSTRING 0x143
#define CB_DELETESTRING 0x144
#define CB_SETCURSEL 0x14e
#define CB_ERR (-1)

#define TBM_GETPOS 0x400
#define TBM_GETRANGEMIN 0x401
#define TBM_GETRANGEMAX 0x402
#define TBM_SETPOS 0x405
#define TBM_SETRANGE 0x406
#define TBM_SETRANGEMIN 0x407
#define TBM_SETRANGEMAX 0x408

#define DS_SETFONT 0x40
#define WS_TABSTOP 0x00010000u
#define BS_TYPEMASK 0x0f

/* ---- Text: code page 1252 and UTF-16 (dialog templates) ---- */

/* 0x80..0x9f of code page 1252 as Unicode (the rest below 0x100 is Latin-1; the five holes
   map to the C1 control of the same number). */
static const uint16_t cp1252_high[32] = {
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
    0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178};

static unsigned cp1252_unicode(unsigned char c) {
  return c >= 0x80 && c < 0xa0 ? cp1252_high[c - 0x80] : c;
}

/* A malloc'd UTF-8 copy of a code page 1252 string. */
static char *cp1252_to_utf8(const char *s) {
  char *out = malloc(strlen(s) * 3 + 1), *p = out;
  for (; *s; s++) {
    unsigned u = cp1252_unicode((unsigned char)*s);
    if (u < 0x80) {
      *p++ = (char)u;
    } else if (u < 0x800) {
      *p++ = (char)(0xc0 | u >> 6);
      *p++ = (char)(0x80 | (u & 0x3f));
    } else {
      *p++ = (char)(0xe0 | u >> 12);
      *p++ = (char)(0x80 | (u >> 6 & 0x3f));
      *p++ = (char)(0x80 | (u & 0x3f));
    }
  }
  *p = 0;
  return out;
}

/* One UTF-16 unit as a code page 1252 byte ('?' when it has none). */
static char unicode_to_cp1252(unsigned u) {
  if (u < 0x80 || (u >= 0xa0 && u < 0x100)) return (char)u;
  for (int i = 0; i < 32; i++)
    if (cp1252_high[i] == u) return (char)(0x80 + i);
  return '?';
}

/* ---- MessageBoxA ---- */

static int env_set(const char *name) {
  const char *v = getenv(name);
  return v && *v;
}

/* No window can be shown: asked for (ROBOT_HEADLESS) or SDL has no real video driver. */
static int headless(void) {
  const char *driver = getenv("SDL_VIDEODRIVER");
  return env_set("ROBOT_HEADLESS") || (driver && !strcmp(driver, "dummy"));
}

static const char *button_name(int id) {
  switch (id) {
  case IDOK: return "OK";
  case IDCANCEL: return "Cancel";
  case IDABORT: return "Abort";
  case IDRETRY: return "Retry";
  case IDIGNORE: return "Ignore";
  case IDYES: return "Yes";
  case IDNO: return "No";
  }
  return "?";
}

static int WINAPI MessageBoxA(HWND hwnd, LPCSTR text, LPCSTR caption, UINT type) {
  (void)hwnd;
  /* The buttons left to right, by MB_TYPEMASK. */
  static const struct {
    int count, id[3];
    int escape; /* index of the button Escape presses */
  } sets[] = {
      {1, {IDOK}, 0},
      {2, {IDOK, IDCANCEL}, 1},
      {3, {IDABORT, IDRETRY, IDIGNORE}, 2},
      {3, {IDYES, IDNO, IDCANCEL}, 2},
      {2, {IDYES, IDNO}, 1},
      {2, {IDRETRY, IDCANCEL}, 1},
  };
  unsigned kind = type & MB_TYPEMASK;
  if (kind >= sizeof sets / sizeof *sets) kind = MB_OK;
  int count = sets[kind].count;
  int def = (int)((type & MB_DEFMASK) >> 8);
  if (def >= count) def = 0;

  char *utext = cp1252_to_utf8(text ? text : ""), *ucaption = cp1252_to_utf8(caption ? caption : "");
  int answer = sets[kind].id[def];
  say("MessageBox \"%s\": %s", ucaption, utext);

  if (headless()) {
    say("  (no window: answered %s, the default)", button_name(answer));
  } else {
    SDL_MessageBoxButtonData buttons[3];
    for (int i = 0; i < count; i++) {
      buttons[i].flags = (i == def ? SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT : 0) |
                         (i == sets[kind].escape ? SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT : 0);
      buttons[i].buttonid = sets[kind].id[i];
      buttons[i].text = button_name(sets[kind].id[i]);
    }
    Uint32 flags;
    switch (type & MB_ICONMASK) {
    case MB_ICONHAND: flags = SDL_MESSAGEBOX_ERROR; break;
    case MB_ICONQUESTION:
    case MB_ICONEXCLAMATION: flags = SDL_MESSAGEBOX_WARNING; break;
    case MB_ICONASTERISK: flags = SDL_MESSAGEBOX_INFORMATION; break;
    default: flags = SDL_MESSAGEBOX_INFORMATION;
    }
    SDL_MessageBoxData data = {flags, screen_window(), ucaption, utext, count, buttons, NULL};
    int chosen = -1;
    if (SDL_ShowMessageBox(&data, &chosen) < 0 || chosen < 0)
      say("  (SDL cannot show it: %s; answered %s)", SDL_GetError(), button_name(answer));
    else
      answer = chosen;
    if (chosen >= 0) say("  answer: %s", button_name(answer));
  }
  free(utext);
  free(ucaption);
  return answer;
}

/* ---- Dialog controls: windows that hold their state ---- */

enum kind { K_OTHER, K_BUTTON, K_EDIT, K_STATIC, K_LIST, K_COMBO, K_TRACKBAR };

struct ctl {
  enum kind kind;
  char *text; /* the whole window text (WM_SETTEXT; the window's title keeps the first 255) */
  int check;  /* buttons: BST_* */
  int sel_start, sel_end; /* edit: the selection */
  char **items;           /* list and combo box */
  int count, cur;
  int pos, range_min, range_max; /* trackbar */
};

static struct ctl *ctl_of(HWND h) {
  struct window *w = win(h);
  return w ? w->data : NULL;
}

static void ctl_set_text(HWND h, struct ctl *c, const char *text) {
  free(c->text);
  c->text = strdup(text ? text : "");
  snprintf(win(h)->title, sizeof win(h)->title, "%s", c->text);
}

/* Copies `text` into a caller's buffer of `max` bytes (WM_GETTEXT: returns the length). */
static LRESULT copy_text(const char *text, char *buffer, int max) {
  if (max <= 0) return 0;
  int n = (int)strlen(text);
  if (n > max - 1) n = max - 1;
  memcpy(buffer, text, (size_t)n);
  buffer[n] = 0;
  return n;
}

static void items_insert(struct ctl *c, int at, const char *text) {
  if (at < 0 || at > c->count) at = c->count;
  c->items = realloc(c->items, (size_t)(c->count + 1) * sizeof *c->items);
  memmove(c->items + at + 1, c->items + at, (size_t)(c->count - at) * sizeof *c->items);
  c->items[at] = strdup(text ? text : "");
  if (c->cur >= at) c->cur++;
  c->count++;
}

static void items_clear(struct ctl *c) {
  for (int i = 0; i < c->count; i++) free(c->items[i]);
  free(c->items);
  c->items = NULL;
  c->count = 0;
  c->cur = CB_ERR;
}

static LRESULT WINAPI ctl_proc(HWND h, UINT msg, WPARAM wparam, LPARAM lparam) {
  struct ctl *c = ctl_of(h);
  if (!c) return 0;
  switch (msg) {
  case WM_DESTROY:
    free(c->text);
    items_clear(c);
    free(c);
    win(h)->data = NULL;
    return 0;
  case WM_SETTEXT: ctl_set_text(h, c, (const char *)lparam); return TRUE;
  case WM_GETTEXT: return copy_text(c->text, (char *)lparam, (int)wparam);
  case WM_GETTEXTLENGTH: return (LRESULT)strlen(c->text);
  case WM_SETFONT:
  case WM_ENABLE:
  case WM_PAINT:
  case WM_ERASEBKGND:
  case WM_SHOWWINDOW: return 0;

  case BM_GETCHECK: return c->check;
  case BM_SETCHECK: c->check = (int)wparam; return 0;
  case BM_GETSTATE: return c->check;
  case BM_SETSTATE: return 0;

  case EM_SETSEL: {
    int len = (int)strlen(c->text), a = (int)wparam, b = (int)lparam;
    if (a == -1) { /* no selection: the caret stays where the selection began */
      c->sel_end = c->sel_start;
      return 0;
    }
    if (b < 0 || b > len) b = len;
    if (a > b) a = b;
    c->sel_start = a;
    c->sel_end = b;
    return 0;
  }
  case EM_GETSEL: return (LRESULT)((unsigned)c->sel_start | (unsigned)c->sel_end << 16);
  case EM_REPLACESEL: {
    /* Replaces the selection (appending at the caret), which then is the caret behind it. */
    const char *with = (const char *)lparam;
    size_t len = strlen(c->text), a = (size_t)c->sel_start, b = (size_t)c->sel_end;
    if (b > len) b = len;
    if (a > b) a = b;
    size_t add = strlen(with);
    char *n = malloc(len - (b - a) + add + 1);
    memcpy(n, c->text, a);
    memcpy(n + a, with, add);
    strcpy(n + a + add, c->text + b);
    free(c->text);
    c->text = n;
    snprintf(win(h)->title, sizeof win(h)->title, "%s", n);
    c->sel_start = c->sel_end = (int)(a + add);
    return 0;
  }
  case EM_SETTABSTOPS:
  case EM_SETREADONLY: return TRUE;

  case LB_ADDSTRING:
  case CB_ADDSTRING:
    if (c->kind != K_LIST && c->kind != K_COMBO) break;
    items_insert(c, c->count, (const char *)lparam);
    return c->count - 1;
  case LB_INSERTSTRING:
  case CB_INSERTSTRING:
    if (c->kind != K_LIST && c->kind != K_COMBO) break;
    items_insert(c, (int)wparam, (const char *)lparam);
    return (int)wparam > c->count - 1 ? c->count - 1 : (int)wparam;
  case LB_DELETESTRING:
  case CB_DELETESTRING:
    if (c->kind != K_LIST && c->kind != K_COMBO) break;
    if ((int)wparam < 0 || (int)wparam >= c->count) return CB_ERR;
    free(c->items[wparam]);
    memmove(c->items + wparam, c->items + wparam + 1,
            (size_t)(c->count - (int)wparam - 1) * sizeof *c->items);
    c->count--;
    if (c->cur == (int)wparam) c->cur = CB_ERR;
    else if (c->cur > (int)wparam) c->cur--;
    return c->count;
  case LB_RESETCONTENT:
  case CB_RESETCONTENT: items_clear(c); return 0;
  case LB_SETCURSEL:
  case CB_SETCURSEL:
    if ((int)wparam < 0 || (int)wparam >= c->count) {
      c->cur = CB_ERR;
      return CB_ERR;
    }
    c->cur = (int)wparam;
    return c->cur;
  case LB_GETCURSEL:
  case CB_GETCURSEL: return c->cur;
  case LB_GETCOUNT:
  case CB_GETCOUNT: return c->count;
  case LB_GETTEXT:
  case CB_GETLBTEXT:
    if ((int)wparam < 0 || (int)wparam >= c->count) return CB_ERR;
    return copy_text(c->items[wparam], (char *)lparam, 0x7fffffff);
  case LB_GETTEXTLEN:
  case CB_GETLBTEXTLEN:
    if ((int)wparam < 0 || (int)wparam >= c->count) return CB_ERR;
    return (LRESULT)strlen(c->items[wparam]);

  case TBM_GETPOS: return c->pos;
  case TBM_GETRANGEMIN: return c->range_min;
  case TBM_GETRANGEMAX: return c->range_max;
  case TBM_SETRANGE:
    c->range_min = (short)(lparam & 0xffff);
    c->range_max = (short)((lparam >> 16) & 0xffff);
    goto clamp;
  case TBM_SETRANGEMIN: c->range_min = (int)lparam; goto clamp;
  case TBM_SETRANGEMAX: c->range_max = (int)lparam; goto clamp;
  case TBM_SETPOS:
    c->pos = (int)lparam;
  clamp:
    if (c->pos < c->range_min) c->pos = c->range_min;
    if (c->pos > c->range_max) c->pos = c->range_max;
    return 0;
  }
  trace("dialog control %d (kind %d): message 0x%x not supported, answered 0", (int)win(h)->id,
        c->kind, msg);
  return 0;
}

/* ---- Dialogs ---- */

struct dialog {
  int template;     /* the resource number (traces, ROBOT_DIALOG_OK) */
  int ended;        /* EndDialog was called */
  INT_PTR result;   /* its value */
  HWND *ctl;        /* the controls in template order */
  int count;
};

typedef INT_PTR(WINAPI *DLGPROC)(HWND, UINT, WPARAM, LPARAM);

static struct dialog *dialog_of(HWND h) {
  struct window *w = win(h);
  return w && w->proc && w->extra_size >= 12 ? w->data : NULL;
}

static LONG *dialog_long(struct window *w, int index) { return (LONG *)(w->extra + index); }

static LRESULT WINAPI dlg_proc(HWND h, UINT msg, WPARAM wparam, LPARAM lparam) {
  struct window *w = win(h);
  struct dialog *d = w->data;
  if (msg == WM_DESTROY) {
    if (d) {
      free(d->ctl);
      free(d);
    }
    w->data = NULL;
    return 0;
  }
  DLGPROC proc = (DLGPROC)(uintptr_t)*dialog_long(w, DWL_DLGPROC);
  if (proc) {
    INT_PTR r = proc(h, msg, wparam, lparam);
    if (msg == WM_INITDIALOG) return r;
    if (r) return *dialog_long(w, DWL_MSGRESULT);
  }
  switch (msg) { /* what the dialog manager does when the procedure leaves it be */
  case WM_CLOSE: return send_message(h, WM_COMMAND, IDCANCEL, 0);
  case WM_SETTEXT: snprintf(w->title, sizeof w->title, "%s", (const char *)lparam); return TRUE;
  case WM_GETTEXT: return copy_text(w->title, (char *)lparam, (int)wparam);
  case WM_GETTEXTLENGTH: return (LRESULT)strlen(w->title);
  }
  return 0;
}

static HWND WINAPI GetDlgItem(HWND hdlg, int id) {
  struct dialog *d = dialog_of(hdlg);
  if (!d) return NULL;
  for (int i = 0; i < d->count; i++)
    if (win(d->ctl[i])->id == id) return d->ctl[i];
  return NULL;
}

static LRESULT WINAPI SendDlgItemMessageA(HWND hdlg, int id, UINT msg, WPARAM wparam,
                                          LPARAM lparam) {
  HWND item = GetDlgItem(hdlg, id);
  if (!item) {
    trace("SendDlgItemMessageA: no control %d (message 0x%x)", id, msg);
    return 0;
  }
  return send_message(item, msg, wparam, lparam);
}

static BOOL WINAPI EndDialog(HWND hdlg, INT_PTR result) {
  struct dialog *d = dialog_of(hdlg);
  if (!d) return FALSE;
  trace("EndDialog(%d): %d", d->template, (int)result);
  d->ended = 1;
  d->result = result;
  return TRUE;
}

/* A reader over the template's bytes. */
struct reader {
  const BYTE *base;
  DWORD size, pos;
};

static int rd_have(struct reader *r, DWORD n) { return r->pos + n <= r->size; }
static unsigned rd_word(struct reader *r) {
  if (!rd_have(r, 2)) fatal("DialogBoxParamA: the template ends early");
  unsigned v = r->base[r->pos] | r->base[r->pos + 1] << 8;
  r->pos += 2;
  return v;
}
static DWORD rd_dword(struct reader *r) {
  DWORD lo = rd_word(r);
  return lo | (DWORD)rd_word(r) << 16;
}
static void rd_align(struct reader *r) { r->pos = (r->pos + 3) & ~3u; }

/* A name or ordinal: 0 = none, 0xffff + ordinal, or a UTF-16 string. Returns the ordinal
   (0 when it is a string or none) and, with `text`, the string in code page 1252. */
static unsigned rd_name(struct reader *r, char *text, size_t max) {
  unsigned w = rd_word(r);
  if (text) text[0] = 0;
  if (w == 0xffff) return rd_word(r);
  size_t n = 0;
  while (w) {
    if (text && n + 1 < max) text[n++] = unicode_to_cp1252(w);
    w = rd_word(r);
  }
  if (text) text[n] = 0;
  return 0;
}

static enum kind kind_of(unsigned atom, const char *name) {
  switch (atom) {
  case 0x80: return K_BUTTON;
  case 0x81: return K_EDIT;
  case 0x82: return K_STATIC;
  case 0x83: return K_LIST;
  case 0x85: return K_COMBO;
  case 0: break;
  default: return K_OTHER;
  }
  if (!strcasecmp(name, "msctls_trackbar32")) return K_TRACKBAR;
  if (!strcasecmp(name, "button")) return K_BUTTON;
  if (!strcasecmp(name, "edit")) return K_EDIT;
  if (!strcasecmp(name, "static")) return K_STATIC;
  if (!strcasecmp(name, "listbox")) return K_LIST;
  if (!strcasecmp(name, "combobox")) return K_COMBO;
  return K_OTHER;
}

static const char *kind_name(enum kind k) {
  static const char *names[] = {"other", "button", "edit", "static", "listbox", "combobox", "trackbar"};
  return names[k];
}

/* Dialog units to pixels (the average character of the dialog's font: 6 x 13 for MS Sans
   Serif 8). */
static LONG dlu_x(int v) { return v * 6 / 4; }
static LONG dlu_y(int v) { return v * 13 / 8; }

/* The first `max` bytes of a code page 1252 text as UTF-8 for the trace (one of four buffers
   in turn, so a call may use up to four). */
static const char *u8(const char *s, size_t max) {
  static char *ring[4];
  static int next;
  char head[1024];
  snprintf(head, sizeof head, "%.*s", (int)(max < sizeof head ? max : sizeof head - 1), s);
  free(ring[next]);
  ring[next] = cp1252_to_utf8(head);
  const char *out = ring[next];
  next = (next + 1) % 4;
  return out;
}

/* What the dialog shows, for the trace. */
static void trace_controls(struct dialog *d) {
  for (int i = 0; i < d->count; i++) {
    struct window *w = win(d->ctl[i]);
    struct ctl *c = w->data;
    if (!c) continue;
    if (c->kind == K_STATIC && (int)w->id == 0xffff) {
      trace("  static: \"%s\"", u8(c->text, 70));
      continue;
    }
    switch (c->kind) {
    case K_BUTTON:
      trace("  button %d \"%s\" (style 0x%x) check %d", (int)w->id, u8(c->text, 50), w->style,
            c->check);
      break;
    case K_EDIT: trace("  edit %d: \"%s\"", (int)w->id, u8(c->text, 1000)); break;
    case K_TRACKBAR:
      trace("  trackbar %d: %d in %d..%d", (int)w->id, c->pos, c->range_min, c->range_max);
      break;
    case K_LIST:
    case K_COMBO:
      trace("  %s %d: %d items, selected %d", kind_name(c->kind), (int)w->id, c->count, c->cur);
      for (int j = 0; j < c->count; j++) trace("    \"%s\"", u8(c->items[j], 200));
      break;
    default: trace("  %s %d \"%s\"", kind_name(c->kind), (int)w->id, u8(c->text, 50));
    }
  }
}

/* Whether ROBOT_DIALOG_OK=<id>[,<id>...] names this dialog. */
static int press_ok_for(int template) {
  const char *list = getenv("ROBOT_DIALOG_OK");
  while (list && *list) {
    char *end;
    long v = strtol(list, &end, 10);
    if (end != list && v == template) return 1;
    list = strchr(list, ',');
    if (list) list++;
  }
  return 0;
}

static INT_PTR WINAPI DialogBoxParamA(HINSTANCE instance, LPCSTR template, HWND parent,
                                      DLGPROC dlgproc, LPARAM param) {
  (void)instance;
  int number = (uintptr_t)template < 0x10000 ? (int)(uintptr_t)template : 0;
  DWORD size;
  const void *data = resource_find((LPCSTR)5, template, &size);
  if (!data) fatal("DialogBoxParamA: no DIALOG resource %d", number);

  struct reader r = {data, size, 0};
  DWORD style = rd_dword(&r);
  if (style == 0xffff0001) fatal("DialogBoxParamA: DLGTEMPLATEEX is not supported");
  rd_dword(&r); /* the extended style */
  unsigned count = rd_word(&r);
  int x = (short)rd_word(&r), y = (short)rd_word(&r), cx = (short)rd_word(&r), cy = (short)rd_word(&r);
  rd_name(&r, NULL, 0); /* menu */
  rd_name(&r, NULL, 0); /* window class */
  char title[256];
  rd_name(&r, title, sizeof title);
  if (style & DS_SETFONT) {
    rd_word(&r);
    rd_name(&r, NULL, 0);
  }

  RECT rect = {dlu_x(x), dlu_y(y), dlu_x(x + cx), dlu_y(y + cy)};
  HWND dlg = window_create(dlg_proc, style & ~WS_VISIBLE, parent, 0, rect, title, 12);
  struct window *dw = win(dlg);
  struct dialog *d = calloc(1, sizeof *d);
  d->template = number;
  d->ctl = calloc(count ? count : 1, sizeof *d->ctl);
  dw->data = d;
  *dialog_long(dw, DWL_MSGRESULT) = 0;
  *dialog_long(dw, DWL_DLGPROC) = (LONG)(uintptr_t)dlgproc;
  *dialog_long(dw, DWL_USER) = 0;
  trace("dialog %d \"%s\" (%u controls)", number, u8(title, 200), count);

  HWND first = NULL;
  for (unsigned i = 0; i < count; i++) {
    rd_align(&r);
    DWORD istyle = rd_dword(&r);
    rd_dword(&r);
    int ix = (short)rd_word(&r), iy = (short)rd_word(&r), icx = (short)rd_word(&r),
        icy = (short)rd_word(&r);
    LONG id = (short)rd_word(&r);
    char cname[64], text[1024];
    unsigned atom = rd_name(&r, cname, sizeof cname);
    unsigned ord = rd_name(&r, text, sizeof text);
    if (ord) snprintf(text, sizeof text, "#%u", ord);
    unsigned extra = rd_word(&r);
    if (!rd_have(&r, extra)) fatal("DialogBoxParamA: the template ends early");
    r.pos += extra;

    enum kind kind = kind_of(atom, cname);
    if (kind == K_OTHER)
      trace("  control %d: unknown class %s (0x%x), kept as an empty window", (int)id, cname, atom);
    RECT ir = {dlu_x(ix), dlu_y(iy), dlu_x(ix + icx), dlu_y(iy + icy)};
    HWND item = window_create(ctl_proc, istyle | WS_CHILD, dlg, id, ir, "", 0);
    struct ctl *c = calloc(1, sizeof *c);
    c->kind = kind;
    c->cur = CB_ERR;
    c->range_max = 100;
    win(item)->data = c;
    ctl_set_text(item, c, text);
    d->ctl[d->count++] = item;
    if (!first && (istyle & WS_TABSTOP) && !(istyle & WS_DISABLED)) first = item;
  }
  if (!first && d->count) first = d->ctl[0];

  send_message(dlg, WM_INITDIALOG, (WPARAM)first, param);
  trace_controls(d);

  /* Nothing is shown: close it the way the user would, by cancelling (or pressing OK). */
  if (!d->ended) {
    int button = press_ok_for(number) ? IDOK : IDCANCEL;
    HWND item = GetDlgItem(dlg, button);
    trace("dialog %d: %s", number, button == IDOK ? "OK pressed (ROBOT_DIALOG_OK)" : "cancelled");
    send_message(dlg, WM_COMMAND, (WPARAM)button | BN_CLICKED << 16, (LPARAM)item);
    if (!d->ended) EndDialog(dlg, button);
  }
  INT_PTR result = d->result;
  window_destroy(dlg);
  return result;
}

/* ---- The popup menu ---- */

static BOOL WINAPI TrackPopupMenu(HMENU hmenu, UINT flags, int x, int y, int reserved, HWND hwnd,
                                  const RECT *rect) {
  (void)flags, (void)reserved, (void)hwnd, (void)rect;
  struct menu *m = menu_of(hmenu);
  trace("TrackPopupMenu(%d items at %d,%d): nothing is shown, nothing chosen", m ? m->count : 0, x, y);
  return 0;
}

const struct export ui_exports[] = {
    {"MessageBoxA", MessageBoxA},
    {"DialogBoxParamA", DialogBoxParamA},
    {"EndDialog", EndDialog},
    {"GetDlgItem", GetDlgItem},
    {"SendDlgItemMessageA", SendDlgItemMessageA},
    {"TrackPopupMenu", TrackPopupMenu},
    {NULL, NULL},
};

/* ---- Shortcuts ---- */

/* Menu commands the game has no accelerator for, on Ctrl+Shift+key (the game itself reads
   plain, Shift, Ctrl and Alt combinations of letters, digits, arrows, Home/End/PgUp/PgDn,
   Insert/Delete, Return, Escape, Tab, Pause and F1-F10; Alt+letters and F11 are its own
   accelerators). The ids are the menu resource 2012's, which the game loads in all cases;
   Deutsch/Englisch (0xfb4/0xfb5, only in the unused menus 2010/2011) and Vollbild's menu id
   0x10c4 (Alt+Enter has its own) are left out. */
static const struct {
  SDL_Keycode key; /* with Ctrl+Shift */
  UINT command;
} shortcuts[] = {
    {SDLK_q, 0x0fa1}, /* ROBOT > Ende */
    {SDLK_k, 0x0fb2}, /* ROBOT > Konfiguration (a dialog that is not shown; see ROBOT_DIALOG_OK) */
    {SDLK_o, 0x0fb1}, /* ROBOT > Spieldateien öffnen (the save folder) */
    {SDLK_1, 0x1004}, /* Episode > ROBOT Junior */
    {SDLK_2, 0x1005}, /* Episode > ROBOT I */
    {SDLK_3, 0x1006}, /* Episode > ROBOT II */
    {SDLK_4, 0x1007}, /* Episode > ROBOT III */
    {SDLK_5, 0x1008}, /* Episode > ROBOT IV */
    {SDLK_a, 0x10cd}, /* Info > Über ROBOT */
    {SDLK_t, 0x10ce}, /* Info > Über TOM Productions */
    {SDLK_s, 0x10cf}, /* Info > Über Shareware */
    {SDLK_w, 0x10d0}, /* Info > Zur TOM Productions Web-Site (online) */
    {SDLK_f, 0x10d3}, /* Info > Zum ROBOT-Forum (online) */
    {SDLK_r, 0x10d2}, /* Info > Zur Registrierung (online) */
    {SDLK_i, 0x10d1}, /* Info > System-Informationen (a dialog that is not shown) */
};

BOOL ui_key(const SDL_KeyboardEvent *e) {
  if (e->type != SDL_KEYDOWN) return FALSE;
  SDL_Keymod mod = (SDL_Keymod)e->keysym.mod;
  if (!(mod & KMOD_CTRL) || !(mod & KMOD_SHIFT) || (mod & (KMOD_ALT | KMOD_GUI))) return FALSE;
  for (size_t i = 0; i < sizeof shortcuts / sizeof *shortcuts; i++) {
    if (shortcuts[i].key != e->keysym.sym) continue;
    if (!e->repeat && main_window()) {
      trace("shortcut: menu command 0x%x", shortcuts[i].command);
      post_message(main_window(), WM_COMMAND, shortcuts[i].command, 0);
    }
    return TRUE;
  }
  return FALSE;
}
