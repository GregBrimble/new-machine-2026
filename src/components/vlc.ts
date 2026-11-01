import { Effect } from "effect"
import { join } from "node:path"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import type { Component } from "../runner.ts"
import { BootstrapError } from "../system.ts"
import type { System } from "../system.ts"

export interface Vlc { configPath: string; playbackRate: number; subtitleLanguage: string }
export const settings = ({ home }: Machine): Vlc => ({
  configPath: join(home, "Library/Preferences/org.videolan.vlc/vlcrc"), playbackRate: 2.35, subtitleLanguage: "en,any"
})


function mergeSettings(text: string, config: Vlc): string {
  const desired = new Map([["rate", String(config.playbackRate)], ["sub-language", config.subtitleLanguage]])
  // Remove conflicting overrides so VLC's defaults enable subtitles and select by language.
  const automatic = new Map([["spu", 1], ["sub-track", -1], ["sub-track-id", -1]])
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const output: string[] = [], seen = new Set<string>()
  let core = false, foundCore = false
  const append = (line: string) => {
    if (output.length && !output.at(-1)?.endsWith("\n")) output.push(newline)
    output.push(line + newline)
  }
  const missing = () => {
    for (const [key, value] of desired) if (!seen.has(key)) { append(`${key}=${value}`); seen.add(key) }
  }
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const line = raw.replace(/^\uFEFF/u, "").replace(/\r?\n$/u, "")
    const section = line.match(/^\[([^\]]+)\]/u)
    if (section) {
      if (core) missing()
      core = section[1] === "core"
      foundCore ||= core
    } else if (core) {
      const setting = line.match(/^([^=]+)=(.*)$/u)
      if (setting) {
        const [, key, value] = setting
        if (automatic.has(key) && Number(value) !== automatic.get(key)) continue
        const wanted = desired.get(key)
        if (wanted !== undefined) {
          if (seen.has(key)) continue
          seen.add(key)
          const equal = key === "rate" ? Number(value) === config.playbackRate : value === wanted
          const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : ""
          output.push(equal ? raw : `${key}=${wanted}${ending}`)
          continue
        }
      }
    }
    output.push(raw)
  }
  if (!foundCore) { append("[core]"); core = true }
  if (core) missing()
  return output.join("")
}

export function vlcSettings(system: System, config: Vlc): Component {
  absolutePaths(config.configPath)
  if (!Number.isFinite(config.playbackRate) || config.playbackRate <= 0) throw new Error("VLC playback rate must be positive and finite.")
  if (!/^[a-z]+(?:,[a-z]+)*$/iu.test(config.subtitleLanguage)) throw new Error("VLC subtitle languages must be comma-separated language names or codes.")
  const state = () => Effect.gen(function* () {
    const current = (yield* system.readText(config.configPath)) ?? ""
    return { current, next: mergeSettings(current, config) }
  })
  const inspect = () => Effect.gen(function* () {
    const { current, next } = yield* state()
    return { status: current === next ? "ok" : "change", detail: `${config.playbackRate}× playback; subtitle preference ${config.subtitleLanguage}` } as const
  })
  return {
    id: "vlc-settings", description: `Configure VLC: ${config.playbackRate}× playback; subtitles ${config.subtitleLanguage}`, inspect,
    apply: () => Effect.gen(function* () {
      const running = yield* system.run({ file: "pgrep", args: ["-x", "VLC"] })
      if (running.code === 0) return yield* Effect.fail(new BootstrapError("VLC settings", "Close VLC and rerun so it cannot overwrite the updated preferences on exit."))
      if (running.code !== 1) return yield* Effect.fail(new BootstrapError("VLC settings", running.stderr || "Could not check whether VLC is running."))
      const { current, next } = yield* state()
      if (current !== next) yield* system.writeText(config.configPath, next)
    })
  }
}
