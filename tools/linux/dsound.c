/* DSOUND on SDL2 audio: the game mixes its own OPL2 sound into a looping secondary buffer
   (STATUS.md "MUSIC"); this file is the DirectSound it writes to. One SDL device (or, if
   SDL cannot open one, a timer thread) consumes the playing buffers: its callback mixes
   them, moves their play cursors and signals the notification events, as a sound card
   would. The game's own thread (0x442270) waits on those events and refills the buffer
   halves with Lock/Unlock.

   What the game uses (init 0x442490): DirectSoundEnumerateA (picks the first device with a
   GUID and a module name), DirectSoundCreate; IDirectSound::SetCooperativeLevel,
   CreateSoundBuffer (the primary, then a secondary); IDirectSoundBuffer::SetFormat and
   GetFormat (primary), QueryInterface (IDirectSoundNotify), Play (looping), Lock, Unlock,
   Stop, Release; IDirectSoundNotify::SetNotificationPositions. Everything else stops the
   program (missing_function). */
#define _GNU_SOURCE
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ui.h"
#include "wrapper.h"

#define DS_OK 0
#define E_NOINTERFACE ((HRESULT)0x80004002)
#define DSERR_INVALIDPARAM ((HRESULT)0x80070057)
#define DSERR_OUTOFMEMORY ((HRESULT)0x8007000E)
#define DSERR_UNSUPPORTED ((HRESULT)0x80004001)
#define DSERR_NODRIVER ((HRESULT)0x88780078)
#define DSERR_ALLOCATED ((HRESULT)0x8878000A)

#define DSBCAPS_PRIMARYBUFFER 1
#define DSBPLAY_LOOPING 1
#define DSBLOCK_FROMWRITECURSOR 1
#define DSBLOCK_ENTIREBUFFER 2
#define DSBSTATUS_PLAYING 1
#define DSBSTATUS_LOOPING 4
#define DSBPN_OFFSETSTOP 0xFFFFFFFFu

typedef struct {
  DWORD d1;
  WORD d2, d3;
  BYTE d4[8];
} GUID;

#pragma pack(push, 1)
typedef struct {
  WORD wFormatTag, nChannels;
  DWORD nSamplesPerSec, nAvgBytesPerSec;
  WORD nBlockAlign, wBitsPerSample, cbSize;
} WAVEFORMATEX;
#pragma pack(pop)
_Static_assert(sizeof(WAVEFORMATEX) == 18, "WAVEFORMATEX");

typedef struct {
  DWORD dwSize, dwFlags, dwBufferBytes, dwReserved;
  WAVEFORMATEX *lpwfxFormat; /* a 32-bit pointer in the game */
} DSBUFFERDESC;
_Static_assert(sizeof(DSBUFFERDESC) == 20, "DSBUFFERDESC");

typedef struct {
  DWORD dwSize, dwFlags, dwBufferBytes, dwUnlockTransferRate, dwPlayCpuOverhead;
} DSBCAPS;

typedef struct {
  DWORD dwOffset;
  HANDLE hEventNotify;
} DSBPOSITIONNOTIFY;
_Static_assert(sizeof(DSBPOSITIONNOTIFY) == 8, "DSBPOSITIONNOTIFY");

static const GUID IID_IUnknown = {0, 0, 0, {0xc0, 0, 0, 0, 0, 0, 0, 0x46}};
static const GUID IID_IDirectSound = {0x279afa83, 0x4981, 0x11ce, {0xa5, 0x21, 0x00, 0x20, 0xaf, 0x0b, 0xe5, 0x60}};
static const GUID IID_IDirectSoundBuffer = {0x279afa85, 0x4981, 0x11ce, {0xa5, 0x21, 0x00, 0x20, 0xaf, 0x0b, 0xe5, 0x60}};
static const GUID IID_IDirectSoundNotify = {0xb0210783, 0x89cd, 0x11d0, {0xaf, 0x08, 0x00, 0xa0, 0xc9, 0x25, 0xcd, 0x16}};
/* The one device we list next to the default (NULL GUID) one. */
static const GUID device_guid = {0x7a3d5e10, 0x5d4c, 0x4b1e, {0x9a, 0x01, 0x52, 0x6f, 0x62, 0x6f, 0x74, 0x01}};

