import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { Effect, Exit } from "effect"
import { BootstrapError, checked, liveSystem } from "../src/system.ts"

const repo = fileURLToPath(new URL("../", import.meta.url))
const defaultImage = "ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640"
const stageTimeout = 90 * 60_000

export function options(args: string[]) {
  const { values } = parseArgs({ args, options: {
    local: { type: "boolean" }, attended: { type: "boolean" }, image: { type: "string", default: defaultImage },
    "ca-bundle": { type: "string" }, "private-cask": { type: "string" }, help: { type: "boolean", short: "h" }
  } })
  if (!values.image || values["ca-bundle"] === "" || values["private-cask"] === "") throw new Error("--image, --ca-bundle and --private-cask need a value")
  return { mode: values.local ? "local" : "published", image: values.image, attended: values.attended ?? false, caBundle: values["ca-bundle"], privateCask: values["private-cask"], help: values.help }
}

// One wait policy owns stage deadlines and checks process liveness on every poll.
function waitFor<A>(read: () => A | undefined, milliseconds: number, message: string) {
  return Effect.gen(function* () {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) {
      const value = yield* Effect.try({ try: read, catch: cause => new BootstrapError("VM test", cause) })
      if (value !== undefined) return value
      yield* Effect.sleep(1000)
    }
    return yield* Effect.fail(new BootstrapError("VM test", message))
  })
}

