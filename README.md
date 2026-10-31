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
2. Reuses Homebrew from PATH or a standard prefix. If missing, installs it with
   its [official installer](https://docs.brew.sh/Installation). Passes the resolved
   Homebrew executable to the configurator.
3. Installs mise with `brew install mise` if needed, repairing the formula with
   `brew reinstall mise` if its executable or zsh completion is missing. The
   runner uses Homebrew's stable `opt/mise/bin/mise` path, including when another
   mise is on PATH. Homebrew owns mise and its bundled completions.
4. Uses `mise exec` to install/select **Node.js 26.13.0**, pinned in
   `.node-version`. Its bundled npm is **11.20.0**; no separate npm installation
   is needed. This version runs the TypeScript source directly.
5. Installs locked production dependencies with `npm ci --omit=dev
   --ignore-scripts`, then runs the Effect configurator.

Runtime setup precedes every mode, including previews. **On a fresh Mac,
`--dry-run` and `--plan` can install Homebrew, Homebrew's mise, Node.js, and the
runner's dependencies.** They do not apply appearance/Spotlight settings, install
casks, or edit shell profiles. `--help` needs no runtime or downloads.

Homebrew's installer may ask for your administrator password,
confirmation, and developer tools. Interactive installers use `/dev/tty` when
available, including when this launcher is curl-piped. Headless runs inherit
stdin and need any required privileges provisioned beforehand.

## Configuration

Edit the ordinary TypeScript data in [`src/config.ts`](src/config.ts):

- Dark appearance with automatic light/dark switching disabled.
- Homebrew prepared by the shell launcher and verified by the Effect runner.
- A Homebrew `shellenv` entry in zsh's `.zprofile`.
- mise activation in zsh's `.zshrc`.
- mise zsh completions supplied by Homebrew, with zsh completion initialization.
- Ghostty, Spotify, VLC, and Google Chrome installed through Homebrew Bundle.
- Global Git `push.autoSetupRemote=true` so a branch's first push sets its upstream.
- VLC playback at 2.35×, preferring English subtitles and falling back to any available track.
- Spotlight Search Privacy exclusions for `~/Developer` and `/opt/homebrew`.

The `shared` object is the base. `personal` and `cloudflare` profile overrides
replace scalar values and append to the shared cask and exclusion arrays.
Paths must be absolute. Edit the shared exclusion array to `[]` to skip Spotlight
automation. Casks are listed by their Homebrew names; the runner passes them as
an inline Brewfile to `brew bundle` through stdin, using Homebrew's default app
location (`/Applications` unless configured otherwise).

The runner asks `/bin/zsh` for its startup directory, honoring `ZDOTDIR` set in
`.zshenv` even without `export`, and falling back to `HOME` when unset. This uses
a noninteractive, non-login shell: it reads `.zshenv`, without loading `.zprofile`
or `.zshrc`. Set shared startup-directory choices in `.zshenv`. This resolution
runs in every mode, including previews, and executes any commands in `.zshenv`.

The runner inspects each resource, applies necessary changes, and verifies the
result before proceeding to its dependents. Casks use `brew bundle check` and
`brew bundle install`, both with `--no-upgrade`, followed by another check.
Bundle handles installation and adoption of matching manually installed apps;
it checks Homebrew's installation records, so a manually deleted app may need
`brew reinstall --cask <name>`. Removing a cask from this configuration leaves
the app installed. Activation entries are appended only when their exact line
is absent; existing contents are preserved.

Git settings use `git config --global`, preserving other settings and identities.
VLC preferences are merged into `~/Library/Preferences/org.videolan.vlc/vlcrc`;
other sections, comments, and unrelated settings are preserved. Conflicting
subtitle-disable and numbered-track overrides are removed so VLC's defaults
enable subtitles and select by language. Subtitle-file discovery keeps its
existing behavior; `any` selects from loaded tracks, including unnamed tracks.
Close VLC before applying changed preferences so it cannot overwrite them on
exit. An already configured VLC needs no shutdown.

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

- `--dry-run` prints the desired operations without applying configuration or
  invoking System Events. Runtime preparation and zsh startup-directory resolution
  still happen as described above.
- `--plan` inspects current state and reports `ok`, `change`, or `unknown`,
  without applying machine configuration. Reading appearance may require
  Automation permission. Spotlight remains `unknown` because macOS has no
  supported folder-level exclusion query.
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
dependencies on exit. Homebrew, mise, and its installed Node version persist for reuse.

## Zsh completions and updates

The bootstrap runs under Bash; it configures future zsh sessions in `.zshrc`.
It adds Homebrew's mise completion directory to `fpath` before existing shell
configuration, then initializes completion at the end only if `compdef` is not
already defined. Existing frameworks can initialize completion themselves.
mise's completion is explicitly registered, including when a prior completion
cache exists. The two marked completion blocks are updated in place on reruns;
other startup-file contents are preserved. No separate completion package is needed.

Update mise with `brew upgrade mise`; Node and other tools are still managed by
mise. Upstream notes that the Homebrew build can be larger and slower than its
optimized release binary, and package-manager releases can lag upstream. See
[mise installation methods](https://mise.jdx.dev/installing-mise.html).