static int same_guid(const GUID *a, const GUID *b) { return memcmp(a, b, sizeof *a) == 0; }

/* ---- SDL audio availability ---- */

static int audio_probed, audio_ok;

/* Also for WINMM's waveOutGetDevCapsA (misc.c). */
int dsound_audio_available(void);
int dsound_audio_available(void) {
  if (!audio_probed) {
    audio_probed = 1;
    audio_ok = !driver_active() && SDL_InitSubSystem(SDL_INIT_AUDIO) == 0; /* silent under a driver */
    if (!audio_ok && !driver_active()) say("sound: SDL audio is not available (%s): silent", SDL_GetError());
  }
  return audio_ok;
}

/* ---- Objects ---- */

#define MAX_NOTIFY 16
#define MAX_BUFFERS 32
#define PERIOD_FRAMES 1024 /* SDL's buffer; the write cursor leads the play cursor by this */

struct buffer;
struct notify_face {
  void **vtable;
  struct buffer *buffer;
};

struct buffer {
  void **vtable; /* first: this is the COM object */
  struct notify_face notify;
  LONG refs;
  struct dsound *ds;
  int primary;
  DWORD flags, size;
  BYTE *data;
  WAVEFORMATEX format;
  int playing, looping, just_started;
  DWORD pos;   /* play cursor, bytes */
  DWORD frac;  /* 16.16: how far into the source frame at pos the output is */
  LONG volume; /* hundredths of dB, <= 0 */
  LONG pan;    /* hundredths of dB, -10000 (left) .. 10000 (right) */
  DWORD frequency;
  DWORD notify_count;
  DSBPOSITIONNOTIFY notifications[MAX_NOTIFY];
};

struct dsound {
  void **vtable;
  LONG refs;
  WAVEFORMATEX primary_format; /* what SetFormat on the primary buffer set */
  int primary_set;
};

static pthread_mutex_t mix_lock = PTHREAD_MUTEX_INITIALIZER; /* buffer state vs. the mixer */
static struct buffer *active[MAX_BUFFERS];                   /* the live secondary buffers */

static SDL_AudioDeviceID device;
static int device_rate; /* output sample rate (always stereo S16) */
static int device_users;
static pthread_t timer_thread;
static volatile int timer_running;
static int timer_started;

static BOOL(WINAPI *set_event)(HANDLE);

/* ---- Mixer ---- */

/* Events to signal once the lock is released (SetEvent takes kernel32's locks). */
struct signals {
  HANDLE events[64];
  int count;
};

static void signal_add(struct signals *s, HANDLE e) {
  if (s->count < 64) s->events[s->count++] = e;
}

static void signal_send(const struct signals *s) {
  for (int i = 0; i < s->count; i++) set_event(s->events[i]);
}

static void fire_stop(const struct buffer *b, struct signals *s) {
  for (DWORD i = 0; i < b->notify_count; i++)
    if (b->notifications[i].dwOffset == DSBPN_OFFSETSTOP)
      signal_add(s, b->notifications[i].hEventNotify);
}

/* The play cursor moved from `old` by one frame: signal the positions it passed. */
static void fire_crossed(const struct buffer *b, DWORD old, struct signals *s) {
  for (DWORD i = 0; i < b->notify_count; i++) {
    DWORD off = b->notifications[i].dwOffset;
    if (off == DSBPN_OFFSETSTOP || off >= b->size) continue;
    DWORD d = (off + b->size - old) % b->size;
    if (d > 0 && d <= b->format.nBlockAlign) signal_add(s, b->notifications[i].hEventNotify);
  }
}

