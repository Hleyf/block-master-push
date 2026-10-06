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
    /master is protected/
  )
})

test("isProtectedPush blocks src:dst form", () => {
  assert.match(
    isProtectedPush(["origin", "feature:master"]) ?? "",
    /master is protected/
  )
})

test("isProtectedPush blocks delete form", () => {
  assert.match(
    isProtectedPush(["origin", ":master"]) ?? "",
    /master is protected/
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
    /master is protected/
  )
})

test("checkPushCommand only matches git push", () => {
  assert.equal(checkPushCommand("git status"), null)
  assert.equal(checkPushCommand("git pushd /tmp"), null)
  assert.equal(checkPushCommand("echo git push origin master"), null)
})

test("checkPushCommand allows dry-run", () => {
  assert.equal(checkPushCommand("git push --dry-run origin master"), null)
  assert.equal(checkPushCommand("git push -n origin master"), null)
})

test("checkPushCommand blocks real pushes", () => {
  assert.match(
    checkPushCommand("git push origin master") ?? "",
    /master is protected/
  )
  assert.match(
    checkPushCommand("git push upstream main") ?? "",
    /main is protected/
  )
})
