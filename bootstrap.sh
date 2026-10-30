#!/bin/bash
# macOS bootstrap, compatible with Apple's bundled Bash 3.2.
set -euo pipefail

# Configuration: edit this value and rerun to change the desired appearance.
APPEARANCE="dark" # dark or light

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

read_dark_mode() {
  osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode'
}

read_automatic_appearance() {
  # An absent key means automatic appearance is disabled.
  defaults read -g AppleInterfaceStyleSwitchesAutomatically 2>/dev/null || printf '0\n'
}

main() {
  local dry_run=false desired actual automatic
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      -h|--help)
        printf 'Usage: /bin/bash bootstrap.sh [--dry-run]\n'
        printf 'Ensures the inline APPEARANCE setting; disables automatic switching.\n'
        return
        ;;
      *) fail "Unknown argument: $1. Use --help." ;;
    esac
    shift
  done

  case "$APPEARANCE" in
    dark) desired=true ;;
    light) desired=false ;;
    *) fail "APPEARANCE must be dark or light." ;;
  esac
  [[ "$(uname -s)" == Darwin ]] || fail "This script supports macOS only."
  [[ "$(id -u)" != 0 ]] || fail "Run as your normal user, without sudo."

  if "$dry_run"; then
    # Preview without launching System Events or requesting Automation permission.
    printf 'Would ensure %s appearance with automatic switching disabled.\n' "$APPEARANCE"
    printf 'Preview only; current appearance was not inspected.\n'
    return
  fi

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

# Run after all definitions have been read, including when piped into bash.
main "$@"
