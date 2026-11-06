/* USER32: window classes, windows, the message queue, resources the game loads through
   USER32, message boxes and wsprintf. No visible window yet (that is milestone 2: SDL). */
#define _GNU_SOURCE
#include <ctype.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include "wrapper.h"

#define WM_NULL 0x0000
#define WM_CREATE 0x0001
#define WM_DESTROY 0x0002
#define WM_MOVE 0x0003
#define WM_SIZE 0x0005
#define WM_PAINT 0x000f
#define WM_CLOSE 0x0010
#define WM_QUIT 0x0012
#define WM_NCCREATE 0x0081
#define WM_TIMER 0x0113

#define GWL_WNDPROC (-4)
#define GWL_HINSTANCE (-6)
#define GWL_HWNDPARENT (-8)
#define GWL_ID (-12)
#define GWL_STYLE (-16)
#define GWL_EXSTYLE (-20)
#define GWL_USERDATA (-21)

#define CW_USEDEFAULT ((INT)0x80000000)

/* ---- Classes ---- */

typedef struct {
  UINT cbSize, style;
  WNDPROC lpfnWndProc;
  INT cbClsExtra, cbWndExtra;
  HINSTANCE hInstance;
  HICON hIcon;
  HCURSOR hCursor;
  HBRUSH hbrBackground;
  LPCSTR lpszMenuName, lpszClassName;
  HICON hIconSm;
} WNDCLASSEXA;
_Static_assert(sizeof(WNDCLASSEXA) == 48, "WNDCLASSEXA");

typedef struct {
  LPVOID lpCreateParams;
  HINSTANCE hInstance;
  HMENU hMenu;
  HWND hwndParent;
  INT cy, cx, y, x;
  LONG style;
  LPCSTR lpszName, lpszClass;
  DWORD dwExStyle;
} CREATESTRUCTA;
_Static_assert(sizeof(CREATESTRUCTA) == 48, "CREATESTRUCTA");

#define MAX_CLASSES 16
static struct wclass {
  char name[64];
  WORD atom;
  WNDCLASSEXA def;
} classes[MAX_CLASSES];
static int class_count;

/* An integer atom or a name. */
static struct wclass *find_class(LPCSTR name) {
  for (int i = 0; i < class_count; i++) {
    if ((uintptr_t)name < 0x10000 ? classes[i].atom == (uintptr_t)name
                                  : strcasecmp(classes[i].name, name) == 0)
      return &classes[i];
  }
  return NULL;
}

static WORD WINAPI RegisterClassExA(const WNDCLASSEXA *def) {
  if (class_count == MAX_CLASSES) fatal("too many window classes");
  struct wclass *c = &classes[class_count++];
  c->def = *def;
  c->atom = (WORD)(0xc000 + class_count);
  if ((uintptr_t)def->lpszClassName < 0x10000)
    fatal("RegisterClassExA with an atom as name");
  snprintf(c->name, sizeof c->name, "%s", def->lpszClassName);
  trace("RegisterClassExA %s: proc %p, %d extra bytes", c->name, (void *)def->lpfnWndProc,
        def->cbWndExtra);
  return c->atom;
}

/* ---- Windows ---- */

#define WINDOW_MAGIC 0x574e4457u
struct window {
  DWORD magic;
  struct wclass *cls;
  WNDPROC proc;
  DWORD style, exstyle;
  LONG userdata, id;
  HINSTANCE instance;
  HWND parent;
  HMENU menu;
  HMENU system_menu;
  RECT rect; /* screen coordinates of the whole window */
  BOOL visible, dirty;
  char title[256];
  BYTE *extra;
};

/* Windows made, for WM_PAINT. */
#define MAX_WINDOWS 16
static HWND windows[MAX_WINDOWS];

static struct window *win(HWND hwnd) {
  struct window *w = handle_get(hwnd, HANDLE_OTHER);
  return w && w->magic == WINDOW_MAGIC ? w : NULL;
}

static LRESULT send(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  struct window *w = win(hwnd);
  if (!w) return 0;
  return w->proc(hwnd, msg, wparam, lparam);
}

static void destroy_window_data(void *data) {
  struct window *w = data;
  w->magic = 0;
  free(w->extra);
  free(w);
}

