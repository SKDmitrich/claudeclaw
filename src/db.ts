import Database from 'better-sqlite3'
import path from 'path'
import { mkdirSync } from 'fs'
import { STORE_DIR } from './config.js'

let db: Database.Database

function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    const dbPath = path.join(STORE_DIR, 'claudeclaw.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
  }
  return db
}

export function initDatabase(): void {
  const db = getDb()

  // Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Full memory tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='id')
  `)

  // FTS sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)

  // Scheduled tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next_run
    ON scheduled_tasks(status, next_run)
  `)
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function getSession(chatId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined
  return row?.session_id
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(`
      INSERT INTO sessions (chat_id, session_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `)
    .run(chatId, sessionId, Date.now())
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// ─── Memories (full) ──────────────────────────────────────────────────────────

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Date.now()
  getDb()
    .prepare(`
      INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
      VALUES (?, ?, ?, ?, 1.0, ?, ?)
    `)
    .run(chatId, topicKey ?? null, content, sector, now, now)
}

export function searchMemoriesFts(
  chatId: string,
  query: string,
  limit = 3
): Array<{ id: number; content: string; sector: string }> {
  return getDb()
    .prepare(`
      SELECT m.id, m.content, m.sector
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.id
      WHERE memories_fts MATCH ?
        AND m.chat_id = ?
      ORDER BY rank
      LIMIT ?
    `)
    .all(query, chatId, limit) as Array<{ id: number; content: string; sector: string }>
}

export function getRecentMemories(
  chatId: string,
  limit = 5
): Array<{ id: number; content: string; sector: string }> {
  return getDb()
    .prepare(`
      SELECT id, content, sector
      FROM memories
      WHERE chat_id = ?
      ORDER BY accessed_at DESC
      LIMIT ?
    `)
    .all(chatId, limit) as Array<{ id: number; content: string; sector: string }>
}

export function touchMemory(id: number): void {
  const now = Date.now()
  getDb()
    .prepare(`
      UPDATE memories
      SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0)
      WHERE id = ?
    `)
    .run(now, id)
}

export function decayMemories(): void {
  const cutoff = Date.now() - 86400 * 1000
  getDb()
    .prepare(`
      UPDATE memories SET salience = salience * 0.95
      WHERE created_at < ?
    `)
    .run(cutoff)

  getDb()
    .prepare('DELETE FROM memories WHERE salience < 0.1')
    .run()
}

export function getAllMemories(chatId: string): Array<{ content: string; sector: string; salience: number }> {
  return getDb()
    .prepare('SELECT content, sector, salience FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC')
    .all(chatId) as Array<{ content: string; sector: string; salience: number }>
}

export function deleteAllMemories(chatId: string): void {
  getDb().prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId)
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(task: ScheduledTask): void {
  getDb()
    .prepare(`
      INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, last_run, last_result, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(task.id, task.chat_id, task.prompt, task.schedule, task.next_run, task.last_run, task.last_result, task.status, task.created_at)
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return getDb()
    .prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run <= ?
    `)
    .all(now) as ScheduledTask[]
}

export function getAllTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function getTask(id: string): ScheduledTask | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined
}

export function updateTaskAfterRun(id: string, lastResult: string, nextRun: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare(`
      UPDATE scheduled_tasks
      SET last_run = ?, last_result = ?, next_run = ?
      WHERE id = ?
    `)
    .run(now, lastResult, nextRun, id)
}

export function setTaskStatus(id: string, status: 'active' | 'paused'): void {
  getDb()
    .prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?')
    .run(status, id)
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}
