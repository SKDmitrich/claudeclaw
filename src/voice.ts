import { readFileSync, renameSync } from 'fs'
import https from 'https'
import path from 'path'
import { GROQ_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } from './config.js'
import { logger } from './logger.js'

// ─── STT — Groq Whisper ───────────────────────────────────────────────────────

export async function transcribeAudio(filePath: string): Promise<string> {
  // Groq requires .ogg, not .oga (same format, different extension)
  let sendPath = filePath
  if (filePath.endsWith('.oga')) {
    sendPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, sendPath)
  }

  const fileBuffer = readFileSync(sendPath)
  const filename = path.basename(sendPath)

  const boundary = `----FormBoundary${Date.now().toString(16)}`
  const CRLF = '\r\n'

  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: audio/ogg',
    '',
    '',
  ].join(CRLF)

  const modelPart = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    '',
    'whisper-large-v3',
    '',
  ].join(CRLF)

  const footer = `--${boundary}--${CRLF}`

  const body = Buffer.concat([
    Buffer.from(header),
    fileBuffer,
    Buffer.from(CRLF + modelPart + footer),
  ])

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      res => {
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.text) {
              resolve(parsed.text as string)
            } else {
              logger.error({ response: data }, 'Groq STT unexpected response')
              reject(new Error(`Groq STT error: ${data}`))
            }
          } catch {
            reject(new Error(`Groq STT parse error: ${data}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── TTS — ElevenLabs ─────────────────────────────────────────────────────────

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const body = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  })

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'audio/mpeg',
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`ElevenLabs TTS error ${res.statusCode}: ${buf.toString()}`))
          } else {
            resolve(buf)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── Capability check ─────────────────────────────────────────────────────────

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: Boolean(GROQ_API_KEY),
    tts: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
  }
}