static HWND WINAPI CreateWindowExA(DWORD exstyle, LPCSTR class_name, LPCSTR title, DWORD style,
                                   INT x, INT y, INT width, INT height, HWND parent, HMENU menu,
                                   HINSTANCE instance, LPVOID param) {
  struct wclass *c = find_class(class_name);
  if (!c) fatal("CreateWindowExA: unknown class");
  struct window *w = calloc(1, sizeof *w);
  w->magic = WINDOW_MAGIC;
  w->cls = c;
  w->proc = c->def.lpfnWndProc;
  w->style = style;
  w->exstyle = exstyle;
  w->instance = instance;
  w->parent = parent;
  w->menu = menu;
  w->extra = calloc(1, (size_t)(c->def.cbWndExtra > 0 ? c->def.cbWndExtra : 0) + 4);
  if (x == CW_USEDEFAULT) x = y = 0;
  if (width == CW_USEDEFAULT) width = 640, height = 480;
  w->rect = (RECT){x, y, x + width, y + height};
  snprintf(w->title, sizeof w->title, "%s", title ? title : "");
  HWND hwnd = handle_new(HANDLE_OTHER, w, destroy_window_data);
  for (int i = 0; i < MAX_WINDOWS; i++)
    if (!windows[i] || !win(windows[i])) {
      windows[i] = hwnd;
      break;
    }
  trace("CreateWindowExA %s \"%s\" style 0x%x ex 0x%x at %d,%d %dx%d -> %p", c->name, w->title,
        style, exstyle, x, y, width, height, hwnd);

  CREATESTRUCTA cs = {param,      instance,   menu,  parent,     height, width,
                      y,          x,          (LONG)style, w->title, c->name, exstyle};
  if (!send(hwnd, WM_NCCREATE, 0, (LPARAM)(uintptr_t)&cs)) {
    trace("CreateWindowExA: WM_NCCREATE refused");
    handle_close(hwnd);
    return NULL;
  }
  if (send(hwnd, WM_CREATE, 0, (LPARAM)(uintptr_t)&cs) == -1) {
    trace("CreateWindowExA: WM_CREATE refused");
    handle_close(hwnd);
    return NULL;
  }
  send(hwnd, WM_SIZE, 0, (LPARAM)((height & 0xffff) << 16 | (width & 0xffff)));
  send(hwnd, WM_MOVE, 0, (LPARAM)((y & 0xffff) << 16 | (x & 0xffff)));
  return hwnd;
}

static LONG *window_long(struct window *w, INT index) {
  switch (index) {
  case GWL_WNDPROC: return (LONG *)&w->proc;
  case GWL_HINSTANCE: return (LONG *)&w->instance;
  case GWL_HWNDPARENT: return (LONG *)&w->parent;
  case GWL_ID: return &w->id;
  case GWL_STYLE: return (LONG *)&w->style;
  case GWL_EXSTYLE: return (LONG *)&w->exstyle;
  case GWL_USERDATA: return &w->userdata;
  }
  if (index >= 0 && index + 4 <= w->cls->def.cbWndExtra) return (LONG *)(w->extra + index);
  return NULL;
}

static LONG WINAPI GetWindowLongA(HWND hwnd, INT index) {
  struct window *w = win(hwnd);
  LONG *p = w ? window_long(w, index) : NULL;
  return p ? *p : 0;
}

static LONG WINAPI SetWindowLongA(HWND hwnd, INT index, LONG value) {
  struct window *w = win(hwnd);
  LONG *p = w ? window_long(w, index) : NULL;
  if (!p) return 0;
  LONG old = *p;
  *p = value;
  return old;
}

static LRESULT WINAPI DefWindowProcA(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  (void)hwnd, (void)wparam, (void)lparam;
  switch (msg) {
  case WM_NCCREATE: return TRUE;
  default: return 0;
  }
}

static BOOL WINAPI SetWindowPos(HWND hwnd, HWND after, INT x, INT y, INT cx, INT cy, UINT flags) {
  (void)after;
  struct window *w = win(hwnd);
  if (!w) return FALSE;
  trace("SetWindowPos %d,%d %dx%d flags 0x%x", x, y, cx, cy, flags);
  if (!(flags & 2)) /* SWP_NOMOVE */
    w->rect = (RECT){x, y, x + (w->rect.right - w->rect.left), y + (w->rect.bottom - w->rect.top)};
  if (!(flags & 1)) /* SWP_NOSIZE */
    w->rect.right = w->rect.left + cx, w->rect.bottom = w->rect.top + cy;
  return TRUE;
}

#define SM_CXSCREEN 0
#define SM_CYSCREEN 1

static INT WINAPI GetSystemMetrics(INT index) {
  switch (index) {
  case SM_CXSCREEN: return 1280;
  case SM_CYSCREEN: return 1024;
  case 4: return 19;   /* SM_CYCAPTION */
  case 5: case 6: return 1;  /* SM_CXBORDER, SM_CYBORDER */
  case 7: case 8: return 3;  /* SM_CXDLGFRAME, SM_CYDLGFRAME */
  case 15: return 19;  /* SM_CYMENU */
  case 32: case 33: return 4; /* SM_CXFRAME, SM_CYFRAME */
  }
  trace("GetSystemMetrics %d: 0", index);
  return 0;
}

