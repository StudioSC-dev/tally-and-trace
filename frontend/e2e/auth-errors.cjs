// Browser checks for STU-209: the sign-in, demo-login, resend-verification, register and
// verify-email screens show a readable line for every refused request (a FastAPI 422 `detail`
// array, a string `detail`, a 400, 401 or 500) and never crash; their success paths are unchanged.
//   (a) AC1  sign-in with a 422 detail array: one readable line, the form stays usable.
//   (b) AC2  demo-login and resend-verification with a 422 array: the same.
//   (c) AC3  sign-in with 400, 401 and 500 (a JSON reason and a body that is not JSON): a message.
//   (d) AC4  verify-email with a 422 array: a message.
//   (e) AC5  "Email not verified" still shows the resend button.
//   (f) AC7  register with a 422 array: readable text, the form stays usable.
//   (g) AC8  a string `detail` reads as itself on sign-in, demo-login, resend, register, verify-email.
//   (h) AC9  register and verify-email with 400, 401 and 500: a message, no crash.
//   (j) a resend result is cleared when the email changes or a new sign-in or demo-login starts.
//   (k) guard: a 401 on an authenticated page still redirects to /login.
//   (i) AC10 successful sign-in, demo-login, resend, registration and verification keep their
//            navigation and confirmation.
// Every /auth request is a route mock; the API is never reached. A crash is a page error or a
// console error about a React child (the 422 array rendered as a child), or the form unmounting.
//
// Starts its own web app (./_local_stack.cjs) against a throwaway database. Not wired into CI.
// Run steps: ./README.md.
//
// Usage: node frontend/e2e/auth-errors.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let stack

const PASSWORD = 'E2eTest!2345'
const EMAIL_422 = [{ type: 'value_error', loc: ['body', 'email'], msg: 'value is not a valid email address: The part after the @-sign is a special-use or reserved name', input: 'user@example.test' }]
const EMAIL_422_TEXT = 'value is not a valid email address'
const TWO_422 = [
  { type: 'string_too_short', loc: ['body', 'password'], msg: 'String should have at least 8 characters', input: 'x' },
  { type: 'value_error', loc: ['body', 'email'], msg: 'value is not a valid email address', input: 'x' },
]
const USER = {
  id: 1, email: 'ok@example.com', first_name: 'Ok', last_name: 'User', default_currency: 'PHP',
  is_active: true, is_verified: true, onboarding_completed: true, created_at: '2026-01-01T00:00:00',
}

const json = (status, body) => ({ status, body })
const text = (status, body) => ({ status, body, raw: true })

/** A fresh page with the /auth routes mocked. `mocks` maps an /auth path to a response or a function. */
async function openPage(browser, mocks) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } })
  const page = await ctx.newPage()
  const crashes = []
  page.on('pageerror', (e) => crashes.push(String(e && e.message ? e.message : e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && /not valid as a React child/.test(m.text())) crashes.push(m.text().split('\n')[0])
  })
  const calls = {}
  // Anything else under /api/v1 (the dashboard after a sign-in) answers an empty list.
  await page.route('**/api/v1/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
    headers: { 'access-control-allow-origin': stack.webUrl, 'access-control-allow-credentials': 'true' },
  }))
  await page.route('**/api/v1/auth/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1\/auth\//, '')
    const cors = {
      'access-control-allow-origin': stack.webUrl,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    calls[path] = (calls[path] || 0) + 1
    const mock = mocks[path]
    const reply = typeof mock === 'function' ? mock(calls[path]) : mock
    if (!reply) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not Found"}', headers: cors })
    return route.fulfill({
      status: reply.status,
      contentType: reply.raw ? 'text/plain' : 'application/json',
      body: reply.raw ? reply.body : JSON.stringify(reply.body),
      headers: cors,
    })
  })
  return { ctx, page, crashes, calls }
}

