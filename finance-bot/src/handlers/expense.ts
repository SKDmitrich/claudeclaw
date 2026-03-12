import type { Api, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { userStates, txnQueue, type MissingField } from '../state.js'
import {
  createManager, getManagerByTelegramId,
  getPendingTransaction, updatePendingTransaction,
  createPendingTransaction, getAllDirections, getAllCards,
  getCardsByManagerId,
  type PendingTransaction,
} from '../db.js'
import { extractExpenseFields } from '../ai.js'
import { ADMIN_CHAT_ID } from '../config.js'
import { logger } from '../logger.js'
import { transcribeVoice } from '../voice.js'

const FIELD_LABELS: Record<MissingField, string> = {
  date: 'Дата (ГГГГ-ММ-ДД)',
  amount: 'Сумма',
  account_info: 'Счет или карта',
  category: 'Статья расходов',
  direction: 'Направление бизнеса',
  counterparty: 'Контрагент (кому/от кого)',
  description: 'Описание',
}

// Pre-parse obvious amount from text like "500 руб", "1200₽", "300 р"
function preParseAmount(text: string): { amount: number | undefined; cleanText: string } {
  const match = text.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(?:руб\.?|рублей|₽|р\.?\b)/i)
  if (match) {
    const num = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'))
    if (!isNaN(num)) {
      const cleanText = text.replace(match[0], '').trim()
      return { amount: num, cleanText: cleanText || text }
    }
  }
  return { amount: undefined, cleanText: text }
}

// Manager categories (from FinTablo) -- short names for callback_data
const MANAGER_CATEGORIES = [
  { id: 1045100, name: 'Самовыкупы' },
  { id: 1045121, name: 'Фотоконтент' },
  { id: 1045119, name: 'ПО и сервисы' },
  { id: 1045095, name: 'Логистика' },
  { id: 1342729, name: 'Брак' },
  { id: 1045094, name: 'Упаковка' },
  { id: 1327155, name: 'Упаковка не вх с/с' },
]

export async function expenseHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id
  if (!userId) return

  if (ctx.message?.voice) {
    await handleVoiceMessage(ctx, userId)
    return
  }

  const text = ctx.message?.text
  if (!text) return

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

// ─── Voice ───────────────────────────────────────────────────────────────────

async function handleVoiceMessage(ctx: Context, userId: number): Promise<void> {
  const manager = getManagerByTelegramId(String(userId))
  if (!manager || manager.status !== 'active') return

  await ctx.replyWithChatAction('typing')

  try {
    const file = await ctx.getFile()
    const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    const text = await transcribeVoice(url)

    if (!text) {
      await ctx.reply('Не удалось распознать голос. Попробуй ещё раз.')
      return
    }

    await ctx.reply(`Распознано: "${text}"`)

    const state = userStates.get(userId)

    if (state?.type === 'awaiting_expense_description') {
      await handleExpenseDescription(ctx, userId, text, state.txnId)
    } else if (state?.type === 'filling_missing_field') {
      await handleFillingField(ctx, userId, text, state.txnId, state.field, state.remaining)
    } else {
      await handleManualEntry(ctx, userId, text, manager.id)
    }
  } catch (err) {
    logger.error({ err }, 'Voice processing failed')
    await ctx.reply('Ошибка обработки голосового сообщения.')
  }
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

// ─── Auto-fill account & direction from manager's linked card ───────────────

function autoFillFromManager(managerId: number, txn: Partial<PendingTransaction>): Partial<PendingTransaction> {
  const cards = getCardsByManagerId(managerId)
  if (cards.length === 0) return txn

  const card = cards[0] // Primary linked card
  const result = { ...txn }

  if (!result.account_info && !result.account_id) {
    result.account_id = card.fintablo_account_id
    result.account_info = card.fintablo_account_name
  }

  if (!result.direction_id && card.direction_id) {
    const dirs = getAllDirections()
    const dir = dirs.find(d => d.id === card.direction_id)
    if (dir) {
      result.direction_id = dir.fintablo_direction_id
      result.direction_name = dir.name
    }
  }

  return result
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

  const { amount: preParsedAmount, cleanText } = preParseAmount(text)
  const extracted = await extractExpenseFields(cleanText, {
    amount: preParsedAmount ?? txn.amount ?? undefined,
    date: txn.date ?? undefined,
    accountName: txn.account_info ?? undefined,
  })

  let updates: Partial<PendingTransaction> = {
    status: 'enriched',
    date: extracted.date ?? txn.date,
    amount: preParsedAmount ?? extracted.amount ?? txn.amount,
    category_id: extracted.category_id,
    category_name: extracted.category_name,
    direction_id: extracted.direction_id ?? txn.direction_id,
    direction_name: extracted.direction_name,
    counterparty_name: extracted.counterparty_name,
    description: extracted.description,
    account_info: txn.account_info,
    account_id: txn.account_id,
  }

  if (txn.manager_id) {
    updates = autoFillFromManager(txn.manager_id, updates)
  }

  updatePendingTransaction(txnId, updates)

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
      update.category_name = text.trim()
      break
    case 'direction':
      update.direction_name = text.trim()
      break
    case 'counterparty':
      update.counterparty_name = text.trim()
      break
    case 'description':
      update.description = text.trim()
      break
  }

  updatePendingTransaction(txnId, update)
  await askNextMissing(ctx, userId, txnId, remaining)
}

