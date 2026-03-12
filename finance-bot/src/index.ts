import { initDatabase, seedDirections, getCardByZenmoneyAccount, getCardByFintabloId, getManagerById, createPendingTransaction, getPendingTransactionByZenmoneyId } from './db.js'
import { syncAccountsFromFintablo } from './handlers/admin.js'
import { createBot } from './bot.js'
import { startPolling, stopPolling, type ZenMoneyTransaction } from './zenmoney.js'
import { notifyManagerAboutTransaction } from './handlers/expense.js'
import { logger } from './logger.js'
import { FINANCE_BOT_TOKEN, ADMIN_CHAT_ID } from './config.js'

async function main() {
  if (!FINANCE_BOT_TOKEN) {
    logger.error('FINANCE_BOT_TOKEN not set')
    process.exit(1)
  }

  // Init DB
  initDatabase()
  seedDirections()
  logger.info('Database initialized')

  // Sync accounts from FinTablo
  try {
    const count = await syncAccountsFromFintablo()
    logger.info({ count }, 'Synced accounts from FinTablo')
  } catch (err) {
    logger.error({ err }, 'Failed to sync accounts from FinTablo on startup')
  }

  // Create bot
  const bot = createBot()

  // ZenMoney polling
  const handleNewTransaction = async (txn: ZenMoneyTransaction) => {
    // Skip if already processed
    const existing = getPendingTransactionByZenmoneyId(txn.id)
    if (existing) return

    // Find card by ZenMoney account
    const card = getCardByZenmoneyAccount(txn.outcomeAccount)
    if (!card) {
      logger.debug({ txnId: txn.id, account: txn.outcomeAccount }, 'No card linked for this account, skipping')
      return
    }

    // Find manager
    if (!card.manager_id) {
      logger.debug({ txnId: txn.id, account: txn.outcomeAccount }, 'Card has no manager linked, skipping')
      return
    }
    const manager = getManagerById(card.manager_id)
    if (!manager || manager.status !== 'active') {
      logger.warn({ txnId: txn.id, managerId: card.manager_id }, 'Manager not active, skipping')
      return
    }

    const accountInfo = card.fintablo_account_name

    // Create pending transaction
    const txnId = createPendingTransaction({
      zenmoney_txn_id: txn.id,
      manager_id: manager.id,
      amount: txn.outcome,
      date: txn.date,
      account_info: accountInfo,
      direction_id: card.direction_id,
    })

    logger.info({ txnId, zenTxnId: txn.id, manager: manager.name, amount: txn.outcome }, 'New transaction for manager')

    // Notify manager
    await notifyManagerAboutTransaction(
      bot.api,
      parseInt(manager.telegram_id, 10),
      txnId,
      txn.outcome,
      txn.date,
      accountInfo
    )
  }

  const handleAuthError = () => {
    try {
      bot.api.sendMessage(ADMIN_CHAT_ID, 'ZenMoney токен истек! Обнови ZENMONEY_ACCESS_TOKEN в .env и перезапусти бота.')
    } catch { /* ignore */ }
  }

  startPolling(handleNewTransaction, handleAuthError)
  logger.info('ZenMoney polling started')

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...')
    stopPolling()
    bot.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start bot
  await bot.start({
    onStart: () => logger.info('Finance bot started'),
  })
}

main().catch(err => {
  logger.error({ err }, 'Fatal error')
  process.exit(1)
})
