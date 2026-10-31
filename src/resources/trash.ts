import { Effect } from "effect"
import type { Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export function trashSettings(system: System, enabled: boolean): Resource {
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
    apply: () => checked(system, { file: "defaults", args: ["write", "com.apple.finder", "FXRemoveOldTrashItems", "-bool", String(enabled)] }).pipe(Effect.asVoid),
    verify: () => verifyObservation("trash", inspect)
  }
}
