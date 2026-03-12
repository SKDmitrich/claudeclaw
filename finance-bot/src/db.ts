import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { STORE_DIR } from './config.js'
import path from 'path'

let db: Database.Database

function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    const dbPath = path.join(STORE_DIR, 'finance.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
  }
  return db
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Manager {
  id: number
  name: string
  telegram_id: string
  telegram_username: string | null
  status: 'pending' | 'active' | 'blocked'
  created_at: number
}

export interface Card {
  id: number
  card_mask: string
  zenmoney_account_id: string
  manager_id: number
  direction_id: number
  label: string | null
  created_at: number
}

export interface Direction {
  id: number
  name: string
  fintablo_direction_id: number | null
}

export interface PendingTransaction {
  id: number
  zenmoney_txn_id: string | null
  manager_id: number | null
  amount: number | null
  date: string | null
  account_info: string | null
  account_id: number | null
  status: 'pending' | 'enriched' | 'confirmed' | 'sent' | 'failed'
  category_id: number | null
  category_name: string | null
  direction_id: number | null
  direction_name: string | null
  counterparty_id: number | null
  counterparty_name: string | null
  description: string | null
  fintablo_txn_id: string | null
  bot_message_id: number | null
  created_at: number
  updated_at: number
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initDatabase(): void {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS managers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      telegram_id TEXT NOT NULL UNIQUE,
      telegram_username TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','blocked')),
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS directions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      fintablo_direction_id INTEGER
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_mask TEXT NOT NULL,
      zenmoney_account_id TEXT NOT NULL,
      manager_id INTEGER REFERENCES managers(id),
      direction_id INTEGER REFERENCES directions(id),
      label TEXT,
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS pending_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zenmoney_txn_id TEXT UNIQUE,
      manager_id INTEGER REFERENCES managers(id),
      amount REAL,
      date TEXT,
      account_info TEXT,
      account_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','enriched','confirmed','sent','failed')),
      category_id INTEGER,
      category_name TEXT,
      direction_id INTEGER,
      direction_name TEXT,
      counterparty_id INTEGER,
      counterparty_name TEXT,
      description TEXT,
      fintablo_txn_id TEXT,
      bot_message_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

// ─── Seed ────────────────────────────────────────────────────────────────────

export function seedDirections(): void {
  const d = getDb()
  const insert = d.prepare('INSERT OR IGNORE INTO directions (id, name, fintablo_direction_id) VALUES (?, ?, ?)')
  insert.run(1, 'WB (Кузнецов С.Д.)', null)
  insert.run(2, 'WB (Кузнецова Н.Л.)', null)
  insert.run(3, 'WB (Унжакова В.С.)', null)
}

// ─── Managers ────────────────────────────────────────────────────────────────

export function getManagerByTelegramId(telegramId: string): Manager | undefined {
  return getDb()
    .prepare('SELECT * FROM managers WHERE telegram_id = ?')
    .get(telegramId) as Manager | undefined
}

export function getManagerById(id: number): Manager | undefined {
  return getDb()
    .prepare('SELECT * FROM managers WHERE id = ?')
    .get(id) as Manager | undefined
}

export function createManager(name: string, telegramId: string, username: string | null): number {
  const result = getDb()
    .prepare('INSERT INTO managers (name, telegram_id, telegram_username, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, telegramId, username, 'pending', Date.now())
  return result.lastInsertRowid as number
}

export function setManagerStatus(id: number, status: 'pending' | 'active' | 'blocked'): void {
  getDb().prepare('UPDATE managers SET status = ? WHERE id = ?').run(status, id)
}

export function getAllManagers(): Manager[] {
  return getDb().prepare('SELECT * FROM managers ORDER BY created_at DESC').all() as Manager[]
}

export function getActiveManagers(): Manager[] {
  return getDb().prepare("SELECT * FROM managers WHERE status = 'active'").all() as Manager[]
}

// ─── Cards ───────────────────────────────────────────────────────────────────

export function getCardByZenmoneyAccount(accountId: string): Card | undefined {
  return getDb()
    .prepare('SELECT * FROM cards WHERE zenmoney_account_id = ?')
    .get(accountId) as Card | undefined
}

export function getCardsByManagerId(managerId: number): Card[] {
  return getDb()
    .prepare('SELECT * FROM cards WHERE manager_id = ?')
    .all(managerId) as Card[]
}

export function getAllCards(): Card[] {
  return getDb().prepare(`
    SELECT c.*, m.name as manager_name, d.name as direction_name
    FROM cards c
    LEFT JOIN managers m ON c.manager_id = m.id
    LEFT JOIN directions d ON c.direction_id = d.id
    ORDER BY c.created_at DESC
  `).all() as Card[]
}

export function createCard(
  cardMask: string,
  zenmoneyAccountId: string,
  managerId: number,
  directionId: number,
  label: string | null
): number {
  const result = getDb()
    .prepare('INSERT INTO cards (card_mask, zenmoney_account_id, manager_id, direction_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cardMask, zenmoneyAccountId, managerId, directionId, label, Date.now())
  return result.lastInsertRowid as number
}

export function deleteCard(id: number): void {
  getDb().prepare('DELETE FROM cards WHERE id = ?').run(id)
}

// ─── Directions ──────────────────────────────────────────────────────────────

export function getAllDirections(): Direction[] {
  return getDb().prepare('SELECT * FROM directions ORDER BY id').all() as Direction[]
}

// ─── Pending Transactions ────────────────────────────────────────────────────

export function createPendingTransaction(data: {
  zenmoney_txn_id?: string | null
  manager_id?: number | null
  amount?: number | null
  date?: string | null
  account_info?: string | null
  account_id?: number | null
  category_id?: number | null
  category_name?: string | null
  direction_id?: number | null
  direction_name?: string | null
  counterparty_id?: number | null
  counterparty_name?: string | null
  description?: string | null
}): number {
  const now = Date.now()
  const result = getDb()
    .prepare(`
      INSERT INTO pending_transactions
        (zenmoney_txn_id, manager_id, amount, date, account_info, account_id, status,
         category_id, category_name, direction_id, direction_name,
         counterparty_id, counterparty_name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      data.zenmoney_txn_id ?? null,
      data.manager_id ?? null,
      data.amount ?? null,
      data.date ?? null,
      data.account_info ?? null,
      data.account_id ?? null,
      data.category_id ?? null,
      data.category_name ?? null,
      data.direction_id ?? null,
      data.direction_name ?? null,
      data.counterparty_id ?? null,
      data.counterparty_name ?? null,
      data.description ?? null,
      now, now
    )
  return result.lastInsertRowid as number
}

export function getPendingTransaction(id: number): PendingTransaction | undefined {
  return getDb()
    .prepare('SELECT * FROM pending_transactions WHERE id = ?')
    .get(id) as PendingTransaction | undefined
}

export function getPendingTransactionByZenmoneyId(txnId: string): PendingTransaction | undefined {
  return getDb()
    .prepare('SELECT * FROM pending_transactions WHERE zenmoney_txn_id = ?')
    .get(txnId) as PendingTransaction | undefined
}

export function updatePendingTransaction(id: number, fields: Partial<PendingTransaction>): void {
  const allowed = [
    'status', 'amount', 'date', 'account_info', 'account_id',
    'category_id', 'category_name', 'direction_id', 'direction_name',
    'counterparty_id', 'counterparty_name', 'description',
    'fintablo_txn_id', 'bot_message_id', 'manager_id',
  ] as const
  const sets: string[] = []
  const values: unknown[] = []

  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`)
      values.push(fields[key as keyof PendingTransaction] ?? null)
    }
  }

  if (sets.length === 0) return

  sets.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  getDb().prepare(`UPDATE pending_transactions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function getUnsentConfirmedTransactions(): PendingTransaction[] {
  return getDb()
    .prepare("SELECT * FROM pending_transactions WHERE status = 'confirmed'")
    .all() as PendingTransaction[]
}

export function getPendingByManagerId(managerId: number): PendingTransaction[] {
  return getDb()
    .prepare("SELECT * FROM pending_transactions WHERE manager_id = ? AND status IN ('pending', 'enriched') ORDER BY created_at")
    .all(managerId) as PendingTransaction[]
}

// ─── Sync State ──────────────────────────────────────────────────────────────

export function getSyncState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM sync_state WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value
}

export function setSyncState(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}
