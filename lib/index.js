/**
 * Host half of `dsh-token-cost-estimate`: estimate the cost of every Assistant message
 * in a Session from the published pi-ai model catalogs, then serve the running
 * total to this package's browser half.
 *
 * This is deliberately an estimate. It uses the same provider/model catalogs
 * as pi-ai and does not attempt to ask a gateway what an account was billed.
 * That keeps the pill deterministic, credential-free, and useful for routes
 * such as Codex subscriptions where there is no per-request bill to settle.
 *
 * @module dsh-token-cost-estimate
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-token-cost-estimate'

/** The web server serves the running estimate to the browser half. */
export const inject = ['webServer']

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
 * Legacy route retained for runtime compatibility with deployed browser bundles.
 * The package-facing identity is dsh-token-cost-estimate; this API path remains
 * a protocol contract shared by the host and browser halves.
 */
const ROUTE_PATH = '/api/dsh-cost-pill'

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
 * @param state - the package's fold state.
 * @returns provider id to model id to published cost.
 */
function catalogIndex(state) {
  if (state.catalog !== undefined) return state.catalog
  const index = new Map()
  state.catalog = index
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
 * The catalog provider that prices one route, or undefined when none does.
 * @param state - the package's fold state.
 * @param route - the provider route the Session recorded.
 * @returns the catalog provider id, when one is known to price this route.
 */
function catalogProviderFor(state, route) {
  if (typeof route !== 'string' || route.length === 0) return undefined
  const index = catalogIndex(state)
  const aliased = CATALOG_PROVIDER_BY_ROUTE[route]
  if (aliased !== undefined) return index.has(aliased) ? aliased : undefined
  return index.has(route) ? route : undefined
}

/**
 * The published rate for one route's model at one reported input size, in USD
 * per token.
 *
 * Catalog prices are quoted per million tokens, and a model may quote a higher
 * tier above a stated input size, so the tier is selected from the step's own
 * uncached input.
 *
 * @param state - the package's fold state.
 * @param route - the provider route the Session recorded.
 * @param modelId - the model id the Session recorded.
 * @param inputTokens - the step's uncached input.
 * @returns the four per-token rates, or undefined when no catalog states them.
 */
function catalogRateFor(state, route, modelId, inputTokens) {
  const provider = catalogProviderFor(state, route)
  if (provider === undefined) return undefined
  const cost = catalogIndex(state).get(provider)?.get(modelId)
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

/**
 * Estimate one Session's cost from pi-ai's published catalog rates.
 *
 * @param state - the package's fold state.
 * @param sessionId - the Session to report on.
 * @returns the report, or null while the Session has no Assistant usage.
 */
function reportOf(state, sessionId) {
  const sessions = state.ctx.get('sessions')
  if (sessions === undefined) return null
  const session = sessions.get(sessionId)
  if (session === undefined) return null
  const fold = foldOf(state, session)
  if (fold.size === 0) return null

  let usd = 0
  let priced = 0
  let unpriced = 0
  let subscription = false
  const routes = new Set()
  for (const entry of fold.values()) {
    routes.add(entry.route)
    subscription ||= SUBSCRIPTION_ROUTES.has(entry.provider)
    const listed = entry.model === undefined || entry.provider === undefined
      ? undefined
      : catalogRateFor(state, entry.provider, entry.model, entry.counts.input)
    if (listed === undefined) {
      unpriced += 1
      continue
    }
    usd += entry.counts.input * listed.input + entry.counts.output * listed.output
      + entry.counts.cacheRead * listed.cacheRead + entry.counts.cacheWrite * listed.cacheWrite
    priced += 1
  }

  return {
    usd,
    priced,
    unpriced,
    subscription,
    routes: [...routes],
  }
}

/**
 * Fold one durable event into its Session's per-step record.
 * @param state - the package's fold state.
 * @param fold - the Session's map, keyed by `turn:step`.
 * @param event - the appended durable event.
 */
function foldEvent(state, fold, event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return
  const data = event.data
  if (data === null || typeof data !== 'object' || data.usage === undefined) return
  const counts = countsOf(data.usage)
  if (counts === undefined || typeof data.turn !== 'number' || typeof data.step !== 'number') return
  const source = data.message?.source
  const provider = typeof source?.provider === 'string' ? source.provider : undefined
  const model = typeof source?.model === 'string' ? source.model : undefined
  fold.set(`${data.turn}:${data.step}`, {
    route: provider !== undefined && model !== undefined ? `${provider}/${model}` : 'unknown route',
    provider,
    model,
    counts,
  })
}

/**
 * The fold of one Session, seeded from its durable log on first use.
 * @param state - the package's fold state.
 * @param session - the live Session.
 * @returns the Session's per-step map.
 */
function foldOf(state, session) {
  const id = String(session.id)
  const existing = state.folds.get(id)
  if (existing !== undefined) return existing
  const fold = new Map()
  state.folds.set(id, fold)
  for (const event of session.snapshotEvents()) foldEvent(state, fold, event)
  return fold
}

/**
 * Compose the host half: fold the durable Session feed and answer the browser
 * half on one exact route.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const state = {
    ctx,
    folds: new Map(),
    catalog: undefined,
  }

  ctx.on('session/event', (session, event) => {
    foldEvent(state, foldOf(state, session), event)
  })

  ctx.on('session/disposed', (session) => {
    state.folds.delete(String(session.id))
  })

  ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      let sessionId
      try {
        sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId')
      } catch {
        // A malformed request line has no session to report on.
        sessionId = null
      }
      // The session store is resolved per request: a store that arrives after
      // this row activates must still be able to answer.
      const report = sessionId === null ? null : reportOf(state, sessionId)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(report))
    },
  })
}
