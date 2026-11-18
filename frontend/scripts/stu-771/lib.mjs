// STU-771 verification helpers, called by `scripts/verify-stu-771.sh`. Each subcommand reads files and prints its
// result; a failed check exits non-zero with the reason on stderr.
//
//   report-stats <report.json>            the run's totals from a Playwright JSON report
//   load-times <report.json>              the AC3 load times, one per line, then the count and the median
//   list-ids <list.json>                  every test id (project, file, titles) from `playwright test --list --reporter=json`
//   guard-lines <spec.ts>                 the spec's skip, fixme, only and fail rules, one per line, sorted
//   config-diff <main.ts> <head.ts>       compares two playwright.config.ts files outside webServer.command/timeout
//   pr-specs <pr-body.md>                 the touched-spec table under "### Touched specs", one row per line
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Every test in a JSON report, with its suite titles. */
function* tests(suites, titles = []) {
  for (const suite of suites ?? []) {
    const path = suite.title && !suite.title.endsWith('.ts') ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) yield { file: spec.file, titles: [...path, spec.title], test }
    }
    yield* tests(suite.suites, path)
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'report-stats': {
    const { stats, errors } = readJson(args[0])
    process.stdout.write(
      `${JSON.stringify({
        expected: stats.expected,
        unexpected: stats.unexpected,
        flaky: stats.flaky,
        skipped: stats.skipped,
        durationSec: Math.round(stats.duration / 1000),
        errors: (errors ?? []).length,
      })}\n`,
    )
    break
  }
  case 'load-times': {
    const report = readJson(args[0])
    const values = []
    for (const { test } of tests(report.suites)) {
      const annotations = [...(test.annotations ?? []), ...(test.results ?? []).flatMap((r) => r.annotations ?? [])]
      const hit = annotations.find((a) => a.type === 'dashboard-h1-ms')
      if (hit && test.results?.at(-1)?.status === 'passed') values.push(Number(hit.description))
    }
    for (const v of values) process.stdout.write(`${v}\n`)
    process.stdout.write(`count ${values.length}\nmedian ${values.length ? median(values).toFixed(1) : 'NaN'}\n`)
    break
  }
  case 'list-ids': {
    const report = readJson(args[0])
    const ids = [...tests(report.suites)].map(({ file, titles, test }) => `${test.projectName} › ${file} › ${titles.join(' › ')}`)
    process.stdout.write(`${ids.sort().join('\n')}\n`)
    break
  }
  case 'guard-lines': {
    const source = fs.readFileSync(args[0], 'utf8')
    // test.skip / test.fixme / test.only / test.fail and their describe forms, conditional or not.
    const lines = source
      .split('\n')
      .filter((l) => /\b(test|describe|it)(\.describe)?\.(skip|fixme|only|fail)\b/.test(l))
      .map((l) => l.trim())
    process.stdout.write(lines.sort().join('\n') + (lines.length ? '\n' : ''))
    break
  }
  case 'config-diff': {
    const [mainConfig, headConfig] = await Promise.all(args.map(async (f) => (await import(pathToFileURL(f).href)).default))
    const strip = (config) => {
      const { webServer, ...rest } = config
      const { command: _command, timeout: _timeout, ...server } = webServer ?? {}
      return { rest, server }
    }
    const main = strip(mainConfig)
    const head = strip(headConfig)
    const problems = []
    for (const key of new Set([...Object.keys(main.rest), ...Object.keys(head.rest)])) {
      if (!isDeepStrictEqual(main.rest[key], head.rest[key])) problems.push(`config.${key} changed`)
    }
    if (!isDeepStrictEqual(main.server, head.server)) problems.push('webServer fields other than command and timeout changed')
    if (headConfig.webServer?.reuseExistingServer !== false) problems.push('webServer.reuseExistingServer is not false')
    if ('shard' in headConfig) problems.push('config sets shard')
    if (problems.length) fail(problems.join('\n'))
    process.stdout.write(
      `${JSON.stringify({
        keysCompared: Object.keys(head.rest).sort(),
        workers: headConfig.workers ?? null,
        retries: headConfig.retries ?? null,
        timeout: headConfig.timeout ?? null,
        expect: headConfig.expect ?? null,
        projects: (headConfig.projects ?? []).map((p) => p.name),
        reporter: headConfig.reporter,
        mainCommand: mainConfig.webServer?.command,
        headCommand: headConfig.webServer?.command,
        mainTimeout: mainConfig.webServer?.timeout,
        headTimeout: headConfig.webServer?.timeout,
      })}\n`,
    )
    break
  }
  case 'pr-specs': {
    const body = fs.readFileSync(args[0], 'utf8').split('\n')
    const start = body.findIndex((l) => /^#{2,4} Touched specs\b/.test(l))
    if (start < 0) fail('no "Touched specs" heading in the PR body')
    const rows = []
    for (const line of body.slice(start + 1)) {
      if (/^#{1,4} /.test(line)) break
      const cells = line.split('|').slice(1, -1).map((c) => c.trim())
      if (cells.length !== 3 || /^-+$/.test(cells[0]) || cells[0] === 'Path') continue
      rows.push(cells.map((c) => c.replace(/^`|`$/g, '')).join('\t'))
    }
    process.stdout.write(rows.join('\n') + (rows.length ? '\n' : ''))
    break
  }
  default:
    fail(`unknown command: ${command}`)
}
