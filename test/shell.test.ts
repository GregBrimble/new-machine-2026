import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { homebrewLine, managedBlock, miseLine, profileEntry, zshCompletions } from "../src/components/shell.ts"
import { runComponents } from "../src/runner.ts"
import { liveSystem } from "../src/system.ts"
import { executable, result, temporaryDirectory } from "./helpers.ts"

const run = (components: Parameters<typeof runComponents>[0]) => Effect.runPromise(runComponents(components, { mode: "apply", failFast: true }))

test("managed blocks replace content in place and preserve surrounding user text", () => {
  const text = managedBlock("# user configuration\n", "mise", "old command") + "# after\n"
  const updated = managedBlock(text, "mise", "new command")
  assert.equal(updated, text.replace("old command", "new command"))
  assert.equal(managedBlock(updated, "mise", "new command"), updated)
  for (const broken of ["# >>> new-machine-2026 mise >>>\n", text + text]) assert.throws(() => managedBlock(broken, "mise", "command"), /Incomplete|duplicate/u)
})

test("shell entries migrate tagged legacy commands and update executable paths", async t => {
  const root = temporaryDirectory(t, "new-machine-shell-"), path = join(root, ".zprofile")
  const system = liveSystem(process.env)
  writeFileSync(path, '# user\n\n# Homebrew\neval "$(/old/bin/brew shellenv)"\n# keep\n')
  await run([profileEntry(system, "Homebrew", path, homebrewLine("/new path/bin/brew"))])
  const first = readFileSync(path, "utf8")
  assert.ok(first.startsWith("# user\n\n# keep\n")); assert.ok(!first.includes("/old/"))
  await run([profileEntry(system, "Homebrew", path, homebrewLine("/newer/bin/brew"))])
  assert.equal(readFileSync(path, "utf8"), first.replace("'/new path/bin/brew'", "/newer/bin/brew"))
})

for (const framework of [false, true]) {
  test(`shell setup converges and loads completions with framework=${framework}`, async t => {
    const root = temporaryDirectory(t, "new-machine-completions-"), prefix = join(root, "prefix with 'quotes'")
    const mise = join(prefix, "bin/mise"), zoxide = join(prefix, "zoxide/bin/zoxide"), completion = join(prefix, "share/zsh/site-functions/_mise")
    for (const path of [mise, zoxide, completion]) mkdirSync(dirname(path), { recursive: true })
    executable(mise, "#!/bin/sh\nexit 0\n")
    executable(zoxide, "#!/bin/sh\nprintf 'typeset -g ZOXIDE_FIXTURE_LOADED=1\\n'\n")
    writeFileSync(completion, "#compdef mise\nreturn 0\n")
    const path = join(root, ".zshrc"), native = liveSystem(process.env)
    const system = { ...native, run: (command: Parameters<typeof native.run>[0]) => command.file === "/brew" ? Effect.succeed(result(dirname(dirname(zoxide)))) : native.run(command) }
    writeFileSync(path, framework ? 'autoload -Uz compinit\ncompinit\n[[ "${_comps[mise]}" == _mise ]] || return 23\ncompdef _files fixture-command\n' : "# user\n")
    const entries = [profileEntry(system, "mise", path, miseLine(mise)), zshCompletions(system, path, mise, "/brew", true)]
    await run(entries)
    const before = readFileSync(path, "utf8")
    const parsed = spawnSync("/bin/zsh", ["-f", "-c", 'source "$1" || exit; [[ "$ZOXIDE_FIXTURE_LOADED" == 1 ]] || exit 24; print -r -- "${_comps[mise]}"; print -r -- "${_comps[fixture-command]:-none}"', "zsh", path], { encoding: "utf8", timeout: 10000, env: { HOME: root, ZDOTDIR: root, PATH: "/usr/bin:/bin" } })
    assert.equal(parsed.status, 0, parsed.stderr); assert.equal(parsed.stderr, "")
    assert.equal(parsed.stdout, framework ? "_mise\n_files\n" : "_mise\nnone\n")
    await run(entries); assert.equal(readFileSync(path, "utf8"), before)
  })
}
