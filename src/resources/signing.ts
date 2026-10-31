import { dirname } from "node:path"
import { Effect } from "effect"
import type { Configuration } from "../config.ts"
import type { Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

type Signing = Configuration["git"]["signing"]
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

function publicKey(system: System, path: string) {
  return Effect.gen(function* () {
    const text = yield* system.readText(`${path}.pub`)
    if (text === undefined) return undefined
    const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?\r?\n?$/u.exec(text)
    if (!match) return yield* Effect.fail(new BootstrapError("Git signing key", `Expected one Ed25519 public key in ${path}.pub; existing files were preserved.`))
    yield* checked(system, { file: "/usr/bin/ssh-keygen", args: ["-l", "-f", `${path}.pub`] })
    return `ssh-ed25519 ${match[1]}`
  })
}

function keyState(system: System, path: string) {
  return Effect.gen(function* () {
    // Test existence without reading private key material into the configurator.
    const exists = yield* system.run({ file: "/bin/test", args: ["-e", path] })
    if (exists.code !== 0 && exists.code !== 1) return yield* Effect.fail(new BootstrapError("Git signing key", "Could not inspect the private key path."))
    const key = yield* publicKey(system, path)
    if ((exists.code === 0) !== (key !== undefined)) return yield* Effect.fail(new BootstrapError(
      "Git signing key", `Incomplete key pair at ${path}. Restore its missing half before retrying; existing files will not be overwritten.`
    ))
    return key
  })
}

const usable = (system: System, path: string) => system.run({ file: "/usr/bin/ssh-add", args: ["-T", `${path}.pub`] })

export function gitSigningKey(system: System, config: Signing): Resource {
  const inspect = () => Effect.gen(function* () {
    const key = yield* keyState(system, config.keyPath)
    if (!key) return { status: "change", detail: `Create ${config.keyPath}; choose a passphrase in the terminal, then save it in macOS Keychain` } as const
    const agent = yield* usable(system, config.keyPath)
    return {
      status: agent.code === 0 ? "ok" : "change",
      detail: agent.code === 0 ? `Dedicated signing key available in ssh-agent: ${config.keyPath}.pub` : `Unlock ${config.keyPath} into ssh-agent using macOS Keychain; run repair in a logged-in terminal`
    } as const
  })
  return {
    id: "git-signing-key", description: "Prepare a dedicated Ed25519 Git signing key with macOS Keychain", inspect,
    apply: () => Effect.gen(function* () {
      const key = yield* keyState(system, config.keyPath)
      const agent = yield* system.run({ file: "/usr/bin/ssh-add", args: ["-l"] })
      if (agent.code !== 0 && agent.code !== 1) return yield* Effect.fail(new BootstrapError("Git signing key", "No usable ssh-agent. Run repair from your normal macOS login terminal."))
      if (!key) {
        const terminal = yield* system.run({ file: "/bin/test", args: ["-t", "0"], interactive: true })
        if (terminal.code !== 0) return yield* Effect.fail(new BootstrapError("Git signing key", "Key creation needs a terminal for its passphrase prompts. Run bootstrap.sh --component git-signing there."))
        yield* checked(system, { file: "/usr/bin/install", args: ["-d", "-m", "700", dirname(config.keyPath)] })
        yield* checked(system, {
          file: "/usr/bin/ssh-keygen", args: ["-t", "ed25519", "-C", "Git signing", "-f", config.keyPath], interactive: true
        })
      }
      yield* checked(system, { file: "/usr/bin/ssh-add", args: ["--apple-use-keychain", config.keyPath], interactive: true })
    }),
    verify: () => verifyObservation("git-signing-key", inspect)
  }
}

export function signingProgram(config: Signing): string {
  return `#!/bin/sh
set -eu
# Reload only this key, only when signing. Verification needs no agent or Keychain.
if [ "\${1-}" = -Y ] && [ "\${2-}" = sign ]; then
  if ! /usr/bin/ssh-add -T ${quote(`${config.keyPath}.pub`)} >/dev/null 2>&1; then
    /usr/bin/ssh-add --apple-use-keychain -q ${quote(config.keyPath)}
  fi
fi
exec /usr/bin/ssh-keygen "$@"
`
}

export function gitSigning(system: System, config: Signing): Resource {
  const settings = [
    ["gpg.format", "ssh"],
    ["user.signingkey", `${config.keyPath}.pub`],
    ["gpg.ssh.program", config.programPath],
    ["gpg.ssh.allowedSignersFile", config.allowedSignersPath],
    ["commit.gpgsign", "true"],
    ["tag.gpgsign", "true"]
  ] as const
  const desired = () => Effect.gen(function* () {
    const key = yield* keyState(system, config.keyPath)
    if (!key) return undefined
    const current = (yield* system.readText(config.allowedSignersPath)) ?? ""
    // Trust our own machine key for any of our Git identities; keep other trust entries.
    const entry = `* ${key}`
    const next = current.split(/\r?\n/u).includes(entry) ? current : `${current}${!current || current.endsWith("\n") ? "" : "\n"}${entry}\n`
    return { current, next }
  })
  const inspect = () => Effect.gen(function* () {
    const trust = yield* desired()
    let ok = !!trust && trust.current === trust.next &&
      (yield* system.readText(config.programPath)) === signingProgram(config) && (yield* system.executable(config.programPath))
    for (const [key, value] of settings) {
      const result = yield* system.run({ file: "git", args: ["config", "--global", "--get-all", key] })
      if (result.code !== 0 && result.code !== 1) return yield* Effect.fail(new BootstrapError("Git signing settings", result.stderr || `Could not read ${key}`))
      ok &&= result.code === 0 && result.stdout.trim() === value
    }
    return { status: ok ? "ok" : "change", detail: `SSH signing for commits and annotated tags, with local verification; register ${config.keyPath}.pub as a GitHub signing key` } as const
  })
  return {
    id: "git-signing", description: "Configure automatic SSH signing and local signature verification", inspect,
    apply: () => Effect.gen(function* () {
      const trust = yield* desired()
      if (!trust) return yield* Effect.fail(new BootstrapError("Git signing settings", "Repair git-signing-key first."))
      // Do not enable automatic signing until this public key can actually sign.
      yield* checked(system, { file: "/usr/bin/ssh-add", args: ["-T", `${config.keyPath}.pub`] })
      if (trust.current !== trust.next) yield* system.writeText(config.allowedSignersPath, trust.next)
      const program = signingProgram(config)
      if ((yield* system.readText(config.programPath)) !== program) yield* system.writeText(config.programPath, program)
      yield* checked(system, { file: "/bin/chmod", args: ["700", config.programPath] })
      for (const [key, value] of settings) yield* checked(system, { file: "git", args: ["config", "--global", "--replace-all", key, value] })
    }),
    verify: () => verifyObservation("git-signing", inspect)
  }
}
