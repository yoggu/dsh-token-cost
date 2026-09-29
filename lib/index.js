/** Session token-cost projection over durable usage and an owner-resolved pi-ai snapshot. */
import { createPricing } from './pricing.js'
export const name = 'dsh-token-cost'
export const inject = ['sessionProjections']
export const COST_KEY = 'dsh-token-cost.cost'

const positive = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
const validCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const tokenCount = value => Number.isSafeInteger(value) && value >= 0
const countOf = value => tokenCount(value) ? value : 0
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null

function countsOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const { inputTokens, outputTokens } = usage
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  return [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(tokenCount)
    && Number.isSafeInteger(inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens)
    ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } : null
}

/** Detached JSON metadata only: no mutable catalog or service object enters a checkpoint. */
function sourceOf(source) {
  if (!source || typeof source !== 'object') return null
  const result = {
    package: text(source.package), version: text(source.version), catalog: text(source.catalog),
    digest: text(source.digest), owner: text(source.owner), label: text(source.label),
    subscription: source.subscription === true,
  }
  return [result.package, result.version, result.catalog, result.digest, result.owner, result.label].every(Boolean)
    ? result : null
}
const sourceKey = source => JSON.stringify([source.package, source.version, source.catalog,
  source.digest, source.owner, source.label, source.subscription])
function sourceEntry(value) {
  const source = sourceOf(value)
  const count = countOf(value?.count)
  return source && count > 0 ? { ...source, count } : null
}
function sourcesOf(value) {
  if (!Array.isArray(value)) return []
  const sources = []
  for (const candidate of value) {
    const entry = sourceEntry(candidate)
    if (entry && !sources.some(other => sourceKey(other) === sourceKey(entry))) sources.push(entry)
  }
  return sources
}
function updateSources(current, previous, slot) {
  const next = sourcesOf(current)
  for (const [source, delta] of [[previous?.source, -1], [slot.source, 1]]) {
    if (!source) continue
    const key = sourceKey(source)
    const index = next.findIndex(item => sourceKey(item) === key)
    if (index === -1) {
      if (delta > 0) next.push({ ...source, count: delta })
    } else {
      const count = next[index].count + delta
      if (count <= 0) next.splice(index, 1)
      else next[index] = { ...next[index], count }
    }
  }
  return next
}
function emptyState() {
  return { usd: 0, priced: 0, unpriced: 0, subSteps: 0, last: null, sources: [] }
}
function slotOf(value) {
  if (value === null || typeof value !== 'object') return null
  const { turn, step } = value
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || turn < 0 || step < 0) return null
  return {
    turn, step, usd: positive(value.usd, 0), priced: countOf(value.priced), unpriced: countOf(value.unpriced),
    subscription: value.subscription === true, source: sourceOf(value.source),
  }
}
const stateSchema = {
  parse(value) {
    const source = value !== null && typeof value === 'object' ? value : {}
    return { usd: positive(source.usd, 0), priced: countOf(source.priced), unpriced: countOf(source.unpriced),
      subSteps: countOf(source.subSteps), last: slotOf(source.last), sources: sourcesOf(source.sources) }
  },
}
function viewOf(state) {
  return { usd: state.usd, priced: state.priced, unpriced: state.unpriced,
    steps: state.priced + state.unpriced, subscription: state.subSteps > 0, sources: sourcesOf(state.sources) }
}
const viewSchema = {
  parse(value) {
    // The registry validates the already-built wire view, not the host state.
    if (value !== null && typeof value === 'object' && value.steps !== undefined) {
      const priced = countOf(value.priced), unpriced = countOf(value.unpriced)
      return { usd: positive(value.usd, 0), priced, unpriced, steps: priced + unpriced,
        subscription: value.subscription === true, sources: sourcesOf(value.sources) }
    }
    return viewOf(stateSchema.parse(value))
  },
}

/** Fail closed: unavailable, throwing, or malformed pricing is unknown, never free. */
function estimate(pricing, provider, model, usage) {
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  try {
    const answer = pricing?.estimate(provider, model, usage)
    return validCount(answer?.usd) && sourceOf(answer?.source) ? answer : null
  } catch { return null }
}

function foldEvent(pricing, state, event) {
  if (event === null || typeof event !== 'object') return state
  if (event.type === 'llm/retry-started') {
    const data = event.data
    return state.last !== null && data?.turn === state.last.turn && data?.step === state.last.step
      ? { ...state, last: null } : state
  }
  if (event.type !== 'assistant/message') return state
  const data = event.data
  if (data === null || typeof data !== 'object' || data.usage === undefined) return state
  const counts = countsOf(data.usage)
  if (!counts || !Number.isSafeInteger(data.turn) || data.turn < 0
    || !Number.isSafeInteger(data.step) || data.step < 0) return state
  const provider = data.message?.source?.provider
  const model = data.message?.source?.model
  const price = estimate(pricing, provider, model, counts)
  const source = price ? sourceOf(price.source) : null
  const slot = { turn: data.turn, step: data.step, usd: price?.usd ?? 0,
    priced: price ? 1 : 0, unpriced: price ? 0 : 1,
    subscription: price?.source?.subscription === true, source }
  const previous = state.last !== null && state.last.turn === slot.turn && state.last.step === slot.step ? state.last : undefined
  if (previous !== undefined && previous.usd === slot.usd && previous.priced === slot.priced
    && previous.unpriced === slot.unpriced && previous.subscription === slot.subscription
    && (!previous.source && !slot.source || previous.source && slot.source
      && sourceKey(previous.source) === sourceKey(slot.source))) return state
  return {
    usd: state.usd - (previous?.usd ?? 0) + slot.usd,
    priced: state.priced - (previous?.priced ?? 0) + slot.priced,
    unpriced: state.unpriced - (previous?.unpriced ?? 0) + slot.unpriced,
    subSteps: state.subSteps - (previous?.subscription ? 1 : 0) + (slot.subscription ? 1 : 0),
    sources: updateSources(state.sources, previous, slot), last: slot,
  }
}

/** Immutable catalog resolved once before registration; the fold makes no filesystem reads. */
export function createCostUnit(pricing = null) {
  return { key: COST_KEY,
    // v1–5 predate typed chat catalog support. Replay historical usage using
    // the validated owner-resolved catalog, including pi-ai 0.99 chat entries;
    // future price/catalog changes need a deliberate bump to reprice history.
    stateVersion: 6, stateSchema, init: () => emptyState(),
    apply: (state, event) => foldEvent(pricing, state, event),
    wire: { viewSchema, view: viewOf } }
}
export async function apply(ctx) {
  const pricing = await createPricing()
  ctx.effect(() => ctx.sessionProjections.register(createCostUnit(pricing)),
    'token-cost: priced Session projection')
}
