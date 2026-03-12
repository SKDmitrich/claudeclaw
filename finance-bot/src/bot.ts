import { Bot } from 'grammy'
import { FINANCE_BOT_TOKEN } from './config.js'
import { logger } from './logger.js'
import { startHandler } from './handlers/start.js'
import { adminMenuHandler } from './handlers/admin.js'
import { callbackHandler } from './handlers/callbacks.js'
import { expenseHandler } from './handlers/expense.js'

export function createBot(): Bot {
  const bot = new Bot(FINANCE_BOT_TOKEN)

  bot.use(async (ctx, next) => {
    logger.debug({ update_id: ctx.update.update_id, from: ctx.from?.id }, 'Update')
    await next()
  })

  // Commands
  bot.command('start', startHandler)
  bot.command('admin', adminMenuHandler)

  // Callbacks
  bot.on('callback_query:data', callbackHandler)

  // Text and voice messages
  bot.on('message:text', expenseHandler)
  bot.on('message:voice', expenseHandler)

  bot.catch(err => {
    logger.error({ err: err.error }, 'Bot error')
  })

  return bot
}
