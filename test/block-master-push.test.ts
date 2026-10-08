import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseArgs,
  isProtectedPush,
  checkPushCommand,
  getPluginStatus,
} from "../src/block-master-push.ts"

// ---------------------------------------------------------------------------
// Config file harness
//
// The plugin reads its allow-list from
// ~/.config/opencode/block-master-push.json, overridable with the
// BLOCK_MASTER_PUSH_CONFIG env var. The override lets the config policy be
// tested without patching node:fs.
// ---------------------------------------------------------------------------
const CONFIG_ENV = "BLOCK_MASTER_PUSH_CONFIG"

function withConfig(contents: string | null): () => void {
  const dir = mkdtempSync(join(tmpdir(), "bmp-config-"))
  const path = join(dir, "block-master-push.json")
  if (contents !== null) writeFileSync(path, contents)
  process.env[CONFIG_ENV] = path
  return () => {
    delete process.env[CONFIG_ENV]
    rmSync(dir, { recursive: true, force: true })
  }
}

const NOT_ALLOWED = /not in the allow-list/

// ---------------------------------------------------------------------------
// Unit: argv parsing (unchanged from f19e717)
// ---------------------------------------------------------------------------

test("parseArgs handles simple args", () => {
  assert.deepEqual(parseArgs("origin master"), ["origin", "master"])
})

test("parseArgs preserves quoted strings", () => {
  assert.deepEqual(parseArgs('commit -m "feat: x"'), [
    "commit",
    "-m",
    "feat: x",
  ])
})

// ---------------------------------------------------------------------------
// Group 1 — protected git destinations are rejected
// ---------------------------------------------------------------------------

test("blocks git push origin master", () => {
  assert.match(checkPushCommand("git push origin master") ?? "", /destination ref 'master'/)
})

test("blocks git push origin main", () => {
  assert.match(checkPushCommand("git push origin main") ?? "", /destination ref 'main'/)
})

test("blocks case-variant git push origin Master", () => {
  assert.match(checkPushCommand("git push origin Master") ?? "", /destination ref 'master'/)
})

test("blocks git push origin refs/heads/master", () => {
  assert.match(
    checkPushCommand("git push origin refs/heads/master") ?? "",
    /destination ref 'master'/
  )
})

test("blocks force-push git push origin +master", () => {
  assert.match(checkPushCommand("git push origin +master") ?? "", /destination ref 'master'/)
})

test("blocks empty-destination git push origin master:", () => {
  assert.match(checkPushCommand("git push origin master:") ?? "", /destination ref 'master'/)
})

test("blocks git push origin feature:master", () => {
  assert.match(
    checkPushCommand("git push origin feature:master") ?? "",
    /destination ref 'master'/
  )
})

test("blocks git push --all origin master", () => {
  assert.match(checkPushCommand("git push --all origin master") ?? "", /--all/)
})

test("blocks git push --mirror origin", () => {
  assert.match(checkPushCommand("git push --mirror origin") ?? "", /--mirror/)
})

test("blocks git push origin --delete master", () => {
  assert.match(
    checkPushCommand("git push origin --delete master") ?? "",
    /destination ref 'master'/
  )
})

test("blocks multiple refs when one destination is protected", () => {
  assert.match(
    checkPushCommand("git push origin feature main") ?? "",
    /destination ref 'main'/
  )
})

// ---------------------------------------------------------------------------
// Group 2 — git commands that are not protected pushes are allowed
// ---------------------------------------------------------------------------

test("allows git push origin feature", () => {
  assert.equal(checkPushCommand("git push origin feature"), null)
})

test("allows git status", () => {
  assert.equal(checkPushCommand("git status"), null)
})

test("allows git pushd /tmp", () => {
  assert.equal(checkPushCommand("git pushd /tmp"), null)
})

test("allows git config alias definition mentioning push origin master", () => {
  assert.equal(checkPushCommand("git config alias.p 'push origin master'"), null)
})

test("allows git push origin --delete feature", () => {
  assert.equal(checkPushCommand("git push origin --delete feature"), null)
})

test("allows dry-run pushes to master", () => {
  // --dry-run / -n never move a ref, so the protected destination is
  // unreachable. Pinned here so the exemption stays deliberate.
  assert.equal(checkPushCommand("git push --dry-run origin master"), null)
  assert.equal(checkPushCommand("git push origin master -n"), null)
})

