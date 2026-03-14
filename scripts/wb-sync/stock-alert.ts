#!/usr/bin/env npx tsx
/**
 * WB Stock Alert -- daily stock monitoring report with restock recommendations.
 * Sends alerts to Telegram when stock is running low.
 *
 * Usage: npx tsx scripts/wb-sync/stock-alert.ts
 * Cron:  0 7 * * * (after sync, at 10:00 MSK)
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '../..')

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(PROJECT_ROOT, '.env'), 'utf-8')
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    result[trimmed.slice(0, eq).trim()] = val
  }
  return result
}

const env = loadEnv()
const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN
const CHAT_ID = env.ALLOWED_CHAT_ID
const PG_PASSWORD = env.POSTGRES_PASSWORD || 'H7fpXAHTtGisXQEvGwHREhNpT73sGI3f'
const MS_TOKEN = env.MOYSKLAD_API_TOKEN

const pool = new pg.Pool({
  host: '172.18.0.2',
  port: 5432,
  database: 'wb_analytics',
  user: 'n8n',
  password: PG_PASSWORD,
})

async function sendTelegram(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  })
}

async function main() {
  // 1. Summary by urgency
  const summary = await pool.query(`
    SELECT urgency, COUNT(*) as cnt
    FROM v_stock_forecast
    GROUP BY urgency
    ORDER BY CASE urgency
      WHEN 'OUT_OF_STOCK' THEN 1
      WHEN 'CRITICAL' THEN 2
      WHEN 'LOW' THEN 3
      WHEN 'MEDIUM' THEN 4
      WHEN 'OK' THEN 5
    END
  `)

  const counts: Record<string, number> = {}
  for (const r of summary.rows) counts[r.urgency] = parseInt(r.cnt)

  // 2. Aggregated restock by article+size (across all warehouses)
  const restockAgg = await pool.query(`
    SELECT
      supplier_article,
      tech_size,
      SUM(stock_total) as total_stock,
      ROUND(SUM(avg_daily_orders_7d), 1) as total_daily_orders,
      CASE WHEN SUM(avg_daily_orders_7d) > 0
           THEN ROUND(SUM(stock_total)::numeric / SUM(avg_daily_orders_7d), 1)
           ELSE 999
      END as days_left,
      SUM(restock_14d) as need_14d,
      SUM(restock_30d) as need_30d,
      COUNT(*) FILTER (WHERE urgency = 'OUT_OF_STOCK') as oos_warehouses,
      COUNT(*) FILTER (WHERE urgency = 'CRITICAL') as crit_warehouses
    FROM v_stock_forecast
    WHERE avg_daily_orders_7d > 0
    GROUP BY supplier_article, tech_size
    HAVING SUM(stock_total)::numeric / NULLIF(SUM(avg_daily_orders_7d), 0) < 7
       OR COUNT(*) FILTER (WHERE urgency = 'OUT_OF_STOCK') > 0
    ORDER BY
      CASE WHEN SUM(stock_total)::numeric / NULLIF(SUM(avg_daily_orders_7d), 0) < 1 THEN 0
           ELSE SUM(stock_total)::numeric / NULLIF(SUM(avg_daily_orders_7d), 0)
      END ASC
    LIMIT 30
  `)

  // 3. Top warehouses with OOS
  const warehouseOOS = await pool.query(`
    SELECT warehouse_name,
      COUNT(*) FILTER (WHERE urgency = 'OUT_OF_STOCK') as oos,
      COUNT(*) FILTER (WHERE urgency = 'CRITICAL') as crit,
      COUNT(*) FILTER (WHERE urgency = 'LOW') as low
    FROM v_stock_forecast
    WHERE avg_daily_orders_7d > 0
    GROUP BY warehouse_name
    HAVING COUNT(*) FILTER (WHERE urgency IN ('OUT_OF_STOCK', 'CRITICAL')) > 0
    ORDER BY COUNT(*) FILTER (WHERE urgency = 'OUT_OF_STOCK') DESC
    LIMIT 10
  `)

  // 4. Fetch own warehouse stock from MoySklad
  interface MsStockItem { name: string; article: string; stock: number; reserve: number; inTransit: number }
  const msStock: MsStockItem[] = []
  if (MS_TOKEN) {
    try {
      let offset = 0
      const limit = 1000
      let hasMore = true
      while (hasMore) {
        const resp = await fetch(
          `https://api.moysklad.ru/api/remap/1.2/report/stock/all?limit=${limit}&offset=${offset}`,
          { headers: { Authorization: `Bearer ${MS_TOKEN}`, 'Accept-Encoding': 'gzip' } }
        )
        if (!resp.ok) break
        const data = await resp.json() as any
        for (const r of data.rows ?? []) {
          if (r.stock > 0 || r.inTransit > 0) {
            msStock.push({
              name: r.name ?? '',
              article: r.article ?? r.code ?? '',
              stock: r.stock ?? 0,
              reserve: r.reserve ?? 0,
              inTransit: r.inTransit ?? 0,
            })
          }
        }
        offset += (data.rows ?? []).length
        if (offset >= (data.meta?.size ?? 0)) hasMore = false
      }
    } catch (err: any) {
      console.error('[moysklad] Fetch error:', err.message)
    }
  }

  // Aggregate MS stock by article (group sizes)
  const msByArticle: Record<string, { stock: number; reserve: number; inTransit: number; sizes: string[] }> = {}
  for (const item of msStock) {
    // Extract base article from name (before size separator)
    const nameParts = item.name.split('/')
    const baseName = nameParts[0].trim()
    const size = nameParts.length > 1 ? nameParts[1].trim() : ''

    if (!msByArticle[baseName]) msByArticle[baseName] = { stock: 0, reserve: 0, inTransit: 0, sizes: [] }
    msByArticle[baseName].stock += item.stock
    msByArticle[baseName].reserve += item.reserve
    msByArticle[baseName].inTransit += item.inTransit
    if (size && item.stock > 0) msByArticle[baseName].sizes.push(`${size}:${Math.round(item.stock)}`)
  }

  // ─── Build message ──────────────────────────────────────────────────

  const date = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  let msg = `<b>📦 Отчет по остаткам WB -- ${date}</b>\n\n`

  // Summary
  msg += `<b>Статус позиций:</b>\n`
  if (counts['OUT_OF_STOCK']) msg += `🔴 Нет в наличии: ${counts['OUT_OF_STOCK']}\n`
  if (counts['CRITICAL']) msg += `🟠 Критично (менее 3 дн): ${counts['CRITICAL']}\n`
  if (counts['LOW']) msg += `🟡 Мало (менее 7 дн): ${counts['LOW']}\n`
  if (counts['MEDIUM']) msg += `🔵 Средне (7-14 дн): ${counts['MEDIUM']}\n`
  if (counts['OK']) msg += `🟢 Ок (более 14 дн): ${counts['OK']}\n`
  msg += '\n'

  // Restock recommendations
  if (restockAgg.rows.length > 0) {
    msg += `<b>⚠️ Требуется пополнение (общие по всем складам):</b>\n\n`

    for (const r of restockAgg.rows.slice(0, 20)) {
      const icon = r.days_left <= 0 ? '🔴' : r.days_left <= 3 ? '🟠' : '🟡'
      const daysStr = r.days_left <= 0 ? 'ЗАКОНЧИЛСЯ' : `${r.days_left} дн`
      msg += `${icon} <b>${r.supplier_article}</b> | ${r.tech_size}\n`
      msg += `   Остаток: ${r.total_stock} шт | Заказов/день: ${r.total_daily_orders}\n`
      msg += `   Хватит на: ${daysStr}\n`
      if (parseInt(r.need_30d) > 0) {
        msg += `   Подвезти: ${r.need_14d} (на 14дн) / ${r.need_30d} (на 30дн)\n`
      }
      if (parseInt(r.oos_warehouses) > 0) {
        msg += `   Пустых складов: ${r.oos_warehouses}\n`
      }
      msg += '\n'
    }
  }

  // MoySklad own warehouse stock
  if (Object.keys(msByArticle).length > 0) {
    msg += `<b>🏠 Свой склад (МойСклад):</b>\n`
    const sorted = Object.entries(msByArticle)
      .sort((a, b) => b[1].stock - a[1].stock)

    for (const [art, data] of sorted) {
      const transit = data.inTransit > 0 ? ` | в пути: ${Math.round(data.inTransit)}` : ''
      const sizes = data.sizes.length > 0 ? ` [${data.sizes.join(', ')}]` : ''
      msg += `  ${art}: <b>${Math.round(data.stock)}</b> шт${transit}${sizes}\n`
    }
    msg += '\n'
  }

  // Warehouse summary
  if (warehouseOOS.rows.length > 0) {
    msg += `<b>🏭 Склады с пустыми позициями:</b>\n`
    for (const w of warehouseOOS.rows) {
      msg += `${w.warehouse_name}: 🔴${w.oos} 🟠${w.crit} 🟡${w.low}\n`
    }
  }

  // Split long messages (Telegram limit 4096)
  const chunks: string[] = []
  if (msg.length <= 4000) {
    chunks.push(msg)
  } else {
    const lines = msg.split('\n')
    let chunk = ''
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 4000) {
        chunks.push(chunk)
        chunk = ''
      }
      chunk += line + '\n'
    }
    if (chunk) chunks.push(chunk)
  }

  for (const chunk of chunks) {
    await sendTelegram(chunk)
  }

  console.log(`Stock alert sent: ${counts['OUT_OF_STOCK'] ?? 0} OOS, ${counts['CRITICAL'] ?? 0} critical`)
  await pool.end()
}

main().catch(err => {
  console.error('Stock alert failed:', err)
  process.exit(1)
})
