/**
 * Host half of `dsh-token-cost`: price every durable Assistant settlement
 * in a Session from the published pi-ai model catalogs, then publish the running
 * total as a Session projection the browser half reads.
 *
 * This is deliberately an estimate. It uses the same provider/model catalogs
 * as pi-ai and does not attempt to ask a gateway what an account was billed.
 * That keeps the readout deterministic, credential-free, and useful for routes
 * such as Codex subscriptions where there is no per-request bill to settle.
 *
 * The estimate is a push value, not a route: the framework drives the fold over
 * committed Session events and delivers whole values to the browser, so an idle
 * Session costs no requests at all.
 *
 * @module dsh-token-cost
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-token-cost'

/** The projection registry drives the fold and serves the browser half. */
export const inject = ['sessionProjections']

/** The projection key the browser half reads. */
export const COST_KEY = 'dsh-token-cost.cost'

/**
 * Where the installed pi-ai keeps its per-provider model catalogs.
 *
 * Those files carry the published list price of every model pi-ai describes.
 * The directory is discovered rather than configured because it moves with the
 * installation; `DSH_PI_AI_DATA` overrides the search.
 *
 * @returns the catalog directory, or undefined when it cannot be found.
 */
function piAiCatalogDir() {
  const override = process.env.DSH_PI_AI_DATA
  if (typeof override === 'string' && override.length > 0) return override
  const relative = join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  const roots = []
  try {
    // The running CLI's own resolved location: pi-ai is a dependency of the
    // installed harness package, so it sits under one of its ancestors.
    roots.push(dirname(realpathSync(process.argv[1] ?? '')))
  } catch {
    // A process whose argv[1] is not a resolvable path contributes no root.
  }
  roots.push(process.cwd())
  roots.push(join(process.env.HOME ?? '', '.local', 'share', 'mise', 'installs', 'node'))
  for (const root of roots) {
    let dir = root
    for (let depth = 0; depth < 8; depth += 1) {
      const found = join(dir, relative)
      if (existsSync(found)) return found
      // A mise install root holds one directory per Node version instead.
      try {
        for (const version of readdirSync(dir)) {
          const versioned = join(dir, version, 'lib', relative)
          if (existsSync(versioned)) return versioned
        }
      } catch {
        // An unreadable directory simply has no versioned catalog.
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/**
 * A deployment route whose catalog is a subscription route rather than a
 * metered API route. This controls the pi coding-agent style `(sub)` suffix;
 * it does not change the list-price calculation.
 */
const SUBSCRIPTION_ROUTES = new Set(['codex-personal', 'codex-business'])

/**
 * Which catalog file prices which provider route.
 *
 * pi-ai keys every published price by provider id and model id. A route is a
 * deployment's own name, so this explicit binding is needed for ChatGPT
 * routes whose catalog provider is `openai-codex`.
 */
const CATALOG_PROVIDER_BY_ROUTE = {
  'codex-personal': 'openai-codex',
  'codex-business': 'openai-codex',
}

/**
 * Read one non-negative finite number, falling back when the value is absent.
 * @param value - the reported value, possibly a numeric string.
 * @param fallback - the value to use when the input is not usable.
 * @returns the parsed number, or the fallback.
 */
function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Published list prices, indexed the way pi-ai publishes them: by provider,
 * then by model id.
 *
 * One model id can be described by many catalogs, because the same model may be
 * served by OpenAI, Azure, Copilot, OpenCode, and gateways in between. Keying
 * by provider prevents a route from accidentally receiving another provider's
 * price.
 *
 * @returns provider id to model id to published cost.
 */
function readCatalogs() {
  const index = new Map()
  const dir = piAiCatalogDir()
  if (dir === undefined) return index
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return index
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      // A catalog this process cannot read contributes no price.
      continue
    }
    for (const models of Object.values(parsed)) {
      if (models === null || typeof models !== 'object') continue
      for (const [id, model] of Object.entries(models)) {
        const cost = model?.cost
        if (cost === undefined) continue
        // A catalog model may state its provider; otherwise the file name is
        // the provider id, which is how pi-ai publishes these files.
        const provider = typeof model?.provider === 'string' && model.provider.length > 0
          ? model.provider
          : file.slice(0, -'.json'.length)
        let byModel = index.get(provider)
        if (byModel === undefined) {
          byModel = new Map()
          index.set(provider, byModel)
        }
        if (byModel.has(id)) continue
        byModel.set(id, cost)
      }
    }
  }
  return index
}

/**
 * The published catalogs of this plugin instance, read on first use.
 * @returns a getter for the provider/model price index.
 */
function lazyCatalogs() {
  let index
  return () => (index ??= readCatalogs())
}

/**
 * The catalog provider that prices one route, or undefined when none does.
 * @param catalogs - provider/model price index.
 * @param route - the provider route the Session recorded.
 * @returns the catalog provider id, when one is known to price this route.
 */
function catalogProviderFor(catalogs, route) {
  if (typeof route !== 'string' || route.length === 0) return undefined
  const aliased = CATALOG_PROVIDER_BY_ROUTE[route]
  if (aliased !== undefined) return catalogs.has(aliased) ? aliased : undefined
  return catalogs.has(route) ? route : undefined
}

/**
 * The published rate for one route's model at one reported input size, in USD
 * per token.
 *
 * Catalog prices are quoted per million tokens, and a model may quote a higher
 * tier above a stated input size, so the tier is selected from the step's own
 * uncached input.
 *
 * @param catalogs - provider/model price index.
 * @param route - the provider route the Session recorded.
 * @param modelId - the model id the Session recorded.
 * @param inputTokens - the step's uncached input.
 * @returns the four per-token rates, or undefined when no catalog states them.
 */
function catalogRateFor(catalogs, route, modelId, inputTokens) {
  const provider = catalogProviderFor(catalogs, route)
  if (provider === undefined) return undefined
  const cost = catalogs.get(provider)?.get(modelId)
  if (cost === undefined) return undefined
  let chosen = cost
  for (const tier of cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove) chosen = { ...cost, ...tier }
  }
  return {
    input: positive(chosen.input, 0) / 1000000,
    output: positive(chosen.output, 0) / 1000000,
    cacheRead: positive(chosen.cacheRead, 0) / 1000000,
    cacheWrite: positive(chosen.cacheWrite, 0) / 1000000,
  }
}

/**
 * The four disjoint token counts of one usage report.
 * @param usage - the durable usage object of an Assistant message.
 * @returns the counts, or undefined when any of them is not usable.
 */
function countsOf(usage) {
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens
  const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens
  const values = [input, output, cacheRead, cacheWrite]
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  }
  return { input, output, cacheRead, cacheWrite }
}