static BOOL WINAPI MoveWindow(HWND hwnd, INT x, INT y, INT cx, INT cy, BOOL repaint) {
  (void)repaint;
  struct window *w = win(hwnd);
  if (!w) return FALSE;
  trace("MoveWindow %d,%d %dx%d", x, y, cx, cy);
  w->rect = (RECT){x, y, x + cx, y + cy};
  return TRUE;
}

static BOOL WINAPI GetWindowRect(HWND hwnd, RECT *rect) {
  struct window *w = win(hwnd);
  if (!w) return FALSE;
  *rect = w->rect;
  return TRUE;
}

/* No frame or menu bar is drawn: the client area is the whole window. */
static BOOL WINAPI GetClientRect(HWND hwnd, RECT *rect) {
  struct window *w = win(hwnd);
  if (!w) return FALSE;
  *rect = (RECT){0, 0, w->rect.right - w->rect.left, w->rect.bottom - w->rect.top};
  return TRUE;
}

static BOOL WINAPI ShowWindow(HWND hwnd, INT how) {
  struct window *w = win(hwnd);
  if (!w) return FALSE;
  BOOL was = w->visible;
  w->visible = how != 0; /* SW_HIDE */
  trace("ShowWindow %d", how);
  return was;
}

static BOOL WINAPI IsIconic(HWND hwnd) {
  (void)hwnd;
  return FALSE;
}

static HWND focus;

static HWND WINAPI SetFocus(HWND hwnd) {
  HWND old = focus;
  focus = hwnd;
  return old;
}

static BOOL WINAPI SetForegroundWindow(HWND hwnd) {
  focus = hwnd;
  return TRUE;
}

static HWND capture;

static HWND WINAPI SetCapture(HWND hwnd) {
  HWND old = capture;
  capture = hwnd;
  return old;
}

static BOOL WINAPI ReleaseCapture(void) {
  capture = NULL;
  return TRUE;
}

/* ---- Painting: a DC per window (GDI fills in what drawing needs) ---- */

typedef struct {
  HDC hdc;
  BOOL fErase;
  RECT rcPaint;
  BOOL fRestore, fIncUpdate;
  BYTE rgbReserved[32];
} PAINTSTRUCT;
_Static_assert(sizeof(PAINTSTRUCT) == 64, "PAINTSTRUCT");

static HDC WINAPI GetDC(HWND hwnd) { return (HDC)(hwnd ? hwnd : (HWND)1); }

static INT WINAPI ReleaseDC(HWND hwnd, HDC dc) {
  (void)hwnd, (void)dc;
  return 1;
}

static BOOL WINAPI InvalidateRect(HWND hwnd, const RECT *rect, BOOL erase) {
  (void)rect, (void)erase;
  struct window *w = win(hwnd);
  if (w) w->dirty = TRUE;
  return TRUE;
}

static BOOL WINAPI UpdateWindow(HWND hwnd) {
  struct window *w = win(hwnd);
  if (w && w->dirty) {
    w->dirty = FALSE;
    send(hwnd, WM_PAINT, 0, 0);
  }
  return TRUE;
}

static HDC WINAPI BeginPaint(HWND hwnd, PAINTSTRUCT *ps) {
  struct window *w = win(hwnd);
  memset(ps, 0, sizeof *ps);
  ps->hdc = GetDC(hwnd);
  if (w) {
    w->dirty = FALSE;
    GetClientRect(hwnd, &ps->rcPaint);
  }
  return ps->hdc;
}

static BOOL WINAPI EndPaint(HWND hwnd, const PAINTSTRUCT *ps) {
  (void)hwnd, (void)ps;
  return TRUE;
}

static INT WINAPI FillRect(HDC dc, const RECT *rect, HBRUSH brush) {
  (void)dc, (void)rect, (void)brush;
  return 1;
}

static HBRUSH WINAPI GetSysColorBrush(INT index) {
  static HBRUSH brushes[32];
  if (index < 0 || index >= 32) return NULL;
  if (!brushes[index]) brushes[index] = handle_new(HANDLE_OTHER, NULL, NULL);
  return brushes[index];
}

/* ---- Keyboard and mouse state (fed by the SDL events in milestone 2) ---- */

static SHORT WINAPI GetAsyncKeyState(INT vk) {
  (void)vk;
  return 0;
}

static SHORT WINAPI GetKeyState(INT vk) {
  (void)vk;
  return 0;
}

static BOOL WINAPI GetCursorPos(POINT *point) {
  *point = (POINT){0, 0};
  return TRUE;
}

/* ---- Menus: kept as data, not shown ---- */

#define MF_CHECKED 0x0008
#define MF_POPUP 0x0010
#define MF_END 0x0080
#define MF_BYPOSITION 0x0400
#define MF_SEPARATOR 0x0800

#define MENU_MAGIC 0x554e454du
#define MAX_ITEMS 48
struct menu {
  DWORD magic;
  int count;
  struct item {
    UINT flags, id;
    HMENU sub;
    char text[64];
  } items[MAX_ITEMS];
};

