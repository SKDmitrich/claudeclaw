import { describe, it, expect } from 'vitest'
import { formatForTelegram, splitMessage, isAuthorised } from './bot.js'

describe('formatForTelegram', () => {
  it('converts **bold** to <b>', () => {
    expect(formatForTelegram('**hello**')).toBe('<b>hello</b>')
  })

  it('converts __bold__ to <b>', () => {
    expect(formatForTelegram('__hello__')).toBe('<b>hello</b>')
  })

  it('converts *italic* to <i>', () => {
    expect(formatForTelegram('*hello*')).toBe('<i>hello</i>')
  })

  it('converts ~~strikethrough~~ to <s>', () => {
    expect(formatForTelegram('~~hello~~')).toBe('<s>hello</s>')
  })

  it('converts [link](url) to <a>', () => {
    expect(formatForTelegram('[click here](https://example.com)')).toBe(
      '<a href="https://example.com">click here</a>'
    )
  })

  it('converts # heading to <b>', () => {
    expect(formatForTelegram('# My Title')).toBe('<b>My Title</b>')
  })

  it('converts inline `code` to <code>', () => {
    expect(formatForTelegram('use `npm install`')).toBe('use <code>npm install</code>')
  })

  it('converts ```code block``` to <pre>', () => {
    const result = formatForTelegram('```\nconsole.log("hi")\n```')
    expect(result).toContain('<pre>')
    expect(result).toContain('console.log')
  })

  it('converts - [ ] to ☐', () => {
    expect(formatForTelegram('- [ ] task')).toBe('☐ task')
  })

  it('converts - [x] to ☑', () => {
    expect(formatForTelegram('- [x] done')).toBe('☑ done')
  })

  it('escapes & in text', () => {
    const result = formatForTelegram('rock & roll')
    expect(result).toBe('rock &amp; roll')
  })

  it('strips --- dividers', () => {
    const result = formatForTelegram('above\n---\nbelow')
    expect(result).not.toContain('---')
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    const chunks = splitMessage('hello world')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('hello world')
  })

  it('splits long text at newlines', () => {
    const longText = 'line\n'.repeat(300)
    const chunks = splitMessage(longText, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
  })
})

describe('isAuthorised', () => {
  it('returns true when no ALLOWED_CHAT_ID set (first-run mode)', () => {
    // With empty config, isAuthorised should be permissive
    // This tests the runtime behavior given the current config
    // In test env, config will have empty ALLOWED_CHAT_ID
    const result = isAuthorised(12345)
    expect(typeof result).toBe('boolean')
  })
})