/** The list price of one counted step, in USD. */
function priceOf(counts, rate) {
  return counts.input * rate.input + counts.output * rate.output
    + counts.cacheRead * rate.cacheRead + counts.cacheWrite * rate.cacheWrite
}

/**
 * The empty measured state: nothing counted, nothing priced.
 * @returns a fresh state.
 */
function emptyState() {
  return { usd: 0, priced: 0, unpriced: 0, subSteps: 0, last: null }
}

/**
 * Normalize one measured substitution slot: the last settlement that
 * contributed, kept so a superseding settlement can subtract it again.
 * `subscription` here is that one step's route, while the state counts such
 * steps in `subSteps`.
 * @param value - a candidate slot.
 * @returns the normalized slot, or null.
 */
function slotOf(value) {
  if (value === null || typeof value !== 'object') return null
  const turn = Number(value.turn)
  const step = Number(value.step)
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || turn < 0 || step < 0) return null
  return {
    turn,
    step,
    usd: positive(value.usd, 0),
    priced: Number.isSafeInteger(value.priced) && value.priced >= 0 ? value.priced : 0,
    unpriced: Number.isSafeInteger(value.unpriced) && value.unpriced >= 0 ? value.unpriced : 0,
    subscription: value.subscription === true,
  }
}

/**
 * The projection registry consumes schemas through `.parse` only. This plugin
 * keeps zero runtime dependencies, so the state and view seats are served by
 * normalizing validators instead of a schema library: a malformed row becomes
 * a measured zero rather than a crash inside the registry. `subSteps` counts
 * the contributing settlements that came from a subscription route.
 */
const stateSchema = {
  parse(value) {
    const source = value !== null && typeof value === 'object' ? value : {}
    return {
      usd: positive(source.usd, 0),
      priced: Number.isSafeInteger(source.priced) && source.priced >= 0 ? source.priced : 0,
      unpriced: Number.isSafeInteger(source.unpriced) && source.unpriced >= 0 ? source.unpriced : 0,
      subSteps: Number.isSafeInteger(source.subSteps) && source.subSteps >= 0 ? source.subSteps : 0,
      last: slotOf(source.last),
    }
  },
}

