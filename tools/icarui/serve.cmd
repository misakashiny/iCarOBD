@echo off
rem ===========================================================================
rem  serve.cmd -- start a tiny local static server for ICarUI and open it
rem
rem  FALLBACK ONLY. Normally you double-click start-icarui.cmd, which opens
rem  index.html straight from disk. Measured with tests/probe-file-url.js:
rem  file:// runs the whole tool (assets, export JSON/PNG/.icarzip, import via
rem  file dialog and drag-and-drop, localStorage) with zero console errors.
rem  So no feature *requires* this server.
rem
rem  Use it when file:// misbehaves on some machine/browser/policy, or when you
rem  want to compare the two -- over http://127.0.0.1 fetch/XHR work and images
rem  loaded by path no longer taint the canvas.
rem
rem  No Node, no Python: the server is serve.ps1 (PowerShell + HttpListener),
rem  so the zero-install promise of the tool is not broken.
rem
rem  Port: defaults to 8765 and auto-increments when busy. Override with
rem    serve.cmd 9000
rem
rem  Stop: Ctrl+C in this window, or just close the window.
rem
rem  Pure ASCII on purpose -- see the note in start-icarui.cmd.
rem ===========================================================================

setlocal
set "HERE=%~dp0"
set "PS1=%HERE%serve.ps1"

if not exist "%PS1%" (
  echo.
  echo   [ERROR] serve.ps1 not found next to this script.
  echo   Expected: "%PS1%"
  echo.
  pause
  exit /b 1
)

rem %1 (if given) is the port. Passing it through unconditionally keeps this
rem file free of branching -- serve.ps1 already defaults when it is empty.
rem The empty "" after -File is not needed; -Port is always supplied so the
rem parameter binding is unambiguous even with an empty value... except an
rem empty value would bind as 0, so only pass it when actually provided.
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Port %~1
)

rem Keep the window open when the server exits with an error, so the message
rem is readable instead of flashing away.
if errorlevel 1 (
  echo.
  echo   [serve.ps1 exited with code %errorlevel%]
  pause
)
exit /b %errorlevel%
