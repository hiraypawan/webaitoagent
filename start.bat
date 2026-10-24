@echo off
title Web Agents To
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example. Edit it if needed.
)

echo Starting Web Agents To server...
start "Web Agents To Server" cmd /k "node --import tsx src/server/main.ts"

timeout /t 6 >nul
echo.
echo Server:  http://127.0.0.1:8787
echo Health:  http://127.0.0.1:8787/health
echo.
echo To chat:  npm run cli -- "your prompt" --model=mimo/mimo-v2.6-pro
echo To login: npm run login -- --provider=mimo
echo.
pause