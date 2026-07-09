#!/usr/bin/env bash
# Public-release gate: everything tracked in this repo must be sanitized.
#   1. English only          (no Dutch prose in docs)
#   2. No tooling references (internal assistants, skills, knowledge bases)
#   3. No private identifiers
# Runs from the pre-push hook; run manually with: bash scripts/check-sanitized.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# 1. Dutch prose in markdown (distinctly Dutch stopwords, threshold filters
#    out incidental hits in code identifiers or URLs)
dutch='\b(het|een|niet|wordt|worden|geen|deze|ook|naar|dus|omdat|zodat|tijdens|wijzig|gebruiker|bestand|programmeren)\b'
while IFS= read -r f; do
  hits=$(grep -oiE "$dutch" "$f" 2>/dev/null | wc -l | tr -d ' ' || true)
  if [ "$hits" -ge 5 ]; then
    echo "FAIL [dutch]      $f ($hits stopword hits)"
    fail=1
  fi
done < <(git ls-files '*.md')

# 2 + 3. Forbidden terms in all tracked text files
forbidden='mistermeneer|mister meneer|m\.mijnals|mm3204ha|claude|anthropic|copilot|openai|gpt-oss|superpowers|agentbrain|snapcoder|sitescope|peer-review|cartmedia'
while IFS= read -r f; do
  case "$f" in *.png|*.jpg|*.vsix|package-lock.json|scripts/check-sanitized.sh) continue ;; esac
  out=$(grep -inE "$forbidden" "$f" 2>/dev/null | head -3 || true)
  if [ -n "$out" ]; then
    echo "FAIL [forbidden]  $f"
    echo "$out" | sed 's/^/    /'
    fail=1
  fi
done < <(git ls-files)

if [ "$fail" -ne 0 ]; then
  echo
  echo "Sanitization gate failed — fix the findings above before pushing."
  exit 1
fi
echo "Sanitization gate passed."
