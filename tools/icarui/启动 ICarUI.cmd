@echo off
rem ===========================================================================
rem  启动 ICarUI.cmd -- Chinese-named alias for start-icarui.cmd
rem
rem  This file exists only so the launcher is easy to spot in Explorer on a
rem  Chinese Windows. It contains NO logic: it just hands over to the ASCII
rem  name, which is the one to use from scripts, shortcuts and CI.
rem
rem  Why an ASCII alias is the "real" one: a CJK filename survives git and
rem  Explorer fine on this machine, but breaks on machines whose code page or
rem  archive tooling mangles the bytes. Keeping the logic in start-icarui.cmd
rem  means there is exactly one implementation to maintain.
rem
rem  Pure ASCII on purpose -- see the note in start-icarui.cmd.
rem ===========================================================================

call "%~dp0start-icarui.cmd" %*