static struct menu *menu_of(HMENU h) {
  struct menu *m = handle_get(h, HANDLE_OTHER);
  return m && m->magic == MENU_MAGIC ? m : NULL;
}

static HMENU new_menu(void) {
  struct menu *m = calloc(1, sizeof *m);
  m->magic = MENU_MAGIC;
  return handle_new(HANDLE_OTHER, m, free);
}

static HMENU WINAPI CreateMenu(void) { return new_menu(); }
static HMENU WINAPI CreatePopupMenu(void) { return new_menu(); }

static struct item *add_item(HMENU h, int position) {
  struct menu *m = menu_of(h);
  if (!m) return NULL;
  if (m->count == MAX_ITEMS) fatal("menu with more than %d items", MAX_ITEMS);
  if (position < 0 || position > m->count) position = m->count;
  memmove(&m->items[position + 1], &m->items[position],
          (size_t)(m->count - position) * sizeof *m->items);
  m->count++;
  memset(&m->items[position], 0, sizeof *m->items);
  return &m->items[position];
}

static BOOL WINAPI AppendMenuA(HMENU h, UINT flags, UINT_PTR id, LPCSTR text) {
  struct item *it = add_item(h, -1);
  if (!it) return FALSE;
  it->flags = flags;
  if (flags & MF_POPUP)
    it->sub = (HMENU)id;
  else
    it->id = id;
  if (!(flags & (MF_SEPARATOR | 0x4 /* MF_BITMAP */ | 0x100 /* MF_OWNERDRAW */)) && text)
    snprintf(it->text, sizeof it->text, "%s", text);
  return TRUE;
}

typedef struct {
  UINT cbSize, fMask, fType, fState, wID;
  HMENU hSubMenu;
  HBITMAP hbmpChecked, hbmpUnchecked;
  ULONG_PTR dwItemData;
  LPSTR dwTypeData;
  UINT cch;
  HBITMAP hbmpItem;
} MENUITEMINFOA;
_Static_assert(sizeof(MENUITEMINFOA) == 48, "MENUITEMINFOA");

static struct item *find_item(HMENU h, UINT which, BOOL by_position, HMENU *owner);

static BOOL WINAPI InsertMenuItemA(HMENU h, UINT item, BOOL by_position, const MENUITEMINFOA *info) {
  int position = -1;
  if (by_position) {
    position = (int)item;
  } else {
    struct menu *m = menu_of(h);
    for (int i = 0; m && i < m->count; i++)
      if (m->items[i].id == item) position = i;
  }
  struct item *it = add_item(h, position);
  if (!it) return FALSE;
  if (info->fMask & 0x01) it->flags |= info->fState;             /* MIIM_STATE */
  if (info->fMask & 0x02) it->id = info->wID;                   /* MIIM_ID */
  if (info->fMask & 0x04 && info->hSubMenu) {                   /* MIIM_SUBMENU */
    it->sub = info->hSubMenu;
    it->flags |= MF_POPUP;
  }
  if (info->fMask & (0x10 | 0x100)) it->flags |= info->fType;   /* MIIM_TYPE, MIIM_FTYPE */
  if (info->fMask & (0x10 | 0x40) && !(info->fType & 0x804) && info->dwTypeData)
    snprintf(it->text, sizeof it->text, "%s", info->dwTypeData); /* MIIM_TYPE, MIIM_STRING */
  return TRUE;
}

/* By position in `h`, or by command id anywhere below `h`. */
static struct item *find_item(HMENU h, UINT which, BOOL by_position, HMENU *owner) {
  struct menu *m = menu_of(h);
  if (!m) return NULL;
  if (by_position) {
    if (owner) *owner = h;
    return which < (UINT)m->count ? &m->items[which] : NULL;
  }
  for (int i = 0; i < m->count; i++) {
    if (m->items[i].sub) {
      struct item *it = find_item(m->items[i].sub, which, FALSE, owner);
      if (it) return it;
    } else if (m->items[i].id == which) {
      if (owner) *owner = h;
      return &m->items[i];
    }
  }
  return NULL;
}

static HMENU WINAPI GetSubMenu(HMENU h, INT position) {
  struct item *it = find_item(h, (UINT)position, TRUE, NULL);
  return it ? it->sub : NULL;
}

static DWORD WINAPI CheckMenuItem(HMENU h, UINT which, UINT flags) {
  struct item *it = find_item(h, which, flags & MF_BYPOSITION, NULL);
  if (!it) return (DWORD)-1;
  DWORD old = it->flags & MF_CHECKED;
  it->flags = (it->flags & ~MF_CHECKED) | (flags & MF_CHECKED);
  return old;
}

static BOOL WINAPI DestroyMenu(HMENU h) {
  struct menu *m = menu_of(h);
  if (!m) return FALSE;
  for (int i = 0; i < m->count; i++)
    if (m->items[i].sub) DestroyMenu(m->items[i].sub);
  return handle_close(h);
}