// ─── Callback handlers for field pickers ────────────────────────────────────

export async function handleFieldPickerCallback(ctx: Context, data: string): Promise<void> {
  const userId = ctx.from?.id
  if (!userId) return

  const state = userStates.get(userId)

  // Handle edit_ callbacks (from confirmation screen)
  if (data.startsWith('edit_')) {
    const parts = data.split(':')
    const field = parts[0].replace('edit_', '') as MissingField
    const txnId = parseInt(parts[1], 10)
    userStates.set(userId, { type: 'filling_missing_field', txnId, field, remaining: [] })
    await askForField(ctx, userId, txnId, field, [])
    return
  }

  if (!state || state.type !== 'filling_missing_field') return
  const { txnId, remaining } = state

  if (data.startsWith('pick_cat:')) {
    const [, idStr, ...rest] = data.split(':')
    const catId = parseInt(idStr, 10)
    const cat = MANAGER_CATEGORIES.find(c => c.id === catId)
    updatePendingTransaction(txnId, { category_id: catId, category_name: cat?.name ?? rest.join(':') })
  } else if (data.startsWith('pick_dir:')) {
    const [, idStr] = data.split(':')
    const dirId = parseInt(idStr, 10)
    const dirs = getAllDirections()
    const dir = dirs.find(d => (d.fintablo_direction_id ?? d.id) === dirId)
    updatePendingTransaction(txnId, { direction_id: dirId, direction_name: dir?.name ?? String(dirId) })
  } else if (data.startsWith('pick_acc:')) {
    const [, idStr] = data.split(':')
    const accId = parseInt(idStr, 10)
    const cards = getAllCards()
    const card = cards.find(c => c.fintablo_account_id === accId)
    updatePendingTransaction(txnId, { account_id: accId, account_info: card?.fintablo_account_name ?? String(accId) })
  }

  await ctx.editMessageText('Выбрано.')
  await askNextMissing(ctx, userId, txnId, remaining)
}

// ─── Manual entry ───────────────────────────────────────────────────────────

async function handleManualEntry(
  ctx: Context,
  userId: number,
  text: string,
  managerId: number
): Promise<void> {
  await ctx.replyWithChatAction('typing')

  const { amount: preParsedAmount, cleanText } = preParseAmount(text)
  const extracted = await extractExpenseFields(cleanText)

  let data: Record<string, unknown> = {
    manager_id: managerId,
    amount: preParsedAmount ?? extracted.amount,
    date: extracted.date,
    account_info: extracted.account_name,
    category_id: extracted.category_id,
    category_name: extracted.category_name,
    direction_id: extracted.direction_id,
    direction_name: extracted.direction_name,
    counterparty_name: extracted.counterparty_name,
    description: extracted.description,
  }

  // Auto-fill account & direction from linked card
  data = autoFillFromManager(managerId, data as Partial<PendingTransaction>)

  const txnId = createPendingTransaction(data as Parameters<typeof createPendingTransaction>[0])
  updatePendingTransaction(txnId, { status: 'enriched' })

  const updated = getPendingTransaction(txnId)!
  await checkAndAskMissing(ctx, userId, updated)
}

