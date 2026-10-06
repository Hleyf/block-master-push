import type { Plugin } from "@opencode-ai/plugin"

const PROTECTED = new Set(["master", "main"])

export function parseArgs(input: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: false | '"' | "'" = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = false
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        out.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) out.push(current)
  return out
}

function normaliseRef(ref: string): string {
  let r = ref
  if (r.startsWith("+")) r = r.slice(1)
  if (r.startsWith("refs/heads/")) r = r.slice("refs/heads/".length)
  return r.toLowerCase()
}

function destinationsOf(args: string[]): string[] {
  const positional: string[] = []
  for (const a of args) if (!a.startsWith("-")) positional.push(a)
  if (positional.length < 2) return []
  const refs = positional.slice(1)
  const destinations: string[] = []
  for (const ref of refs) {
    if (ref.includes(":")) {
      const parts = ref.split(":", 2)
      const src = parts[0]
      const dst = parts[1]
      const effective = dst || src
      if (effective) destinations.push(normaliseRef(effective))
    } else {
      destinations.push(normaliseRef(ref))
    }
  }
  return destinations
}

export function isProtectedPush(args: string[]): string | null {
  if (args.includes("--all") || args.includes("--mirror")) {
    return "--all / --mirror pushes every ref, including master/main"
  }
  for (const dst of destinationsOf(args)) {
    if (PROTECTED.has(dst)) return `destination ref '${dst}' is protected`
  }
  return null
}

const GIT_PUSH_REGEX =
  /(^|[;&|(]\s|\(\s)\s*\bgit\b(?:\s+(?:-c\s+\S+|-C\s+\S+|--\S+(?:=\S+)?|-\S+))*\s+\bpush\b/g

export function checkPushCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  const matches = [...trimmed.matchAll(GIT_PUSH_REGEX)]
  if (matches.length === 0) return null

  for (const match of matches) {
    const matchStart = match.index! + match[1].length
    const args = parseArgs(trimmed.slice(matchStart))
    if (args.length < 2 || args[0] !== "git") continue

    const pushIdx = args.indexOf("push")
    if (pushIdx < 0) continue

    const pushArgs = args.slice(pushIdx)
    if (pushArgs.includes("--dry-run") || pushArgs.includes("-n")) continue

    const reason = isProtectedPush(pushArgs)
    if (reason) return reason
  }

  return null
}

export default (async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const cmd = output.args?.command
      if (typeof cmd !== "string") return
      const reason = checkPushCommand(cmd)
      if (reason) {
        throw new Error(
          `Push to master/main blocked by opencode plugin: ${reason}. ` +
            `Use a feature branch and open a PR instead.`
        )
      }
    },
  }
}) satisfies Plugin
