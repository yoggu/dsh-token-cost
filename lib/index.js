/**
 * Host half of `dsh-cost-pill`: price every settled Assistant message of a
 * Session and serve the running total to this package's own browser half.
 *
 * Authority runs from the billed amount down to an estimate. OpenRouter settles
 * a generation asynchronously and reports both the upstream provider that
 * served it and the exact charge; that record is the only exact source, so each
 * generation is looked up once and kept forever. Until it settles — and for
 * every provider that has no such record — the pill falls back to the model's
 * published rates applied to the reported token counts, and to a lower bound
 * when those rates are unknown too.
 *
 * @module dsh-cost-pill
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-cost-pill'

/** The timer service drives the throttled lookup pump and the rate refresh. */
export const inject = ['timer', 'webServer']

/**
 * Where the installed pi-ai keeps its per-provider model catalogs.
 *
 * Those files carry the published list price of every model pi-ai describes,
 * which is the only rate source for a route OpenRouter does not serve. The
 * directory is discovered rather than configured because it moves with the
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

/** Public rate table for one model, and the endpoint path that serves it. */
const MODELS_ORIGIN = 'https://openrouter.ai/api/v1/models/'

/** One settled generation record, addressed by the id the response carried. */
const GENERATION_API = 'https://openrouter.ai/api/v1/generation?id='

/** Cadence of the settled lookup pump: one generation at a time, kept gentle. */
const PUMP_MS = 4000

/** Providers may change rates mid-session, so the table is re-read on a cadence. */
const RATE_REFRESH_MS = 300000

/** Credential reference the OpenRouter key is resolved from, per lookup. */
const CREDENTIAL_REF = 'OPENROUTER_API_KEY'

/** Exact route this package's browser half polls. */
const ROUTE_PATH = '/api/dsh-cost-pill'

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** Generation ids are opaque, so only the documented shape is accepted. */
const GENERATION_ID = /^gen-[A-Za-z0-9-]{1,64}$/

/**
 * Read one non-negative finite number, falling back when the value is absent.
 * @param value - the reported value, possibly a numeric string.
 * @param fallback - the value to use when the input is not a usable number.
 * @returns the parsed number, or the fallback.
 */
function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Which catalog file prices which provider route.
 *
 * pi-ai keys every published price by provider id and model id, and that pair
 * is the whole lookup — the coding agent reaches a price the same way, by
 * asking the provider that owns the route for its model. The harness records
 * the route a Session used, and a route is a deployment's own name: this
 * deployment serves its ChatGPT account as `codex-personal`, while the catalog
 * that prices it is `openai-codex`. Nothing in the durable log carries that
 * binding, because the plugin that owns the route holds it in its own config.
 *
 * So the binding is stated here, which is also how the coding agent resolves a
 * custom provider: an explicit declaration rather than a guess about names. A
 * route whose provider is already a catalog provider needs no entry —
 * `openrouter` prices from `openrouter`.
 */
const CATALOG_PROVIDER_BY_ROUTE = {
  'codex-personal': 'openai-codex',
}

/**
 * Published list prices, indexed the way pi-ai publishes them: by provider,
 * then by model id.
 *
 * Read once, on first need: those files are the only rate source for a route
 * OpenRouter does not serve, and a route with no published price stays
 * unpriced rather than being shown as free.
 *
 * The provider key is what makes this exact. One model id is described by many
 * catalogs — the same model is served by OpenAI, Azure, Copilot, OpenCode, and
 * every gateway in between — so a single flat index would let whichever file
 * sorts first answer for all of them, and Azure's file quotes no request-wide
 * tiers. Keyed by provider, a route reaches its own catalog or none.
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
  for (const file of readdirSync(dir)) {
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
        // A model states the provider it belongs to; the file name states the
        // same thing, and is what remains readable if a declaration omits it.
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
 * uncached input rather than from a single flat rate.
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
 * @returns the counts, or undefined when any of them is not a usable count.
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
 * Compose one Session's billed and estimated cost.
 *
 * @param state - the package's fold state.
 * @param sessionId - the Session to report on.
 * @returns the report, or null while nothing can be priced yet.
 */