// ─── Validation & field asking ──────────────────────────────────────────────

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

  await askForField(ctx, userId, txn.id, missing[0], missing.slice(1))
}

async function askNextMissing(ctx: Context, userId: number, txnId: number, remaining: MissingField[]): Promise<void> {
  const updated = getPendingTransaction(txnId)!
  const stillMissing = getMissingFields(updated)

  if (stillMissing.length === 0) {
    await showConfirmation(ctx, userId, updated)
  } else {
    await askForField(ctx, userId, txnId, stillMissing[0], stillMissing.slice(1))
  }
}

async function askForField(
  ctx: Context,
  userId: number,
  txnId: number,
  field: MissingField,
  remaining: MissingField[]
): Promise<void> {
  userStates.set(userId, { type: 'filling_missing_field', txnId, field, remaining })

  if (field === 'category') {
    const keyboard = new InlineKeyboard()
    for (const cat of MANAGER_CATEGORIES) {
      keyboard.text(cat.name, `pick_cat:${cat.id}`).row()
    }
    await ctx.reply('Выбери статью:', { reply_markup: keyboard })
    return
  }

  if (field === 'direction') {
    const dirs = getAllDirections()
    const keyboard = new InlineKeyboard()
    for (const d of dirs) {
      keyboard.text(d.name, `pick_dir:${d.fintablo_direction_id ?? d.id}`).row()
    }
    await ctx.reply('Выбери направление:', { reply_markup: keyboard })
    return
  }

  if (field === 'account_info') {
    const cards = getAllCards()
    if (cards.length > 0) {
      const keyboard = new InlineKeyboard()
      for (const c of cards) {
        keyboard.text(c.fintablo_account_name, `pick_acc:${c.fintablo_account_id}`).row()
      }
      await ctx.reply('Выбери счет/карту:', { reply_markup: keyboard })
      return
    }
  }

  await ctx.reply(`${FIELD_LABELS[field]}:`, { reply_markup: { force_reply: true } })
}

async function showConfirmation(ctx: Context, userId: number, txn: PendingTransaction): Promise<void> {
  userStates.delete(userId)

  const keyboard = new InlineKeyboard()
    .text('Подтвердить', `confirm_txn:${txn.id}`)
    .text('Отменить', `cancel_txn:${txn.id}`)
    .row()
    .text('Редактировать', `edit_menu:${txn.id}`)

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

// ─── Edit menu handler ──────────────────────────────────────────────────────

export async function handleEditMenuCallback(ctx: Context, data: string): Promise<void> {
  const txnId = parseInt(data.replace('edit_menu:', ''), 10)

  const keyboard = new InlineKeyboard()
    .text('Дата', `edit_date:${txnId}`).text('Сумма', `edit_amount:${txnId}`).row()
    .text('Счет', `edit_account_info:${txnId}`).text('Статья', `edit_category:${txnId}`).row()
    .text('Направление', `edit_direction:${txnId}`).text('Контрагент', `edit_counterparty:${txnId}`).row()
    .text('Описание', `edit_description:${txnId}`).row()
    .text('« Назад', `back_confirm:${txnId}`)

  await ctx.editMessageText('Что исправить?', { reply_markup: keyboard })
}

export async function handleBackToConfirmCallback(ctx: Context, data: string): Promise<void> {
  const userId = ctx.from?.id
  if (!userId) return

  const txnId = parseInt(data.replace('back_confirm:', ''), 10)
  const txn = getPendingTransaction(txnId)
  if (!txn) return

  userStates.delete(userId)

  const keyboard = new InlineKeyboard()
    .text('Подтвердить', `confirm_txn:${txn.id}`)
    .text('Отменить', `cancel_txn:${txn.id}`)
    .row()
    .text('Редактировать', `edit_menu:${txn.id}`)

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

  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard })
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
      `Списание ${txn.amount}₽ (${txn.account_info ?? '?'}) ${txn.date}\nНа что были потрачены деньги?`,
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
      `Списание ${amount}₽ (${accountInfo}) ${date}\nНа что были потрачены деньги?`,
      { reply_markup: { force_reply: true } }
    )
    updatePendingTransaction(txnId, { bot_message_id: msg.message_id })
  } catch (err) {
    logger.error({ err, telegramUserId, txnId }, 'Failed to notify manager about transaction')
  }
}
