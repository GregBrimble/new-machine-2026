import type { Machine } from "../machine.ts"
import { Effect } from "effect"
import type { Component, Observation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export const settings = (_machine: Machine): "dark" | "light" => "dark"
const observation = (ok: boolean, detail: string): Observation => ({ status: ok ? "ok" : "change", detail })

export function appearance(system: System, desired: "dark" | "light"): Component {
  if (!["dark", "light"].includes(desired)) throw new Error("Appearance must be dark or light.")
  const read = () => Effect.gen(function* () {
    const dark = yield* checked(system, { file: "osascript", args: ["-e", "tell application \"System Events\" to tell appearance preferences to get dark mode"] })
    const automatic = yield* system.run({ file: "defaults", args: ["read", "-g", "AppleInterfaceStyleSwitchesAutomatically"] })
    if (dark !== "true" && dark !== "false") return yield* Effect.fail(new BootstrapError("Appearance", `Unexpected dark mode value: ${dark}`))
    // defaults returns 1 for an absent key, which means automatic switching is off.
    if (automatic.code !== 0 && !/does not exist|not found/iu.test(automatic.stderr)) {
      return yield* Effect.fail(new BootstrapError("Appearance", automatic.stderr || "Could not read automatic appearance."))
    }
    const auto = automatic.code === 0 ? automatic.stdout.trim() : "0"
    if (auto !== "0" && auto !== "1") return yield* Effect.fail(new BootstrapError("Appearance", `Unexpected automatic appearance value: ${auto}`))
    return { dark: dark === "true", automatic: auto === "1" }
  })
  const inspect = () => Effect.gen(function* () {
    const state = yield* read()
    return observation(state.dark === (desired === "dark") && !state.automatic, `${desired} appearance; automatic switching disabled`)
  })
  return {
    id: "appearance", description: `Ensure ${desired} appearance and disable automatic switching`, inspect,
    apply: () => Effect.gen(function* () {
      const state = yield* read()
      if (state.automatic) yield* checked(system, { file: "defaults", args: ["write", "-g", "AppleInterfaceStyleSwitchesAutomatically", "-bool", "false"] })
      if (state.dark !== (desired === "dark")) yield* checked(system, {
        file: "osascript", args: ["-e", `tell application "System Events" to tell appearance preferences to set dark mode to ${desired === "dark"}`]
      })
    })
  }
}
