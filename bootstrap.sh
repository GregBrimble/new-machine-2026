#!/bin/bash
# macOS bootstrap, compatible with Apple's bundled Bash 3.2.
set -euo pipefail

# Configuration: edit these values and rerun.
APPEARANCE="dark" # dark or light
HOMEBREW_SHELL_PROFILE="${ZDOTDIR:-$HOME}/.zprofile" # zsh login shells
GHOSTTY_APP_DIR="/Applications"
SPOTLIGHT_EXCLUDED_FOLDERS=(
  "$HOME/Developer"
  "/opt/homebrew"
)

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

ensure_spotlight_exclusions() {
  [[ ${#SPOTLIGHT_EXCLUDED_FOLDERS[@]} -gt 0 ]] || return 0
  local folder
  local folders=()
  for folder in "${SPOTLIGHT_EXCLUDED_FOLDERS[@]}"; do
    mkdir -p -- "$folder"
    folders+=("$(cd -P -- "$folder" && pwd)")
  done

  # Use macOS's folder picker; it deduplicates by path, including on reruns.
  # The privacy table only exposes display names, so never skip based on a name.
  osascript - "${folders[@]}" <<'APPLESCRIPT'
on findControl(wantedRole, wantedLabel)
  tell application "System Events"
    tell process "System Settings"
      if not (exists window 1) then return missing value
      set controls to entire contents of window 1
    end tell
    repeat with uiItem in controls
      try
        if role of uiItem is wantedRole then
          set labels to {}
          try
            set end of labels to name of uiItem as text
          end try
          try
            set end of labels to description of uiItem as text
          end try
          try
            set end of labels to value of attribute "AXIdentifier" of uiItem as text
          end try
          repeat with labelText in labels
            if (contents of labelText) is wantedLabel then return contents of uiItem
          end repeat
        end if
      end try
    end repeat
  end tell
  return missing value
end findControl

on waitForControl(wantedRole, wantedLabel)
  repeat 100 times
    set uiItem to my findControl(wantedRole, wantedLabel)
    if uiItem is not missing value then return uiItem
    delay 0.2
  end repeat
  error "Could not find " & wantedLabel & ". This automation requires English System Settings on macOS Tahoe."
end waitForControl

on run folderPaths
  tell application "System Events"
    if not UI elements enabled then error "Enable Accessibility for your terminal in System Settings > Privacy & Security > Accessibility, then rerun."
  end tell
  tell application "System Settings" to activate
  if my findControl("AXTable", "Excluded locations") is missing value then
    open location "x-apple.systempreferences:com.apple.Spotlight-Settings.extension"
    set privacyButton to my waitForControl("AXButton", "Search Privacy…")
    tell application "System Events" to click privacyButton
  end if

  repeat with folderPath in folderPaths
    set privacyTable to my waitForControl("AXTable", "Excluded locations")
    tell application "System Events" to set previousCount to count rows of privacyTable
    set addButton to my waitForControl("AXButton", "Add folder or a disk to exclude from indexing.")
    tell application "System Events" to click addButton
    set chooseButton to my waitForControl("AXButton", "OKButton")
    tell application "System Events" to keystroke "g" using {command down, shift down}
    set pathField to my waitForControl("AXTextField", "PathTextField")
    tell application "System Events"
      set value of pathField to contents of folderPath
      key code 36
    end tell
    -- Wait for Go to Folder to close before submitting the open panel.
    repeat 100 times
      if my findControl("AXTextField", "PathTextField") is missing value then exit repeat
      delay 0.2
    end repeat
    if my findControl("AXTextField", "PathTextField") is not missing value then error "Could not resolve folder: " & folderPath
    set chooseButton to my waitForControl("AXButton", "OKButton")
    tell application "System Events" to click chooseButton

    -- An error dialog or an open picker must never be reported as success.
    set focusedOnTable to false
    repeat 100 times
      tell application "System Events"
        try
          set focusedControl to value of attribute "AXFocusedUIElement" of process "System Settings"
          if role of focusedControl is "AXTable" and name of focusedControl is "Excluded locations" then set focusedOnTable to true
        end try
      end tell
      if focusedOnTable then exit repeat
      delay 0.2
    end repeat
    if not focusedOnTable then error "Search Privacy did not accept folder: " & folderPath
    set privacyTable to my waitForControl("AXTable", "Excluded locations")
    tell application "System Events" to set currentCount to count rows of privacyTable
    if currentCount < previousCount or currentCount > previousCount + 1 then error "Unexpected change to Search Privacy."
  end repeat
  set doneButton to my waitForControl("AXButton", "Done")
  tell application "System Events" to click doneButton
end run
APPLESCRIPT
  for folder in "${folders[@]}"; do
    printf 'Ensured Spotlight exclusion: %s\n' "$folder"
  done
}

main() {
  local dry_run=false BREW_BIN folder
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      -h|--help)
        printf 'Usage: /bin/bash bootstrap.sh [--dry-run]\n'
        printf 'Ensures appearance, Homebrew, Ghostty, and Spotlight folder exclusions.\n'
        return
        ;;
      *) fail "Unknown argument: $1. Use --help." ;;
    esac
    shift
  done

  [[ "$APPEARANCE" == dark || "$APPEARANCE" == light ]] || fail "APPEARANCE must be dark or light."
  [[ "$HOMEBREW_SHELL_PROFILE" == /* && "$GHOSTTY_APP_DIR" == /* ]] || fail "Configured paths must be absolute."
  if [[ ${#SPOTLIGHT_EXCLUDED_FOLDERS[@]} -gt 0 ]]; then
    for folder in "${SPOTLIGHT_EXCLUDED_FOLDERS[@]}"; do
      [[ "$folder" == /* && "$folder" != / ]] || fail "Spotlight exclusions must be absolute folder paths below /."
    done
  fi
  [[ "$(uname -s)" == Darwin ]] || fail "This script supports macOS only."
  [[ "$(id -u)" != 0 ]] || fail "Run as your normal user, without sudo."

  if "$dry_run"; then
    printf 'Would ensure %s appearance with automatic switching disabled.\n' "$APPEARANCE"
    printf 'Would ensure Homebrew is installed and configured in %s.\n' "$HOMEBREW_SHELL_PROFILE"
    printf 'Would ensure Ghostty is installed in %s.\n' "$GHOSTTY_APP_DIR"
    if [[ ${#SPOTLIGHT_EXCLUDED_FOLDERS[@]} -gt 0 ]]; then
      for folder in "${SPOTLIGHT_EXCLUDED_FOLDERS[@]}"; do
        printf 'Would create if missing and exclude from Spotlight: %s\n' "$folder"
      done
    fi
    printf 'Preview only; current settings and installations were not inspected.\n'
    return
  fi

  ensure_appearance
  ensure_homebrew
  ensure_ghostty
  ensure_spotlight_exclusions
}

# Run after all definitions have been read, including when piped into bash.
main "$@"