test("allows git -C <path> push origin feature", () => {
  assert.equal(checkPushCommand("git -C /tmp push origin feature"), null)
})

test("allows git -c key=value push origin feature", () => {
  assert.equal(
    checkPushCommand("git -c push.default=current push origin feature"),
    null
  )
})

// ---------------------------------------------------------------------------
// Group 3 — irreducible limitations, pinned so they stay visible
// ---------------------------------------------------------------------------

test("PIN: bare 'git push' is allowed (needs git rev-parse --abbrev-ref HEAD)", () => {
  assert.equal(checkPushCommand("git push"), null)
})

test("PIN: 'git push origin HEAD' is allowed (destination resolved by git)", () => {
  assert.equal(checkPushCommand("git push origin HEAD"), null)
})

test("PIN: git aliases are not expanded by the plugin", () => {
  // Alias expansion happens inside git, so the plugin only sees `git p`.
  assert.equal(checkPushCommand("git p"), null)
})

test("PIN: script invocations are rejected by the outer allow-list", () => {
  // The gate cannot see what a script body does once it is running; the only
  // defence left is refusing to launch it at all.
  assert.match(checkPushCommand("./script.sh") ?? "", NOT_ALLOWED)
  assert.match(checkPushCommand("bash script.sh") ?? "", NOT_ALLOWED)
})

test("PIN: variable expansion in git push args is not detected by the gate", () => {
  // Bash would expand $MASTER to "master" and push to master; the gate only
  // sees the literal token $MASTER. The plugin's threat model is the gate
  // refusing what bash evaluates, NOT evaluating bash itself.
  assert.equal(checkPushCommand("git push origin $MASTER"), null)
})

test("PIN: ${VAR:-default} expansion in git push args is not detected", () => {
  assert.equal(checkPushCommand("git push origin ${MASTER:-master}"), null)
})

test("PIN: backtick command substitution is not detected", () => {
  assert.equal(checkPushCommand("git push origin `echo master`"), null)
})

test("PIN: $(...) command substitution is not detected", () => {
  assert.equal(checkPushCommand("git push origin $(echo master)"), null)
})

test("PIN: ANSI-C quoting is not decoded by the gate", () => {
  // $'\x6d\x61\x73\x74\x65\x72' is bash's spelling of "master".
  assert.equal(checkPushCommand("git push origin $'\\x6d\\x61\\x73\\x74\\x65\\x72'"), null)
})

test("PIN: brace expansion is not expanded by the gate", () => {
  // bash expands {main,master} to two args; the gate sees the literal text.
  assert.equal(checkPushCommand("git push origin {main,master}"), null)
})

test("PIN: bare-path /usr/bin/git is rejected as not in the safe-list", () => {
  // The allow-list contains `git`, not `/usr/bin/git`. Users with a non-PATH
  // git must whitelist the full path via additionalAllowedOuterCommands.
  assert.match(
    checkPushCommand("/usr/bin/git push origin master") ?? "",
    NOT_ALLOWED
  )
})

// ---------------------------------------------------------------------------
// Group 4 — the pivot: every non-git interpreter and launcher is rejected
// ---------------------------------------------------------------------------

test("rejects bash -c 'git push origin master'", () => {
  assert.match(
    checkPushCommand(`bash -c "git push origin master"`) ?? "",
    NOT_ALLOWED
  )
})

test("rejects sh -c 'git push origin master'", () => {
  assert.match(checkPushCommand(`sh -c "git push origin master"`) ?? "", NOT_ALLOWED)
})

test("rejects env git push origin master", () => {
  assert.match(checkPushCommand("env git push origin master") ?? "", NOT_ALLOWED)
})

test("rejects python3 -c with an inline push", () => {
  assert.match(
    checkPushCommand(`python3 -c "os.system('git push origin master')"`) ?? "",
    NOT_ALLOWED
  )
})

test("rejects ruby -e with an inline push", () => {
  assert.match(
    checkPushCommand(`ruby -e 'system("git push origin master")'`) ?? "",
    NOT_ALLOWED
  )
})

test("rejects node -e with an inline push", (t) => {
  const restore = withConfig(null)
  t.after(restore)
  assert.match(
    checkPushCommand(`node -e 'require("child_process").execSync("git push origin master")'`) ?? "",
    NOT_ALLOWED
  )
})

test("rejects perl -e with an inline push", () => {
  assert.match(checkPushCommand(`perl -e 'system("git push origin master")'`) ?? "", NOT_ALLOWED)
})

