import test from "node:test"
import assert from "node:assert/strict"
import { BlockMasterPush } from "../src/block-master-push.ts"

test("plugin loads cleanly", async () => {
  const toastCalls: unknown[] = []
  // Structural test: only tui.showToast is touched by the plugin on load,
  // so a partial mock is sufficient. Cast through `unknown` to satisfy the
  // full OpencodeClient type from @opencode-ai/plugin.
  const mockClient = {
    tui: {
      showToast: async (args: unknown) => {
        toastCalls.push(args)
        return true
      },
    },
  } as unknown as Parameters<typeof BlockMasterPush>[0]["client"]

  const hooks = await BlockMasterPush({
    client: mockClient,
  } as unknown as Parameters<typeof BlockMasterPush>[0])

  assert.ok(hooks, "BlockMasterPush must return a hooks object")
  assert.ok(
    Object.hasOwn(hooks, "experimental.chat.system.transform"),
    "hooks must own key 'experimental.chat.system.transform'"
  )
  assert.ok(
    Object.hasOwn(hooks, "tool.execute.before"),
    "hooks must own key 'tool.execute.before'"
  )
  assert.equal(
    typeof (hooks as Record<string, unknown>)["experimental.chat.system.transform"],
    "function",
    "'experimental.chat.system.transform' must be a function"
  )
  assert.equal(
    typeof (hooks as Record<string, unknown>)["tool.execute.before"],
    "function",
    "'tool.execute.before' must be a function"
  )

  assert.equal(toastCalls.length, 1, "client.tui.showToast must be called exactly once on load")
  assert.deepEqual(
    toastCalls[0],
    { body: { message: "Main branch blocked", variant: "error" } },
    "toast must be called with the expected payload"
  )
})

test("plugin load returns promptly even when showToast hangs (fire-and-forget)", async () => {
  // Build a toast promise that NEVER resolves on its own. The test manually
  // resolves it via resolveToast AFTER asserting timing — proving the load
  // function did not wait for the toast to settle.
  let resolveToast!: () => void
  const hungToast = new Promise<boolean>((res) => {
    resolveToast = () => res(true)
  })

  const mockClient = {
    tui: {
      showToast: async (_args: unknown) => hungToast,
    },
  } as unknown as Parameters<typeof BlockMasterPush>[0]["client"]

  const start = Date.now()
  const hooks = await BlockMasterPush({
    client: mockClient,
  } as unknown as Parameters<typeof BlockMasterPush>[0])
  const elapsed = Date.now() - start

  assert.ok(
    hooks,
    "BlockMasterPush must return a hooks object even when showToast is pending"
  )
  assert.ok(
    elapsed < 50,
    `load function must not block on the toast promise, but took ${elapsed}ms`
  )

  // The promise is still hanging here — resolve it so the .catch() handler
  // runs and the promise does not outlive the test runner as a pending tick.
  resolveToast()
  // Give the microtask queue one drain so any spurious unhandled rejection
  // would surface here rather than after the test reports success.
  await Promise.resolve()
})