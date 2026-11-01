import { Effect, Result } from "effect"
import { BootstrapError } from "./system.ts"

export interface Observation { status: "ok" | "change" | "unknown"; detail: string }
export interface Component {
  id: string
  description: string
  dependencies?: ReadonlyArray<string>
  interaction?: ReadonlyArray<"terminal" | "automation" | "accessibility">
  inspect(): Effect.Effect<Observation, BootstrapError>
  apply(): Effect.Effect<void, BootstrapError>
  verify?(): Effect.Effect<Observation | void, BootstrapError>
}
export type Mode = "apply" | "plan" | "preview"

export interface ComponentState {
  id: string
  description: string
  dependencies: ReadonlyArray<string>
  interaction: NonNullable<Component["interaction"]>
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

function selectComponents(components: ReadonlyArray<Component>, options: RunOptions): ReadonlyArray<Component> {
  const catalog = new Map<string, Component>()
  for (const component of components) {
    if (catalog.has(component.id)) throw new Error(`Duplicate component: ${component.id}`)
    catalog.set(component.id, component)
  }
  const ordered: Component[] = [], visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    const component = catalog.get(id)
    if (!component) throw new Error(`Unknown component: ${id}`)
    if (visiting.has(id)) throw new Error(`Component dependency cycle: ${id}`)
    visiting.add(id)
    for (const dependency of component.dependencies ?? []) visit(dependency)
    visiting.delete(id); visited.add(id); ordered.push(component)
  }
  // Validate the whole catalog before any component is inspected or changed.
  for (const id of catalog.keys()) visit(id)
  if (!options.components?.length) return ordered
  const selected = new Set<string>()
  const include = (id: string) => {
    if (selected.has(id)) return
    const component = catalog.get(id)
    if (!component) throw new Error(`Unknown component: ${id}`)
    selected.add(id)
    if (options.mode !== "plan") for (const dependency of component.dependencies ?? []) include(dependency)
  }
  for (const id of options.components) include(id)
  return ordered.filter(component => selected.has(component.id))
}

// The UI and CLI share this engine. Each emitted snapshot is JSON serializable.
export function runComponents(components: ReadonlyArray<Component>, options: RunOptions) {
  return Effect.gen(function* () {
    const selected = yield* Effect.try({ try: () => selectComponents(components, options), catch: cause => new BootstrapError("Components", cause) })
    const states = new Map<string, ComponentState>()
    const publish = (state: ComponentState) => {
      states.set(state.id, state)
      options.onEvent?.({ type: "component", component: state })
    }
    for (const component of selected) publish({
      id: component.id, description: component.description,
      dependencies: component.dependencies ?? [], interaction: component.interaction ?? [],
      phase: "idle", status: "pending", detail: component.description, repaired: false
    })
    for (const component of selected) {
      let state = states.get(component.id)!
      if (options.mode === "preview") { publish({ ...state, phase: "done" }); continue }
      const failed = (component.dependencies ?? []).filter(id => ["error", "blocked"].includes(states.get(id)?.status ?? ""))
      if (options.mode === "apply" && failed.length) {
        publish({ ...state, phase: "done", status: "blocked", detail: `Repair blocked by: ${failed.join(", ")}` })
        continue
      }
      const outcome = yield* Effect.result(Effect.gen(function* () {
        state = { ...state, phase: "inspecting" }; publish(state)
        const observed = yield* component.inspect()
        state = { ...state, ...observed, phase: "observed" }; publish(state)
        if (options.mode === "plan" || observed.status === "ok") { publish({ ...state, phase: "done" }); return }
        state = { ...state, phase: "applying" }; publish(state)
        yield* component.apply()
        state = { ...state, phase: "verifying" }; publish(state)
        const verified = yield* (component.verify ? component.verify() : verifyObservation(component.id, component.inspect))
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

export function logComponent({ component: state }: ComponentEvent, mode: Mode, log: (text: string) => void) {
  if (mode === "preview" && state.phase === "done") log(`[preview] ${state.description}`)
  else if (state.phase === "done" && state.repaired) log(`[applied] ${state.id}`)
  else if (state.phase === "observed" || (state.phase === "done" && ["error", "blocked"].includes(state.status))) log(`[${state.status}] ${state.id}: ${state.detail}`)
}

function verifyObservation(id: string, inspect: () => Effect.Effect<Observation, BootstrapError>) {
  return Effect.gen(function* () {
    const result = yield* inspect()
    if (result.status !== "ok") yield* Effect.fail(new BootstrapError(id, `Verification failed: ${result.detail}`))
    return result
  })
}
