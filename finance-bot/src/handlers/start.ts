import type { Context } from 'grammy'
import { getManagerByTelegramId } from '../db.js'
import { userStates } from '../state.js'
import { ADMIN_CHAT_ID } from '../config.js'

const WELCOME_TEXT = `Привет! Я бот-помощник для учета расходов.

Я помогаю менеджерам фиксировать операции по картам и отправлять их в ФинТабло.

Как это работает:
1. Зарегистрируйся -- напиши свои Фамилию и Имя
2. Администратор одобрит заявку
3. Когда на привязанной карте будет списание, я спрошу "На что были потрачены деньги?"
4. Опиши расход текстом или голосовым сообщением
5. Я заполню поля автоматически, ты проверишь и подтвердишь
6. Операция уйдет в ФинТабло

Также можно добавить операцию вручную -- просто напиши описание расхода, например:
"500 руб доставка СДЭК"

Для начала -- напиши свои Фамилию и Имя:`

const WELCOME_BACK_TEXT = `С возвращением! Ты уже зарегистрирован.

Что умею:
-- Напиши описание расхода текстом или голосовым
-- Я заполню статью, направление и контрагента
-- Ты проверишь и подтвердишь отправку в ФинТабло

Просто пиши описание расхода, например:
"500 руб доставка СДЭК"`

export async function startHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id
  if (!userId) return

  const existing = getManagerByTelegramId(String(userId))

  if (existing?.status === 'active') {
    await ctx.reply(WELCOME_BACK_TEXT)
    return
  }

  if (existing?.status === 'pending') {
    await ctx.reply('Твоя заявка на рассмотрении. Жди подтверждения от администратора.')
    return
  }

  if (existing?.status === 'blocked') {
    await ctx.reply('Доступ заблокирован. Обратись к администратору.')
    return
  }

  userStates.set(userId, { type: 'registration_name' })
  await ctx.reply(WELCOME_TEXT)
}

export function isAdmin(chatId: string | number): boolean {
  return String(chatId) === ADMIN_CHAT_ID
}
