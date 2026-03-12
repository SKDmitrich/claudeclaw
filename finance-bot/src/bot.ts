import { Bot } from 'grammy'
import { FINANCE_BOT_TOKEN } from './config.js'
import { logger } from './logger.js'
import { startHandler } from './handlers/start.js'
import { managersHandler, cardsHandler, directionsHandler, linkcardHandler, unlinkcardHandler } from './handlers/admin.js'
import { callbackHandler } from './handlers/callbacks.js'
import { expenseHandler } from './handlers/expense.js'
import { getUnsentConfirmedTransactions, getPendingTransaction, updatePendingTransaction } from './db.js'
import { postTransaction } from './fintablo.js'
import { isAdmin } from './handlers/start.js'

export function createBot(): Bot {
  const bot = new Bot(FINANCE_BOT_TOKEN)

  bot.use(async (ctx, next) => {
    logger.debug({ update_id: ctx.update.update_id, from: ctx.from?.id }, 'Update')
    await next()
  })

  // Commands
  bot.command('start', startHandler)
  bot.command('managers', managersHandler)
  bot.command('cards', cardsHandler)
  bot.command('directions', directionsHandler)
  bot.command('linkcard', linkcardHandler)
  bot.command('unlinkcard', unlinkcardHandler)
  bot.command('retry', retryHandler)

  // Callbacks
  bot.on('callback_query:data', callbackHandler)

  // Text messages
  bot.on('message:text', expenseHandler)

  bot.catch(err => {
    logger.error({ err: err.error }, 'Bot error')
  })

  return bot
}

async function retryHandler(ctx: import('grammy').Context): Promise<void> {
  if (!ctx.chat?.id || !isAdmin(ctx.chat.id)) {
    await ctx.reply('Только для администратора.')
    return
  }

  const unsent = getUnsentConfirmedTransactions()
  if (unsent.length === 0) {
    await ctx.reply('Нет неотправленных транзакций.')
    return
  }

  let sent = 0
  let failed = 0
  for (const txn of unsent) {
    try {
      const fintabloId = await postTransaction({
        date: txn.date,
        amount: Math.abs(txn.amount) * -1,
        category_id: txn.category_id ?? undefined,
        direction_id: txn.direction_id ?? undefined,
        description: txn.description ?? undefined,
        currency: 'RUB',
      })
      updatePendingTransaction(txn.id, { status: 'sent', fintablo_txn_id: fintabloId })
      sent++
    } catch {
      failed++
    }
  }

  await ctx.reply(`Retry: отправлено ${sent}, ошибок ${failed}`)
}
