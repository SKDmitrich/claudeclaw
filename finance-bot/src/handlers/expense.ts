import type { Api, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { userStates, txnQueue, type MissingField } from '../state.js'
import {
  createManager, getManagerByTelegramId,
  getPendingTransaction, updatePendingTransaction,
  createPendingTransaction,
  type PendingTransaction,
} from '../db.js'
import { extractExpenseFields } from '../ai.js'
import { ADMIN_CHAT_ID } from '../config.js'
import { logger } from '../logger.js'

const FIELD_LABELS: Record<MissingField, string> = {
  date: 'Дата (ГГГГ-ММ-ДД)',
  amount: 'Сумма',
  account_info: 'Счет или карта',
  category: 'Статья расходов',
  direction: 'Направление бизнеса',
  counterparty: 'Контрагент (кому/от кого)',
}

export async function expenseHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id
  const text = ctx.message?.text
  if (!userId || !text) return

  const state = userStates.get(userId)

  if (state?.type === 'registration_name') {
    await handleRegistrationName(ctx, userId, text)
    return
  }

  if (state?.type === 'awaiting_expense_description') {
    await handleExpenseDescription(ctx, userId, text, state.txnId)
    return
  }

  if (state?.type === 'filling_missing_field') {
    await handleFillingField(ctx, userId, text, state.txnId, state.field, state.remaining)
    return
  }

  const manager = getManagerByTelegramId(String(userId))
  if (!manager || manager.status !== 'active') return

  await handleManualEntry(ctx, userId, text, manager.id)
}

// ─── Registration ────────────────────────────────────────────────────────────

async function handleRegistrationName(ctx: Context, userId: number, name: string): Promise<void> {
  const username = ctx.from?.username ?? null
  const managerId = createManager(name, String(userId), username)
  userStates.delete(userId)

  await ctx.reply(`${name}, заявка отправлена. Жди подтверждения.`)

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

// ─── Expense description (from ZenMoney polling) ────────────────────────────

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
    amount: txn.amount ?? undefined,
    date: txn.date ?? undefined,
    accountName: txn.account_info ?? undefined,
  })

  updatePendingTransaction(txnId, {
    status: 'enriched',
    date: extracted.date ?? txn.date,
    amount: extracted.amount ?? txn.amount,
    category_id: extracted.category_id,
    category_name: extracted.category_name,
    direction_id: extracted.direction_id ?? txn.direction_id,
    direction_name: extracted.direction_name,
    counterparty_name: extracted.counterparty_name,
    description: extracted.description,
  })

  const updated = getPendingTransaction(txnId)!
  await checkAndAskMissing(ctx, userId, updated)
}

// ─── Filling missing fields ─────────────────────────────────────────────────

async function handleFillingField(
  ctx: Context,
  userId: number,
  text: string,
  txnId: number,
  field: MissingField,
  remaining: MissingField[]
): Promise<void> {
  const txn = getPendingTransaction(txnId)
  if (!txn) {
    userStates.delete(userId)
    return
  }

  // Apply the answer to the correct field
  const update: Partial<PendingTransaction> = {}
  switch (field) {
    case 'date':
      update.date = text.trim()
      break
    case 'amount': {
      const num = parseFloat(text.replace(/\s/g, '').replace(',', '.'))
      if (isNaN(num)) {
        await ctx.reply('Не могу разобрать сумму. Введи число:')
        return
      }
      update.amount = num
      break
    }
    case 'account_info':
      update.account_info = text.trim()
      break
    case 'category':
      // Try to match by name or ID
      update.category_name = text.trim()
      break
    case 'direction':
      update.direction_name = text.trim()
      break
    case 'counterparty':
      update.counterparty_name = text.trim()
      break
  }

  updatePendingTransaction(txnId, update)

  if (remaining.length > 0) {
    const nextField = remaining[0]
    const rest = remaining.slice(1)
    userStates.set(userId, { type: 'filling_missing_field', txnId, field: nextField, remaining: rest })
    await ctx.reply(`${FIELD_LABELS[nextField]}:`, { reply_markup: { force_reply: true } })
  } else {
    const updated = getPendingTransaction(txnId)!
    await showConfirmation(ctx, userId, updated)
  }
}