static HMENU WINAPI GetMenu(HWND hwnd) {
  struct window *w = win(hwnd);
  return w ? w->menu : NULL;
}

static BOOL WINAPI SetMenu(HWND hwnd, HMENU menu) {
  struct window *w = win(hwnd);
  if (!w) return FALSE;
  w->menu = menu;
  return TRUE;
}

static BOOL WINAPI DrawMenuBar(HWND hwnd) {
  (void)hwnd;
  return TRUE;
}

static HMENU WINAPI GetSystemMenu(HWND hwnd, BOOL revert) {
  struct window *w = win(hwnd);
  if (!w || revert) return NULL;
  if (!w->system_menu) w->system_menu = new_menu();
  return w->system_menu;
}

static BOOL WINAPI SetMenuInfo(HMENU h, const void *info) {
  (void)info;
  return menu_of(h) != NULL;
}

static BOOL WINAPI TrackPopupMenu(HMENU h, UINT flags, INT x, INT y, INT reserved, HWND hwnd,
                                  const RECT *rect) {
  (void)h, (void)flags, (void)x, (void)y, (void)reserved, (void)hwnd, (void)rect;
  trace("TrackPopupMenu: nothing chosen");
  return FALSE;
}

/* A MENU resource (RT_MENU 4): a header of two words, then items; a popup's items follow it,
   MF_END marks the last item of a level. Texts are UTF-16. */
static const BYTE *parse_menu(HMENU h, const BYTE *p, const BYTE *end) {
  for (;;) {
    if (p + 2 > end) return end;
    WORD flags = (WORD)(p[0] | p[1] << 8);
    p += 2;
    WORD id = 0;
    if (!(flags & MF_POPUP)) {
      id = (WORD)(p[0] | p[1] << 8);
      p += 2;
    }
    char text[64];
    size_t n = 0;
    for (; p + 1 < end && (p[0] | p[1]); p += 2)
      if (n < sizeof text - 1) text[n++] = p[1] ? '?' : (char)p[0];
    text[n] = 0;
    p += 2;
    struct item *it = add_item(h, -1);
    it->flags = flags & ~MF_END;
    it->id = id;
    snprintf(it->text, sizeof it->text, "%s", text);
    if (flags & MF_POPUP) {
      it->sub = new_menu();
      p = parse_menu(it->sub, p, end);
    }
    if (flags & MF_END) return p;
  }
}

static HMENU WINAPI LoadMenuA(HINSTANCE instance, LPCSTR name) {
  (void)instance;
  DWORD size;
  const BYTE *data = resource_find((LPCSTR)4, name, &size);
  if (!data) {
    trace("LoadMenuA %p: not found", (void *)name);
    return NULL;
  }
  HMENU h = new_menu();
  parse_menu(h, data + 4, data + size);
  return h;
}

/* ---- The message queue (any thread may post; the game's thread takes) ---- */

#define QUEUE_SIZE 1024
static MSG queue[QUEUE_SIZE];
static int queue_head, queue_count;
static pthread_mutex_t queue_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t queue_cond = PTHREAD_COND_INITIALIZER;
static int quit_posted, quit_code;

static DWORD now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (DWORD)((uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000);
}

static BOOL matches(const MSG *m, HWND hwnd, UINT first, UINT last);

/* Timers: WM_TIMER is made when a timer is due and nothing else is waiting. */
#define MAX_TIMERS 16
static struct {
  HWND hwnd;
  UINT_PTR id;
  UINT interval;
  void *proc;
  DWORD due;
} timers[MAX_TIMERS];
static int timer_count;

static UINT_PTR WINAPI SetTimer(HWND hwnd, UINT_PTR id, UINT interval, void *proc) {
  pthread_mutex_lock(&queue_lock);
  int i = 0;
  while (i < timer_count && !(timers[i].hwnd == hwnd && timers[i].id == id)) i++;
  if (i == MAX_TIMERS) fatal("too many timers");
  if (i == timer_count) timer_count++;
  if (!hwnd && !id) id = 0x100 + (UINT_PTR)i;
  timers[i].hwnd = hwnd;
  timers[i].id = id;
  timers[i].interval = interval < 10 ? 10 : interval;
  timers[i].proc = proc;
  timers[i].due = now_ms() + timers[i].interval;
  pthread_mutex_unlock(&queue_lock);
  trace("SetTimer %u every %u ms", (unsigned)id, interval);
  return id;
}

/* A due timer's WM_TIMER, or a dirty window's WM_PAINT, when the queue has nothing else;
   call with queue_lock held. Sets *wait_ms to the time to the next timer. */
