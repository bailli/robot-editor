/* DDRAW: the DirectDraw objects the game asks for. Every method slot exists; the ones not
   written yet stop the program naming interface and method, so a run shows what is needed. */
#include <stdlib.h>
#include <string.h>

#include "wrapper.h"

#define DD_OK 0
#define E_NOINTERFACE ((HRESULT)0x80004002)

typedef struct {
  DWORD d1;
  WORD d2, d3;
  BYTE d4[8];
} GUID;

static const GUID IID_IDirectDraw = {0x6c14db80, 0xa733, 0x11ce, {0xa5, 0x21, 0x00, 0x20, 0xaf, 0x0b, 0xe5, 0x60}};
static const GUID IID_IDirectDraw2 = {0xb3a6f3e0, 0x2b43, 0x11cf, {0xa2, 0xde, 0x00, 0xaa, 0x00, 0xb9, 0x33, 0x56}};

/* Method names by slot, for the ones not written. */
static const char *const directdraw_methods[] = {
    "QueryInterface", "AddRef", "Release", "Compact", "CreateClipper", "CreatePalette",
    "CreateSurface", "DuplicateSurface", "EnumDisplayModes", "EnumSurfaces", "FlipToGDISurface",
    "GetCaps", "GetDisplayMode", "GetFourCCCodes", "GetGDISurface", "GetMonitorFrequency",
    "GetScanLine", "GetVerticalBlankStatus", "Initialize", "RestoreDisplayMode",
    "SetCooperativeLevel", "SetDisplayMode", "WaitForVerticalBlank", "GetAvailableVidMem",
};
#define DIRECTDRAW_SLOTS 23
#define DIRECTDRAW2_SLOTS 24

/* One DirectDraw object; its IDirectDraw and IDirectDraw2 faces share it. */
struct face {
  void **vtable;
  struct directdraw *dd;
};

struct directdraw {
  struct face v1, v2;
  LONG refs;
  HWND window;
  DWORD cooperative;
};

static void *vtable_dd1[DIRECTDRAW_SLOTS], *vtable_dd2[DIRECTDRAW2_SLOTS];

static int same_guid(const GUID *a, const GUID *b) { return memcmp(a, b, sizeof *a) == 0; }

static HRESULT WINAPI dd_QueryInterface(struct face *self, const GUID *iid, void **out) {
  struct directdraw *dd = self->dd;
  if (same_guid(iid, &IID_IDirectDraw)) {
    *out = &dd->v1;
  } else if (same_guid(iid, &IID_IDirectDraw2)) {
    *out = &dd->v2;
  } else {
    trace("IDirectDraw::QueryInterface {%08x-...}: no", iid->d1);
    *out = NULL;
    return E_NOINTERFACE;
  }
  dd->refs++;
  return DD_OK;
}

static ULONG WINAPI dd_AddRef(struct face *self) { return (ULONG)++self->dd->refs; }

static ULONG WINAPI dd_Release(struct face *self) {
  /* Never freed: the game makes one and keeps it to the end. */
  return (ULONG)(self->dd->refs > 0 ? --self->dd->refs : 0);
}

static HRESULT WINAPI dd_SetCooperativeLevel(struct face *self, HWND window, DWORD flags) {
  trace("IDirectDraw::SetCooperativeLevel 0x%x", flags);
  self->dd->window = window;
  self->dd->cooperative = flags;
  return DD_OK;
}

/* No hardware features: a DDCAPS of zeros (its size kept). */
static HRESULT WINAPI dd_GetCaps(struct face *self, DWORD *hal, DWORD *hel) {
  (void)self;
  if (hal) memset(hal + 1, 0, hal[0] - 4);
  if (hel) memset(hel + 1, 0, hel[0] - 4);
  return DD_OK;
}

/* ---- Surfaces: 32-bit XRGB memory; the primary is the whole screen (windowed mode) ---- */

#define SCREEN_WIDTH 1280
#define SCREEN_HEIGHT 1024

