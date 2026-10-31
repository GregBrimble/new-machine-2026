import { isAbsolute } from "node:path"
import { Effect } from "effect"
import { BootstrapError } from "./system.ts"
import type { System } from "./system.ts"

export function zshStartupDirectory(system: System): Effect.Effect<string, BootstrapError> {
  return Effect.gen(function* () {
    const result = yield* system.run({
      file: "/bin/zsh", args: ["-c", 'builtin printf "\\0%s\\0" "${ZDOTDIR-$HOME}"']
    })
    if (result.code !== 0) return yield* Effect.fail(new BootstrapError("zsh startup directory", result.stderr || `zsh exited with status ${result.code}`))
    // NUL delimiters preserve whitespace in paths and separate any .zshenv output.
    const parts = result.stdout.split("\0")
    const directory = parts[1] ?? ""
    if (parts.length !== 3 || parts[2] !== "" || !isAbsolute(directory)) {
      return yield* Effect.fail(new BootstrapError("zsh startup directory", "zsh did not report an absolute startup directory; check ZDOTDIR in .zshenv."))
    }
    return directory
  })
}
