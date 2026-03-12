import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, TYPING_REFRESH_MS } from './config.js'
import { logger } from './logger.js'

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void
): Promise<{ text: string | null; newSessionId?: string }> {
  let resultText: string | null = null
  let newSessionId: string | undefined

  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  try {
    // Remove CLAUDECODE env var so the subprocess isn't blocked by nested-session check
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'CLAUDECODE' && v !== undefined) env[k] = v
    }

    const stream = query({
      prompt: message,
      options: {
        cwd: PROJECT_ROOT,
        settingSources: ['project', 'user'],
        permissionMode: 'default',
        env,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })

    for await (const event of stream) {
      if (event.type === 'system' && (event as any).subtype === 'init') {
        newSessionId = (event as any).session_id ?? (event as any).sessionId
      }

      if (event.type === 'result') {
        resultText = (event as any).result ?? null
      }
    }
  } catch (err) {
    logger.error({ err }, 'runAgent error')
    throw err
  } finally {
    if (typingInterval !== undefined) {
      clearInterval(typingInterval)
    }
  }

  return { text: resultText, newSessionId }
}
