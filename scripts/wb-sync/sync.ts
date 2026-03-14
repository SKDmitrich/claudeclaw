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
const WB_ADV = 'https://advert-api.wildberries.ru/adv'
const WB_ANALYTICS = 'https://seller-analytics-api.wildberries.ru/api/v2'

async function wbFetch(url: string, opts?: { method?: string; body?: any; extraHeaders?: Record<string, string> }): Promise<any> {
  const method = opts?.method ?? 'GET'
  const headers: Record<string, string> = { Authorization: WB_TOKEN, ...opts?.extraHeaders }
  const fetchOpts: RequestInit = { method, headers }
  if (opts?.body) {
    headers['Content-Type'] = 'application/json'
    fetchOpts.body = JSON.stringify(opts.body)
  }
  const res = await fetch(url, fetchOpts)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WB API ${res.status} ${url}: ${text.slice(0, 300)}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('json')) return res.json()
  return res.text()
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

async function syncReportDetail() {
  const dateFrom = dateNDaysAgo(DAYS_BACK + 7) // reports lag by ~7 days
  console.log(`[report] Fetching from ${dateFrom}...`)
  try {
    const dateTo = new Date().toISOString().split('T')[0]
    const data = await wbFetch(`https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}`)
    if (!Array.isArray(data) || data.length === 0) {
      console.log('[report] No data')
      return 0
    }
    let inserted = 0
    for (const r of data) {
      try {
        await pool.query(
          `INSERT INTO wb_report_detail (realizationreport_id, date_from, date_to, rrd_id, gi_id,
           subject_name, nm_id, brand_name, sa_name, ts_name, barcode, doc_type_name, quantity,
           retail_price, retail_amount, sale_percent, commission_percent, office_name,
           supplier_oper_name, order_dt, sale_dt, rr_dt, shk_id,
           retail_price_withdisc_rub, delivery_amount, return_amount, delivery_rub,
           ppvz_for_pay, ppvz_sales_commission, penalty, additional_payment,
           storage_fee, deduction, acceptance, srid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
           ON CONFLICT (rrd_id) DO NOTHING`,
          [r.realizationreport_id, r.date_from, r.date_to, r.rrd_id, r.gi_id,
           r.subject_name, r.nm_id, r.brand_name, r.sa_name, r.ts_name, r.barcode, r.doc_type_name, r.quantity,
           r.retail_price, r.retail_amount, r.sale_percent, r.commission_percent, r.office_name,
           r.supplier_oper_name, r.order_dt || null, r.sale_dt || null, r.rr_dt || null, r.shk_id,
           r.retail_price_withdisc_rub, r.delivery_amount, r.return_amount, r.delivery_rub,
           r.ppvz_for_pay, r.ppvz_sales_commission, r.penalty, r.additional_payment,
           r.storage_fee, r.deduction, r.acceptance, r.srid]
        )
        inserted++
      } catch (err: any) {
        if (!err.message?.includes('duplicate')) console.error('[report] Insert error:', err.message)
      }
    }
    console.log(`[report] ${inserted}/${data.length} inserted`)
    return data.length
  } catch (err: any) {
    console.error('[report] Fetch error:', err.message)
    return 0
  }
}

async function syncSupply() {
  const dateFrom = dateNDaysAgo(DAYS_BACK)
  console.log(`[supply] Fetching from ${dateFrom}...`)
  try {
    const data = await wbFetch(`${WB_STATS}/incomes?dateFrom=${dateFrom}`)
    if (!Array.isArray(data) || data.length === 0) {
      console.log('[supply] No data')
      return 0
    }
    let inserted = 0
    for (const s of data) {
      try {
        await pool.query(
          `INSERT INTO wb_supply (income_id, number, date, last_change_date, supplier_article,
           tech_size, barcode, quantity, total_price, date_close, warehouse_name, nm_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (income_id, barcode) DO UPDATE SET
             quantity = EXCLUDED.quantity, status = EXCLUDED.status,
             date_close = EXCLUDED.date_close, fetched_at = NOW()`,
          [s.incomeId, s.number, s.date, s.lastChangeDate, s.supplierArticle,
           s.techSize, s.barcode, s.quantity, s.totalPrice, s.dateClose || null,
           s.warehouseName, s.nmId, s.status]
        )
        inserted++
      } catch (err: any) {
        console.error('[supply] Insert error:', err.message)
      }
    }
    console.log(`[supply] ${inserted}/${data.length} upserted`)
    return data.length
  } catch (err: any) {
    console.error('[supply] Fetch error:', err.message)
    return 0
  }
}

