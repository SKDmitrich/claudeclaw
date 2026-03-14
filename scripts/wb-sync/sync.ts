#!/usr/bin/env npx tsx
/**
 * WB Daily Sync -- fetches orders, sales, stocks from Wildberries API
 * and saves to PostgreSQL (wb_analytics database).
 *
 * Usage: npx tsx scripts/wb-sync/sync.ts [--days N]
 * Cron:  0 7 * * * (07:00 UTC = 10:00 MSK)
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '../..')

// ─── Config ──────────────────────────────────────────────────────────────────

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
const WB_TOKEN = env.WB_API_TOKEN
if (!WB_TOKEN) throw new Error('WB_API_TOKEN not set in .env')

const DAYS_BACK = parseInt(process.argv.find(a => a === '--days') ? process.argv[process.argv.indexOf('--days') + 1] : '1', 10)

const pool = new pg.Pool({
  host: '172.18.0.2',
  port: 5432,
  database: 'wb_analytics',
  user: 'n8n',
  password: env.POSTGRES_PASSWORD || 'H7fpXAHTtGisXQEvGwHREhNpT73sGI3f',
})

// ─── WB API helpers ──────────────────────────────────────────────────────────

const WB_STATS = 'https://statistics-api.wildberries.ru/api/v1/supplier'

async function wbFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: WB_TOKEN },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WB API ${res.status}: ${text}`)
  }
  return res.json()
}

function dateNDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0] + 'T00:00:00'
}

// ─── Sync functions ──────────────────────────────────────────────────────────

async function syncOrders() {
  const dateFrom = dateNDaysAgo(DAYS_BACK)
  console.log(`[orders] Fetching from ${dateFrom}...`)
  const data = await wbFetch(`${WB_STATS}/orders?dateFrom=${dateFrom}`)
  if (!Array.isArray(data) || data.length === 0) {
    console.log('[orders] No data')
    return 0
  }

  let inserted = 0
  for (const o of data) {
    try {
      await pool.query(
        `INSERT INTO wb_orders (wb_id, date, last_change_date, supplier_article, tech_size, barcode,
         total_price, discount_percent, warehouse_name, oblast, income_id, nm_id,
         subject, category, brand, is_cancel, cancel_dt, g_number, srid, order_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (wb_id) DO NOTHING`,
        [String(o.odid || o.srid || ''), o.date, o.lastChangeDate, o.supplierArticle, o.techSize, o.barcode,
         o.totalPrice, o.discountPercent, o.warehouseName, o.oblast, o.incomeID, o.nmId,
         o.subject, o.category, o.brand, o.isCancel, o.cancelDt || null, o.gNumber, o.srid, o.orderType]
      )
      inserted++
    } catch (err: any) {
      if (!err.message?.includes('duplicate')) console.error('[orders] Insert error:', err.message)
    }
  }
  console.log(`[orders] ${inserted}/${data.length} inserted`)
  return data.length
}

async function syncSales() {
  const dateFrom = dateNDaysAgo(DAYS_BACK)
  console.log(`[sales] Fetching from ${dateFrom}...`)
  const data = await wbFetch(`${WB_STATS}/sales?dateFrom=${dateFrom}`)
  if (!Array.isArray(data) || data.length === 0) {
    console.log('[sales] No data')
    return 0
  }

  let inserted = 0
  for (const s of data) {
    try {
      await pool.query(
        `INSERT INTO wb_sales (wb_id, date, last_change_date, supplier_article, tech_size, barcode,
         total_price, discount_percent, is_supply, is_realization, promo_code_discount,
         warehouse_name, country_name, oblast_okrug_name, region_name, income_id, sale_id,
         spp, for_pay, finished_price, price_with_disc, nm_id, subject, category, brand, g_number, srid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (wb_id) DO NOTHING`,
        [String(s.odid || s.srid || ''), s.date, s.lastChangeDate, s.supplierArticle, s.techSize, s.barcode,
         s.totalPrice, s.discountPercent, s.isSupply, s.isRealization, s.promoCodeDiscount,
         s.warehouseName, s.countryName, s.oblastOkrugName, s.regionName, s.incomeID, s.saleID,
         s.spp, s.forPay, s.finishedPrice, s.priceWithDisc, s.nmId, s.subject, s.category, s.brand, s.gNumber, s.srid]
      )
      inserted++
    } catch (err: any) {
      if (!err.message?.includes('duplicate')) console.error('[sales] Insert error:', err.message)
    }
  }
  console.log(`[sales] ${inserted}/${data.length} inserted`)
  return data.length
}

async function syncStocks() {
  console.log('[stocks] Fetching...')
  const data = await wbFetch(`${WB_STATS}/stocks?dateFrom=${dateNDaysAgo(1)}`)
  if (!Array.isArray(data) || data.length === 0) {
    console.log('[stocks] No data')
    return 0
  }

  const today = new Date().toISOString().split('T')[0]
  let inserted = 0
  for (const s of data) {
    try {
      await pool.query(
        `INSERT INTO wb_stocks (snapshot_date, last_change_date, supplier_article, tech_size, barcode,
         quantity, is_supply, is_realization, quantity_full, warehouse_name, nm_id,
         subject, category, brand, sc_code, price, discount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (snapshot_date, barcode, warehouse_name) DO UPDATE SET
           quantity = EXCLUDED.quantity, quantity_full = EXCLUDED.quantity_full,
           price = EXCLUDED.price, discount = EXCLUDED.discount, fetched_at = NOW()`,
        [today, s.lastChangeDate, s.supplierArticle, s.techSize, s.barcode,
         s.quantity, s.isSupply, s.isRealization, s.quantityFull, s.warehouseName, s.nmId,
         s.subject, s.category, s.brand, s.SCCode, s.Price, s.Discount]
      )
      inserted++
    } catch (err: any) {
      console.error('[stocks] Insert error:', err.message)
    }
  }
  console.log(`[stocks] ${inserted}/${data.length} upserted`)
  return data.length
}

async function buildDailySummary() {
  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

  console.log(`[summary] Building for ${yesterday}...`)

  await pool.query(
    `INSERT INTO wb_daily_summary (date, total_orders, total_orders_sum, total_sales, total_sales_sum,
     total_returns, total_returns_sum, total_cancels, total_for_pay, total_stock_qty)
     SELECT
       $1::date,
       COALESCE((SELECT COUNT(*) FROM wb_orders WHERE date::date = $1::date), 0),
       COALESCE((SELECT SUM(total_price) FROM wb_orders WHERE date::date = $1::date AND NOT is_cancel), 0),
       COALESCE((SELECT COUNT(*) FROM wb_sales WHERE date::date = $1::date AND total_price > 0), 0),
       COALESCE((SELECT SUM(total_price) FROM wb_sales WHERE date::date = $1::date AND total_price > 0), 0),
       COALESCE((SELECT COUNT(*) FROM wb_sales WHERE date::date = $1::date AND total_price < 0), 0),
       COALESCE((SELECT ABS(SUM(total_price)) FROM wb_sales WHERE date::date = $1::date AND total_price < 0), 0),
       COALESCE((SELECT COUNT(*) FROM wb_orders WHERE date::date = $1::date AND is_cancel), 0),
       COALESCE((SELECT SUM(for_pay) FROM wb_sales WHERE date::date = $1::date), 0),
       COALESCE((SELECT SUM(quantity_full) FROM wb_stocks WHERE snapshot_date = $2::date), 0)
     ON CONFLICT (date) DO UPDATE SET
       total_orders = EXCLUDED.total_orders, total_orders_sum = EXCLUDED.total_orders_sum,
       total_sales = EXCLUDED.total_sales, total_sales_sum = EXCLUDED.total_sales_sum,
       total_returns = EXCLUDED.total_returns, total_returns_sum = EXCLUDED.total_returns_sum,
       total_cancels = EXCLUDED.total_cancels, total_for_pay = EXCLUDED.total_for_pay,
       total_stock_qty = EXCLUDED.total_stock_qty, fetched_at = NOW()`,
    [yesterday, today]
  )
  console.log(`[summary] Done`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== WB Sync started at ${new Date().toISOString()} (${DAYS_BACK} days back) ===\n`)

  try {
    await syncOrders()
    await syncSales()
    await syncStocks()
    await buildDailySummary()
    console.log('\n=== WB Sync completed ===\n')
  } catch (err) {
    console.error('Sync failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
