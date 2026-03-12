import { FINTABLO_API_TOKEN, FINTABLO_API_URL } from './config.js'
import { logger } from './logger.js'

export interface FinTabloTransactionPayload {
  date: string        // YYYY-MM-DD (will be converted to DD.MM.YYYY)
  value: number       // positive number
  group: 'outcome' | 'income' | 'transfer'
  moneybagId: number  // account ID in FinTablo
  moneybag2Id?: number // second account for transfers
  categoryId?: number
  directionId?: number
  partnerId?: number
  description?: string
}

export interface FinTabloCategory {
  id: number
  name: string
  type: string
}

export interface FinTabloDirection {
  id: number
  name: string
}

export interface FinTabloAccount {
  id: number
  name: string
  type: string
  groupId: number
  number: string
  currency: string
  balance: number
  archived: number
}

export interface FinTabloGroup {
  id: number
  name: string
}

export interface FinTabloPartner {
  id: number
  name: string
  groupId: number | null
  inn: string
}

let partnersCache: FinTabloPartner[] | null = null
let categoriesCache: FinTabloCategory[] | null = null
let directionsCache: FinTabloDirection[] | null = null
let accountsCache: FinTabloAccount[] | null = null
let groupsCache: FinTabloGroup[] | null = null

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${FINTABLO_API_URL}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${FINTABLO_API_TOKEN}`,
    'Content-Type': 'application/json',
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const text = await response.text()
    logger.error({ status: response.status, body: text, path }, 'FinTablo API error')
    throw new Error(`FinTablo ${response.status}: ${text}`)
  }

  return response.json()
}

export async function postTransaction(data: FinTabloTransactionPayload): Promise<string> {
  // Convert date to DD.MM.YYYY HH:mm format
  let fmtDate: string
  const raw = data.date
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // YYYY-MM-DD
    const [y, m, d] = raw.split('-')
    fmtDate = `${d}.${m}.${y} 12:00`
  } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) {
    // Already DD.MM.YYYY
    fmtDate = `${raw} 12:00`
  } else {
    // Try to parse as Date
    const dt = new Date(raw)
    const dd = String(dt.getDate()).padStart(2, '0')
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const yyyy = dt.getFullYear()
    fmtDate = `${dd}.${mm}.${yyyy} 12:00`
  }
  const payload = {
    ...data,
    date: fmtDate,
  }
  logger.info({ payload }, 'Sending to FinTablo')
  const result = await apiRequest('POST', '/v1/transaction', payload) as { id: number }
  logger.info({ id: result.id }, 'Created FinTablo transaction')
  return String(result.id)
}

export async function getCategories(forceRefresh = false): Promise<FinTabloCategory[]> {
  if (categoriesCache && !forceRefresh) return categoriesCache
  const result = await apiRequest('GET', '/v1/category') as { items: FinTabloCategory[] }
  categoriesCache = result.items
  return result.items
}

export async function getDirections(forceRefresh = false): Promise<FinTabloDirection[]> {
  if (directionsCache && !forceRefresh) return directionsCache
  const result = await apiRequest('GET', '/v1/direction') as { items: FinTabloDirection[] }
  directionsCache = result.items
  return result.items
}

export async function getAccounts(forceRefresh = false): Promise<FinTabloAccount[]> {
  if (accountsCache && !forceRefresh) return accountsCache
  const result = await apiRequest('GET', '/v1/moneybag') as { items: FinTabloAccount[] }
  accountsCache = result.items.filter(a => !a.archived)
  return accountsCache
}

export async function getPartners(forceRefresh = false): Promise<FinTabloPartner[]> {
  if (partnersCache && !forceRefresh) return partnersCache
  const result = await apiRequest('GET', '/v1/partner') as { items: FinTabloPartner[] }
  partnersCache = result.items
  return result.items
}

export async function createPartner(name: string): Promise<number> {
  const result = await apiRequest('POST', '/v1/partner', { name }) as { items: Array<{ id: number }> }
  const id = result.items[0].id
  partnersCache = null // invalidate cache
  logger.info({ id, name }, 'Created FinTablo partner')
  return id
}

export async function findOrCreatePartner(name: string): Promise<number> {
  const partners = await getPartners()
  const normalized = name.toLowerCase().trim()
  const existing = partners.find(p => p.name.toLowerCase().trim() === normalized)
  if (existing) return existing.id
  return createPartner(name)
}

export async function getGroups(forceRefresh = false): Promise<FinTabloGroup[]> {
  if (groupsCache && !forceRefresh) return groupsCache
  const result = await apiRequest('GET', '/v1/moneybag-group') as { items: FinTabloGroup[] }
  groupsCache = result.items
  return result.items
}
