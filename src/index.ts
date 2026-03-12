import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import path from 'path'
import { TELEGRAM_BOT_TOKEN, STORE_DIR, PROJECT_ROOT } from './config.js'
import { initDatabase, clearSession } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { createBot, sendMessage } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { logger } from './logger.js'

const PID_FILE = path.join(STORE_DIR, 'claudeclaw.pid')

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })
  if (existsSync(PID_FILE)) {
    const raw = readFileSync(PID_FILE, 'utf-8').trim()
    const oldPid = parseInt(raw, 10)
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // check if alive
        logger.warn({ oldPid }, 'Killing stale ClaudeClaw process')
        process.kill(oldPid, 'SIGTERM')
        // brief wait for it to die
        const start = Date.now()
        while (Date.now() - start < 2000) {
          try { process.kill(oldPid, 0) } catch { break }
        }
      } catch {
        // Process not running — stale PID file
      }
    }
  }
  writeFileSync(PID_FILE, String(process.pid))
}

function releaseLock(): void {
  try { unlinkSync(PID_FILE) } catch { /* ignore */ }
}

function showBanner(): void {
  try {
    const bannerPath = path.join(PROJECT_ROOT, 'banner.txt')
    if (existsSync(bannerPath)) {
      console.log(readFileSync(bannerPath, 'utf-8'))
      return
    }
  } catch { /* ignore */ }
  console.log('=== ClaudeClaw ===')
}

async function main(): Promise<void> {
  showBanner()

  if (!TELEGRAM_BOT_TOKEN) {
    console.error('\nError: TELEGRAM_BOT_TOKEN is not set.\nRun `npm run setup` or add it to .env\n')
    process.exit(1)
  }

  acquireLock()

  initDatabase()
  logger.info('Database initialized')

  // Memory decay sweep — once on startup, then every 24h
  runDecaySweep()
  setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  cleanupOldUploads()

  const bot = createBot()

  // Scheduler
  initScheduler(async (chatId, text) => {
    await sendMessage(bot, chatId, text)
  })

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...')
    stopScheduler()
    releaseLock()
    try { await bot.stop() } catch { /* ignore */ }
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    logger.info('Starting Telegram bot...')
    await bot.start()
    logger.info('ClaudeClaw running')
  } catch (err) {
    logger.error({ err }, 'Failed to start bot')
    releaseLock()
    process.exit(1)
  }
}

main().catch(err => {
  logger.error({ err }, 'Fatal error')
  releaseLock()
  process.exit(1)
})
