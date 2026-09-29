import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPricing, ownerPackage } from './pricing.js'
import { COST_KEY, createCostUnit } from './index.js'

const base = { input: 1, output: 2, cacheRead: .1, cacheWrite: 0 }
function fixture(t, catalogs = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-token-cost-owner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
  const pkg = join(root, 'node_modules', '@earendil-works', 'pi-ai')
  const data = join(pkg, 'dist', 'providers', 'data')
  mkdirSync(owner, { recursive: true }); mkdirSync(data, { recursive: true })
  writeFileSync(join(owner, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai' }))
  writeFileSync(join(owner, 'index.js'), '// owner anchor')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.99.0', type: 'module',
    exports: { '.': { import: './dist/index.js' }, './providers/*': { import: './dist/providers/*.js' } } }))
  for (const catalog of ['openrouter', 'openai-codex', 'deepseek'])
    writeFileSync(join(data, `${catalog}.json`), JSON.stringify({ fixture: catalogs[catalog] ?? {} }))
  writeFileSync(join(pkg, 'dist', 'providers', 'all.js'), `import openrouter from './data/openrouter.json' with {type:'json'};
    import codex from './data/openai-codex.json' with {type:'json'};
    import deepseek from './data/deepseek.json' with {type:'json'};
    export function getBuiltinModel(provider,id){const raw=({openrouter,'openai-codex':codex,deepseek})[provider];
      return raw?Object.values(raw).flatMap(group=>Object.values(group)).find(model=>model?.id===id&&(!model.type||model.type==='chat')):undefined}`)
  writeFileSync(join(pkg, 'dist', 'index.js'), `export function calculateCost(model,usage){
    const total=usage.input+usage.cacheRead+usage.cacheWrite;let chosen=model.cost;
    for(const tier of model.cost.tiers??[])if(total>tier.inputTokensAbove)chosen={...chosen,...tier};
    for(const key of ['input','output','cacheRead','cacheWrite'])usage.cost[key]=usage[key]*chosen[key]/1e6;
    usage.cost.total=usage.cost.input+usage.cost.output+usage.cost.cacheRead+usage.cost.cacheWrite;
    return usage.cost}`)
  return { anchor: join(owner, 'index.js'), data }
}
const model = (catalog, id, cost = base, api = 'openai-completions') =>
  ({ id, provider: catalog, api, cost })
const event = (seq, provider, modelId, usage = { inputTokens: 500, outputTokens: 0, cacheReadTokens: 501 }) =>
  ({ seq, type: 'assistant/message', data: { turn: seq, step: 0, usage,
    message: { source: { kind: 'model', provider, model: modelId } } } })

/** Model the registry's version-gated cold restore, without modifying real session storage. */
function coldReplay(definition, checkpoint, events) {
  const row = checkpoint[COST_KEY], usable = row?.ver === definition.stateVersion
  const state = events.filter(entry => !usable || entry.seq > row.seq)
    .reduce((value, entry) => definition.apply(value, entry), usable ? definition.stateSchema.parse(row.val) : definition.init())
  return { view: definition.wire.view(state), checkpoint: { [COST_KEY]: { ver: definition.stateVersion,
    seq: events.at(-1)?.seq ?? -1, val: definition.stateSchema.parse(state) } } }
}

test('resolves shipped owner physically, not consumer cwd; pi-ai formula chooses full-input tier', async t => {
  const { anchor, data } = fixture(t, { openrouter: {
    tiered: model('openrouter', 'tiered', { ...base,
      tiers: [{ inputTokensAbove: 1000, input: 4, output: 8, cacheRead: .4, cacheWrite: 0 }] }),
  } })
  assert.match(ownerPackage(anchor), /dsh-llm-pi-ai\/package.json$/)
  const pricing = await createPricing({ ownerAnchor: anchor })
  assert.ok(pricing)
  assert.equal(pricing.estimate('unknown-provider', 'tiered', {inputTokens:1,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}), null)
  assert.equal(pricing.estimate('openrouter', 'unlisted', {inputTokens:1,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}), null)
  const value = pricing.estimate('openrouter', 'tiered',
    { inputTokens: 500, outputTokens: 0, cacheReadTokens: 501, cacheWriteTokens: 0 })
  assert.ok(Math.abs(value.usd - (500*4+501*.4)/1e6) < 1e-12)
  assert.deepEqual({ owner: value.source.owner, catalog: value.source.catalog, version: value.source.version },
    {owner:'@deepseek-ai/dsh-llm-pi-ai',catalog:'openrouter',version:'0.99.0'})
  assert.match(value.source.digest,/^[a-f0-9]{64}$/)
  assert.equal(value.source.label,'pi-ai catalog API list-price estimate')
  const staged = createCostUnit(pricing)
  const before = coldReplay(staged, { [COST_KEY]: { ver: 4, seq: 1,
    val: { usd: 1000, priced: 10, unpriced: 0 } } }, [event(1,'openrouter','tiered')])
  assert.equal(before.checkpoint[COST_KEY].ver,6)
  assert.equal(before.view.priced,1)
  assert.ok(Math.abs(before.view.usd-value.usd)<1e-12)
  assert.deepEqual(coldReplay(staged,before.checkpoint,[event(1,'openrouter','tiered')]).view,before.view)
  // A fold reads neither the catalog nor the network after initialization.
  rmSync(data,{recursive:true,force:true})
  assert.equal(staged.wire.view(staged.apply(staged.init(),event(1,'openrouter','tiered'))).usd,value.usd)
})

