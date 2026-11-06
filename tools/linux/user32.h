/* USER32's windows and menus, shared by user32.c (the API), sdl.c (the screen and input)
   and ui.c (menu bar, dialogs, message boxes). */
#ifndef USER32_H
#define USER32_H

#include "wrapper.h"

#define WM_NULL 0x0000
#define WM_CREATE 0x0001
#define WM_DESTROY 0x0002
#define WM_MOVE 0x0003
#define WM_SIZE 0x0005
#define WM_ACTIVATE 0x0006
#define WM_SETFOCUS 0x0007
#define WM_KILLFOCUS 0x0008
#define WM_ENABLE 0x000a
#define WM_SETTEXT 0x000c
#define WM_GETTEXT 0x000d
#define WM_GETTEXTLENGTH 0x000e
#define WM_PAINT 0x000f
#define WM_CLOSE 0x0010
#define WM_QUIT 0x0012
#define WM_ERASEBKGND 0x0014
#define WM_SHOWWINDOW 0x0018
#define WM_ACTIVATEAPP 0x001c
#define WM_SETCURSOR 0x0020
#define WM_SETFONT 0x0030
#define WM_NCCREATE 0x0081
#define WM_KEYDOWN 0x0100
#define WM_KEYUP 0x0101
#define WM_CHAR 0x0102
#define WM_SYSKEYDOWN 0x0104
#define WM_SYSKEYUP 0x0105
#define WM_SYSCHAR 0x0106
#define WM_INITDIALOG 0x0110
#define WM_COMMAND 0x0111
#define WM_SYSCOMMAND 0x0112
#define WM_TIMER 0x0113
#define WM_INITMENU 0x0116
#define WM_INITMENUPOPUP 0x0117
#define WM_MOUSEMOVE 0x0200
#define WM_LBUTTONDOWN 0x0201
#define WM_LBUTTONUP 0x0202
#define WM_LBUTTONDBLCLK 0x0203
#define WM_RBUTTONDOWN 0x0204
#define WM_RBUTTONUP 0x0205
#define WM_RBUTTONDBLCLK 0x0206
#define WM_MBUTTONDOWN 0x0207
#define WM_MBUTTONUP 0x0208
#define WM_MOUSEWHEEL 0x020a
#define WM_USER 0x0400

#define MK_LBUTTON 0x01
#define MK_RBUTTON 0x02
#define MK_SHIFT 0x04
#define MK_CONTROL 0x08
#define MK_MBUTTON 0x10

#define GWL_WNDPROC (-4)
#define GWL_HINSTANCE (-6)
#define GWL_HWNDPARENT (-8)
#define GWL_ID (-12)
#define GWL_STYLE (-16)
#define GWL_EXSTYLE (-20)
#define GWL_USERDATA (-21)
#define DWL_MSGRESULT 0
#define DWL_DLGPROC 4
#define DWL_USER 8

#define WS_CHILD 0x40000000u
#define WS_VISIBLE 0x10000000u
#define WS_DISABLED 0x08000000u
#define WS_CAPTION 0x00c00000u

#define IDOK 1
#define IDCANCEL 2
#define IDABORT 3
#define IDRETRY 4
#define IDIGNORE 5
#define IDYES 6
#define IDNO 7

/* ---- Windows ---- */

#define WINDOW_MAGIC 0x574e4457u
struct window {
  DWORD magic;
  struct wclass *cls; /* NULL for windows made by window_create */
  WNDPROC proc;
  DWORD style, exstyle;
  LONG userdata, id;
  HINSTANCE instance;
  HWND parent;
  HMENU menu;
  HMENU system_menu;
  RECT rect; /* the whole window: screen coordinates, or the parent's client ones for a child */
  BOOL visible, dirty; /* dirty: `update` is not empty, a WM_PAINT is due */
  RECT update;         /* the update region's bounds, client coordinates */
  char title[256]; /* the window text: WM_SETTEXT, WM_GETTEXT, GetWindowTextA */
  BYTE *extra;     /* cbWndExtra bytes (window_create: `extra` bytes) */
  int extra_size;
  void *data; /* for the module that made the window (ui.c: dialog or control state) */
};

/* The window behind a handle, or NULL. */
struct window *win(HWND hwnd);

/* Calls the window's procedure (in this thread, as SendMessage). */
LRESULT send_message(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam);

/* Queues a message for the game's thread (any thread may post). */
BOOL post_message(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam);

/* A window without a registered class (dialogs, controls): no WM_NCCREATE/WM_CREATE is sent;
   `extra` bytes of window longs (DWL_* for dialogs). `rect` as in struct window. */
HWND window_create(WNDPROC proc, DWORD style, HWND parent, LONG id, RECT rect, const char *title,
                   int extra);
void window_destroy(HWND hwnd); /* sends WM_DESTROY, then frees it (and its children) */

/* The game's main window (the first top-level window made), or NULL. */
HWND main_window(void);

/* The client area of a top-level window: the window minus the frame, caption and (when it
   has one) menu bar the GetSystemMetrics values describe; for a child the whole window. */
void client_size(const struct window *w, int *width, int *height);

/* Messages for any window: takes and dispatches what is queued (timers and WM_PAINT
   included), after turning the screen's input into messages. For modal loops (dialogs,
   message boxes); returns FALSE when WM_QUIT was taken (and posts it again). */
BOOL pump_messages(void);

/* ---- Input state (sdl.c keeps it, user32.c reports it) ---- */

/* Per virtual key: 0x80 while down, 0x01 toggled (as GetKeyState). VK_LBUTTON 1, VK_RBUTTON 2,
   VK_MBUTTON 4 for the mouse buttons; VK_SHIFT 0x10, VK_CONTROL 0x11, VK_MENU 0x12 too. */
extern BYTE key_state[256];
/* The mouse in the main window's client coordinates. */
extern POINT mouse_client;

/* ---- Menus ---- */

#define MF_GRAYED 0x0001
#define MF_DISABLED 0x0002
#define MF_CHECKED 0x0008
#define MF_POPUP 0x0010
#define MF_MENUBARBREAK 0x0020
#define MF_MENUBREAK 0x0040
#define MF_END 0x0080
#define MF_BYPOSITION 0x0400
#define MF_SEPARATOR 0x0800
#define MF_RADIOCHECK 0x0200 /* MFT_RADIOCHECK */

#define MENU_MAGIC 0x554e454du
#define MAX_ITEMS 48
struct menu {
  DWORD magic;
  int count;
  struct item {
    UINT flags, id; /* MF_* (state and type together); the command id */
    HMENU sub;      /* a popup's items */
    char text[64];  /* code page 1252; '&' marks the mnemonic, '\t' starts the shortcut */
  } items[MAX_ITEMS];
};

struct menu *menu_of(HMENU h); /* or NULL */

/* Whether any message (a due timer or a dirty window too) waits for the game's thread:
   driver.c's idle test. */
BOOL message_pending(void);

#endif
