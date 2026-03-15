#!/usr/bin/env node
// Usage: node scripts/chat-history.js [count] [search]
// Examples:
//   node scripts/chat-history.js          # last 20 messages
//   node scripts/chat-history.js 50       # last 50 messages
//   node scripts/chat-history.js 0 pdf    # search for "pdf" in all messages

const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(__dirname, '..', 'store', 'claudeclaw.db')
const db = new Database(DB_PATH, { readonly: true })

const count = parseInt(process.argv[2]) || 20
const search = process.argv[3]

let rows
if (search) {
  rows = db.prepare(
    `SELECT id, sector, content, created_at FROM memories
     WHERE content LIKE ?
     ORDER BY created_at DESC LIMIT 200`
  ).all(`%${search}%`)
} else {
  rows = db.prepare(
    `SELECT id, sector, content, created_at FROM memories
     ORDER BY created_at DESC LIMIT ?`
  ).all(count)
}

rows.reverse()

for (const r of rows) {
  const d = new Date(r.created_at)
  const time = d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
  console.log(`\n[${time}] #${r.id} (${r.sector})`)
  console.log(r.content)
  console.log('─'.repeat(60))
}

console.log(`\nTotal: ${rows.length} messages`)
db.close()