test("rejects awk BEGIN{system(...)}", () => {
  assert.match(
    checkPushCommand(`awk 'BEGIN{system("git push origin master")}'`) ?? "",
    NOT_ALLOWED
  )
})

test("rejects subshell '(git push origin master)'", () => {
  assert.match(checkPushCommand("(git push origin master)") ?? "", NOT_ALLOWED)
})

test("rejects brace group '{ git push origin master; }'", () => {
  assert.match(checkPushCommand("{ git push origin master; }") ?? "", NOT_ALLOWED)
})

test("rejects unknown outer command", () => {
  assert.match(checkPushCommand("make deploy") ?? "", NOT_ALLOWED)
})

// ---------------------------------------------------------------------------
// Group 5 — env prefixes are stripped, then the git rule applies
// ---------------------------------------------------------------------------

test("strips FOO=bar prefix and blocks the protected push", () => {
  assert.match(
    checkPushCommand("FOO=bar git push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("strips multiple env prefixes and blocks the protected push", () => {
  assert.match(
    checkPushCommand("FOO=bar BAZ=qux git push origin main") ?? "",
    /destination ref 'main'/
  )
})

test("strips env prefix and allows a feature push", () => {
  assert.equal(checkPushCommand("FOO=bar git push origin feature"), null)
})

// ---------------------------------------------------------------------------
// Group 6 — chained commands are segmented, then each segment classified
// ---------------------------------------------------------------------------

test("blocks a protected push chained after ;", () => {
  assert.match(
    checkPushCommand("git status; git push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("blocks a protected push chained after &&", () => {
  assert.match(
    checkPushCommand("git push origin master && echo done") ?? "",
    /destination ref 'master'/
  )
})

test("blocks a protected push after a pipe", () => {
  assert.match(
    checkPushCommand("git status | grep x && git push origin main") ?? "",
    /destination ref 'main'/
  )
})

test("allows a safe chain of git and echo", () => {
  assert.equal(checkPushCommand("git status && echo done"), null)
})

test("allows an echo of a push string (quoted, inert)", () => {
  assert.equal(checkPushCommand(`echo "git push origin master"`), null)
})

// ---------------------------------------------------------------------------
// Group 7 — built-in safe-list commands are allowed
// ---------------------------------------------------------------------------

test("allows every built-in safe command", () => {
  const cases: Record<string, string> = {
    echo: "echo hi",
    cat: "cat file.txt",
    head: "head -n 5 file.txt",
    tail: "tail -f log.txt",
    tr: "tr a-z A-Z",
    cut: "cut -d: -f1 file.txt",
    paste: "paste a b",
    sort: "sort f",
    uniq: "sort f | uniq -c",
    wc: "wc -l f",
    grep: "grep -rn needle src",
    ls: "ls -la",
    pwd: "pwd",
    date: "date",
    whoami: "whoami",
    id: "id",
    uname: "uname -a",
    file: "file f",
    df: "df -h",
    du: "du -sh .",
    diff: "diff a b",
    comm: "comm a b",
    cmp: "cmp a b",
    true: "true",
    false: "false",
    test: "test -f file.txt",
    tee: "cat f | tee out.txt",
    cp: "cp a b",
    mv: "mv a b",
    rm: "rm -f tmp",
    mkdir: "mkdir -p out",
    rmdir: "rmdir empty",
    touch: "touch file.txt",
  }
  for (const [command, invocation] of Object.entries(cases)) {
    assert.equal(
      checkPushCommand(invocation),
      null,
      `${command} (${invocation}) should be allowed`
    )
  }
})

test("does not treat less/more as wrappers", () => {
  assert.equal(checkPushCommand("more f"), null)
})

// ---------------------------------------------------------------------------
// Group 8 — config file policy
// ---------------------------------------------------------------------------

test("config file missing: built-in defaults apply", (t) => {
  const restore = withConfig(null)
  t.after(restore)
  assert.equal(checkPushCommand("echo hi"), null)
  assert.match(checkPushCommand("git push origin master") ?? "", /destination ref 'master'/)
  assert.match(checkPushCommand("awk 'BEGIN{}'") ?? "", NOT_ALLOWED)
})

test("config without additionalAllowedOuterCommands: built-in defaults apply", (t) => {
  const restore = withConfig(JSON.stringify({ someOtherKey: true }))
  t.after(restore)
  assert.equal(checkPushCommand("echo hi"), null)
  assert.match(checkPushCommand("awk 'BEGIN{}'") ?? "", NOT_ALLOWED)
})

test("config additionalAllowedOuterCommands extends the allow-list", (t) => {
  const restore = withConfig(
    JSON.stringify({ additionalAllowedOuterCommands: ["awk", "sed", "xargs"] })
  )
  t.after(restore)
  assert.equal(checkPushCommand("awk 'BEGIN{}'"), null)
  assert.equal(checkPushCommand("xargs echo hi"), null)
  // git is still checked, even when the config exists
  assert.match(checkPushCommand("git push origin master") ?? "", /destination ref 'master'/)
})

test("config with an empty additionalAllowedOuterCommands keeps defaults", (t) => {
  const restore = withConfig(JSON.stringify({ additionalAllowedOuterCommands: [] }))
  t.after(restore)
  assert.equal(checkPushCommand("echo hi"), null)
  assert.match(checkPushCommand("make deploy") ?? "", NOT_ALLOWED)
})

test("malformed config JSON fails closed and rejects every command", (t) => {
  const restore = withConfig("{ this is not json")
  t.after(restore)
  assert.match(checkPushCommand("echo hi") ?? "", /malformed/i)
  assert.match(checkPushCommand("ls -la") ?? "", /malformed/i)
  assert.match(checkPushCommand("git push origin feature") ?? "", /malformed/i)
  assert.match(checkPushCommand("git push origin master") ?? "", /malformed/i)
})

test("config with a non-array additionalAllowedOuterCommands fails closed", (t) => {
  const restore = withConfig(JSON.stringify({ additionalAllowedOuterCommands: "awk" }))
  t.after(restore)
  assert.match(checkPushCommand("echo hi") ?? "", /must be an array/i)
  assert.match(checkPushCommand("git push origin feature") ?? "", /must be an array/i)
})

test("config file under XDG_CONFIG_HOME extends the allow-list", (t) => {
  // BLOCK_MASTER_PUSH_CONFIG takes precedence; the XDG path is the default
  // when the override is unset. Linux users with a non-default XDG config
  // home must find the file at ${XDG_CONFIG_HOME}/opencode/block-master-push.json.
  const savedOverride = process.env[CONFIG_ENV]
  const savedXdg = process.env.XDG_CONFIG_HOME
  delete process.env[CONFIG_ENV]

  const xdgRoot = mkdtempSync(join(tmpdir(), "bmp-xdg-"))
  const opencodeDir = join(xdgRoot, "opencode")
  mkdirSync(opencodeDir, { recursive: true })
  writeFileSync(
    join(opencodeDir, "block-master-push.json"),
    JSON.stringify({ additionalAllowedOuterCommands: ["xargs"] })
  )
  process.env.XDG_CONFIG_HOME = xdgRoot

  t.after(() => {
    if (savedOverride === undefined) delete process.env[CONFIG_ENV]
    else process.env[CONFIG_ENV] = savedOverride
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedXdg
    rmSync(xdgRoot, { recursive: true, force: true })
  })

  // xargs was added by the XDG-rooted config — the gate accepts it.
  assert.equal(checkPushCommand("xargs echo hi"), null)
})

test("malformed config does not break the hook, it blocks it", async (t) => {
  const restore = withConfig("{ broken")
  t.after(restore)
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await assert.rejects(
    () =>
      hook(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "git push origin master" } }
      ),
    /malformed/i
  )
})

// ---------------------------------------------------------------------------
// Group 9 — unit-level isProtectedPush still behaves (kept from f19e717)
// ---------------------------------------------------------------------------

test("isProtectedPush blocks a protected destination directly", () => {
  assert.match(isProtectedPush(["origin", "master"]) ?? "", /destination ref 'master'/)
  assert.equal(isProtectedPush(["origin", "feature"]), null)
})

test("isProtectedPush allows master as the source of a push", () => {
  assert.equal(isProtectedPush(["origin", "master:feature"]), null)
})

// ---------------------------------------------------------------------------
// Group 10 — hook integration
// ---------------------------------------------------------------------------

test("default export hook blocks a protected push", async () => {
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await assert.rejects(
    () =>
      hook(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "git push origin master" } }
      ),
    /destination ref 'master'/
  )
})

