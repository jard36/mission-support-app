@echo off
echo ========================================================
echo   PUSH MISSION SUPPORT APP TO GITHUB
echo ========================================================
echo.
set /p REPO_URL=I-paste dinhi ang imong GitHub Repository URL (pananglitan: https://github.com/username/repo.git): 
if " %REPO_URL%\==\\ (
 echo Walay URL nga gibutang. Pag-exit...
 pause
 exit /b
)
echo.
echo Nag-connect sa GitHub remote repository...
git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%
git branch -M main
echo Nag-push sa mga files ngadto sa GitHub...
git push -u origin main
echo.
if %ERRORLEVEL% EQU 0 (
 echo SUCCESS! Naka-upload na tanan sa imong GitHub repository!
) else (
 echo Naay error sa pag-push. Palihug susiha kung husto ang repository URL o permissions.
)
echo.
pause
