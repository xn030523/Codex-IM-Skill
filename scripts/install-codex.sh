#!/usr/bin/env bash
set -euo pipefail

# 安装 codex-skill 到 Codex skills 目录。
# Usage: bash scripts/install-codex.sh [--link]
#   --link  Create a symlink instead of copying (for development)

SKILL_NAME="codex-skill"
CODEX_SKILLS_DIR="$HOME/.codex/skills"
TARGET_DIR="$CODEX_SKILLS_DIR/$SKILL_NAME"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Installing $SKILL_NAME skill for Codex..."

# Check source
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

# Create skills directory
mkdir -p "$CODEX_SKILLS_DIR"

copy_clean_tree() {
  mkdir -p "$TARGET_DIR"
  if command -v tar >/dev/null 2>&1; then
    (
      cd "$SOURCE_DIR"
      tar \
        --exclude='.git' \
        --exclude='node_modules' \
        --exclude='dist' \
        --exclude='.codex-skill' \
        --exclude='*.tgz' \
        -cf - .
    ) | (
      cd "$TARGET_DIR"
      tar -xf -
    )
  else
    cp -R "$SOURCE_DIR"/. "$TARGET_DIR"
    rm -rf "$TARGET_DIR/.git" "$TARGET_DIR/node_modules" "$TARGET_DIR/dist"
  fi
}

# Check if already installed
if [ -e "$TARGET_DIR" ]; then
  if [ -L "$TARGET_DIR" ]; then
    EXISTING=$(readlink "$TARGET_DIR")
    echo "Already installed as symlink → $EXISTING"
    echo "To reinstall, remove it first: rm $TARGET_DIR"
    exit 0
  else
    echo "Already installed at $TARGET_DIR"
    echo "To reinstall, remove it first: rm -rf $TARGET_DIR"
    exit 0
  fi
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
  echo "Symlinked: $TARGET_DIR → $SOURCE_DIR"
else
  copy_clean_tree
  echo "Copied to: $TARGET_DIR"
fi

# Ensure dependencies (need devDependencies for build step)
if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@openai/codex-sdk" ]; then
  echo "Installing dependencies..."
  if [ -f "$TARGET_DIR/package-lock.json" ]; then
    (cd "$TARGET_DIR" && npm ci)
  else
    (cd "$TARGET_DIR" && npm install)
  fi
fi

# Ensure build
if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

# Prune devDependencies after build
echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done! Start a new Codex session and use:"
echo "  codex-skill setup    — configure IM platform credentials"
echo "  codex-skill start    — start the bridge daemon"
echo "  codex-skill doctor   — diagnose issues"