async function syncAdsCampaigns() {
  console.log('[ads] Fetching campaigns...')
  try {
    // Get all campaign statuses (4=active, 7=completed, 9=paused, 11=all)
    const campaigns = await wbFetch(`${WB_ADV}/v1/promotion/count`, { method: 'GET' })
    const allCampaigns = [
      ...(campaigns?.adverts ?? []).flatMap((g: any) => g.advert_list ?? [])
    ]

    if (allCampaigns.length === 0) {
      console.log('[ads] No campaigns')
      return 0
    }

    let inserted = 0
    for (const c of allCampaigns) {
      try {
        await pool.query(
          `INSERT INTO wb_ads_campaigns (campaign_id, name, start_time, end_time, create_time, status, type, daily_budget)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (campaign_id) DO UPDATE SET
             name = EXCLUDED.name, status = EXCLUDED.status,
             end_time = EXCLUDED.end_time, daily_budget = EXCLUDED.daily_budget, fetched_at = NOW()`,
          [c.advertId, c.changeTime || '', c.startTime || null, c.endTime || null,
           c.createTime || null, c.status, c.type, c.dailyBudget ?? 0]
        )
        inserted++
      } catch (err: any) {
        console.error('[ads] Campaign insert error:', err.message)
      }
    }
    console.log(`[ads] ${inserted}/${allCampaigns.length} campaigns upserted`)

    // Now get stats for active campaigns
    const activeCampaignIds = allCampaigns
      .filter((c: any) => [4, 9, 11].includes(c.status))
      .map((c: any) => c.advertId)

    if (activeCampaignIds.length > 0) {
      await syncAdsStats(activeCampaignIds)
    }

    return allCampaigns.length
  } catch (err: any) {
    console.error('[ads] Fetch error:', err.message)
    return 0
  }
}

