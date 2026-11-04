@echo off
chcp 65001 >nul
title Vatio Local
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js no esta instalado o no esta en PATH.
  echo Instale Node.js 24 o superior y vuelva a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo.
  echo ERROR: Vatio requiere Node.js 24 o superior. Version detectada: %NODE_MAJOR%.
  echo Instale Node.js 24 y vuelva a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
if not exist ".env" (
  echo.
  echo AVISO: no existe el archivo .env. Copie .env.example como .env y complete
  echo VATIO_ADMIN_PASSWORD y VATIO_DEVICE_KEY; el servidor lo carga automaticamente.
  echo.
)
node server.js
pause
