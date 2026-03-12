import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const ENV_PATH = path.join(PROJECT_ROOT, '.env')

let originalEnv: string | null = null

beforeEach(() => {
  if (existsSync(ENV_PATH)) {
    originalEnv = readFileSync(ENV_PATH, 'utf-8')
  }
})

afterEach(() => {
  if (originalEnv !== null) {
    writeFileSync(ENV_PATH, originalEnv)
  } else if (existsSync(ENV_PATH)) {
    unlinkSync(ENV_PATH)
  }
  originalEnv = null
})

describe('readEnvFile', () => {
  it('returns empty object when .env does not exist', async () => {
    if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH)
    const { readEnvFile } = await import('./env.js')
    expect(readEnvFile()).toEqual({})
  })

  it('parses KEY=VALUE pairs', async () => {
    writeFileSync(ENV_PATH, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile()
    expect(result['FOO']).toBe('bar')
    expect(result['BAZ']).toBe('qux')
  })

  it('strips double quotes', async () => {
    writeFileSync(ENV_PATH, 'FOO="hello world"\n')
    const { readEnvFile } = await import('./env.js')
    expect(readEnvFile()['FOO']).toBe('hello world')
  })

  it('strips single quotes', async () => {
    writeFileSync(ENV_PATH, "FOO='hello world'\n")
    const { readEnvFile } = await import('./env.js')
    expect(readEnvFile()['FOO']).toBe('hello world')
  })

  it('ignores comment lines', async () => {
    writeFileSync(ENV_PATH, '# comment\nFOO=bar\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile()
    expect(Object.keys(result)).not.toContain('#')
    expect(result['FOO']).toBe('bar')
  })

  it('filters to requested keys only', async () => {
    writeFileSync(ENV_PATH, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile(['FOO'])
    expect(result['FOO']).toBe('bar')
    expect(result['BAZ']).toBeUndefined()
  })
})