static BOOL synthesize(MSG *out, HWND hwnd, UINT first, UINT last, BOOL remove, DWORD *wait_ms) {
  DWORD now = now_ms();
  *wait_ms = 0xffffffff;
  for (int i = 0; i < timer_count; i++) {
    MSG m = {timers[i].hwnd, WM_TIMER, timers[i].id, (LPARAM)(uintptr_t)timers[i].proc, now, {0, 0}};
    if (!matches(&m, hwnd, first, last)) continue;
    if ((int32_t)(now - timers[i].due) >= 0) {
      if (remove) timers[i].due = now + timers[i].interval;
      *out = m;
      return TRUE;
    }
    DWORD left = timers[i].due - now;
    if (left < *wait_ms) *wait_ms = left;
  }
  for (int i = 0; i < MAX_WINDOWS; i++) {
    struct window *w = windows[i] ? win(windows[i]) : NULL;
    MSG m = {windows[i], WM_PAINT, 0, 0, now, {0, 0}};
    if (!w || !w->dirty || !matches(&m, hwnd, first, last)) continue;
    *out = m; /* stays dirty until BeginPaint, as on Windows */
    (void)remove;
    return TRUE;
  }
  return FALSE;
}

static BOOL WINAPI PostMessageA(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  pthread_mutex_lock(&queue_lock);
  if (queue_count == QUEUE_SIZE) {
    pthread_mutex_unlock(&queue_lock);
    say("robot: message queue full, 0x%x dropped", msg);
    return FALSE;
  }
  queue[(queue_head + queue_count++) % QUEUE_SIZE] =
      (MSG){hwnd, msg, wparam, lparam, now_ms(), {0, 0}};
  pthread_cond_signal(&queue_cond);
  pthread_mutex_unlock(&queue_lock);
  return TRUE;
}

static void WINAPI PostQuitMessage(INT code) {
  pthread_mutex_lock(&queue_lock);
  quit_posted = 1;
  quit_code = code;
  pthread_cond_signal(&queue_cond);
  pthread_mutex_unlock(&queue_lock);
}

static BOOL matches(const MSG *m, HWND hwnd, UINT first, UINT last) {
  if (hwnd && m->hwnd != hwnd) return FALSE;
  if (first || last) return m->message >= first && m->message <= last;
  return TRUE;
}

/* Takes (or with !remove copies) the first matching message; call with queue_lock held. */
static BOOL take(MSG *out, HWND hwnd, UINT first, UINT last, BOOL remove) {
  for (int i = 0; i < queue_count; i++) {
    MSG *m = &queue[(queue_head + i) % QUEUE_SIZE];
    if (!matches(m, hwnd, first, last)) continue;
    *out = *m;
    if (remove) {
      for (int j = i; j > 0; j--)
        queue[(queue_head + j) % QUEUE_SIZE] = queue[(queue_head + j - 1) % QUEUE_SIZE];
      queue_head = (queue_head + 1) % QUEUE_SIZE;
      queue_count--;
    }
    return TRUE;
  }
  if (quit_posted && (!first || (WM_QUIT >= first && WM_QUIT <= last))) {
    *out = (MSG){NULL, WM_QUIT, (WPARAM)quit_code, 0, now_ms(), {0, 0}};
    if (remove) quit_posted = 0;
    return TRUE;
  }
  return FALSE;
}

#define PM_REMOVE 1

static BOOL WINAPI PeekMessageA(MSG *msg, HWND hwnd, UINT first, UINT last, UINT flags) {
  DWORD wait_ms;
  pthread_mutex_lock(&queue_lock);
  BOOL got = take(msg, hwnd, first, last, flags & PM_REMOVE) ||
             synthesize(msg, hwnd, first, last, flags & PM_REMOVE, &wait_ms);
  pthread_mutex_unlock(&queue_lock);
  return got;
}

static BOOL WINAPI GetMessageA(MSG *msg, HWND hwnd, UINT first, UINT last) {
  DWORD wait_ms;
  pthread_mutex_lock(&queue_lock);
  while (!take(msg, hwnd, first, last, TRUE) &&
         !synthesize(msg, hwnd, first, last, TRUE, &wait_ms)) {
    if (wait_ms == 0xffffffff) {
      pthread_cond_wait(&queue_cond, &queue_lock);
    } else {
      struct timespec t;
      clock_gettime(CLOCK_REALTIME, &t);
      t.tv_nsec += (long)wait_ms * 1000000;
      t.tv_sec += t.tv_nsec / 1000000000;
      t.tv_nsec %= 1000000000;
      pthread_cond_timedwait(&queue_cond, &queue_lock, &t);
    }
  }
  pthread_mutex_unlock(&queue_lock);
  return msg->message != WM_QUIT;
}

static BOOL WINAPI TranslateMessage(const MSG *msg) {
  (void)msg;
  return FALSE; /* WM_CHAR comes with the keyboard (milestone 2) */
}

