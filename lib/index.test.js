import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COST_KEY, apply, createCostUnit, inject } from './index.js'

/**
 * A fixture catalog: no file is read and no installed package is required, so
 * the pricing rules are exercised against stated list prices.
 */
const catalogs = () => new Map([
  ['openai-codex', new Map([['gpt-test-model', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }]])],
  ['openrouter', new Map([['vendor/tiered-model', { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 1000, input: 4, output: 8, cacheRead: 0.4, cacheWrite: 0 }] }]])],
])

const unit = () => createCostUnit(catalogs)
const view = (state) => unit().wire.view(state)
/** List prices are floats: compare amounts to a tolerance, shapes exactly. */
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${message ?? 'amount'}: ${actual} !~ ${expected}`)
const usdOf = (state) => view(state).usd

/** One durable Assistant settlement. */
function settlement({ turn = 1, step = 0, provider = 'openrouter', model = 'vendor/tiered-model',
  inputTokens = 100, outputTokens = 10, cacheReadTokens, cacheWriteTokens, usage = true } = {}) {
  return {
    type: 'assistant/message',
    data: {
      turn, step,
      ...(usage ? { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } } : {}),
      message: { source: { provider, model } },
    },
  }
}

/** Fold a list of events over a fresh state. */
function fold(events, definition = unit()) {
  return events.reduce((state, event) => definition.apply(state, event), definition.init())
}

test('host half registers one Session projection and opens no route', () => {
  assert.deepEqual(inject, ['sessionProjections'])
  const registered = new Map()
  const disposers = []
  const ctx = {
    sessionProjections: {
      register(definition) {
        assert.equal(registered.has(definition.key), false)
        registered.set(definition.key, definition)
        return () => registered.delete(definition.key)
      },
    },
    // A projection is pushed, so neither seat below may ever be touched.
    get connection() { throw new Error('a projection needs no route') },
    get webServer() { throw new Error('raw webServer bypasses browser authentication') },
    effect(register) { disposers.push(register()) },
  }
  apply(ctx)
  assert.deepEqual([...registered.keys()], [COST_KEY])
  const definition = registered.get(COST_KEY)
  assert.equal(definition.stateVersion, 1)
  assert.equal(typeof definition.wire.viewSchema.parse, 'function')
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  assert.equal(registered.size, 0)
})

test('nothing measured reports an empty view instead of a confident zero', () => {
  const definition = unit()
  assert.deepEqual(view(definition.init()), { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false })
  assert.deepEqual(view(fold([{ type: 'turn/start', data: {} }, settlement({ usage: false })])),
    { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false })
})

test('priced settlements accumulate list price, cache traffic and tiers', () => {
  const priced = view(fold([settlement({ provider: 'codex-personal', model: 'gpt-test-model', inputTokens: 1000, outputTokens: 50 })]))
  assert.deepEqual({ ...priced, usd: 0 }, { usd: 0, priced: 1, unpriced: 0, steps: 1, subscription: true })
  close(priced.usd, 1000 * 10 / 1e6 + 50 * 50 / 1e6, 'input plus output')

  const cache = view(fold([settlement({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0 })]))
  assert.deepEqual({ ...cache, usd: 0 }, { usd: 0, priced: 1, unpriced: 0, steps: 1, subscription: false })
  close(cache.usd, 1000 * 0.1 / 1e6, 'cache reads')

  const writes = view(fold([settlement({ provider: 'codex-personal', model: 'gpt-test-model',
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 })]))
  close(writes.usd, 1000 * 12.5 / 1e6, 'cache writes')

  // Above the stated input size the tier's rates replace the base rates.
  close(usdOf(fold([settlement({ inputTokens: 2000, outputTokens: 0 })])), 2000 * 4 / 1e6, 'tier input')
  close(usdOf(fold([settlement({ inputTokens: 500, outputTokens: 0 })])), 500 * 1 / 1e6, 'base input')
})

test('an unpriced route counts as a step without inventing a price', () => {
  const state = fold([
    settlement({ provider: 'codex-personal', model: 'unlisted-test-model' }),
    settlement({ turn: 2, step: 0 }),
  ])
  assert.deepEqual({ ...view(state), usd: 0 }, { usd: 0, priced: 1, unpriced: 1, steps: 2, subscription: true })
  close(view(state).usd, 100 * 1 / 1e6 + 10 * 2 / 1e6, 'the one priced step')
})

test('a superseding settlement replaces its slot and a retry adds to it', () => {
  const once = fold([settlement({ inputTokens: 100, outputTokens: 0 })])
  const replayed = fold([settlement({ inputTokens: 100, outputTokens: 0 }), settlement({ inputTokens: 100, outputTokens: 0 })])
  assert.deepEqual(view(replayed), view(once), 'a replay of the same step is counted once')
  const definition = unit()
  const afterFirst = definition.apply(definition.init(), settlement({ inputTokens: 100, outputTokens: 0 }))
  assert.equal(definition.apply(afterFirst, settlement({ inputTokens: 100, outputTokens: 0 })), afterFirst,
    'a replay keeps the state reference, so the registry produces no client frame')

  const amended = fold([settlement({ inputTokens: 100, outputTokens: 0 }), settlement({ inputTokens: 400, outputTokens: 0 })])
  close(view(amended).usd, 400 * 1 / 1e6, 'the second settlement for the same step supersedes the first')
  assert.equal(view(amended).steps, 1)

  // A retried attempt is billed as well: the slot closes, so the next
  // settlement for the same step adds instead of replacing.
  const retried = fold([
    settlement({ inputTokens: 400, outputTokens: 0 }),
    { type: 'llm/retry-started', data: { turn: 1, step: 0 } },
    settlement({ inputTokens: 100, outputTokens: 0 }),
  ])
  close(usdOf(retried), 500 * 1 / 1e6, 'both attempts of a retried step are billed')
  assert.equal(view(retried).steps, 2)

  const otherStep = fold([
    settlement({ inputTokens: 400, outputTokens: 0 }),
    { type: 'llm/retry-started', data: { turn: 9, step: 9 } },
    settlement({ inputTokens: 100, outputTokens: 0 }),
  ])
  close(usdOf(otherStep), 100 * 1 / 1e6, 'a retry of another step does not close this slot')
})

test('malformed settlements and unrelated events leave the state untouched', () => {
  const definition = unit()
  const empty = definition.init()
  const events = [
    null, 'assistant/message', 42,
    { type: 'assistant/message' },
    { type: 'assistant/message', data: {} },
    settlement({ turn: 1.5 }),
    settlement({ turn: -1 }),
    settlement({ step: '0' }),
    settlement({ inputTokens: -1 }),
    settlement({ outputTokens: Number.NaN }),
    settlement({ cacheReadTokens: 'many' }),
    { type: 'llm/retry-started' },
    { type: 'llm/retry-started', data: { turn: 1, step: 0 } },
    { type: 'user/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } },
  ]
  for (const event of events) {
    const state = definition.apply(empty, event)
    assert.equal(state, empty, JSON.stringify(event))
  }
  assert.equal(view(fold([settlement()])).steps, 1)
})

test('schemas normalize both seats for the registry', () => {
  const definition = unit()
  const state = fold([settlement({ provider: 'codex-personal', model: 'gpt-test-model', inputTokens: 1000, outputTokens: 50 })])
  const parsed = definition.stateSchema.parse(state)
  assert.deepEqual(parsed, state)
  assert.deepEqual(definition.wire.viewSchema.parse(parsed), view(state))

  // A damaged checkpoint row and a damaged wire value both degrade to zeros
  // rather than throwing inside the framework.
  assert.deepEqual(definition.stateSchema.parse({ usd: 'nope', priced: -4, unpriced: 1.5, subSteps: null, last: { turn: 0.5 } }),
    { usd: 0, priced: 0, unpriced: 0, subSteps: 0, last: null })
  assert.deepEqual(definition.wire.viewSchema.parse(null), { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false })
  assert.equal(definition.stateSchema.parse(undefined).last, null)
})
