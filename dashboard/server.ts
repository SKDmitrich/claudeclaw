#!/usr/bin/env npx tsx
/**
 * WB Stock Dashboard -- API server
 * Serves stock data from PostgreSQL and static frontend files.
 *
 * Usage: npx tsx dashboard/server.ts
 */

import express from 'express'
import cors from 'cors'
import pg from 'pg'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

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
const PG_PASSWORD = env.POSTGRES_PASSWORD || 'H7fpXAHTtGisXQEvGwHREhNpT73sGI3f'
const MS_TOKEN = env.MOYSKLAD_API_TOKEN
const DASHBOARD_PORT = parseInt(env.DASHBOARD_PORT || '3456')
const DASHBOARD_USER = env.DASHBOARD_USER || 'sofiny'
const DASHBOARD_PASS = env.DASHBOARD_PASS || env.POSTGRES_PASSWORD || 'admin'

const pool = new pg.Pool({
  host: '172.18.0.2',
  port: 5432,
  database: 'wb_analytics',
  user: 'n8n',
  password: PG_PASSWORD,
})

const app = express()
app.use(cors())
app.use(express.json())

// ── Basic Auth middleware ──────────────────────────────────────────────
function basicAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Sofiny Dashboard"')
    return res.status(401).send('Authentication required')
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString()
  const [user, pass] = decoded.split(':')
  if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) {
    return next()
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Sofiny Dashboard"')
  return res.status(401).send('Invalid credentials')
}

app.use(basicAuth)
app.use(express.static(resolve(__dirname, 'public')))

// ── API Routes ─────────────────────────────────────────────────────────

// Summary counts by urgency
app.get('/api/summary', async (_req, res) => {
  try {
    const result = await pool.query(`
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
    res.json(result.rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Full forecast table with filters
app.get('/api/forecast', async (req, res) => {
  try {
    const { urgency, article, warehouse } = req.query
    let where: string[] = []
    let params: any[] = []
    let i = 1

    if (urgency && urgency !== 'all') {
      where.push(`urgency = $${i++}`)
      params.push(urgency)
    }
    if (article) {
      where.push(`supplier_article ILIKE $${i++}`)
      params.push(`%${article}%`)
    }
    if (warehouse) {
      where.push(`warehouse_name ILIKE $${i++}`)
      params.push(`%${warehouse}%`)
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    const result = await pool.query(`
      SELECT
        supplier_article, tech_size, warehouse_name,
        stock_total, stock_to_client, stock_from_client,
        avg_daily_orders_7d, avg_daily_orders_14d,
        days_remaining, restock_14d, restock_30d,
        urgency, cancel_rate
      FROM v_stock_forecast
      ${whereClause}
      ORDER BY
        CASE urgency
          WHEN 'OUT_OF_STOCK' THEN 1
          WHEN 'CRITICAL' THEN 2
          WHEN 'LOW' THEN 3
          WHEN 'MEDIUM' THEN 4
          WHEN 'OK' THEN 5
        END,
        days_remaining ASC NULLS LAST
    `, params)
    res.json(result.rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Aggregated restock recommendations
app.get('/api/restock', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        supplier_article,
        tech_size,
        SUM(stock_total) as total_stock,
        ROUND(SUM(avg_daily_orders_7d)::numeric, 1) as total_daily_orders,
        CASE WHEN SUM(avg_daily_orders_7d) > 0
             THEN ROUND(SUM(stock_total)::numeric / SUM(avg_daily_orders_7d), 1)
             ELSE 999
        END as days_left,
        SUM(restock_14d) as need_14d,
        SUM(restock_30d) as need_30d,
        COUNT(*) FILTER (WHERE urgency = 'OUT_OF_STOCK') as oos_warehouses,
        COUNT(*) FILTER (WHERE urgency = 'CRITICAL') as crit_warehouses,
        COUNT(*) as total_warehouses
      FROM v_stock_forecast
      WHERE avg_daily_orders_7d > 0
      GROUP BY supplier_article, tech_size
      ORDER BY
        CASE WHEN SUM(stock_total)::numeric / NULLIF(SUM(avg_daily_orders_7d), 0) < 1 THEN 0
             ELSE SUM(stock_total)::numeric / NULLIF(SUM(avg_daily_orders_7d), 0)
        END ASC
    `)
    res.json(result.rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// MoySklad own warehouse stock
app.get('/api/moysklad', async (_req, res) => {
  if (!MS_TOKEN) return res.json([])
  try {
    const items: any[] = []
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
          items.push({
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

    // Group by base article
    const grouped: Record<string, any> = {}
    for (const item of items) {
      const parts = item.name.split('/')
      const base = parts[0].trim()
      const size = parts.length > 1 ? parts[1].trim() : ''
      if (!grouped[base]) grouped[base] = { name: base, stock: 0, reserve: 0, inTransit: 0, sizes: [] }
      grouped[base].stock += item.stock
      grouped[base].reserve += item.reserve
      grouped[base].inTransit += item.inTransit
      if (size && item.stock > 0) grouped[base].sizes.push({ size, qty: Math.round(item.stock) })
    }

    res.json(Object.values(grouped).sort((a: any, b: any) => b.stock - a.stock))
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Warehouses list
app.get('/api/warehouses', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT warehouse_name FROM v_stock_forecast ORDER BY warehouse_name
    `)
    res.json(result.rows.map((r: any) => r.warehouse_name))
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Articles list
app.get('/api/articles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT supplier_article FROM v_stock_forecast ORDER BY supplier_article
    `)
    res.json(result.rows.map((r: any) => r.supplier_article))
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Orders trend (last 30 days)
app.get('/api/orders-trend', async (req, res) => {
  try {
    const { article } = req.query
    let where = ''
    let params: any[] = []
    if (article) {
      where = `AND supplier_article = $1`
      params.push(article)
    }
    const result = await pool.query(`
      SELECT
        date::date::text as date,
        COUNT(*) as orders,
        COUNT(*) FILTER (WHERE is_cancel) as cancels
      FROM wb_orders
      WHERE date >= CURRENT_DATE - INTERVAL '30 days' ${where}
      GROUP BY date::date
      ORDER BY date::date
    `, params)
    res.json(result.rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Stock history (from daily snapshots)
app.get('/api/stock-history', async (req, res) => {
  try {
    const { article } = req.query
    let where = ''
    let params: any[] = []
    if (article) {
      where = `WHERE supplier_article = $1`
      params.push(article)
    }
    const result = await pool.query(`
      SELECT
        synced_at::date::text as date,
        SUM(quantity) as total_stock,
        SUM(quantity_full) as total_full
      FROM wb_stocks
      ${where}
      GROUP BY synced_at::date
      ORDER BY synced_at::date
    `, params)
    res.json(result.rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Daily summary
app.get('/api/daily-summary', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM wb_daily_summary
      ORDER BY date DESC
      LIMIT 30
    `)
    res.json(result.rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(DASHBOARD_PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${DASHBOARD_PORT}`)
})
