import { Bot, Context, InputFile } from 'grammy'
import { writeFileSync, unlinkSync } from 'fs'
import path from 'path'
import os from 'os'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js'
import { getSession, setSession, clearSession, getAllMemories, deleteAllMemories } from './db.js'
import { runAgent } from './agent.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from './voice.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, UPLOADS_DIR } from './media.js'
import { logger } from './logger.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatForTelegram(text: string): string {
  // 1. Protect code blocks (multi-line and inline)
  const codeBlocks: string[] = []
  let protected_ = text.replace(/```[\s\S]*?```/g, match => {
    const lang = match.match(/^```(\w+)?/)?.[1] ?? ''
    const code = match.replace(/^```\w*\n?/, '').replace(/```$/, '')
    const escaped = escapeHtml(code)
    const idx = codeBlocks.length
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    return `\x00CODE${idx}\x00`
  })

  // Protect inline code
  const inlineCodes: string[] = []
  protected_ = protected_.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINE${idx}\x00`
  })

  // 2. Convert Markdown in text
  let result = protected_
    // Strip --- dividers
    .replace(/^---+$/gm, '')
    // Strip ***
    .replace(/^\*{3,}$/gm, '')
    // Headings → bold
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    // Bold **text** or __text__
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    // Italic *text* or _text_ (not inside words)
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<i>$1</i>')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<i>$1</i>')
    // Strikethrough ~~text~~
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Checkboxes
    .replace(/^- \[ \] /gm, '☐ ')
    .replace(/^- \[x\] /gi, '☑ ')

  // 3. Escape & < > in non-tag text nodes
  result = escapeTextNodes(result)

  // 4. Restore protected blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)])

  return result.trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Escape & < > only in plain text regions (not inside HTML tags).
 */
function escapeTextNodes(html: string): string {
  return html.replace(/(<[^>]+>)|([^<]+)/g, (match, tag, text) => {
    if (tag) return tag
    return text
      .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  })
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', limit)
    if (splitAt === -1) splitAt = limit
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)

  return chunks
}

export function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID && ALLOWED_CHAT_IDS.length === 0) {
    // First-run mode — no restriction yet
    return true
  }
  return ALLOWED_CHAT_IDS.includes(String(chatId))
}

// ─── Voice mode state ─────────────────────────────────────────────────────────

const voiceModeChats = new Set<string>()

// ─── Core message handler ─────────────────────────────────────────────────────

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = String(ctx.chat?.id)
  if (!chatId) return

  if (!isAuthorised(Number(chatId))) {
    await ctx.reply('Unauthorized. Your chat ID: ' + chatId)
    return
  }

  try {
    // Memory context
    const memCtx = await buildMemoryContext(chatId, rawText)
    const message = memCtx ? `${memCtx}\n\n${rawText}` : rawText

    // Session
    const sessionId = getSession(chatId)

    // Typing loop
    let typingActive = true
    const typingLoop = setInterval(async () => {
      if (typingActive) {
        try { await ctx.replyWithChatAction('typing') } catch { /* ignore */ }
      }
    }, TYPING_REFRESH_MS)

    await ctx.replyWithChatAction('typing')

    let result: { text: string | null; newSessionId?: string }
    try {
      result = await runAgent(message, sessionId)
    } finally {
      typingActive = false
      clearInterval(typingLoop)
    }

    const responseText = result.text ?? '(no response)'

    // Save session
    if (result.newSessionId) {
      setSession(chatId, result.newSessionId)
    }

    // Save memory
    await saveConversationTurn(chatId, rawText, responseText)

    const caps = voiceCapabilities()
    const useVoice = caps.tts && (forceVoiceReply || voiceModeChats.has(chatId))

    if (useVoice) {
      try {
        const audioBuffer = await synthesizeSpeech(responseText)
        const tmpPath = path.join(os.tmpdir(), `claudeclaw_tts_${Date.now()}.mp3`)
        writeFileSync(tmpPath, audioBuffer)
        await ctx.replyWithVoice(new InputFile(tmpPath))
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      } catch (ttsErr) {
        logger.warn({ ttsErr }, 'TTS failed, falling back to text')
        await sendTextChunks(ctx, responseText)
      }
    } else {
      await sendTextChunks(ctx, responseText)
    }
  } catch (err: any) {
    logger.error({ err }, 'handleMessage error')

    // Clear stale session so next message starts fresh
    clearSession(chatId)
    logger.info({ chatId }, 'Cleared session after error for auto-recovery')

    const isExitCode1 = err?.message?.includes('exited with code 1')
    const userMsg = isExitCode1
      ? 'Claude subprocess crashed. Session cleared -- try sending your message again.'
      : 'Something went wrong. Session cleared -- try again.'
    await ctx.reply(userMsg).catch(() => {})
  }
}

