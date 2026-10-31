# New machine 2026

A macOS configurator written in TypeScript with Effect. A small Bash entry point
prepares its runtime on a brand new Mac, then runs the configuration.

## Run from GitHub

Run as your normal user:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' |
  /bin/bash -s --
```

For a personal or Cloudflare machine, append `--profile personal` or
`--profile cloudflare` after `--`. Both currently use the shared configuration;
their editable overrides start empty.

The launcher uses tools shipped with macOS. It:

1. Downloads the repository as a GitHub archive when run outside a checkout.
   Git, Xcode, and Command Line Tools are not needed to fetch the runner.
2. Reuses mise from PATH, `~/.local/bin`, or a standard Homebrew prefix. If
   missing, installs mise v2026.10.25 to `~/.local/bin/mise` using its
   [official installer](https://mise.jdx.dev/installing-mise.html).
3. Uses `mise exec` to install/select **Node.js 24.22.2**, pinned in
   `.node-version`. This version runs the TypeScript source directly.
4. Installs locked production dependencies with `npm ci --omit=dev
   --ignore-scripts`, then runs the Effect configurator.

Runtime setup precedes every mode, including previews. **On a fresh Mac,
`--dry-run` and `--plan` can download/install mise, Node.js, and the runner's
dependencies.** They do not apply machine settings, install Homebrew/casks, or
edit shell profiles. `--help` needs no runtime or downloads.

Homebrew's installer may subsequently ask for your administrator password,
confirmation, and developer tools. Interactive installers use `/dev/tty` when
available, including when this launcher is curl-piped. Headless runs inherit
stdin and need any required privileges provisioned beforehand.

## Configuration

Edit the ordinary TypeScript data in [`src/config.ts`](src/config.ts):

- Dark appearance with automatic light/dark switching disabled.
- Homebrew installed through its official installer when missing.
- A Homebrew `shellenv` entry in `${ZDOTDIR:-$HOME}/.zprofile`.
- mise activation in `${ZDOTDIR:-$HOME}/.zshrc`.
- Ghostty installed in `/Applications` through Homebrew.
- Spotlight Search Privacy exclusions for `~/Developer` and `/opt/homebrew`.

The `shared` object is the base. `personal` and `cloudflare` profile overrides
replace scalar values and append to the shared cask and exclusion arrays.
Paths must be absolute. Edit the shared exclusion array to `[]` to skip Spotlight
automation. Each cask specifies its Homebrew name, app bundle, and executable
within the bundle, so the runner can verify installation.

The runner inspects each resource, applies necessary changes, and verifies the
result before proceeding to its dependents. Existing Homebrew and apps are kept
without upgrading. An executable Ghostty installation is kept even if installed
manually. A recorded cask whose app executable is missing is repaired using
`brew reinstall`. Profile entries are appended only when their exact line is
absent; existing contents are preserved.

An error stops the run. Fix the cause and rerun to reconcile the remaining
configuration. Open a new login terminal after applying shell setup. The Node
pin is selected explicitly for the runner through mise; other projects can
select their own versions. Nothing runs automatically between invocations.

## Preview and inspect

From a checkout:

```sh
/bin/bash bootstrap.sh --dry-run
/bin/bash bootstrap.sh --plan --profile cloudflare
/bin/bash bootstrap.sh --profile personal
```

From the hosted entry point, pass the same options after `/bin/bash -s --`.

- `--dry-run` prints the desired operations without inspecting machine settings
  or invoking System Events. Runtime preparation still happens as described above.
- `--plan` inspects current state and reports `ok`, `change`, or `unknown`,
  without applying machine configuration. Reading appearance may require
  Automation permission. Resources depending on a missing Homebrew installation
  can remain `unknown` until it is installed.
- With neither flag, the runner inspects, applies, and verifies resources in order.

## Spotlight automation

macOS does not expose a supported folder-level CLI for Search Privacy. The
runner reports this state as `unknown` in its plan, then uses System Settings to
ensure each configured exclusion during application. The folder picker
deduplicates repeated additions by path. Listed folders are created if missing;
existing exclusions are preserved. Removing a folder from the configuration does
not re-enable indexing: remove it from Search Privacy in System Settings.

The AppleScript targets **English System Settings on macOS Tahoe (26)**. Allow
your terminal to control System Events and System Settings under Privacy &
Security > Automation, and enable it under Privacy & Security > Accessibility.
Leave System Settings and the keyboard alone during this step. Missing controls,
denied permission, or an unaccepted folder fail the run. Verification happens
inside the picker automation; an independent folder-level state query is
unavailable.

## Development

```sh
mise exec "node@$(cat .node-version)" -- npm ci --ignore-scripts
mise exec "node@$(cat .node-version)" -- npm run check
mise exec "node@$(cat .node-version)" -- npm test
```

Effect and development dependencies are pinned in `package-lock.json`. There is
no transpilation step. Tests cover resource convergence, failure handling,
process/filesystem adapters, and the shell entry point with simulated missing
tools and failed downloads. They do not change the host's settings or install
Homebrew or Ghostty.

Local bootstrap runs reuse dependencies when the lockfile fingerprint matches.
Hosted runs unpack into a temporary directory, use npm's cache under
`~/Library/Caches/new-machine-2026/npm`, and clean up the unpacked source and
dependencies on exit. mise and its installed Node version persist for reuse.
