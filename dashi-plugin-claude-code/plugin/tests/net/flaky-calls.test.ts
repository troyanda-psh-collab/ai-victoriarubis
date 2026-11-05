// The two calls that failed her on 05.11.2026, now retried.
//
// A finished clip did not reach her because Telegram answered `504: Gateway
// Timeout` while the host was busy, and a voice message arrived without its
// transcript because the download never finished. Both paths now go through
// withRetry, and these tests pin that: a transient failure is survived, a
// permanent one is still reported at once.
import { describe, expect, test } from 'bun:test'

import { createTelegramApi } from '../../src/channel/tools.js'
import { maybeTranscribeVoice } from '../../src/telegram/media.js'
import type { AppConfig } from '../../src/config.js'
import type { Bot } from 'grammy'

const nap = { sleep: async () => {} }

function gatewayTimeout(): Error {
  const err = new Error('Call to sendDocument failed! (504: Gateway Timeout)') as Error & {
    error_code: number
  }
  err.error_code = 504
  return err
}

function blocked(): Error {
  const err = new Error('Forbidden: bot was blocked by the user') as Error & { error_code: number }
  err.error_code = 403
  return err
}

// Only the handful of api methods the wrapper touches.
function fakeBot(api: Record<string, unknown>): Bot {
  return { api } as unknown as Bot
}

const voiceConfig: AppConfig = {
  bot_id: 1,
  dm_only: true,
  allowed_user_ids: [1],
  allowed_chat_ids: [1],
  status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true },
  album: { flush_ms: 2000 },
  voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
  webhook: { enabled: false, host: '127.0.0.1', port: 0 },
  permission_relay: { enabled: true, allowed_user_ids: [1], bash_only_proof: true },
  commands: { help: true, status: true, stop: true, reset: true, new: true },
  memory: {
    enabled: false,
    source_tag: 'tg',
    max_hot_bytes: 20480,
    trim_keep_lines: 600,
    buffer_ttl_ms: 5 * 60 * 1000,
    buffer_max_entries: 100,
  },
  progress: {
    enabled: true,
    edit_throttle_ms: 1000,
    recent_buffer: 5,
    session_ttl_ms: 300_000,
  },
} as AppConfig

describe('sending a file while the host is busy', () => {
  test('a gateway timeout is survived and the message goes out', async () => {
    let calls = 0
    const api = createTelegramApi(
      fakeBot({
        sendDocument: async () => {
          calls += 1
          if (calls === 1) throw gatewayTimeout()
          return { message_id: 77 }
        },
      }),
      'token',
      nap,
    )
    const sent = await api.sendDocument('1', '/tmp/clip.mp4', {})
    expect(sent.message_id).toBe(77)
    expect(calls).toBe(2)
  })

  test('a photo gets the same second chance', async () => {
    let calls = 0
    const api = createTelegramApi(
      fakeBot({
        sendPhoto: async () => {
          calls += 1
          if (calls === 1) throw gatewayTimeout()
          return { message_id: 5 }
        },
      }),
      'token',
      nap,
    )
    await api.sendPhoto('1', '/tmp/pic.jpg', {})
    expect(calls).toBe(2)
  })

  test('so does a plain text reply', async () => {
    let calls = 0
    const api = createTelegramApi(
      fakeBot({
        sendMessage: async () => {
          calls += 1
          if (calls === 1) throw gatewayTimeout()
          return { message_id: 9 }
        },
      }),
      'token',
      nap,
    )
    await api.sendMessage('1', 'привет', {})
    expect(calls).toBe(2)
  })

  test('a blocked bot is reported at once, without pointless retries', async () => {
    let calls = 0
    const api = createTelegramApi(
      fakeBot({
        sendDocument: async () => {
          calls += 1
          throw blocked()
        },
      }),
      'token',
      nap,
    )
    await expect(api.sendDocument('1', '/tmp/clip.mp4', {})).rejects.toThrow('blocked')
    expect(calls).toBe(1)
  })
})

describe('transcribing a voice message while the host is busy', () => {
  const key = { GROQ_API_KEY: 'gsk_test_key' }

  function okResponse(text: string): Response {
    return new Response(text, { status: 200 })
  }

  test('a download that dies mid-way is retried, and the transcript arrives', async () => {
    let downloads = 0
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v1',
        retry: nap,
        downloadFile: async () => {
          downloads += 1
          if (downloads === 1) throw new Error('fetch failed')
          return { path: '/tmp/voice.oga', mime: 'audio/ogg', size: 1024 }
        },
        readFile: async () => new Uint8Array([1, 2, 3]),
        fetchImpl: (async () => okResponse('Привет')) as unknown as typeof fetch,
      },
      voiceConfig,
      key,
    )
    expect(r.status).toBe('ok')
    expect(r.transcript).toBe('Привет')
    expect(downloads).toBe(2)
  })

  test('a 503 from the transcription service is retried', async () => {
    let posts = 0
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v1',
        retry: nap,
        downloadFile: async () => ({ path: '/tmp/voice.oga', mime: 'audio/ogg', size: 1024 }),
        readFile: async () => new Uint8Array([1, 2, 3]),
        fetchImpl: (async () => {
          posts += 1
          if (posts === 1) return new Response('upstream unavailable', { status: 503 })
          return okResponse('Второй раз получилось')
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      key,
    )
    expect(r.status).toBe('ok')
    expect(r.transcript).toBe('Второй раз получилось')
    expect(posts).toBe(2)
  })

  test('a rejected file is not sent again — the answer would not change', async () => {
    let posts = 0
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v1',
        retry: nap,
        downloadFile: async () => ({ path: '/tmp/voice.oga', mime: 'audio/ogg', size: 1024 }),
        readFile: async () => new Uint8Array([1, 2, 3]),
        fetchImpl: (async () => {
          posts += 1
          return new Response('unsupported_audio_format', { status: 400 })
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      key,
    )
    expect(r.status).toBe('failed')
    expect(posts).toBe(1)
  })

  test('when every attempt fails the status is still failed, not a crash', async () => {
    let posts = 0
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v1',
        retry: nap,
        downloadFile: async () => ({ path: '/tmp/voice.oga', mime: 'audio/ogg', size: 1024 }),
        readFile: async () => new Uint8Array([1, 2, 3]),
        fetchImpl: (async () => {
          posts += 1
          return new Response('gateway timeout', { status: 504 })
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      key,
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('504')
    expect(posts).toBe(3)
  })

  test('the key never leaks into the message, retries or not', async () => {
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v1',
        retry: nap,
        downloadFile: async () => {
          throw new Error('fetch failed for gsk_test_key')
        },
        readFile: async () => new Uint8Array([1, 2, 3]),
        fetchImpl: (async () => okResponse('x')) as unknown as typeof fetch,
      },
      voiceConfig,
      key,
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage ?? '').not.toContain('gsk_test_key')
  })
})