static float gain_of(LONG hundredths_db) {
  if (hundredths_db <= -10000) return 0;
  if (hundredths_db >= 0) return 1;
  return powf(10.0f, (float)hundredths_db / 2000.0f); /* 10^(dB / 20) */
}

static int sample_at(const struct buffer *b, DWORD byte_pos, int channel) {
  DWORD bytes = b->format.wBitsPerSample / 8;
  DWORD at = byte_pos + (b->format.nChannels > 1 ? (DWORD)channel * bytes : 0);
  if (at + bytes > b->size) return 0;
  if (bytes == 1) return ((int)b->data[at] - 128) << 8;
  return (int16_t)(b->data[at] | b->data[at + 1] << 8);
}

/* ---- The wrapper's master volume (Ctrl+Shift+Up/Down/M, ui.c), over the game's own ---- */

static int volume_percent = -1, muted; /* -1: not read from the settings yet */
static volatile float master_gain = 1.0f; /* what the mixer applies */

static void load_volume(void) {
  if (volume_percent >= 0) return;
  volume_percent = (int)wrapper_setting("Volume", 100);
  if (volume_percent > 100) volume_percent = 100;
  muted = wrapper_setting("Mute", 0) != 0;
}

/* Percent to gain on a curve close to how loudness is heard (squared). */
static void update_gain(void) {
  float v = (float)volume_percent / 100.0f;
  master_gain = muted ? 0.0f : v * v;
}

int sound_volume(int percent) {
  load_volume();
  if (percent >= 0 || percent < -1) {
    volume_percent = percent < 0 ? 0 : percent > 100 ? 100 : percent;
    wrapper_setting_set("Volume", (DWORD)volume_percent);
    update_gain();
    say("robot: volume %d%%%s", volume_percent, muted ? " (muted)" : "");
  }
  return volume_percent;
}

int sound_mute(int on) {
  load_volume();
  if (on != -2) {
    muted = on < 0 ? !muted : on != 0;
    wrapper_setting_set("Mute", (DWORD)muted);
    update_gain();
    say("robot: sound %s", muted ? "muted" : "on");
  }
  return muted;
}