const goto = (page, path) => page.goto(`${stack.webUrl}${path}`, { waitUntil: 'domcontentloaded' })
const emailBox = (page) => page.locator('#email')
const passwordBox = (page) => page.locator('#password')
const signInButton = (page) => page.getByRole('button', { name: 'Sign in', exact: true })

async function signInPage(browser, mocks) {
  const ctx = await openPage(browser, mocks)
  await goto(ctx.page, '/login')
  await emailBox(ctx.page).waitFor({ timeout: 60000 })
  return ctx
}

async function submitSignIn(page, email = 'user@example.test') {
  await emailBox(page).fill(email)
  await passwordBox(page).fill(PASSWORD)
  await signInButton(page).click()
}

async function registerPage(browser, mocks) {
  const ctx = await openPage(browser, mocks)
  await goto(ctx.page, '/register')
  await ctx.page.locator('#firstName').waitFor({ timeout: 60000 })
  return ctx
}

async function submitRegister(page) {
  await page.locator('#firstName').fill('Ada')
  await page.locator('#lastName').fill('Lovelace')
  await page.locator('#email').fill('user@example.test')
  await page.locator('#password').fill(PASSWORD)
  await page.locator('#confirmPassword').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
}

const verifyPage = async (browser, mocks) => {
  const ctx = await openPage(browser, mocks)
  await goto(ctx.page, '/verify-email?token=abc')
  return ctx
}

/** True once the text is visible on the page; false after the wait. */
async function shows(page, needle, ms = 8000) {
  return page.getByText(needle, { exact: false }).first().waitFor({ timeout: ms }).then(() => true, () => false)
}
const noCrash = (ctx) => ctx.crashes.length === 0 || `crashed: ${ctx.crashes[0]}`
const bodyText = async (page) => ((await page.locator('body').textContent({ timeout: 3000 }).catch(() => '')) || '').replace(/\s+/g, ' ')

/** Sign-in form still takes input and can submit: the email box edits and Sign in is enabled. */
async function signInUsable(page) {
  await emailBox(page).fill('someone@example.com')
  return (await emailBox(page).inputValue()) === 'someone@example.com' && (await signInButton(page).isEnabled())
}
async function registerUsable(page) {
  await page.locator('#firstName').fill('Grace')
  return (await page.locator('#firstName').inputValue()) === 'Grace'
    && (await page.getByRole('button', { name: 'Create account', exact: true }).isEnabled())
}

const NOT_VERIFIED = json(403, { detail: 'Email not verified' })

// ---------------------------------------------------------------------------------------------

