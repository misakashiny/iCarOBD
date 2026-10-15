@echo off
setlocal
node "%~dp0build.js"
if errorlevel 1 (
  echo Snapshot generation failed. Read the message above.
  pause
  exit /b 1
)
start "" "%~dp0index.html"
exit /b 0
