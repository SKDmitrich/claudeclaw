import {
  insertMemory,
  searchMemoriesFts,
  getRecentMemories,
  touchMemory,
  decayMemories as dbDecay,
} from './db.js'
import { logger } from './logger.js'

// Max chars for memory context block sent to Claude
const MEMORY_BUDGET = 1500
// Max chars for assistant response stored in memory
const MAX_ASSISTANT_CHARS = 200
// Max chars for user message stored in memory
const MAX_USER_CHARS = 300

const SEMANTIC_RE = /\b(my|i am|i'm|i prefer|remember|always|never|мой|моя|моё|я |запомни|всегда|никогда|предпочитаю)\b/i

export async function buildMemoryContext(chatId: string, userMessage: string): Promise<string> {
  const results: Array<{ id: number; content: string; sector: string }> = []

  // FTS5 search - support Cyrillic + Latin
  try {
    const sanitized = userMessage
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .map(w => `"${w}"`)
      .join(' OR ')

    if (sanitized) {
      const ftsResults = searchMemoriesFts(chatId, sanitized, 3)
      results.push(...ftsResults)
    }
  } catch (err) {
    logger.warn({ err }, 'FTS search failed')
  }

  // Recent memories (3 instead of 5 to save tokens)
  const recent = getRecentMemories(chatId, 3)
  for (const r of recent) {
    if (!results.find(x => x.id === r.id)) {
      results.push(r)
    }
  }

  if (results.length === 0) return ''

  // Touch each result
  for (const r of results) {
    touchMemory(r.id)
  }

  // Prioritize: semantic first, then episodic
  results.sort((a, b) => {
    if (a.sector === 'semantic' && b.sector !== 'semantic') return -1
    if (a.sector !== 'semantic' && b.sector === 'semantic') return 1
    return 0
  })

  // Build output within token budget
  const lines: string[] = []
  let totalChars = 0
  for (const r of results) {
    const line = `- ${r.content}`
    if (totalChars + line.length > MEMORY_BUDGET) break
    lines.push(line)
    totalChars += line.length
  }

  if (lines.length === 0) return ''
  return `[Memory]\n${lines.join('\n')}`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '...'
}

export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return

  const isSemantic = SEMANTIC_RE.test(userMsg)

  // Compact format: truncate both sides
  const userPart = truncate(userMsg, MAX_USER_CHARS)
  const assistantPart = truncate(
    assistantMsg.replace(/\n{2,}/g, '\n').trim(),
    MAX_ASSISTANT_CHARS
  )
  const content = `Q: ${userPart}\nA: ${assistantPart}`

  insertMemory(chatId, content, isSemantic ? 'semantic' : 'episodic')
}

export function runDecaySweep(): void {
  try {
    dbDecay()
    logger.debug('Memory decay sweep complete')
  } catch (err) {
    logger.warn({ err }, 'Memory decay sweep failed')
  }
}
