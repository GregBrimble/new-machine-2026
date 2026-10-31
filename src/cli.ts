import { parseArgs } from "node:util"
import type { Profile } from "./config.ts"
import type { Mode } from "./runner.ts"

export function options(args: ReadonlyArray<string>) {
  const { values } = parseArgs({ args: [...args], options: {
    "dry-run": { type: "boolean" }, plan: { type: "boolean" }, status: { type: "boolean" },
    json: { type: "boolean" }, component: { type: "string", multiple: true }, profile: { type: "string", default: "shared" }
  } })
  if ([values["dry-run"], values.plan, values.status].filter(Boolean).length > 1) throw new Error("Choose only one of --dry-run, --plan, and --status.")
  const profile = values.profile as Profile
  if (!["shared", "personal", "cloudflare"].includes(profile)) throw new Error("Choose profile shared, personal, or cloudflare.")
  const mode: Mode = values["dry-run"] ? "preview" : values.plan || values.status ? "plan" : "apply"
  return { mode, profile, components: values.component, json: values.json ?? false, failFast: !values.status && !values.json }
}