async function scenarioA(browser) {
  const ctx = await signInPage(browser, { login: json(422, { detail: EMAIL_422 }) })
  try {
    await submitSignIn(ctx.page)
    await h.check('a.login-422', 'B', async () => {
      if (!(await shows(ctx.page, EMAIL_422_TEXT))) return `no readable line; page: ${(await bodyText(ctx.page)).slice(0, 200)}`
      const crash = noCrash(ctx)
      if (crash !== true) return crash
      if ((await ctx.page.locator('.text-danger', { hasText: EMAIL_422_TEXT }).count()) !== 1) return 'the line is not shown exactly once'
      return (await signInUsable(ctx.page)) || 'form not usable after the error'
    })
    await h.check('a.login-422-two-messages', 'B', async () => {
      await ctx.page.unroute('**/api/v1/auth/**')
      await ctx.page.route('**/api/v1/auth/login', (route) => route.fulfill({
        status: 422, contentType: 'application/json', body: JSON.stringify({ detail: TWO_422 }),
        headers: { 'access-control-allow-origin': stack.webUrl, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*' },
      }))
      await submitSignIn(ctx.page)
      return (await shows(ctx.page, 'String should have at least 8 characters; value is not a valid email address')) || 'the two messages are not one line'
    })
  } finally {
    await ctx.ctx.close()
  }
}

async function scenarioB(browser) {
  // demo-login
  const demo = await signInPage(browser, { login: json(422, { detail: EMAIL_422 }) })
  try {
    await demo.page.getByRole('button', { name: 'Sign in as demo user' }).click()
    await h.check('b.demo-422', 'B', async () => {
      if (!(await shows(demo.page, EMAIL_422_TEXT))) return 'no readable line on demo-login'
      const crash = noCrash(demo)
      if (crash !== true) return crash
      return (await demo.page.getByRole('button', { name: 'Sign in as demo partner' }).isEnabled()) || 'demo buttons stay disabled'
    })
  } finally {
    await demo.ctx.close()
  }
  // resend-verification
  const resend = await signInPage(browser, { login: NOT_VERIFIED, 'resend-verification': json(422, { detail: EMAIL_422 }) })
  try {
    await submitSignIn(resend.page, 'user@example.com')
    await resend.page.getByRole('button', { name: 'Resend verification email' }).click()
    await h.check('b.resend-422', 'B', async () => {
      if (!(await shows(resend.page, EMAIL_422_TEXT))) return `no readable line on resend; page: ${(await bodyText(resend.page)).slice(0, 200)}`
      const crash = noCrash(resend)
      if (crash !== true) return crash
      return (await signInUsable(resend.page)) || 'form not usable after the resend error'
    })
  } finally {
    await resend.ctx.close()
  }
}

async function scenarioC(browser) {
  const cases = [
    ['400', json(400, { detail: 'Bad sign-in request' }), 'Bad sign-in request'],
    ['401', json(401, { detail: 'Incorrect email or password' }), 'Incorrect email or password'],
    ['500', json(500, { detail: 'Server exploded' }), 'Server exploded'],
    ['500-not-json', text(500, 'Internal Server Error'), 'Login failed. Please try again.'],
    ['401-no-detail', json(401, {}), 'Login failed. Please try again.'],
  ]
  for (const [name, reply, expected] of cases) {
    const ctx = await signInPage(browser, { login: reply })
    try {
      await submitSignIn(ctx.page, 'user@example.com')
      await h.check(`c.login-${name}`, 'B', async () => {
        if (!(await shows(ctx.page, expected))) return `no "${expected}"; page: ${(await bodyText(ctx.page)).slice(0, 200)}`
        const crash = noCrash(ctx)
        if (crash !== true) return crash
        return (await signInUsable(ctx.page)) || 'form not usable'
      })
    } finally {
      await ctx.ctx.close()
    }
  }
}

async function scenarioD(browser) {
  const ctx = await verifyPage(browser, { 'verify-email': json(422, { detail: [{ type: 'string_type', loc: ['body', 'token'], msg: 'Input should be a valid string', input: 1 }] }) })
  try {
    await h.check('d.verify-422', 'B', async () => {
      if (!(await shows(ctx.page, 'Input should be a valid string'))) return `no message; page: ${(await bodyText(ctx.page)).slice(0, 200)}`
      const crash = noCrash(ctx)
      if (crash !== true) return crash
      return (await ctx.page.getByRole('button', { name: 'Go to login' }).isVisible()) || 'no way back to the sign-in page'
    })
  } finally {
    await ctx.ctx.close()
  }
}

async function scenarioE(browser) {
  for (const [name, reply] of [['403', NOT_VERIFIED], ['400', json(400, { detail: 'Email not verified' })]]) {
    const ctx = await signInPage(browser, { login: reply })
    try {
      await submitSignIn(ctx.page, 'user@example.com')
      await h.check(`e.unverified-still-works-${name}`, 'B', async () => {
        if (!(await shows(ctx.page, 'Email not verified'))) return 'the message is missing'
        if (!(await ctx.page.getByRole('button', { name: 'Resend verification email' }).isVisible())) return 'the resend button is missing'
        return noCrash(ctx)
      })
    } finally {
      await ctx.ctx.close()
    }
  }
  // The same, as the closing step of the resend flow: a success clears the notice.
  const ok = await signInPage(browser, { login: NOT_VERIFIED, 'resend-verification': json(200, { message: 'Verification email sent!' }) })
  try {
    await submitSignIn(ok.page, 'user@example.com')
    await ok.page.getByRole('button', { name: 'Resend verification email' }).click()
    await h.check('e.resend-confirmation', 'B', async () => (await shows(ok.page, 'Verification email sent!')) || 'no confirmation')
  } finally {
    await ok.ctx.close()
  }
}

async function scenarioF(browser) {
  const ctx = await registerPage(browser, { register: json(422, { detail: EMAIL_422 }) })
  try {
    await submitRegister(ctx.page)
    await h.check('f.register-422', 'B', async () => {
      if (!(await shows(ctx.page, EMAIL_422_TEXT))) return `no readable text; page: ${(await bodyText(ctx.page)).slice(0, 200)}`
      const crash = noCrash(ctx)
      if (crash !== true) return crash
      return (await registerUsable(ctx.page)) || 'form not usable after the error'
    })
  } finally {
    await ctx.ctx.close()
  }
}

async function scenarioG(browser) {
  const reason = 'Reason as a plain string'
  const signIn = await signInPage(browser, { login: json(400, { detail: reason }) })
  try {
    await submitSignIn(signIn.page, 'user@example.com')
    await h.check('g.string-signin', 'B', async () => (await shows(signIn.page, reason)) && noCrash(signIn))
  } finally { await signIn.ctx.close() }

  const demo = await signInPage(browser, { login: json(400, { detail: reason }) })
  try {
    await demo.page.getByRole('button', { name: 'Sign in as demo user' }).click()
    await h.check('g.string-demo', 'B', async () => (await shows(demo.page, reason)) && noCrash(demo))
  } finally { await demo.ctx.close() }

  const resend = await signInPage(browser, { login: NOT_VERIFIED, 'resend-verification': json(400, { detail: reason }) })
  try {
    await submitSignIn(resend.page, 'user@example.com')
    await resend.page.getByRole('button', { name: 'Resend verification email' }).click()
    await h.check('g.string-resend', 'B', async () => (await shows(resend.page, reason)) && noCrash(resend))
  } finally { await resend.ctx.close() }

  const register = await registerPage(browser, { register: json(400, { detail: reason }) })
  try {
    await submitRegister(register.page)
    await h.check('g.string-register', 'B', async () => (await shows(register.page, reason)) && noCrash(register))
  } finally { await register.ctx.close() }

  const verify = await verifyPage(browser, { 'verify-email': json(400, { detail: reason }) })
  try {
    await h.check('g.string-verify', 'B', async () => (await shows(verify.page, reason)) && noCrash(verify))
  } finally { await verify.ctx.close() }
}

async function scenarioH(browser) {
  const cases = [
    ['400', json(400, { detail: 'Refused (400)' }), 'Refused (400)'],
    ['401', json(401, { detail: 'Refused (401)' }), 'Refused (401)'],
    ['500', json(500, { detail: 'Refused (500)' }), 'Refused (500)'],
  ]
  for (const [name, reply, expected] of cases) {
    const register = await registerPage(browser, { register: reply })
    try {
      await submitRegister(register.page)
      await h.check(`h.register-${name}`, 'B', async () => {
        if (!(await shows(register.page, expected))) return `no message; page: ${(await bodyText(register.page)).slice(0, 200)}`
        if (new URL(register.page.url()).pathname !== '/register') return `left /register for ${register.page.url()}`
        return noCrash(register)
      })
    } finally { await register.ctx.close() }

    const verify = await verifyPage(browser, { 'verify-email': reply })
    try {
      await h.check(`h.verify-${name}`, 'B', async () => {
        if (!(await shows(verify.page, expected))) return `no message; page: ${(await bodyText(verify.page)).slice(0, 200)}`
        if (new URL(verify.page.url()).pathname !== '/verify-email') return `left /verify-email for ${verify.page.url()}`
        return noCrash(verify)
      })
    } finally { await verify.ctx.close() }
  }
  const generic = await verifyPage(browser, { 'verify-email': text(500, 'Internal Server Error') })
  try {
    await h.check('h.verify-500-not-json', 'B', async () => (await shows(generic.page, 'Verification failed. Please try again.')) && noCrash(generic))
  } finally { await generic.ctx.close() }
  const genericRegister = await registerPage(browser, { register: text(500, 'Internal Server Error') })
  try {
    await submitRegister(genericRegister.page)
    await h.check('h.register-500-not-json', 'B', async () => (await shows(genericRegister.page, 'Registration failed. Please try again.')) && noCrash(genericRegister))
  } finally { await genericRegister.ctx.close() }
}

async function scenarioI(browser) {
  const signedIn = { login: json(200, { access_token: 'e2e-token', token_type: 'bearer' }), me: json(200, USER) }
  const pathOf = (page) => new URL(page.url()).pathname

  const signIn = await signInPage(browser, signedIn)
  try {
    await submitSignIn(signIn.page, 'ok@example.com')
    await h.check('i.signin-navigates', 'G', async () => {
      await signIn.page.waitForURL((u) => u.pathname === '/', { timeout: 10000 })
      const token = await signIn.page.evaluate(() => localStorage.getItem('access_token'))
      return token === 'e2e-token' || `token stored: ${token}`
    })
  } finally { await signIn.ctx.close() }

  const demo = await signInPage(browser, signedIn)
  try {
    await demo.page.getByRole('button', { name: 'Sign in as demo partner' }).click()
    await h.check('i.demo-navigates', 'G', async () => {
      await demo.page.waitForURL((u) => u.pathname === '/', { timeout: 10000 })
      const sent = demo.calls.login === 1
      return sent || `login calls: ${demo.calls.login}`
    })
  } finally { await demo.ctx.close() }

  const resend = await signInPage(browser, { login: NOT_VERIFIED, 'resend-verification': json(200, { message: 'Verification email sent!' }) })
  try {
    await submitSignIn(resend.page, 'ok@example.com')
    await resend.page.getByRole('button', { name: 'Resend verification email' }).click()
    await h.check('i.resend-confirms', 'G', async () => {
      if (!(await shows(resend.page, 'Verification email sent!'))) return 'no confirmation'
      if (pathOf(resend.page) !== '/login') return `left /login for ${pathOf(resend.page)}`
      return (await resend.page.getByRole('button', { name: 'Resend verification email' }).count()) === 0 || 'the resend button is still offered after a success'
    })
  } finally { await resend.ctx.close() }

  const register = await registerPage(browser, { register: json(200, USER) })
  try {
    await submitRegister(register.page)
    await h.check('i.register-navigates', 'G', async () => {
      await register.page.waitForURL((u) => u.pathname === '/login', { timeout: 10000 })
      return (await shows(register.page, 'Registration successful! Please check your email')) || 'no registration notice on sign-in'
    })
  } finally { await register.ctx.close() }

  const verify = await verifyPage(browser, { 'verify-email': json(200, { message: 'Verified' }) })
  try {
    await h.check('i.verify-confirms', 'G', async () => {
      if (!(await shows(verify.page, 'Email verified!'))) return 'no confirmation'
      await verify.page.getByRole('button', { name: 'Continue now' }).click()
      // '/' sends a signed-out visitor on to /login; leaving /verify-email is the navigation.
      await verify.page.waitForURL((u) => u.pathname !== '/verify-email', { timeout: 10000 })
      return true
    })
  } finally { await verify.ctx.close() }
}

async function scenarioJ(browser) {
  const SENT = 'Verification email sent!'
  const mocks = { login: NOT_VERIFIED, 'resend-verification': json(200, { message: SENT }) }
  const sendResend = async (page) => {
    await submitSignIn(page, 'user@example.com')
    await page.getByRole('button', { name: 'Resend verification email' }).click()
    await shows(page, SENT)
  }
  const gone = async (page) => (await page.getByText(SENT, { exact: false }).count()) === 0

  const edit = await signInPage(browser, mocks)
  try {
    await sendResend(edit.page)
    await emailBox(edit.page).fill('other@example.com')
    await h.check('j.cleared-on-email-change', 'B', async () => (await gone(edit.page)) || 'the old resend message is still shown')
  } finally { await edit.ctx.close() }

  const again = await signInPage(browser, mocks)
  try {
    await sendResend(again.page)
    await signInButton(again.page).click()
    await h.check('j.cleared-on-new-signin', 'B', async () => {
      if (!(await shows(again.page, 'Email not verified'))) return 'no new "Email not verified"'
      return (await gone(again.page)) || 'the old resend message sits beside the new error'
    })
  } finally { await again.ctx.close() }

  const demo = await signInPage(browser, mocks)
  try {
    await sendResend(demo.page)
    await demo.page.getByRole('button', { name: 'Sign in as demo user' }).click()
    await h.check('j.cleared-on-demo-login', 'B', async () => {
      if (!(await shows(demo.page, 'Email not verified'))) return 'no new "Email not verified"'
      return (await gone(demo.page)) || 'the old resend message sits beside the new error'
    })
  } finally { await demo.ctx.close() }

  const failed = await signInPage(browser, { login: NOT_VERIFIED, 'resend-verification': json(400, { detail: 'Resend refused' }) })
  try {
    await submitSignIn(failed.page, 'user@example.com')
    await failed.page.getByRole('button', { name: 'Resend verification email' }).click()
    await shows(failed.page, 'Resend refused')
    await signInButton(failed.page).click()
    await h.check('j.failure-cleared-on-new-signin', 'B', async () => {
      if (!(await shows(failed.page, 'Email not verified'))) return 'no new "Email not verified"'
      return (await failed.page.getByText('Resend refused').count()) === 0 || 'the old resend failure is still shown'
    })
  } finally { await failed.ctx.close() }
}

async function scenarioK(browser) {
  // Guard: a 401 on an authenticated page (an expired session) still goes to /login.
  const ctx = await openPage(browser, { me: json(401, { detail: 'Could not validate credentials' }), refresh: json(401, { detail: 'Invalid or expired refresh token' }) })
  try {
    await ctx.ctx.addInitScript((user) => {
      if (location.pathname === '/login') return
      localStorage.setItem('access_token', 'expired-token')
      localStorage.setItem('user', JSON.stringify(user))
    }, USER)
    await goto(ctx.page, '/')
    await h.check('k.expired-session-redirects', 'G', async () => {
      await ctx.page.waitForURL((u) => u.pathname === '/login', { timeout: 15000 })
      const token = await ctx.page.evaluate(() => localStorage.getItem('access_token'))
      return token === null || `token still stored: ${token}`
    })
  } finally { await ctx.ctx.close() }
}

const SCENARIOS = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE, f: scenarioF, g: scenarioG, h: scenarioH, i: scenarioI, j: scenarioJ, k: scenarioK }

async function main() {
  try {
    stack = await startLocalStack()
  } catch (error) {
    console.error(`SETUP FAILED: ${error && error.message ? error.message : error}`)
    process.exit(2)
  }
  const browser = await chromium.launch()
  let code = 1
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (only && only !== name) continue
      try {
        await run(browser)
      } catch (error) {
        await h.check(`${name}.ran`, 'S', () => `threw ${error && error.stack ? error.stack : error}`)
      }
    }
    code = h.report()
  } finally {
    await browser.close()
    await stack.stop()
  }
  process.exit(code)
}

main()
