import { describe, it, expect } from 'vitest'

// The package's test script pins TZ=Asia/Manila (UTC+8) so the wall-time and
// recurrence tests run where local time and UTC disagree. If the pin is lost,
// tests that compare local and UTC components could pass for the wrong reason.
describe('test timezone', () => {
  it('runs with the clock pinned to UTC+8', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(-480)
  })
})
