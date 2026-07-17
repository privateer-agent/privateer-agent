@echo off
REM Windows entry point for a Privateer bundle. Mirrors the unix bin/privateer-tui
REM shim: run the bundled Node against the shared cross-platform launcher. %~dp0 is
REM this file's dir (<app>\bin\), so ..\node.exe is the bundled runtime.
"%~dp0..\node.exe" "%~dp0privateer-launch.mjs" %*
exit /b %errorlevel%
