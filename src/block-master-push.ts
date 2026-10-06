import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Strategy: strict outer allow-list (pivot from the bash-grammar detector).
//
// After five iterations of modelling bash grammar, every round closed
// bypasses in one corner and opened them in another: aliases, sourced
// scripts, env-var prefixes, versioned interpreter names, alternate shells,
// wrapper chains. Bash has no finite grammar, so there is no state in which
// static analysis is provably complete.
//
// This gate therefore does NOT try to understand the command. It segments the
// input on the shell's separator operators and accepts a segment only when its
// first word is `git` (checked against the protected-destination rules) or a
// member of an allow-list. Everything else — every interpreter, every launcher,
// every script file, every wrapper — is rejected by construction, because the
// gate never needs to model what it refuses.
//
// Deliberately absent: heredocs, `$( )`, backticks, `eval`, recursion. They are
// not needed, because nothing but `git` is ever allowed.
//
// Irreducible limitations, each pinned by a test:
//   - bare `git push` / `git push origin HEAD` — the destination is resolved
//     by git (needs `git rev-parse --abbrev-ref HEAD`).
//   - git aliases (`git config alias.p 'push origin master'; git p`) — alias
//     expansion happens inside git.
//   - script files and sourced bodies (`./script.sh`, `bash script.sh`,
//     `. script.sh`) — rejected at launch, but a body already running is opaque.
//   - shell functions defined by an earlier invocation — not visible.
//
// The canonical defence is still server-side branch protection on the remote.
// ---------------------------------------------------------------------------

const PROTECTED = new Set(["master", "main"])

/** Outer commands allowed without a git-specific check. Extend via config. */
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
const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "block-master-push.json"
)

type AllowList =
  | { ok: true; extra: Set<string> }
  | { ok: false; reason: string }

/**
 * Reads the user allow-list additions. A missing file, or a file without
 * `additionalAllowedOuterCommands`, keeps the built-in defaults. Anything the
 * gate cannot trust (bad JSON, wrong value type) is a fail-closed signal:
 * `ok: false` makes the caller reject every command rather than silently
 * falling back to a weaker policy.
 */
function loadUserAllowList(): AllowList {
  const path = process.env[CONFIG_ENV_VAR] || DEFAULT_CONFIG_PATH
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
      // Empty destination means a delete of the source-named ref, so the
      // effective destination is the source side in that case.
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

/**
 * Splits on the separator operators that start a new command: `;`, `&&`,
 * `||`, `|`, `&` and newline. Single pass, quote-aware so a separator inside a
 * quoted string stays part of the argument.
 *
 * Grouping operators (`(`, `)`, `{`, `}`) are deliberately NOT split points:
 * leaving them glued to the neighbouring word is what makes `(git push …)` and
 * `{ …; }` fail the allow-list instead of being evaluated.
 */
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

/**
 * Returns the real command word of a segment: the first token that is not a
 * `FOO=bar` environment assignment. An empty result means the segment carried
 * nothing but assignments, so there is no command to classify.
 */
function stripEnvPrefix(tokens: string[]): string {
  for (const token of tokens) {
    if (!ENV_ASSIGNMENT.test(token)) return token
  }
  return ""
}

function notAllowed(word: string): string {
  return `'${word}' is not in the allow-list of outer commands this gate can verify`
}

/**
 * Returns a rejection reason, or null when the whole command is acceptable.
 *
 * Fail-closed by construction: a segment passes only if it is `git` (and its
 * push destination is unprotected) or an allow-listed outer command. A command
 * the gate cannot read is never guessed at.
 */
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
      // A dry run never moves a ref, so no destination is ever reached.
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