test("default export hook allows a feature push", async () => {
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await hook(
    { tool: "bash", sessionID: "s", callID: "c" },
    { args: { command: "git push origin feature" } }
  )
})

test("default export hook ignores non-bash tools", async () => {
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await hook(
    { tool: "read", sessionID: "s", callID: "c" },
    { args: { filePath: "/etc/passwd" } }
  )
})

test("default export hook ignores a non-string command", async () => {
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await hook(
    { tool: "bash", sessionID: "s", callID: "c" },
    { args: { command: 42 as unknown as string } }
  )
})

test("default export hook rejects an interpreter bypass", async () => {
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await assert.rejects(
    () =>
      hook(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: `bash -c "git push origin master"` } }
      ),
    NOT_ALLOWED
  )
})

// ---------------------------------------------------------------------------
// Group 11 — non-string / empty input guards
// ---------------------------------------------------------------------------

test("empty command is allowed", () => {
  assert.equal(checkPushCommand(""), null)
  assert.equal(checkPushCommand("   "), null)
})

test("command of only separators produces no segments", () => {
  assert.equal(checkPushCommand(";;"), null)
})

// ---------------------------------------------------------------------------
// Group 12 — visual indicator (so the user can confirm the plugin is loaded)
// ---------------------------------------------------------------------------

