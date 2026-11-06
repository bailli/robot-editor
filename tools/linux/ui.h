/* The screen (sdl.c) and what stands in for Windows' own UI (ui.c).

   There is no drawn menu bar and no drawn dialog: the menu exists as data (user32.c), its
   commands are reached through the game's accelerators and the wrapper's own shortcuts
   (ui_key); dialogs run without being shown (their settings live in the registry file);
   message boxes are SDL's. */
#ifndef UI_H
#define UI_H

#include <SDL2/SDL.h>

#include "user32.h"

#define GAME_WIDTH 640
#define GAME_HEIGHT 348

/* ---- ui.c ---- */

/* A key the wrapper itself handles (menu commands the game has no accelerator for): TRUE if
   ui.c took it. Called by sdl.c for every key press before it becomes a window message. */
BOOL ui_key(const SDL_KeyboardEvent *e);

/* ---- sdl.c ---- */

/* Shows the game's last frame (GDI's, 640 × 348 palette indices). */
void screen_present(void);

/* Shows a 32-bit picture instead (DirectDraw's primary surface in fullscreen); `pitch` in
   pixels. Mouse positions are then this picture's coordinates. */
void screen_present_rgb(const DWORD *pixels, int width, int height, int pitch);

/* Fullscreen on or off (DirectDraw's exclusive mode). */
void screen_fullscreen(BOOL on);

/* Takes the SDL events: keys go to ui_key first, the rest become window messages for the
   game. Called by PeekMessageA, GetMessageA and pump_messages. */
void screen_poll(void);

/* Waits up to `ms` for an SDL event (for modal loops). */
void screen_wait(int ms);

/* The main window shown (SW_* as ShowWindow takes it), its title changed. */
void screen_show(int how);
void screen_title(const char *title);

/* The desktop size (for GetSystemMetrics, EnumDisplaySettingsA). */
void screen_desktop(int *width, int *height);

/* The SDL window, for message boxes (NULL before the first frame). */
SDL_Window *screen_window(void);

#endif