/** The client view schema, in the same normalizing style as the state schema. */
const viewSchema = {
  parse(value) {
    const state = stateSchema.parse(value)
    return viewOf(state)
  },
}

/**
 * The client view: whole numbers only, and no substitution slot. `steps` is the
 * count of settlements that contributed, so a Session with nothing to price is
 * distinguishable from one that priced to zero.
 * @param state - the measured state.
 * @returns the whole client value.
 */
function viewOf(state) {
  return {
    usd: state.usd,
    priced: state.priced,
    unpriced: state.unpriced,
    steps: state.priced + state.unpriced,
    subscription: state.subSteps > 0,
  }
}

/**
 * Fold one committed Session event into the measured total.
 *
 * A settlement replaces the slot it supersedes, exactly as the shipped token
 * meter does: `(turn, step)` is the substitution key, so a replayed or amended
 * settlement is counted once, and `llm/retry-started` closes the slot because a
 * retried attempt is billed as well.
 *
 * @param catalogs - provider/model price index.
 * @param state - the measured state.
 * @param event - the committed event.
 * @returns the next state, or the same reference when nothing is measured.
 */
function foldEvent(catalogs, state, event) {
  if (event === null || typeof event !== 'object') return state
  if (event.type === 'llm/retry-started') {
    const data = event.data
    if (state.last === null || data?.turn !== state.last.turn || data?.step !== state.last.step) return state
    return { ...state, last: null }
  }
  if (event.type !== 'assistant/message') return state
  const data = event.data
  if (data === null || typeof data !== 'object' || data.usage === undefined) return state
  const counts = countsOf(data.usage)
  if (counts === undefined) return state
  if (!Number.isSafeInteger(data.turn) || data.turn < 0 || !Number.isSafeInteger(data.step) || data.step < 0) return state
  const source = data.message?.source
  const provider = typeof source?.provider === 'string' ? source.provider : undefined
  const model = typeof source?.model === 'string' ? source.model : undefined
  const rate = provider === undefined || model === undefined ? undefined : catalogRateFor(catalogs, provider, model, counts.input)
  const slot = {
    turn: data.turn,
    step: data.step,
    usd: rate === undefined ? 0 : priceOf(counts, rate),
    priced: rate === undefined ? 0 : 1,
    unpriced: rate === undefined ? 1 : 0,
    subscription: provider !== undefined && SUBSCRIPTION_ROUTES.has(provider),
  }
  const previous = state.last !== null && state.last.turn === slot.turn && state.last.step === slot.step ? state.last : undefined
  // A replay of the settlement already in the slot changes nothing: keep the
  // state reference so the registry can skip a client frame entirely.
  if (previous !== undefined && previous.usd === slot.usd && previous.priced === slot.priced
    && previous.unpriced === slot.unpriced && previous.subscription === slot.subscription) return state
  return {
    usd: state.usd - (previous?.usd ?? 0) + slot.usd,
    priced: state.priced - (previous?.priced ?? 0) + slot.priced,
    unpriced: state.unpriced - (previous?.unpriced ?? 0) + slot.unpriced,
    subSteps: state.subSteps - (previous?.subscription ? 1 : 0) + (slot.subscription ? 1 : 0),
    last: slot,
  }
}

/**
 * Build the projection unit over one catalog source.
 *
 * Exported for tests: the unit is a pure fold plus a view, so it can be driven
 * event by event without a Session, a registry, or the installed catalogs.
 *
 * @param catalogs - getter for the provider/model price index.
 * @returns the projection definition consumed by `ctx.sessionProjections`.
 */
export function createCostUnit(catalogs) {
  return {
    key: COST_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => emptyState(),
    apply: (state, event) => foldEvent(catalogs(), state, event),
    wire: { viewSchema, view: viewOf },
  }
}

/**
 * Compose the host half: register the estimate as a Session projection. The
 * browser half reads the same key through the standard projection hook, so this
 * plugin opens no route, polls nothing, and answers an idle Session with
 * nothing at all.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.sessionProjections.register(createCostUnit(lazyCatalogs())),
    'token-cost: priced Session projection')
}
