#!/usr/bin/env bash
# Append collected rows to the data branch checked out at $2 and push.
#
# Usage: scripts/push-data.sh rows.json data-checkout-dir
#
# On a push race (another run pushed first) it resets to the remote branch and
# redoes the append instead of rebasing, so concurrent runs never conflict.
set -euo pipefail

ROWS=$(realpath "$1")
DIR=$2
BRANCH=${DATA_BRANCH:-data}
STORE="$(cd "$(dirname "$0")" && pwd)/store.py"

cd "$DIR"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  python3 "$STORE" append "$ROWS" --data .
  git add -A
  if git diff --cached --quiet; then
    echo "nothing new to store"
    exit 0
  fi
  git commit -q -m "Add results from run ${GITHUB_RUN_ID:-local} attempt ${GITHUB_RUN_ATTEMPT:-1}"
  if git push -q origin "HEAD:refs/heads/$BRANCH"; then
    git log -1 --stat --format='pushed %h %s'
    exit 0
  fi
  echo "push rejected (attempt $attempt); retrying on top of the latest $BRANCH"
  sleep $((attempt * 3))
  git fetch -q origin "$BRANCH"
  git reset -q --hard FETCH_HEAD
done
echo "::error::could not push to $BRANCH"
exit 1
