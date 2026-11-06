/* The screen: an SDL window showing the game's frames, and SDL's input turned into the
   window messages the game expects. Options (environment): ROBOT_SCALE (window size as a
   multiple of 640 × 348, default 2), ROBOT_FULLSCREEN (start in fullscreen). Without a video
   device (or SDL_VIDEODRIVER=dummy) everything still runs, with nothing shown. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "ui.h"
#include "user32.h"

/* The last frame (gdi32.c). */
extern BYTE frame_pixels[];
extern DWORD frame_colours[256];
extern int frame_width, frame_height;

static int state; /* 0 not tried, 1 video works, -1 no video */
static SDL_Window *window;
static SDL_Renderer *renderer;
static SDL_Texture *texture;
static DWORD pixels[GAME_WIDTH * GAME_HEIGHT];

static BOOL video(void) {
  if (!state) {
    if (SDL_InitSubSystem(SDL_INIT_VIDEO) == 0) {
      state = 1;
    } else {
      state = -1;
      say("robot: no video (%s): running without a window", SDL_GetError());
    }
  }
  return state > 0;
}

static void create_window(void) {
  if (window || !video()) return;
  const char *s = getenv("ROBOT_SCALE");
  int scale = s ? atoi(s) : 2;
  if (scale < 1) scale = 1;
  Uint32 flags = SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI;
  if (getenv("ROBOT_FULLSCREEN")) flags |= SDL_WINDOW_FULLSCREEN_DESKTOP;
  struct window *w = win(main_window());
  window = SDL_CreateWindow(w ? w->title : "The Game of Robot", SDL_WINDOWPOS_CENTERED,
                            SDL_WINDOWPOS_CENTERED, GAME_WIDTH * scale, GAME_HEIGHT * scale, flags);
  if (!window) fatal("SDL_CreateWindow: %s", SDL_GetError());
  SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "nearest");
  renderer = SDL_CreateRenderer(window, -1, 0);
  if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer) fatal("SDL_CreateRenderer: %s", SDL_GetError());
  SDL_RenderSetLogicalSize(renderer, GAME_WIDTH, GAME_HEIGHT);
  texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING,
                              GAME_WIDTH, GAME_HEIGHT);
  if (!texture) fatal("SDL_CreateTexture: %s", SDL_GetError());
  SDL_StartTextInput();
  trace("screen: %dx%d window", GAME_WIDTH * scale, GAME_HEIGHT * scale);
}

SDL_Window *screen_window(void) { return window; }

/* The size of what is shown (the texture and the renderer's logical size). */
static int shown_width = GAME_WIDTH, shown_height = GAME_HEIGHT;
static BOOL showing_rgb;
static DWORD *shown; /* the last picture shown */
static unsigned shown_count;

/* Writes the last picture shown as a PPM (ROBOT_SHOT); without a window GDI's last frame. */
void write_frame(const char *path);
void screen_write(const char *path) {
  if (!shown_count) {
    write_frame(path);
    return;
  }
  FILE *f = fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", shown_width, shown_height);
  for (int i = 0; i < shown_width * shown_height; i++) {
    BYTE rgb[3] = {(BYTE)(shown[i] >> 16), (BYTE)(shown[i] >> 8), (BYTE)shown[i]};
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

static void show(const DWORD *rgb, int width, int height, int pitch) {
  if (width != shown_width || height != shown_height) {
    SDL_DestroyTexture(texture);
    texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING,
                                width, height);
    if (!texture) fatal("SDL_CreateTexture: %s", SDL_GetError());
    SDL_RenderSetLogicalSize(renderer, width, height);
    shown_width = width;
    shown_height = height;
  }
  /* A copy for ROBOT_SHOT. */
  static size_t kept_size;
  if ((size_t)width * (size_t)height > kept_size) {
    kept_size = (size_t)width * (size_t)height;
    shown = realloc(shown, kept_size * 4);
  }
  for (int y = 0; y < height; y++) memcpy(shown + y * width, rgb + y * pitch, (size_t)width * 4);
  shown_count++;
  SDL_UpdateTexture(texture, NULL, rgb, pitch * 4);
  SDL_SetRenderDrawColor(renderer, 0, 0, 0, 255);
  SDL_RenderClear(renderer);
  SDL_RenderCopy(renderer, texture, NULL, NULL);
  SDL_RenderPresent(renderer);
}

void screen_present(void) {
  if (!window) create_window();
  if (!window) return;
  showing_rgb = FALSE;
  int w = frame_width < GAME_WIDTH ? frame_width : GAME_WIDTH;
  int h = frame_height < GAME_HEIGHT ? frame_height : GAME_HEIGHT;
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++)
      pixels[y * GAME_WIDTH + x] = frame_colours[frame_pixels[y * frame_width + x]];
  show(pixels, GAME_WIDTH, GAME_HEIGHT, GAME_WIDTH);
}

