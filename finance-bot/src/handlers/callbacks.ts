import type { Context } from 'grammy'
import {
  setManagerStatus, getManagerById,
  getPendingTransaction, updatePendingTransaction,
} from '../db.js'
import { postTransaction, findOrCreatePartner } from '../fintablo.js'
import { logger } from '../logger.js'
import { userStates } from '../state.js'
import { processNextInQueue, handleFieldPickerCallback, handleEditMenuCallback, handleBackToConfirmCallback } from './expense.js'
import { adminCallbackHandler } from './admin.js'

export async function callbackHandler(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data
  if (!data) return

  await ctx.answerCallbackQuery()

  if (data.startsWith('admin:')) {
    await adminCallbackHandler(ctx, data)
  } else if (data.startsWith('approve_mgr:')) {
    await handleApproveManager(ctx, data)
  } else if (data.startsWith('reject_mgr:')) {
    await handleRejectManager(ctx, data)
  } else if (data.startsWith('pick_cat:') || data.startsWith('pick_dir:') || data.startsWith('pick_acc:')) {
    await handleFieldPickerCallback(ctx, data)
  } else if (data.startsWith('edit_menu:')) {
    await handleEditMenuCallback(ctx, data)
  } else if (data.startsWith('back_confirm:')) {
    await handleBackToConfirmCallback(ctx, data)
  } else if (data.startsWith('edit_')) {
    await handleFieldPickerCallback(ctx, data)
  } else if (data.startsWith('confirm_txn:')) {
    await handleConfirmTransaction(ctx, data)
  } else if (data.startsWith('cancel_txn:')) {
    await handleCancelTransaction(ctx, data)
  }
}

async function handleApproveManager(ctx: Context, data: string): Promise<void> {
  const id = parseInt(data.split(':')[1], 10)
  const manager = getManagerById(id)
  if (!manager) return

  setManagerStatus(id, 'active')
  await ctx.editMessageText(`${manager.name} -- одобрен`)

  try {
    await ctx.api.sendMessage(manager.telegram_id, 'Ты подключен! Теперь можешь писать описание расходов.')
  } catch (err) {
    logger.error({ err }, 'Failed to notify manager')
  }
}

async function handleRejectManager(ctx: Context, data: string): Promise<void> {
  const id = parseInt(data.split(':')[1], 10)
  const manager = getManagerById(id)
  if (!manager) return

  setManagerStatus(id, 'blocked')
  await ctx.editMessageText(`${manager.name} -- отклонен`)

  try {
    await ctx.api.sendMessage(manager.telegram_id, 'Заявка отклонена. Обратись к администратору.')
  } catch (err) {
    logger.error({ err }, 'Failed to notify manager')
  }
}

async function handleConfirmTransaction(ctx: Context, data: string): Promise<void> {
  const txnId = parseInt(data.split(':')[1], 10)
  const txn = getPendingTransaction(txnId)
  if (!txn) return

  updatePendingTransaction(txnId, { status: 'confirmed' })

  try {
    let partnerId: number | undefined
    if (txn.counterparty_name) {
      partnerId = await findOrCreatePartner(txn.counterparty_name)
    }

    const fintabloId = await postTransaction({
      date: txn.date!,
      value: Math.abs(txn.amount!),
      group: 'outcome',
      moneybagId: txn.account_id!,
      categoryId: txn.category_id ?? undefined,
      directionId: txn.direction_id ?? undefined,
      partnerId,
      description: txn.description ?? undefined,
    })

    updatePendingTransaction(txnId, { status: 'sent', fintablo_txn_id: fintabloId })
    await ctx.editMessageText(
      `Отправлено в ФинТабло\n${txn.date} | ${txn.amount}₽ | ${txn.category_name ?? '?'} | ${txn.description ?? ''}`
    )
  } catch (err) {
    logger.error({ err, txnId }, 'Failed to send to FinTablo')
    updatePendingTransaction(txnId, { status: 'failed' })
    await ctx.editMessageText(
      `Ошибка отправки в ФинТабло. Попробуй /retry\n${txn.date} | ${txn.amount}₽ | ${txn.description ?? ''}`
    )
  }

  // Process next queued transaction for this manager
  if (txn.manager_id) {
    const manager = getManagerById(txn.manager_id)
    if (manager) {
      userStates.delete(parseInt(manager.telegram_id, 10))
      await processNextInQueue(ctx.api, parseInt(manager.telegram_id, 10))
    }
  }
}

async function handleCancelTransaction(ctx: Context, data: string): Promise<void> {
  const txnId = parseInt(data.split(':')[1], 10)
  const txn = getPendingTransaction(txnId)
  if (!txn) return

  updatePendingTransaction(txnId, { status: 'failed' })
  await ctx.editMessageText(`Отменено: ${txn.date} | ${txn.amount}₽`)

  if (txn.manager_id) {
    const manager = getManagerById(txn.manager_id)
    if (manager) {
      userStates.delete(parseInt(manager.telegram_id, 10))
      await processNextInQueue(ctx.api, parseInt(manager.telegram_id, 10))
    }
  }
}

