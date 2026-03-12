import type { Api, Context } from 'grammy'
import { userStates, txnQueue } from '../state.js'
import {
  createManager, getManagerByTelegramId,
  getPendingTransaction, updatePendingTransaction,
  createPendingTransaction, getPendingByManagerId,
} from '../db.js'
import { extractExpenseFields } from '../ai.js'
import { ADMIN_CHAT_ID } from '../config.js'
import { logger } from '../logger.js'
import { InlineKeyboard } from 'grammy'

export async function expenseHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id
  const text = ctx.message?.text
  if (!userId || !text) return

  const state = userStates.get(userId)

  // Registration flow
  if (state?.type === 'registration_name') {
    await handleRegistrationName(ctx, userId, text)
    return
  }

  // Answering "what was this for?"
  if (state?.type === 'awaiting_expense_description') {
    await handleExpenseDescription(ctx, userId, text, state.txnId)
    return
  }

  // Manual entry (no active state)
  const manager = getManagerByTelegramId(String(userId))
  if (!manager || manager.status !== 'active') {
    // Not registered or not active -- ignore non-command messages
    return
  }

  await handleManualEntry(ctx, userId, text, manager.id)
}

async function handleRegistrationName(ctx: Context, userId: number, name: string): Promise<void> {
  const username = ctx.from?.username ?? null
  const managerId = createManager(name, String(userId), username)

  userStates.delete(userId)

  await ctx.reply(`${name}, заявка отправлена. Жди подтверждения.`)

  // Notify admin
  const keyboard = new InlineKeyboard()
    .text('Одобрить', `approve_mgr:${managerId}`)
    .text('Отклонить', `reject_mgr:${managerId}`)

  try {
    await ctx.api.sendMessage(
      ADMIN_CHAT_ID,
      `Новая заявка:\n${name} (@${username ?? '?'}, ID: ${userId})`,
      { reply_markup: keyboard }
    )
  } catch (err) {
    logger.error({ err }, 'Failed to notify admin about new manager')
  }
}

async function handleExpenseDescription(
  ctx: Context,
  userId: number,
  text: string,
  txnId: number
): Promise<void> {
  const txn = getPendingTransaction(txnId)
  if (!txn) {
    userStates.delete(userId)
    await ctx.reply('Транзакция не найдена.')
    return
  }

  await ctx.replyWithChatAction('typing')

  const extracted = await extractExpenseFields(text, {
    amount: txn.amount,
    date: txn.date,
    accountName: txn.account_info ?? undefined,
  })

  updatePendingTransaction(txnId, {
    status: 'enriched',
    category_id: extracted.category_id,
    category_name: extracted.category_name,
    direction_id: extracted.direction_id,
    description: extracted.description,
  })

  const keyboard = new InlineKeyboard()
    .text('Подтвердить', `confirm_txn:${txnId}`)
    .text('Отменить', `cancel_txn:${txnId}`)

  const lines = [
    `${txn.date} | ${txn.amount}₽`,
    `Статья: ${extracted.category_name ?? 'не определена'}`,
    `Направление: ${extracted.direction_name ?? 'не определено'}`,
    `Описание: ${extracted.description}`,
    '',
    'Все верно?',
  ]

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard })
}

async function handleManualEntry(
  ctx: Context,
  userId: number,
  text: string,
  managerId: number
): Promise<void> {
  await ctx.replyWithChatAction('typing')

  const today = new Date().toISOString().slice(0, 10)
  const extracted = await extractExpenseFields(text)

  // Try to parse amount from text
  const amountMatch = text.match(/(\d[\d\s]*[\d.,]*\d*)/)
  const amount = amountMatch
    ? parseFloat(amountMatch[1].replace(/\s/g, '').replace(',', '.'))
    : 0

  const txnId = createPendingTransaction({
    manager_id: managerId,
    amount,
    date: today,
    category_id: extracted.category_id,
    category_name: extracted.category_name,
    direction_id: extracted.direction_id,
    description: extracted.description,
  })

  updatePendingTransaction(txnId, { status: 'enriched' })

  const keyboard = new InlineKeyboard()
    .text('Подтвердить', `confirm_txn:${txnId}`)
    .text('Отменить', `cancel_txn:${txnId}`)

  const lines = [
    `${today} | ${amount}₽`,
    `Статья: ${extracted.category_name ?? 'не определена'}`,
    `Направление: ${extracted.direction_name ?? 'не определено'}`,
    `Описание: ${extracted.description}`,
    '',
    'Все верно?',
  ]

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard })
}

// Called after a transaction is confirmed/cancelled to process next queued
export async function processNextInQueue(api: Api, telegramUserId: number): Promise<void> {
  const queue = txnQueue.get(telegramUserId)
  if (!queue || queue.length === 0) {
    txnQueue.delete(telegramUserId)
    return
  }

  const nextTxnId = queue.shift()!
  if (queue.length === 0) txnQueue.delete(telegramUserId)

  const txn = getPendingTransaction(nextTxnId)
  if (!txn) return

  userStates.set(telegramUserId, { type: 'awaiting_expense_description', txnId: nextTxnId })

  try {
    await api.sendMessage(
      String(telegramUserId),
      `Списание ${txn.amount}₽ (${txn.account_info ?? '?'}) ${txn.date}\nНа что?`,
      { reply_markup: { force_reply: true } }
    )
  } catch (err) {
    logger.error({ err, telegramUserId, txnId: nextTxnId }, 'Failed to ask manager about next queued txn')
  }
}

// Called from ZenMoney polling when a new transaction is found for a manager
export async function notifyManagerAboutTransaction(
  api: Api,
  telegramUserId: number,
  txnId: number,
  amount: number,
  date: string,
  accountInfo: string
): Promise<void> {
  const currentState = userStates.get(telegramUserId)

  if (currentState) {
    // Manager is busy with another transaction, queue this one
    const queue = txnQueue.get(telegramUserId) ?? []
    queue.push(txnId)
    txnQueue.set(telegramUserId, queue)
    logger.info({ telegramUserId, txnId, queueSize: queue.length }, 'Queued transaction for busy manager')
    return
  }

  userStates.set(telegramUserId, { type: 'awaiting_expense_description', txnId })

  try {
    const msg = await api.sendMessage(
      String(telegramUserId),
      `Списание ${amount}₽ (${accountInfo}) ${date}\nНа что?`,
      { reply_markup: { force_reply: true } }
    )
    updatePendingTransaction(txnId, { bot_message_id: msg.message_id })
  } catch (err) {
    logger.error({ err, telegramUserId, txnId }, 'Failed to notify manager about transaction')
  }
}
