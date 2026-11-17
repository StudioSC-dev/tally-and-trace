/**
 * Minimal Node typings for the e2e code. `@types/node` is not an approved dependency of
 * this package, so only the handful of APIs the e2e code uses are declared here.
 */
declare module 'node:path' {
  const path: {
    basename(p: string): string
    join(...parts: string[]): string
    resolve(...parts: string[]): string
    dirname(p: string): string
    relative(from: string, to: string): string
  }
  export default path
}

declare module 'node:fs' {
  const fs: {
    existsSync(p: string): boolean
    readFileSync(p: string, encoding: 'utf8'): string
    readdirSync(p: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[]
  }
  export default fs
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null
    stdout: string
    stderr: string
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { cwd: string; encoding: 'utf8' },
  ): SpawnSyncResult
}

declare const process: {
  env: Record<string, string | undefined>
  cwd(): string
}
