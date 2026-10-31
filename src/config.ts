import { isAbsolute, join } from "node:path"

export type Profile = "shared" | "personal" | "cloudflare"
export interface Configuration {
  appearance: "dark" | "light"
  homebrewProfile: string
  miseProfile: string
  casks: ReadonlyArray<string>
  git: { autoSetupRemote: boolean }
  vlc: { configPath: string; playbackRate: number; subtitleLanguage: string }
  spotlightExcludedFolders: ReadonlyArray<string>
}

// Edit the shared configuration here. Profile arrays add to the shared arrays.
export function configuration(home: string, zshDirectory: string, profile: Profile): Configuration {
  const shared: Configuration = {
    appearance: "dark",
    homebrewProfile: join(zshDirectory, ".zprofile"),
    miseProfile: join(zshDirectory, ".zshrc"),
    casks: ["ghostty", "spotify", "vlc", "google-chrome"],
    git: { autoSetupRemote: true },
    vlc: {
      configPath: join(home, "Library/Preferences/org.videolan.vlc/vlcrc"),
      playbackRate: 2.35,
      subtitleLanguage: "en,any"
    },
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
    casks: [...shared.casks, ...(extra.casks ?? [])],
    spotlightExcludedFolders: [...new Set([...shared.spotlightExcludedFolders, ...(extra.spotlightExcludedFolders ?? [])])]
  }
}

export function validateConfiguration(config: Configuration): void {
  if (!["dark", "light"].includes(config.appearance)) throw new Error("Appearance must be dark or light.")
  for (const path of [config.homebrewProfile, config.miseProfile, config.vlc.configPath]) {
    if (!isAbsolute(path)) throw new Error(`Configured paths must be absolute: ${path}`)
  }
  if (typeof config.git.autoSetupRemote !== "boolean") throw new Error("Git autoSetupRemote must be a boolean.")
  if (!Number.isFinite(config.vlc.playbackRate) || config.vlc.playbackRate <= 0) throw new Error("VLC playback rate must be positive and finite.")
  if (!/^[a-z]+(?:,[a-z]+)*$/iu.test(config.vlc.subtitleLanguage)) throw new Error("VLC subtitle languages must be comma-separated language names or codes.")
  for (const path of config.spotlightExcludedFolders) {
    if (!isAbsolute(path) || /^\/+$/u.test(path)) throw new Error(`Invalid Spotlight folder: ${path}`)
  }
  for (const cask of config.casks) {
    if (!/^[a-z0-9][a-z0-9+@._-]*$/u.test(cask)) throw new Error(`Invalid cask: ${cask}`)
  }
}
