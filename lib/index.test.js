import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COST_KEY, apply, createCostUnit, inject } from './index.js'

const rates = {
  'openai-codex/gpt-test-model': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, subscription: true },
  'openrouter/vendor/tiered-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, subscription: false,
    tiers: [{ inputTokensAbove: 1000, input: 4, output: 8, cacheRead: 0.4, cacheWrite: 0 }] },
}
function pricing() {
  return {
    estimate(provider, model, usage) {
      const schedule = rates[`${provider}/${model}`]
      if (!schedule) return { status: 'unknown', reason: 'unpriced-model' }
      const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      let chosen = schedule
      for (const tier of schedule.tiers ?? []) if (total > tier.inputTokensAbove) chosen = tier
      return { usd: (usage.inputTokens * chosen.input + usage.outputTokens * chosen.output
        + usage.cacheReadTokens * chosen.cacheRead + usage.cacheWriteTokens * chosen.cacheWrite) / 1e6,
      source: { package: '@earendil-works/pi-ai', version: '0.87.1', catalog: provider,
        digest: 'fixture-digest', owner: '@deepseek-ai/dsh-llm-pi-ai',
        label: 'fixture API list-price estimate', subscription: schedule.subscription } }
    },
  }
}
const unit = () => createCostUnit(pricing())
const view = state => unit().wire.view(state)
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} !~ ${expected}`)
const usdOf = state => view(state).usd
function settlement({ turn = 1, step = 0, provider = 'openrouter', model = 'vendor/tiered-model',
  inputTokens = 100, outputTokens = 10, cacheReadTokens, cacheWriteTokens, usage = true } = {}) {
  return { type: 'assistant/message', data: { turn, step,
    ...(usage ? { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } } : {}),
    message: { source: { provider, model } } } }
}
function fold(events, definition = unit()) {
  return events.reduce((state, event) => definition.apply(state, event), definition.init())
}

test('host registers one Session projection without modelPricing or an HTTP route', async () => {
  assert.deepEqual(inject, ['sessionProjections'])
  const registered = new Map(), disposers = []
  const ctx = {
    sessionProjections: { register(definition) {
      assert.equal(registered.has(definition.key), false)
      registered.set(definition.key, definition)
      return () => registered.delete(definition.key)
    } },
    get() { throw new Error('must not request modelPricing') },
    get connection() { throw new Error('a projection needs no route') },
    get webServer() { throw new Error('raw webServer bypasses browser authentication') },
    effect(register) { disposers.push(register()) },
  }
  await apply(ctx)
  assert.deepEqual([...registered.keys()], [COST_KEY])
  const definition = registered.get(COST_KEY)
  assert.equal(definition.stateVersion, 6)
  assert.equal(typeof definition.wire.viewSchema.parse, 'function')
  disposers.splice(0).reverse().forEach(dispose => dispose())
  assert.equal(registered.size, 0)
})

test('nothing measured reports an empty view instead of a confident zero', () => {
  const definition = unit()
  assert.deepEqual(view(definition.init()), { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false, sources: [] })
  assert.deepEqual(view(fold([{ type: 'turn/start', data: {} }, settlement({ usage: false })])),
    { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false, sources: [] })
})

test('priced settlements accumulate list price, cache traffic and full-input tiers', () => {
  const priced = view(fold([settlement({ provider: 'openai-codex', model: 'gpt-test-model', inputTokens: 1000, outputTokens: 50 })]))
  assert.deepEqual({ ...priced, usd: 0, sources: [] }, { usd: 0, priced: 1, unpriced: 0, steps: 1, subscription: true, sources: [] })
  assert.deepEqual(priced.sources, [{ package: '@earendil-works/pi-ai', version: '0.87.1',
    catalog: 'openai-codex', digest: 'fixture-digest', owner: '@deepseek-ai/dsh-llm-pi-ai',
    subscription: true, label: 'fixture API list-price estimate', count: 1 }])
  close(priced.usd, (1000 * 10 + 50 * 50) / 1e6)
  const cache = view(fold([settlement({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 })]))
  close(cache.usd, 1000 * 0.1 / 1e6)
  const writes = view(fold([settlement({ provider: 'openai-codex', model: 'gpt-test-model',
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 })]))
  close(writes.usd, 1000 * 12.5 / 1e6)
  close(usdOf(fold([settlement({ inputTokens: 2000, outputTokens: 0 })])), 2000 * 4 / 1e6)
  close(usdOf(fold([settlement({ inputTokens: 500, outputTokens: 0 })])), 500 * 1 / 1e6)
  // Uncached input alone is below threshold; total input including cache exceeds it.
  close(usdOf(fold([settlement({ inputTokens: 500, outputTokens: 0, cacheReadTokens: 501 })])),
    (500 * 4 + 501 * 0.4) / 1e6)
  close(usdOf(fold([settlement({ inputTokens: 500, outputTokens: 0, cacheReadTokens: 500 })])),
    (500 * 1 + 500 * 0.1) / 1e6)
})

test('unknown and failed pricing count unpriced, without breaking the history fold', () => {
  const state = fold([settlement({ provider: 'openai-codex', model: 'unlisted-test-model' }), settlement({ turn: 2 })])
  assert.deepEqual({ ...view(state), usd: 0, sources: [] },
    { usd: 0, priced: 1, unpriced: 1, steps: 2, subscription: false, sources: [] })
  assert.equal(view(state).sources[0].count, 1)
  close(view(state).usd, (100 * 1 + 10 * 2) / 1e6)
  const unavailable = createCostUnit()
  assert.deepEqual(unavailable.wire.view(fold([settlement()], unavailable)),
    { usd: 0, priced: 0, unpriced: 1, steps: 1, subscription: false, sources: [] })
  for (const broken of [{ estimate() { throw new Error('bad catalog') } },
    { estimate: () => ({ usd: NaN }) }, { estimate: () => ({ usd: .25 }) }, { estimate: () => null }]) {
    const definition = createCostUnit(broken)
    assert.equal(definition.wire.view(fold([settlement(), settlement({ step: 1 })], definition)).unpriced, 2)
  }
})

test('superseding settlement replaces slot, replay stays inert, retry adds attempt', () => {
  const definition = unit()
  const first = definition.apply(definition.init(), settlement({ inputTokens: 100, outputTokens: 0 }))
  assert.equal(definition.apply(first, settlement({ inputTokens: 100, outputTokens: 0 })), first)
  const amended = fold([settlement({ inputTokens: 100, outputTokens: 0 }), settlement({ inputTokens: 400, outputTokens: 0 })])
  close(view(amended).usd, 400 / 1e6)
  assert.equal(view(amended).steps, 1)
  const retried = fold([settlement({ inputTokens: 400, outputTokens: 0 }),
    { type: 'llm/retry-started', data: { turn: 1, step: 0 } }, settlement({ inputTokens: 100, outputTokens: 0 })])
  close(usdOf(retried), 500 / 1e6)
  assert.equal(view(retried).steps, 2)
  const otherStep = fold([settlement({ inputTokens: 400, outputTokens: 0 }),
    { type: 'llm/retry-started', data: { turn: 9, step: 9 } }, settlement({ inputTokens: 100, outputTokens: 0 })])
  close(usdOf(otherStep), 100 / 1e6)
})

test('provenance aggregates distinct snapshots, substitution and retries', () => {
  let revision = 1
  const definition = createCostUnit({ estimate(provider) {
    return { usd: 0.25, source: { package: '@earendil-works/pi-ai',
      version: '0.87.1', catalog: 'openai-codex', digest: `digest-${revision}`,
      owner: '@deepseek-ai/dsh-llm-pi-ai', label: 'API-equivalent subscription estimate',
      subscription: provider === 'openai-codex' } }
  } })
  const event = settlement({ provider: 'openai-codex', model: 'shared' })
  const first = definition.apply(definition.init(), event)
  assert.equal(definition.wire.view(first).subscription, true, 'subscription follows validated provenance, not a substring match')
  assert.equal(first.sources.length, 1)
  assert.equal(first.sources[0].count, 1)
  assert.equal(first.last.source.digest, 'digest-1')
  assert.equal(definition.apply(first, event), first, 'identical replay leaves state untouched')
  revision = 2
  const replaced = definition.apply(first, event)
  assert.equal(replaced.priced, 1)
  assert.equal(replaced.sources.length, 1)
  assert.equal(replaced.sources[0].digest, 'digest-2')
  assert.equal(replaced.sources[0].count, 1)
  const closed = definition.apply(replaced, { type: 'llm/retry-started', data: { turn: 1, step: 0 } })
  revision = 3
  const retried = definition.apply(closed, event)
  assert.equal(retried.priced, 2)
  assert.deepEqual(retried.sources.map(item => [item.digest, item.count]), [['digest-2', 1], ['digest-3', 1]])
  assert.deepEqual(definition.stateSchema.parse(structuredClone(retried)), retried)
  assert.deepEqual(definition.wire.viewSchema.parse(structuredClone(definition.wire.view(retried))), definition.wire.view(retried))
})

test('malformed settlements and unrelated events leave state untouched', () => {
  const definition = unit(), empty = definition.init()
  const events = [null, 'assistant/message', 42, { type: 'assistant/message' },
    { type: 'assistant/message', data: {} }, settlement({ turn: 1.5 }), settlement({ turn: -1 }),
    settlement({ step: '0' }), settlement({ inputTokens: -1 }), settlement({ inputTokens: .5 }), settlement({ outputTokens: NaN }),
    settlement({ cacheReadTokens: 'many' }), { type: 'llm/retry-started' },
    { type: 'llm/retry-started', data: { turn: 1, step: 0 } },
    { type: 'user/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } }]
  for (const event of events) assert.equal(definition.apply(empty, event), empty, JSON.stringify(event))
  assert.equal(view(fold([settlement()])).steps, 1)
})

test('schemas normalize both seats for the registry', () => {
  const definition = unit()
  const state = fold([settlement({ provider: 'openai-codex', model: 'gpt-test-model', inputTokens: 1000, outputTokens: 50 })])
  const parsed = definition.stateSchema.parse(state)
  assert.deepEqual(parsed, state)
  assert.deepEqual(definition.wire.viewSchema.parse(parsed), view(state))
  assert.deepEqual(definition.stateSchema.parse({ usd: 'nope', priced: -4, unpriced: 1.5, subSteps: null, last: { turn: 0.5 } }),
    { usd: 0, priced: 0, unpriced: 0, subSteps: 0, last: null, sources: [] })
  assert.deepEqual(definition.wire.viewSchema.parse(null), { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false, sources: [] })
  assert.equal(definition.stateSchema.parse(undefined).last, null)
  assert.deepEqual(definition.stateSchema.parse({ sources: [
    { package: 'valid', version: '1', catalog: 'route', digest: 'hash', owner: 'owner', label: 'estimate', count: 2 },
    { package: 'missing', count: 3 }, { package: 'valid', version: '1', catalog: 'route', digest: 'hash', owner: 'owner', label: 'estimate', count: 7 },
  ] }).sources, [{ package: 'valid', version: '1', catalog: 'route', digest: 'hash', owner: 'owner',
    label: 'estimate', subscription: false, count: 2 }])
})
