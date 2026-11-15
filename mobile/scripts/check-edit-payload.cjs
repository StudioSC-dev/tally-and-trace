#!/usr/bin/env node
// STU-243 acceptance checks for the mobile transaction form and the stale forecast contracts.
// Run: node mobile/scripts/check-edit-payload.cjs [--skip-build]
// Loads the real transactions.tsx (transpiled in memory, react-native stubbed) and drives the form.
'use strict'
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { execFileSync, spawnSync } = require('child_process')

const mobileDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(mobileDir, '..')
const ts = require(require.resolve('typescript', { paths: [mobileDir] }))
const FORM_PATH = path.join(mobileDir, 'app', '(tabs)', 'transactions.tsx')

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
}

function runModule(code, req) {
  const module = { exports: {} }
  new Function('require', 'exports', 'module', code)(req, module.exports, module)
  return module.exports
}

// The shared helper is real; everything else the screen imports is stubbed.
function loadShared() {
  const file = path.join(repoRoot, 'packages', 'shared', 'src', 'utils', 'transfer.ts')
  return runModule(transpile(fs.readFileSync(file, 'utf8'), file), () => {
    throw new Error('transfer.ts must not import')
  })
}

function loadForm(transformSource = (s) => s) {
  const calls = { alerts: [], create: [], update: [] }
  const host = (name) => name
  const stubs = {
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props: { ...props } }),
      jsxs: (type, props) => ({ type, props: { ...props } }),
      Fragment: 'Fragment',
    },
    react: { useState: (...a) => state.useState(...a) },
    'react-native': {
      FlatList: host('FlatList'), View: host('View'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity'),
      RefreshControl: host('RefreshControl'), Modal: host('Modal'), ScrollView: host('ScrollView'),
      Alert: { alert: (title, message) => calls.alerts.push({ title, message }) },
    },
    'react-native-safe-area-context': { SafeAreaView: host('SafeAreaView') },
    '../../src/store/api': new Proxy({}, {
      get: (_t, key) => {
        if (key === 'useCreateTransactionMutation') {
          return () => [(data) => (calls.create.push(data), { unwrap: async () => ({}) }), { isLoading: false }]
        }
        if (key === 'useUpdateTransactionMutation') {
          return () => [(arg) => (calls.update.push(arg), { unwrap: async () => ({}) }), { isLoading: false }]
        }
        return () => ({})
      },
    }),
    '../../src/contexts/AuthContext': { useAuth: () => ({ user: { default_currency: 'PHP' } }) },
    '@tally-trace/shared': {
      ...loadShared(),
      categoryOptionLabel: (c) => c.name, formatCurrency: String, formatRelativeDate: String,
      transactionDate: String, transactionDescription: String,
    },
    '../../src/utils/currencyDisplay': { isCrossCurrencyTransfer: () => false },
    '../../src/components/ui': {
      Card: host('Card'), Button: host('Button'), Input: host('Input'), LoadingSpinner: host('LoadingSpinner'),
      EmptyState: host('EmptyState'), Badge: host('Badge'), SectionHeader: host('SectionHeader'),
    },
  }
  const state = { slots: [], idx: 0, useState(init) {
    const i = state.idx++
    if (!(i in state.slots)) state.slots[i] = typeof init === 'function' ? init() : init
    return [state.slots[i], (v) => { state.slots[i] = typeof v === 'function' ? v(state.slots[i]) : v }]
  } }
  const source = transformSource(fs.readFileSync(FORM_PATH, 'utf8'))
  const exp = runModule(transpile(source, FORM_PATH), (name) => {
    if (!(name in stubs)) throw new Error(`unstubbed import ${name}`)
    return stubs[name]
  })
  return { exp, calls, state }
}

function walk(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  walk(node.props && node.props.children, out)
  return out
}

// Mounts the form and returns a driver; every action re-renders so handlers are never stale.
function mountForm(form, props) {
  form.state.slots = []
  const render = () => { form.state.idx = 0; return form.exp.TransactionFormModal(props) }
  const find = (id) => walk(render()).find((n) => n.props.testID === id)
  return {
    render,
    find,
    byLabel: (label) => walk(render()).find((n) => n.props.label === label),
    press: (id) => { const n = find(id); assert(n, `no element ${id}`); n.props.onPress() },
    ids: () => walk(render()).map((n) => n.props.testID).filter(Boolean),
    async submit() { await find('submit').props.onPress() },
  }
}