// ─── Manual entry ───────────────────────────────────────────────────────────

async function handleManualEntry(
  ctx: Context,
  userId: number,
  text: string,
  managerId: number
): Promise<void> {
  await ctx.replyWithChatAction('typing')

  const extracted = await extractExpenseFields(text)

  const txnId = createPendingTransaction({
    manager_id: managerId,
    amount: extracted.amount,
    date: extracted.date,
    account_info: extracted.account_name,
    category_id: extracted.category_id,
    category_name: extracted.category_name,
    direction_id: extracted.direction_id,
    direction_name: extracted.direction_name,
    counterparty_name: extracted.counterparty_name,
    description: extracted.description,
  })

  updatePendingTransaction(txnId, { status: 'enriched' })

  const updated = getPendingTransaction(txnId)!
  await checkAndAskMissing(ctx, userId, updated)
}

// ─── Validation ─────────────────────────────────────────────────────────────

function getMissingFields(txn: PendingTransaction): MissingField[] {
  const missing: MissingField[] = []
  if (!txn.date) missing.push('date')
  if (txn.amount == null || txn.amount === 0) missing.push('amount')
  if (!txn.account_info && !txn.account_id) missing.push('account_info')
  if (!txn.category_id && !txn.category_name) missing.push('category')
  if (!txn.direction_id && !txn.direction_name) missing.push('direction')
  if (!txn.counterparty_id && !txn.counterparty_name) missing.push('counterparty')
  return missing
}

async function checkAndAskMissing(ctx: Context, userId: number, txn: PendingTransaction): Promise<void> {
  const missing = getMissingFields(txn)

  if (missing.length === 0) {
    await showConfirmation(ctx, userId, txn)
    return
  }

  // Show what we have so far
  const lines = [
    'Заполнено:',
    `  Дата: ${txn.date ?? '---'}`,
    `  Сумма: ${txn.amount != null ? txn.amount + '₽' : '---'}`,
    `  Счет: ${txn.account_info ?? '---'}`,
    `  Статья: ${txn.category_name ?? '---'}`,
    `  Направление: ${txn.direction_name ?? '---'}`,
    `  Контрагент: ${txn.counterparty_name ?? '---'}`,
    `  Описание: ${txn.description ?? '---'}`,
    '',
    `Не хватает: ${missing.map(f => FIELD_LABELS[f]).join(', ')}`,
  ]
  await ctx.reply(lines.join('\n'))

  // Ask for the first missing field
  const firstField = missing[0]
  const rest = missing.slice(1)
  userStates.set(userId, { type: 'filling_missing_field', txnId: txn.id, field: firstField, remaining: rest })
  await ctx.reply(`${FIELD_LABELS[firstField]}:`, { reply_markup: { force_reply: true } })
}

async function showConfirmation(ctx: Context, userId: number, txn: PendingTransaction): Promise<void> {
  userStates.delete(userId)

  const keyboard = new InlineKeyboard()
    .text('Подтвердить', `confirm_txn:${txn.id}`)
    .text('Отменить', `cancel_txn:${txn.id}`)

  const lines = [
    'Проверь операцию:',
    '',
    `Дата: ${txn.date}`,
    `Сумма: ${txn.amount}₽`,
    `Счет: ${txn.account_info ?? '?'}`,
    `Статья: ${txn.category_name ?? '?'}`,
    `Направление: ${txn.direction_name ?? '?'}`,
    `Контрагент: ${txn.counterparty_name ?? '?'}`,
    `Описание: ${txn.description ?? ''}`,
  ]

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard })
}

// ─── Queue management ───────────────────────────────────────────────────────

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
