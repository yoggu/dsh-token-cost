import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OWNER = '@deepseek-ai/dsh-llm-pi-ai'
const PACKAGE = '@earendil-works/pi-ai'
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
// Explicit route mappings, not a license to price unrelated gateway aliases.
const ROUTES = Object.freeze({
  openrouter: Object.freeze({ catalog: 'openrouter', owner: OWNER, subscription: false,
    label: 'pi-ai catalog API list-price estimate' }),
  'openai-codex': Object.freeze({ catalog: 'openai-codex', owner: OWNER, subscription: true,
    label: 'API-equivalent subscription estimate; not a subscription charge' }),
  // Historic log route IDs remain priceable after the custom adapter is removed.
  // This does not authorize new requests or claim the old route used this copy.
  'codex-business': Object.freeze({ catalog: 'openai-codex', owner: 'legacy dsh-codex-account route',
    subscription: true, label: 'Legacy route; current pi-ai API-equivalent subscription estimate' }),
  'codex-personal': Object.freeze({ catalog: 'openai-codex', owner: 'legacy dsh-codex-account route',
    subscription: true, label: 'Legacy route; current pi-ai API-equivalent subscription estimate' }),
  'deepseek-official': Object.freeze({ catalog: 'deepseek', owner: 'independent deepseek-official mapping',
    subscription: false, label: 'Independent pi-ai DeepSeek catalog estimate; Messages endpoint price not attested' }),
})
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
const tokens = n => Number.isSafeInteger(n) && n >= 0
const sha256 = text => createHash('sha256').update(text).digest('hex')
const within = (root, target) => { const path = relative(root, target); return path && !path.startsWith('..') && !isAbsolute(path) }
const modelId = text => typeof text === 'string' && text.length > 0 && text.length <= 256

/** An explicit, already installed shipped-adapter path may be supplied by offline tests. */
export function ownerPackage(anchor = process.argv[1]) {
  try {
    const manifest = findPackageJSON(OWNER, realpathSync(anchor))
    if (!manifest || JSON.parse(readFileSync(manifest, 'utf8')).name !== OWNER) return null
    return realpathSync(manifest)
  } catch { return null }
}

function costIsValid(cost) {
  if (!cost || typeof cost !== 'object' || Array.isArray(cost) || !PRICE_KEYS.every(key => finite(cost[key]))
    || cost.cacheWrite1h !== undefined) return false
  const tiers = cost.tiers === undefined ? [] : cost.tiers
  if (!Array.isArray(tiers)) return false
  const thresholds = new Set()
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier) || !finite(tier.inputTokensAbove)
      || tier.cacheWrite1h !== undefined || thresholds.has(tier.inputTokensAbove)) return false
    thresholds.add(tier.inputTokensAbove)
    if (!PRICE_KEYS.every(key => tier[key] === undefined || finite(tier[key]))) return false
  }
  return true
}
const freshUsage = counts => ({ input: counts.inputTokens, output: counts.outputTokens,
  cacheRead: counts.cacheReadTokens, cacheWrite: counts.cacheWriteTokens,
  totalTokens: counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })

/**
 * Resolve pi-ai from the physical shipped adapter owner, not this linked consumer,
 * cwd, or a process-wide pi-ai copy. Import the owner's import-only package exports.
 * Three active route IDs plus two legacy historical IDs are admitted.
 * All disk reads finish before fold.
 */
export async function createPricing({ ownerAnchor = process.argv[1] } = {}) {
  const owner = ownerPackage(ownerAnchor)
  if (!owner) return null
  try {
    const manifest = findPackageJSON(PACKAGE, owner)
    if (!manifest) return null
    const resolved = realpathSync(manifest), root = dirname(resolved)
    const packageData = JSON.parse(readFileSync(resolved, 'utf8'))
    if (packageData.name !== PACKAGE || typeof packageData.version !== 'string' || !packageData.version) return null
    const main = packageData.exports?.['.']?.import
    const providers = packageData.exports?.['./providers/*']?.import
    if (typeof main !== 'string' || typeof providers !== 'string' || !providers.includes('*')) return null
    const modulePaths = [main, providers.replace('*', 'all')].map(path => {
      const found = realpathSync(resolve(root, path))
      return within(root, found) ? found : null
    })
    if (modulePaths.some(path => !path)) return null
    const [ai, directory] = await Promise.all(modulePaths.map(path => import(pathToFileURL(path).href)))
    if (typeof ai.calculateCost !== 'function' || typeof directory.getBuiltinModel !== 'function') return null
    const catalogs = new Map()
    for (const catalog of new Set(Object.values(ROUTES).map(route => route.catalog))) {
      const path = realpathSync(join(root, 'dist', 'providers', 'data', `${catalog}.json`))
      if (!within(root, path)) continue
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const original = new Map(), duplicates = new Set()
      for (const group of Object.values(parsed)) {
        if (!group || typeof group !== 'object' || Array.isArray(group)) continue
        for (const [key, entry] of Object.entries(group)) {
          // pi-ai 0.99 uses typed storage keys (chat:<id>, image:<id>, etc.).
          // Settlements and getBuiltinModel still use the bare chat model ID.
          // Admit legacy bare keys and typed chat entries only; another model
          // kind with the same ID must never shadow or price a chat settlement.
          const id = entry?.id
          if (!modelId(id) || (entry.type !== undefined && entry.type !== 'chat')
            || (key !== id && (key !== `chat:${id}` || entry.type !== 'chat'))) continue
          if (original.has(id)) duplicates.add(id)
          original.set(id, entry)
        }
      }
      const models = new Map()
      for (const [id, source] of original) {
        if (!modelId(id) || duplicates.has(id)) continue
        const model = directory.getBuiltinModel(catalog, id)
        if (model?.id !== id || models.has(id) || model.provider !== catalog
          || source?.provider !== catalog || (model.type !== undefined && model.type !== 'chat')
          || model.api !== source.api || !costIsValid(model.cost)
          || JSON.stringify(model.cost) !== JSON.stringify(source.cost)) continue
        // Freeze an owner-local snapshot; never mutate a runtime model while pricing.
        models.set(id, Object.freeze({ id, provider: catalog, api: model.api,
          cost: structuredClone(model.cost) }))
      }
      catalogs.set(catalog, Object.freeze({ models, version: packageData.version, digest: sha256(raw) }))
    }
    return Object.freeze({
      estimate(provider, model, counts) {
        const binding = ROUTES[provider]
        if (!binding || !modelId(model) || !counts || !PRICE_KEYS.every((key, index) =>
          tokens(counts[['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'][index]]))) return null
        const catalog = catalogs.get(binding.catalog), selected = catalog?.models.get(model)
        if (!selected) return null
        // DSH does not log cacheWrite1h: Anthropic-protocol writes cannot be
        // faithfully priced, even though pi-ai supports the richer usage field.
        if (selected.api === 'anthropic-messages' && counts.cacheWriteTokens > 0) return null
        const usage = freshUsage(counts)
        if (!tokens(usage.totalTokens)) return null
        try {
          const calculated = ai.calculateCost(selected, usage)
          if (!calculated || !PRICE_KEYS.every(key => finite(calculated[key])) || !finite(calculated.total)
            || Math.abs(calculated.total - PRICE_KEYS.reduce((n, key) => n + calculated[key], 0)) > 1e-9) return null
          return Object.freeze({ usd: calculated.total, source: Object.freeze({ package: PACKAGE,
            version: catalog.version, catalog: binding.catalog, owner: binding.owner, digest: catalog.digest,
            subscription: binding.subscription, label: binding.label }) })
        } catch { return null }
      },
    })
  } catch { return null }
}
