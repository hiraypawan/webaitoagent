@echo off
title Web Agents To
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example - set a unique API_KEY before exposing the server.
)

echo Starting Web Agents To server...
start "Web Agents To Server" cmd /k "node --import tsx src/server/main.ts"

timeout /t 6 >nul
echo.
echo API:     http://127.0.0.1:8787/v1
echo Health:  http://127.0.0.1:8787/health
echo.
echo First run? Sign in once:  WEB login
echo Chat:                     WEB repl
echo Agent:                    WEB agent "summarise this repo"
echo.
pause
