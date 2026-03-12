import type { Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { isAdmin } from './start.js'
import {
  getAllManagers, getAllCards, getAllDirections,
  upsertCard, linkCardToManager, linkCardToDirection, unlinkCardManager,
  getUnsentConfirmedTransactions, updatePendingTransaction,
  getActiveManagers,
} from '../db.js'
import { getAccounts, postTransaction, type FinTabloAccount } from '../fintablo.js'
import { logger } from '../logger.js'

function adminOnly(ctx: Context): boolean {
  const chatId = ctx.chat?.id
  if (!chatId || !isAdmin(chatId)) {
    ctx.reply('Только для администратора.')
    return false
  }
  return true
}

// ─── Sync accounts from FinTablo ─────────────────────────────────────────────

export async function syncAccountsFromFintablo(): Promise<number> {
  const accounts = await getAccounts(true)
  // Only Т-Банк Совм cards
  const tCards = accounts.filter(a => a.name.includes('Т-Банк Совм'))
  for (const acc of tCards) {
    upsertCard(acc.id, acc.name)
  }
  return tCards.length
}

// ─── Main admin menu ─────────────────────────────────────────────────────────

export async function adminMenuHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return
  await showMainMenu(ctx, false)
}

// ─── Admin callback router ───────────────────────────────────────────────────

export async function adminCallbackHandler(ctx: Context, data: string): Promise<void> {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return

  const parts = data.replace('admin:', '').split(':')
  const action = parts[0]

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
    case 'sync':
      await handleSync(ctx)
      break
    case 'assign_mgr':
      // admin:assign_mgr:fintabloAccountId
      await showManagerPicker(ctx, parseInt(parts[1], 10))
      break
    case 'set_mgr':
      // admin:set_mgr:fintabloAccountId:managerId
      await handleSetManager(ctx, parseInt(parts[1], 10), parseInt(parts[2], 10))
      break
    case 'assign_dir':
      // admin:assign_dir:fintabloAccountId
      await showDirectionPicker(ctx, parseInt(parts[1], 10))
      break
    case 'set_dir':
      // admin:set_dir:fintabloAccountId:directionId
      await handleSetDirection(ctx, parseInt(parts[1], 10), parseInt(parts[2], 10))
      break
    case 'unlink':
      // admin:unlink:fintabloAccountId
      unlinkCardManager(parseInt(parts[1], 10))
      await showCards(ctx)
      break
    case 'retry':
      await retryUnsent(ctx)
      break
    case 'back':
      await showMainMenu(ctx, true)
      break
    case 'close':
      await ctx.editMessageText('Меню закрыто.')
      break
  }
}

// ─── Menu screens ────────────────────────────────────────────────────────────

async function showMainMenu(ctx: Context, edit: boolean): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('Счета/Карты', 'admin:cards').text('Менеджеры', 'admin:managers').row()
    .text('Направления', 'admin:directions').text('Синхр. ФинТабло', 'admin:sync').row()
    .text('Retry отправку', 'admin:retry').text('Закрыть', 'admin:close')

  if (edit) {
    await ctx.editMessageText('Управление:', { reply_markup: keyboard })
  } else {
    await ctx.reply('Управление:', { reply_markup: keyboard })
  }
}

async function showManagers(ctx: Context): Promise<void> {
  const managers = getAllManagers()
  const back = new InlineKeyboard().text('« Назад', 'admin:back')

  if (managers.length === 0) {
    await ctx.editMessageText('Менеджеров нет.', { reply_markup: back })
    return
  }

  const lines = managers.map((m, i) =>
    `${i + 1}. ${m.name} (@${m.telegram_username ?? '?'}) - ${m.status}`
  )

  await ctx.editMessageText(`Менеджеры:\n\n${lines.join('\n')}`, { reply_markup: back })
}

async function showCards(ctx: Context): Promise<void> {
  const cards = getAllCards()
  const back = new InlineKeyboard()

  if (cards.length === 0) {
    back.text('Синхр. ФинТабло', 'admin:sync').row()
    back.text('« Назад', 'admin:back')
    await ctx.editMessageText('Счетов нет. Нажми "Синхр. ФинТабло" чтобы загрузить.', { reply_markup: back })
    return
  }

  const lines = cards.map(c => {
    const mgr = c.manager_name ?? 'не привязан'
    const dir = c.direction_name ?? 'нет'
    return `${c.fintablo_account_name}\n  Менеджер: ${mgr} | Направление: ${dir}`
  })

  // Buttons for each card: assign manager, assign direction
  const keyboard = new InlineKeyboard()
  for (const c of cards) {
    const label = c.fintablo_account_name.replace('Т-Банк Совм ', '').slice(0, 20)
    keyboard
      .text(`${label} → Менеджер`, `admin:assign_mgr:${c.fintablo_account_id}`)
      .text(`→ Направление`, `admin:assign_dir:${c.fintablo_account_id}`)
      .row()
  }
  keyboard.text('Синхр. ФинТабло', 'admin:sync').row()
  keyboard.text('« Назад', 'admin:back')

  await ctx.editMessageText(`Счета:\n\n${lines.join('\n\n')}`, { reply_markup: keyboard })
}

async function showDirections(ctx: Context): Promise<void> {
  const dirs = getAllDirections()
  const back = new InlineKeyboard().text('« Назад', 'admin:back')
  const lines = dirs.map(d => `${d.id}. ${d.name} (ФинТабло: ${d.fintablo_direction_id ?? '-'})`)
  await ctx.editMessageText(`Направления:\n\n${lines.join('\n')}`, { reply_markup: back })
}

// ─── Pickers ─────────────────────────────────────────────────────────────────

async function showManagerPicker(ctx: Context, fintabloAccountId: number): Promise<void> {
  const managers = getActiveManagers()
  const keyboard = new InlineKeyboard()

  for (const m of managers) {
    keyboard.text(m.name, `admin:set_mgr:${fintabloAccountId}:${m.id}`).row()
  }
  keyboard.text('Отвязать', `admin:unlink:${fintabloAccountId}`).row()
  keyboard.text('« К счетам', 'admin:cards')

  await ctx.editMessageText(`Выбери менеджера для счета:`, { reply_markup: keyboard })
}

async function showDirectionPicker(ctx: Context, fintabloAccountId: number): Promise<void> {
  const dirs = getAllDirections()
  const keyboard = new InlineKeyboard()

  for (const d of dirs) {
    keyboard.text(d.name, `admin:set_dir:${fintabloAccountId}:${d.id}`).row()
  }
  keyboard.text('« К счетам', 'admin:cards')

  await ctx.editMessageText(`Выбери направление:`, { reply_markup: keyboard })
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function handleSync(ctx: Context): Promise<void> {
  try {
    const count = await syncAccountsFromFintablo()
    await showCards(ctx)
  } catch (err) {
    logger.error({ err }, 'Failed to sync from FinTablo')
    const back = new InlineKeyboard().text('« Назад', 'admin:back')
    await ctx.editMessageText('Ошибка синхронизации с ФинТабло.', { reply_markup: back })
  }
}

async function handleSetManager(ctx: Context, fintabloAccountId: number, managerId: number): Promise<void> {
  linkCardToManager(fintabloAccountId, managerId)
  await showCards(ctx)
}

async function handleSetDirection(ctx: Context, fintabloAccountId: number, directionId: number): Promise<void> {
  linkCardToDirection(fintabloAccountId, directionId)
  await showCards(ctx)
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
