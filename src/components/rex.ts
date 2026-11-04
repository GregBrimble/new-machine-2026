import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import type { Component } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export interface Rex { encryptedCask: string; localCask: string; executable: string }
export const settings = ({ home }: Machine): Rex => ({
  encryptedCask: fileURLToPath(new URL("../../private/rex.rb.age", import.meta.url)),
  localCask: join(home, "Library/Application Support/new-machine-2026/private/rex.rb"),
  executable: "/Applications/Rex Beta.app/Contents/MacOS/Rex"
})
const tap = "gregbrimble/new-machine-private"
const cask = `${tap}/rex`

export function rex(system: System, config: Rex, brew: string): Component {
  absolutePaths(config.encryptedCask, config.localCask, config.executable, brew)
  const inspect = () => Effect.gen(function* () {
    return { status: (yield* system.executable(config.executable)) ? "ok" as const : "change" as const, detail: "Install Rex from the encrypted private cask" }
  })
  return {
    id: "rex", description: "Install Rex from the encrypted private cask", inspect,
    apply: () => Effect.scoped(Effect.gen(function* () {
      const staged = yield* Effect.acquireRelease(
        checked(system, { file: "/usr/bin/mktemp", args: ["-t", "new-machine-rex"] }),
        path => system.run({ file: "/bin/rm", args: ["-f", "--", path] }).pipe(Effect.ignore)
      )
      // A local plaintext input lets unattended VM tests avoid sharing the passphrase.
      const local = yield* system.readText(config.localCask)
      if (local !== undefined) {
        if (!local.trim()) return yield* Effect.fail(new BootstrapError("Rex", "Local private cask is empty."))
        yield* system.writeText(staged, local)
      }
      else {
        const age = join(yield* checked(system, { file: brew, args: ["--prefix", "age"] }), "bin/age")
        const encrypted = yield* system.readText(config.encryptedCask)
        if (!encrypted) return yield* Effect.fail(new BootstrapError("Rex", "Missing private/rex.rb.age. Encrypt the private cask before installing Rex."))
        yield* checked(system, { file: age, args: ["--decrypt", "--output", staged], input: encrypted })
      }
      const repository = yield* checked(system, { file: brew, args: ["--repository", tap] })
      absolutePaths(repository)
      // A directory is enough for a local tap; no Git repository or remote is needed.
      const destination = join(repository, "Casks/rex.rb")
      yield* system.mkdir(dirname(destination))
      yield* checked(system, { file: "/bin/mv", args: ["-f", staged, destination] })
      yield* checked(system, { file: brew, args: ["trust", "--cask", cask] })
      yield* checked(system, { file: brew, args: ["install", "--cask", "--adopt", cask], interactive: true })
    }))
  }
}