async function syncAdsStats(campaignIds: number[]) {
  const dateFrom = new Date(Date.now() - DAYS_BACK * 86400000).toISOString().split('T')[0]
  const dateTo = new Date().toISOString().split('T')[0]

  // WB allows max 100 campaigns per request
  const chunks = []
  for (let i = 0; i < campaignIds.length; i += 100) {
    chunks.push(campaignIds.slice(i, i + 100))
  }

  let totalInserted = 0
  for (const chunk of chunks) {
    try {
      const stats = await wbFetch(`${WB_ADV}/v2/fullstats`, {
        method: 'POST',
        body: chunk.map(id => ({ id, dates: [dateFrom, dateTo] })),
      })

      if (!Array.isArray(stats)) continue

      for (const campaign of stats) {
        const cId = campaign.advertId
        for (const day of campaign.days ?? []) {
          for (const app of day.apps ?? [{ nm: []}]) {
            for (const nm of app.nm ?? []) {
              try {
                await pool.query(
                  `INSERT INTO wb_ads_stats (campaign_id, date, views, clicks, ctr, cpc, sum, atbs, orders_count, shks, sum_price, nm_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                   ON CONFLICT (campaign_id, date, nm_id) DO UPDATE SET
                     views = EXCLUDED.views, clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr,
                     cpc = EXCLUDED.cpc, sum = EXCLUDED.sum, atbs = EXCLUDED.atbs,
                     orders_count = EXCLUDED.orders_count, shks = EXCLUDED.shks,
                     sum_price = EXCLUDED.sum_price, fetched_at = NOW()`,
                  [cId, day.date, nm.views, nm.clicks, nm.ctr, nm.cpc, nm.sum,
                   nm.atbs, nm.orders, nm.shks, nm.sum_price, nm.nmId]
                )
                totalInserted++
              } catch (err: any) {
                if (!err.message?.includes('duplicate')) console.error('[ads-stats] Insert error:', err.message)
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[ads-stats] Fetch error:', err.message)
    }
  }
  console.log(`[ads-stats] ${totalInserted} stat rows upserted`)
}

async function syncAnalytics() {
  console.log('[analytics] Fetching nm report...')
  const dateFrom = new Date(Date.now() - DAYS_BACK * 86400000).toISOString().split('T')[0]
  const dateTo = new Date().toISOString().split('T')[0]

  try {
    let offset = 0
    let totalInserted = 0
    let hasMore = true
    const limit = 100

    while (hasMore) {
      const body = {
        selectedPeriod: { start: dateFrom, end: dateTo },
        orderBy: { field: 'orderSum', mode: 'desc' },
        limit,
        offset,
      }
      const resp = await wbFetch(
        `https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products`,
        { method: 'POST', body }
      )
      const cards = resp?.data?.products ?? resp?.data?.cards ?? []

      if (cards.length === 0) {
        hasMore = false
        break
      }

      for (const card of cards) {
        const prod = card.product ?? card
        const nmID = prod.nmId ?? prod.nmID
        const vendor = prod.vendorCode ?? ''
        const brand = prod.brandName ?? ''
        const tag = prod.subjectName ?? ''
        const stats = card.statistic?.selected ?? card.statistics?.selectedPeriod

        if (stats) {
          try {
            await pool.query(
              `INSERT INTO wb_analytics (nm_id, date, vendor_code, brand_name, tag_name,
               opens_count, add_to_cart_count, orders_count, orders_sum_rub,
               buyouts_count, buyouts_sum_rub, cancel_count, cancel_sum_rub,
               avg_price_rub, conversions)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               ON CONFLICT (nm_id, date) DO UPDATE SET
                 opens_count = EXCLUDED.opens_count, add_to_cart_count = EXCLUDED.add_to_cart_count,
                 orders_count = EXCLUDED.orders_count, orders_sum_rub = EXCLUDED.orders_sum_rub,
                 buyouts_count = EXCLUDED.buyouts_count, buyouts_sum_rub = EXCLUDED.buyouts_sum_rub,
                 cancel_count = EXCLUDED.cancel_count, cancel_sum_rub = EXCLUDED.cancel_sum_rub,
                 avg_price_rub = EXCLUDED.avg_price_rub, conversions = EXCLUDED.conversions, fetched_at = NOW()`,
              [nmID, dateFrom, vendor, brand, tag,
               stats.openCount ?? stats.openCardCount ?? 0,
               stats.cartCount ?? stats.addToCartCount ?? 0,
               stats.orderCount ?? stats.ordersCount ?? 0,
               stats.orderSum ?? stats.ordersSumRub ?? 0,
               stats.buyoutCount ?? stats.buyoutsCount ?? 0,
               stats.buyoutSum ?? stats.buyoutsSumRub ?? 0,
               stats.cancelCount ?? 0,
               stats.cancelSum ?? stats.cancelSumRub ?? 0,
               stats.avgPrice ?? stats.avgPriceRub ?? 0,
               JSON.stringify(stats.conversions ?? {})]
            )
            totalInserted++
          } catch (err: any) {
            if (!err.message?.includes('duplicate')) console.error('[analytics] Insert error:', err.message)
          }
        }
      }

      offset += cards.length
      if (cards.length < limit) hasMore = false
      else {
        console.log(`[analytics] ${offset} cards processed, fetching more...`)
        await new Promise(r => setTimeout(r, 1000)) // Rate limit
      }
    }
    console.log(`[analytics] ${totalInserted} cards upserted`)
    return totalInserted
  } catch (err: any) {
    console.error('[analytics] Fetch error:', err.message)
    return 0
  }
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
    await syncReportDetail()
    await syncSupply()
    await syncAdsCampaigns()
    await syncAnalytics()
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