test("getPluginStatus returns ACTIVE by default", () => {
  delete process.env.BLOCK_MASTER_PUSH_DISABLED
  const status = getPluginStatus()
  assert.equal(status.active, true)
  assert.ok(status.version)
  assert.ok(status.commit)
})

test("getPluginStatus returns INACTIVE when BLOCK_MASTER_PUSH_DISABLED=1", () => {
  process.env.BLOCK_MASTER_PUSH_DISABLED = "1"
  try {
    const status = getPluginStatus()
    assert.equal(status.active, false)
    assert.match(status.reason ?? "", /BLOCK_MASTER_PUSH_DISABLED=1/)
  } finally {
    delete process.env.BLOCK_MASTER_PUSH_DISABLED
  }
})

test("self-test command 'block-master-push status' throws with ACTIVE status", async () => {
  delete process.env.BLOCK_MASTER_PUSH_DISABLED
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await assert.rejects(
    () =>
      hook(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "block-master-push status" } }
      ),
    /\[block-master-push: ACTIVE\]/
  )
})

test("self-test command '__bmp_status__' (alternate form) also throws", async () => {
  delete process.env.BLOCK_MASTER_PUSH_DISABLED
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["tool.execute.before"]
  await assert.rejects(
    () =>
      hook(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "__bmp_status__" } }
      ),
    /\[block-master-push: ACTIVE\]/
  )
})

test("self-test command shows INACTIVE when BLOCK_MASTER_PUSH_DISABLED=1", async () => {
  process.env.BLOCK_MASTER_PUSH_DISABLED = "1"
  try {
    const mod = await import("../src/block-master-push.ts")
    const hooks = await mod.default()
    const hook = hooks["tool.execute.before"]
    await assert.rejects(
      () =>
        hook(
          { tool: "bash", sessionID: "s", callID: "c" },
          { args: { command: "block-master-push status" } }
        ),
      /\[block-master-push: INACTIVE\]/
    )
  } finally {
    delete process.env.BLOCK_MASTER_PUSH_DISABLED
  }
})

test("disabled plugin does NOT block a protected push (sanity check)", async () => {
  process.env.BLOCK_MASTER_PUSH_DISABLED = "1"
  try {
    const mod = await import("../src/block-master-push.ts")
    const hooks = await mod.default()
    const hook = hooks["tool.execute.before"]
    // Should NOT throw — plugin is disabled, push goes through (would actually
    // push to master in real life, but here we just verify the hook didn't block)
    await hook(
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command: "git push origin master" } }
    )
  } finally {
    delete process.env.BLOCK_MASTER_PUSH_DISABLED
  }
})

test("system prompt hook injects ACTIVE status into system array", async () => {
  delete process.env.BLOCK_MASTER_PUSH_DISABLED
  const mod = await import("../src/block-master-push.ts")
  const hooks = await mod.default()
  const hook = hooks["experimental.chat.system.transform"]
  assert.ok(hook, "system transform hook not registered")
  const output = { system: [] as string[] }
  await hook({ model: {} as any }, output)
  assert.ok(
    output.system.some((s: string) => s.includes("[block-master-push: ACTIVE")),
    `expected system to include [block-master-push: ACTIVE], got: ${JSON.stringify(output.system)}`
  )
})
