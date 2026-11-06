/* GDI32: objects as plain handles for now; drawing (StretchDIBits into SDL) is milestone 2. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ui.h"
#include "wrapper.h"

static HANDLE fake_object(void) { return handle_new(HANDLE_OTHER, NULL, NULL); }

static HFONT WINAPI CreateFontA(INT height, INT width, INT escapement, INT orientation, INT weight,
                                DWORD italic, DWORD underline, DWORD strike, DWORD charset,
                                DWORD out_precision, DWORD clip_precision, DWORD quality,
                                DWORD pitch, LPCSTR face) {
  (void)width, (void)escapement, (void)orientation, (void)italic, (void)underline, (void)strike;
  (void)charset, (void)out_precision, (void)clip_precision, (void)quality, (void)pitch;
  trace("CreateFontA %s %d weight %d", face ? face : "", height, weight);
  return fake_object();
}

static BOOL WINAPI DeleteObject(HGDIOBJ object) {
  handle_close(object);
  return TRUE;
}

static HGDIOBJ WINAPI GetStockObject(INT which) {
  static HGDIOBJ stock[20];
  if (which < 0 || which >= 20) return NULL;
  if (!stock[which]) stock[which] = fake_object();
  return stock[which];
}

/* A true-colour screen, as under Wine: the game then converts its palette itself. */
static INT WINAPI GetDeviceCaps(HDC dc, INT index) {
  (void)dc;
  switch (index) {
  case 8: return 1280;  /* HORZRES */
  case 10: return 1024; /* VERTRES */
  case 12: return 32;   /* BITSPIXEL */
  case 14: return 1;    /* PLANES */
  case 38: return 0x7e99; /* RASTERCAPS: no RC_PALETTE (0x100) */
  case 104: return 0;   /* SIZEPALETTE */
  case 116: return 60;  /* VREFRESH */
  }
  trace("GetDeviceCaps %d: 0", index);
  return 0;
}

typedef struct {
  BYTE peRed, peGreen, peBlue, peFlags;
} PALETTEENTRY;

typedef struct {
  WORD palVersion, palNumEntries;
  PALETTEENTRY palPalEntry[1];
} LOGPALETTE;

struct palette {
  int count;
  PALETTEENTRY entries[256];
};

static HPALETTE WINAPI CreatePalette(const LOGPALETTE *log) {
  struct palette *p = calloc(1, sizeof *p);
  p->count = log->palNumEntries > 256 ? 256 : log->palNumEntries;
  memcpy(p->entries, log->palPalEntry, (size_t)p->count * sizeof *p->entries);
  return handle_new(HANDLE_OTHER, p, free);
}

/* One palette for all DCs: the game draws into one window. */
static HPALETTE selected;

static HPALETTE WINAPI SelectPalette(HDC dc, HPALETTE palette, BOOL background) {
  (void)dc, (void)background;
  HPALETTE old = selected;
  selected = palette;
  return old;
}

static UINT WINAPI RealizePalette(HDC dc) {
  (void)dc;
  return 0;
}

static BOOL WINAPI UpdateColors(HDC dc) {
  (void)dc;
  return TRUE;
}

/* The last picture the game presented: palette indices and the colours of its bitmap info. */
BYTE frame_pixels[640 * 480];
DWORD frame_colours[256]; /* 0x00RRGGBB */
int frame_width, frame_height;
unsigned frame_count;

typedef struct {
  DWORD biSize;
  LONG biWidth, biHeight;
  WORD biPlanes, biBitCount;
  DWORD biCompression, biSizeImage;
  LONG biXPelsPerMeter, biYPelsPerMeter;
  DWORD biClrUsed, biClrImportant;
} BITMAPINFOHEADER;
_Static_assert(sizeof(BITMAPINFOHEADER) == 40, "BITMAPINFOHEADER");

static INT WINAPI StretchDIBits(HDC dc, INT x, INT y, INT width, INT height, INT src_x, INT src_y,
                                INT src_width, INT src_height, const void *bits,
                                const BITMAPINFOHEADER *info, UINT usage, DWORD rop) {
  (void)dc, (void)x, (void)y, (void)width, (void)height, (void)rop;
  int w = info->biWidth, h = info->biHeight < 0 ? -info->biHeight : info->biHeight;
  if (info->biBitCount != 8 || usage > 1)
    fatal("StretchDIBits: %d bits, usage %u", info->biBitCount, usage);
  if (src_x || src_y || src_width != w || src_height != h || w > 640 || h > 480)
    fatal("StretchDIBits: part %d,%d %dx%d of %dx%d", src_x, src_y, src_width, src_height, w, h);
  const BYTE *table = (const BYTE *)info + info->biSize;
  int colours = info->biClrUsed ? (int)info->biClrUsed : 256;
  if (usage == 0) { /* DIB_RGB_COLORS: RGBQUADs */
    for (int i = 0; i < colours && i < 256; i++)
      frame_colours[i] =
          (DWORD)table[4 * i + 2] << 16 | (DWORD)table[4 * i + 1] << 8 | table[4 * i];
  } else { /* DIB_PAL_COLORS: indices into the selected palette */
    const struct palette *p = handle_get(selected, HANDLE_OTHER);
    if (!p) fatal("StretchDIBits with palette colours but no palette selected");
    for (int i = 0; i < colours && i < 256; i++) {
      WORD index = (WORD)(table[2 * i] | table[2 * i + 1] << 8);
      const PALETTEENTRY *e = &p->entries[index < p->count ? index : 0];
      frame_colours[i] = (DWORD)e->peRed << 16 | (DWORD)e->peGreen << 8 | e->peBlue;
    }
  }
  int stride = (w + 3) & ~3;
  for (int row = 0; row < h; row++) {
    int from = info->biHeight < 0 ? row : h - 1 - row;
    memcpy(frame_pixels + row * w, (const BYTE *)bits + from * stride, (size_t)w);
  }
  frame_width = w;
  frame_height = h;
  if (frame_count++ == 0) trace("first frame: %dx%d", w, h);
  screen_present();
  return h;
}

/* Writes the last frame as a PPM (for debugging: ROBOT_SHOT, written when stopped). */
void write_frame(const char *path) {
  FILE *f = fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", frame_width, frame_height);
  for (int i = 0; i < frame_width * frame_height; i++) {
    DWORD c = frame_colours[frame_pixels[i]];
    BYTE rgb[3] = {(BYTE)(c >> 16), (BYTE)(c >> 8), (BYTE)c};
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

const struct export gdi32_exports[] = {
    {"CreateFontA", CreateFontA},
    {"CreatePalette", CreatePalette},
    {"DeleteObject", DeleteObject},
    {"GetDeviceCaps", GetDeviceCaps},
    {"GetStockObject", GetStockObject},
    {"RealizePalette", RealizePalette},
    {"SelectPalette", SelectPalette},
    {"StretchDIBits", StretchDIBits},
    {"UpdateColors", UpdateColors},
    {NULL, NULL},
};