#define DDSD_CAPS 0x1
#define DDSD_HEIGHT 0x2
#define DDSD_WIDTH 0x4
#define DDSD_PITCH 0x8
#define DDSD_LPSURFACE 0x800
#define DDSD_PIXELFORMAT 0x1000
#define DDSCAPS_PRIMARYSURFACE 0x200
#define DDPF_RGB 0x40
#define DDBLT_COLORFILL 0x400
#define DDERR_INVALIDPARAMS ((HRESULT)0x80070057)

typedef struct {
  DWORD dwSize, dwFlags, dwFourCC, dwRGBBitCount, dwRBitMask, dwGBitMask, dwBBitMask,
      dwRGBAlphaBitMask;
} DDPIXELFORMAT;
_Static_assert(sizeof(DDPIXELFORMAT) == 32, "DDPIXELFORMAT");

typedef struct {
  DWORD dwSize, dwFlags, dwHeight, dwWidth;
  LONG lPitch;
  DWORD dwBackBufferCount, dwRefreshRate, dwAlphaBitDepth, dwReserved;
  void *lpSurface;
  DWORD colour_keys[8];
  DDPIXELFORMAT ddpfPixelFormat;
  DWORD dwCaps;
} DDSURFACEDESC;
_Static_assert(sizeof(DDSURFACEDESC) == 0x6c, "DDSURFACEDESC");

static const DDPIXELFORMAT xrgb = {32, DDPF_RGB, 0, 32, 0xff0000, 0xff00, 0xff, 0};

static const char *const surface_methods[] = {
    "QueryInterface", "AddRef", "Release", "AddAttachedSurface", "AddOverlayDirtyRect", "Blt",
    "BltBatch", "BltFast", "DeleteAttachedSurface", "EnumAttachedSurfaces", "EnumOverlayZOrders",
    "Flip", "GetAttachedSurface", "GetBltStatus", "GetCaps", "GetClipper", "GetColorKey",
    "GetDC", "GetFlipStatus", "GetOverlayPosition", "GetPalette", "GetPixelFormat",
    "GetSurfaceDesc", "Initialize", "IsLost", "Lock", "ReleaseDC", "Restore", "SetClipper",
    "SetColorKey", "SetOverlayPosition", "SetPalette", "Unlock", "UpdateOverlay",
    "UpdateOverlayDisplay", "UpdateOverlayZOrder",
};
#define SURFACE_SLOTS 36

static const char *const palette_methods[] = {
    "QueryInterface", "AddRef", "Release", "GetCaps", "GetEntries", "Initialize", "SetEntries",
};
#define PALETTE_SLOTS 7

static const char *const clipper_methods[] = {
    "QueryInterface", "AddRef", "Release", "GetClipList", "GetHWnd", "Initialize",
    "IsClipListChanged", "SetClipList", "SetHWnd",
};
#define CLIPPER_SLOTS 9

struct surface {
  void **vtable;
  LONG refs;
  int width, height, pitch; /* pitch in bytes */
  DWORD caps;
  DWORD *pixels;
  struct palette *palette;
};

struct palette {
  void **vtable;
  LONG refs;
  DWORD flags;
  BYTE entries[256][4]; /* PALETTEENTRY: red, green, blue, flags */
};

static void *vtable_surface[SURFACE_SLOTS], *vtable_palette[PALETTE_SLOTS],
    *vtable_clipper[CLIPPER_SLOTS];

/* How many times something was drawn onto the primary surface (the picture changed). */
unsigned screen_updates;
static struct surface *primary;

static HRESULT WINAPI no_interface(void *self, const GUID *iid, void **out) {
  (void)self;
  trace("QueryInterface {%08x-...} on a surface/palette: no", iid->d1);
  *out = NULL;
  return E_NOINTERFACE;
}

static ULONG WINAPI surface_AddRef(struct surface *s) { return (ULONG)++s->refs; }

static ULONG WINAPI surface_Release(struct surface *s) {
  LONG refs = --s->refs;
  if (refs <= 0) {
    if (s == primary) primary = NULL;
    free(s->pixels);
    free(s);
    return 0;
  }
  return (ULONG)refs;
}

