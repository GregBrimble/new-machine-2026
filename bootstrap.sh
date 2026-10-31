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
interactive() {
  # Keep password/confirmation prompts available when curl-piped into Bash.
  if [[ ! -t 0 ]] && ( : </dev/tty ) 2>/dev/null; then
    "$@" </dev/tty
  else
    "$@"
  fi
}
find_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    printf '/opt/homebrew/bin/brew\n'
  elif [[ -x /usr/local/bin/brew ]]; then
    printf '/usr/local/bin/brew\n'
  else
    return 1
  fi
}

main() {
  local arg previous="" profile="shared" mode="" source_dir="" project_dir brew_bin brew_environment mise_bin mise_prefix installed_formulas node_version lock_hash
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
        printf 'Prepares Homebrew, Homebrew-managed mise, and pinned Node.js before running the TypeScript configurator.\n'
        printf 'Preview modes still prepare these prerequisites and npm dependencies, but do not apply other machine settings.\n'
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

  if ! brew_bin="$(find_homebrew)"; then
    printf 'Installing Homebrew with its official installer.\n'
    download 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh' "$bootstrap_tmp/install-homebrew.sh"
    interactive /bin/bash "$bootstrap_tmp/install-homebrew.sh"
    brew_bin="$(find_homebrew)" || fail "Homebrew was not found after installation."
  fi
  brew_bin="$(cd -- "$(dirname -- "$brew_bin")" && pwd -P)/$(basename -- "$brew_bin")"
  "$brew_bin" --version
  brew_environment="$("$brew_bin" shellenv)"
  eval "$brew_environment"

  installed_formulas="$("$brew_bin" list --formula --versions)"
  if printf '%s\n' "$installed_formulas" | awk '$1 == "mise" {found=1} END {exit !found}'; then
    mise_prefix="$("$brew_bin" --prefix mise)"
    if [[ ! -x "$mise_prefix/bin/mise" || ! -s "$mise_prefix/share/zsh/site-functions/_mise" ]]; then
      printf 'Repairing the Homebrew-managed mise installation.\n'
      interactive "$brew_bin" reinstall mise
    fi
  else
    printf 'Installing mise through Homebrew.\n'
    interactive "$brew_bin" install mise
  fi
  mise_prefix="$("$brew_bin" --prefix mise)"
  [[ "$mise_prefix" == /* ]] || fail "Homebrew returned a non-absolute mise prefix."
  mise_bin="$mise_prefix/bin/mise"
  [[ -x "$mise_bin" ]] || fail "Homebrew-managed mise was not found after installation."
  [[ -s "$mise_prefix/share/zsh/site-functions/_mise" ]] || fail "Homebrew's mise zsh completion was not found after installation."
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
  BOOTSTRAP_BREW_BIN="$brew_bin" BOOTSTRAP_MISE_BIN="$mise_bin" \
    "$mise_bin" exec "node@$node_version" -- node src/main.ts "$@"
}

# Read every definition before starting, including when curl-piped into Bash.
main "$@"
