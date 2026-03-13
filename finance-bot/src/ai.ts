import { OPENROUTER_API_KEY } from './config.js'
import { logger } from './logger.js'

export interface ExtractedField<T> {
  value: T | null
  confident: boolean
}

export interface ExtractedExpense {
  date: ExtractedField<string>
  amount: ExtractedField<number>
  account_name: ExtractedField<string>
  category_id: ExtractedField<number>
  category_name: ExtractedField<string>
  direction_id: ExtractedField<number>
  direction_name: ExtractedField<string>
  counterparty_name: ExtractedField<string>
  description: string
}

interface TransactionContext {
  amount?: number
  date?: string
  accountName?: string
  directionName?: string
}

const SYSTEM_PROMPT = `Ты финансовый ассистент компании. Извлеки поля операции из текста менеджера.

Для каждого поля верни value и confident (true если уверен на 80%+, false если угадываешь).

Статьи расходов менеджеров (category_id : название):
1045100 : Самовыкупы
1053173 : Фотоконтент
1045119 : Расходы на ПО и сервисы
1045095 : Логистические расходы
1245493 : Логистические расходы (не вх. в с/с)
1043953 : Закупки
1342729 : Брак
1045094 : Упаковка
1327155 : Упаковка не вх с/с

Направления (direction_id : название):
98224 : WB (Кузнецов С.Д.)
99106 : WB (Кузнецова Н.Л.)
99103 : WB (Унжакова В.С.)
99105 : OZON (Унжакова В.С.)
99857 : OZON (Кузнецов С.Д.)

Правила:
- date: если не указана явно, используй сегодня. Формат YYYY-MM-DD
- amount: число в рублях. Если указано "500 руб" или "1200₽" -- извлеки число. "1 млн" = 1000000, "1.5 млн" = 1500000, "500 тыс" = 500000
- category: определи по описанию (СДЭК/почта/ПЭК/доставка → Логистические расходы, WB/самовыкуп → Самовыкупы, фото/съемка → Фотоконтент, пленка/коробки → Упаковка, подписка/сервис → ПО и сервисы, брак → Брак, закупка/поставщик/товар/платье → Закупки). "Логистические расходы (не вх. в с/с)" используй только если явно указано что расход не входит в себестоимость. Если менеджер явно назвал статью -- используй именно её
- counterparty_name: кому заплатили (СДЭК, Wildberries, OZON и т.д.)
- description: краткое описание операции
- direction: определи только если есть явное указание. Если менеджер не указал направление, ставь null
- account_name: обычно не указывается, ставь null

Верни ТОЛЬКО JSON без markdown:
{
  "date": {"value": "2026-03-12", "confident": true},
  "amount": {"value": 500, "confident": true},
  "category_id": {"value": 1045095, "confident": true},
  "category_name": {"value": "Логистика", "confident": true},
  "direction_id": {"value": null, "confident": false},
  "direction_name": {"value": null, "confident": false},
  "counterparty_name": {"value": "СДЭК", "confident": true},
  "account_name": {"value": null, "confident": false},
  "description": "Доставка СДЭК"
}`

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
    if (context.directionName) parts.push(`Направление: ${context.directionName}`)
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
    const parsed = JSON.parse(cleaned)

    const field = <T>(raw: unknown, fallback: T | null = null): ExtractedField<T> => {
      if (raw && typeof raw === 'object' && 'value' in raw) {
        const obj = raw as { value: T | null; confident?: boolean }
        return { value: obj.value ?? fallback, confident: obj.confident ?? false }
      }
      return { value: (raw as T) ?? fallback, confident: false }
    }

    return {
      date: field<string>(parsed.date),
      amount: field<number>(parsed.amount),
      account_name: field<string>(parsed.account_name),
      category_id: field<number>(parsed.category_id),
      category_name: field<string>(parsed.category_name),
      direction_id: field<number>(parsed.direction_id),
      direction_name: field<string>(parsed.direction_name),
      counterparty_name: field<string>(parsed.counterparty_name),
      description: parsed.description ?? text,
    }
  } catch (err) {
    logger.error({ err }, 'AI extraction failed')
    return {
      date: { value: null, confident: false },
      amount: { value: null, confident: false },
      account_name: { value: null, confident: false },
      category_id: { value: null, confident: false },
      category_name: { value: null, confident: false },
      direction_id: { value: null, confident: false },
      direction_name: { value: null, confident: false },
      counterparty_name: { value: null, confident: false },
      description: text,
    }
  }
}