function processResource(file: string, args: string[], log: string) {
  return Effect.acquireRelease(Effect.sync(() => {
    const fd = openSync(log, "a")
    try {
      const child = spawn(file, args, { stdio: ["ignore", fd, fd] })
      let error: Error | undefined
      child.on("error", cause => { error = cause })
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()))
      return {
        child,
        assertRunning() {
          if (error) throw error
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${file} exited before the test finished; inspect ${log}`)
        },
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null || error) return
          child.kill("SIGTERM")
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
          try { await exited } finally { clearTimeout(timer) }
        }
      }
    } finally { closeSync(fd) }
  }), process => Effect.promise(() => process.stop()))
}

export function runVM(settings: ReturnType<typeof options>, env = process.env) {
  const system = liveSystem(env)
  const run = (file: string, args: string[] = []) => checked(system, { file, args })
  return Effect.scoped(Effect.gen(function* () {
    if (settings.caBundle) {
      const text = yield* system.readText(settings.caBundle)
      if (!text) return yield* Effect.fail(new BootstrapError("CA bundle", "CA bundle must be a readable PEM file."))
      if (text.includes("PRIVATE KEY")) return yield* Effect.fail(new BootstrapError("CA bundle", "CA bundle must not contain private keys."))
      const cert = yield* Effect.result(run("/usr/bin/openssl", ["x509", "-in", settings.caBundle, "-noout"]))
      if (cert._tag === "Failure") return yield* Effect.fail(new BootstrapError("CA bundle", "CA bundle must contain PEM certificates."))
    }
    if ((yield* run("uname", ["-s"])) !== "Darwin" || (yield* run("uname", ["-m"])) !== "arm64") {
      return yield* Effect.fail(new BootstrapError("VM test", "Requires an Apple Silicon Mac."))
    }
    const tartVersion = yield* run("tart", ["--version"])
    const cached = (yield* run("tart", ["list", "--quiet"])).split("\n").includes(settings.image)
    const requiredGiB = cached ? 30 : 60
    const available = Number((yield* run("df", ["-Pk", tmpdir()])).trim().split("\n").at(-1)!.split(/\s+/u)[3])
    if (!Number.isFinite(available) || available < requiredGiB * 1048576) {
      return yield* Effect.fail(new BootstrapError("VM test", `At least ${requiredGiB} GiB free is required for the image, VM, and installations.`))
    }
    const artifacts = mkdtempSync(join(tmpdir(), "new-machine-vm.")), input = join(artifacts, "input"), results = join(artifacts, "results")
    mkdirSync(input); mkdirSync(results)
    const vm = `new-machine-test-${randomUUID()}`
    let created = false
    yield* Effect.addFinalizer(exit => Effect.gen(function* () {
      rmSync(join(artifacts, "ssh-askpass"), { force: true })
      if (created && Exit.isSuccess(exit)) yield* run("tart", ["delete", vm])
      else if (created) console.error(`VM preserved for inspection: ${vm}\nDelete it when finished: tart delete ${vm}`)
      console.log(`Logs and results: ${results}`)
    }).pipe(Effect.orDie))
    yield* processResource("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], join(results, "caffeinate.log"))
    if (settings.caBundle) copyFileSync(settings.caBundle, join(input, "network-ca.pem"))
    // Decrypt on the host so its passphrase never enters the guest or VNC input.
    const privateCask = settings.privateCask
      ? yield* system.readText(settings.privateCask)
      : yield* run("age", ["--decrypt", join(repo, "private/rex.rb.age")])
    if (!privateCask) return yield* Effect.fail(new BootstrapError("VM test", "Private Rex cask must be readable and nonempty."))
    writeFileSync(join(input, "private-rex.rb"), privateCask, { mode: 0o600 })
    let python = ""
    if (!settings.attended) {
      yield* run("python3", ["-c", "import sys; sys.exit(sys.version_info < (3, 11))"])
      const hash = createHash("sha256").update(readFileSync(join(repo, "vm/requirements.txt"))).digest("hex")
      const version = (yield* run("python3", ["--version"])).replaceAll(" ", "-")
      const cache = join(env.XDG_CACHE_HOME ?? join(homedir(), "Library/Caches"), "new-machine-2026/vm-ui")
      const runtime = join(cache, `${version}-${hash}`)
      python = join(runtime, "bin/python")
      if (!existsSync(python)) yield* run("python3", ["-m", "venv", runtime])
      yield* run(python, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", join(repo, "vm/requirements.txt")])
      yield* run("xcrun", ["swiftc", "-module-cache-path", join(cache, "swift-modules"), join(repo, "vm/ocr.swift"), "-o", join(artifacts, "ocr")])
    }
    const snapshotFiles = ["bootstrap.sh", "package.json", "package-lock.json", ".node-version", "src", "vm", "scripts", "private"]
    yield* run("tar", ["-czf", join(input, "source.tar.gz"), "-C", repo, ...snapshotFiles])
    copyFileSync(join(repo, "vm/guest.command"), join(input, "start.command")); chmodSync(join(input, "start.command"), 0o755)
    writeFileSync(join(input, "mode"), `${settings.mode}\n`)
    writeFileSync(join(results, "image.txt"), `${settings.image}\n`)
    writeFileSync(join(results, "checkout-commit.txt"), `${yield* run("git", ["-C", repo, "rev-parse", "HEAD"])}\n`)
    writeFileSync(join(results, "checkout.diff"), yield* run("git", ["-C", repo, "diff", "HEAD", "--", ...snapshotFiles]))
    writeFileSync(join(results, "snapshot.sha256"), `${createHash("sha256").update(readFileSync(join(input, "source.tar.gz"))).digest("hex")}\n`)
    writeFileSync(join(results, "tart-version.txt"), `${tartVersion}\n`)
    console.log(`Cloning ${settings.image} into ${vm}`)
    // Retain a partial clone on failure for inspection.
    created = true
    yield* run("tart", ["clone", settings.image, vm])
    const boot = (stage: "first" | "after-login") => Effect.scoped(Effect.gen(function* () {
      const log = join(results, "tart-current.log")
      writeFileSync(log, "")
      // Finalizers run in reverse order: stop VM, wait for runner, collect logs.
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        appendFileSync(join(results, "tart.log"), readFileSync(log))
      }))
      const runner = yield* processResource("tart", ["run", vm, ...(settings.attended ? [] : ["--no-graphics", "--vnc-experimental"]), "--no-clipboard", "--no-audio", `--dir=bootstrap-input:${input}:ro`, `--dir=bootstrap-results:${results}`], log)
      yield* Effect.addFinalizer(() => run("tart", ["stop", vm]).pipe(Effect.ignore))
      console.log(`Results: ${results}`)
      let ui: { assertRunning(): void } | undefined
      if (settings.attended) {
        console.log("In the VM (admin/admin), open /Volumes/My Shared Files/bootstrap-input/start.command in Terminal.")
      } else {
        const endpoint = yield* waitFor(() => {
          runner.assertRunning()
          return /VNC server is running at (vnc:\S+)/u.exec(readFileSync(log, "utf8"))?.[1]
        }, 120_000, "Timed out waiting for the VM VNC endpoint.")
        if (stage === "first") {
          const address = yield* run("tart", ["ip", vm, "--wait", "120"])
          const askpass = join(artifacts, "ssh-askpass")
          writeFileSync(askpass, '#!/bin/sh\nprintf "%s\\n" admin\n', { mode: 0o700 })
          const ssh = liveSystem({ ...env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" })
          const deadline = Date.now() + 600_000
          while (true) {
            runner.assertRunning()
            const attempt = yield* ssh.run({ file: "ssh", args: ["-F", "/dev/null", "-T", "-o", "IdentityAgent=none", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1", "-o", "NumberOfPasswordPrompts=1", `admin@${address}`, "/usr/bin/open -a Terminal '/Volumes/My Shared Files/bootstrap-input/start.command'"] })
            writeFileSync(join(results, "guest-start.log"), attempt.stdout + attempt.stderr)
            if (attempt.code === 0) break
            if (Date.now() >= deadline) return yield* Effect.fail(new BootstrapError("VM test", "Timed out opening the guest test in Terminal; inspect guest-start.log."))
            yield* Effect.sleep(2000)
          }
          rmSync(askpass)
        }
        ui = yield* processResource(python, ["-B", join(repo, "vm/ui.py"), "--endpoint", endpoint, "--ocr", join(artifacts, "ocr"), "--results", results], join(results, "ui.log"))
      }
      const status = () => {
        runner.assertRunning()
        ui?.assertRunning()
        const state = existsSync(join(results, "status")) ? readFileSync(join(results, "status"), "utf8").trim() : ""
        if (state === "failed") throw new Error("Guest test failed; inspect its logs.")
        return state
      }
      if (!settings.attended && stage === "first") yield* waitFor(() => {
        status()
        return existsSync(join(results, "guest-first.log")) ? true : undefined
      }, 600_000, "The guest test did not start in Terminal within ten minutes.")
      const desired = stage === "first" ? "reboot-required" : "passed"
      yield* waitFor(() => status() === desired ? true : undefined, stageTimeout, "Timed out after 90 minutes waiting for the guest test.")
    }))
    yield* boot("first")
    console.log("First pass succeeded. Restarting the VM to check login startup.")
    yield* boot("after-login")
    console.log("VM smoke test passed, including repeat application and login startup.")
  }))
}
