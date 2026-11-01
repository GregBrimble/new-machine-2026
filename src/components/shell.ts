import { dirname, join } from "node:path"
import { Effect } from "effect"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import type { Component, Observation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

const quote = (text: string) => /^[a-zA-Z0-9_/.+-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
const observation = (ok: boolean, detail: string): Observation => ({ status: ok ? "ok" : "change", detail })

export const settings = ({ zshDirectory }: Machine) => ({ homebrewProfile: join(zshDirectory, ".zprofile"), miseProfile: join(zshDirectory, ".zshrc") })
export const homebrewLine = (brew: string) => `eval "$(${quote(brew)} shellenv)"`
export const miseLine = (mise: string) => `eval "$(${quote(mise)} activate zsh)"`

export function managedBlock(original: string, name: string, content: string, position: "preserve" | "start" | "end" = "preserve"): string {
  const start = `# >>> new-machine-2026 ${name} >>>\n`, end = `# <<< new-machine-2026 ${name} <<<\n`
  const first = original.indexOf(start), last = original.indexOf(end)
  const block = `${start}${content}\n${end}`
  if (first !== -1 || last !== -1) {
    if (first === -1 || last < first || original.indexOf(start, first + 1) !== -1 || original.indexOf(end, last + 1) !== -1) {
      throw new Error(`Incomplete or duplicate managed ${name} block`)
    }
    if (position === "preserve") return original.slice(0, first) + block + original.slice(last + end.length)
    original = original.slice(0, first) + original.slice(last + end.length)
  }
  if (position === "start") return block + original
  return `${original}${!original || original.endsWith("\n") ? "" : "\n"}${block}`
}

export function profileEntry(system: System, id: string, path: string, line: string): Component {
  absolutePaths(path)
  const desired = () => Effect.gen(function* () {
    const current = (yield* system.readText(path)) ?? ""
    // Migrate only the tagged entries written by earlier initializer versions.
    const legacy = id === "Homebrew" ? /(^|\n)# Homebrew\r?\neval "\$\([^\n]+ shellenv\)"\r?\n/gu
      : /(^|\n)# mise\r?\neval "\$\([^\n]+ activate zsh\)"\r?\n/gu
    const next = yield* Effect.try({
      try: () => managedBlock(current.replace(legacy, "$1"), id, line),
      catch: cause => new BootstrapError(path, cause)
    })
    return { current, next }
  })
  const inspect = () => Effect.gen(function* () {
    const { current, next } = yield* desired()
    return observation(current === next, `Ensure ${id} in ${path}`)
  })
  return {
    id, description: `Configure ${id} in ${path}`, inspect,
    apply: () => Effect.gen(function* () {
      const { current, next } = yield* desired()
      if (current !== next) yield* system.writeText(path, next)
    })
  }
}

export function renderCompletions(original: string, directory: string, zoxideBin?: string): string {
  // fpath must precede a framework's compinit; initialize at the end only if needed.
  const header = `fpath=(${quote(directory)} $fpath)`
  const footer = `if (( ! $+functions[compdef] )); then\n  autoload -Uz compinit\n  compinit\nfi\nautoload -Uz _mise\ncompdef _mise mise${zoxideBin ? `\neval "$(${quote(zoxideBin)} init zsh)"` : ""}`
  return managedBlock(managedBlock(original, "zsh fpath", header, "start"), "zsh completion init", footer, "end")
}

export function zshCompletions(system: System, path: string, mise: string, brew: string, zoxide: boolean): Component {
  const directory = join(dirname(dirname(mise)), "share/zsh/site-functions")
  const completion = join(directory, "_mise")
  absolutePaths(path, mise, brew)
  const desired = () => Effect.gen(function* () {
    if (!(yield* system.readText(completion))) return yield* Effect.fail(new BootstrapError("zsh completions", `Missing ${completion}; repair mise with brew reinstall mise.`))
    const zoxideBin = zoxide ? join(yield* checked(system, { file: brew, args: ["--prefix", "zoxide"] }), "bin/zoxide") : undefined
    const current = (yield* system.readText(path)) ?? ""
    const next = yield* Effect.try({ try: () => renderCompletions(current, directory, zoxideBin), catch: cause => new BootstrapError("zsh completions", cause) })
    return { current, next }
  })
  const inspect = () => Effect.gen(function* () {
    const state = yield* desired()
    return observation(state.current === state.next, `Load Homebrew's mise completion${zoxide ? " and zoxide navigation" : ""} and initialize zsh in ${path}`)
  })
  return {
    id: "zsh-completions", description: `Configure zsh completions${zoxide ? " and zoxide navigation" : ""} in ${path}`, inspect,
    apply: () => Effect.gen(function* () {
      const state = yield* desired()
      if (state.current !== state.next) yield* system.writeText(path, state.next)
    })
  }
}