const ACCOUNTS = [
  { id: 1, name: 'Checking USD', currency: 'USD', permissions: { can_add_transactions: true } },
  { id: 2, name: 'Savings EUR', currency: 'EUR', permissions: { can_add_transactions: true } },
]
const RECORD = {
  view: 'full', id: 10, description: 'old note', amount: 50, transaction_type: 'debit', account_id: 1,
  currency: 'EUR', transaction_date: '2026-03-01T00:00:00Z', category_id: 3,
}
const baseProps = (extra) => ({ visible: true, onClose: () => {}, accounts: ACCOUNTS, categories: [], defaultCurrency: 'PHP', ...extra })
// Transfer fields belong to STU-262; the other fields are compared as they were on main.
const stripTransfer = (p) => {
  const o = JSON.parse(JSON.stringify(p))
  delete o.transfer_from_account_id
  delete o.transfer_to_account_id
  return o
}

async function editPayload(form) {
  const ui = mountForm(form, baseProps({ initial: RECORD }))
  ui.byLabel('Description (optional)').props.onChangeText('new note')
  await ui.submit()
  assert.strictEqual(form.calls.update.length, 1, 'edit was not submitted')
  assert.strictEqual(form.calls.update[0].id, 10)
  return form.calls.update[0].data
}

async function aEditKeepsCurrency(form) {
  const data = await editPayload(form)
  assert(data.currency === 'EUR' || data.currency === undefined, `edit sent currency ${data.currency}`)
  assert.deepStrictEqual(stripTransfer(data), {
    description: 'new note', amount: 50, transaction_type: 'debit', account_id: 1, category_id: 3,
    transaction_date: '2026-03-01T00:00:00.000Z', currency: 'EUR',
  })
}

async function bCreateUsesAccountCurrency(form) {
  const ui = mountForm(form, baseProps({}))
  ui.press('account-2')
  ui.byLabel('Amount').props.onChangeText('12.5')
  ui.byLabel('Description (optional)').props.onChangeText('coffee')
  await ui.submit()
  assert.strictEqual(form.calls.create.length, 1, 'create was not submitted')
  assert.deepStrictEqual(stripTransfer(form.calls.create[0]), {
    description: 'coffee', amount: 12.5, transaction_type: 'debit', account_id: 2,
    transaction_date: new Date(new Date().toISOString().split('T')[0]).toISOString(), currency: 'EUR',
  })
}

function cStaleContractsRemoved() {
  const read = (...p) => fs.readFileSync(path.join(repoRoot, ...p), 'utf8')
  const names = ['CashFlowProjection', 'UpcomingBill', 'NetDisposableIncome']
  const hooks = ['useGetCashFlowProjectionQuery', 'useGetUpcomingBillsQuery', 'useGetNetDisposableIncomeQuery',
    'getCashFlowProjection', 'getUpcomingBills', 'getNetDisposableIncome']
  const urls = ['forecast/cash-flow-projection', 'forecast/upcoming-bills', 'forecast/net-disposable-income']
  const mobileApi = read('mobile', 'src', 'store', 'api.ts')
  for (const t of [...names, ...hooks, ...urls]) assert(!mobileApi.includes(t), `mobile api.ts still has ${t}`)
  const shared = read('packages', 'shared', 'src', 'types', 'api.ts')
  for (const n of [...names, 'MonthlySummary']) {
    assert(!new RegExp(`\\b(interface|type)\\s+${n}\\b`).test(shared), `shared types still declare ${n}`)
  }
  assert(!read('frontend', 'src', 'store', 'api.ts').match(/\b(CashFlowProjection|UpcomingBill|NetDisposableIncome|MonthlySummary)\b/), 'frontend api.ts still references a removed type')
  // No mobile source requests the old routes.
  const grep = spawnSync('git', ['grep', '-nE', urls.join('|'), '--', 'mobile', ':!mobile/scripts'], { cwd: repoRoot, encoding: 'utf8' })
  assert.strictEqual(grep.status, 1, `mobile still requests a stale forecast route:\n${grep.stdout}`)
}

