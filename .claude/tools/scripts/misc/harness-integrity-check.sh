#!/usr/bin/env bash
# harness-integrity-check.sh — framework integrity check via git-diff HEAD
#
# Checks that all k-class files in .framework-manifest are unmodified from
# their committed state. Uses git (not sha256) so line-ending normalization
# is handled natively — no CRLF false positives.
#
# Usage:
#   bash harness-integrity-check.sh [project_dir] [state_file]

set -euo pipefail

PROJECT_DIR="${1:-.}"
STATE_FILE="${2:-}"
_TS=$(date +%s)

# ── Prerequisites ──

MANIFEST="$PROJECT_DIR/.framework-manifest"
if [ ! -f "$MANIFEST" ]; then
    echo "WARNING: .framework-manifest missing, skip integrity check"
    [ -n "$STATE_FILE" ] && echo "SKIP $_TS" > "$STATE_FILE"
    exit 0
fi

if ! command -v git >/dev/null 2>&1; then
    echo "WARNING: git not available, skip integrity check"
    [ -n "$STATE_FILE" ] && echo "SKIP $_TS" > "$STATE_FILE"
    exit 0
fi

# ── Collect k-class files ──

FILES=$(grep '^k ' "$MANIFEST" | sed 's/^k //' | tr '\n' ' ')
TOTAL=$(echo "$FILES" | wc -w)

if [ "$TOTAL" -eq 0 ]; then
    echo "WARNING: no k-class files in manifest, skip integrity check"
    [ -n "$STATE_FILE" ] && echo "SKIP $_TS" > "$STATE_FILE"
    exit 0
fi

# ── Check for modifications vs HEAD ──

cd "$PROJECT_DIR"

MODIFIED=$(git diff --name-only HEAD -- $FILES 2>/dev/null || true)

# Also check for untracked k-class files (missing from git index)
UNTRACKED=""
for f in $FILES; do
    if [ ! -f "$f" ]; then
        UNTRACKED="$UNTRACKED   - $f (missing)"$'\n'
    fi
done

if [ -z "$MODIFIED" ] && [ -z "$UNTRACKED" ]; then
    echo "OK: framework integrity verified ($TOTAL files)"
    [ -n "$STATE_FILE" ] && echo "OK $_TS $TOTAL" > "$STATE_FILE"
else
    FAIL_COUNT=0
    DETAIL=""
    if [ -n "$MODIFIED" ]; then
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            FAIL_COUNT=$((FAIL_COUNT + 1))
            DETAIL="$DETAIL   - $f"$'\n'
        done <<< "$MODIFIED"
    fi
    if [ -n "$UNTRACKED" ]; then
        FAIL_COUNT=$((FAIL_COUNT + $(echo "$UNTRACKED" | grep -c 'missing' || true)))
        DETAIL="$DETAIL$UNTRACKED"
    fi

    echo "TAMPERED: $FAIL_COUNT/$TOTAL files modified"
    echo -n "$DETAIL"
    echo "   Run /upgrade-harness to restore."
    if [ -n "$STATE_FILE" ]; then
        echo "TAMPERED $_TS $FAIL_COUNT/$TOTAL" > "$STATE_FILE"
        echo -n "$DETAIL" >> "$STATE_FILE"
    fi
fi

exit 0
