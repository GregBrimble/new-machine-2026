import { dirname, join } from "node:path"
import { Effect } from "effect"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import { developerDirectory } from "./developer.ts"
import type { Component } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export interface Checkout { directory: string; remote: string }
export const settings = (machine: Machine): Checkout => ({
  directory: join(developerDirectory(machine), "repos/github.com/GregBrimble/new-machine-2026"),
  remote: "https://github.com/GregBrimble/new-machine-2026.git"
})

const remoteIdentity = (url: string) => url.replace(/^git@github\.com:/u, "https://github.com/").replace(/\/$/u, "").replace(/\.git$/u, "")

export function configurationCheckout(system: System, config: Checkout): Component {
  absolutePaths(config.directory)
  if (!config.remote || config.remote.startsWith("-") || /[\r\n\0]/u.test(config.remote)) throw new Error("Checkout remote must be a Git URL or path.")
  const inspect = () => Effect.gen(function* () {
    if (!(yield* system.directory(config.directory))) return { status: "change", detail: `Clone ${config.remote} into ${config.directory}` } as const
    const root = yield* checked(system, { file: "git", args: ["-C", config.directory, "rev-parse", "--show-toplevel"] })
    if ((yield* system.realpath(root)) !== (yield* system.realpath(config.directory))) {
      return yield* Effect.fail(new BootstrapError("Configuration checkout", `${config.directory} is inside another repository; choose an empty checkout location.`))
    }
    const origin = yield* checked(system, { file: "git", args: ["-C", config.directory, "config", "--get", "remote.origin.url"] })
    if (remoteIdentity(origin) !== remoteIdentity(config.remote)) {
      return yield* Effect.fail(new BootstrapError("Configuration checkout", `Preserving ${config.directory}: its origin is ${origin}, expected ${config.remote}.`))
    }
    return { status: "ok", detail: `Editable checkout at ${config.directory}; existing branch and changes preserved` } as const
  })
  return {
    id: "configuration-checkout", description: `Keep an editable configuration checkout at ${config.directory}`, inspect,
    apply: () => Effect.gen(function* () {
      yield* system.mkdir(dirname(config.directory))
      yield* checked(system, { file: "git", args: ["clone", "--", config.remote, config.directory] })
    })
  }
}
