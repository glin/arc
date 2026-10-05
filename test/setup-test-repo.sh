#!/usr/bin/env bash
set -euo pipefail
# Scaffold a throwaway git repo for exercising Arc in a fresh Claude Code
# session. Generic: not tied to any real project.
#
# Usage: ./test/setup-test-repo.sh [dir]      (default: /tmp/arc-test)
# Then: open <dir> in VS Code and start a NEW Claude Code session there. Any permission
# mode works; acceptEdits keeps the walkthrough free of approval prompts.

DIR="${1:-/tmp/arc-test}"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

git init -q
git config user.email you@example.com
git config user.name "Test User"

cat > alpha.txt <<'EOF'
one
two
three
four
five
six
seven
eight
EOF

cat > beta.txt <<'EOF'
alpha
beta
gamma
EOF

git add -A
git commit -q -m "initial"

echo "Test repo ready at: $DIR"
echo
echo "Next:"
echo "  1. Open this folder in VS Code:   code \"$DIR\""
echo "  2. Start a NEW Claude Code session in it (acceptEdits avoids approval prompts)."
echo "  3. Follow test/CHECKLIST.md."
