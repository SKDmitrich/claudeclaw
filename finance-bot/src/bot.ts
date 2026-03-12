import { Bot } from 'grammy'
import { FINANCE_BOT_TOKEN, ADMIN_CHAT_ID } from './config.js'
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

  // Register commands for Telegram menu button
  bot.api.setMyCommands([
    { command: 'start', description: 'Начать / Инструкция' },
    { command: 'admin', description: 'Панель администратора' },
  ])

  // Commands
  bot.command('start', startHandler)
  bot.command('admin', adminMenuHandler)

  // Callbacks
  bot.on('callback_query:data', callbackHandler)

  // Text and voice messages
  bot.on('message:text', expenseHandler)
  bot.on('message:voice', expenseHandler)

  bot.catch(async (err) => {
    logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'Bot error')

    // Notify user about the error
    try {
      const chatId = err.ctx?.chat?.id
      if (chatId) {
        await err.ctx.reply('Произошла ошибка. Попробуй ещё раз или обратись к администратору.')
      }
    } catch { /* ignore */ }

    // Notify admin
    const errMsg = err.error instanceof Error ? err.error.message : String(err.error)
    try {
      await bot.api.sendMessage(
        ADMIN_CHAT_ID,
        `Ошибка бота\n\nUser: ${err.ctx?.from?.id ?? '?'}\nОшибка: ${errMsg.slice(0, 300)}`
      )
    } catch { /* ignore */ }
  })

  return bot
}
