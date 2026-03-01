@echo off
setlocal

echo ========================================
echo   Mapwright - Build Portable App
echo ========================================
echo.

:: Navigate to script directory
cd /d "%~dp0"

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Please run install.bat first, or download Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Install/update dependencies
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

:: Build the portable executable
echo.
echo Building portable Windows executable...
echo (This may take a few minutes on first run)
echo.
call npm run electron:build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed. See output above for details.
    pause
    exit /b 1
)

echo.
echo ========================================
echo  Build complete!
echo  Output: dist\Mapwright.exe
echo.
echo  This portable .exe can be copied to any
echo  Windows machine and run without Node.js.
echo ========================================
echo.
pause
endlocal