test('pi-ai 0.99 typed chat keys price bare IDs, exclude other kinds and replay v5 checkpoints', async t => {
  const chat = (catalog, id, cost = base) => ({ ...model(catalog, id, cost), type: 'chat' })
  const { anchor } = fixture(t, {
    openrouter: {
      'chat:vendor/typed': chat('openrouter', 'vendor/typed'),
      'image:vendor/typed': { ...model('openrouter', 'vendor/typed', { ...base, input: 99 }), type: 'image' },
      'classifier:vendor/classifier': { ...model('openrouter', 'vendor/classifier'), type: 'classifier' },
      'chat:vendor/mismatch': chat('openrouter', 'vendor/different-id'),
      'chat:vendor/untyped': model('openrouter', 'vendor/untyped'),
    },
    'openai-codex': { 'chat:codex-typed': chat('openai-codex', 'codex-typed', { ...base, input: 2 }) },
    deepseek: { 'chat:deepseek-typed': chat('deepseek', 'deepseek-typed', { ...base, input: .3 }) },
  })
  const pricing = await createPricing({ ownerAnchor: anchor })
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(pricing.estimate('openrouter', 'vendor/typed', usage)?.usd, 1)
  assert.equal(pricing.estimate('openai-codex', 'codex-typed', usage)?.usd, 2)
  assert.equal(pricing.estimate('deepseek-official', 'deepseek-typed', usage)?.usd, .3)
  for (const id of ['chat:vendor/typed', 'vendor/classifier', 'vendor/mismatch', 'vendor/different-id', 'vendor/untyped'])
    assert.equal(pricing.estimate('openrouter', id, usage), null)
  const definition = createCostUnit(pricing)
  const replayed = coldReplay(definition, { [COST_KEY]: { ver: 5, seq: 1,
    val: { usd: 0, priced: 0, unpriced: 1 } } }, [event(1, 'openrouter', 'vendor/typed', usage)])
  assert.equal(replayed.checkpoint[COST_KEY].ver, 6)
  assert.equal(replayed.view.usd, 1)
  assert.equal(replayed.view.priced, 1)
  assert.equal(replayed.view.unpriced, 0)
  assert.deepEqual(coldReplay(definition, replayed.checkpoint,
    [event(1, 'openrouter', 'vendor/typed', usage)]).view, replayed.view)
})

