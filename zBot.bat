@echo off
setlocal
title zBot

rem ===========================================================================
rem  zBot launcher - double-click this file to open the app.
rem
rem  This machine has ELECTRON_RUN_AS_NODE=1 set, which makes Electron boot as
rem  plain Node and crash before a window appears. Clearing it in this process
rem  is the main reason this launcher exists at all.
rem ===========================================================================

set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

if not exist "package.json" (
  echo.
  echo   ERROR: package.json not found next to this file.
  echo   Keep this launcher inside the zBot project folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found on PATH.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   First run - installing dependencies. This takes several minutes.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   ERROR: npm install failed. Scroll up for the reason.
    echo.
    pause
    exit /b 1
  )
)

rem Always rebuild. It costs a few seconds and it means a stale build can never
rem be mistaken for a broken feature.
echo.
echo   Building zBot...
echo.
call npm run build
if errorlevel 1 (
  echo.
  echo   ERROR: the build failed, so zBot was NOT started.
  echo   The previous build is left untouched. Scroll up for the reason.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting zBot. Close this window to quit the app.
echo.

call "node_modules\.bin\electron.cmd" .
if errorlevel 1 (
  echo.
  echo   zBot exited with an error. Scroll up for the reason.
  echo.
  pause
)

endlocal
