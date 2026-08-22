#!/usr/bin/env bash
# Refresh the opencode upstream source snapshot at <project-root>/opencode/opencode-dev/.
#
# Steps:
#   1. git clone --depth 1 https://github.com/anomalyco/opencode into a temp dir.
#   2. If the default-branch HEAD is not the latest release tag, fetch tags and
#      check out the latest release tag (semver >= MIN_VERSION).
#   3. rsync -a --delete --exclude '.git' the checkout over opencode/opencode-dev/.
#   4. Print the refreshed version from packages/opencode/package.json.
set -euo pipefail

REPO_URL="https://github.com/anomalyco/opencode"
MIN_VERSION="1.18.10"
MIN_TAG="v${MIN_VERSION}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLUECODE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$BLUECODE_DIR")"
TARGET="$PROJECT_ROOT/opencode/opencode-dev"

if [ -n "${CLAUDE_JOB_DIR:-}" ]; then
  TMP_DIR="$CLAUDE_JOB_DIR/tmp/refresh-upstream.$$"
  mkdir -p "$TMP_DIR"
else
  TMP_DIR="$(mktemp -d)"
fi
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> shallow-cloning $REPO_URL"
CLONE="$TMP_DIR/opencode"
git clone --depth 1 "$REPO_URL" "$CLONE"

# Latest release tag (vMAJOR.MINOR.PATCH), highest semver wins.
LATEST_TAG="$(git ls-remote --tags "$REPO_URL" \
  | awk '{print $2}' \
  | sed 's|^refs/tags/||' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -n 1)"
if [ -z "$LATEST_TAG" ]; then
  echo "ERROR: no vX.Y.Z release tags found on $REPO_URL" >&2
  exit 1
fi

if [ "$(printf '%s\n%s\n' "$MIN_TAG" "$LATEST_TAG" | sort -V | head -n 1)" != "$MIN_TAG" ]; then
  echo "ERROR: latest release tag $LATEST_TAG is older than required minimum $MIN_TAG" >&2
  exit 1
fi
echo "==> latest release tag: $LATEST_TAG (minimum required: $MIN_TAG)"

# Commit the tag points to (tail -1 handles annotated tags, whose ^{} line is the commit).
TAG_COMMIT="$(git ls-remote "$REPO_URL" "refs/tags/$LATEST_TAG" "refs/tags/$LATEST_TAG^{}" \
  | tail -n 1 | awk '{print $1}')"
HEAD_SHA="$(git -C "$CLONE" rev-parse HEAD)"

if [ "$HEAD_SHA" = "$TAG_COMMIT" ]; then
  echo "==> default-branch HEAD is already at release tag $LATEST_TAG"
else
  echo "==> HEAD ($HEAD_SHA) is not release tag $LATEST_TAG ($TAG_COMMIT); checking out tag"
  git -C "$CLONE" fetch --depth 1 origin "refs/tags/$LATEST_TAG:refs/tags/$LATEST_TAG"
  git -C "$CLONE" checkout --quiet "$LATEST_TAG"
fi

echo "==> syncing into $TARGET"
mkdir -p "$TARGET"
rsync -a --delete --exclude '.git' "$CLONE/" "$TARGET/"

VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$TARGET/packages/opencode/package.json" | head -n 1)"
echo "==> refreshed opencode-dev to version: $VERSION (tag $LATEST_TAG)"
