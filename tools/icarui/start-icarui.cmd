@echo off
rem ===========================================================================
rem  start-icarui.cmd -- open ICarUI directly from disk (the normal way)
rem
rem  Double-click this file. It opens index.html in the DEFAULT browser.
rem
rem  Why this is the normal way and not a local server:
rem    ICarUI is a zero-install web tool. It uses only classic <script src>
rem    tags (no ES modules, no fetch, no XHR), so file:// works completely.
rem    See tests/probe-file-url.js for the measurements that back this up.
rem
rem  If you also want a local server (rarely needed), use serve.cmd instead.
rem
rem  NOTE: this file is deliberately pure ASCII. A .cmd is read by cmd.exe in
rem  the OEM code page (936/GBK on a Chinese Windows), so non-ASCII bytes here
rem  would show up as mojibake in the console. Chinese docs live in README.md.
rem
rem  NOTE: the path is built from %~dp0, never hard-coded -- the repo can live
rem  anywhere (it is D:\AI Dsh\<CJK>\iCarOBD2 on this machine, which is why
rem  every path below is quoted).
rem ===========================================================================

setlocal
set "HERE=%~dp0"
set "PAGE=%HERE%index.html"

if not exist "%PAGE%" (
  echo.
  echo   [ERROR] index.html not found next to this script.
  echo   Expected: "%PAGE%"
  echo.
  echo   This .cmd must stay in the same folder as index.html.
  echo.
  pause
  exit /b 1
)

rem The empty "" is the window title -- without it, `start` would treat the
rem quoted path as the title and open nothing.
start "" "%PAGE%"

rem No `exit /b 0` banner: the window closes at once, which is what a launcher
rem should do. If nothing appears, run serve.cmd and read the console output.
exit /b 0
