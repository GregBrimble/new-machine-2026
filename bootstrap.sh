#!/bin/bash
# macOS bootstrap, compatible with Apple's bundled Bash 3.2.
set -euo pipefail

# Configuration: edit these values and rerun.
APPEARANCE="dark" # dark or light
HOMEBREW_SHELL_PROFILE="${ZDOTDIR:-$HOME}/.zprofile" # zsh login shells
GHOSTTY_APP_DIR="/Applications"

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

read_dark_mode() {
  osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode'
}

read_automatic_appearance() {
  # An absent key means automatic appearance is disabled.
  defaults read -g AppleInterfaceStyleSwitchesAutomatically 2>/dev/null || printf '0\n'
}

ensure_appearance() {
  local desired actual automatic
  case "$APPEARANCE" in
    dark) desired=true ;;
    light) desired=false ;;
    *) fail "APPEARANCE must be dark or light." ;;
  esac
  if ! actual="$(read_dark_mode)"; then
    fail "Could not read appearance. Allow your terminal to control System Events if macOS requests it, then rerun."
  fi
  automatic="$(read_automatic_appearance)"
  [[ "$actual" == true || "$actual" == false ]] || fail "Unexpected dark mode value: $actual"
  [[ "$automatic" == 0 || "$automatic" == 1 ]] || fail "Unexpected automatic appearance value: $automatic"

  if [[ "$actual" == "$desired" && "$automatic" == 0 ]]; then
    printf 'Already configured: %s appearance, automatic switching disabled.\n' "$APPEARANCE"
    return
  fi

  if [[ "$automatic" != 0 ]]; then
    defaults write -g AppleInterfaceStyleSwitchesAutomatically -bool false
  fi
  if [[ "$actual" != "$desired" ]]; then
    osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $desired"
  fi

  actual="$(read_dark_mode)"
  automatic="$(read_automatic_appearance)"
  [[ "$actual" == "$desired" && "$automatic" == 0 ]] || fail "Appearance did not match the configuration after applying it."
  printf 'Configured: %s appearance, automatic switching disabled.\n' "$APPEARANCE"
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

ensure_homebrew() {
  local installer shell_environment shell_line
  if BREW_BIN="$(find_homebrew)"; then
    printf 'Already installed: Homebrew (%s).\n' "$BREW_BIN"
  else
    printf 'Installing Homebrew with its official installer.\n'
    installer="$(curl --fail --silent --show-error --location \
      'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')" \
      || fail "Could not download the Homebrew installer."
    [[ -n "$installer" ]] || fail "The Homebrew installer download was empty."
    # Keep password/confirmation prompts available when this script is curl-piped.
    if [[ ! -t 0 ]] && ( : </dev/tty ) 2>/dev/null; then
      /bin/bash -c "$installer" </dev/tty
    else
      /bin/bash -c "$installer"
    fi
    BREW_BIN="$(find_homebrew)" || fail "Homebrew was not found after installation."
  fi
  "$BREW_BIN" --version >/dev/null
  shell_environment="$("$BREW_BIN" shellenv)"
  eval "$shell_environment"

  printf -v shell_line 'eval "$(%q shellenv)"' "$BREW_BIN"
  if [[ -f "$HOMEBREW_SHELL_PROFILE" ]] && \
      grep -Fqx -- "$shell_line" "$HOMEBREW_SHELL_PROFILE"; then
    printf 'Already configured: Homebrew in %s.\n' "$HOMEBREW_SHELL_PROFILE"
  else
    printf '\n# Homebrew\n%s\n' "$shell_line" >> "$HOMEBREW_SHELL_PROFILE"
    printf 'Configured: Homebrew in %s.\n' "$HOMEBREW_SHELL_PROFILE"
  fi
}

ensure_ghostty() {
  local executable="$GHOSTTY_APP_DIR/Ghostty.app/Contents/MacOS/ghostty"
  if [[ -x "$executable" ]]; then
    printf 'Already installed: Ghostty (%s/Ghostty.app).\n' "$GHOSTTY_APP_DIR"
    return
  fi

  if "$BREW_BIN" list --cask ghostty >/dev/null 2>&1; then
    printf 'Repairing missing Ghostty app.\n'
    "$BREW_BIN" reinstall --cask --appdir="$GHOSTTY_APP_DIR" ghostty
  else
    printf 'Installing Ghostty.\n'
    "$BREW_BIN" install --cask --appdir="$GHOSTTY_APP_DIR" ghostty
  fi
  [[ -x "$executable" ]] || fail "Ghostty was not found after installation."
  printf 'Installed: Ghostty (%s/Ghostty.app).\n' "$GHOSTTY_APP_DIR"
}

main() {
  local dry_run=false BREW_BIN
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      -h|--help)
        printf 'Usage: /bin/bash bootstrap.sh [--dry-run]\n'
        printf 'Ensures appearance, Homebrew, its zsh profile entry, and Ghostty.\n'
        return
        ;;
      *) fail "Unknown argument: $1. Use --help." ;;
    esac
    shift
  done

  [[ "$APPEARANCE" == dark || "$APPEARANCE" == light ]] || fail "APPEARANCE must be dark or light."
  [[ "$HOMEBREW_SHELL_PROFILE" == /* && "$GHOSTTY_APP_DIR" == /* ]] || fail "Configured paths must be absolute."
  [[ "$(uname -s)" == Darwin ]] || fail "This script supports macOS only."
  [[ "$(id -u)" != 0 ]] || fail "Run as your normal user, without sudo."

  if "$dry_run"; then
    printf 'Would ensure %s appearance with automatic switching disabled.\n' "$APPEARANCE"
    printf 'Would ensure Homebrew is installed and configured in %s.\n' "$HOMEBREW_SHELL_PROFILE"
    printf 'Would ensure Ghostty is installed in %s.\n' "$GHOSTTY_APP_DIR"
    printf 'Preview only; current settings and installations were not inspected.\n'
    return
  fi

  ensure_appearance
  ensure_homebrew
  ensure_ghostty
}

# Run after all definitions have been read, including when piped into bash.
main "$@"
