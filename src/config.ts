import { isAbsolute, join } from "node:path"

export type Profile = "shared" | "personal" | "cloudflare"
export interface Configuration {
  appearance: "dark" | "light"
  homebrewProfile: string
  miseProfile: string
  developerDirectory: string
  checkout: { directory: string; remote: string }
  formulae: ReadonlyArray<string>
  casks: ReadonlyArray<string>
  git: {
    autoSetupRemote: boolean
    signing: { keyPath: string; allowedSignersPath: string; programPath: string }
  }
  vlc: { configPath: string; playbackRate: number; subtitleLanguage: string }
  downloadsCleanup: { directory: string; olderThanDays: number; checkIntervalHours: number; helperPath: string; launchAgentPath: string; logPath: string }
  trash: { removeAfter30Days: boolean }
  spotlightExcludedFolders: ReadonlyArray<string>
}

// Edit the shared configuration here. Profile arrays add to the shared arrays.
export function configuration(home: string, zshDirectory: string, profile: Profile): Configuration {
  const shared: Configuration = {
    appearance: "dark",
    homebrewProfile: join(zshDirectory, ".zprofile"),
    miseProfile: join(zshDirectory, ".zshrc"),
    developerDirectory: join(home, "Developer"),
    checkout: {
      directory: join(home, "Developer/repos/github.com/GregBrimble/new-machine-2026"),
      remote: "https://github.com/GregBrimble/new-machine-2026.git"
    },
    formulae: ["container", "zoxide"],
    casks: ["ghostty", "spotify", "vlc", "google-chrome"],
    git: {
      autoSetupRemote: true,
      signing: {
        keyPath: join(home, ".ssh/id_ed25519_signing"),
        allowedSignersPath: join(home, ".ssh/git_allowed_signers"),
        programPath: join(home, "Library/Application Support/new-machine-2026/git-ssh-sign")
      }
    },
    vlc: {
      configPath: join(home, "Library/Preferences/org.videolan.vlc/vlcrc"),
      playbackRate: 2.35,
      subtitleLanguage: "en,any"
    },
    downloadsCleanup: {
      directory: join(home, "Downloads"),
      olderThanDays: 30,
      checkIntervalHours: 24,
      helperPath: join(home, "Library/Application Support/new-machine-2026/downloads-cleanup"),
      launchAgentPath: join(home, "Library/LaunchAgents/com.gregbrimble.new-machine-2026.downloads-cleanup.plist"),
      logPath: join(home, "Library/Logs/new-machine-2026-downloads-cleanup.log")
    },
    trash: { removeAfter30Days: true },
    spotlightExcludedFolders: [join(home, "Developer"), "/opt/homebrew"]
  }
  const profiles: Record<Exclude<Profile, "shared">, Partial<Configuration>> = {
    personal: {},
    cloudflare: {}
  }
  const extra = profile === "shared" ? {} : profiles[profile]
  return {
    ...shared,
    ...extra,
    formulae: [...shared.formulae, ...(extra.formulae ?? [])],
    casks: [...shared.casks, ...(extra.casks ?? [])],
    spotlightExcludedFolders: [...new Set([...shared.spotlightExcludedFolders, ...(extra.spotlightExcludedFolders ?? [])])]
  }
}

export function validateConfiguration(config: Configuration): void {
  if (!["dark", "light"].includes(config.appearance)) throw new Error("Appearance must be dark or light.")
  for (const path of [config.homebrewProfile, config.miseProfile, config.developerDirectory, config.checkout.directory, config.vlc.configPath,
    ...Object.values(config.git.signing),
    config.downloadsCleanup.directory, config.downloadsCleanup.helperPath, config.downloadsCleanup.launchAgentPath, config.downloadsCleanup.logPath]) {
    if (!isAbsolute(path)) throw new Error(`Configured paths must be absolute: ${path}`)
  }
  if (!config.checkout.remote || config.checkout.remote.startsWith("-") || /[\r\n\0]/u.test(config.checkout.remote)) throw new Error("Checkout remote must be a Git URL or path.")
  if (typeof config.git.autoSetupRemote !== "boolean") throw new Error("Git autoSetupRemote must be a boolean.")
  const signingPaths = Object.values(config.git.signing)
  if (signingPaths.some(path => /[\r\n\0]/u.test(path)) || new Set([...signingPaths, `${config.git.signing.keyPath}.pub`]).size !== 4) {
    throw new Error("Git signing paths must be distinct and contain no line breaks or NULs.")
  }
  if (!Number.isFinite(config.vlc.playbackRate) || config.vlc.playbackRate <= 0) throw new Error("VLC playback rate must be positive and finite.")
  if (!/^[a-z]+(?:,[a-z]+)*$/iu.test(config.vlc.subtitleLanguage)) throw new Error("VLC subtitle languages must be comma-separated language names or codes.")
  if (!Number.isSafeInteger(config.downloadsCleanup.olderThanDays) || config.downloadsCleanup.olderThanDays <= 0) throw new Error("Downloads cleanup age must be a positive whole number of days.")
  if (!Number.isSafeInteger(config.downloadsCleanup.checkIntervalHours * 3600) || config.downloadsCleanup.checkIntervalHours < 1) throw new Error("Downloads cleanup interval must be at least one hour and resolve to a safe whole number of seconds.")
  if (join(config.downloadsCleanup.directory) === "/") throw new Error("Downloads cleanup cannot target the filesystem root.")
  if (typeof config.trash.removeAfter30Days !== "boolean") throw new Error("Automatic Trash removal must be a boolean.")
  for (const path of config.spotlightExcludedFolders) {
    if (!isAbsolute(path) || /^\/+$/u.test(path)) throw new Error(`Invalid Spotlight folder: ${path}`)
  }
  for (const [kind, names] of [["formula", config.formulae], ["cask", config.casks]] as const) {
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9+@._-]*$/u.test(name)) throw new Error(`Invalid ${kind}: ${name}`)
    }
  }
}
