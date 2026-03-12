import { randomUUID } from 'crypto'
import { initDatabase, createTask, getAllTasks, deleteTask, setTaskStatus, getTask } from './db.js'
import { computeNextRun } from './scheduler.js'
import cronParser from 'cron-parser'
const { parseExpression } = cronParser

initDatabase()

const [,, cmd, ...args] = process.argv

function printUsage(): void {
  console.log(`
ClaudeClaw Schedule CLI

Usage:
  node dist/schedule-cli.js create "<prompt>" "<cron>" <chat_id>
  node dist/schedule-cli.js list
  node dist/schedule-cli.js delete <id>
  node dist/schedule-cli.js pause <id>
  node dist/schedule-cli.js resume <id>

Examples:
  node dist/schedule-cli.js create "Summarize my emails" "0 9 * * *" 123456789
  node dist/schedule-cli.js list
  node dist/schedule-cli.js pause abc123
`)
}

function validateCron(expr: string): boolean {
  try {
    parseExpression(expr)
    return true
  } catch {
    return false
  }
}

switch (cmd) {
  case 'create': {
    const [prompt, schedule, chatId] = args
    if (!prompt || !schedule || !chatId) {
      console.error('Error: create requires <prompt> <cron> <chat_id>')
      printUsage()
      process.exit(1)
    }
    if (!validateCron(schedule)) {
      console.error(`Error: invalid cron expression: "${schedule}"`)
      process.exit(1)
    }
    const id = randomUUID().slice(0, 8)
    const nextRun = computeNextRun(schedule)
    const now = Math.floor(Date.now() / 1000)
    createTask({
      id,
      chat_id: chatId,
      prompt,
      schedule,
      next_run: nextRun,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: now,
    })
    console.log(`Created task: ${id}`)
    console.log(`Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
    break
  }

  case 'list': {
    const tasks = getAllTasks()
    if (tasks.length === 0) {
      console.log('No scheduled tasks.')
      break
    }
    console.log('\nID       | Status | Schedule       | Next run                | Prompt')
    console.log('-'.repeat(90))
    for (const t of tasks) {
      const nextRunStr = new Date(t.next_run * 1000).toLocaleString().padEnd(24)
      const prompt = t.prompt.length > 40 ? t.prompt.slice(0, 37) + '...' : t.prompt
      console.log(`${t.id.padEnd(8)} | ${t.status.padEnd(6)} | ${t.schedule.padEnd(14)} | ${nextRunStr} | ${prompt}`)
    }
    console.log()
    break
  }

  case 'delete': {
    const [id] = args
    if (!id) { console.error('Error: delete requires <id>'); process.exit(1) }
    const task = getTask(id)
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1) }
    deleteTask(id)
    console.log(`Deleted task: ${id}`)
    break
  }

  case 'pause': {
    const [id] = args
    if (!id) { console.error('Error: pause requires <id>'); process.exit(1) }
    setTaskStatus(id, 'paused')
    console.log(`Paused task: ${id}`)
    break
  }

  case 'resume': {
    const [id] = args
    if (!id) { console.error('Error: resume requires <id>'); process.exit(1) }
    const task = getTask(id)
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1) }
    const nextRun = computeNextRun(task.schedule)
    setTaskStatus(id, 'active')
    // Update next_run on resume
    const db = await import('./db.js')
    db.updateTaskAfterRun(id, task.last_result ?? '', nextRun)
    setTaskStatus(id, 'active') // restore after updateTaskAfterRun doesn't change status
    console.log(`Resumed task: ${id}`)
    console.log(`Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
    break
  }

  default:
    printUsage()
    if (cmd) process.exit(1)
}
