#!/usr/bin/env tsx
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'
import https from 'https'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ── ANSI ──────────────────────────────────────
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

function ok(label: string, value?: string) {
  const val = value ? dim(` — ${value}`) : ''
  console.log(`  ${green('✓')} ${label}${val}`)
}
function warn(label: string, value?: string) {
  const val = value ? dim(` — ${value}`) : ''
  console.log(`  ${yellow('⚠')} ${label}${val}`)
}
function fail(label: string, value?: string) {
  const val = value ? dim(` — ${value}`) : ''
  console.log(`  ${red('✗')} ${label}${val}`)
}

// ── Parse .env ────────────────────────────────
function readEnv(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const { readFileSync } = await import('fs') as any
  // sync approach
  const { readFileSync: rfs } = await (async () => ({ readFileSync: (await import('fs')).readFileSync }))()
  const result: Record<string, string> = {}
  try {
    const raw: string = (await import('fs')).readFileSync(envPath, 'utf-8') as string
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const idx = t.indexOf('=')
      if (idx === -1) continue
      let val = t.slice(idx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      result[t.slice(0, idx).trim()] = val
    }
  } catch {}
  return result
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

async function main() {
  console.log(bold('\nClaudeClaw — Status\n'))

  // ── Node version ──
  const nodeVer = parseInt(process.versions.node.split('.')[0])
  if (nodeVer >= 20) {
    ok(`Node.js ${process.versions.node}`)
  } else {
    fail(`Node.js ${process.versions.node}`, 'need 20+')
  }

  // ── Claude CLI ────
  const claudeResult = spawnSync('claude', ['--version'], { encoding: 'utf-8' })
  if (claudeResult.status === 0) {
    ok('claude CLI', claudeResult.stdout.trim())
  } else {
    fail('claude CLI not found')
  }

  // ── .env exists ───
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) {
    fail('.env not found', 'run npm run setup')
    process.exit(1)
  }

  const { readFileSync } = await import('fs')
  const env: Record<string, string> = {}
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const idx = t.indexOf('=')
    if (idx === -1) continue
    let val = t.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    env[t.slice(0, idx).trim()] = val
  }

  // ── Telegram bot token ────
  const token = env['TELEGRAM_BOT_TOKEN']
  if (token) {
    try {
      const resp = await httpsGet(`https://api.telegram.org/bot${token}/getMe`)
      const parsed = JSON.parse(resp)
      if (parsed.ok) {
        ok('Telegram bot token', `@${parsed.result.username}`)
      } else {
        fail('Telegram bot token', 'invalid token')
      }
    } catch {
      warn('Telegram bot token', 'could not verify (network?)')
    }
  } else {
    fail('Telegram bot token', 'not set')
  }

  // ── Chat ID ────
  const chatId = env['ALLOWED_CHAT_ID']
  if (chatId) {
    ok('Allowed chat ID', chatId)
  } else {
    warn('Allowed chat ID', 'not set — bot accepts all chats')
  }

  // ── Groq STT ────
  if (env['GROQ_API_KEY']) {
    ok('Groq STT', 'configured')
  } else {
    warn('Groq STT', 'GROQ_API_KEY not set')
  }

  // ── ElevenLabs TTS ────
  if (env['ELEVENLABS_API_KEY'] && env['ELEVENLABS_VOICE_ID']) {
    ok('ElevenLabs TTS', 'configured')
  } else if (env['ELEVENLABS_API_KEY']) {
    warn('ElevenLabs TTS', 'ELEVENLABS_VOICE_ID not set')
  } else {
    warn('ElevenLabs TTS', 'ELEVENLABS_API_KEY not set')
  }

  // ── Service status ────
  console.log()
  const platform = process.platform
  if (platform === 'darwin') {
    const result = spawnSync('launchctl', ['list', 'com.claudeclaw.app'], { encoding: 'utf-8' })
    if (result.status === 0) {
      ok('launchd service', 'running')
    } else {
      warn('launchd service', 'not running or not installed')
    }
  } else if (platform === 'linux') {
    const result = spawnSync('systemctl', ['--user', 'is-active', 'claudeclaw'], { encoding: 'utf-8' })
    if (result.stdout.trim() === 'active') {
      ok('systemd service', 'active')
    } else {
      warn('systemd service', result.stdout.trim())
    }
  }

  // ── DB ────
  const dbPath = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db')
  if (existsSync(dbPath)) {
    try {
      const Database = (await import('better-sqlite3')).default
      const db = new Database(dbPath, { readonly: true })
      const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any).c
      const taskCount = (db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as any).c
      db.close()
      ok('Database', `${memCount} memories, ${taskCount} scheduled tasks`)
    } catch {
      warn('Database', 'could not read')
    }
  } else {
    warn('Database', 'not created yet (start the bot once)')
  }

  console.log()
}

main().catch(err => {
  console.error(red('Status check failed: ' + err.message))
  process.exit(1)
})
