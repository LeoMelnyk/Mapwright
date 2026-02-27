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
echo                Mapwright
echo ========================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Please run install.bat first.
    echo.
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "%~dp0node_modules" (
    echo [ERROR] Dependencies are not installed.
    echo Please run install.bat first.
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"

:: Check if port 3000 is already in use
netstat -an | find "LISTENING" | find ":3000 " >nul 2>&1
if %errorlevel% equ 0 (
    echo Mapwright is already running.
    echo.
    echo Opening browser to existing instance...
    start http://localhost:3000/editor/
    echo.
    pause
    exit /b 0
)

echo Starting Mapwright...
echo.
echo The editor will open in your browser at:
echo   http://localhost:3000/editor/
echo.
echo Press Ctrl+C to stop the server when you are done.
echo.

:: Open browser after a short delay (runs in background)
start "" /B cmd /c "timeout /t 2 >nul && start http://localhost:3000/editor/"

:: Start the server (blocking — keeps window open)
call npm start

echo.
echo Server stopped.
pause
endlocal
