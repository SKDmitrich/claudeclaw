import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '..')
const CLAUDECLAW_ROOT = path.resolve(PROJECT_ROOT, '..')
export const STORE_DIR = path.join(PROJECT_ROOT, 'store')

function readEnvFile(): Record<string, string> {
  const envPath = path.join(CLAUDECLAW_ROOT, '.env')
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

const env = readEnvFile()

export const FINANCE_BOT_TOKEN = env.FINANCE_BOT_TOKEN ?? ''
export const ZENMONEY_ACCESS_TOKEN = env.ZENMONEY_ACCESS_TOKEN ?? ''
export const ZENMONEY_POLL_INTERVAL = parseInt(env.ZENMONEY_POLL_INTERVAL ?? '3600', 10)
export const FINTABLO_API_TOKEN = env.FINTABLO_API_TOKEN ?? ''
export const FINTABLO_API_URL = env.FINTABLO_API_URL ?? 'https://api.fintablo.ru'
export const ADMIN_CHAT_ID = env.ALLOWED_CHAT_ID ?? ''
export const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY ?? ''
