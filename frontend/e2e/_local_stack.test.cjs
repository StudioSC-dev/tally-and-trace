// Self-check for the DATABASE_URL guard: node --test frontend/e2e/_local_stack.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const { refuseDatabaseUrl, consumePageOpen } = require('./_local_stack.cjs')

const refused = (url) => assert.notEqual(refuseDatabaseUrl(url), null, url)

test('accepts a plain local throwaway URL', () => {
  assert.equal(refuseDatabaseUrl('postgresql://u:p@127.0.0.1:55417/tt_test_x'), null)
  assert.equal(refuseDatabaseUrl('postgresql+psycopg2://u:p@localhost/tally_trace_test'), null)
})

test('refuses an ambiguous multi-@ comma-host authority', () => {
  refused('postgresql://u:p@db.example.com,127.0.0.1@localhost/tt_test_x')
})

test('refuses a second unescaped @ even without a comma', () => {
  refused('postgresql://u:p@db.example.com@localhost/tt_test_x')
})

test('refuses a comma host', () => {
  refused('postgresql://u:p@127.0.0.1,db.example.com/tt_test_x')
  refused('postgresql://u,x:p@localhost/tt_test_x')
})

test('refuses a remote host', () => {
  refused('postgresql://u:p@db.example.com/tt_test_x')
})

test('refuses a query string and a non-throwaway database', () => {
  refused('postgresql://u:p@localhost/tt_test_x?host=db.example.com')
  refused('postgresql://u:p@localhost/production')
})

test('accepts an escaped @ in the password', () => {
  assert.equal(refuseDatabaseUrl('postgresql://u:p%40ss@localhost/tt_test_x'), null)
})

test('consumePageOpen sends one page_open POST as the user and returns the response', async () => {
  const calls = []
  const api = async (...args) => { calls.push(args); return { status: 200, json: { throttled: false, posted: 0 } } }
  assert.deepEqual(await consumePageOpen(api, { token: 't1' }), { throttled: false, posted: 0 })
  assert.deepEqual(calls, [['t1', 'POST', '/budget-entries/post-due-installments', { trigger: 'page_open' }]])
})

test('consumePageOpen throws on anything but 200', async () => {
  await assert.rejects(consumePageOpen(async () => ({ status: 404, json: { detail: 'x' } }), { token: 't' }), /consumePageOpen: 404/)
})
