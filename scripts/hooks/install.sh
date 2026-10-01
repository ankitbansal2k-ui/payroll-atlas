#!/bin/sh
# Copies the pre-commit hook into this clone's .git/hooks. Run once per clone.
set -e
cd "$(git rev-parse --show-toplevel)"
cp scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "Installed .git/hooks/pre-commit"
