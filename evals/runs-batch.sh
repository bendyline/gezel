#!/bin/bash
# Run 3 trials each of tictactoe, tankcombat, petshop sequentially.
# Each trial is logged to its own evals/runs/<id>/ dir.
set -u
cd "$(dirname "$0")"
PASSES=0
FAILS=0
SUMMARY=""

for SCENARIO in tictactoe tankcombat petshop; do
  for TRIAL in 1 2 3; do
    echo "=== ${SCENARIO} trial ${TRIAL} starting at $(date -u +%H:%M:%S) ==="
    if pnpm exec tsx src/bin/run-ollama.ts ${SCENARIO} --model gemma4:26b --timeout 25m; then
      echo "=== ${SCENARIO} trial ${TRIAL} PASS ==="
      PASSES=$((PASSES+1))
      SUMMARY="${SUMMARY}${SCENARIO}/${TRIAL}: PASS\n"
    else
      echo "=== ${SCENARIO} trial ${TRIAL} FAIL ==="
      FAILS=$((FAILS+1))
      SUMMARY="${SUMMARY}${SCENARIO}/${TRIAL}: FAIL\n"
    fi
    echo
  done
done

echo
echo "=== BATCH COMPLETE: passes=${PASSES} fails=${FAILS} ==="
echo -e "${SUMMARY}"
