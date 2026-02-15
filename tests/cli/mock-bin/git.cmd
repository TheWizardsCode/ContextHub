@echo off
:: Windows cmd wrapper for the bash mock git script.
:: Node's child_process.exec on Windows uses cmd.exe which only finds
:: files with PATHEXT extensions (.cmd, .exe, etc). This wrapper delegates
:: to the bash git mock so tests work on Windows.
bash "%~dp0git" %*
