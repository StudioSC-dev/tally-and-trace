// Browser checks for STU-208: the onboarding tour bubble is an accessible dialog.
//
//   a.dialog-role        AC1  the bubble is role=dialog, aria-modal=true, labelled by the step title
//   b.focus-in           AC2  on each of the 8 steps focus is inside the bubble
//   c.trap               AC3  Tab and Shift+Tab never leave the bubble; both boundaries wrap
//   d.space              AC4  Space and Enter press the focused button
//   e.escape             AC5  Escape skips the tour and marks it complete, like Skip
//   f.no-scroll          AC6  window.scrollY never changes through focus moves and step changes
//   g.keyboard-walk      AC7  a keyboard-only walk of all 8 steps (Chromium and WebKit)
//   h.step-announcement  AC1  a polite live region names the step on entry to each of the 8 steps
//   i.regression         AC9  step order, copy, spotlight targets, Next/Back/Skip and completion
//                             persistence are as on main 2d8eb26 (the expected values below were
//                             taken from main's OnboardingFlow.tsx and this scenario passes there)
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). Not wired into
// CI. Run steps: ./README.md. WebKit needs `playwright install webkit`.
//
// Usage: node frontend/e2e/onboarding-a11y.cjs [a|b|c|d|e|f|g|h|i]     ENGINES=chromium,webkit
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let pw
try {
  pw = require(playwrightPath)
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
const ENGINES = ['chromium', 'webkit']
const VIEWPORT = { width: 1280, height: 1000 }
// Tall enough that every step's target is on screen without the tour scrolling to it, so any
// scroll in f.no-scroll is a focus-induced one.
const TALL_VIEWPORT = { width: 1280, height: 1300 }
let stack

// The tour on main 2d8eb26: step order, copy, spotlight target and the route each step opens.
const STEPS = [
  { title: 'Welcome to Your Dashboard', description: 'This is your home overview where you can see all your financial information at a glance.', target: 'nav-home', path: '/' },
  { title: 'Manage Your Accounts', description: 'Track all your accounts - cash, savings, checking, and credit cards - in one place.', target: 'nav-accounts', path: '/accounts' },
  { title: 'Record Transactions', description: 'Add and categorize your income and expenses to keep track of your spending.', target: 'nav-transactions', path: '/transactions' },
  { title: 'Set Financial Goals', description: 'Create budgets, savings goals, and track your progress toward financial milestones.', target: 'nav-allocations', path: '/allocations' },
  { title: 'Financial Snapshot', description: 'View your total balance, income, expenses, and net flow for the selected period.', target: 'financial-snapshot', path: '/' },
  { title: 'Budget Envelope Status', description: 'Monitor your spending against budget limits to stay on track with your financial goals.', target: 'budget-envelopes', path: '/' },
  { title: 'Upcoming Planned Expenses', description: 'See your scheduled payments and expenses to plan ahead and avoid surprises.', target: 'upcoming-expenses', path: '/' },
  { title: 'Spending breakdown', description: 'Open a breakdown of your posted spending by category for the dates shown, then pick a category to filter the list.', target: 'spending-breakdown', path: '/transactions' },
]

const BUBBLE = '[data-onboarding-controls]'
const DIALOG = '[role="dialog"][data-onboarding-controls]'
const LIVE = `${BUBBLE} [aria-live]`

/** A new user with the tour pending, signed in, the tour showing step 1. */
async function startTour(browser, engine, tag, { padPage = false } = {}) {
  const user = await h.makeUser(stack, `${tag}${engine.slice(0, 2)}`)
  stack.psql(`UPDATE users SET onboarding_completed = false WHERE email = '${user.email}'`)
  const { ctx, page } = await h.newPage(browser, { viewport: padPage ? TALL_VIEWPORT : VIEWPORT })
  page.setDefaultTimeout(10000)
  if (padPage) {
    // Make the document scrollable, so a focus move that scrolled it would show.
    await page.addInitScript(() => {
      const apply = () => {
        const style = document.createElement('style')
        style.textContent = 'html::after { content: ""; position: absolute; top: 0; left: 0; width: 1px; height: 4000px; pointer-events: none; }'
        document.head.appendChild(style)
      }
      if (document.head) apply()
      else document.addEventListener('DOMContentLoaded', apply)
    })
  }
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').waitFor({ timeout: 60000 })
  await page.locator('#email').fill(user.email)
  await page.locator('#password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.locator(BUBBLE).waitFor()
  await settle(page, 0)
  return { ctx, page, user }
}

const stepLabel = (page) => page.locator(`${BUBBLE} span`, { hasText: /^Step \d of 8$/ }).first().textContent()

/** Waits until the bubble shows `Step n of 8` and the spotlight has found its target. */
async function settle(page, index) {
  await page.locator(`${BUBBLE} span`, { hasText: new RegExp(`^Step ${index + 1} of 8$`) }).waitFor()
  await page.locator('[data-onboarding-highlight]').waitFor()
  await h.sleep(350)
}

/** Where focus is, as seen from the bubble: inside, or the tag it is on instead. */
const focusInfo = (page) => page.evaluate((sel) => {
  const bubble = document.querySelector(sel)
  const el = document.activeElement
  const label = el ? (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30) || el.tagName) : 'none'
  return { inside: !!(bubble && el && bubble.contains(el)), label, tag: el ? el.tagName : 'none' }
}, BUBBLE)

const completed = (user) => stack.psql(`SELECT onboarding_completed FROM users WHERE email = '${user.email}'`).split('\n')[2].trim() === 't'

/** Presses Enter on the focused Next until step `to` is shown (keyboard only). */
async function advanceTo(page, from, to) {
  for (let i = from; i < to; i++) {
    await page.keyboard.press('Enter')
    await settle(page, i + 1)
  }
}

async function scenarioA(browser, engine) {
  console.log(`\n=== a.dialog-role ${engine}`)
  const { ctx, page } = await startTour(browser, engine, 'a')
  try {
    for (let i = 0; i < STEPS.length; i++) {
      await h.check(`a.${engine}.dialog-role.step${i + 1}`, 'S', async () => {
        const dialogs = page.locator(DIALOG)
        if ((await dialogs.count()) !== 1) return `${await dialogs.count()} role=dialog bubbles`
        const modal = await dialogs.getAttribute('aria-modal')
        if (modal !== 'true') return `aria-modal="${modal}"`
        const labelledby = await dialogs.getAttribute('aria-labelledby')
        if (!labelledby) return 'no aria-labelledby'
        const name = await page.evaluate((id) => document.getElementById(id)?.textContent, labelledby)
        if (name !== STEPS[i].title) return `labelled by "${name}", expected "${STEPS[i].title}"`
        const accessible = await page.getByRole('dialog', { name: STEPS[i].title }).count()
        return accessible === 1 || `getByRole(dialog, name "${STEPS[i].title}") found ${accessible}`
      })
      if (i < STEPS.length - 1) await advanceTo(page, i, i + 1)
    }
  } finally {
    await ctx.close()
  }
}

async function scenarioB(browser, engine) {
  console.log(`\n=== b.focus-in ${engine}`)
  const { ctx, page } = await startTour(browser, engine, 'b')
  try {
    for (let i = 0; i < STEPS.length; i++) {
      await h.check(`b.${engine}.focus-in.step${i + 1}`, 'B', async () => {
        const f = await focusInfo(page)
        return f.inside || `focus is on ${f.tag} "${f.label}", outside the bubble`
      })
      if (i < STEPS.length - 1) await advanceTo(page, i, i + 1)
    }
    // Going back moves focus into the bubble too, including onto step 1 where Previous is disabled.
    await h.check(`b.${engine}.focus-in.previous`, 'B', async () => {
      await page.getByRole('button', { name: 'Previous', exact: true }).click()
      await settle(page, 6)
      const f = await focusInfo(page)
      return f.inside || `focus is on ${f.tag} "${f.label}" after Previous`
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioC(browser, engine) {
  console.log(`\n=== c.trap ${engine}`)
  const { ctx, page } = await startTour(browser, engine, 'c')
  try {
    for (let i = 0; i < STEPS.length; i++) {
      // The controls a keyboard can reach in the bubble, in DOM order.
      const controls = await page.evaluate((sel) => Array.from(document.querySelector(sel).querySelectorAll('button, [tabindex="0"]'))
        .filter((el) => !el.disabled)
        .map((el) => (el.textContent || '').trim().slice(0, 30)), BUBBLE)
      await h.check(`c.${engine}.trap.step${i + 1}.has-controls`, 'G', async () => controls.length >= 2 || `controls ${JSON.stringify(controls)}`)
      for (const [dir, key] of [['forward', 'Tab'], ['reverse', 'Shift+Tab']]) {
        await h.check(`c.${engine}.trap.step${i + 1}.${dir}`, 'B', async () => {
          // Start from the first (forward) or last (reverse) control, then press the key
          // through every control twice over: focus must stay inside and wrap.
          const seen = []
          for (let n = 0; n < controls.length * 2 + 1; n++) {
            await page.keyboard.press(key)
            const f = await focusInfo(page)
            if (!f.inside) return `press ${n + 1}: focus left the bubble, on ${f.tag} "${f.label}"`
            seen.push(f.label)
          }
          const period = seen.slice(0, controls.length)
          if (new Set(period).size !== controls.length) return `did not visit every control: ${JSON.stringify(seen)}`
          const repeats = seen.slice(controls.length, controls.length * 2).every((label, k) => label === period[k])
          return repeats || `no wrap: ${JSON.stringify(seen)}`
        })
      }
      if (i === 0) {
        await h.check(`c.${engine}.trap.focus-pulled-back`, 'B', async () => {
          // Focus put on a link behind the overlay comes straight back into the bubble.
          await page.evaluate(() => {
            const link = document.querySelector('nav a, a[href]')
            if (link) link.focus()
          })
          await h.sleep(100)
          const f = await focusInfo(page)
          return f.inside || `focus stayed on ${f.tag} "${f.label}" behind the overlay`
        })
      }
      if (i < STEPS.length - 1) {
        await page.locator(`${BUBBLE} button`, { hasText: /^Next$/ }).focus()
        await advanceTo(page, i, i + 1)
      }
    }
  } finally {
    await ctx.close()
  }
}

async function scenarioD(browser, engine) {
  console.log(`\n=== d.space ${engine}`)
  const { ctx, page, user } = await startTour(browser, engine, 'd')
  try {
    const press = async (name, key) => {
      await page.getByRole('button', { name, exact: true }).focus()
      await page.keyboard.press(key)
    }
    await h.check(`d.${engine}.space.next`, 'B', async () => {
      await press('Next', 'Space')
      await settle(page, 1)
      return true
    })
    await h.check(`d.${engine}.space.previous`, 'B', async () => {
      await press('Previous', 'Space')
      await settle(page, 0)
      return true
    })
    await h.check(`d.${engine}.enter.next`, 'B', async () => {
      await press('Next', 'Enter')
      await settle(page, 1)
      return true
    })
    await h.check(`d.${engine}.enter.previous`, 'B', async () => {
      await press('Previous', 'Enter')
      await settle(page, 0)
      return true
    })
    await h.check(`d.${engine}.space-does-not-scroll`, 'B', async () => {
      const before = await page.evaluate(() => window.scrollY)
      await press('Next', 'Space')
      await settle(page, 1)
      const after = await page.evaluate(() => window.scrollY)
      return before === after || `scrollY ${before} -> ${after}`
    })
    await h.check(`d.${engine}.space.skip`, 'B', async () => {
      await press('Skip', 'Space')
      await page.locator(BUBBLE).waitFor({ state: 'detached' })
      await h.sleep(300)
      return completed(user) || 'onboarding_completed is still false after Space on Skip'
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioE(browser, engine) {
  console.log(`\n=== e.escape ${engine}`)
  const { ctx, page, user } = await startTour(browser, engine, 'e')
  try {
    await advanceTo(page, 0, 2)
    await h.check(`e.${engine}.escape.skips`, 'B', async () => {
      await page.keyboard.press('Escape')
      await page.locator(BUBBLE).waitFor({ state: 'detached' })
      return true
    })
    await h.check(`e.${engine}.escape.marks-complete`, 'B', async () => {
      await h.sleep(300)
      if (!completed(user)) return 'onboarding_completed is still false after Escape'
      await page.reload()
      await page.locator('nav').first().waitFor()
      await h.sleep(1500)
      return (await page.locator(BUBBLE).count()) === 0 || 'the tour came back after a reload'
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioF(browser, engine) {
  console.log(`\n=== f.no-scroll ${engine}`)
  const { ctx, page } = await startTour(browser, engine, 'f', { padPage: true })
  try {
    const scrollY = () => page.evaluate(() => window.scrollY)
    // The tour itself centres a card that sits below the fold (STU-159: steps 6 and 7 on the
    // dashboard) with scrollIntoView; that is the one allowed scroll. Count those calls.
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView
      window.__tourScrolls = 0
      Element.prototype.scrollIntoView = function (...args) { window.__tourScrolls++; return original.apply(this, args) }
    })
    const tourScrolls = () => page.evaluate(() => window.__tourScrolls)
    /** Waits for a smooth scroll or a route's scroll reset to finish, returns the resting scrollY. */
    const resting = async () => {
      let last = await scrollY()
      for (let n = 0; n < 20; n++) {
        await h.sleep(300)
        const now = await scrollY()
        if (now === last) return now
        last = now
      }
      return last
    }
    const start = await resting()
    await h.check(`f.${engine}.no-scroll.initial-is-top`, 'G', async () => start === 0 || `initial scrollY ${start}`)
    await h.check(`f.${engine}.no-scroll.page-is-scrollable`, 'G', async () => {
      const room = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      return room > 500 || `only ${room}px of scroll room, so a scroll could not show`
    })
    for (let i = 0; i < STEPS.length; i++) {
      const baseline = await resting()
      await h.check(`f.${engine}.no-scroll.step${i + 1}`, 'B', async () => {
        const moves = []
        for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
          await page.keyboard.press(key)
          moves.push(await scrollY())
        }
        const moved = moves.filter((y) => y !== baseline)
        return moved.length === 0 || `scrollY changed from ${baseline} to ${JSON.stringify(moved)}`
      })
      if (i < STEPS.length - 1) {
        await page.locator(`${BUBBLE} button`, { hasText: /^Next$/ }).focus()
        const before = await tourScrolls()
        await advanceTo(page, i, i + 1)
        const y = await resting()
        const byTour = (await tourScrolls()) > before
        await h.check(`f.${engine}.no-scroll.after-transition${i + 2}`, 'B', async () => {
          if (byTour) return true // the tour's own centring; focus moves are checked at the next step
          // No new scroll was asked for: the page stays where the step before left it, or a route change reset it to the top.
          return y === baseline || y === start || `scrollY ${baseline} -> ${y} after moving to step ${i + 2}, and the tour did not scroll`
        })
      }
    }
  } finally {
    await ctx.close()
  }
}

async function scenarioG(browser, engine) {
  console.log(`\n=== g.keyboard-walk ${engine}`)
  // No mouse after sign-in: the walk starts from wherever the tour put focus.
  const { ctx, page, user } = await startTour(browser, engine, 'g')
  try {
    await h.check(`g.${engine}.keyboard-walk.step1-focus`, 'B', async () => (await focusInfo(page)).inside || 'focus not in the bubble')
    for (let i = 0; i < STEPS.length - 1; i++) {
      await h.check(`g.${engine}.keyboard-walk.to-step${i + 2}`, 'B', async () => {
        const f = await focusInfo(page)
        if (!f.inside) return `focus outside the bubble before step ${i + 2}: ${f.tag} "${f.label}"`
        // Reach Next with the keyboard only, whatever has focus now.
        for (let n = 0; n < 6 && (await focusInfo(page)).label !== 'Next'; n++) await page.keyboard.press('Tab')
        if ((await focusInfo(page)).label !== 'Next') return 'Tab never reached Next'
        await page.keyboard.press('Enter')
        await settle(page, i + 1)
        return (await stepLabel(page)) === `Step ${i + 2} of 8` || 'wrong step'
      })
    }
    await h.check(`g.${engine}.keyboard-walk.back-and-forward`, 'B', async () => {
      await page.keyboard.press('Shift+Tab')
      if ((await focusInfo(page)).label !== 'Previous') return `Shift+Tab from Next reached "${(await focusInfo(page)).label}"`
      await page.keyboard.press('Space')
      await settle(page, 6)
      for (let n = 0; n < 6 && (await focusInfo(page)).label !== 'Next'; n++) await page.keyboard.press('Tab')
      await page.keyboard.press('Space')
      await settle(page, 7)
      return true
    })
    await h.check(`g.${engine}.keyboard-walk.finish`, 'B', async () => {
      const f = await focusInfo(page)
      if (f.label !== 'Get Started') return `last step's primary button is "${f.label}"`
      await page.keyboard.press('Enter')
      await page.locator(BUBBLE).waitFor({ state: 'detached' })
      await h.sleep(300)
      return completed(user) || 'onboarding_completed is still false after Get Started'
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioH(browser, engine) {
  console.log(`\n=== h.step-announcement ${engine}`)
  const { ctx, page } = await startTour(browser, engine, 'h')
  try {
    for (let i = 0; i < STEPS.length; i++) {
      await h.check(`h.${engine}.step-announcement.step${i + 1}`, 'S', async () => {
        const regions = page.locator(LIVE)
        if ((await regions.count()) !== 1) return `${await regions.count()} live regions in the bubble`
        const politeness = await regions.getAttribute('aria-live')
        if (politeness !== 'polite') return `aria-live="${politeness}"`
        const text = ((await regions.textContent()) || '').trim()
        const expected = `Step ${i + 1} of 8: ${STEPS[i].title}`
        return text === expected || `live region says "${text}", expected "${expected}"`
      })
      if (i < STEPS.length - 1) await advanceTo(page, i, i + 1)
    }
  } finally {
    await ctx.close()
  }
}

async function scenarioI(browser, engine) {
  console.log(`\n=== i.regression ${engine}`)
  const { ctx, page, user } = await startTour(browser, engine, 'i')
  try {
    const clickButton = async (name) => page.getByRole('button', { name, exact: true }).click()
    const path = () => new URL(page.url()).pathname
    for (let i = 0; i < STEPS.length; i++) {
      const step = STEPS[i]
      await h.check(`i.${engine}.regression.step${i + 1}.content`, 'B', async () => {
        const title = await page.locator(`${BUBBLE} h3`).textContent()
        const description = await page.locator(`${BUBBLE} p`).first().textContent()
        if (title !== step.title) return `title "${title}"`
        if (description !== step.description) return `description "${description}"`
        return (await stepLabel(page)) === `Step ${i + 1} of 8` || 'progress label'
      })
      await h.check(`i.${engine}.regression.step${i + 1}.target`, 'B', async () => {
        await page.waitForFunction((p) => location.pathname === p, step.path)
        const target = await page.locator(`[data-onboarding="${step.target}"]`).locator('visible=true').first().boundingBox()
        const box = await page.locator('[data-onboarding-highlight]').boundingBox()
        if (!target || !box) return `target ${JSON.stringify(target)} highlight ${JSON.stringify(box)}`
        // The highlight is the target plus 12px padding (the border is inside the box), drawn around it.
        const tol = 2
        const ok = Math.abs(box.x - (target.x - 12)) <= tol && Math.abs(box.y - (target.y - 12)) <= tol &&
          Math.abs(box.width - (target.width + 24)) <= tol && Math.abs(box.height - (target.height + 24)) <= tol
        return ok || `highlight ${JSON.stringify(box)} does not frame ${step.target} ${JSON.stringify(target)}`
      })
      await h.check(`i.${engine}.regression.step${i + 1}.buttons`, 'B', async () => {
        const prevDisabled = await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled()
        if (prevDisabled !== (i === 0)) return `Previous disabled=${prevDisabled}`
        const nextName = i === STEPS.length - 1 ? 'Get Started' : 'Next'
        return (await page.getByRole('button', { name: nextName, exact: true }).count()) === 1 || `no "${nextName}" button`
      })
      if (i < STEPS.length - 1) {
        await clickButton('Next')
        await settle(page, i + 1)
      }
    }
    await h.check(`i.${engine}.regression.back`, 'B', async () => {
      await clickButton('Previous')
      await settle(page, 6)
      await clickButton('Previous')
      await settle(page, 5)
      await clickButton('Next')
      await settle(page, 6)
      await clickButton('Next')
      await settle(page, 7)
      return path() === '/transactions' || `path ${path()}`
    })
    await h.check(`i.${engine}.regression.not-complete-before-finish`, 'B', async () => !completed(user) || 'completed before the last step was finished')
    await h.check(`i.${engine}.regression.get-started-persists`, 'B', async () => {
      await clickButton('Get Started')
      await page.locator(BUBBLE).waitFor({ state: 'detached' })
      await h.sleep(300)
      return completed(user) || 'onboarding_completed is false after Get Started'
    })
  } finally {
    await ctx.close()
  }
  // Skip, by mouse, marks the tour complete and it does not return.
  const skipped = await startTour(browser, engine, 'is')
  try {
    for (let i = 0; i < 3; i++) {
      await skipped.page.getByRole('button', { name: 'Next', exact: true }).click()
      await settle(skipped.page, i + 1)
    }
    await h.check(`i.${engine}.regression.skip-persists`, 'B', async () => {
      await skipped.page.getByRole('button', { name: 'Skip', exact: true }).click()
      await skipped.page.locator(BUBBLE).waitFor({ state: 'detached' })
      await h.sleep(300)
      if (!completed(skipped.user)) return 'onboarding_completed is false after Skip'
      await skipped.page.reload()
      await skipped.page.locator('nav').first().waitFor()
      await h.sleep(1500)
      return (await skipped.page.locator(BUBBLE).count()) === 0 || 'the tour came back after a reload'
    })
  } finally {
    await skipped.ctx.close()
  }
}

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  const wanted = (process.env.ENGINES || ENGINES.join(',')).split(',')
  const scenarios = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['d', scenarioD], ['e', scenarioE], ['f', scenarioF], ['g', scenarioG], ['h', scenarioH], ['i', scenarioI]]
  for (const engine of wanted) {
    const browser = await pw[engine].launch()
    for (const [name, run] of scenarios) {
      if (only && only !== name) continue
      try {
        await run(browser, engine)
      } catch (e) {
        await h.check(`${name}.${engine}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
      }
    }
    await browser.close()
  }
  stack.stop()
  process.exit(h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