/* Mixes `frames` stereo S16 frames into `out` (NULL: only move the cursors, no output). */
static void mix(int16_t *out, int frames, int rate) {
  struct signals sig = {.count = 0};
  int32_t *acc = out ? calloc((size_t)frames * 2, sizeof *acc) : NULL;
  pthread_mutex_lock(&mix_lock);
  for (int n = 0; n < MAX_BUFFERS; n++) {
    struct buffer *b = active[n];
    if (!b || !b->playing) continue;
    DWORD align = b->format.nBlockAlign;
    DWORD step = (DWORD)(((uint64_t)b->frequency << 16) / (uint32_t)rate);
    float volume = gain_of(b->volume);
    float left = volume * gain_of(b->pan > 0 ? -b->pan : 0);
    float right = volume * gain_of(b->pan < 0 ? b->pan : 0);
    if (b->just_started) { /* a notification at the start position fires at once, as on Windows */
      b->just_started = 0;
      fire_crossed(b, (b->pos + b->size - align) % b->size, &sig);
    }
    for (int i = 0; i < frames && b->playing; i++) {
      if (acc) {
        acc[2 * i] += (int32_t)((float)sample_at(b, b->pos, 0) * left);
        acc[2 * i + 1] += (int32_t)((float)sample_at(b, b->pos, 1) * right);
      }
      b->frac += step;
      while (b->frac >= 0x10000 && b->playing) {
        b->frac -= 0x10000;
        DWORD old = b->pos;
        b->pos += align;
        if (b->pos >= b->size) {
          b->pos = 0;
          if (!b->looping) {
            b->playing = 0;
            b->frac = 0;
            fire_stop(b, &sig);
          }
        }
        fire_crossed(b, old, &sig);
      }
    }
  }
  pthread_mutex_unlock(&mix_lock);
  if (acc) {
    float master = master_gain;
    for (int i = 0; i < frames * 2; i++) {
      int32_t v = master == 1.0f ? acc[i] : (int32_t)((float)acc[i] * master);
      out[i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
    free(acc);
  }
  signal_send(&sig);
}

static void sdl_callback(void *userdata, Uint8 *stream, int len) {
  (void)userdata;
  mix((int16_t *)stream, len / 4, device_rate);
}

/* No sound card: consume the buffers on a timer, so the game's refill loop runs the same. */
static void *timer_main(void *arg) {
  (void)arg;
  struct timespec next;
  clock_gettime(CLOCK_MONOTONIC, &next);
  while (timer_running) {
    mix(NULL, PERIOD_FRAMES, device_rate);
    next.tv_nsec += (long)((int64_t)PERIOD_FRAMES * 1000000000 / device_rate);
    while (next.tv_nsec >= 1000000000) next.tv_nsec -= 1000000000, next.tv_sec++;
    clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
  }
  return NULL;
}

/* Starts the output when a secondary buffer first plays: stereo S16 at the primary format's
   rate (the buffer's if the game never set one); SDL converts to what the hardware wants. */
static void device_start(const struct buffer *b) {
  if (device || timer_started) return;
  if (!set_event) set_event = find_export("kernel32.dll", "SetEvent");
  device_rate = (int)(b->ds->primary_set ? b->ds->primary_format.nSamplesPerSec
                                         : b->format.nSamplesPerSec);
  if (device_rate < 4000 || device_rate > 192000) device_rate = 32000;
  SDL_AudioSpec want = {.freq = device_rate, .format = AUDIO_S16SYS, .channels = 2,
                        .samples = PERIOD_FRAMES, .callback = sdl_callback};
  SDL_AudioSpec have;
  device = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
  if (device) {
    trace("sound: SDL device opened: %d Hz, %d channels, format %#x, %d frames per period (driver %s)",
          have.freq, have.channels, have.format, have.samples, SDL_GetCurrentAudioDriver());
    SDL_PauseAudioDevice(device, 0);
    return;
  }
  say("sound: cannot open an SDL audio device (%s): running without output", SDL_GetError());
  timer_running = 1;
  timer_started = pthread_create(&timer_thread, NULL, timer_main, NULL) == 0;
  if (!timer_started) timer_running = 0;
}

static void device_stop(void) {
  if (device) {
    SDL_CloseAudioDevice(device);
    device = 0;
  }
  if (timer_started) {
    timer_running = 0;
    pthread_join(timer_thread, NULL);
    timer_started = 0;
  }
}

/* ---- IDirectSoundBuffer ---- */

static void *vtable_buffer[21], *vtable_notify[4], *vtable_ds[11];

static HRESULT WINAPI buffer_QueryInterface(struct buffer *b, const GUID *iid, void **out) {
  if (same_guid(iid, &IID_IDirectSoundNotify) && !b->primary) {
    *out = &b->notify;
  } else if (same_guid(iid, &IID_IUnknown) || same_guid(iid, &IID_IDirectSoundBuffer)) {
    *out = b;
  } else {
    trace("IDirectSoundBuffer::QueryInterface {%08x-...}: no", iid->d1);
    *out = NULL;
    return E_NOINTERFACE;
  }
  __sync_add_and_fetch(&b->refs, 1);
  return DS_OK;
}

static ULONG WINAPI buffer_AddRef(struct buffer *b) {
  return (ULONG)__sync_add_and_fetch(&b->refs, 1);
}

static ULONG WINAPI buffer_Release(struct buffer *b) {
  LONG refs = __sync_sub_and_fetch(&b->refs, 1);
  if (refs) return (ULONG)refs;
  pthread_mutex_lock(&mix_lock);
  for (int i = 0; i < MAX_BUFFERS; i++)
    if (active[i] == b) active[i] = NULL;
  pthread_mutex_unlock(&mix_lock);
  free(b->data);
  free(b);
  return 0;
}

static HRESULT WINAPI buffer_GetCaps(struct buffer *b, DSBCAPS *caps) {
  if (!caps || caps->dwSize < sizeof *caps) return DSERR_INVALIDPARAM;
  caps->dwFlags = b->flags;
  caps->dwBufferBytes = b->size;
  caps->dwUnlockTransferRate = 0;
  caps->dwPlayCpuOverhead = 0;
  return DS_OK;
}

static HRESULT WINAPI buffer_GetCurrentPosition(struct buffer *b, DWORD *play, DWORD *write) {
  pthread_mutex_lock(&mix_lock);
  DWORD p = b->pos, w = p;
  if (b->playing && b->size) {
    DWORD lead = (DWORD)((uint64_t)PERIOD_FRAMES * b->frequency / (DWORD)(device_rate ? device_rate : 32000));
    w = (p + lead * b->format.nBlockAlign) % b->size;
  }
  pthread_mutex_unlock(&mix_lock);
  if (play) *play = p;
  if (write) *write = w;
  return DS_OK;
}

static HRESULT WINAPI buffer_GetFormat(struct buffer *b, WAVEFORMATEX *out, DWORD size,
                                       DWORD *written) {
  DWORD n = size < sizeof b->format ? size : (DWORD)sizeof b->format;
  if (out) memcpy(out, &b->format, n);
  else if (size) return DSERR_INVALIDPARAM;
  if (written) *written = n;
  return DS_OK;
}

static HRESULT WINAPI buffer_GetVolume(struct buffer *b, LONG *v) {
  *v = b->volume;
  return DS_OK;
}

static HRESULT WINAPI buffer_GetPan(struct buffer *b, LONG *v) {
  *v = b->pan;
  return DS_OK;
}

static HRESULT WINAPI buffer_GetFrequency(struct buffer *b, DWORD *v) {
  *v = b->frequency;
  return DS_OK;
}

static HRESULT WINAPI buffer_GetStatus(struct buffer *b, DWORD *status) {
  *status = b->playing ? DSBSTATUS_PLAYING | (b->looping ? DSBSTATUS_LOOPING : 0) : 0;
  return DS_OK;
}

static HRESULT WINAPI buffer_Lock(struct buffer *b, DWORD offset, DWORD bytes, void **p1,
                                  DWORD *s1, void **p2, DWORD *s2, DWORD flags) {
  if (p1) *p1 = NULL;
  if (s1) *s1 = 0;
  if (p2) *p2 = NULL;
  if (s2) *s2 = 0;
  if (b->primary || !p1 || !s1) return DSERR_INVALIDPARAM;
  if (flags & DSBLOCK_FROMWRITECURSOR) buffer_GetCurrentPosition(b, NULL, &offset);
  if (flags & DSBLOCK_ENTIREBUFFER) bytes = b->size;
  if (offset >= b->size || bytes > b->size) return DSERR_INVALIDPARAM;
  DWORD first = b->size - offset < bytes ? b->size - offset : bytes;
  *p1 = b->data + offset;
  *s1 = first;
  if (first < bytes && p2 && s2) { /* wraps around */
    *p2 = b->data;
    *s2 = bytes - first;
  }
  return DS_OK;
}

static HRESULT WINAPI buffer_Unlock(struct buffer *b, void *p1, DWORD s1, void *p2, DWORD s2) {
  (void)b, (void)p1, (void)s1, (void)p2, (void)s2; /* the data was written in place */
  return DS_OK;
}

static HRESULT WINAPI buffer_Play(struct buffer *b, DWORD reserved, DWORD priority, DWORD flags) {
  (void)reserved, (void)priority;
  if (b->primary) return DS_OK; /* the primary buffer is only the format here */
  trace("sound: Play(flags %#x): %u bytes at %u Hz", flags, b->size, b->format.nSamplesPerSec);
  device_start(b);
  pthread_mutex_lock(&mix_lock);
  if (!b->playing) b->just_started = 1;
  b->playing = 1;
  b->looping = flags & DSBPLAY_LOOPING;
  pthread_mutex_unlock(&mix_lock);
  return DS_OK;
}

static HRESULT WINAPI buffer_Stop(struct buffer *b) {
  struct signals sig = {.count = 0};
  pthread_mutex_lock(&mix_lock);
  if (b->playing) {
    b->playing = 0;
    fire_stop(b, &sig);
  }
  pthread_mutex_unlock(&mix_lock);
  signal_send(&sig);
  return DS_OK;
}

static HRESULT WINAPI buffer_SetCurrentPosition(struct buffer *b, DWORD pos) {
  if (pos >= b->size) return DSERR_INVALIDPARAM;
  pthread_mutex_lock(&mix_lock);
  b->pos = pos - pos % b->format.nBlockAlign;
  b->frac = 0;
  pthread_mutex_unlock(&mix_lock);
  return DS_OK;
}

static int format_ok(const WAVEFORMATEX *f) {
  return f->wFormatTag == 1 && f->nChannels >= 1 && f->nChannels <= 2 &&
         (f->wBitsPerSample == 8 || f->wBitsPerSample == 16) && f->nSamplesPerSec != 0;
}

static HRESULT WINAPI buffer_SetFormat(struct buffer *b, const WAVEFORMATEX *f) {
  if (!b->primary || !f || !format_ok(f)) return DSERR_INVALIDPARAM;
  b->format = *f;
  b->format.cbSize = 0;
  b->format.nBlockAlign = (WORD)(f->nChannels * f->wBitsPerSample / 8);
  b->format.nAvgBytesPerSec = b->format.nBlockAlign * f->nSamplesPerSec;
  b->ds->primary_format = b->format;
  b->ds->primary_set = 1;
  trace("sound: primary SetFormat: %u Hz, %u channels, %u bits", f->nSamplesPerSec, f->nChannels,
        f->wBitsPerSample);
  return DS_OK;
}

static HRESULT WINAPI buffer_SetVolume(struct buffer *b, LONG v) {
  if (v > 0 || v < -10000) return DSERR_INVALIDPARAM;
  b->volume = v;
  return DS_OK;
}

static HRESULT WINAPI buffer_SetPan(struct buffer *b, LONG v) {
  if (v < -10000 || v > 10000) return DSERR_INVALIDPARAM;
  b->pan = v;
  return DS_OK;
}

static HRESULT WINAPI buffer_SetFrequency(struct buffer *b, DWORD v) {
  if (v == 0) v = b->format.nSamplesPerSec; /* DSBFREQUENCY_ORIGINAL */
  if (v < 100 || v > 200000) return DSERR_INVALIDPARAM;
  b->frequency = v;
  return DS_OK;
}

/* ---- IDirectSoundNotify ---- */

static HRESULT WINAPI notify_QueryInterface(struct notify_face *n, const GUID *iid, void **out) {
  return buffer_QueryInterface(n->buffer, iid, out);
}

static ULONG WINAPI notify_AddRef(struct notify_face *n) { return buffer_AddRef(n->buffer); }

static ULONG WINAPI notify_Release(struct notify_face *n) { return buffer_Release(n->buffer); }

static HRESULT WINAPI notify_SetNotificationPositions(struct notify_face *n, DWORD count,
                                                      const DSBPOSITIONNOTIFY *positions) {
  struct buffer *b = n->buffer;
  if (count > MAX_NOTIFY || (count && !positions)) return DSERR_INVALIDPARAM;
  trace("sound: SetNotificationPositions(%u)", count);
  pthread_mutex_lock(&mix_lock);
  b->notify_count = count;
  for (DWORD i = 0; i < count; i++) {
    b->notifications[i] = positions[i];
    trace("sound:   at %#x signal event %p", positions[i].dwOffset, positions[i].hEventNotify);
  }
  pthread_mutex_unlock(&mix_lock);
  return DS_OK;
}

/* ---- IDirectSound ---- */

static HRESULT WINAPI ds_QueryInterface(struct dsound *ds, const GUID *iid, void **out) {
  if (same_guid(iid, &IID_IUnknown) || same_guid(iid, &IID_IDirectSound)) {
    *out = ds;
    __sync_add_and_fetch(&ds->refs, 1);
    return DS_OK;
  }
  trace("IDirectSound::QueryInterface {%08x-...}: no", iid->d1);
  *out = NULL;
  return E_NOINTERFACE;
}

static ULONG WINAPI ds_AddRef(struct dsound *ds) {
  return (ULONG)__sync_add_and_fetch(&ds->refs, 1);
}

static ULONG WINAPI ds_Release(struct dsound *ds) {
  LONG refs = __sync_sub_and_fetch(&ds->refs, 1);
  if (refs) return (ULONG)refs;
  if (--device_users == 0) device_stop();
  free(ds);
  return 0;
}

static HRESULT WINAPI ds_SetCooperativeLevel(struct dsound *ds, HWND window, DWORD level) {
  (void)ds;
  trace("sound: SetCooperativeLevel(%p, %u)", window, level);
  return DS_OK;
}

static HRESULT WINAPI ds_CreateSoundBuffer(struct dsound *ds, const DSBUFFERDESC *desc,
                                           struct buffer **out, void *outer) {
  if (outer) return DSERR_UNSUPPORTED;
  if (!desc || desc->dwSize < sizeof *desc || !out) return DSERR_INVALIDPARAM;
  int primary = (desc->dwFlags & DSBCAPS_PRIMARYBUFFER) != 0;
  const WAVEFORMATEX *f = desc->lpwfxFormat;
  if (primary ? (desc->dwBufferBytes != 0 || f) : (!f || !format_ok(f) || desc->dwBufferBytes < 4))
    return DSERR_INVALIDPARAM;

  struct buffer *b = calloc(1, sizeof *b);
  if (!b) return DSERR_OUTOFMEMORY;
  b->vtable = vtable_buffer;
  b->notify = (struct notify_face){vtable_notify, b};
  b->refs = 1;
  b->ds = ds;
  b->primary = primary;
  b->flags = desc->dwFlags;
  if (primary) {
    b->format = ds->primary_set ? ds->primary_format
                                : (WAVEFORMATEX){1, 2, 22050, 22050 * 4, 4, 16, 0};
    *out = b;
    return DS_OK;
  }
  b->format = *f;
  b->format.cbSize = 0;
  b->format.nBlockAlign = (WORD)(f->nChannels * f->wBitsPerSample / 8);
  b->format.nAvgBytesPerSec = b->format.nBlockAlign * f->nSamplesPerSec;
  b->size = desc->dwBufferBytes - desc->dwBufferBytes % b->format.nBlockAlign;
  b->data = calloc(1, b->size ? b->size : 1);
  if (!b->data || !b->size) {
    free(b->data);
    free(b);
    return DSERR_INVALIDPARAM;
  }
  if (f->wBitsPerSample == 8) memset(b->data, 128, b->size); /* 8-bit silence */
  b->frequency = f->nSamplesPerSec;
  pthread_mutex_lock(&mix_lock);
  int slot = 0;
  while (slot < MAX_BUFFERS && active[slot]) slot++;
  if (slot < MAX_BUFFERS) active[slot] = b;
  pthread_mutex_unlock(&mix_lock);
  if (slot == MAX_BUFFERS) {
    free(b->data);
    free(b);
    return DSERR_ALLOCATED;
  }
  trace("sound: secondary buffer: %u bytes, %u Hz, %u channels, %u bits, flags %#x", b->size,
        f->nSamplesPerSec, f->nChannels, f->wBitsPerSample, desc->dwFlags);
  *out = b;
  return DS_OK;
}

/* ---- Entry points ---- */


static void make_vtables(void) {
  if (vtable_ds[0]) return;
  static const char *const ds_methods[] = {
      "QueryInterface", "AddRef", "Release", "CreateSoundBuffer", "GetCaps", "DuplicateSoundBuffer",
      "SetCooperativeLevel", "Compact", "GetSpeakerConfig", "SetSpeakerConfig", "Initialize"};
  static const char *const buffer_methods[] = {
      "QueryInterface", "AddRef", "Release", "GetCaps", "GetCurrentPosition", "GetFormat",
      "GetVolume", "GetPan", "GetFrequency", "GetStatus", "Initialize", "Lock", "Play",
      "SetCurrentPosition", "SetFormat", "SetVolume", "SetPan", "SetFrequency", "Stop", "Unlock",
      "Restore"};
  static const char *const notify_methods[] = {"QueryInterface", "AddRef", "Release",
                                               "SetNotificationPositions"};
  void **n = vtable_notify;
  n[0] = notify_QueryInterface, n[1] = notify_AddRef, n[2] = notify_Release;
  n[3] = notify_SetNotificationPositions;
  fill_vtable(n, 4, "IDirectSoundNotify", notify_methods);

  void **v = vtable_buffer;
  v[0] = buffer_QueryInterface, v[1] = buffer_AddRef, v[2] = buffer_Release;
  v[3] = buffer_GetCaps, v[4] = buffer_GetCurrentPosition, v[5] = buffer_GetFormat;
  v[6] = buffer_GetVolume, v[7] = buffer_GetPan, v[8] = buffer_GetFrequency;
  v[9] = buffer_GetStatus, v[11] = buffer_Lock, v[12] = buffer_Play;
  v[13] = buffer_SetCurrentPosition, v[14] = buffer_SetFormat, v[15] = buffer_SetVolume;
  v[16] = buffer_SetPan, v[17] = buffer_SetFrequency, v[18] = buffer_Stop, v[19] = buffer_Unlock;
  fill_vtable(v, 21, "IDirectSoundBuffer", buffer_methods);

  void **d = vtable_ds;
  d[1] = ds_AddRef, d[2] = ds_Release, d[3] = ds_CreateSoundBuffer, d[6] = ds_SetCooperativeLevel;
  fill_vtable(d, 11, "IDirectSound", ds_methods);
  d[0] = ds_QueryInterface; /* set last: vtable_ds[0] says the tables are done */
}

static HRESULT WINAPI DirectSoundCreate(const GUID *guid, struct dsound **out, void *outer) {
  (void)guid; /* any device: SDL's default */
  if (outer || !out) return DSERR_INVALIDPARAM;
  load_volume(); /* here, on the game's thread, not in the mixer */
  update_gain();
  if (!dsound_audio_available()) {
    trace("DirectSoundCreate: no audio, DSERR_NODRIVER");
    *out = NULL;
    return DSERR_NODRIVER;
  }
  make_vtables();
  struct dsound *ds = calloc(1, sizeof *ds);
  if (!ds) return DSERR_OUTOFMEMORY;
  ds->vtable = vtable_ds;
  ds->refs = 1;
  device_users++;
  trace("DirectSoundCreate");
  *out = ds;
  return DS_OK;
}

typedef BOOL(WINAPI *dsenum_callback)(const GUID *guid, LPCSTR description, LPCSTR module,
                                      void *context);

/* The game takes the first device with a GUID and a module name. Without SDL audio none is
   listed: the game then stays silent, without a message box. */
static HRESULT WINAPI DirectSoundEnumerateA(dsenum_callback callback, void *context) {
  if (!callback) return DSERR_INVALIDPARAM;
  if (!dsound_audio_available()) return DS_OK;
  if (!callback(NULL, "Primary Sound Driver", "", context)) return DS_OK;
  const char *name = SDL_GetNumAudioDevices(0) > 0 ? SDL_GetAudioDeviceName(0, 0) : NULL;
  callback(&device_guid, name ? name : "SDL audio", "sdl.drv", context);
  return DS_OK;
}

const struct export misc_dsound_exports[] = {
    {"#1", DirectSoundCreate},
    {"#2", DirectSoundEnumerateA},
    {NULL, NULL},
};
