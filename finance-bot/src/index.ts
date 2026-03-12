import { initDatabase, seedDirections, getCardByZenmoneyAccount, getCardByFintabloId, getManagerById, createPendingTransaction, updatePendingTransaction, getPendingTransactionByZenmoneyId, getAllCards, linkCardToZenmoney, getAllDirections, getActiveManagers, getPendingByManagerId } from './db.js'
import { syncAccountsFromFintablo } from './handlers/admin.js'
import { createBot } from './bot.js'
import { startPolling, stopPolling, type ZenMoneyTransaction } from './zenmoney.js'
import { postTransaction } from './fintablo.js'
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

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const normalize = (s: string) => s.replace(/[.\s]/g, '').toLowerCase()

  function resolveDirection(card: { direction_id: number | null }) {
    if (!card.direction_id) return { id: null, name: null }
    const dir = getAllDirections().find(d => d.id === card.direction_id)
    return dir ? { id: dir.fintablo_direction_id, name: dir.name } : { id: null, name: null }
  }

  // ─── ZenMoney polling ───────────────────────────────────────────────────
  const handleTransaction = async (txn: ZenMoneyTransaction) => {
    const existing = getPendingTransactionByZenmoneyId(txn.id)
    if (existing) return

    const isTransfer = txn.outcome > 0 && txn.income > 0
    const isExpense = txn.outcome > 0 && txn.income === 0
    const isIncome = txn.income > 0 && txn.outcome === 0

    const outcomeCard = txn.outcomeAccount ? getCardByZenmoneyAccount(txn.outcomeAccount) : null
    const incomeCard = txn.incomeAccount ? getCardByZenmoneyAccount(txn.incomeAccount) : null

    // ── TRANSFER between two linked cards ──
    if (isTransfer && outcomeCard && incomeCard) {
      const fromDir = resolveDirection(outcomeCard)
      const toDir = resolveDirection(incomeCard)

      // Cross-direction alert
      if (fromDir.id && toDir.id && fromDir.id !== toDir.id) {
        try {
          await bot.api.sendMessage(
            ADMIN_CHAT_ID,
            `Перевод между разными направлениями!\n\n` +
            `${txn.outcome}₽ | ${txn.date}\n` +
            `Откуда: ${outcomeCard.fintablo_account_name} (${fromDir.name ?? '?'})\n` +
            `Куда: ${incomeCard.fintablo_account_name} (${toDir.name ?? '?'})\n\n` +
            `Проверь корректность.`
          )
        } catch (err) {
          logger.error({ err }, 'Failed to notify about cross-direction transfer')
        }
      }

      // Auto-send transfer to FinTablo (no manager approval needed)
      const txnId = createPendingTransaction({
        zenmoney_txn_id: txn.id,
        amount: txn.outcome,
        date: txn.date,
        txn_group: 'transfer',
        account_id: outcomeCard.fintablo_account_id,
        account_info: outcomeCard.fintablo_account_name,
        account2_id: incomeCard.fintablo_account_id,
        account2_info: incomeCard.fintablo_account_name,
        description: txn.comment ?? txn.payee ?? 'Перевод между счетами',
      })

      // Auto-send transfer to FinTablo
      try {
        const fintabloId = await postTransaction({
          date: txn.date,
          value: txn.outcome,
          group: 'transfer',
          moneybagId: outcomeCard.fintablo_account_id,
          moneybag2Id: incomeCard.fintablo_account_id,
          description: txn.comment ?? txn.payee ?? 'Перевод между счетами',
        })
        updatePendingTransaction(txnId, { status: 'sent', fintablo_txn_id: fintabloId })
        logger.info({ txnId, fintabloId, from: outcomeCard.fintablo_account_name, to: incomeCard.fintablo_account_name, amount: txn.outcome }, 'Transfer sent to FinTablo')
      } catch (err) {
        updatePendingTransaction(txnId, { status: 'failed' })
        logger.error({ err, txnId }, 'Failed to send transfer to FinTablo')
      }
      return
    }

    // ── TRANSFER where only one side is linked ── (skip, not our card)
    if (isTransfer && !outcomeCard && !incomeCard) return

    // ── EXPENSE from a linked card ──
    if (isExpense && outcomeCard) {
      if (!outcomeCard.manager_id) {
        logger.debug({ txnId: txn.id }, 'Card has no manager linked, skipping')
        return
      }
      const manager = getManagerById(outcomeCard.manager_id)
      if (!manager || manager.status !== 'active') return

      const dir = resolveDirection(outcomeCard)
      const txnId = createPendingTransaction({
        zenmoney_txn_id: txn.id,
        manager_id: manager.id,
        amount: txn.outcome,
        date: txn.date,
        txn_group: 'outcome',
        account_info: outcomeCard.fintablo_account_name,
        account_id: outcomeCard.fintablo_account_id,
        direction_id: dir.id,
        direction_name: dir.name,
      })

      logger.info({ txnId, manager: manager.name, amount: txn.outcome }, 'Expense for manager')
      await notifyManagerAboutTransaction(bot.api, parseInt(manager.telegram_id, 10), txnId, txn.outcome, txn.date, outcomeCard.fintablo_account_name)
      return
    }

    // ── INCOME to a linked card (refund or profit withdrawal) ──
    if (isIncome && incomeCard) {
      const { InlineKeyboard } = await import('grammy')
      const txnId = createPendingTransaction({
        zenmoney_txn_id: txn.id,
        amount: txn.income,
        date: txn.date,
        txn_group: 'income',
        account_id: incomeCard.fintablo_account_id,
        account_info: incomeCard.fintablo_account_name,
        description: txn.comment ?? txn.payee ?? undefined,
      })

      const keyboard = new InlineKeyboard()
        .text('Возврат (в FinТабло)', `income_refund:${txnId}`)
        .row()
        .text('Вывод прибыли (пропустить)', `income_skip:${txnId}`)

      try {
        await bot.api.sendMessage(
          ADMIN_CHAT_ID,
          `Зачисление на физ-карту\n\n` +
          `${txn.income}₽ | ${txn.date}\n` +
          `Карта: ${incomeCard.fintablo_account_name}\n` +
          `Описание: ${txn.comment ?? txn.payee ?? '---'}\n\n` +
          `Это возврат или вывод прибыли с ИП?`,
          { reply_markup: keyboard }
        )
      } catch (err) {
        logger.error({ err }, 'Failed to ask admin about income')
      }
      logger.info({ txnId, amount: txn.income, card: incomeCard.fintablo_account_name }, 'Income on linked card, asked admin')
      return
    }

    // ── Transfer with one linked side ──
    if (isTransfer) {
      const card = outcomeCard ?? incomeCard
      if (!card) return

      if (outcomeCard && !incomeCard) {
        // Money leaving our card to unknown account -- treat as expense
        if (!outcomeCard.manager_id) return
        const manager = getManagerById(outcomeCard.manager_id)
        if (!manager || manager.status !== 'active') return

        const dir = resolveDirection(outcomeCard)
        const txnId = createPendingTransaction({
          zenmoney_txn_id: txn.id,
          manager_id: manager.id,
          amount: txn.outcome,
          date: txn.date,
          txn_group: 'outcome',
          account_info: outcomeCard.fintablo_account_name,
          account_id: outcomeCard.fintablo_account_id,
          direction_id: dir.id,
          direction_name: dir.name,
        })
        logger.info({ txnId, manager: manager.name, amount: txn.outcome }, 'Transfer out (treated as expense)')
        await notifyManagerAboutTransaction(bot.api, parseInt(manager.telegram_id, 10), txnId, txn.outcome, txn.date, outcomeCard.fintablo_account_name)
      }
      // incomeCard only (money from unknown to our card) -- same as income
      if (incomeCard && !outcomeCard) {
        const { InlineKeyboard } = await import('grammy')
        const txnId = createPendingTransaction({
          zenmoney_txn_id: txn.id,
          amount: txn.income,
          date: txn.date,
          txn_group: 'income',
          account_id: incomeCard.fintablo_account_id,
          account_info: incomeCard.fintablo_account_name,
          description: txn.comment ?? txn.payee ?? undefined,
        })
        const keyboard = new InlineKeyboard()
          .text('Возврат (в FinТабло)', `income_refund:${txnId}`)
          .row()
          .text('Вывод прибыли (пропустить)', `income_skip:${txnId}`)

        try {
          await bot.api.sendMessage(
            ADMIN_CHAT_ID,
            `Зачисление на физ-карту (перевод)\n\n` +
            `${txn.income}₽ | ${txn.date}\n` +
            `Карта: ${incomeCard.fintablo_account_name}\n` +
            `Описание: ${txn.comment ?? txn.payee ?? '---'}\n\n` +
            `Это возврат или вывод прибыли с ИП?`,
            { reply_markup: keyboard }
          )
        } catch (err) {
          logger.error({ err }, 'Failed to ask admin about income transfer')
        }
        logger.info({ txnId, amount: txn.income, card: incomeCard.fintablo_account_name }, 'Income transfer, asked admin')
      }
    }
  }

  const handleAuthError = () => {
    try {
      bot.api.sendMessage(ADMIN_CHAT_ID, 'ZenMoney токен истек! Обнови ZENMONEY_ACCESS_TOKEN в .env и перезапусти бота.')
    } catch { /* ignore */ }
  }

  const handleAccountsSync = (zenAccounts: Array<{ id: string; title: string; syncID: string[] | null }>) => {
    const cards = getAllCards()
    for (const zenAcc of zenAccounts) {
      const match = cards.find(c =>
        normalize(c.fintablo_account_name) === normalize(zenAcc.title) && !c.zenmoney_account_id
      )
      if (match) {
        linkCardToZenmoney(match.fintablo_account_id, zenAcc.id)
        logger.info({ card: match.fintablo_account_name, zenmoneyId: zenAcc.id }, 'Auto-linked ZenMoney account by name')
      }
    }
  }

  startPolling(handleTransaction, handleAuthError, handleAccountsSync)
  logger.info('ZenMoney polling started')

  // Daily reminder at 10:00 Moscow time for unprocessed transactions
  const startDailyReminder = () => {
    const checkAndRemind = async () => {
      const managers = getActiveManagers()
      for (const mgr of managers) {
        const pending = getPendingByManagerId(mgr.id)
        if (pending.length === 0) continue

        const word = pending.length === 1 ? 'операция' : pending.length < 5 ? 'операции' : 'операций'
        try {
          await bot.api.sendMessage(
            mgr.telegram_id,
            `У тебя не разнесено ${pending.length} ${word}. Пожалуйста заполни необходимые поля и подтверди операции.`
          )
          logger.info({ manager: mgr.name, count: pending.length }, 'Sent daily reminder')
        } catch (err) {
          logger.error({ err, manager: mgr.name }, 'Failed to send daily reminder')
        }
      }
    }

    const scheduleNext = () => {
      const now = new Date()
      const msk = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }))
      const target = new Date(msk)
      target.setHours(10, 0, 0, 0)
      if (msk >= target) target.setDate(target.getDate() + 1)

      const mskOffset = msk.getTime() - now.getTime()
      const delay = target.getTime() - msk.getTime()

      logger.info({ nextReminder: target.toISOString(), delayMs: delay }, 'Scheduled daily reminder')
      setTimeout(async () => {
        await checkAndRemind()
        scheduleNext()
      }, delay)
    }

    scheduleNext()
  }

  startDailyReminder()

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
