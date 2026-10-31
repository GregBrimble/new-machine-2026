import { dirname } from "node:path"
import { Effect } from "effect"
import type { Configuration } from "../config.ts"
import type { Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

const remoteIdentity = (url: string) => url.replace(/^git@github\.com:/u, "https://github.com/").replace(/\/$/u, "").replace(/\.git$/u, "")

export function configurationCheckout(system: System, config: Configuration["checkout"]): Resource {
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
    }),
    verify: () => verifyObservation("configuration-checkout", inspect)
  }
}