async function sendTextChunks(ctx: Context, text: string): Promise<void> {
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'HTML' })
  }
}

// ─── Bot factory ──────────────────────────────────────────────────────────────

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Run `npm run setup` or add it to .env')
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  // ── Commands ────────────────────────────────────────────────────────────────

  bot.command('start', async ctx => {
    const chatId = ctx.chat?.id
    await ctx.reply(
      `ClaudeClaw is running.\n\nYour chat ID: <code>${chatId}</code>\n\nSend me anything — text, voice notes, photos, or documents.`,
      { parse_mode: 'HTML' }
    )
  })

  bot.command('chatid', async ctx => {
    await ctx.reply(`Your chat ID: <code>${ctx.chat?.id}</code>`, { parse_mode: 'HTML' })
  })

  bot.command('newchat', async ctx => {
    const chatId = String(ctx.chat?.id)
    clearSession(chatId)
    await ctx.reply('Session cleared. Starting fresh.')
  })

  bot.command('forget', async ctx => {
    const chatId = String(ctx.chat?.id)
    clearSession(chatId)
    deleteAllMemories(chatId)
    await ctx.reply('Session and memories cleared.')
  })

  bot.command('memory', async ctx => {
    const chatId = String(ctx.chat?.id)
    const memories = getAllMemories(chatId)
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.')
      return
    }
    const lines = memories
      .slice(0, 20)
      .map((m, i) => `${i + 1}. [${m.sector}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`)
    await ctx.reply(`Stored memories (${memories.length} total):\n\n${lines.join('\n')}`)
  })

  bot.command('voice', async ctx => {
    const chatId = String(ctx.chat?.id)
    const caps = voiceCapabilities()
    if (!caps.tts) {
      await ctx.reply('TTS is not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to .env')
      return
    }
    if (voiceModeChats.has(chatId)) {
      voiceModeChats.delete(chatId)
      await ctx.reply('Voice mode off. Replies will be text.')
    } else {
      voiceModeChats.add(chatId)
      await ctx.reply('Voice mode on. Replies will be audio.')
    }
  })

  // ── Text ─────────────────────────────────────────────────────────────────────

  bot.on('message:text', async ctx => {
    await handleMessage(ctx, ctx.message.text)
  })

  // ── Voice notes ──────────────────────────────────────────────────────────────

  bot.on('message:voice', async ctx => {
    const chatId = String(ctx.chat?.id)
    if (!isAuthorised(Number(chatId))) {
      await ctx.reply('Unauthorized.')
      return
    }
    const caps = voiceCapabilities()
    if (!caps.stt) {
      await ctx.reply('Voice transcription is not configured. Add GROQ_API_KEY to .env')
      return
    }
    try {
      await ctx.replyWithChatAction('typing')
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, ctx.message.voice.file_id, 'voice.oga')
      const transcript = await transcribeAudio(localPath)
      const prefixed = `[Voice transcribed]: ${transcript}`
      await handleMessage(ctx, prefixed, true)
    } catch (err) {
      logger.error({ err }, 'Voice handling error')
      await ctx.reply('Failed to process voice note.')
    }
  })

  // ── Photos ───────────────────────────────────────────────────────────────────

  bot.on('message:photo', async ctx => {
    const chatId = String(ctx.chat?.id)
    if (!isAuthorised(Number(chatId))) return
    try {
      await ctx.replyWithChatAction('typing')
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, largest.file_id, 'photo.jpg')
      const msg = buildPhotoMessage(localPath, ctx.message.caption)
      await handleMessage(ctx, msg)
    } catch (err) {
      logger.error({ err }, 'Photo handling error')
      await ctx.reply('Failed to process photo.')
    }
  })

  // ── Documents ────────────────────────────────────────────────────────────────

  bot.on('message:document', async ctx => {
    const chatId = String(ctx.chat?.id)
    if (!isAuthorised(Number(chatId))) return
    try {
      await ctx.replyWithChatAction('upload_document')
      const doc = ctx.message.document
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name ?? 'document')
      const msg = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption)
      await handleMessage(ctx, msg)
    } catch (err) {
      logger.error({ err }, 'Document handling error')
      await ctx.reply('Failed to process document.')
    }
  })

  // ── Error handler ────────────────────────────────────────────────────────────

  bot.catch(err => {
    logger.error({ err: err.error, ctx: err.ctx?.chat?.id }, 'Bot error')
  })

  return bot
}

export type TelegramBot = Bot

export async function sendMessage(bot: Bot, chatId: string, text: string): Promise<void> {
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
  }
}
