import cronParser from 'cron-parser'
const { parseExpression } = cronParser
import { getDueTasks, updateTaskAfterRun } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'

export type Sender = (chatId: string, text: string) => Promise<void>

let pollInterval: ReturnType<typeof setInterval> | undefined

export function computeNextRun(cronExpression: string): number {
  const interval = parseExpression(cronExpression)
  return Math.floor(interval.next().getTime() / 1000)
}

export async function runDueTasks(send: Sender): Promise<void> {
  const tasks = getDueTasks()
  for (const task of tasks) {
    logger.info({ taskId: task.id, prompt: task.prompt }, 'Running scheduled task')
    try {
      await send(task.chat_id, `⏰ Running scheduled task: ${task.prompt}`)
      const { text } = await runAgent(task.prompt)
      const result = text ?? '(no response)'
      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, result, nextRun)
      await send(task.chat_id, result)
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed')
      try {
        await send(task.chat_id, `Scheduled task failed: ${(err as Error).message}`)
      } catch { /* ignore */ }
      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, `Error: ${(err as Error).message}`, nextRun)
    }
  }
}

export function initScheduler(send: Sender): void {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = setInterval(() => {
    runDueTasks(send).catch(err => logger.error({ err }, 'Scheduler poll error'))
  }, 60_000)
  logger.info('Scheduler initialized (60s poll)')
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = undefined
  }
}
