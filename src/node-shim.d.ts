// Types only: the few Node built-ins the plugin and its tests use, so `tsc` passes without
// @types/node (Orca ships no Node typings and node_modules is not committed). No runtime effect.

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exitCode?: number
  platform: string
  cwd(): string
  exit(code?: number): never
  stdout: { write(s: string): boolean }
  stderr: { write(s: string): boolean }
  kill(pid: number, signal?: string | number): true
}

declare function setImmediate(fn: () => void): unknown

declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: {
      env?: Record<string, string | undefined>
      timeout?: number
      killSignal?: string
      maxBuffer?: number
      encoding?: string
      cwd?: string
      signal?: AbortSignal
    },
    callback: (
      error: (Error & { code?: number | string; killed?: boolean }) | null,
      stdout: string,
      stderr: string
    ) => void
  ): unknown
}

declare module 'node:fs' {
  export const constants: { readonly X_OK: number }
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export const promises: {
    access(path: string, mode?: number): Promise<void>
    readFile(path: string, encoding: 'utf8'): Promise<string>
  }
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readFileSync(path: string): Uint8Array
  export function existsSync(path: string): boolean
  export function writeFileSync(path: string, data: string): void
  export function chmodSync(path: string, mode: number): void
  export function mkdtempSync(prefix: string): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function statSync(path: string): { size: number; isDirectory(): boolean }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(p: string): string
  export function relative(from: string, to: string): string
  export const sep: string
  export const delimiter: string
  export const posix: { delimiter: string }
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:vm' {
  export function runInNewContext(code: string, context: Record<string, unknown>, options?: { filename?: string }): unknown
}

declare module 'node:test' {
  export function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void>
  export function test(name: string, options: { timeout?: number }, fn: () => unknown | Promise<unknown>): Promise<void>
  export function afterEach(fn: () => unknown | Promise<unknown>): void
  export function after(fn: () => unknown | Promise<unknown>): void
  export function beforeEach(fn: () => unknown | Promise<unknown>): void
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value
    ok(value: unknown, message?: string): asserts value
    equal(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void
    throws(fn: () => unknown, expected?: unknown, message?: string): void
    rejects(fn: (() => Promise<unknown>) | Promise<unknown>, expected?: unknown, message?: string): Promise<void>
    match(value: string, pattern: RegExp, message?: string): void
    doesNotMatch(value: string, pattern: RegExp, message?: string): void
  }
  const assert: Assert
  export default assert
}
