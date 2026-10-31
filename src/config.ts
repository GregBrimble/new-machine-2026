import { isAbsolute, join } from "node:path"

export type Profile = "shared" | "personal" | "cloudflare"
export interface Cask { name: string; app: string; executable: string }
export interface Configuration {
  appearance: "dark" | "light"
  homebrewProfile: string
  miseProfile: string
  appDirectory: string
  casks: ReadonlyArray<Cask>
  spotlightExcludedFolders: ReadonlyArray<string>
}

// Edit the shared configuration here. Profile arrays add to the shared arrays.
export function configuration(home: string, env: NodeJS.ProcessEnv, profile: Profile): Configuration {
  const shared: Configuration = {
    appearance: "dark",
    homebrewProfile: join(env.ZDOTDIR || home, ".zprofile"),
    miseProfile: join(env.ZDOTDIR || home, ".zshrc"),
    appDirectory: "/Applications",
    casks: [
      { name: "ghostty", app: "Ghostty.app", executable: "Contents/MacOS/ghostty" },
      { name: "spotify", app: "Spotify.app", executable: "Contents/MacOS/Spotify" },
      { name: "vlc", app: "VLC.app", executable: "Contents/MacOS/VLC" },
      { name: "google-chrome", app: "Google Chrome.app", executable: "Contents/MacOS/Google Chrome" }
    ],
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
  for (const path of [config.homebrewProfile, config.miseProfile, config.appDirectory]) {
    if (!isAbsolute(path)) throw new Error(`Configured paths must be absolute: ${path}`)
  }
  for (const path of config.spotlightExcludedFolders) {
    if (!isAbsolute(path) || /^\/+$/u.test(path)) throw new Error(`Invalid Spotlight folder: ${path}`)
  }
  for (const cask of config.casks) {
    if (!/^[a-z0-9][a-z0-9+@._-]*$/u.test(cask.name) ||
        !/^[^/]+\.app$/u.test(cask.app) || !cask.executable || isAbsolute(cask.executable) ||
        cask.executable.split("/").includes("..")) throw new Error(`Invalid cask: ${cask.name}`)
  }
}
