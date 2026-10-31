import { Effect, Result } from "effect"
import { BootstrapError } from "./system.ts"

export interface Observation { status: "ok" | "change" | "unknown"; detail: string }
export interface Resource {
  id: string
  description: string
  dependencies?: ReadonlyArray<string>
  interaction?: ReadonlyArray<"terminal" | "automation" | "accessibility">
  inspect(): Effect.Effect<Observation, BootstrapError>
  apply(): Effect.Effect<void, BootstrapError>
  verify(): Effect.Effect<Observation | void, BootstrapError>
}
export type Mode = "apply" | "plan" | "preview"

export interface ComponentState {
  id: string
  description: string
  dependencies: ReadonlyArray<string>
  interaction: NonNullable<Resource["interaction"]>
  phase: "idle" | "inspecting" | "observed" | "applying" | "verifying" | "done"
  status: Observation["status"] | "pending" | "error" | "blocked"
  detail: string
  repaired: boolean
}
export type ComponentEvent = { type: "component"; component: ComponentState }

export interface RunOptions {
  mode: Mode
  components?: ReadonlyArray<string>
  onEvent?: (event: ComponentEvent) => void
  failFast?: boolean
}

function selectResources(resources: ReadonlyArray<Resource>, options: RunOptions): ReadonlyArray<Resource> {
  const catalog = new Map<string, Resource>()
  for (const resource of resources) {
    if (catalog.has(resource.id)) throw new Error(`Duplicate component: ${resource.id}`)
    catalog.set(resource.id, resource)
  }
  const ordered: Resource[] = [], visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    const resource = catalog.get(id)
    if (!resource) throw new Error(`Unknown component: ${id}`)
    if (visiting.has(id)) throw new Error(`Component dependency cycle: ${id}`)
    visiting.add(id)
    for (const dependency of resource.dependencies ?? []) visit(dependency)
    visiting.delete(id); visited.add(id); ordered.push(resource)
  }
  // Validate the whole catalog before any resource is inspected or changed.
  for (const id of catalog.keys()) visit(id)
  if (!options.components?.length) return ordered
  const selected = new Set<string>()
  const include = (id: string) => {
    if (selected.has(id)) return
    const resource = catalog.get(id)
    if (!resource) throw new Error(`Unknown component: ${id}`)
    selected.add(id)
    if (options.mode !== "plan") for (const dependency of resource.dependencies ?? []) include(dependency)
  }
  for (const id of options.components) include(id)
  return ordered.filter(resource => selected.has(resource.id))
}

// The UI and CLI share this engine. Each emitted snapshot is JSON serializable.
export function runComponents(resources: ReadonlyArray<Resource>, options: RunOptions) {
  return Effect.gen(function* () {
    const selected = yield* Effect.try({ try: () => selectResources(resources, options), catch: cause => new BootstrapError("Components", cause) })
    const states = new Map<string, ComponentState>()
    const publish = (state: ComponentState) => {
      states.set(state.id, state)
      options.onEvent?.({ type: "component", component: state })
    }
    for (const resource of selected) publish({
      id: resource.id, description: resource.description,
      dependencies: resource.dependencies ?? [], interaction: resource.interaction ?? [],
      phase: "idle", status: "pending", detail: resource.description, repaired: false
    })
    for (const resource of selected) {
      let state = states.get(resource.id)!
      if (options.mode === "preview") { publish({ ...state, phase: "done" }); continue }
      const failed = (resource.dependencies ?? []).filter(id => ["error", "blocked"].includes(states.get(id)?.status ?? ""))
      if (options.mode === "apply" && failed.length) {
        publish({ ...state, phase: "done", status: "blocked", detail: `Repair blocked by: ${failed.join(", ")}` })
        continue
      }
      const outcome = yield* Effect.result(Effect.gen(function* () {
        state = { ...state, phase: "inspecting" }; publish(state)
        const observed = yield* resource.inspect()
        state = { ...state, ...observed, phase: "observed" }; publish(state)
        if (options.mode === "plan" || observed.status === "ok") { publish({ ...state, phase: "done" }); return }
        state = { ...state, phase: "applying" }; publish(state)
        yield* resource.apply()
        state = { ...state, phase: "verifying" }; publish(state)
        const verified = yield* resource.verify()
        publish({ ...state, phase: "done", status: verified?.status ?? (observed.status === "unknown" ? "unknown" : "ok"), detail: verified?.detail ?? state.detail, repaired: true })
      }))
      if (Result.isFailure(outcome)) {
        publish({ ...state, phase: "done", status: "error", detail: outcome.failure.message })
        if (options.failFast) return yield* Effect.fail(outcome.failure)
      }
    }
    return [...states.values()]
  })
}

export function reconcile(resources: ReadonlyArray<Resource>, mode: Mode, log: (text: string) => void) {
  return runComponents(resources, { mode, failFast: true, onEvent: event => logComponent(event, mode, log) })
}

export function logComponent({ component: state }: ComponentEvent, mode: Mode, log: (text: string) => void) {
  if (mode === "preview" && state.phase === "done") log(`[preview] ${state.description}`)
  else if (state.phase === "done" && state.repaired) log(`[applied] ${state.id}`)
  else if (state.phase === "observed" || (state.phase === "done" && ["error", "blocked"].includes(state.status))) log(`[${state.status}] ${state.id}: ${state.detail}`)
}

export function verifyObservation(id: string, inspect: () => Effect.Effect<Observation, BootstrapError>) {
  return Effect.gen(function* () {
    const result = yield* inspect()
    if (result.status !== "ok") yield* Effect.fail(new BootstrapError(id, `Verification failed: ${result.detail}`))
    return result
  })
}
