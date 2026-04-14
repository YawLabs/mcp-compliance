#!/bin/bash
# =============================================================================
# Release Script — PR-based flow
# =============================================================================
# Usage:
#   ./release.sh <new-version>
#   ./release.sh 0.13.0
#
# If interrupted, re-run with the same version — each step is idempotent.
#
# Flow:
#   1. Run tests/lint/typecheck/build
#   2. Create release/v<X> branch with version bump
#   3. Open PR against master
#   4. Wait for CI to pass, then squash-merge (auto — no manual step)
#   5. npm publish --provenance from the updated master
#   6. Create v<X> tag via GitHub release (tag + release in one API call)
#   7. Verify npm + GitHub release
#
# Why PR-based: the repo's master ruleset blocks direct pushes by anyone
# other than an admin-bypass actor. A PR + squash-merge satisfies the "PR
# required" and "signed commits" rules automatically (GitHub signs squash
# merges with the `web-flow` key).
#
# Required repo ruleset bypass for github-actions[bot]:
#   - Tag creation on `v*`: add the bot to the bypass list, OR loosen the
#     tag-creation rule. Without this, step 6 fails and the release is
#     half-done (npm published, no GitHub release).
#
# Permissions needed on the workflow's GITHUB_TOKEN:
#   contents: write, pull-requests: write, id-token: write
#
# Prerequisites:
#   - gh CLI authenticated (or GITHUB_TOKEN set)
#   - npm authenticated (or NPM_TOKEN set)
#   - Node.js + npm installed
#
# Environment:
#   CI=true                   — skip the interactive confirmation prompt
#   RELEASE_CI_TIMEOUT=600    — seconds to wait for PR checks (default 600)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL_STEPS=7
step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# ---- Validate arguments ----
if [ $# -ne 1 ]; then
  echo "Usage: ./release.sh <version>"
  echo "  e.g. ./release.sh 0.13.0"
  exit 1
fi

VERSION="$1"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

BRANCH="release/v${VERSION}"
TAG="v${VERSION}"
RELEASE_CI_TIMEOUT="${RELEASE_CI_TIMEOUT:-600}"

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

command -v gh >/dev/null   || fail "gh CLI not installed"
command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
ON_MASTER=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Resuming release v${VERSION}"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current version: $CURRENT_VERSION → $VERSION"
fi

# ---- Confirmation (skip in CI) ----
if [ -z "${CI:-}" ] && [ "$CURRENT_VERSION" != "$VERSION" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run tests and lint"
  echo "  2. Push branch ${BRANCH} with version bump"
  echo "  3. Open PR against master"
  echo "  4. Wait for CI to pass, squash-merge (auto)"
  echo "  5. Publish to npm"
  echo "  6. Create tag + GitHub release"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# =============================================================================
# Step 1: Test and lint
# =============================================================================
step 1 "Test and lint"

npm run build     || fail "Build failed"
npm run lint      || fail "Lint failed"
npm run typecheck || fail "Type check failed"
npm test          || fail "Tests failed"
info "All checks passed"

# =============================================================================
# Step 2: Release branch with version bump
# =============================================================================
step 2 "Release branch with version bump"

git fetch origin master --quiet

# Reuse an existing branch if we're resuming; otherwise branch from master tip.
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  info "Local branch $BRANCH exists — checking out to resume"
  git checkout "$BRANCH"
elif git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  info "Remote branch origin/$BRANCH exists — tracking it"
  git checkout -b "$BRANCH" "origin/$BRANCH"
else
  git checkout -b "$BRANCH" origin/master
  info "Branch $BRANCH created from origin/master"
fi

if [ "$CURRENT_VERSION" != "$VERSION" ]; then
  npm version "$VERSION" --no-git-tag-version
  info "package.json bumped to ${VERSION}"
fi

if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
  git add package.json package-lock.json
  git commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Version bump already committed"
fi

git push -u origin "$BRANCH"
info "Pushed $BRANCH"

# =============================================================================
# Step 3: Open PR (or reuse)
# =============================================================================
step 3 "Open PR against master"

PR_NUMBER=$(gh pr list --head "$BRANCH" --base master --state open --json number --jq '.[0].number // empty')

if [ -n "$PR_NUMBER" ]; then
  info "PR #${PR_NUMBER} already open — reusing"
else
  PR_URL=$(gh pr create \
    --base master \
    --head "$BRANCH" \
    --title "v${VERSION}" \
    --body "Automated release PR for v${VERSION}. Opened by \`release.sh\`; will be auto-merged once required status checks pass.")
  PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
  [ -n "$PR_NUMBER" ] || fail "Could not parse PR number from: $PR_URL"
  info "Opened PR #${PR_NUMBER}: $PR_URL"
fi

# =============================================================================
# Step 4: Wait for CI, then squash-merge
# =============================================================================
step 4 "Wait for CI + squash-merge"

# Poll the PR's required checks. `gh pr checks --watch` blocks until checks
# complete; exits non-zero if any fail. `--required` limits to the checks
# that actually gate merge, so we don't wait for optional jobs.
if ! gh pr checks "$PR_NUMBER" --watch --required --interval 15; then
  echo ""
  gh pr checks "$PR_NUMBER" --required || true
  fail "PR #${PR_NUMBER} has failing required checks"
fi
info "All required checks passed on PR #${PR_NUMBER}"

# Squash-merge. The resulting commit on master is signed by GitHub's web-flow
# key, satisfying the "signed commits" ruleset on master.
PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state')
if [ "$PR_STATE" = "MERGED" ]; then
  info "PR #${PR_NUMBER} already merged"
else
  gh pr merge "$PR_NUMBER" --squash --delete-branch
  info "PR #${PR_NUMBER} squash-merged; branch deleted"
fi

# Sync local master to the merge commit so subsequent steps work from it.
git checkout master
git pull origin master --ff-only --quiet
info "Local master synced"

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"

NPM_VERSION=$(npm view @yawlabs/mcp-compliance version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "Already published to npm — skipping"
else
  npm publish --access public --provenance
  info "Published @yawlabs/mcp-compliance@${VERSION}"
fi

# =============================================================================
# Step 6: Create tag + GitHub release
# =============================================================================
step 6 "Create tag + GitHub release"

if gh release view "$TAG" >/dev/null 2>&1; then
  info "Release $TAG already exists — skipping"
else
  # gh release create creates both the tag and the release via the Releases
  # API. Requires tag-creation bypass for the bot on the tag ruleset.
  PREV_TAG=$(git tag --sort=-v:refname | grep -v "^${TAG}\$" | head -1 || echo "")
  NOTES_ARGS=(--generate-notes)
  if [ -n "$PREV_TAG" ]; then
    NOTES_ARGS+=(--notes-start-tag "$PREV_TAG")
  fi

  gh release create "$TAG" \
    --title "$TAG" \
    --target master \
    "${NOTES_ARGS[@]}"
  info "Release $TAG created"
fi

# =============================================================================
# Step 7: Verify
# =============================================================================
step 7 "Verify"

sleep 3  # npm can take a moment to propagate

LIVE_VERSION=$(npm view @yawlabs/mcp-compliance version 2>/dev/null || echo "")
if [ "$LIVE_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/mcp-compliance@${LIVE_VERSION}"
else
  warn "npm: ${LIVE_VERSION} (expected ${VERSION} — may still be propagating)"
fi

GH_TAG=$(gh release view "$TAG" --json tagName --jq '.tagName' 2>/dev/null || echo "")
if [ "$GH_TAG" = "$TAG" ]; then
  info "GitHub release: ${GH_TAG}"
else
  warn "GitHub release: not found"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     v${VERSION} released successfully!                     ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  npm: npm i @yawlabs/mcp-compliance@${VERSION}              ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