static void describe(const struct surface *s, DDSURFACEDESC *desc) {
  memset((BYTE *)desc + 4, 0, sizeof *desc - 4);
  desc->dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT;
  desc->dwHeight = (DWORD)s->height;
  desc->dwWidth = (DWORD)s->width;
  desc->lPitch = s->pitch;
  desc->ddpfPixelFormat = xrgb;
  desc->dwCaps = s->caps;
}

static HRESULT WINAPI surface_GetSurfaceDesc(struct surface *s, DDSURFACEDESC *desc) {
  if (!desc || desc->dwSize != sizeof *desc) return DDERR_INVALIDPARAMS;
  describe(s, desc);
  return DD_OK;
}

static HRESULT WINAPI surface_GetPixelFormat(struct surface *s, DDPIXELFORMAT *format) {
  (void)s;
  *format = xrgb;
  return DD_OK;
}

static HRESULT WINAPI surface_Lock(struct surface *s, const RECT *rect, DDSURFACEDESC *desc,
                                   DWORD flags, HANDLE event) {
  (void)flags, (void)event;
  describe(s, desc);
  desc->dwFlags |= DDSD_LPSURFACE;
  BYTE *p = (BYTE *)s->pixels;
  if (rect) p += rect->top * s->pitch + rect->left * 4;
  desc->lpSurface = p;
  return DD_OK;
}

static HRESULT WINAPI surface_Unlock(struct surface *s, void *rect) {
  (void)rect;
  if (s == primary) screen_updates++;
  return DD_OK;
}

/* Clips a source rectangle and its destination point to both surfaces. */
static int clip(const struct surface *dst, const struct surface *src, int *x, int *y, RECT *r) {
  if (r->left < 0) *x -= r->left, r->left = 0;
  if (r->top < 0) *y -= r->top, r->top = 0;
  if (*x < 0) r->left -= *x, *x = 0;
  if (*y < 0) r->top -= *y, *y = 0;
  if (r->right > src->width) r->right = src->width;
  if (r->bottom > src->height) r->bottom = src->height;
  if (r->right - r->left > dst->width - *x) r->right = r->left + dst->width - *x;
  if (r->bottom - r->top > dst->height - *y) r->bottom = r->top + dst->height - *y;
  return r->right > r->left && r->bottom > r->top;
}

static void copy_rect(struct surface *dst, int x, int y, const struct surface *src, RECT r) {
  if (!clip(dst, src, &x, &y, &r)) return;
  for (int row = 0; row < r.bottom - r.top; row++)
    memcpy((BYTE *)dst->pixels + (y + row) * dst->pitch + x * 4,
           (BYTE *)src->pixels + (r.top + row) * src->pitch + r.left * 4,
           (size_t)(r.right - r.left) * 4);
  if (dst == primary) screen_updates++;
}

static HRESULT WINAPI surface_BltFast(struct surface *dst, DWORD x, DWORD y, struct surface *src,
                                      const RECT *rect, DWORD trans) {
  if (trans & 3) fatal("BltFast with a colour key (0x%x)", trans);
  RECT r = rect ? *rect : (RECT){0, 0, src->width, src->height};
  copy_rect(dst, (int)x, (int)y, src, r);
  return DD_OK;
}

