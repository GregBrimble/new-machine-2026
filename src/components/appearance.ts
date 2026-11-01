import { Effect, Schema } from "effect"
import { readBooleanPreference } from "../preferences.ts"
import type { Machine } from "../machine.ts"
import type { Component, Observation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

const Appearance = Schema.Literals(["dark", "light"])
type Appearance = typeof Appearance.Type
const darkMode = Schema.fromJsonString(Schema.Boolean)

export const settings = (_machine: Machine): Appearance => "dark"
const observation = (ok: boolean, detail: string): Observation => ({ status: ok ? "ok" : "change", detail })

export function appearance(system: System, desired: Appearance): Component {
  Schema.decodeUnknownSync(Appearance)(desired)
  const read = () => Effect.gen(function* () {
    const dark = yield* checked(system, {
      file: "osascript", args: ["-e", "tell application \"System Events\" to tell appearance preferences to get dark mode"]
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(darkMode)))
    const automatic = yield* readBooleanPreference(system, "NSGlobalDomain", "AppleInterfaceStyleSwitchesAutomatically")
    return { dark, automatic: automatic ?? false }
  }).pipe(Effect.mapError(cause => new BootstrapError("Appearance", cause)))
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
