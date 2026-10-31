import { Effect } from "effect"
import { BootstrapError } from "./system.ts"

export interface Observation { status: "ok" | "change" | "unknown"; detail: string }
export interface Resource {
  id: string
  description: string
  inspect(): Effect.Effect<Observation, BootstrapError>
  apply(): Effect.Effect<void, BootstrapError>
  verify(): Effect.Effect<void, BootstrapError>
}
export type Mode = "apply" | "plan" | "preview"

export function reconcile(resources: ReadonlyArray<Resource>, mode: Mode, log: (text: string) => void) {
  return Effect.gen(function* () {
    for (const resource of resources) {
      if (mode === "preview") {
        yield* Effect.sync(() => log(`[preview] ${resource.description}`))
        continue
      }
      const observed = yield* resource.inspect()
      yield* Effect.sync(() => log(`[${observed.status}] ${resource.id}: ${observed.detail}`))
      if (mode === "plan" || observed.status === "ok") continue
      yield* resource.apply()
      yield* resource.verify()
      yield* Effect.sync(() => log(`[applied] ${resource.id}`))
    }
  })
}

export function verifyObservation(id: string, inspect: () => Effect.Effect<Observation, BootstrapError>) {
  return Effect.gen(function* () {
    const result = yield* inspect()
    if (result.status !== "ok") yield* Effect.fail(new BootstrapError(id, `Verification failed: ${result.detail}`))
  })
}
