import { OPENROUTER_API_KEY } from './config.js'
import { logger } from './logger.js'

export interface ExtractedExpense {
  category_id: number | null
  category_name: string | null
  direction_id: number | null
  direction_name: string | null
  description: string
}

interface TransactionContext {
  amount?: number
  date?: string
  accountName?: string
}

const SYSTEM_PROMPT = `Ты финансовый ассистент компании Sofiny. Извлеки поля финансовой операции из текста пользователя.

Обязательные поля: category_id, description.
Необязательные: direction_id.

Статьи (первые 30): 1043939:Неразнесенное поступление(income), 1043940:Неразнесенное списание(outcome), 1043941:Перевод между счетами(transfer), 1043942:Конвертация валют(transfer), 1043943:Ввод средств(income), 1043944:Вывод прибыли(outcome), 1043945:Налоги на доходы (прибыль)(outcome), 1043946:Налоги за сотрудников(outcome), 1043947:НДФЛ(outcome), 1043948:Взносы в фонды(outcome), 1043949:Получение кредита(income), 1043950:Выплата тела кредита(outcome), 1043951:Проценты по кредиту(outcome), 1043953:Закупки(outcome), 1043954:Покупка основных средств(outcome), 1043955:Продажа основных средств(income), 1044167:Поступления от МП(income), 1045091:Прочий доход(income), 1045093:Сертификация товара(outcome), 1045094:Покупка упаковки(outcome), 1045095:Логистические расходы(outcome), 1045100:Самовыкупы(outcome), 1045103:РКО(outcome), 1045111:Обучение персонала(outcome), 1045113:Командировки(outcome), 1045114:Представительские расходы(outcome), 1045115:Поиск и найм персонала(outcome), 1045117:Реклама и маркетинг(outcome), 1045119:Расходы на ПО и сервисы(outcome), 1045120:Административные и юридические расходы(outcome)

Направления: 1:WB (Кузнецов С.Д.), 2:WB (Кузнецова Н.Л.), 3:WB (Унжакова В.С.)

Если поле невозможно определить, поставь null.
Верни ТОЛЬКО JSON без markdown:
{"category_id":число или null,"category_name":"название","direction_id":число или null,"direction_name":"название","description":"описание"}`

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
      category_id: parsed.category_id ?? null,
      category_name: parsed.category_name ?? null,
      direction_id: parsed.direction_id ?? null,
      direction_name: parsed.direction_name ?? null,
      description: parsed.description ?? text,
    }
  } catch (err) {
    logger.error({ err }, 'AI extraction failed')
    return {
      category_id: null,
      category_name: null,
      direction_id: null,
      direction_name: null,
      description: text,
    }
  }
}