function reportOf(state, sessionId) {
  const sessions = state.ctx.get('sessions')
  if (sessions === undefined) return null
  const session = sessions.get(sessionId)
  if (session === undefined) return null
  const fold = foldOf(state, session)
  const now = new Date()
  let usd = 0
  let exact = 0
  let estimated = 0
  let unpriced = 0
  let pending = 0
  let listPrice = 0
  const routes = new Set()
  const providers = new Set()
  for (const entry of fold.values()) {
    routes.add(entry.route)
    const billed = entry.generation === undefined ? undefined : state.settled.get(entry.generation)
    if (billed !== undefined) {
      usd += billed.cost
      exact += 1
      providers.add(billed.provider)
      continue
    }
    if (entry.generation !== undefined && !state.rejected.has(entry.generation)) pending += 1
    const rate = entry.model === undefined ? undefined : state.rates.get(entry.model)
    if (rate !== undefined) {
      const applied = rateAt(rate, now)
      usd += entry.counts.input * applied.input + entry.counts.output * applied.output
        + entry.counts.cacheRead * applied.cacheRead + entry.counts.cacheWrite * applied.cacheWrite
      estimated += 1
      continue
    }
    // No live route rate: fall back to the published list price, which is an
    // estimate of what a metered call would cost, not a billed amount. The
    // route decides which published catalog may answer for it.
    const listed = entry.model === undefined || entry.provider === undefined
      ? undefined
      : catalogRateFor(state, entry.provider, entry.model, entry.counts.input)
    if (listed === undefined) {
      unpriced += 1
      continue
    }
    usd += entry.counts.input * listed.input + entry.counts.output * listed.output
      + entry.counts.cacheRead * listed.cacheRead + entry.counts.cacheWrite * listed.cacheWrite
    estimated += 1
    listPrice += 1
  }
  if (exact + estimated === 0) return null
  const labels = [...routes]
  if (providers.size > 0) labels.push(`via ${[...providers].join(', ')}`)
  return { usd, exact, estimated, unpriced, pending, listPrice, routes: labels }
}

/**
 * The applicable rate of one model: its published table, overridden by the
 * first matching UTC window.
 *
 * A window is addressed in per-mille of the UTC day and carries the weekdays it
 * applies to, so a provider can discount off-peak hours without a second
 * request.
 *
 * @param entry - the model's published base table and its override windows.
 * @param now - the moment to price.
 * @returns the four per-token rates in USD.
 */
