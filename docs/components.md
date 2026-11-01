# Component behavior

Edit desired settings in the corresponding module under [`src/components`](../src/components).
The registry wires dependencies; it does not hold configuration.

## Packages

The Homebrew component passes its formula and cask lists as an inline Brewfile
to `brew bundle check` and `brew bundle install`, both with `--no-upgrade`.
Unrelated packages remain installed, and removing an entry does not uninstall it.
Bundle can adopt matching manually installed apps. A manually deleted app can
require `brew reinstall --cask <name>` to repair Homebrew's installation record.
Apps use Homebrew's default installation location.

## Containers

The shared formula list installs [Apple's `container`](https://github.com/apple/container)
through [Homebrew](https://formulae.brew.sh/formula/container). It requires Apple
Silicon and macOS 26 or later. Start it on demand:

```sh
container system start
container run --rm alpine echo hello
```

On first start, accept the prompt to download the recommended Linux kernel.
Stop the service with `container system stop` when finished. Startup, networking,
and resource settings use the tool's defaults. Homebrew supplies its shell
completions; open a new login terminal after installation.

It runs OCI images and builds Dockerfiles with `container build`. Docker API
compatibility and Compose require additional community tooling; see Apple's
[Docker API issue](https://github.com/apple/container/issues/66) and
[Compose discussion](https://github.com/apple/container/discussions/194).

## Developer layout

The initializer creates three directories under the directory returned by `developerDirectory`, defaulting
to `~/Developer`. Use this convention for their contents:

```text
~/Developer/
  repos/
    github.com/
      GregBrimble/my-repo/          # primary checkout of your fork or repo
      some-org/my-repo/             # optional separate upstream checkout
    gitlab.example.com/group/repo/  # other hosts and nested groups work too
  worktrees/
    my-feature/                    # one task, possibly spanning several repos
      github.com/
        GregBrimble/my-repo/
        some-org/another-repo/
  tries/
    2026-10-31-some-experiment/
```

Primary checkouts are ordinary Git clones. Including the host and owner avoids
collisions between forks and between hosting services. Usually one clone with
`origin` pointing to your fork and `upstream` pointing to the original is enough;
keep both checkouts only when you want separate local repositories. For example:

```sh
git clone git@github.com:GregBrimble/my-repo.git \
  ~/Developer/repos/github.com/GregBrimble/my-repo
git -C ~/Developer/repos/github.com/GregBrimble/my-repo \
  remote add upstream https://github.com/some-org/my-repo.git
```

Worktrees are grouped by task first, then by the primary clone's host/owner/repo
identity. This lets a task contain worktrees from multiple repositories:

```sh
git -C ~/Developer/repos/github.com/GregBrimble/my-repo \
  worktree add -b my-feature \
  ~/Developer/worktrees/my-feature/github.com/GregBrimble/my-repo
```

Use `git worktree remove <path>` when finished; worktrees share Git metadata with
their primary clone. See [Git's worktree documentation](https://git-scm.com/docs/git-worktree).
The initializer creates the three parent directories and preserves their
contents. It does not move existing checkouts or create example repositories.

[`tobi/try`](https://github.com/tobi/try) is an optional browser and creator for
scratch experiments. It is not installed by this configuration. If you install
it, point its shell integration at `~/Developer/tries`. Its worktree command
creates detached checkouts in that experiments directory; use the task layout
above for work spanning repositories.

## Downloads cleanup

The Downloads component compiles a small Objective-C helper using Foundation's
[`NSBackgroundActivityScheduler`](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/SchedulingBackgroundActivity.html),
also used by Finder's Trash maintenance.
A user LaunchAgent starts the helper at login and keeps it running. The helper
registers a repeating activity with `checkIntervalHours` (24 by default) as its
suggested interval. macOS chooses when to run it based on energy usage and
system load, using the API's default tolerance and background quality of service.
The activity defers when macOS requests it. There is no exact firing time.

The helper is built with Apple's `xcrun clang`; the standard Homebrew installer
prepares Command Line Tools on a fresh Mac. If an existing installation lacks
them, install them with `xcode-select --install` before applying this component.
Source and its build fingerprint are kept beside `downloadsCleanup.helperPath`;
unchanged builds are reused, and a failed rebuild preserves the previous binary.
The helper uses only macOS libraries and tools at runtime.

Installation and reruns do not immediately clean Downloads. The helper and
changes to its configuration take effect at the next login. For a manual check,
run the helper with `--once` followed by the cleanup command and arguments from
its LaunchAgent plist; this performs cleanup immediately.

The activity invokes macOS's built-in `find` and `trash`. It moves top-level
regular files only when their creation, modification, and metadata-change times
are all more than `olderThanDays` days
old. This conservatively preserves newly created or recently changed downloads,
including files that retain an older modification date. Folders, symlinks,
hidden files, and `.download`, `.crdownload`, and `.part` files are skipped.
Files remain recoverable in Trash until macOS removes them. The default
`trash.removeAfter30Days: true` enables Finder's built-in automatic removal
after another 30 days in Trash, applying to all Trash items. Finder manages this
second stage in the background. The initializer writes its preference; it takes
effect when Finder next starts, normally at the next login.

The plist is stored at `downloadsCleanup.launchAgentPath`; output and errors go
to `downloadsCleanup.logPath`. If macOS denies Downloads access, check that log
and the Files & Folders permissions in System Settings.

## Git and VLC preferences

The Git component sets global `push.autoSetupRemote` while preserving other
settings and identities. Repository-specific Git settings can override globals.

The VLC component merges playback rate and subtitle language into
`~/Library/Preferences/org.videolan.vlc/vlcrc`, preserving unrelated sections,
comments and preferences. It removes conflicting subtitle-disable and numbered-track
overrides so language selection can work. `en,any` prefers English and then any
loaded track, including unnamed tracks; subtitle-file discovery keeps VLC's defaults.
Close VLC before changing its preferences so it cannot overwrite them on exit.
An already configured VLC needs no shutdown.

## Git signing

`git-signing-key` creates `~/.ssh/id_ed25519_signing` on each machine. It runs
Apple's `ssh-keygen` interactively: choose a passphrase in your terminal, then
enter it again for `ssh-add --apple-use-keychain` to save it in macOS Keychain.
Passphrases never enter the TypeScript config or command arguments. Key creation
requires a terminal and a working login SSH agent. Existing complete key pairs
are reused; incomplete or invalid pairs fail without being overwritten.

`git-signing` depends on that key being usable, then sets global `gpg.format=ssh`,
`user.signingkey`, `commit.gpgsign=true`, and `tag.gpgsign=true`. This switches an
existing global GPG signing selection to SSH. Git name/email and authentication
keys remain independently configured; repository-specific Git settings can
override these global defaults.

A small `gpg.ssh.program` helper in `~/Library/Application Support/new-machine-2026/`
checks the dedicated signing key before signing and reloads it with Apple's
`ssh-add --apple-use-keychain` when needed. That command retrieves its saved
passphrase from Keychain, so signing works after restart without first making an
SSH connection. A locked/missing Keychain item can still require interaction.
Verification does not load a key or access Keychain.

For local verification, `~/.ssh/git_allowed_signers` trusts this machine's public
key for any of your Git identities (`*` principal), while retaining other entries.
This verifies possession of your key; it does not enforce which email you use or
prove a human reviewed a commit. An unlocked agent permits unattended signing.

Register each machine's **public** key as a **Signing key** in
[GitHub's SSH key settings](https://github.com/settings/ssh/new). With GitHub CLI
installed and authenticated, the equivalent is:

```sh
gh auth refresh --hostname github.com --scopes write:ssh_signing_key
gh ssh-key add ~/.ssh/id_ed25519_signing.pub --type signing --title "$(scutil --get ComputerName) Git signing"
```

The initializer configures local signing; it does not log in to GitHub or upload
keys. Signing-key registration is separate from SSH authentication registration.
See [GitHub's SSH signing instructions](https://docs.github.com/en/authentication/managing-commit-signature-verification/telling-git-about-your-signing-key).
To enroll from the editable checkout, run:

```sh
/bin/bash bootstrap.sh --component git-signing
```

## Spotlight automation

macOS does not expose a supported folder-level CLI for Search Privacy. The
runner reports this state as `unknown` in its plan, then uses System Settings to
ensure each configured exclusion (the Developer directory and `/opt/homebrew` by default) during application. The folder picker
deduplicates repeated additions by path. Listed folders are created if missing;
existing exclusions are preserved. Removing a folder from the configuration does
not re-enable indexing: remove it from Search Privacy in System Settings.

The AppleScript targets **English System Settings on macOS Tahoe (26)**. Allow
your terminal to control System Events and System Settings under Privacy &
Security > Automation, and enable it under Privacy & Security > Accessibility.
If Accessibility is missing, the runner opens that settings page and waits up to
five minutes for you to grant it, then continues automatically. Leave System
Settings and the keyboard alone during this step. Missing controls,
denied permission, or an unaccepted folder fail the run. Verification happens
inside the picker automation; an independent folder-level state query is
unavailable.

## Zsh completions and updates

The bootstrap runs under Bash; it configures future zsh sessions in `.zshrc`.
It adds Homebrew's mise completion directory to `fpath` before existing shell
configuration, then initializes completion at the end only if `compdef` is not
already defined. Existing frameworks can initialize completion themselves.
mise's completion is explicitly registered, including when a prior completion
cache exists. Activation and completion entries use managed blocks that update on reruns;
legacy tagged activation entries are migrated;
other startup-file contents are preserved. No separate completion package is needed.

When `zoxide` is in the formula list, the same footer activates it after completion
initialization with `zoxide init zsh`, using the stable prefix reported by
Homebrew. [`zoxide`](https://github.com/ajeetdsouza/zoxide) learns visited directories
for `z <query>`; its optional interactive `zi` command needs `fzf` installed separately.

Update mise with `brew upgrade mise`; Node and other tools are still managed by
mise. Upstream notes that the Homebrew build can be larger and slower than its
optimized release binary, and package-manager releases can lag upstream. See
[mise installation methods](https://mise.jdx.dev/installing-mise.html).
