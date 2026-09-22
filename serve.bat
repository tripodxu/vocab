@echo off
REM ---------------------------------------------------------------
REM Static preview only: no Worker / no API.
REM Login, cloud sync and auto-migration are unavailable in this mode.
REM For the full app use:  npm run dev
REM ---------------------------------------------------------------
echo ========================================
echo   Static preview server
echo   Practice : http://localhost:8080/
echo   Lecture  : open the link at the top-right of the practice page
echo   Press Ctrl+C to stop
echo ========================================
npx --yes live-server@1.2.2 --port=8080 --no-browser --wait=200
