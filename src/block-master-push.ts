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

function destinationsOf(args: string[]): string[] {
  const positional: string[] = []
  for (const a of args) if (!a.startsWith("-")) positional.push(a)
  if (positional.length < 2) return []
  const refs = positional.slice(1)
  const destinations: string[] = []
  for (const ref of refs) {
    if (ref.includes(":")) {
      const dst = ref.split(":", 2)[1]
      if (dst) destinations.push(dst)
    } else {
      destinations.push(ref)
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

export function checkPushCommand(command: string): string | null {
  const trimmed = command.trim()
  const match = trimmed.match(/^git\s+push\b\s*(.*)$/)
  if (!match) return null
  if (/(^|\s)(--dry-run|-n)(\s|$)/.test(match[1])) return null
  return isProtectedPush(parseArgs(match[1]))
}

export default (async () => {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: { command?: unknown; [k: string]: unknown }; metadata: unknown }
    ) => {
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
