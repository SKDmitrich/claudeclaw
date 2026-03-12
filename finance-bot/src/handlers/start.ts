import type { Context } from 'grammy'
import { getManagerByTelegramId } from '../db.js'
import { userStates } from '../state.js'
import { ADMIN_CHAT_ID } from '../config.js'

export async function startHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id
  if (!userId) return

  const existing = getManagerByTelegramId(String(userId))

  if (existing?.status === 'active') {
    await ctx.reply('Ты уже зарегистрирован. Просто пиши описание расхода.')
    return
  }

  if (existing?.status === 'pending') {
    await ctx.reply('Твоя заявка на рассмотрении. Жди подтверждения.')
    return
  }

  if (existing?.status === 'blocked') {
    await ctx.reply('Доступ заблокирован. Обратись к администратору.')
    return
  }

  userStates.set(userId, { type: 'registration_name' })
  await ctx.reply('Привет! Как тебя зовут? (Фамилия Имя)')
}

export function isAdmin(chatId: string | number): boolean {
  return String(chatId) === ADMIN_CHAT_ID
}