function rateAt(entry, now) {
  const base = entry.base
  let chosen = base
  const day = DAYS[now.getUTCDay()]
  const elapsed = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()
  const perMille = Math.floor(elapsed / 86.4)
  for (const window of entry.overrides) {
    const days = window.utc_days
    if (!Array.isArray(days) || !days.includes(day)) continue
    const from = positive(window.utc_start, 0)
    const to = positive(window.utc_end, 0)
    const inside = from <= to ? perMille >= from && perMille < to : perMille >= from || perMille < to
    if (inside) {
      chosen = window
      break
    }
  }
  return {
    input: positive(chosen.prompt, positive(base.prompt, 0)),
    output: positive(chosen.completion, positive(base.completion, 0)),
    cacheRead: positive(chosen.input_cache_read, positive(base.input_cache_read, 0)),
    cacheWrite: positive(chosen.input_cache_write, positive(base.input_cache_write, 0)),
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
  const candidate = source?.replayState?.response?.responseId
  const generation = typeof candidate === 'string' && GENERATION_ID.test(candidate) ? candidate : undefined
  if (provider === 'openrouter' && model !== undefined && !state.rates.has(model)) {
    void loadRates(state, model)
  }
  if (generation !== undefined && !state.settled.has(generation) && !state.rejected.has(generation)
    && !state.queue.includes(generation)) {
    state.queue.push(generation)
  }
  fold.set(`${data.turn}:${data.step}`, {
    route: provider !== undefined && model !== undefined ? `${provider}/${model}` : 'unknown route',
    provider,
    model,
    generation,
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
 * Read one model's published rates, replacing any previous table.
 * @param state - the package's fold state.
 * @param modelId - the OpenRouter model id.
 * @returns a promise settling when the refresh attempt is over.
 */
function loadRates(state, modelId) {
  const running = state.inflight.get(modelId)
  if (running !== undefined) return running
  const web = state.ctx.get('web')
  if (web === undefined) return Promise.resolve()
  const attempt = web.fetch({ url: MODELS_ORIGIN + modelId + '/endpoints' }).then((result) => {
    if (result.statusCode !== 200 || result.truncated === true) return
    const endpoints = JSON.parse(result.body.content)?.data?.endpoints
    if (!Array.isArray(endpoints) || endpoints.length === 0) return
    const pricing = endpoints[0].pricing ?? {}
    state.rates.set(modelId, {
      base: pricing,
      overrides: Array.isArray(pricing.overrides) ? pricing.overrides : [],
    })
  }).catch((error) => {
    state.ctx.logger?.warn?.(`dsh-cost-pill: live rates unavailable for ${modelId}: ${String(error)}`)
  })
  state.inflight.set(modelId, attempt)
  void attempt.then(() => { state.inflight.delete(modelId) })
  return attempt
}

/**
 * Ask OpenRouter what one generation was billed.
 *
 * The key is resolved per lookup and passed to `curl` in the child environment,
 * so it never appears on a command line. A failed lookup is remembered and not
 * retried, so a rejected or unknown id cannot spin.
 *
 * @param state - the package's fold state.
 * @param generationId - the id the Assistant message carried.
 * @returns a promise settling when the attempt is over.
 */
async function settle(state, generationId) {
  const credentials = state.ctx.get('credentials')
  const shell = state.ctx.get('shell')
  if (credentials === undefined || shell === undefined) return
  const credential = await credentials.resolve(CREDENTIAL_REF)
  if (typeof credential?.value !== 'string' || credential.value.length === 0) return
  const spec = shell.resolve({
    command: `curl -sS --max-time 20 -H "Authorization: Bearer $${CREDENTIAL_REF}" "${GENERATION_API}${generationId}"`,
    env: { [CREDENTIAL_REF]: credential.value },
    timeoutMs: 25000,
  })
  const result = await shell.run(spec)
  if (result.exitCode !== 0 || result.timedOut === true || result.aborted === true) {
    state.rejected.add(generationId)
    return
  }
  const data = JSON.parse(result.stdout.text)?.data
  const cost = Number(data?.total_cost)
  if (!Number.isFinite(cost) || cost < 0) {
    state.rejected.add(generationId)
    return
  }
  state.settled.set(generationId, {
    cost,
    provider: typeof data.provider_name === 'string' ? data.provider_name : 'unknown provider',
  })
}

/**
 * Compose the host half: fold the durable Session feed, settle generations on a
 * gentle cadence, and answer the browser half on one exact route.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const state = {
    ctx,
    folds: new Map(),
    rates: new Map(),
    settled: new Map(),
    rejected: new Set(),
    inflight: new Map(),
    queue: [],
    pumping: false,
    catalog: undefined,
  }

  const pump = () => {
    if (state.pumping || state.queue.length === 0) return
    const generationId = state.queue.shift()
    if (state.settled.has(generationId) || state.rejected.has(generationId)) return
    state.pumping = true
    settle(state, generationId).catch((error) => {
      state.rejected.add(generationId)
      ctx.logger?.warn?.(`dsh-cost-pill: generation lookup failed for ${generationId}: ${String(error)}`)
    }).then(() => { state.pumping = false })
  }

  ctx.on('session/event', (session, event) => {
    foldEvent(state, foldOf(state, session), event)
  })

  ctx.on('session/disposed', (session) => {
    state.folds.delete(String(session.id))
  })

  ctx.interval(pump, PUMP_MS)

  ctx.interval(() => {
    for (const modelId of state.rates.keys()) void loadRates(state, modelId)
  }, RATE_REFRESH_MS)

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
