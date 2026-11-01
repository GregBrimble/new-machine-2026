import { join } from "node:path"
import { Effect } from "effect"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import type { Component } from "../runner.ts"
import type { System } from "../system.ts"

export const developerDirectory = ({ home }: Machine) => join(home, "Developer")

export function developerDirectories(system: System, root: string): Component {
  absolutePaths(root)
  const paths = ["repos", "worktrees", "tries"].map(name => join(root, name))
  const inspect = () => Effect.gen(function* () {
    const missing: string[] = []
    for (const path of paths) if (!(yield* system.directory(path))) missing.push(path)
    return { status: missing.length ? "change" as const : "ok" as const, detail: missing.length ? `Create ${missing.join(", ")}` : `Directory layout exists in ${root}` }
  })
  return {
    id: "developer-directories", description: `Create repos, worktrees, and tries directories in ${root}`, inspect,
    apply: () => Effect.gen(function* () {
      for (const path of paths) yield* system.mkdir(path)
    })
  }
}