function dWebBuild() {
  const r = spawnSync('pnpm', ['build'], { cwd: repoRoot, encoding: 'utf8', timeout: 540000 })
  assert.strictEqual(r.status, 0, `pnpm build failed\n${(r.stdout || '').slice(-1500)}${(r.stderr || '').slice(-1500)}`)
}

async function eOldEditPayloadFails() {
  const marker = 'isEdit && initial?.currency'
  const old = loadForm((s) => {
    assert(s.includes(marker), 'implementation marker missing')
    return s.replace(marker, 'false')
  })
  let failed = false
  try { await aEditKeepsCurrency(old) } catch { failed = true }
  assert(failed, 'a.edit-keeps-currency passed against the old account-derived currency')
}

// Runs tsc and returns the diagnostics. Anything but a clean run (exit 0) or a normal
// diagnostics run (exit 2, every line a diagnostic or its continuation) is an error.
function runTsc() {
  const r = spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: mobileDir, encoding: 'utf8', timeout: 300000 })
  if (r.error) throw new Error(`tsc did not run: ${r.error.message}`)
  if (r.signal) throw new Error(`tsc was killed by ${r.signal}`)
  const out = (r.stdout || '') + (r.stderr || '')
  const keys = new Set()
  const unparsed = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/)
    if (m) keys.add(`${m[1]} | ${m[2]} | ${m[3]}`)
    else if (!/^\s/.test(line)) unparsed.push(line)
  }
  if (r.status !== 0 && r.status !== 2) throw new Error(`tsc exited ${r.status}:\n${out.slice(-1500)}`)
  if (r.status === 2 && keys.size === 0) throw new Error(`tsc exited 2 with no recognised diagnostic:\n${out.slice(-1500)}`)
  if (unparsed.length) throw new Error(`tsc printed unrecognised output:\n${unparsed.join('\n')}`)
  return { keys, out }
}

function fTypecheckNoNewErrors() {
  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' })
  const base = git('merge-base', 'HEAD', 'origin/main').trim()
  const changed = git('diff', '--name-only', base).split('\n').filter((f) => /\.(ts|tsx)$/.test(f))
  const saved = []
  let baseRun
  try {
    // Base run: put the base version of every changed file in place, then restore the branch's.
    for (const f of changed) {
      let baseText
      try { baseText = git('show', `${base}:${f}`) } catch { continue }
      const abs = path.join(repoRoot, f)
      saved.push([abs, fs.readFileSync(abs, 'utf8')])
      fs.writeFileSync(abs, baseText)
    }
    baseRun = runTsc()
  } finally {
    for (const [abs, text] of saved) fs.writeFileSync(abs, text)
  }
  const headRun = runTsc()
  console.log(`  base diagnostics (${base.slice(0, 7)}): ${baseRun.keys.size}; completed: ${headRun.keys.size}`)
  const added = [...headRun.keys].filter((k) => !baseRun.keys.has(k))
  assert.deepStrictEqual(added, [], `new diagnostics:\n${added.join('\n')}\n--- base output ---\n${baseRun.out}\n--- completed output ---\n${headRun.out}`)
}

async function main() {
  const skipBuild = process.argv.includes('--skip-build')
  const scenarios = [
    ['a.edit-keeps-currency', () => aEditKeepsCurrency(loadForm())],
    ['b.create-uses-account-currency', () => bCreateUsesAccountCurrency(loadForm())],
    ['c.stale-forecast-contracts-removed', cStaleContractsRemoved],
    ['d.web-build-passes', skipBuild ? null : dWebBuild],
    ['e.old-edit-payload-fails', eOldEditPayloadFails],
    ['f.mobile-typecheck-no-new-errors', fTypecheckNoNewErrors],
  ]
  let failed = 0
  for (const [name, fn] of scenarios) {
    if (!fn) { console.log(`SKIP ${name}`); continue }
    try { await fn(); console.log(`PASS ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n${e.message}`) }
  }
  process.exit(failed ? 1 : 0)
}
main()
