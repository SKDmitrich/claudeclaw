import type { Context } from 'grammy'
import { isAdmin } from './start.js'
import {
  getAllManagers, getAllCards, getAllDirections,
  createCard, deleteCard, getManagerByTelegramId,
} from '../db.js'

function adminOnly(ctx: Context): boolean {
  const chatId = ctx.chat?.id
  if (!chatId || !isAdmin(chatId)) {
    ctx.reply('Только для администратора.')
    return false
  }
  return true
}

export async function managersHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return
  const managers = getAllManagers()
  if (managers.length === 0) {
    await ctx.reply('Менеджеров нет.')
    return
  }
  const lines = managers.map((m, i) =>
    `${i + 1}. ${m.name} (@${m.telegram_username ?? '?'}, ID: ${m.telegram_id}) - ${m.status}`
  )
  await ctx.reply(lines.join('\n'))
}

export async function cardsHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return
  const cards = getAllCards()
  if (cards.length === 0) {
    await ctx.reply('Карт нет. Добавь: /linkcard <маска> <zen_account_id> <tg_id_менеджера> <direction_id> [метка]')
    return
  }
  const lines = cards.map((c, i) => {
    const r = c as unknown as Record<string, unknown>
    return `${i + 1}. [${r.id}] ${r.card_mask} → ${r.manager_name ?? '?'} / ${r.direction_name ?? '?'} ${r.label ? `(${r.label})` : ''}`
  })
  await ctx.reply(lines.join('\n'))
}

export async function directionsHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return
  const dirs = getAllDirections()
  const lines = dirs.map(d => `${d.id}. ${d.name} (FinTablo: ${d.fintablo_direction_id ?? 'не привязан'})`)
  await ctx.reply(lines.join('\n'))
}

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
    await ctx.reply(`Направление ${dirId} не найдено. Список: /directions`)
    return
  }

  const id = createCard(cardMask, zenAccountId, manager.id, dirId, label)
  await ctx.reply(`Карта привязана (ID: ${id}). ${cardMask} → ${manager.name} / направление ${dirId}`)
}

export async function unlinkcardHandler(ctx: Context): Promise<void> {
  if (!adminOnly(ctx)) return
  const text = ctx.message?.text ?? ''
  const parts = text.split(/\s+/).slice(1)

  if (parts.length < 1) {
    await ctx.reply('Формат: /unlinkcard <card_id>')
    return
  }

  const cardId = parseInt(parts[0], 10)
  deleteCard(cardId)
  await ctx.reply(`Карта ${cardId} удалена.`)
}
