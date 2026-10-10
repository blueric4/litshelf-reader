@echo off
rem ---------------------------------------------------------------
rem  LitShelf launcher.
rem  IMPORTANT: keep this file ASCII-only. cmd.exe parses batch files
rem  byte-by-byte with the active code page, and non-ASCII text (esp.
rem  inside parenthesised blocks) corrupts parsing. All logic and all
rem  Chinese messages live in scripts/launch.mjs instead.
rem ---------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title LitShelf

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found. Please install Node.js 20 or newer:
  echo           https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem Some Electron-based tools export this; it turns electron.exe into plain Node.
set "ELECTRON_RUN_AS_NODE="

node "scripts\launch.mjs"
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  pause
)
exit /b %EXITCODE%
