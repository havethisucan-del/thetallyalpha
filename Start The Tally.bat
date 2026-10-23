@echo off
rem Double-click to play The Tally on this PC (README.md). Needs only Node.js.
title The Tally
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed ^(or this window cannot find it^).
  echo Install the "LTS" version from https://nodejs.org with the default options,
  echo then double-click "Start The Tally.bat" again.
  echo.
  pause
  exit /b 1
)
node scripts\launch.js
if errorlevel 1 (
  echo.
  echo The Tally could not start or stopped with an error ^(see above^).
  pause
  exit /b 1
)