void screen_present_rgb(const DWORD *rgb, int width, int height, int pitch) {
  if (!window) create_window();
  if (!window) return;
  showing_rgb = TRUE;
  show(rgb, width, height, pitch);
}

void screen_fullscreen(BOOL on) {
  if (!window) create_window();
  if (!window) return;
  trace("screen: fullscreen %s", on ? "on" : "off");
  SDL_SetWindowFullscreen(window, on ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
}

void screen_show(int how) {
  if (!how) {
    if (window) SDL_HideWindow(window);
    return;
  }
  create_window();
  if (!window) return;
  if (how == 2 || how == 6 || how == 7) /* SW_SHOWMINIMIZED, SW_MINIMIZE, SW_SHOWMINNOACTIVE */
    SDL_MinimizeWindow(window);
  else if (how == 3) /* SW_MAXIMIZE */
    SDL_MaximizeWindow(window);
  else {
    SDL_ShowWindow(window);
    if (how == 9) SDL_RestoreWindow(window); /* SW_RESTORE */
  }
}

/* Window titles are code page 1252; the game's are ASCII but for a few letters. */
void screen_title(const char *title) {
  if (!window) return;
  char utf8[512], *o = utf8;
  for (const BYTE *s = (const BYTE *)title; *s && o < utf8 + sizeof utf8 - 3; s++) {
    if (*s < 0x80) {
      *o++ = (char)*s;
    } else if (*s >= 0xa0) {
      *o++ = (char)(0xc0 | *s >> 6), *o++ = (char)(0x80 | (*s & 0x3f));
    } else {
      *o++ = '?';
    }
  }
  *o = 0;
  SDL_SetWindowTitle(window, utf8);
}

void screen_desktop(int *width, int *height) {
  SDL_DisplayMode mode;
  if (video() && SDL_GetDesktopDisplayMode(0, &mode) == 0) {
    *width = mode.w;
    *height = mode.h;
  } else {
    *width = 1280;
    *height = 1024;
  }
}

void screen_wait(int ms) {
  if (window)
    SDL_WaitEventTimeout(NULL, ms);
  else if (ms > 0)
    usleep((useconds_t)ms * 1000);
}

/* ---- Keys ---- */

#define VK_SHIFT 0x10
#define VK_CONTROL 0x11
#define VK_MENU 0x12
#define VK_LSHIFT 0xa0
#define VK_RSHIFT 0xa1
#define VK_LCONTROL 0xa2
#define VK_RCONTROL 0xa3
#define VK_LMENU 0xa4
#define VK_RMENU 0xa5
#define VK_F10 0x79

/* The Windows virtual key for an SDL key (0: none); *extended for the keys Windows marks so. */
static UINT virtual_key(const SDL_Keysym *k, BOOL *extended) {
  SDL_Keycode c = k->sym;
  SDL_Scancode s = k->scancode;
  *extended = FALSE;
  if (c >= 'a' && c <= 'z') return (UINT)(c - 'a' + 'A');
  if (c >= '0' && c <= '9') return (UINT)c;
  if (s >= SDL_SCANCODE_F1 && s <= SDL_SCANCODE_F12) return 0x70 + (UINT)(s - SDL_SCANCODE_F1);
  /* The keypad: digits with Num Lock on, else the keys printed on them. */
  BOOL num = (k->mod & KMOD_NUM) != 0;
  switch (s) {
  case SDL_SCANCODE_KP_0: return num ? 0x60 : 0x2d;
  case SDL_SCANCODE_KP_1: return num ? 0x61 : 0x23;
  case SDL_SCANCODE_KP_2: return num ? 0x62 : 0x28;
  case SDL_SCANCODE_KP_3: return num ? 0x63 : 0x22;
  case SDL_SCANCODE_KP_4: return num ? 0x64 : 0x25;
  case SDL_SCANCODE_KP_5: return num ? 0x65 : 0x0c;
  case SDL_SCANCODE_KP_6: return num ? 0x66 : 0x27;
  case SDL_SCANCODE_KP_7: return num ? 0x67 : 0x24;
  case SDL_SCANCODE_KP_8: return num ? 0x68 : 0x26;
  case SDL_SCANCODE_KP_9: return num ? 0x69 : 0x21;
  case SDL_SCANCODE_KP_PERIOD: return num ? 0x6e : 0x2e;
  case SDL_SCANCODE_KP_MULTIPLY: return 0x6a;
  case SDL_SCANCODE_KP_PLUS: return 0x6b;
  case SDL_SCANCODE_KP_MINUS: return 0x6d;
  case SDL_SCANCODE_KP_DIVIDE: *extended = TRUE; return 0x6f;
  case SDL_SCANCODE_KP_ENTER: *extended = TRUE; return 0x0d;
  default: break;
  }
  switch (s) {
  case SDL_SCANCODE_RETURN: return 0x0d;
  case SDL_SCANCODE_ESCAPE: return 0x1b;
  case SDL_SCANCODE_BACKSPACE: return 0x08;
  case SDL_SCANCODE_TAB: return 0x09;
  case SDL_SCANCODE_SPACE: return 0x20;
  case SDL_SCANCODE_PAUSE: return 0x13;
  case SDL_SCANCODE_CAPSLOCK: return 0x14;
  case SDL_SCANCODE_LSHIFT: return VK_LSHIFT;
  case SDL_SCANCODE_RSHIFT: return VK_RSHIFT;
  case SDL_SCANCODE_LCTRL: return VK_LCONTROL;
  case SDL_SCANCODE_RCTRL: *extended = TRUE; return VK_RCONTROL;
  case SDL_SCANCODE_LALT: return VK_LMENU;
  case SDL_SCANCODE_RALT: *extended = TRUE; return VK_RMENU;
  default: break;
  }
  *extended = TRUE;
  switch (s) {
  case SDL_SCANCODE_PAGEUP: return 0x21;
  case SDL_SCANCODE_PAGEDOWN: return 0x22;
  case SDL_SCANCODE_END: return 0x23;
  case SDL_SCANCODE_HOME: return 0x24;
  case SDL_SCANCODE_LEFT: return 0x25;
  case SDL_SCANCODE_UP: return 0x26;
  case SDL_SCANCODE_RIGHT: return 0x27;
  case SDL_SCANCODE_DOWN: return 0x28;
  case SDL_SCANCODE_INSERT: return 0x2d;
  case SDL_SCANCODE_DELETE: return 0x2e;
  default: break;
  }
  *extended = FALSE;
  switch (s) { /* by position, as a US keyboard's VK_OEM_* */
  case SDL_SCANCODE_SEMICOLON: return 0xba;
  case SDL_SCANCODE_EQUALS: return 0xbb;
  case SDL_SCANCODE_COMMA: return 0xbc;
  case SDL_SCANCODE_MINUS: return 0xbd;
  case SDL_SCANCODE_PERIOD: return 0xbe;
  case SDL_SCANCODE_SLASH: return 0xbf;
  case SDL_SCANCODE_GRAVE: return 0xc0;
  case SDL_SCANCODE_LEFTBRACKET: return 0xdb;
  case SDL_SCANCODE_BACKSLASH: return 0xdc;
  case SDL_SCANCODE_RIGHTBRACKET: return 0xdd;
  case SDL_SCANCODE_APOSTROPHE: return 0xde;
  case SDL_SCANCODE_NONUSBACKSLASH: return 0xe2;
  default: return 0;
  }
}

/* Shift, Ctrl and Alt as one key each too (VK_SHIFT, VK_CONTROL, VK_MENU). */
static void update_modifiers(void) {
  key_state[VK_SHIFT] = (BYTE)((key_state[VK_LSHIFT] | key_state[VK_RSHIFT]) & 0x80);
  key_state[VK_CONTROL] = (BYTE)((key_state[VK_LCONTROL] | key_state[VK_RCONTROL]) & 0x80);
  key_state[VK_MENU] = (BYTE)((key_state[VK_LMENU] | key_state[VK_RMENU]) & 0x80);
}

static void key(const SDL_KeyboardEvent *e) {
  BOOL down = e->type == SDL_KEYDOWN, extended;
  UINT vk = virtual_key(&e->keysym, &extended);
  if (!vk) return;
  if (down && ui_key(e)) return;
  BOOL was_down = (key_state[vk] & 0x80) != 0;
  key_state[vk] = (BYTE)((down ? 0x80 : 0) | ((key_state[vk] ^ (down && !was_down)) & 1));
  update_modifiers();
  /* The game sees the generic modifier keys, as Windows reports them in WM_KEYDOWN. */
  UINT reported = vk == VK_LSHIFT || vk == VK_RSHIFT       ? VK_SHIFT
                  : vk == VK_LCONTROL || vk == VK_RCONTROL ? VK_CONTROL
                  : vk == VK_LMENU || vk == VK_RMENU       ? VK_MENU
                                                           : vk;
  /* Alt (not AltGr, which is Ctrl+Alt on Windows) and F10 make system keys. */
  BOOL alt = (key_state[VK_LMENU] & 0x80) && !(key_state[VK_CONTROL] & 0x80);
  BOOL sys = alt || reported == VK_F10 || (reported == VK_MENU && !down && !(key_state[VK_CONTROL] & 0x80));
  LPARAM lparam = 1 | (extended ? 1 << 24 : 0) | (alt ? 1 << 29 : 0) | (was_down ? 1 << 30 : 0) |
                  (down ? 0 : (LPARAM)1u << 31);
  if (!down) lparam |= 1 << 30;
  UINT msg = down ? (sys ? WM_SYSKEYDOWN : WM_KEYDOWN) : (sys ? WM_SYSKEYUP : WM_KEYUP);
  HWND main = main_window();
  if (main) post_message(main, msg, reported, lparam);
}

/* Typed text, as WM_CHAR in code page 1252 (characters it lacks are dropped). Not while Ctrl
   or Alt (without AltGr) is held: those keys make commands, not text. */
static void text(const char *utf8) {
  HWND main = main_window();
  if (!main || key_state[VK_LMENU] & 0x80 || (key_state[VK_CONTROL] & 0x80 && !(key_state[VK_RMENU] & 0x80)))
    return;
  static const WORD cp1252[32] = {
      0x20ac, 0x81,   0x201a, 0x192,  0x201e, 0x2026, 0x2020, 0x2021, 0x2c6,  0x2030, 0x160,
      0x2039, 0x152,  0x8d,   0x17d,  0x8f,   0x90,   0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
      0x2013, 0x2014, 0x2dc,  0x2122, 0x161,  0x203a, 0x153,  0x9d,   0x17e,  0x178};
  for (const BYTE *s = (const BYTE *)utf8; *s;) {
    unsigned c = *s++;
    if (c >= 0xc0) {
      int more = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : 1;
      c &= 0x3f >> more;
      for (; more && (*s & 0xc0) == 0x80; more--) c = c << 6 | (*s++ & 0x3f);
    }
    int out = c < 0x80 || (c >= 0xa0 && c < 0x100) ? (int)c : -1;
    for (int i = 0; out < 0 && i < 32; i++)
      if (cp1252[i] == c) out = 0x80 + i;
    if (out > 0) post_message(main, WM_CHAR, (WPARAM)out, 1);
  }
}

/* ---- Mouse ---- */

#define VK_LBUTTON 0x01
#define VK_RBUTTON 0x02
#define VK_MBUTTON 0x04

static WPARAM mouse_keys(void) {
  return (key_state[VK_LBUTTON] & 0x80 ? MK_LBUTTON : 0) | (key_state[VK_RBUTTON] & 0x80 ? MK_RBUTTON : 0) |
         (key_state[VK_MBUTTON] & 0x80 ? MK_MBUTTON : 0) | (key_state[VK_SHIFT] & 0x80 ? MK_SHIFT : 0) |
         (key_state[VK_CONTROL] & 0x80 ? MK_CONTROL : 0);
}

/* SDL gives the picture's coordinates (the renderer's logical size). The GDI picture fills
   the game's client area, which may be scaled (WndScaleX/Y); DirectDraw's fullscreen picture
   is the screen, and the window covers it. */
static void mouse_at(int x, int y) {
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x >= shown_width) x = shown_width - 1;
  if (y >= shown_height) y = shown_height - 1;
  struct window *w = win(main_window());
  int cw = shown_width, ch = shown_height;
  if (w && !showing_rgb) client_size(w, &cw, &ch);
  mouse_client.x = x * cw / shown_width;
  mouse_client.y = y * ch / shown_height;
}

