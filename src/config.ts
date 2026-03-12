import { fileURLToPath } from 'url'
import path from 'path'
import { readEnvFile } from './env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '..')
export const STORE_DIR = path.join(PROJECT_ROOT, 'store')

const env = readEnvFile()

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

// Voice
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? ''
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? ''

// Multiuser
export const ALLOWED_CHAT_IDS: string[] = ALLOWED_CHAT_ID
  ? ALLOWED_CHAT_ID.split(',').map(s => s.trim()).filter(Boolean)
  : []

export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
