import { isAbsolute } from "node:path"

export type Profile = "shared" | "personal" | "cloudflare"
export interface Machine {
  home: string
  zshDirectory: string
  profile: Profile
  brew: string
  mise: string
}

export function absolutePaths(...paths: string[]): void {
  for (const path of paths) if (!isAbsolute(path)) throw new Error(`Configured paths must be absolute: ${path}`)
}