static void mouse(UINT msg) {
  HWND main = main_window();
  if (main)
    post_message(main, msg, mouse_keys(),
                 (LPARAM)((mouse_client.y & 0xffff) << 16 | (mouse_client.x & 0xffff)));
}

static void button(const SDL_MouseButtonEvent *e) {
  static const struct {
    Uint8 sdl;
    BYTE vk;
    UINT down, up, dbl;
  } buttons[] = {
      {SDL_BUTTON_LEFT, VK_LBUTTON, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK},
      {SDL_BUTTON_RIGHT, VK_RBUTTON, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK},
      {SDL_BUTTON_MIDDLE, VK_MBUTTON, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDOWN},
  };
  for (size_t i = 0; i < sizeof buttons / sizeof *buttons; i++) {
    if (buttons[i].sdl != e->button) continue;
    BOOL down = e->type == SDL_MOUSEBUTTONDOWN;
    key_state[buttons[i].vk] = down ? 0x80 : 0;
    mouse_at(e->x, e->y);
    /* Windows sends a double click only to classes with CS_DBLCLKS; the game's has none. */
    mouse(down ? buttons[i].down : buttons[i].up);
  }
}

/* What a double click on the tray icon sends; the game shows its window again on it. */
#define TRAY_CLICK WM_LBUTTONDBLCLK

