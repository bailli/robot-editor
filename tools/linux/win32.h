/* Windows types and constants the wrapper needs (32-bit, as the game sees them). */
#ifndef WIN32_H
#define WIN32_H

#include <stdint.h>

#define WINAPI __attribute__((stdcall))

typedef uint8_t BYTE;
typedef uint16_t WORD;
typedef uint32_t DWORD;
typedef int32_t LONG;
typedef uint32_t ULONG;
typedef int32_t BOOL;
typedef uint32_t UINT;
typedef int32_t INT;
typedef int16_t SHORT;
typedef uint16_t WCHAR;
typedef char CHAR;
typedef void *HANDLE;
typedef void *LPVOID;
typedef const void *LPCVOID;
typedef char *LPSTR;
typedef const char *LPCSTR;
typedef WCHAR *LPWSTR;
typedef const WCHAR *LPCWSTR;
typedef DWORD *LPDWORD;
typedef LONG *PLONG;
typedef uint32_t UINT_PTR;
typedef int32_t LONG_PTR;
typedef uint32_t ULONG_PTR;
typedef ULONG_PTR SIZE_T;
typedef UINT_PTR WPARAM;
typedef LONG_PTR LPARAM;
typedef LONG_PTR LRESULT;
typedef LONG HRESULT;
typedef int64_t LONGLONG;
typedef DWORD COLORREF;

typedef HANDLE HMODULE, HINSTANCE, HWND, HDC, HMENU, HICON, HCURSOR, HBRUSH, HFONT, HPALETTE,
    HGDIOBJ, HACCEL, HRSRC, HGLOBAL, HLOCAL, HKEY, HBITMAP;

#define TRUE 1
#define FALSE 0
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)

/* GetLastError codes */
#define ERROR_SUCCESS 0
#define ERROR_FILE_NOT_FOUND 2
#define ERROR_PATH_NOT_FOUND 3
#define ERROR_ACCESS_DENIED 5
#define ERROR_INVALID_HANDLE 6
#define ERROR_NOT_ENOUGH_MEMORY 8
#define ERROR_NO_MORE_FILES 18
#define ERROR_INVALID_PARAMETER 87
#define ERROR_CALL_NOT_IMPLEMENTED 120
#define ERROR_INSUFFICIENT_BUFFER 122
#define ERROR_ALREADY_EXISTS 183

typedef struct {
  LONG left, top, right, bottom;
} RECT;

typedef struct {
  LONG x, y;
} POINT;

typedef union {
  struct {
    DWORD LowPart;
    LONG HighPart;
  } u;
  LONGLONG QuadPart;
} LARGE_INTEGER;

typedef struct {
  WORD wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds;
} SYSTEMTIME;

typedef struct {
  DWORD dwLowDateTime, dwHighDateTime;
} FILETIME;

typedef struct {
  HWND hwnd;
  UINT message;
  WPARAM wParam;
  LPARAM lParam;
  DWORD time;
  POINT pt;
} MSG;

typedef LRESULT(WINAPI *WNDPROC)(HWND, UINT, WPARAM, LPARAM);

#endif
