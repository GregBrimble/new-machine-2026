import type { Machine } from "../machine.ts"
import { Effect } from "effect"
import type { Component } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export const settings = (_machine: Machine) => ({ removeAfter30Days: true })

export function trashSettings(system: System, enabled: boolean): Component {
  if (typeof enabled !== "boolean") throw new Error("Automatic Trash removal must be a boolean.")
  const inspect = () => Effect.gen(function* () {
    const result = yield* system.run({ file: "defaults", args: ["read", "com.apple.finder", "FXRemoveOldTrashItems"] })
    let current = false
    if (result.code === 0) {
      const value = result.stdout.trim()
      if (value !== "0" && value !== "1") return yield* Effect.fail(new BootstrapError("Trash settings", `Unexpected boolean: ${value}`))
      current = value === "1"
    } else if (!/does not exist|not found/iu.test(result.stderr)) {
      return yield* Effect.fail(new BootstrapError("Trash settings", result.stderr || `defaults exited with status ${result.code}`))
    }
    return { status: current === enabled ? "ok" as const : "change" as const, detail: `Automatically remove items after 30 days in Trash: ${enabled}` }
  })
  return {
    id: "trash", description: `Set Finder's automatic removal after 30 days in Trash to ${enabled}`, inspect,
    apply: () => checked(system, { file: "defaults", args: ["write", "com.apple.finder", "FXRemoveOldTrashItems", "-bool", String(enabled)] }).pipe(Effect.asVoid)
  }
}
