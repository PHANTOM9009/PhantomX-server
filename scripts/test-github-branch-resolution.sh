#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-client}"
BRANCH_INPUT="${2:-child/markdown-parser-unification-client}"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: '$REPO_DIR' is not a git repository"
  exit 1
fi

cd "$REPO_DIR"

echo "[INFO] Repository: $(pwd)"
echo "[INFO] Branch input: $BRANCH_INPUT"

echo "[STEP] Simulate old behavior (local-only rev-parse)..."
if git rev-parse --verify "${BRANCH_INPUT}^{commit}" >/dev/null 2>&1; then
  echo "[OLD] Found local branch ref: $BRANCH_INPUT"
else
  echo "[OLD] Not found as local branch ref: $BRANCH_INPUT"
fi

resolved_ref=""
for candidate in "$BRANCH_INPUT" "origin/$BRANCH_INPUT"; do
  if git rev-parse --verify "${candidate}^{commit}" >/dev/null 2>&1; then
    resolved_ref="$candidate"
    break
  fi
done

if [ -z "$resolved_ref" ] && [[ "$BRANCH_INPUT" == origin/* ]]; then
  stripped="${BRANCH_INPUT#origin/}"
  if git rev-parse --verify "${stripped}^{commit}" >/dev/null 2>&1; then
    resolved_ref="$stripped"
  fi
fi

if [ -z "$resolved_ref" ]; then
  echo "[FAIL] Could not resolve branch as local or origin/*: $BRANCH_INPUT"
  exit 2
fi

display_branch="${resolved_ref#origin/}"
echo "[NEW] Resolved ref: $resolved_ref"
echo "[NEW] Display branch: $display_branch"

echo "[STEP] Validate commit list command on resolved ref..."
commit_count=$(git log "$resolved_ref" -n 5 --pretty=format:"%H" | wc -l | tr -d ' ')
echo "[NEW] Commits fetched (up to 5): $commit_count"

echo "[STEP] Validate latest commit diff command on resolved ref..."
latest_hash=$(git show --no-patch --pretty=format:"%H" "$resolved_ref")
files_changed=$(git show --numstat --pretty="" "$latest_hash" | wc -l | tr -d ' ')
echo "[NEW] Latest hash: $latest_hash"
echo "[NEW] Files in latest commit: $files_changed"

echo "[PASS] Branch resolution fallback works for commit list and latest diff."
