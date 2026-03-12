import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

export const UPLOADS_DIR = path.join(PROJECT_ROOT, 'workspace', 'uploads')

function ensureUploadsDir(): void {
  mkdirSync(UPLOADS_DIR, { recursive: true })
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  ensureUploadsDir()

  // Step 1: get file path from Telegram
  const filePath = await new Promise<string>((resolve, reject) => {
    https.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
      res => {
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => {
          const parsed = JSON.parse(data)
          if (parsed.ok && parsed.result?.file_path) {
            resolve(parsed.result.file_path as string)
          } else {
            reject(new Error(`getFile failed: ${data}`))
          }
        })
      }
    ).on('error', reject)
  })

  const ext = path.extname(filePath) || ''
  const baseName = originalFilename
    ? sanitizeFilename(originalFilename)
    : `${sanitizeFilename(path.basename(filePath, ext))}${ext}`

  const localPath = path.join(UPLOADS_DIR, `${Date.now()}_${baseName}`)

  // Step 2: download file
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(localPath)
    https.get(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      res => {
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      }
    ).on('error', err => {
      file.close()
      reject(err)
    })
  })

  return localPath
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`I'm sending you an image file at path: ${localPath}`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please analyze this image and respond to the caption or describe what you see.')
  return parts.join('\n')
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  const parts = [`I'm sending you a document file at path: ${localPath}`, `Filename: ${filename}`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please read and analyze this document.')
  return parts.join('\n')
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [
    `I'm sending you a video file at path: ${localPath}`,
    'Please use the gemini-api-dev skill with the GOOGLE_API_KEY from the project .env to analyze this video.',
  ]
  if (caption) parts.push(`Caption: ${caption}`)
  return parts.join('\n')
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    ensureUploadsDir()
    const now = Date.now()
    const files = readdirSync(UPLOADS_DIR)
    for (const f of files) {
      const fp = path.join(UPLOADS_DIR, f)
      const stat = statSync(fp)
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(fp)
      }
    }
  } catch {
    // Non-critical — uploads dir may not exist yet
  }
}
