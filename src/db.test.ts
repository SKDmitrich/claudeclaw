import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { unlinkSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const TEST_DB_PATH = path.join(PROJECT_ROOT, 'store', '_test.db')

// Create a standalone in-memory test database that mirrors db.ts schema
let testDb: Database.Database

beforeAll(() => {
  mkdirSync(path.join(PROJECT_ROOT, 'store'), { recursive: true })
  testDb = new Database(TEST_DB_PATH)
  testDb.pragma('journal_mode = WAL')

  testDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='id');
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
})

afterAll(() => {
  testDb.close()
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH)
})

function setSession(chatId: string, sessionId: string) {
  testDb.prepare(`
    INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
  `).run(chatId, sessionId, Date.now())
}

function getSession(chatId: string): string | undefined {
  const row = testDb.prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get(chatId) as any
  return row?.session_id
}

function clearSession(chatId: string) {
  testDb.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

function insertMemory(chatId: string, content: string, sector: 'semantic' | 'episodic') {
  const now = Date.now()
  testDb.prepare(`
    INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at)
    VALUES (?, ?, ?, 1.0, ?, ?)
  `).run(chatId, content, sector, now, now)
}

function searchFts(chatId: string, query: string): any[] {
  return testDb.prepare(`
    SELECT m.id, m.content, m.sector FROM memories_fts
    JOIN memories m ON memories_fts.rowid = m.id
    WHERE memories_fts MATCH ? AND m.chat_id = ?
    ORDER BY rank LIMIT 3
  `).all(query, chatId) as any[]
}

function getRecent(chatId: string): any[] {
  return testDb.prepare(
    'SELECT id, content, sector FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT 5'
  ).all(chatId) as any[]
}

describe('sessions', () => {
  it('set and get', () => {
    setSession('chat1', 'session-abc')
    expect(getSession('chat1')).toBe('session-abc')
  })

  it('returns undefined for unknown chat', () => {
    expect(getSession('unknown-chat')).toBeUndefined()
  })

  it('clear removes session', () => {
    setSession('chat2', 'session-abc')
    clearSession('chat2')
    expect(getSession('chat2')).toBeUndefined()
  })

  it('update replaces existing', () => {
    setSession('chat3', 'session-abc')
    setSession('chat3', 'session-xyz')
    expect(getSession('chat3')).toBe('session-xyz')
  })
})

describe('memories', () => {
  it('insert and retrieve', () => {
    insertMemory('memchat', 'I prefer dark mode', 'semantic')
    const recent = getRecent('memchat')
    expect(recent.length).toBe(1)
    expect(recent[0].content).toBe('I prefer dark mode')
    expect(recent[0].sector).toBe('semantic')
  })

  it('FTS search finds relevant content', () => {
    insertMemory('ftschat', 'I love TypeScript and Node.js', 'semantic')
    insertMemory('ftschat', 'My favorite food is sushi', 'semantic')
    const results = searchFts('ftschat', 'TypeScript*')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].content).toContain('TypeScript')
  })

  it('FTS does not return results from other chats', () => {
    insertMemory('chatA', 'unique_xyz_token content', 'semantic')
    const results = searchFts('chatB', 'unique_xyz_token*')
    expect(results.length).toBe(0)
  })
})
