#!/usr/bin/env node
// STU-262 acceptance checks for the mobile transaction form's Transfer type.
// Run: node mobile/scripts/check-transfer-form.cjs
// Loads the real transactions.tsx (transpiled in memory, react-native stubbed) and drives the form.
'use strict'
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { spawnSync } = require('child_process')

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
  { id: 3, name: 'Shared read-only', currency: 'USD', permissions: { can_add_transactions: false } },
]
const props = (extra) => ({ visible: true, onClose: () => {}, accounts: ACCOUNTS, categories: [], defaultCurrency: 'PHP', ...extra })
const record = (type) => ({
  view: 'full', id: 10, description: 'old note', amount: 50, transaction_type: type, account_id: 1,
  currency: 'USD', transaction_date: '2026-03-01T00:00:00Z', category_id: 3,
})
const json = (o) => JSON.parse(JSON.stringify(o))
const TODAY = new Date(new Date().toISOString().split('T')[0]).toISOString()
const NULLS = { transfer_from_account_id: null, transfer_to_account_id: null }

function fresh(initial) {
  const form = loadForm()
  return { form, ui: mountForm(form, props(initial ? { initial } : {})) }
}
const lastAlert = (form) => form.calls.alerts[form.calls.alerts.length - 1]

async function eligibleAccountPickers() {
  const { ui } = fresh()
  assert(!ui.ids().includes('transfer-from-picker'), 'transfer pickers shown before Transfer is chosen')
  ui.press('type-transfer')
  const ids = ui.ids()
  assert(ids.includes('transfer-from-picker') && ids.includes('transfer-to-picker'), 'both pickers must appear for Transfer')
  for (const side of ['transfer-from', 'transfer-to']) {
    assert(ids.includes(`${side}-1`) && ids.includes(`${side}-2`), `${side} must list the eligible accounts`)
    assert(!ids.includes(`${side}-3`), `${side} must not list an account without can_add_transactions`)
  }
}

async function payloadTransferCreate() {
  const { form, ui } = fresh()
  ui.press('type-transfer')
  ui.press('transfer-from-1'); ui.press('transfer-to-2')
  ui.byLabel('Amount').props.onChangeText('75')
  await ui.submit()
  assert.strictEqual(form.calls.create.length, 1, `not submitted: ${JSON.stringify(form.calls.alerts)}`)
  assert.deepStrictEqual(json(form.calls.create[0]), {
    amount: 75, transaction_type: 'transfer', account_id: 1, transaction_date: TODAY, currency: 'USD',
    transfer_from_account_id: 1, transfer_to_account_id: 2,
  })
}

async function payloadTransferEdit() {
  for (const type of ['debit', 'credit']) {
    const { form, ui } = fresh(record(type))
    ui.press('type-transfer')
    ui.press('transfer-from-2'); ui.press('transfer-to-1')
    await ui.submit()
    assert.strictEqual(form.calls.update.length, 1, `${type} -> transfer not submitted: ${JSON.stringify(form.calls.alerts)}`)
    assert.strictEqual(form.calls.update[0].id, 10)
    assert.deepStrictEqual(json(form.calls.update[0].data), {
      description: 'old note', amount: 50, transaction_type: 'transfer', account_id: 2, category_id: 3,
      transaction_date: '2026-03-01T00:00:00.000Z', currency: 'USD', transfer_from_account_id: 2, transfer_to_account_id: 1,
    })
  }
}

async function missingRefused(missing) {
  const { form, ui } = fresh()
  ui.press('type-transfer')
  ui.press(missing === 'source' ? 'transfer-to-2' : 'transfer-from-1')
  ui.byLabel('Amount').props.onChangeText('75')
  await ui.submit()
  assert.strictEqual(form.calls.create.length, 0, `saved without a ${missing}`)
  const alert = lastAlert(form)
  assert(alert && new RegExp(missing, 'i').test(alert.message), `no explanation of the missing ${missing}: ${JSON.stringify(alert)}`)
}

