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

echo.
echo ====================================
echo  Installation complete!
echo  Run start.bat to launch Mapwright.
echo ====================================
echo.
pause
endlocal
