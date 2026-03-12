import { OPENROUTER_API_KEY } from './config.js'
import { logger } from './logger.js'

export interface ExtractedExpense {
  date: string | null
  amount: number | null
  account_name: string | null
  category_id: number | null
  category_name: string | null
  direction_id: number | null
  direction_name: string | null
  counterparty_name: string | null
  description: string
}

interface TransactionContext {
  amount?: number
  date?: string
  accountName?: string
}

const SYSTEM_PROMPT = `Ты финансовый ассистент компании Sofiny. Извлеки ВСЕ поля финансовой операции из текста пользователя.

Обязательные поля: date, amount, account_name (счет/карта), category_id, direction_id, counterparty_name (контрагент), description.

Счета: 115516:ВТБ Бизнес (Кузнецов С.Д.), 118769:Сбер Нак (Кузнецов С.Д.), 119277:ВТБ карта (Кузнецов С.Д.), 119280:Сбер карта (Унжакова В.С.), 119281:Т-Банк Совм (Унжакова В.С.), 124440:Т-Банк Совм (Кузнецов С.Д.), 126356:Сбер карта (Кузнецова Н.Л.), 127434:Сбер Пост (Кузнецов С.Д.), 143461:Сбер Пост (Унжакова В.С.), 143475:Т-Банк Совм (Кузнецова Н.Л.), 143655:СберБизнес (Кузнецов С.Д.), 148716:СберБизнес (Унжакова В.С.), 149282:Сбер Нак (Кузнецова Н.Л.), 149283:Сбер карта (Кузнецов С.Д.), 149558:Сбер Нак (Унжакова), 154253:Сбер Депозит (Кузнецов С.Д.), 154254:Сбер Депозит (Унжакова В.С.), 154257:Точка Депозит (Кузнецова Н.Л.), 154258:ВТБ Депозит (Кузнецов С.Д.), 156762:Наличка (Кузнецов С.Д.)

Статьи: 1043939:Неразнесенное поступление(income), 1043940:Неразнесенное списание(outcome), 1043941:Перевод между счетами(transfer), 1043942:Конвертация валют(transfer), 1043943:Ввод средств(income), 1043944:Вывод прибыли(outcome), 1043945:Налоги на доходы (прибыль)(outcome), 1043946:Налоги за сотрудников(outcome), 1043947:НДФЛ(outcome), 1043948:Взносы в фонды(outcome), 1043949:Получение кредита(income), 1043950:Выплата тела кредита(outcome), 1043951:Проценты по кредиту(outcome), 1043953:Закупки(outcome), 1043954:Покупка основных средств(outcome), 1043955:Продажа основных средств(income), 1044167:Поступления от МП(income), 1045091:Прочий доход(income), 1045093:Сертификация товара(outcome), 1045094:Покупка упаковки(outcome), 1045095:Логистические расходы(outcome), 1045100:Самовыкупы(outcome), 1045103:РКО(outcome), 1045111:Обучение персонала(outcome), 1045113:Командировки(outcome), 1045114:Представительские расходы(outcome), 1045115:Поиск и найм персонала(outcome), 1045117:Реклама и маркетинг(outcome), 1045119:Расходы на ПО и сервисы(outcome), 1045120:Административные и юридические расходы(outcome)

Направления: 1:WB (Кузнецов С.Д.), 2:WB (Кузнецова Н.Л.), 3:WB (Унжакова В.С.)

Если дата не указана, используй сегодня.
Если поле невозможно определить, поставь null.
Верни ТОЛЬКО JSON без markdown:
{"date":"YYYY-MM-DD","amount":число или null,"account_name":"название счета" или null,"category_id":число или null,"category_name":"название","direction_id":число или null,"direction_name":"название","counterparty_name":"контрагент" или null,"description":"описание"}`

export async function extractExpenseFields(
  text: string,
  context?: TransactionContext
): Promise<ExtractedExpense> {
  let userMessage = text
  if (context) {
    const parts: string[] = []
    if (context.amount) parts.push(`Сумма: ${context.amount} RUB`)
    if (context.date) parts.push(`Дата: ${context.date}`)
    if (context.accountName) parts.push(`Счет: ${context.accountName}`)
    if (parts.length > 0) {
      userMessage = `${parts.join(', ')}. Описание менеджера: ${text}`
    }
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    })

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }

    const content = data.choices?.[0]?.message?.content ?? '{}'
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned) as ExtractedExpense

    return {
      date: parsed.date ?? null,
      amount: parsed.amount ?? null,
      account_name: parsed.account_name ?? null,
      category_id: parsed.category_id ?? null,
      category_name: parsed.category_name ?? null,
      direction_id: parsed.direction_id ?? null,
      direction_name: parsed.direction_name ?? null,
      counterparty_name: parsed.counterparty_name ?? null,
      description: parsed.description ?? text,
    }
  } catch (err) {
    logger.error({ err }, 'AI extraction failed')
    return {
      date: null,
      amount: null,
      account_name: null,
      category_id: null,
      category_name: null,
      direction_id: null,
      direction_name: null,
      counterparty_name: null,
      description: text,
    }
  }
}
