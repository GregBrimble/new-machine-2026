import { Effect, Schema } from "effect"
import { BootstrapError, checked } from "./system.ts"
import type { System } from "./system.ts"

const booleanPreference = Schema.fromJsonString(Schema.NullOr(Schema.Struct({ value: Schema.Boolean })))
const readPreference = `
ObjC.import("Foundation")
function run(args) {
  const domain = $.NSUserDefaults.standardUserDefaults.persistentDomainForName(args[0])
  const value = domain.isNil() ? domain : domain.objectForKey(args[1])
  return JSON.stringify(value.isNil() ? null : { value: ObjC.deepUnwrap(value) })
}
`

// Read the named domain without registered defaults or Boolean coercion.
// https://developer.apple.com/documentation/foundation/userdefaults/persistentdomain(forname:)
export function readBooleanPreference(system: System, domain: string, key: string) {
  return checked(system, {
    file: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", readPreference, domain, key]
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(booleanPreference)),
    Effect.map(decoded => decoded?.value ?? null),
    Effect.mapError(cause => new BootstrapError(`Read ${domain}.${key}`, cause))
  )
}
