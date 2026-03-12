import { FINTABLO_API_TOKEN, FINTABLO_API_URL } from './config.js'
import { logger } from './logger.js'

export interface FinTabloTransactionPayload {
  date: string
  amount: number
  account_id?: number
  counterparty_id?: number
  counterparty_name?: string
  category_id?: number
  direction_id?: number
  description?: string
  currency?: string
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
  const result = await apiRequest('POST', '/v1/transaction', data) as { id: string }
  logger.info({ id: result.id }, 'Created FinTablo transaction')
  return result.id
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

export async function getGroups(forceRefresh = false): Promise<FinTabloGroup[]> {
  if (groupsCache && !forceRefresh) return groupsCache
  const result = await apiRequest('GET', '/v1/moneybag-group') as { items: FinTabloGroup[] }
  groupsCache = result.items
  return result.items
}
