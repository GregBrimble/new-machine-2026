import { join } from "node:path"
import { Effect } from "effect"
import type { Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import type { System } from "../system.ts"

export function developerDirectories(system: System, root: string): Resource {
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
    }),
    verify: () => verifyObservation("developer-directories", inspect)
  }
}
