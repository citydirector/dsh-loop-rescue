import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.js'

function harness(cfg = {}) {
  const listeners = {}
  const logs = []
  let resolveIdle
  const agent = {
    followups: [], injected: [],
    inbox: { hasPending: false },
    whenIdle: () => new Promise((r) => { resolveIdle = r }),
    followup(m) { this.followups.push(m) },
    inject(m) { this.injected.push(m) },
  }
  const ctx = {
    on: (name, fn) => { listeners[name] = fn },
    agents: { get: () => agent },
    logger: { warn: (m) => logs.push(m), debug: () => {} },
    get: () => undefined,
  }
  apply(ctx, new Config(cfg))
  async function run(chunks) {
    const req = markAgentLoopRequest({ sessionId: 's1', messages: [] })
    const out = []
    for await (const c of listeners['llm/stream'](req, async function* () { yield* chunks })) out.push(c)
    return out
  }
  return { agent, run, logs, idle: () => resolveIdle?.(), listeners }
}

function loopChunks() {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }]
  chunks.push({ type: 'reasoning-delta', index: 0, text: 'Plan: fix the router.\n' })
  for (let i = 0; i < 40; i++) for (const p of ['Now.', 'OK.', 'Emit.', 'Producing.']) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: p + '\n' })
  }
  chunks.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'never reached' } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

test('切断后 block-end 只含循环前的内容，然后 stop', async () => {
  const h = harness({ marker: false })
  const out = await h.run(loopChunks())
  const end = out.find((c) => c.type === 'block-end')
  assert.equal(end.block.text, 'Plan: fix the router.')
  assert.deepEqual(out.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(out.filter((c) => c.type === 'finish').length, 1)
})

test('空闲后自动续跑一次，消息来源为 loop-rescue notice', async () => {
  const h = harness()
  await h.run(loopChunks())
  h.idle(); await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.agent.followups.length, 1)
  assert.equal(h.agent.followups[0].source.kind, 'loop-rescue')
  assert.equal(h.agent.followups[0].source.form, 'notice')
})

test('续跑前若已有新调用，则不重复续跑', async () => {
  const h = harness()
  await h.run(loopChunks())
  await h.run([{ type: 'finish', reason: { kind: 'stop' } }])
  h.idle(); await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.agent.followups.length, 0)
})

test('打开的工具调用块存在时不切', async () => {
  const h = harness()
  const chunks = loopChunks()
  chunks.splice(1, 0, { type: 'block-start', index: 1, blockType: 'tool-call' })
  const out = await h.run(chunks)
  assert.equal(out.length, chunks.length)
})

test('连续救援超过上限：只剪不续跑，并留提示', async () => {
  const h = harness({ maxConsecutiveRescues: 1 })
  await h.run(loopChunks())
  await h.run(loopChunks())
  h.idle(); await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.agent.followups.length, 0)
  assert.equal(h.agent.injected.length, 1)
})

test('续跑请求改用 retryTemperature，仅一次', async () => {
  const h = harness({ retryTemperature: 1.1 })
  await h.run(loopChunks())
  const base = { provider: 'p', model: 'm', temperature: 0.6 }
  const a = await h.listeners['agent/request']({ agent: h.agent }, async () => base)
  const b = await h.listeners['agent/request']({ agent: h.agent }, async () => base)
  assert.equal(a.temperature, 1.1)
  assert.equal(b.temperature, 0.6)
})

test('observe 模式只记日志，流原样透传', async () => {
  const h = harness({ mode: 'observe' })
  const chunks = loopChunks()
  const out = await h.run(chunks)
  assert.equal(out.length, chunks.length)
  assert.ok(h.logs.some((l) => l.includes('loop detected')))
})
