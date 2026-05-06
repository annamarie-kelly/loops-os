#!/usr/bin/env bash
# Loops OS · installer
# Clones (or updates) the Loops OS repo and hands off to `npm run start`.
# Usage:  curl -fsSL https://raw.githubusercontent.com/annamarie-kelly/loops-os/main/install.sh | bash
# Override install dir with: LOOPS_OS_DIR=/path/to/dir

set -euo pipefail

# ── Color constants (mirror loops-ui/scripts/start.mjs) ──────────────────────
RESET=$'\033[0m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
CYAN=$'\033[36m'

banner() {
  printf '\n'
  printf '%s%sLoops OS%s %s·%s %sinstaller%s\n' "$BOLD" "$CYAN" "$RESET" "$DIM" "$RESET" "$BOLD" "$RESET"
  printf '%s%s%s\n' "$DIM" "----------------------------------------" "$RESET"
}

info() { printf '%s·%s %s\n' "$BLUE" "$RESET" "$1"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }

REPO_URL="https://github.com/annamarie-kelly/loops-os.git"
DIR="${LOOPS_OS_DIR:-$HOME/loops-os}"

banner

# ── Platform check ────────────────────────────────────────────────────────────
UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Darwin)  PLATFORM=mac   ; ok "Platform: macOS" ;;
  Linux)   PLATFORM=linux ; ok "Platform: Linux" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    fail "Windows detected. Native installer coming soon. For now, install manually:"
    printf '  git clone %s\n' "$REPO_URL"
    printf '  cd loops-os/loops-ui\n'
    printf '  npm run start\n'
    exit 1
    ;;
  *)
    fail "Unsupported platform: $UNAME_S. Install manually:"
    printf '  git clone %s\n' "$REPO_URL"
    printf '  cd loops-os/loops-ui\n'
    printf '  npm run start\n'
    exit 1
    ;;
esac

# ── Node check (v20+) ─────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  fail "Node not found. Node 20+ required."
  if [ "$PLATFORM" = "mac" ]; then
    printf '  Install: brew install node@20  (or https://nodejs.org/)\n'
  else
    printf '  Install via nvm (https://github.com/nvm-sh/nvm) or https://nodejs.org/\n'
  fi
  exit 1
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $NODE_VERSION detected. Node 20+ required."
  if [ "$PLATFORM" = "mac" ]; then
    printf '  Upgrade: brew install node@20  (or https://nodejs.org/)\n'
  else
    printf '  Upgrade via nvm (https://github.com/nvm-sh/nvm) or https://nodejs.org/\n'
  fi
  exit 1
fi
ok "Node $NODE_VERSION"

# ── git check ─────────────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  fail "git not found."
  if [ "$PLATFORM" = "mac" ]; then
    printf '  Install Xcode Command Line Tools: xcode-select --install\n'
  else
    printf '  Install via your package manager (apt install git, yum install git, etc.)\n'
  fi
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# ── Install dir ───────────────────────────────────────────────────────────────
if [ -e "$DIR" ]; then
  if [ -d "$DIR/.git" ]; then
    info "Updating existing install at $DIR"
    cd "$DIR"
    git pull --ff-only
    ok "Updated"
  else
    fail "Directory $DIR exists but isn't a Loops OS repo."
    printf '  Remove it or set LOOPS_OS_DIR to a different path.\n'
    exit 1
  fi
else
  info "Cloning to $DIR"
  git clone "$REPO_URL" "$DIR"
  ok "Cloned"
fi

# ── Hand off ──────────────────────────────────────────────────────────────────
cd "$DIR/loops-ui"
printf '\n'
info "Handing off to npm run start..."
printf '%s%s%s\n' "$DIM" "----------------------------------------" "$RESET"
exec npm run start
