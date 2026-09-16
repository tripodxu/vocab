@echo off
echo ========================================
echo   词汇工具 本地开发服务器
echo   刷词器: http://localhost:8080/真经刷词神器.html
echo   讲  义: http://localhost:8080/课程讲义.html
echo   按 Ctrl+C 停止
echo ========================================
npx live-server --port=8080 --no-browser --wait=200
