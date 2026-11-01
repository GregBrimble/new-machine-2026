import { readBooleanPreference } from "../preferences.ts"
import type { Machine } from "../machine.ts"
import { Effect } from "effect"
import type { Component } from "../runner.ts"
import { checked } from "../system.ts"
import type { System } from "../system.ts"

export const settings = (_machine: Machine) => ({ removeAfter30Days: true })

export function trashSettings(system: System, enabled: boolean): Component {
  if (typeof enabled !== "boolean") throw new Error("Automatic Trash removal must be a boolean.")
  const inspect = () => Effect.gen(function* () {
    const current = (yield* readBooleanPreference(system, "com.apple.finder", "FXRemoveOldTrashItems")) ?? false
    return { status: current === enabled ? "ok" as const : "change" as const, detail: `Automatically remove items after 30 days in Trash: ${enabled}` }
  })
  return {
    id: "trash", description: `Set Finder's automatic removal after 30 days in Trash to ${enabled}`, inspect,
    apply: () => checked(system, { file: "defaults", args: ["write", "com.apple.finder", "FXRemoveOldTrashItems", "-bool", String(enabled)] }).pipe(Effect.asVoid)
  }
}
