export type MissingField = 'date' | 'amount' | 'account_info' | 'category' | 'direction' | 'counterparty'

export type ConversationState =
  | { type: 'registration_name' }
  | { type: 'awaiting_expense_description'; txnId: number }
  | { type: 'filling_missing_field'; txnId: number; field: MissingField; remaining: MissingField[] }

export const userStates = new Map<number, ConversationState>()
export const txnQueue = new Map<number, number[]>()