static HRESULT WINAPI surface_Blt(struct surface *dst, const RECT *dst_rect, struct surface *src,
                                  const RECT *src_rect, DWORD flags, const DWORD *fx) {
  RECT d = dst_rect ? *dst_rect : (RECT){0, 0, dst->width, dst->height};
  if (flags & DDBLT_COLORFILL) {
    DWORD colour = fx[0x50 / 4]; /* DDBLTFX.dwFillColor */
    for (int y = d.top < 0 ? 0 : d.top; y < d.bottom && y < dst->height; y++)
      for (int x = d.left < 0 ? 0 : d.left; x < d.right && x < dst->width; x++)
        dst->pixels[y * dst->pitch / 4 + x] = colour;
    if (dst == primary) screen_updates++;
    return DD_OK;
  }
  if (!src) fatal("Blt without a source, flags 0x%x", flags);
  RECT r = src_rect ? *src_rect : (RECT){0, 0, src->width, src->height};
  int dw = d.right - d.left, dh = d.bottom - d.top, sw = r.right - r.left, sh = r.bottom - r.top;
  if (dw == sw && dh == sh) {
    copy_rect(dst, d.left, d.top, src, r);
    return DD_OK;
  }
  /* Stretched: nearest pixel. */
  for (int y = 0; y < dh; y++) {
    int ty = d.top + y, sy = r.top + y * sh / dh;
    if (ty < 0 || ty >= dst->height || sy < 0 || sy >= src->height) continue;
    for (int x = 0; x < dw; x++) {
      int tx = d.left + x, sx = r.left + x * sw / dw;
      if (tx < 0 || tx >= dst->width || sx < 0 || sx >= src->width) continue;
      dst->pixels[ty * dst->pitch / 4 + tx] = src->pixels[sy * src->pitch / 4 + sx];
    }
  }
  if (dst == primary) screen_updates++;
  return DD_OK;
}

static HRESULT WINAPI surface_ok(struct surface *s) {
  (void)s;
  return DD_OK; /* IsLost, Restore: memory is never lost */
}

static HRESULT WINAPI surface_SetPalette(struct surface *s, struct palette *p) {
  if (p) p->refs++;
  if (s->palette && --s->palette->refs <= 0) free(s->palette);
  s->palette = p;
  return DD_OK;
}

static HRESULT WINAPI dd_CreateSurface(struct face *self, const DDSURFACEDESC *desc,
                                       struct surface **out, void *outer) {
  (void)self, (void)outer;
  struct surface *s = calloc(1, sizeof *s);
  s->vtable = vtable_surface;
  s->refs = 1;
  s->caps = desc->dwFlags & DDSD_CAPS ? desc->dwCaps : 0;
  if (s->caps & DDSCAPS_PRIMARYSURFACE) {
    s->width = SCREEN_WIDTH;
    s->height = SCREEN_HEIGHT;
    primary = s;
  } else if ((desc->dwFlags & (DDSD_WIDTH | DDSD_HEIGHT)) == (DDSD_WIDTH | DDSD_HEIGHT)) {
    s->width = (int)desc->dwWidth;
    s->height = (int)desc->dwHeight;
  } else {
    fatal("CreateSurface without a size (flags 0x%x, caps 0x%x)", desc->dwFlags, s->caps);
  }
  if (desc->dwFlags & DDSD_PIXELFORMAT && desc->ddpfPixelFormat.dwRGBBitCount != 32)
    fatal("CreateSurface with %u bits per pixel", desc->ddpfPixelFormat.dwRGBBitCount);
  s->pitch = s->width * 4;
  s->pixels = calloc((size_t)s->height, (size_t)s->pitch);
  trace("CreateSurface %dx%d caps 0x%x -> %p", s->width, s->height, s->caps, (void *)s);
  *out = s;
  return DD_OK;
}

/* ---- Palettes and clippers ---- */

static ULONG WINAPI palette_AddRef(struct palette *p) { return (ULONG)++p->refs; }

static ULONG WINAPI palette_Release(struct palette *p) {
  LONG refs = --p->refs;
  if (refs <= 0) free(p);
  return refs <= 0 ? 0 : (ULONG)refs;
}

static HRESULT WINAPI palette_GetEntries(struct palette *p, DWORD flags, DWORD start, DWORD count,
                                         BYTE *entries) {
  (void)flags;
  if (start + count > 256) return DDERR_INVALIDPARAMS;
  memcpy(entries, p->entries[start], count * 4);
  return DD_OK;
}

