import { GROQ_API_KEY } from './config.js'
import { logger } from './logger.js'

export async function transcribeVoice(fileUrl: string): Promise<string | null> {
  if (!GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, voice transcription unavailable')
    return null
  }

  try {
    const audioResponse = await fetch(fileUrl)
    const audioBuffer = await audioResponse.arrayBuffer()

    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg')
    formData.append('model', 'whisper-large-v3')
    formData.append('language', 'ru')

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: formData,
    })

    if (!response.ok) {
      logger.error({ status: response.status }, 'Groq STT error')
      return null
    }

    const data = await response.json() as { text: string }
    return data.text || null
  } catch (err) {
    logger.error({ err }, 'Voice transcription failed')
    return null
  }
}
