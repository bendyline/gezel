@echo off
title Gezel overnight evals - showcase set
cd /d D:\gh\gezel
set SCEN=craftbook-fact-check craftbook-topic-explainer craftbook-spa-dashboard craftbook-nightly-fix-sweep
set LOGS=D:\gh\gezel\evals\runs\overnight-2026-11-01
echo [%date% %time%] Qwen 3.8 27B: 4 scenarios x 3 trials. Log: %LOGS%\qwen.log
call pnpm --filter @bendyline/gezel-evals run batch %SCEN% --count 3 --model qwen3.8-27b-q4 > "%LOGS%\qwen.log" 2>&1
echo [%date% %time%] Qwen finished, exit %errorlevel%
echo [%date% %time%] Gemma 4 12B: 4 scenarios x 3 trials. Log: %LOGS%\gemma.log
call pnpm --filter @bendyline/gezel-evals run batch %SCEN% --count 3 --model gemma4-12b-q4 > "%LOGS%\gemma.log" 2>&1
echo [%date% %time%] Gemma finished, exit %errorlevel%
echo All done. Results are in evals\runs\matrix-* folders.
pause
