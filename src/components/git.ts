import type { Machine } from "../machine.ts"
import { Effect } from "effect"
import type { Component } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export const settings = (_machine: Machine) => ({ autoSetupRemote: true })

export function gitSettings(system: System, autoSetupRemote: boolean): Component {
  if (typeof autoSetupRemote !== "boolean") throw new Error("Git autoSetupRemote must be a boolean.")
  const key = "push.autoSetupRemote"
  const value = String(autoSetupRemote)
  const inspect = () => Effect.gen(function* () {
    const result = yield* system.run({ file: "git", args: ["config", "--global", "--type=bool", "--get", key] })
    if (result.code !== 0 && result.code !== 1) return yield* Effect.fail(new BootstrapError("Git settings", result.stderr || `Exited with status ${result.code}`))
    return {
      status: result.code === 0 && result.stdout.trim() === value ? "ok" : "change",
      detail: `Global ${key}=${value}`
    } as const
  })
  return {
    id: "git-settings", description: `Set global Git ${key}=${value}`, inspect,
    apply: () => checked(system, { file: "git", args: ["config", "--global", "--type=bool", "--replace-all", key, value] }).pipe(Effect.asVoid)
  }
}
