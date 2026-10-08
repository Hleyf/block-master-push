import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const VERSION = "0.2.0"
const COMMIT = "bc5d48f"

const PROTECTED = new Set(["master", "main"])

const SAFE_OUTER_COMMANDS = new Set([
  "echo",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "tr",
  "cut",
  "paste",
  "sort",
  "uniq",
  "wc",
  "grep",
  "ls",
  "pwd",
  "date",
  "whoami",
  "id",
  "uname",
  "file",
  "df",
  "du",
  "diff",
  "comm",
  "cmp",
  "true",
  "false",
  "test",
  "tee",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "rmdir",
  "touch",
])

const CONFIG_ENV_VAR = "BLOCK_MASTER_PUSH_CONFIG"

function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(root, "opencode", "block-master-push.json")
}

type AllowList =
  | { ok: true; extra: Set<string> }
  | { ok: false; reason: string }

function loadUserAllowList(): AllowList {
  const path = process.env[CONFIG_ENV_VAR] || defaultConfigPath()
  if (!existsSync(path)) return { ok: true, extra: new Set() }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { ok: false, reason: `config file ${path} is malformed JSON` }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `config file ${path} is not a JSON object` }
  }

  const extra = (parsed as { additionalAllowedOuterCommands?: unknown })
    .additionalAllowedOuterCommands
  if (extra === undefined) return { ok: true, extra: new Set() }
  if (!Array.isArray(extra) || extra.some((entry) => typeof entry !== "string")) {
    return {
      ok: false,
      reason: `config key 'additionalAllowedOuterCommands' in ${path} must be an array of strings`,
    }
  }

  return { ok: true, extra: new Set(extra as string[]) }
}

export function getPluginStatus(): {
  active: boolean
  version: string
  commit: string
  reason?: string
} {
  if (process.env.BLOCK_MASTER_PUSH_DISABLED === "1") {
    return {
      active: false,
      version: VERSION,
      commit: COMMIT,
      reason: "BLOCK_MASTER_PUSH_DISABLED=1",
    }
  }
  return { active: true, version: VERSION, commit: COMMIT }
}

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

function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: false | '"' | "'" = false

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed.length > 0) segments.push(trimmed)
    current = ""
  }

  for (const ch of command) {
    if (quote) {
      current += ch
      if (ch === quote) quote = false
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      flush()
      continue
    }
    current += ch
  }
  flush()
  return segments
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function stripEnvPrefix(tokens: string[]): string {
  for (const token of tokens) {
    if (!ENV_ASSIGNMENT.test(token)) return token
  }
  return ""
}

function notAllowed(word: string): string {
  return `'${word}' is not in the allow-list of outer commands this gate can verify`
}

export function checkPushCommand(command: string): string | null {
  if (command.trim().length === 0) return null

  const allowList = loadUserAllowList()
  if (!allowList.ok) return allowList.reason

  const effective = new Set(SAFE_OUTER_COMMANDS)
  for (const extra of allowList.extra) effective.add(extra)

  for (const segment of splitSegments(command)) {
    const args = parseArgs(segment)
    const word = stripEnvPrefix(args)
    if (word.length === 0) continue

    if (word === "git") {
      const pushIdx = args.indexOf("push")
      if (pushIdx < 0) continue

      const pushArgs = args.slice(pushIdx)
      if (pushArgs.includes("--dry-run") || pushArgs.includes("-n")) continue

      const reason = isProtectedPush(pushArgs)
      if (reason) return reason
      continue
    }

    if (effective.has(word)) continue

    return notAllowed(word)
  }

  return null
}

export const BlockMasterPush: Plugin = async ({ client }) => {
  const loadStatus = getPluginStatus()
  console.log(
    `[block-master-push: ${loadStatus.active ? "ACTIVE" : "INACTIVE"}] ` +
      `v${loadStatus.version} @ ${loadStatus.commit}` +
      (loadStatus.reason ? ` (${loadStatus.reason})` : "") +
      ` — pushes to master/main are ${loadStatus.active ? "blocked" : "NOT blocked"}`
  )

  void client.tui.showToast({
    body: { message: "Main branch blocked", variant: "error" },
  }).catch(() => {})

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const status = getPluginStatus()
      if (status.active) {
        output.system.push(
          `[block-master-push: ACTIVE v${status.version}] — git push to master/main is blocked by an opencode plugin. Pivot work must go through a feature branch.`
        )
      } else {
        output.system.push(
          `[block-master-push: INACTIVE v${status.version}] — plugin is loaded but disabled (${status.reason ?? "unknown"}). Pushes to master/main are NOT blocked.`
        )
      }
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const cmd = output.args?.command
      if (typeof cmd !== "string") return

      const trimmed = cmd.trim()
      if (trimmed === "block-master-push status" || trimmed === "__bmp_status__") {
        const status = getPluginStatus()
        throw new Error(
          `[block-master-push: ${status.active ? "ACTIVE" : "INACTIVE"}] ` +
            `v${status.version} @ ${status.commit}` +
            (status.reason ? ` (${status.reason})` : "") +
            ` — pushes to master/main are ${status.active ? "blocked" : "NOT blocked"}`
        )
      }

      if (process.env.BLOCK_MASTER_PUSH_DISABLED === "1") return

      const reason = checkPushCommand(cmd)
      if (reason) {
        void client.tui.showToast({
          body: { message: reason, variant: "error" },
        }).catch(() => {})

        throw new Error(
          `Push to master/main blocked by opencode plugin: ${reason}. ` +
            `Use a feature branch and open a PR instead.`
        )
      }
    },
  }
}

export default BlockMasterPush
