import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseArgs,
  isProtectedPush,
  checkPushCommand,
} from "../src/block-master-push.ts"

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

test("isProtectedPush blocks bare master destination", () => {
  assert.match(
    isProtectedPush(["origin", "master"]) ?? "",
    /destination ref 'master'/
  )
})

test("isProtectedPush blocks src:dst form", () => {
  assert.match(
    isProtectedPush(["origin", "feature:master"]) ?? "",
    /destination ref 'master'/
  )
})

test("isProtectedPush blocks delete form", () => {
  assert.match(
    isProtectedPush(["origin", ":master"]) ?? "",
    /destination ref 'master'/
  )
})

test("isProtectedPush blocks --all and --mirror", () => {
  assert.match(
    isProtectedPush(["origin", "--all"]) ?? "",
    /\-\-all \/ \-\-mirror/
  )
  assert.match(
    isProtectedPush(["origin", "--mirror"]) ?? "",
    /\-\-all \/ \-\-mirror/
  )
})

test("isProtectedPush allows feature branches", () => {
  assert.equal(isProtectedPush(["origin", "feature-branch"]), null)
})

test("isProtectedPush allows master as source (non-dst)", () => {
  assert.equal(isProtectedPush(["origin", "master:feature"]), null)
})

test("isProtectedPush filters out flags before parsing refs", () => {
  assert.equal(isProtectedPush(["-f", "origin", "feature"]), null)
  assert.match(
    isProtectedPush(["-f", "origin", "master"]) ?? "",
    /destination ref 'master'/
  )
})

test("isProtectedPush strips + force-push prefix", () => {
  assert.match(
    isProtectedPush(["origin", "+master"]) ?? "",
    /destination ref 'master'/
  )
  assert.match(
    isProtectedPush(["origin", "+refs/heads/master"]) ?? "",
    /destination ref 'master'/
  )
})

test("isProtectedPush normalises refs/heads/ prefix", () => {
  assert.match(
    isProtectedPush(["origin", "refs/heads/master"]) ?? "",
    /destination ref 'master'/
  )
  assert.match(
    isProtectedPush(["origin", "refs/heads/main"]) ?? "",
    /destination ref 'main'/
  )
})

test("isProtectedPush normalises refs/heads/ in src:dst", () => {
  assert.match(
    isProtectedPush(["origin", "feature:refs/heads/main"]) ?? "",
    /destination ref 'main'/
  )
  assert.match(
    isProtectedPush(["origin", "refs/heads/master:refs/heads/main"]) ?? "",
    /destination ref 'main'/
  )
})

test("isProtectedPush is case-insensitive", () => {
  assert.match(
    isProtectedPush(["origin", "Master"]) ?? "",
    /destination ref 'master'/
  )
  assert.match(
    isProtectedPush(["origin", "MAIN"]) ?? "",
    /destination ref 'main'/
  )
})

test("isProtectedPush blocks empty-dst master: form (delete source-named ref)", () => {
  assert.match(
    isProtectedPush(["origin", "master:"]) ?? "",
    /destination ref 'master'/
  )
})

test("isProtectedPush allows empty-dst delete of non-protected ref", () => {
  assert.equal(isProtectedPush(["origin", "feature:"]), null)
})

test("isProtectedPush blocks multi-destination when one is protected", () => {
  assert.match(
    isProtectedPush(["origin", "feature", "master"]) ?? "",
    /destination ref 'master'/
  )
  assert.match(
    isProtectedPush(["origin", "master", "main"]) ?? "",
    /destination ref/
  )
})

test("isProtectedPush allows multi-destination when none is protected", () => {
  assert.equal(isProtectedPush(["origin", "feature", "release"]), null)
})

test("checkPushCommand only matches git push at command position", () => {
  assert.equal(checkPushCommand("git status"), null)
  assert.equal(checkPushCommand("git pushd /tmp"), null)
  assert.equal(checkPushCommand("echo git push origin master"), null)
  assert.equal(
    checkPushCommand("xargs git push origin master"),
    null
  )
})

test("checkPushCommand allows dry-run before refspec", () => {
  assert.equal(checkPushCommand("git push --dry-run origin master"), null)
  assert.equal(checkPushCommand("git push -n origin master"), null)
})

test("checkPushCommand allows dry-run after refspec", () => {
  assert.equal(checkPushCommand("git push origin master --dry-run"), null)
  assert.equal(
    checkPushCommand("git push origin master -n"),
    null
  )
})

test("checkPushCommand blocks real pushes", () => {
  assert.match(
    checkPushCommand("git push origin master") ?? "",
    /destination ref 'master'/
  )
  assert.match(
    checkPushCommand("git push upstream main") ?? "",
    /destination ref 'main'/
  )
})

test("checkPushCommand handles git -C <path> push", () => {
  assert.match(
    checkPushCommand("git -C /tmp push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand handles git -c key=value push", () => {
  assert.match(
    checkPushCommand("git -c push.default=current push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand handles git --no-pager push", () => {
  assert.match(
    checkPushCommand("git --no-pager push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand handles git -P push", () => {
  assert.match(
    checkPushCommand("git -P push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks chained push after &&", () => {
  assert.match(
    checkPushCommand("git status && git push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks chained push after ;", () => {
  assert.match(
    checkPushCommand("git status; git push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks chained push after |", () => {
  assert.match(
    checkPushCommand("git status | git push origin master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks refs/heads/master destination", () => {
  assert.match(
    checkPushCommand("git push origin refs/heads/master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks force-push +master", () => {
  assert.match(
    checkPushCommand("git push origin +master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks --all at command level", () => {
  assert.match(
    checkPushCommand("git push --all origin master") ?? "",
    /\-\-all \/ \-\-mirror/
  )
})

test("checkPushCommand blocks --mirror at command level", () => {
  assert.match(
    checkPushCommand("git push --mirror origin") ?? "",
    /\-\-all \/ \-\-mirror/
  )
})

test("checkPushCommand allows --delete on non-protected ref", () => {
  assert.equal(
    checkPushCommand("git push origin --delete feature"),
    null
  )
})

test("checkPushCommand blocks --delete on protected ref", () => {
  assert.match(
    checkPushCommand("git push origin --delete master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand blocks case variant", () => {
  assert.match(
    checkPushCommand("git push origin Master") ?? "",
    /destination ref 'master'/
  )
})

test("checkPushCommand does not block bare git push (documented limitation)", () => {
  // Resolving the current branch would require a sub-process to git
  // (e.g. `git rev-parse --abbrev-ref HEAD`). Out of scope for the
  // regex-based detector. Test pins current behaviour.
  assert.equal(checkPushCommand("git push"), null)
})

test("default export hook blocks protected push", async () => {
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

test("default export hook allows safe commands", async () => {
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