test('typed and legacy chat entries with the same bare ID are ambiguous and stay unpriced', async t => {
  const { anchor } = fixture(t, { openrouter: {
    duplicate: model('openrouter', 'duplicate'),
    'chat:duplicate': { ...model('openrouter', 'duplicate'), type: 'chat' },
  } })
  const pricing = await createPricing({ ownerAnchor: anchor })
  assert.equal(pricing.estimate('openrouter', 'duplicate',
    { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null)
})

test('a nested owner pi-ai wins over a different ambient copy',async t=>{
  const {anchor}=fixture(t,{openrouter:{local:model('openrouter','local',{...base,input:1})}})
  const packageRoot=join(anchor,'..')
  const top=join(packageRoot,'..','..','@earendil-works','pi-ai')
  const nested=join(packageRoot,'node_modules','@earendil-works','pi-ai')
  mkdirSync(join(packageRoot,'node_modules','@earendil-works'),{recursive:true})
  renameSync(top,nested)
  // An ambient copy exists but must never price the route when owner nests pi-ai.
  const alternate=join(top,'dist','providers','data')
  mkdirSync(alternate,{recursive:true})
  writeFileSync(join(top,'package.json'),JSON.stringify({name:'@earendil-works/pi-ai',version:'9.9.9'}))
  const pricing=await createPricing({ownerAnchor:anchor})
  const quote=pricing?.estimate('openrouter','local',{inputTokens:1_000_000,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0})
  assert.equal(quote?.usd,1)
  assert.equal(quote.source.version,'0.99.0')
})

test('a changed on-disk catalog cannot mislabel an already imported pi-ai model',async t=>{
  const {anchor,data}=fixture(t,{openrouter:{repriced:model('openrouter','repriced',base)}})
  // Module import sees a different installed model from the observed catalog.
  const first=await createPricing({ownerAnchor:anchor})
  assert.equal(first.estimate('openrouter','repriced',{inputTokens:1_000_000,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0})?.usd,1)
  writeFileSync(join(data,'openrouter.json'),JSON.stringify({fixture:{repriced:model('openrouter','repriced',
    {...base,input:10})}}))
  const second=await createPricing({ownerAnchor:anchor})
  assert.equal(second.estimate('openrouter','repriced',{inputTokens:1_000_000,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}),null)
})

test('Codex subscription and independent DeepSeek route use only explicit catalog identities',async t=>{
  const {anchor}=fixture(t, {'openai-codex':{'gpt-6-sol':model('openai-codex','gpt-6-sol',{...base,input:2})},
    deepseek:{'deepseek-flash':model('deepseek','deepseek-flash',{...base,input:.3})}})
  const pricing=await createPricing({ownerAnchor:anchor})
  const usage={inputTokens:1_000_000,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}
  const codex=pricing.estimate('openai-codex','gpt-6-sol',usage)
  assert.equal(codex.usd,2); assert.equal(codex.source.subscription,true)
  assert.match(codex.source.label,/not a subscription charge/)
  const deepseek=pricing.estimate('deepseek-official','deepseek-flash',usage)
  assert.equal(deepseek.usd,.3)
  assert.equal(deepseek.source.catalog,'deepseek')
  assert.match(deepseek.source.label,/independent/i)
  const old = pricing.estimate('codex-business','gpt-6-sol',usage)
  assert.equal(old.usd,2);assert.equal(old.source.subscription,true)
  assert.match(old.source.label,/Legacy route/)
  assert.equal(old.source.owner,'legacy dsh-codex-account route')
  assert.equal(pricing.estimate('codex-personal','gpt-6-sol',usage)?.usd,2)
  assert.equal(pricing.estimate('codex-unreviewed','gpt-6-sol',usage),null)
  assert.equal(pricing.estimate('deepseek-official','gpt-6-sol',usage),null)
  assert.equal(pricing.estimate('deepseek', 'deepseek-flash',usage),null)
})

test('malformed prices, duplicate models, uncertain 1h writes and missing owner fail closed',async t=>{
  const {anchor,data}=fixture(t,{openrouter:{bad:model('openrouter','bad',{...base,cacheRead:-1}),
    '1h':model('openrouter','1h',{...base,cacheWrite1h:4},'anthropic-messages'),
    uncertain:model('openrouter','uncertain',base,'anthropic-messages'),
    duplicate:model('openrouter','duplicate',base)},
    deepseek:{stranger:model('other','stranger',base)}})
  writeFileSync(join(data,'openrouter.json'),JSON.stringify({fixture: {
    bad:model('openrouter','bad',{...base,cacheRead:-1}),
    '1h':model('openrouter','1h',{...base,cacheWrite1h:4},'anthropic-messages'),
    uncertain:model('openrouter','uncertain',base,'anthropic-messages'),
    duplicate:model('openrouter','duplicate',base)},
    second:{duplicate:model('openrouter','duplicate',base)}}))
  const pricing=await createPricing({ownerAnchor:anchor})
  const usage={inputTokens:1,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:1}
  assert.equal(pricing.estimate('openrouter','bad',usage),null)
  assert.equal(pricing.estimate('openrouter','1h',usage),null)
  assert.equal(pricing.estimate('openrouter','uncertain',usage),null)
  assert.equal(pricing.estimate('openrouter','duplicate',usage),null)
  assert.equal(pricing.estimate('deepseek-official','stranger',usage),null)
  assert.equal(pricing.estimate('openrouter','bad',{...usage,inputTokens:-1}),null)
  assert.equal(ownerPackage(join(anchor,'absent')),null)
  assert.equal(await createPricing({ownerAnchor:join(anchor,'absent')}),null)
})
