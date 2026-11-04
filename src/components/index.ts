import type { Machine } from "../machine.ts"
import type { Component } from "../runner.ts"
import type { System } from "../system.ts"
import * as appearance from "./appearance.ts"
import * as checkout from "./checkout.ts"
import * as developer from "./developer.ts"
import * as downloads from "./downloads.ts"
import * as git from "./git.ts"
import * as homebrew from "./homebrew.ts"
import * as rex from "./rex.ts"
import * as shell from "./shell.ts"
import * as signing from "./signing.ts"
import * as spotlight from "./spotlight.ts"
import * as trash from "./trash.ts"
import * as vlc from "./vlc.ts"

export function components(system: System, machine: Machine): ReadonlyArray<Component> {
  const component = (value: Component, dependencies: string[] = [], interaction: Component["interaction"] = []): Component => ({ ...value, dependencies, interaction })
  const packages = homebrew.settings(machine)
  const paths = shell.settings(machine)
  return [
    homebrew.homebrew(system, machine.brew),
    component(appearance.appearance(system, appearance.settings(machine)), [], ["automation"]),
    developer.developerDirectories(system, developer.developerDirectory(machine)),
    component(checkout.configurationCheckout(system, checkout.settings(machine)), ["homebrew", "developer-directories"]),
    component(shell.profileEntry(system, "Homebrew", paths.homebrewProfile, shell.homebrewLine(machine.brew)), ["homebrew"]),
    component(shell.profileEntry(system, "mise", paths.miseProfile, shell.miseLine(machine.mise)), ["homebrew"]),
    component(git.gitSettings(system, git.settings(machine).autoSetupRemote), ["homebrew"]),
    component(signing.gitSigningKey(system, signing.settings(machine)), ["homebrew"], ["terminal"]),
    component(signing.gitSigning(system, signing.settings(machine)), ["git-signing-key"]),
    component(homebrew.homebrewBundle(system, packages, machine.brew), ["homebrew"], ["terminal"]),
    component(rex.rex(system, rex.settings(machine), machine.brew), ["homebrew-bundle"], ["terminal"]),
    component(shell.zshCompletions(system, paths.miseProfile, machine.mise, machine.brew, packages.formulae.includes("zoxide")), ["mise", "homebrew-bundle"]),
    component(vlc.vlcSettings(system, vlc.settings(machine)), ["homebrew-bundle"]),
    component(downloads.downloadsCleanup(system, downloads.settings(machine)), ["homebrew"]),
    trash.trashSettings(system, trash.settings(machine).removeAfter30Days),
    component(spotlight.spotlight(system, spotlight.settings(machine)), ["homebrew", "developer-directories"], ["automation", "accessibility"])
  ]
}
