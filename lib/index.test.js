import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject } from './index.js'

const PATH = '/api/dsh-token-cost-estimate'

function fixture() {
  const routes = new Map()
  const handlers = new Map()
  const disposers = []
  const sessions = new Map()
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          assert.equal(routes.has(route.path), false)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    // Raw webServer registration is forbidden even if a future change adds it.
    get webServer() { throw new Error('raw webServer bypasses browser authentication') },
    effect(register) { disposers.push(register()) },
    on(name, callback) { handlers.set(name, callback) },
    get(name) { return name === 'sessions' ? sessions : undefined },
  }
  return { ctx, routes, handlers, sessions, dispose: () => disposers.splice(0).reverse().forEach(fn => fn()) }
}

function usageEvent() {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 0,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'codex-personal', model: 'unlisted-test-model' } },
    },
  }
}

test('estimate uses only authenticated connection Fetch route and cleans it up', async () => {
  assert.deepEqual(inject, ['connection'])
  const fixtureState = fixture()
  const { ctx, routes, sessions, dispose } = fixtureState
  apply(ctx)
  assert.deepEqual([...routes.keys()], [PATH])
  const route = routes.get(PATH)
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')

  sessions.set('current', { id: 'current', snapshotEvents: () => [usageEvent()] })
  const result = await route.fetch(new Request(`http://localhost${PATH}?sessionId=current`))
  assert.equal(result.status, 200)
  assert.match(result.headers.get('content-type'), /^application\/json/)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await result.json(), {
    usd: 0,
    priced: 0,
    unpriced: 1,
    subscription: true,
    routes: ['codex-personal/unlisted-test-model'],
  })

  const missing = await route.fetch(new Request(`http://localhost${PATH}?sessionId=other`))
  assert.equal(missing.headers.get('cache-control'), 'no-store')
  assert.equal(await missing.json(), null)
  dispose()
  assert.equal(routes.has(PATH), false)
})

test('event feed keeps the authenticated estimate current', async () => {
  const { ctx, routes, handlers, sessions } = fixture()
  const session = { id: 'live', snapshotEvents: () => [] }
  sessions.set('live', session)
  apply(ctx)
  const route = routes.get(PATH)
  const request = new Request(`http://localhost${PATH}?sessionId=live`)
  assert.equal(await (await route.fetch(request)).json(), null)
  handlers.get('session/event')(session, usageEvent())
  assert.equal((await (await route.fetch(request)).json()).unpriced, 1)
  handlers.get('session/disposed')(session)
  sessions.delete('live')
  assert.equal(await (await route.fetch(request)).json(), null)
})
