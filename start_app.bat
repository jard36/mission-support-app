@echo off
echo Starting Mission Support Management System...
cd /d "%~dp0"
start http://localhost:3000
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  call "%ProgramFiles%\nodejs\npm.cmd" run dev
) else (
  call npm run dev
)
pause
