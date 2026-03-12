import { ZENMONEY_ACCESS_TOKEN, ZENMONEY_POLL_INTERVAL } from './config.js'
import { getSyncState, setSyncState } from './db.js'
import { logger } from './logger.js'

export interface ZenMoneyTransaction {
  id: string
  date: string
  income: number
  incomeAccount: string
  outcome: number
  outcomeAccount: string
  payee: string | null
  merchant: string | null
  comment: string | null
  tag: string[] | null
  deleted: boolean
  hold: boolean
  mcc: number | null
  changed: number
}

interface DiffResponse {
  serverTimestamp: number
  transaction?: ZenMoneyTransaction[]
  account?: Array<{ id: string; title: string; syncID: string[] | null }>
}

const API_URL = 'https://api.zenmoney.ru/v8/diff/'

let pollTimer: ReturnType<typeof setInterval> | null = null
let polling = false

export async function fetchNewTransactions(): Promise<{
  transactions: ZenMoneyTransaction[]
  accounts: Array<{ id: string; title: string; syncID: string[] | null }>
}> {
  const lastTs = getSyncState('last_server_timestamp') ?? '0'

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZENMONEY_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      currentClientTimestamp: Math.floor(Date.now() / 1000),
      serverTimestamp: parseInt(lastTs, 10),
    }),
  })

  if (response.status === 401) {
    throw new Error('ZENMONEY_AUTH_EXPIRED')
  }

  if (!response.ok) {
    throw new Error(`ZenMoney API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as DiffResponse

  setSyncState('last_server_timestamp', String(data.serverTimestamp))

  // Return ALL non-deleted transactions
  const transactions = (data.transaction ?? []).filter(t => !t.deleted)

  return { transactions, accounts: data.account ?? [] }
}

export function startPolling(
  onTransaction: (txn: ZenMoneyTransaction) => Promise<void>,
  onAuthError: () => void,
  onAccountsSync?: (accounts: Array<{ id: string; title: string; syncID: string[] | null }>) => void
): void {
  if (polling) return
  polling = true

  const poll = async () => {
    try {
      logger.info('ZenMoney: polling for new transactions...')
      const { transactions, accounts } = await fetchNewTransactions()
      logger.info({ count: transactions.length }, 'ZenMoney: got transactions')

      if (accounts.length > 0 && onAccountsSync) {
        onAccountsSync(accounts)
      }

      for (const txn of transactions) {
        try {
          await onTransaction(txn)
        } catch (err) {
          logger.error({ err, txnId: txn.id }, 'Error processing ZenMoney transaction')
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'ZENMONEY_AUTH_EXPIRED') {
        logger.error('ZenMoney token expired! Stopping polling.')
        onAuthError()
        stopPolling()
        return
      }
      logger.error({ err }, 'ZenMoney polling error')
    }
  }

  poll()
  pollTimer = setInterval(poll, ZENMONEY_POLL_INTERVAL * 1000)
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  polling = false
}
