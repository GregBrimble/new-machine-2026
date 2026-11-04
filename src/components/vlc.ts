import { Effect } from "effect"
import { Ini, IniSection } from "ini-api"
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

function editPreferences(text: string, config: Vlc): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const document = new Ini(text.slice(bom.length))
  const sections = document.sections.filter(section => section.name === "core")
  const core = sections[0] ?? document.addSection("core")
  const desired = new Map([["rate", String(config.playbackRate)], ["sub-language", config.subtitleLanguage]])
  const defaults = new Map([["spu", 1], ["sub-track", -1], ["sub-track-id", -1]])
  const seen = new Set<string>()
  for (const section of sections) {
    section.lines = section.lines.filter(line => {
      if (!line.key) return true
      // Remove conflicting overrides so VLC enables subtitles and selects by language.
      const fallback = defaults.get(line.key)
      if (fallback !== undefined) return Number(line.value) === fallback
      const value = desired.get(line.key)
      if (value === undefined) return true
      if (seen.has(line.key)) return false
      seen.add(line.key)
      const equal = line.key === "rate" ? Number(line.value) === config.playbackRate : line.value === value
      // VLC treats quotes and inline comment markers as literal value text.
      if (!equal) line.value = value
      line.comment = ""
      return true
    })
  }
  const additions = new IniSection()
  for (const [key, value] of desired) if (!seen.has(key)) additions.setValue(key, value)
  // Insert before trailing blank lines, retaining the file's existing newline convention.
  core.lines.splice(core.lines.findLastIndex(line => line.text !== "") + 1, 0, ...additions.lines)
  if (additions.lines.length && document.sections.at(-1) === core && core.lines.at(-1)?.text !== "") core.addLine("")
  return bom + document.stringify()
}

export function vlcSettings(system: System, config: Vlc): Component {
  absolutePaths(config.configPath)
  if (!Number.isFinite(config.playbackRate) || config.playbackRate <= 0) throw new Error("VLC playback rate must be positive and finite.")
  if (!/^[a-z]+(?:,[a-z]+)*$/iu.test(config.subtitleLanguage)) throw new Error("VLC subtitle languages must be comma-separated language names or codes.")
  const state = () => Effect.gen(function* () {
    const current = (yield* system.readText(config.configPath)) ?? ""
    const next = yield* Effect.try({ try: () => editPreferences(current, config), catch: cause => new BootstrapError("VLC preferences", cause) })
    return { current, next }
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
