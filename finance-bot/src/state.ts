export type ConversationState =
  | { type: 'registration_name' }
  | { type: 'awaiting_expense_description'; txnId: number }

export const userStates = new Map<number, ConversationState>()
export const txnQueue = new Map<number, number[]>()
