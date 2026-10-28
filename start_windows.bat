@echo off
title Vatio Local Demo
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js 18 o superior y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
node server.js
pause
