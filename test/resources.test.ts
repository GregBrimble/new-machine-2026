import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { configuration, validateConfiguration } from "../src/config.ts"
import { resources } from "../src/resources/index.ts"
import { reconcile } from "../src/runner.ts"
import type { Mode } from "../src/runner.ts"
import type { Command, CommandResult, System } from "../src/system.ts"

function fixture(mise = "/mise with 'quotes'/bin/mise") {
  const config = configuration("/Users/test person", "/Users/test person", "shared")
  const brew = "/prefix with spaces/bin/brew"
  const completion = join(dirname(dirname(mise)), "share/zsh/site-functions/_mise")
  const files = new Map<string, string>([[completion, "#compdef mise\nreturn 0\n"]])
  const directories = new Set<string>()
  const executables = new Set<string>()
  const excluded = new Set<string>()
  const writes: string[] = [], commands: Command[] = [], logs: string[] = []
  const state = {
    dark: false, automatic: true, absentAutomatic: false, brew: true,
    casks: new Set<string>(),
    autoSetupRemote: undefined as boolean | undefined,
    removeOldTrashItems: false,
    installFailure: false, ineffectiveCask: false, checkFailure: false,
    ineffectiveAppearance: false, deniedSpotlight: false, invalidDefaults: false, rootAlias: false
  }
  let reads = 0
  const result = (stdout = "", code = 0, stderr = ""): CommandResult => ({ stdout, code, stderr })
  const system: System = {
    run: command => Effect.sync(() => {
      commands.push(command)
      const args = command.args
      if (command.file === "/usr/bin/xcrun") {
        assert.equal(args[0], "clang")
        executables.add(args.at(-1)!); writes.push("compile-helper"); return result()
      }
      if (command.file === `${config.downloadsCleanup.helperPath}.next`) {
        assert.deepEqual(args, ["--help"])
        assert.ok(executables.has(command.file)); return result()
      }
      if (command.file === "/bin/mv") {
        assert.deepEqual(args, ["-f", `${config.downloadsCleanup.helperPath}.next`, config.downloadsCleanup.helperPath])
        executables.delete(args[1]); executables.add(args[2]); writes.push("install-helper"); return result()
      }
      if (command.file === "git") {
        assert.equal(args[0], "config")
        assert.equal(args[1], "--global")
        assert.equal(args[2], "--type=bool")
        assert.equal(args[4], "push.autoSetupRemote")
        if (args[3] === "--get") return state.autoSetupRemote === undefined ? result("", 1) : result(String(state.autoSetupRemote))
        assert.equal(args[3], "--replace-all")
        state.autoSetupRemote = args[5] === "true"; writes.push("git"); return result()
      }
      if (command.file === "pgrep") {
        assert.deepEqual(args, ["-x", "VLC"])
        return result("", 1)
      }
      if (command.file === "osascript") {
        if (args[0] === "-") {
          assert.match(command.input ?? "", /on run folderPaths/u)
          if (state.deniedSpotlight) return result("", 1, "Enable Accessibility for your terminal")
          for (const path of args.slice(1)) if (!excluded.has(path)) { excluded.add(path); writes.push(`exclude:${path}`) }
          return result()
        }
        if (args[1].includes("get dark mode")) return result(String(state.dark))
        if (!state.ineffectiveAppearance) { state.dark = args[1].endsWith("true"); writes.push("appearance") }
        return result()
      }
      if (command.file === "defaults") {
        if (args[1] === "com.apple.finder") {
          assert.equal(args[2], "FXRemoveOldTrashItems")
          if (args[0] === "read") return result(state.removeOldTrashItems ? "1" : "0")
          assert.deepEqual(args.slice(3), ["-bool", "true"])
          state.removeOldTrashItems = true; writes.push("trash"); return result()
        }
        if (args[0] === "read") {
          if (state.invalidDefaults) return result("", 1, "Permission denied")
          if (state.absentAutomatic) return result("", 1, "The domain/default pair does not exist")
          return result(state.automatic ? "1" : "0")
        }
        state.automatic = false; writes.push("automatic"); return result()
      }
      if (command.file === brew) {
        assert.equal(state.brew, true)
        if (args[0] === "--version") return result("Homebrew fixture")
        assert.equal(args[0], "bundle")
        assert.deepEqual(args.slice(2), ["--no-upgrade", "--file=-"])
        assert.equal(command.input, config.casks.map(name => `cask "${name}"\n`).join(""))
        if (args[1] === "check") {
          if (state.checkFailure) return result("", 2, "Bundle check failed")
          return result("", config.casks.every(name => state.casks.has(name)) ? 0 : 1)
        }
        assert.equal(args[1], "install")
        assert.equal(command.interactive, true)
        if (state.installFailure) return result("", 1, "Cask installation failed")
        if (!state.ineffectiveCask) {
          for (const name of config.casks) if (!state.casks.has(name)) {
            state.casks.add(name)
            writes.push(`cask:${name}`)
          }
        }
        return result()
      }
      throw new Error(`Unexpected command: ${command.file} ${args.join(" ")}`)
    }),
    executable: path => Effect.sync(() => { reads++; return path === brew ? state.brew : executables.has(path) }),
    readText: path => Effect.sync(() => { reads++; return files.get(path) }),
    writeText: (path, text) => Effect.sync(() => { files.set(path, text); writes.push(`profile:${path}`) }),
    mkdir: path => Effect.sync(() => { if (!directories.has(path)) { directories.add(path); writes.push(`mkdir:${path}`) } }),
    realpath: path => Effect.sync(() => state.rootAlias ? "/" : path)
  }
  const run = (mode: Mode = "apply") => Effect.runPromise(reconcile(resources(system, config, { brew, mise }), mode, text => logs.push(text)))
  return { config, state, files, completion, directories, excluded, writes, commands, logs, run, reads: () => reads }
}

