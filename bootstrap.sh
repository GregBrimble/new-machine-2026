#!/bin/bash
# Fresh macOS entry point; uses only tools included with macOS (Bash 3.2).
set -euo pipefail

bootstrap_tmp=""
cleanup() { [[ -z "$bootstrap_tmp" ]] || rm -rf -- "$bootstrap_tmp"; }
trap cleanup EXIT

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
download() {
  curl --fail --silent --show-error --location --retry 2 \
    --connect-timeout 15 --max-time 300 "$1" --output "$2"
  [[ -s "$2" ]] || fail "Empty download: $1"
}

main() {
  local arg previous="" profile="shared" mode="" source_dir="" project_dir mise_bin node_version lock_hash
  for arg in "$@"; do
    if [[ "$previous" == --profile ]]; then
      profile="$arg"; previous=""; continue
    fi
    case "$arg" in
      --dry-run|--plan)
        [[ -z "$mode" ]] || fail "Choose only one of --dry-run and --plan."
        mode="$arg" ;;
      --profile) previous="$arg" ;;
      -h|--help)
        printf 'Usage: /bin/bash bootstrap.sh [--dry-run | --plan] [--profile shared|personal|cloudflare]\n'
        printf 'Installs mise and pinned Node.js before running the TypeScript configurator.\n'
        printf 'Preview modes still prepare the runtime and npm dependencies, but do not apply machine settings.\n'
        return ;;
      *) fail "Unknown argument: $arg. Use --help." ;;
    esac
  done
  [[ -z "$previous" ]] || fail "--profile requires a value."
  case "$profile" in shared|personal|cloudflare) ;; *) fail "Unknown profile: $profile" ;; esac
  [[ "$(uname -s)" == Darwin ]] || fail "This bootstrap supports macOS only."
  [[ "$(id -u)" != 0 ]] || fail "Run as your normal user, without sudo."

  bootstrap_tmp="$(mktemp -d "${TMPDIR:-/tmp}/new-machine-2026.XXXXXX")"
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  fi
  if [[ -n "$source_dir" && -f "$source_dir/src/main.ts" && -f "$source_dir/package-lock.json" ]]; then
    project_dir="$source_dir"
  else
    printf 'Downloading the configurator from GitHub (no Git installation needed).\n'
    download 'https://codeload.github.com/GregBrimble/new-machine-2026/tar.gz/main' "$bootstrap_tmp/source.tar.gz"
    project_dir="$bootstrap_tmp/source"
    mkdir -p "$project_dir"
    tar -xzf "$bootstrap_tmp/source.tar.gz" --strip-components=1 -C "$project_dir"
  fi
  cd "$project_dir"
  [[ -f .node-version && -f package-lock.json && -f src/main.ts ]] || fail "Incomplete configurator download."
  read -r node_version < .node-version
  [[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid pinned Node.js version."

  if command -v mise >/dev/null 2>&1; then
    mise_bin="$(command -v mise)"
  elif [[ -x "$HOME/.local/bin/mise" ]]; then
    mise_bin="$HOME/.local/bin/mise"
  elif [[ -x /opt/homebrew/bin/mise ]]; then
    mise_bin=/opt/homebrew/bin/mise
  elif [[ -x /usr/local/bin/mise ]]; then
    mise_bin=/usr/local/bin/mise
  else
    printf 'Installing mise with its official installer.\n'
    download 'https://mise.run' "$bootstrap_tmp/install-mise.sh"
    MISE_VERSION=v2026.10.25 MISE_INSTALL_PATH="$HOME/.local/bin/mise" \
      /bin/sh "$bootstrap_tmp/install-mise.sh" </dev/null
    mise_bin="$HOME/.local/bin/mise"
  fi
  [[ -x "$mise_bin" ]] || fail "mise was not found after installation."
  mise_bin="$(cd -- "$(dirname -- "$mise_bin")" && pwd -P)/$(basename -- "$mise_bin")"
  "$mise_bin" --version
  export MISE_YES=1
  printf 'Preparing Node.js %s through mise.\n' "$node_version"
  "$mise_bin" exec "node@$node_version" -- node --version

  lock_hash="$(shasum -a 256 package-lock.json | awk '{print $1}')"
  if [[ ! -f node_modules/.bootstrap-lock-sha256 || ! -f node_modules/effect/package.json ]] || \
      [[ "$(cat node_modules/.bootstrap-lock-sha256)" != "$lock_hash" ]]; then
    "$mise_bin" exec "node@$node_version" -- npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      --cache "$HOME/Library/Caches/new-machine-2026/npm"
    printf '%s\n' "$lock_hash" > node_modules/.bootstrap-lock-sha256
  fi
  BOOTSTRAP_MISE_BIN="$mise_bin" "$mise_bin" exec "node@$node_version" -- node src/main.ts "$@"
}

# Read every definition before starting, including when curl-piped into Bash.
main "$@"