static LRESULT WINAPI DispatchMessageA(const MSG *msg) {
  if (msg->message == WM_TIMER && msg->lParam) {
    typedef void(WINAPI * timerproc)(HWND, UINT, UINT_PTR, DWORD);
    ((timerproc)(uintptr_t)msg->lParam)(msg->hwnd, WM_TIMER, msg->wParam, now_ms());
    return 0;
  }
  return send(msg->hwnd, msg->message, msg->wParam, msg->lParam);
}

static LRESULT WINAPI SendMessageA(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  return send(hwnd, msg, wparam, lparam);
}

/* ---- Resources and other objects ---- */

#define RT_ACCELERATOR ((LPCSTR)9)

static HACCEL WINAPI LoadAcceleratorsA(HINSTANCE instance, LPCSTR name) {
  (void)instance;
  DWORD size;
  const void *table = resource_find(RT_ACCELERATOR, name, &size);
  trace("LoadAcceleratorsA %p: %u bytes", (void *)name, table ? size : 0);
  return (HACCEL)table;
}

static INT WINAPI TranslateAcceleratorA(HWND hwnd, HACCEL table, MSG *msg) {
  (void)hwnd, (void)table, (void)msg;
  return 0; /* with the keyboard (milestone 2) */
}

/* A string table (RT_STRING 6) holds 16 strings per block, block id/16 + 1, each a count and
   that many UTF-16 characters. Out in code page 1252 (the texts are Latin-1). */
static INT WINAPI LoadStringA(HINSTANCE instance, UINT id, LPSTR out, INT size) {
  (void)instance;
  DWORD block_size;
  const BYTE *p = resource_find((LPCSTR)6, (LPCSTR)(uintptr_t)((id >> 4) + 1), &block_size);
  if (!p || size <= 0) {
    trace("LoadStringA %u: not found", id);
    if (size > 0) out[0] = 0;
    return 0;
  }
  const BYTE *end = p + block_size;
  for (UINT i = 0; i < (id & 15) && p + 2 <= end; i++) p += 2 + 2 * (p[0] | p[1] << 8);
  INT length = p + 2 <= end ? p[0] | p[1] << 8 : 0;
  p += 2;
  INT n = 0;
  for (; n < length && n < size - 1 && p + 2 * n + 1 < end; n++) {
    WORD c = (WORD)(p[2 * n] | p[2 * n + 1] << 8);
    out[n] = c < 0x100 ? (char)c : '?';
  }
  out[n] = 0;
  return n;
}

static HANDLE fake_object(void) { return handle_new(HANDLE_OTHER, NULL, NULL); }

static HANDLE WINAPI LoadImageA(HINSTANCE instance, LPCSTR name, UINT type, INT cx, INT cy,
                                UINT flags) {
  (void)instance, (void)cx, (void)cy, (void)flags;
  trace("LoadImageA %p type %u", (void *)name, type);
  return fake_object();
}

static HCURSOR WINAPI LoadCursorA(HINSTANCE instance, LPCSTR name) {
  (void)instance, (void)name;
  return fake_object();
}

/* ---- Message boxes ---- */

#define MB_TYPEMASK 0xf

static INT WINAPI MessageBoxA(HWND hwnd, LPCSTR text, LPCSTR caption, UINT type) {
  (void)hwnd;
  static const INT first_button[] = {1, 1, 3, 6, 6, 4, 2}; /* OK, OK, ABORT, YES, YES, RETRY, CANCEL */
  UINT kind = type & MB_TYPEMASK;
  INT answer = kind < sizeof first_button / sizeof *first_button ? first_button[kind] : 1;
  say("robot: message box \"%s\": %s (answered %d)", caption ? caption : "", text ? text : "",
      answer);
  return answer;
}

/* ---- wsprintf ---- */

/* Windows' wsprintf: %[-][#][0][width][.precision][h|l]type, type c C d i s S u x X; no
   floats; at most 1024 characters out. `args` are the stack's 32-bit slots. */
