import type { Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { isAdmin } from './start.js'
import {
  getAllManagers, getAllCards, getAllDirections,
  createCard, deleteCard, getManagerByTelegramId,
  getUnsentConfirmedTransactions, updatePendingTransaction,
} from '../db.js'
import { postTransaction } from '../fintablo.js'
import { userStates } from '../state.js'

function adminOnly(ctx: Context): boolean {
  const chatId = ctx.chat?.id
  if (!chatId || !isAdmin(chatId)) {
    ctx.reply('Только для администратора.')
    return false
  }
  return true
}

// ─── Main admin menu ─────────────────────────────────────────────────────────

export async function adminMenuHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return

  const keyboard = new InlineKeyboard()
    .text('Менеджеры', 'admin:managers').text('Карты', 'admin:cards').row()
    .text('Направления', 'admin:directions').text('Привязать карту', 'admin:linkcard').row()
    .text('Отвязать карту', 'admin:unlinkcard').text('Retry отправку', 'admin:retry').row()
    .text('Закрыть', 'admin:close')

  await ctx.reply('Управление:', { reply_markup: keyboard })
}

// ─── Admin callback router ───────────────────────────────────────────────────

export async function adminCallbackHandler(ctx: Context, data: string): Promise<void> {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return

  const action = data.replace('admin:', '')

  switch (action) {
    case 'managers':
      await showManagers(ctx)
      break
    case 'cards':
      await showCards(ctx)
      break
    case 'directions':
      await showDirections(ctx)
      break
    case 'linkcard':
      await promptLinkCard(ctx)
      break
    case 'unlinkcard':
      await promptUnlinkCard(ctx)
      break
    case 'retry':
      await retryUnsent(ctx)
      break
    case 'back':
      await showMainMenu(ctx)
      break
    case 'close':
      await ctx.editMessageText('Меню закрыто.')
      break
  }
}

// ─── Menu screens ────────────────────────────────────────────────────────────

async function showMainMenu(ctx: Context): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('Менеджеры', 'admin:managers').text('Карты', 'admin:cards').row()
    .text('Направления', 'admin:directions').text('Привязать карту', 'admin:linkcard').row()
    .text('Отвязать карту', 'admin:unlinkcard').text('Retry отправку', 'admin:retry').row()
    .text('Закрыть', 'admin:close')

  await ctx.editMessageText('Управление:', { reply_markup: keyboard })
}

async function showManagers(ctx: Context): Promise<void> {
  const managers = getAllManagers()
  const back = new InlineKeyboard().text('« Назад', 'admin:back')

  if (managers.length === 0) {
    await ctx.editMessageText('Менеджеров нет.', { reply_markup: back })
    return
  }

  const lines = managers.map((m, i) =>
    `${i + 1}. ${m.name} (@${m.telegram_username ?? '?'}, ID: ${m.telegram_id}) - ${m.status}`
  )

  await ctx.editMessageText(`Менеджеры:\n\n${lines.join('\n')}`, { reply_markup: back })
}

async function showCards(ctx: Context): Promise<void> {
  const cards = getAllCards()
  const back = new InlineKeyboard().text('« Назад', 'admin:back')

  if (cards.length === 0) {
    await ctx.editMessageText('Карт нет. Привяжи через кнопку "Привязать карту".', { reply_markup: back })
    return
  }

  const lines = cards.map((c, i) => {
    const r = c as unknown as Record<string, unknown>
    return `${i + 1}. [${r.id}] ${r.card_mask} → ${r.manager_name ?? '?'} / ${r.direction_name ?? '?'} ${r.label ? `(${r.label})` : ''}`
  })

  await ctx.editMessageText(`Карты:\n\n${lines.join('\n')}`, { reply_markup: back })
}

async function showDirections(ctx: Context): Promise<void> {
  const dirs = getAllDirections()
  const back = new InlineKeyboard().text('« Назад', 'admin:back')
  const lines = dirs.map(d => `${d.id}. ${d.name} (FinTablo: ${d.fintablo_direction_id ?? 'не привязан'})`)
  await ctx.editMessageText(`Направления:\n\n${lines.join('\n')}`, { reply_markup: back })
}

async function promptLinkCard(ctx: Context): Promise<void> {
  const back = new InlineKeyboard().text('« Назад', 'admin:back')
  await ctx.editMessageText(
    'Отправь сообщение в формате:\n\n/linkcard <маска> <zen_account_id> <tg_id> <direction_id> [метка]\n\nПример:\n/linkcard ****1234 abc-123 482728189 1 Т-Банк Совм',
    { reply_markup: back }
  )
}

async function promptUnlinkCard(ctx: Context): Promise<void> {
  const cards = getAllCards()
  if (cards.length === 0) {
    const back = new InlineKeyboard().text('« Назад', 'admin:back')
    await ctx.editMessageText('Нет привязанных карт.', { reply_markup: back })
    return
  }

  // Show cards as buttons for easy unlinking
  const keyboard = new InlineKeyboard()
  for (const c of cards) {
    const r = c as unknown as Record<string, unknown>
    keyboard.text(`${r.card_mask} (${r.manager_name ?? '?'})`, `admin:unlinkcard:${r.id}`).row()
  }
  keyboard.text('« Назад', 'admin:back')

  await ctx.editMessageText('Выбери карту для отвязки:', { reply_markup: keyboard })
}

async function retryUnsent(ctx: Context): Promise<void> {
  const back = new InlineKeyboard().text('« Назад', 'admin:back')
  const unsent = getUnsentConfirmedTransactions()

  if (unsent.length === 0) {
    await ctx.editMessageText('Нет неотправленных транзакций.', { reply_markup: back })
    return
  }

  let sent = 0
  let failed = 0
  for (const txn of unsent) {
    try {
      const fintabloId = await postTransaction({
        date: txn.date!,
        amount: Math.abs(txn.amount!) * -1,
        category_id: txn.category_id ?? undefined,
        direction_id: txn.direction_id ?? undefined,
        counterparty_name: txn.counterparty_name ?? undefined,
        description: txn.description ?? undefined,
        currency: 'RUB',
      })
      updatePendingTransaction(txn.id, { status: 'sent', fintablo_txn_id: fintabloId })
      sent++
    } catch {
      failed++
    }
  }

  await ctx.editMessageText(`Retry: отправлено ${sent}, ошибок ${failed}`, { reply_markup: back })
}

// ─── Text command handlers (still needed for /linkcard) ──────────────────────

export async function linkcardHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return
  const text = ctx.message?.text ?? ''
  const parts = text.split(/\s+/).slice(1)

  if (parts.length < 4) {
    await ctx.reply('Формат: /linkcard <маска_карты> <zen_account_id> <tg_id_менеджера> <direction_id> [метка]')
    return
  }

  const [cardMask, zenAccountId, tgId, dirIdStr, ...labelParts] = parts
  const dirId = parseInt(dirIdStr, 10)
  const label = labelParts.length > 0 ? labelParts.join(' ') : null

  const manager = getManagerByTelegramId(tgId)
  if (!manager || manager.status !== 'active') {
    await ctx.reply(`Менеджер с TG ID ${tgId} не найден или неактивен.`)
    return
  }

  const dirs = getAllDirections()
  if (!dirs.find(d => d.id === dirId)) {
    await ctx.reply(`Направление ${dirId} не найдено. /directions`)
    return
  }

  const id = createCard(cardMask, zenAccountId, manager.id, dirId, label)
  await ctx.reply(`Карта привязана (ID: ${id}). ${cardMask} → ${manager.name} / направление ${dirId}`)
}