async function payloadNonTransfer() {
  for (const type of ['debit', 'credit']) {
    const { form, ui } = fresh()
    ui.press(`type-${type}`)
    ui.byLabel('Amount').props.onChangeText('9')
    await ui.submit()
    assert.strictEqual(form.calls.create.length, 1)
    const p = form.calls.create[0]
    assert(p.transfer_from_account_id === null && p.transfer_to_account_id === null, `${type} must send both transfer fields as null`)
  }
  // An edit away from a transfer clears the stored accounts.
  const t = { ...record('transfer'), transfer_from_account_id: 1, transfer_to_account_id: 2 }
  const { form, ui } = fresh(t)
  ui.press('type-debit')
  await ui.submit()
  const p = form.calls.update[0].data
  assert(p.transfer_from_account_id === null && p.transfer_to_account_id === null, 'edit away from transfer must send nulls')
}

async function sameAccountRefused() {
  const { form, ui } = fresh()
  ui.press('type-transfer')
  ui.press('transfer-from-1'); ui.press('transfer-to-1')
  ui.byLabel('Amount').props.onChangeText('75')
  await ui.submit()
  assert.strictEqual(form.calls.create.length, 0, 'saved a transfer to the same account')
  assert(/different/i.test(lastAlert(form).message), 'no explanation for the same account')
}

async function nonTransferRegression() {
  for (const type of ['debit', 'credit']) {
    // Valid create: every value as on main, plus the two null fields.
    let { form, ui } = fresh()
    ui.press(`type-${type}`)
    ui.press('account-2')
    ui.byLabel('Amount').props.onChangeText('12.5')
    ui.byLabel('Description (optional)').props.onChangeText('coffee')
    await ui.submit()
    assert.deepStrictEqual(json(form.calls.create[0]), {
      description: 'coffee', amount: 12.5, transaction_type: type, account_id: 2, transaction_date: TODAY, currency: 'EUR', ...NULLS,
    })
    // Valid edit.
    ;({ form, ui } = fresh(record(type)))
    ui.byLabel('Description (optional)').props.onChangeText('new note')
    await ui.submit()
    assert.deepStrictEqual(json(form.calls.update[0].data), {
      description: 'new note', amount: 50, transaction_type: type, account_id: 1, category_id: 3,
      transaction_date: '2026-03-01T00:00:00.000Z', currency: 'USD', ...NULLS,
    })
    // Required-field failures, create and edit: no amount, and no account.
    for (const initial of [undefined, record(type)]) {
      ;({ form, ui } = fresh(initial))
      ui.press(`type-${type}`)
      ui.byLabel('Amount').props.onChangeText('')
      await ui.submit()
      assert.strictEqual(form.calls.create.length + form.calls.update.length, 0, 'saved without an amount')
      assert.strictEqual(lastAlert(form).message, 'Amount and account are required.')
    }
    form = loadForm()
    ui = mountForm(form, props({ accounts: [] }))
    ui.press(`type-${type}`)
    ui.byLabel('Amount').props.onChangeText('5')
    await ui.submit()
    assert.strictEqual(form.calls.create.length, 0, 'saved without an account')
    assert.strictEqual(lastAlert(form).message, 'Amount and account are required.')
  }
}

// The diagnostics present on main 06a95a9, by file, code and message.
const BASELINE = new Set([
  "app/(tabs)/more.tsx | TS2353 | Object literal may only specify known properties, and 'is_achieved' does not exist in type 'Partial<WishlistItem>'.",
  "app/(tabs)/more.tsx | TS2339 | Property 'is_achieved' does not exist on type 'WishlistItem'.",
])

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

async function typecheckBaseline() {
  const { keys } = runTsc()
  const added = [...keys].filter((k) => !BASELINE.has(k))
  assert.deepStrictEqual(added, [], `diagnostics beyond the baseline:\n${added.join('\n')}`)
}

async function main() {
  const scenarios = [
    ['eligible-account-pickers', eligibleAccountPickers],
    ['a.payload-transfer-create', payloadTransferCreate],
    ['a.payload-transfer-edit', payloadTransferEdit],
    ['missing-source-refused', () => missingRefused('source')],
    ['missing-destination-refused', () => missingRefused('destination')],
    ['b.payload-nontransfer', payloadNonTransfer],
    ['c.same-account-refused', sameAccountRefused],
    ['typecheck-baseline', typecheckBaseline],
    ['nontransfer-create-edit-regression', nonTransferRegression],
  ]
  let failed = 0
  for (const [name, fn] of scenarios) {
    try { await fn(); console.log(`PASS ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n${e.message}`) }
  }
  process.exit(failed ? 1 : 0)
}
main()
