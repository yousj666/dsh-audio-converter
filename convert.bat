@echo off
chcp 65001 >nul
title 音频转换器

cd /d "%~dp0"

echo.
echo ====================================================
echo   音频转换器
echo ====================================================
echo.

REM ── 有参数（拖文件/文件夹上来的情况）就直接转 ──
if not "%~1"=="" (
    echo   处理拖进来的 %*  ...
    echo.
    node "convert.mjs" %* --format mp3
    echo.
    echo   输出目录：%USERPROFILE%\Desktop\音频转换输出
    echo.
    pause
    exit /b 0
)

REM ── 没参数：交互模式 ──
echo   支持解密的格式：网易云 .ncm / 酷我 .kwm / 酷狗 .kgm / QQ音乐 .qmc .mflac .mgg
echo   常规格式互转：mp3 / flac / m4a / aac / wav / ogg / opus
echo.
echo   [提示] 也可以把文件或文件夹**直接拖到本文件上**，会自动转成 mp3
echo.
echo ----------------------------------------------------
echo.

:ask
set "SRC="
set /p "SRC=  输入要转换的文件或文件夹路径（直接回车 = 退出）: "
if "%SRC%"=="" goto :end

REM 去掉用户可能带的引号
set "SRC=%SRC:"=%"

if not exist "%SRC%" (
    echo.
    echo   [错误] 找不到：%SRC%
    echo.
    goto :ask
)

echo.
echo   目标格式：
echo     1. mp3（默认）
echo     2. flac（无损）
echo     3. m4a
echo     4. 沿用源格式（只解密，不转码）
echo.
set "FMTCH=1"
set /p "FMTCH=  选一个 [1-4]，直接回车=1: "

set "FMTARG=--format mp3"
if "%FMTCH%"=="2" set "FMTARG=--format flac"
if "%FMTCH%"=="3" set "FMTARG=--format m4a"
if "%FMTCH%"=="4" set "FMTARG="

echo.
echo   音质增强：
echo     0. 不处理（默认）
echo     1. 响度归一化   2. 夜间降动态   3. 暖声 EQ
echo     4. 明亮 EQ      5. 人声突出     6. 低频增强   7. 全套
echo.
set "ENHCH=0"
set /p "ENHCH=  选一个 [0-7]，直接回车=0: "

set "ENHARG="
if "%ENHCH%"=="1" set "ENHARG=--enhance loudness"
if "%ENHCH%"=="2" set "ENHARG=--enhance night"
if "%ENHCH%"=="3" set "ENHARG=--enhance warm"
if "%ENHCH%"=="4" set "ENHARG=--enhance bright"
if "%ENHCH%"=="5" set "ENHARG=--enhance vocal"
if "%ENHCH%"=="6" set "ENHARG=--enhance bass"
if "%ENHCH%"=="7" set "ENHARG=--enhance full"

echo.
echo ----------------------------------------------------
node "convert.mjs" "%SRC%" %FMTARG% %ENHARG%
echo ----------------------------------------------------
echo.
goto :ask

:end
echo.
echo   已退出。
timeout /t 3 >nul
