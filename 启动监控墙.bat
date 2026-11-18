@echo off
rem ===========================================================
rem  Ezviz Wall launcher
rem  IMPORTANT: this file is ASCII-only on purpose.
rem  cmd.exe parses .bat in the local ANSI code page (GBK on
rem  Chinese Windows), so UTF-8 Chinese text inside a .bat is
rem  shredded into bogus commands and the server never starts.
rem  All messages here are English; the app prints Chinese.
rem ===========================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title Ezviz Wall

if not exist "server.py" (
  echo [ERROR] server.py not found in this folder.
  echo         Current dir: %CD%
  echo.
  pause
  exit /b 1
)

set "PYCMD="

where py.exe >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys" >nul 2>&1
  if not errorlevel 1 set "PYCMD=py -3"
)

if not defined PYCMD (
  where python.exe >nul 2>&1
  if not errorlevel 1 (
    python -c "import sys" >nul 2>&1
    if not errorlevel 1 set "PYCMD=python"
  )
)

if not defined PYCMD (
  where python3.exe >nul 2>&1
  if not errorlevel 1 (
    python3 -c "import sys" >nul 2>&1
    if not errorlevel 1 set "PYCMD=python3"
  )
)

if not defined PYCMD goto :nopython

echo.
echo  Starting Ezviz Wall with: %PYCMD%
echo.

%PYCMD% server.py %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [ERROR] Server exited with code %RC%.
  echo         Check the messages above.
)
echo  ---------------------------------------------
echo  Server stopped. Press any key to close.
echo  ---------------------------------------------
pause >nul
exit /b %RC%

:nopython
echo.
echo  [ERROR] Python 3 not found on this machine.
echo.
echo  1. Install Python 3.8+ : https://www.python.org/downloads/
echo  2. During setup, tick "Add python.exe to PATH".
echo  3. Re-run this file.
echo.
pause
exit /b 1
