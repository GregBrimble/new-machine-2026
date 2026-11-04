import { Effect } from "effect"
import { options, runVM } from "./driver.ts"

try {
  const settings = options(process.argv.slice(2))
  if (settings.help) console.log(`Usage: npm run test:vm -- [--local] [--attended] [--image <Tart image>] [--ca-bundle <PEM file>] [--private-cask <Ruby file>]

Tests the published bootstrap in a disposable macOS VM, then repeats and restarts it.
--local tests this checkout. --attended leaves guest interaction to you.
Decrypts Rex on the host before starting the VM; --private-cask uses an already decrypted cask.
Requires Apple Silicon, Tart, age, Node and npm dependencies; unattended mode also
requires Python 3.11+ and Swift tools. Keeps failed VMs and deletes successful ones.`)
  else {
    const controller = new AbortController()
    process.once("SIGINT", () => { process.exitCode = 130; controller.abort() })
    process.once("SIGTERM", () => { process.exitCode = 143; controller.abort() })
    await Effect.runPromise(runVM(settings), { signal: controller.signal })
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode ||= 1
}
