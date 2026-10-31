# New machine 2026

A single macOS bootstrap script with its configuration inline. It ensures:

- Dark appearance with automatic light/dark switching disabled.
- Homebrew, using its [official installer](https://docs.brew.sh/Installation) when missing.
- A Homebrew `shellenv` entry in your zsh login profile, appended once.
- [Ghostty](https://ghostty.org/docs/install/binary), using `brew install --cask ghostty`.
- Spotlight Search Privacy exclusions for the folders in
  `SPOTLIGHT_EXCLUDED_FOLDERS`, initially `~/Developer` and `/opt/homebrew`.

Existing installations are kept without upgrading them. If Homebrew records
Ghostty as installed but its app executable is missing, the script reinstalls the
cask. An existing executable at the configured app destination is kept, including
a manually installed Ghostty.

Edit the configuration at the top of `bootstrap.sh`: `APPEARANCE`,
`HOMEBREW_SHELL_PROFILE` (defaults to `${ZDOTDIR:-$HOME}/.zprofile`), and
`GHOSTTY_APP_DIR` (defaults to `/Applications`). If you use another shell, choose
its appropriate startup file for `HOMEBREW_SHELL_PROFILE`; the generated entry
works with zsh and Bash.

Edit `SPOTLIGHT_EXCLUDED_FOLDERS` to change the folder list, or use `()` to skip
Spotlight automation. Listed folders are created if missing. Exclusions are
added through System Settings without renaming folders; macOS deduplicates
repeated additions by path. Existing exclusions are preserved. Removing an entry
from this array does not re-enable its indexing; remove it from Search Privacy
in System Settings when you want that.

The UI automation targets **English System Settings on macOS Tahoe (26)**.
It opens the Spotlight pane and operates its folder picker. Allow your terminal
to control System Events and System Settings under Privacy & Security > Automation,
and enable your terminal under Privacy & Security > Accessibility. Leave System
Settings and the keyboard alone while this step runs. A missing control, denied
permission, or an unaccepted folder stops the script with an error.

```sh
/bin/bash bootstrap.sh --dry-run
/bin/bash bootstrap.sh
```

Run as your normal user. macOS may ask permission for your terminal to control
System Events. Homebrew's installer may request your administrator password,
confirmation, and developer tools. Interactive prompts use the terminal even
when you pipe this script into Bash. Headless runs follow the installer's
non-interactive behavior and need any required privileges provisioned beforehand.

An error stops the script; fix the cause and rerun. A preview describes the
desired state without querying System Events, downloading installers, or writing
files. Open a new login terminal after running so it picks up Homebrew's profile
entry. The script does not create a background service.

## Run from GitHub

Download and run the latest script:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' --output bootstrap.sh &&
  /bin/bash bootstrap.sh
```

Or execute directly from the response:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' | /bin/bash -s --
```

To preview the hosted script, add `--dry-run` after `--` in the second example.
Rerun the command whenever you update the hosted configuration or want to repair
local drift. Nothing runs automatically between invocations.
