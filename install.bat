@echo off
setlocal

echo ========================================
echo                                  +*++*
echo   ++++++++++++++++++++++++++   +===+==
echo ++=-::::::::::::::::::::::-++ =-=+*+--+
echo ++.........................=+=--++*=--+
echo ++........::.....::........=+===+*+-==+
echo ++........::.....::........=+-:+* =:-+
echo ++..========:::::--::::::..==-=*  =--
echo ++..=-----=-.....::........=+**     +
echo ++..=-----=-.....::........+**
echo ++..=-----=-.....::.......:**
echo ++..=-----==::::::-:::::::*++
echo ++..:--=--==-----==:::::-*-=+
echo ++.....---==------=....:*-.=+
echo ++........-=------=...-*-..=+
echo ++........-=------=..-*%%=..=+
echo ++...:::::=========::*#=:..=+
echo ++...:::::::::::::-::--:...=+
echo ++........::.....::........=+
echo ++........::......:........=+
echo ++-:......................:++
echo  +++++++++++++++++++++++++++
echo         Mapwright - Installation
echo ========================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo.
    echo Please download and install Node.js from:
    echo   https://nodejs.org/
    echo.
    echo Choose the "LTS" version, install it, then run this script again.
    echo.
    pause
    exit /b 1
)

:: Check Node.js version (need 18+)
for /f "tokens=1 delims=v." %%i in ('node --version') do set NODE_MAJOR=%%i
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
if %NODE_MAJOR% LSS 18 (
    echo [ERROR] Node.js %NODE_VER% is too old. Version 18 or newer is required.
    echo.
    echo Please download the latest LTS version from:
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js %NODE_VER% found.

:: Navigate to script directory
cd /d "%~dp0"

:: Run npm install
echo.
echo Installing dependencies (this may take a minute)...
echo.
call npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Installation failed. See the output above for details.
    echo.
    pause
    exit /b 1
)

:: ── Texture Library ─────────────────────────────────────────────────────────
echo.
echo ========================================
echo  Textures (Optional)
echo ========================================
echo  Mapwright supports high-quality PBR textures from Polyhaven
echo  (free, CC0 licensed). The editor works without them.
echo  You can re-run install.bat at any time to download textures.
echo.
echo  [R] Required only  - ~25 textures used by built-in props
echo  [A] All textures   - full Polyhaven library (700+)
echo  [S] Skip for now
echo.
set /p "TC=Download textures? [R/A/S]: "
echo.
if /i "%TC%"=="R" (
    call node tools/download-textures.js --required
    if %errorlevel% neq 0 echo [WARNING] Some downloads failed. Re-run install.bat to retry.
) else if /i "%TC%"=="A" (
    call node tools/download-textures.js --all
    if %errorlevel% neq 0 echo [WARNING] Some downloads failed. Re-run install.bat to retry.
) else (
    echo  Skipped. Run install.bat again to download textures later.
)

echo.
echo ====================================
echo  Installation complete!
echo  Run start.bat to launch Mapwright.
echo ====================================
echo.
pause
endlocal