test("fresh application converges; repeated application preserves installations and profile bytes", async () => {
  const f = fixture()
  f.files.set(f.config.homebrewProfile, "# existing content without a final newline")
  await f.run()
  assert.equal(f.state.dark, true)
  assert.equal(f.state.automatic, false)
  assert.equal(f.state.brew, true)
  assert.equal(f.state.autoSetupRemote, true)
  assert.equal(f.state.removeOldTrashItems, true)
  assert.equal(f.files.get(f.config.vlc.configPath), "[core]\nrate=2.35\nsub-language=en,any\n")
  assert.deepEqual([...f.state.casks], f.config.casks)
  assert.equal(f.commands.filter(c => c.args[0] === "bundle" && c.args[1] === "install").length, 1)
  assert.deepEqual([...f.excluded], f.config.spotlightExcludedFolders)
  assert.match(f.files.get(f.config.homebrewProfile)!, /^# existing content without a final newline\n/u)
  for (const profile of [f.config.homebrewProfile, f.config.miseProfile]) {
    const parsed = spawnSync("/bin/zsh", ["-n"], { input: f.files.get(profile), encoding: "utf8" })
    assert.equal(parsed.status, 0, parsed.stderr)
  }
  const before = [...f.files]
  f.writes.length = 0; f.commands.length = 0
  await f.run()
  assert.deepEqual(f.writes, [])
  assert.deepEqual([...f.files], before)
  assert.equal(f.commands.some(c => c.file === "curl" || c.args.includes("install")), false)
})

test("preview does not query system state; plan observes without applying changes or opening Search Privacy", async () => {
  const f = fixture()
  await f.run("preview")
  assert.equal(f.commands.length, 0)
  assert.equal(f.reads(), 0)
  assert.deepEqual(f.writes, [])
  await f.run("plan")
  assert.deepEqual(f.writes, [])
  assert.equal(f.commands.some(c => c.args[0] === "-"), false)
  assert.ok(f.logs.some(line => line.includes("[unknown] spotlight")))
})

test("satisfied Bundle skips installation and leaves unrelated casks installed", async () => {
  const f = fixture()
  for (const name of [...f.config.casks, "another-app"]) f.state.casks.add(name)
  await f.run()
  assert.equal(f.commands.some(c => c.args.includes("install")), false)
  assert.ok(f.state.casks.has("another-app"))
})

test("partially satisfied Bundle installs missing casks and verifies the result", async () => {
  const f = fixture()
  f.state.casks.add("ghostty")
  await f.run()
  assert.deepEqual([...f.state.casks], f.config.casks)
  assert.equal(f.writes.includes("cask:ghostty"), false)
  assert.ok(f.writes.includes("cask:spotify"))
  const bundle = f.commands.filter(c => c.args[0] === "bundle")
  assert.deepEqual(bundle.map(c => c.args[1]), ["check", "install", "check"])
})

test("empty cask list needs no installation", async () => {
  const f = fixture(); f.config.casks = []
  await f.run()
  assert.equal(f.commands.some(c => c.args.includes("install")), false)
})

test("a Bundle check error stops installation", async () => {
  const f = fixture(); f.state.checkFailure = true
  await assert.rejects(f.run(), /Bundle check failed/u)
  assert.equal(f.commands.some(c => c.args.includes("install")), false)
  assert.equal(f.files.has(f.config.vlc.configPath), false)
})

test("an absent automatic appearance key means switching is disabled", async () => {
  const f = fixture()
  f.state.absentAutomatic = true; f.state.dark = true
  await f.run()
  assert.equal(f.writes.includes("automatic"), false)
  assert.equal(f.writes.includes("appearance"), false)
})

for (const failure of ["ineffectiveAppearance", "invalidDefaults"] as const) {
  test(`${failure} stops dependent changes`, async () => {
    const f = fixture(); f.state[failure] = true
    await assert.rejects(f.run())
    assert.equal(f.state.casks.size, 0)
    assert.equal(f.files.has(f.config.homebrewProfile), false)
    assert.equal(f.excluded.size, 0)
  })
}

test("missing Homebrew fails before machine configuration is changed", async () => {
  const f = fixture(); f.state.brew = false
  await assert.rejects(f.run(), /bootstrap.sh/u)
  assert.deepEqual(f.writes, [])
})

test("zsh loads mise completions in a fresh shell and alongside an existing compinit setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "new-machine-zsh-"))
  const mise = join(root, "prefix with 'quotes'", "bin/mise")
  try {
    for (const framework of [false, true]) {
      const f = fixture(mise)
      if (framework) f.files.set(f.config.miseProfile,
        'autoload -Uz compinit\ncompinit\n[[ "${_comps[mise]}" == _mise ]] || return 23\ncompdef _files fixture-command\n')
      await f.run()
      mkdirSync(dirname(mise), { recursive: true })
      writeFileSync(mise, "#!/bin/sh\nexit 0\n"); chmodSync(mise, 0o755)
      mkdirSync(dirname(f.completion), { recursive: true })
      writeFileSync(f.completion, f.files.get(f.completion)!)
      const profile = join(root, "zshrc")
      writeFileSync(profile, f.files.get(f.config.miseProfile)!)
      const result = spawnSync("/bin/zsh", ["-f", "-c",
        'source "$1" || exit; print -r -- "${_comps[mise]}"; print -r -- "${_comps[fixture-command]:-none}"', "zsh", profile], {
        encoding: "utf8", timeout: 10000, env: { HOME: root, ZDOTDIR: root, PATH: "/usr/bin:/bin" }
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, "")
      assert.equal(result.stdout, framework ? "_mise\n_files\n" : "_mise\nnone\n")
      const before = f.files.get(f.config.miseProfile)
      await f.run()
      assert.equal(f.files.get(f.config.miseProfile), before)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const failure of ["installFailure", "ineffectiveCask"] as const) {
  test(`${failure} is not reported as a successful cask installation`, async () => {
    const f = fixture(); f.state.brew = true; f.state[failure] = true
    await assert.rejects(f.run())
    assert.equal(f.excluded.size, 0)
    assert.equal(f.logs.includes("[applied] casks"), false)
    assert.equal(f.files.has(f.config.vlc.configPath), false)
  })
}

test("denied Accessibility is surfaced without reporting Spotlight success", async () => {
  const f = fixture(); f.state.deniedSpotlight = true
  await assert.rejects(f.run(), /Accessibility/u)
  assert.equal(f.excluded.size, 0)
  assert.equal(f.logs.includes("[applied] spotlight"), false)
})

test("empty exclusion list skips Spotlight automation; existing exclusions are preserved", async () => {
  const f = fixture()
  f.config.spotlightExcludedFolders = []
  f.excluded.add("/existing exclusion")
  await f.run()
  assert.deepEqual([...f.excluded], ["/existing exclusion"])
  assert.equal(f.commands.some(c => c.args[0] === "-"), false)
  assert.equal(f.directories.has("/Users/test person/Developer"), false)
})

test("a configured folder resolving to filesystem root fails before exclusion", async () => {
  const f = fixture(); f.state.rootAlias = true
  await assert.rejects(f.run(), /filesystem root/u)
  assert.equal(f.excluded.size, 0)
})

test("light appearance is supported", async () => {
  const f = fixture(); f.state.dark = true; f.config.appearance = "light"
  await f.run()
  assert.equal(f.state.dark, false)
})

test("profiles share the base and use the resolved zsh directory; invalid exclusions fail validation", () => {
  for (const profile of ["shared", "personal", "cloudflare"] as const) {
    const config = configuration("/Users/test", "/Users/test/zsh config", profile)
    assert.equal(config.homebrewProfile, "/Users/test/zsh config/.zprofile")
    assert.equal(config.miseProfile, "/Users/test/zsh config/.zshrc")
    validateConfiguration(config)
    config.spotlightExcludedFolders = ["/"]
    assert.throws(() => validateConfiguration(config), /Spotlight/u)
  }
})

test("cask names must be safe to embed in a Brewfile", () => {
  const config = configuration("/Users/test", "/Users/test", "shared")
  for (const name of ['ghostty"\nsystem "unexpected"', "#{1 + 1}", "--force", "vlc\n"]) {
    config.casks = [name]
    assert.throws(() => validateConfiguration(config), /Invalid cask/u)
  }
})
