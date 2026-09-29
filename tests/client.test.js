import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const KEY = 'dsh-token-cost.cost'
const span = (node) => (typeof node === 'object' && node ? [node, ...node.props.children.flatMap(span)].find(part => typeof part === 'object' && part?.props?.className === 'dsh-token-cost') : undefined)
const textOf = (node) => typeof node === 'object' && node
  ? node.props.children.map(textOf).filter(part => part !== '').join(' ')
  : String(node ?? '')

// Exercise the registered readout and its actual hooks; no browser, private UI
// imports, network requests, or repeating timers are involved.
function fixture({ projection } = {}) {
  const state = [], effects = [], pending = [], calls = { fetch: 0, intervals: 0 }
  let cursor = 0, effectCursor = 0, plugin, component, key
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) } }),
    useState: initial => {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef: initial => { const index = cursor++; return state[index] ||= { current: initial } },
    useEffect: (callback, deps) => {
      const index = effectCursor++, previous = effects[index]
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return
      pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: callback() } })
    },
    Fragment: 'fragment', useId: () => 'readout-help',
  }
  const noop = () => {}
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => name === 'react' ? React : { createPortal: node => node }) } }, addEventListener: noop, removeEventListener: noop, innerWidth: 1200 },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: noop }, body: {}, addEventListener: noop, removeEventListener: noop },
    setTimeout: () => 0, clearTimeout: noop,
    setInterval: () => { calls.intervals += 1; return 0 },
    fetch: () => { calls.fetch += 1; throw new Error('the readout must not request anything') },
  })
  const ctx = { effect: callback => callback(), slots: {
    inject: (_key, register) => register(),
    register: (options, value) => { if (options.name === 'conversation.composer.dock') component = value },
  } }
  plugin.apply(ctx)
  const render = (props = { sessionId: 's' }) => {
    cursor = 0; effectCursor = 0
    const tree = component({ useProjection: wanted => { key = wanted; return projection }, ...props })
    while (pending.length) pending.shift()()
    return span(tree)
  }
  return { render, calls, key: () => key, unmount: () => effects.forEach(effect => effect.cleanup?.()) }
}

test('the readout subscribes to the host projection and issues no request', () => {
  const f = fixture()
  const node = f.render()
  assert.equal(f.key(), KEY)
  assert.equal(textOf(node), '$0.000')
  assert.equal(node.props.style.opacity, 0.5, 'an absent projection is unavailable, not zero')
  assert.equal(f.calls.fetch, 0)
  assert.equal(f.calls.intervals, 0)
  f.unmount()
})

test('a measured estimate renders price and a short subscription tooltip', () => {
  const report = { usd: 1.2345, priced: 2, unpriced: 0, steps: 2, subscription: true }
  const f = fixture({ projection: report })
  const node = f.render()
  assert.equal(textOf(node), '$1.234 (sub)')
  assert.equal(node.props.style.opacity, 1)
  assert.equal(node.props.children[1].props.text, 'Estimated cost · subscription')

  node.props.onMouseEnter()
  const hovered = f.render()
  assert.equal(hovered.props['aria-describedby'], 'readout-help')
  f.unmount()
})

test('tooltip omits catalog provenance and detailed caveats', () => {
  const source = { package: '@earendil-works/pi-ai', version: '0.87.1', catalog: 'openrouter',
    digest: 'abc123', owner: '@deepseek-ai/dsh-llm-pi-ai', subscription: false,
    label: 'pi-ai catalog API list-price estimate', count: 2 }
  const f = fixture({ projection: { usd: 0.5, priced: 2, unpriced: 1, steps: 3,
    subscription: false, sources: [source] } })
  const node = f.render()
  assert.equal(textOf(node), '$0.500')
  assert.equal(node.props.children[1].props.text, 'Estimated cost')
  f.unmount()
})

test('a partly unpriced session dims the readout without extra tooltip detail', () => {
  const f = fixture({ projection: { usd: 0.5, priced: 1, unpriced: 1, steps: 2, subscription: false } })
  const node = f.render()
  assert.equal(textOf(node), '$0.500')
  assert.equal(node.props.style.opacity, 0.75)
  assert.equal(node.props.children[1].props.text, 'Estimated cost')
  f.unmount()
})

test('a session with nothing priced reports unavailable rather than zero', () => {
  const f = fixture({ projection: { usd: 0, priced: 0, unpriced: 0, steps: 0, subscription: false } })
  const node = f.render()
  assert.equal(textOf(node), '$0.000')
  assert.equal(node.props.style.opacity, 0.5)
  assert.equal(node.props.children[1].props.text, 'Cost estimate unavailable')
  f.unmount()
})