/* No wrapper shortcuts until ui.c has its own (it overrides this). */
__attribute__((weak)) BOOL ui_key(const SDL_KeyboardEvent *e) {
  (void)e;
  return FALSE;
}

/* ---- Events ---- */

void screen_poll(void) {
  if (!window) return;
  SDL_Event e;
  HWND main = main_window();
  while (SDL_PollEvent(&e)) {
    switch (e.type) {
    case SDL_QUIT:
      if (main) post_message(main, WM_CLOSE, 0, 0);
      break;
    case SDL_KEYDOWN:
    case SDL_KEYUP: key(&e.key); break;
    case SDL_TEXTINPUT: text(e.text.text); break;
    case SDL_MOUSEMOTION:
      mouse_at(e.motion.x, e.motion.y);
      mouse(WM_MOUSEMOVE);
      break;
    case SDL_MOUSEBUTTONDOWN:
    case SDL_MOUSEBUTTONUP: button(&e.button); break;
    case SDL_MOUSEWHEEL:
      if (main && e.wheel.y)
        post_message(main, WM_MOUSEWHEEL, mouse_keys() | (WPARAM)((e.wheel.y * 120) & 0xffff) << 16,
                     (LPARAM)((mouse_client.y & 0xffff) << 16 | (mouse_client.x & 0xffff)));
      break;
    case SDL_WINDOWEVENT:
      switch (e.window.event) {
      case SDL_WINDOWEVENT_EXPOSED: screen_present(); break;
      case SDL_WINDOWEVENT_FOCUS_LOST:
        /* Keys held when the focus goes would stay down: let them go. */
        for (int vk = 0; vk < 256; vk++)
          if (key_state[vk] & 0x80) {
            key_state[vk] &= 1;
            if (main && vk > VK_MBUTTON) post_message(main, WM_KEYUP, (WPARAM)vk, (LPARAM)0xc0000001u);
          }
        if (main) post_message(main, WM_ACTIVATEAPP, FALSE, 0);
        break;
      case SDL_WINDOWEVENT_FOCUS_GAINED:
        if (main) post_message(main, WM_ACTIVATEAPP, TRUE, 0);
        break;
      case SDL_WINDOWEVENT_RESTORED: {
        /* Back from the taskbar while the game is "in the tray": a click on its icon. */
        HWND icon_hwnd;
        UINT icon_id, icon_message;
        if (tray_icon(&icon_hwnd, &icon_id, &icon_message) && icon_message) {
          trace("screen: restored, the tray icon clicked");
          post_message(icon_hwnd, icon_message, icon_id, TRAY_CLICK);
        }
        break;
      }
      default: break;
      }
      break;
    default: break;
    }
  }
}