static INT format(LPSTR out, LPCSTR fmt, const DWORD *args) {
  const size_t cap = 1024;
  size_t n = 0;
  for (const char *p = fmt; *p && n < cap - 1; p++) {
    if (*p != '%') {
      out[n++] = *p;
      continue;
    }
    char spec[32] = "%";
    size_t s = 1;
    p++;
    while (*p && strchr("-#0", *p) && s < 8) spec[s++] = *p++;
    while (isdigit((unsigned char)*p) && s < 16) spec[s++] = *p++;
    if (*p == '.') {
      spec[s++] = *p++;
      while (isdigit((unsigned char)*p) && s < 24) spec[s++] = *p++;
    }
    int wide = 0;
    if (*p == 'l' || *p == 'h') wide = *p++ == 'l';
    char type = *p;
    if (!type) break;
    char piece[1100];
    switch (type) {
    case 'd':
    case 'i':
      spec[s++] = 'd', spec[s] = 0;
      snprintf(piece, sizeof piece, spec, (int)*args++);
      break;
    case 'u':
    case 'x':
    case 'X':
      spec[s++] = type, spec[s] = 0;
      snprintf(piece, sizeof piece, spec, (unsigned)*args++);
      break;
    case 'c':
    case 'C':
      spec[s++] = 'c', spec[s] = 0;
      snprintf(piece, sizeof piece, spec, (int)(BYTE)*args++);
      break;
    case 's':
    case 'S': {
      const void *str = (const void *)(uintptr_t)*args++;
      char narrow[1024];
      if (!str) {
        snprintf(narrow, sizeof narrow, "(null)");
      } else if (type == 'S' || wide) {
        const WCHAR *ws = str;
        size_t i = 0;
        for (; ws[i] && i < sizeof narrow - 1; i++) narrow[i] = ws[i] < 0x100 ? (char)ws[i] : '?';
        narrow[i] = 0;
      } else {
        snprintf(narrow, sizeof narrow, "%s", (const char *)str);
      }
      spec[s++] = 's', spec[s] = 0;
      snprintf(piece, sizeof piece, spec, narrow);
      break;
    }
    default:
      piece[0] = type, piece[1] = 0;
    }
    for (const char *q = piece; *q && n < cap - 1; q++) out[n++] = *q;
  }
  out[n] = 0;
  return (INT)n;
}

static INT WINAPI wvsprintfA(LPSTR out, LPCSTR fmt, const DWORD *args) {
  return format(out, fmt, args);
}

/* cdecl and variadic, as on Windows: the arguments follow the format on the stack. */
static INT wsprintfA(LPSTR out, LPCSTR fmt, ...) {
  va_list args; /* on i386 a pointer to the 32-bit argument slots */
  va_start(args, fmt);
  INT n = format(out, fmt, (const DWORD *)args);
  va_end(args);
  return n;
}

const struct export user32_exports[] = {
    {"AppendMenuA", AppendMenuA},
    {"BeginPaint", BeginPaint},
    {"CheckMenuItem", CheckMenuItem},
    {"CreateMenu", CreateMenu},
    {"CreatePopupMenu", CreatePopupMenu},
    {"CreateWindowExA", CreateWindowExA},
    {"DefWindowProcA", DefWindowProcA},
    {"DestroyMenu", DestroyMenu},
    {"DispatchMessageA", DispatchMessageA},
    {"DrawMenuBar", DrawMenuBar},
    {"EndPaint", EndPaint},
    {"FillRect", FillRect},
    {"GetAsyncKeyState", GetAsyncKeyState},
    {"GetClientRect", GetClientRect},
    {"GetCursorPos", GetCursorPos},
    {"GetDC", GetDC},
    {"GetKeyState", GetKeyState},
    {"GetMenu", GetMenu},
    {"GetMessageA", GetMessageA},
    {"GetSubMenu", GetSubMenu},
    {"GetSysColorBrush", GetSysColorBrush},
    {"GetSystemMenu", GetSystemMenu},
    {"GetSystemMetrics", GetSystemMetrics},
    {"GetWindowLongA", GetWindowLongA},
    {"GetWindowRect", GetWindowRect},
    {"InsertMenuItemA", InsertMenuItemA},
    {"InvalidateRect", InvalidateRect},
    {"IsIconic", IsIconic},
    {"LoadAcceleratorsA", LoadAcceleratorsA},
    {"LoadCursorA", LoadCursorA},
    {"LoadImageA", LoadImageA},
    {"LoadMenuA", LoadMenuA},
    {"LoadStringA", LoadStringA},
    {"MessageBoxA", MessageBoxA},
    {"MoveWindow", MoveWindow},
    {"PeekMessageA", PeekMessageA},
    {"PostMessageA", PostMessageA},
    {"PostQuitMessage", PostQuitMessage},
    {"RegisterClassExA", RegisterClassExA},
    {"ReleaseCapture", ReleaseCapture},
    {"ReleaseDC", ReleaseDC},
    {"SendMessageA", SendMessageA},
    {"SetCapture", SetCapture},
    {"SetFocus", SetFocus},
    {"SetForegroundWindow", SetForegroundWindow},
    {"SetMenu", SetMenu},
    {"SetMenuInfo", SetMenuInfo},
    {"SetTimer", SetTimer},
    {"SetWindowLongA", SetWindowLongA},
    {"SetWindowPos", SetWindowPos},
    {"ShowWindow", ShowWindow},
    {"TrackPopupMenu", TrackPopupMenu},
    {"TranslateAcceleratorA", TranslateAcceleratorA},
    {"TranslateMessage", TranslateMessage},
    {"UpdateWindow", UpdateWindow},
    {"wsprintfA", wsprintfA},
    {"wvsprintfA", wvsprintfA},
    {NULL, NULL},
};
