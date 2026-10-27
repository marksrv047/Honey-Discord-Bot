@echo off
title Honey Bot Server
cd /d "%~dp0"
echo ====================================================
echo Honey Bot - Autonomous 24/7 Server Runner
echo Running independently of AntiGravity / IDE
echo ====================================================
:loop
node --dns-result-order=ipv4first bot.js
echo.
echo [HONEY BOT] Process exited with code %ERRORLEVEL%.
echo [HONEY BOT] Restarting in 5 seconds (Press Ctrl+C to stop)...
timeout /t 5 /nobreak >nul
goto loop

