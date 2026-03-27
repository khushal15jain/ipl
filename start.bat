@echo off
echo 🏏 IPL Auction - Starting...
echo.
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
echo Starting server at http://localhost:3000
echo Database: auction.db (auto-created)
echo.
node server.js
pause
