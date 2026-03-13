import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, TYPING_REFRESH_MS } from './config.js'
import { logger } from './logger.js'

const MAX_RETRIES = 2

async function runAgentOnce(
  message: string,
  sessionId?: string,
): Promise<{ text: string | null; newSessionId?: string }> {
  let resultText: string | null = null
  let newSessionId: string | undefined

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

  return { text: resultText, newSessionId }
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void
): Promise<{ text: string | null; newSessionId?: string }> {
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const useSession = attempt === 0 ? sessionId : undefined
        if (attempt > 0) {
          logger.warn({ attempt, hadSession: !!sessionId }, 'Retrying without session after failure')
        }
        return await runAgentOnce(message, useSession)
      } catch (err: any) {
        const isExitCode1 = err?.message?.includes('exited with code 1')
        const isLastAttempt = attempt === MAX_RETRIES

        logger.error(
          { err, attempt, isExitCode1, hadSession: !!sessionId },
          `runAgent attempt ${attempt + 1}/${MAX_RETRIES + 1} failed`
        )

        if (isLastAttempt) throw err

        // If we had a session and got exit code 1, retry without session
        if (isExitCode1 && sessionId && attempt === 0) {
          continue
        }

        // For other errors or second retry, wait briefly then retry fresh
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    // Should not reach here, but just in case
    throw new Error('runAgent: exhausted all retries')
  } finally {
    if (typingInterval !== undefined) {
      clearInterval(typingInterval)
    }
  }
}
