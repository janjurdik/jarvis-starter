@echo off
rem Dvojklik na Windows: pripravi pocitac a polozi Jarvisa na plochu.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Jarvis potrebuje Node.js. Stiahni verziu LTS z https://nodejs.org, nainstaluj ju a spusti tento subor znova.
  start https://nodejs.org
  pause
  exit /b 1
)
node scripts\setup.mjs
echo.
echo Toto okno mozes zavriet.
pause