static HRESULT WINAPI palette_SetEntries(struct palette *p, DWORD flags, DWORD start, DWORD count,
                                         const BYTE *entries) {
  (void)flags;
  if (start + count > 256) return DDERR_INVALIDPARAMS;
  memcpy(p->entries[start], entries, count * 4);
  return DD_OK;
}

static HRESULT WINAPI dd_CreatePalette(struct face *self, DWORD flags, const BYTE *entries,
                                       struct palette **out, void *outer) {
  (void)self, (void)outer;
  struct palette *p = calloc(1, sizeof *p);
  p->vtable = vtable_palette;
  p->refs = 1;
  p->flags = flags;
  if (entries) memcpy(p->entries, entries, sizeof p->entries);
  *out = p;
  return DD_OK;
}

static HRESULT WINAPI dd_CreateClipper(struct face *self, DWORD flags, void **out, void *outer) {
  (void)self, (void)flags, (void)outer;
  void **clipper = calloc(2, sizeof *clipper);
  clipper[0] = vtable_clipper;
  *out = clipper;
  return DD_OK;
}

/* ---- Vtables ---- */

static void fill_vtable(void **vtable, int slots, const char *interface,
                        const char *const *methods) {
  for (int i = 0; i < slots; i++) {
    if (vtable[i]) continue;
    size_t n = strlen(interface) + strlen(methods[i]) + 3;
    char *name = malloc(n);
    strcpy(name, interface);
    strcat(name, "::");
    strcat(name, methods[i]);
    vtable[i] = missing_function(name);
  }
}

static void make_vtables(void) {
  if (vtable_dd1[0]) return;
  void **tables[] = {vtable_dd1, vtable_dd2};
  for (int t = 0; t < 2; t++) {
    void **v = tables[t];
    v[0] = dd_QueryInterface;
    v[1] = dd_AddRef;
    v[2] = dd_Release;
    v[4] = dd_CreateClipper;
    v[5] = dd_CreatePalette;
    v[6] = dd_CreateSurface;
    v[11] = dd_GetCaps;
    v[20] = dd_SetCooperativeLevel;
  }
  fill_vtable(vtable_dd1, DIRECTDRAW_SLOTS, "IDirectDraw", directdraw_methods);
  fill_vtable(vtable_dd2, DIRECTDRAW2_SLOTS, "IDirectDraw2", directdraw_methods);

  void **s = vtable_surface;
  s[0] = no_interface;
  s[1] = surface_AddRef;
  s[2] = surface_Release;
  s[5] = surface_Blt;
  s[7] = surface_BltFast;
  s[21] = surface_GetPixelFormat;
  s[22] = surface_GetSurfaceDesc;
  s[24] = surface_ok; /* IsLost */
  s[25] = surface_Lock;
  s[27] = surface_ok; /* Restore */
  s[31] = surface_SetPalette;
  s[32] = surface_Unlock;
  fill_vtable(vtable_surface, SURFACE_SLOTS, "IDirectDrawSurface", surface_methods);

  void **p = vtable_palette;
  p[0] = no_interface;
  p[1] = palette_AddRef;
  p[2] = palette_Release;
  p[4] = palette_GetEntries;
  p[6] = palette_SetEntries;
  fill_vtable(vtable_palette, PALETTE_SLOTS, "IDirectDrawPalette", palette_methods);

  vtable_clipper[0] = no_interface;
  fill_vtable(vtable_clipper, CLIPPER_SLOTS, "IDirectDrawClipper", clipper_methods);
}

static HRESULT WINAPI DirectDrawCreate(const GUID *guid, void **out, void *outer) {
  (void)guid, (void)outer;
  make_vtables();
  struct directdraw *dd = calloc(1, sizeof *dd);
  dd->v1 = (struct face){vtable_dd1, dd};
  dd->v2 = (struct face){vtable_dd2, dd};
  dd->refs = 1;
  *out = &dd->v1;
  trace("DirectDrawCreate");
  return DD_OK;
}

const struct export ddraw_exports[] = {
    {"DirectDrawCreate", DirectDrawCreate},
    {NULL, NULL},
};
