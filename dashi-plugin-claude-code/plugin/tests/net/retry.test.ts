// A call that fails because the machine was busy for a moment should not
// be reported as a failure to the operator.
//
// On 05.11.2026 the video editor's clip never reached her: Telegram answered
// `504: Gateway Timeout` twice while ffmpeg and a local speech model were
// eating the host's memory. Her voice message of the same minute reached the
// same agent without a transcript, for the same reason. Both calls were short
// and both would have succeeded seconds later — nobody retried them.
//
// These tests pin what "retry" means here: transient failures are retried
// with growing pauses, permanent ones are raised at once, and the work is
// never done twice after it succeeded.
import { describe, expect, test } from 'bun:test'

import { isTransient, withRetry } from '../../src/net/retry.js'

// A stand-in for grammY's GrammyError: what matters to us is `error_code`.
function telegramError(code: number, description = 'telegram said no'): Error {
  const err = new Error(description) as Error & { error_code: number }
  err.error_code = code
  return err
}

describe('isTransient', () => {
  test('a gateway timeout from Telegram is worth retrying', () => {
    expect(isTransient(telegramError(504, 'Gateway Timeout'))).toBe(true)
  })

  test('so is any other server-side failure', () => {
    expect(isTransient(telegramError(500))).toBe(true)
    expect(isTransient(telegramError(502))).toBe(true)
  })

  test('and being asked to slow down', () => {
    expect(isTransient(telegramError(429, 'Too Many Requests'))).toBe(true)
  })

  test('a rejected request is not — the next attempt is rejected too', () => {
    expect(isTransient(telegramError(400, 'Bad Request: chat not found'))).toBe(false)
    expect(isTransient(telegramError(401))).toBe(false)
    expect(isTransient(telegramError(403, 'bot was blocked by the user'))).toBe(false)
  })

  test('a socket that died mid-call is worth retrying', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true)
    expect(isTransient(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransient(new Error('connect ETIMEDOUT 149.154.167.220:443'))).toBe(true)
    expect(isTransient(new Error('socket hang up'))).toBe(true)
    expect(isTransient(new Error('The operation was aborted'))).toBe(true)
    expect(isTransient(new Error('getaddrinfo EAI_AGAIN api.telegram.org'))).toBe(true)
  })

  test('an HTTP status carried as plain text still counts', () => {
    // maybeTranscribeVoice builds its own message out of the response code.
    expect(isTransient(new Error('groq HTTP 503: upstream unavailable'))).toBe(true)
    expect(isTransient(new Error('groq HTTP 429: rate limited'))).toBe(true)
    expect(isTransient(new Error('groq HTTP 400: unsupported_audio_format'))).toBe(false)
  })

  test('a mistake in our own code is not a network hiccup', () => {
    expect(isTransient(new TypeError('x.map is not a function'))).toBe(false)
    expect(isTransient(new Error('refusing to send file outside workspace'))).toBe(false)
  })
})

describe('withRetry', () => {
  test('a call that works is made once and its value returned', async () => {
    let calls = 0
    const value = await withRetry(async () => {
      calls += 1
      return 'sent'
    })
    expect(value).toBe('sent')
    expect(calls).toBe(1)
  })

  test('a gateway timeout is tried again and the second attempt stands', async () => {
    let calls = 0
    const slept: number[] = []
    const value = await withRetry(
      async () => {
        calls += 1
        if (calls === 1) throw telegramError(504, 'Gateway Timeout')
        return 'sent'
      },
      { sleep: async (ms) => { slept.push(ms) } },
    )
    expect(value).toBe('sent')
    expect(calls).toBe(2)
    expect(slept.length).toBe(1)
  })

  test('the pause grows between attempts, so a busy host gets room', async () => {
    const slept: number[] = []
    await expect(
      withRetry(
        async () => { throw telegramError(504) },
        { attempts: 3, baseDelayMs: 1000, sleep: async (ms) => { slept.push(ms) } },
      ),
    ).rejects.toThrow()
    expect(slept).toEqual([1000, 2000])
  })

  test('after the last attempt the original failure reaches the caller', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw telegramError(504, 'Gateway Timeout')
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow('Gateway Timeout')
    expect(calls).toBe(3)
  })

  test('a permanent failure is raised at once, without a second call', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw telegramError(403, 'bot was blocked by the user')
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('bot was blocked')
    expect(calls).toBe(1)
  })

  test('three attempts is the default: one try and two retries', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error('fetch failed')
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('fetch failed')
    expect(calls).toBe(3)
  })
})
