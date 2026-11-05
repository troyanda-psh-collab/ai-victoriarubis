// Retrying short calls that failed because the host was busy for a moment.
//
// Every agent on this machine shares one small server, and one of them edits
// video: while ffmpeg and a local speech model run, free memory drops to
// almost nothing and outbound calls start timing out. On 05.11.2026 that cost
// a finished clip (Telegram answered `504: Gateway Timeout` on sendDocument,
// twice) and a voice transcript (the file never finished downloading). Both
// calls take under a second when the machine is calm.
//
// So: transient failures are tried again after a growing pause, permanent
// ones are raised immediately. Nothing here is Telegram-specific — the Groq
// transcription path uses the same helper.

export interface RetryOptions {
  // One try plus (attempts - 1) retries.
  attempts?: number
  // The first pause; each later one doubles it.
  baseDelayMs?: number
  // Injected so tests do not actually wait.
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 1000

// Network-level failures, by the text Node and Bun put in the message. A
// socket that died says nothing about whether the request was sound, so the
// same call is worth making again.
const TRANSIENT_PATTERNS = [
  'fetch failed',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'epipe',
  'enetunreach',
  'ehostunreach',
  'eai_again',
  'socket hang up',
  'network',
  'timeout',
  'timed out',
  'aborted',
  'gateway timeout',
]

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  // grammY's GrammyError carries Telegram's own code; HttpError and fetch
  // wrappers tend to use `status`.
  const bag = err as { error_code?: unknown; status?: unknown }
  for (const value of [bag.error_code, bag.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

// A status we built into a message ourselves, as maybeTranscribeVoice does
// with `groq HTTP 503: ...`.
function statusInText(message: string): number | undefined {
  const match = /\bhttp\s+(\d{3})\b/i.exec(message)
  return match ? Number(match[1]) : undefined
}

function retriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/** True when the same call, made again in a moment, could well succeed. */
export function isTransient(err: unknown): boolean {
  const status = statusOf(err)
  if (status !== undefined) return retriableStatus(status)

  const message = err instanceof Error ? err.message : String(err ?? '')
  const lower = message.toLowerCase()

  const inText = statusInText(lower)
  if (inText !== undefined) return retriableStatus(inText)

  // A TypeError is our own bug, not the network's: repeating it only wastes
  // the operator's time.
  if (err instanceof TypeError) return false

  return TRANSIENT_PATTERNS.some((pattern) => lower.includes(pattern))
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `op`, retrying it while it fails for a transient reason.
 *
 * The caller sees exactly what it would have seen without this wrapper: the
 * value on success, or the last failure once the attempts are spent.
 */
export async function withRetry<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const sleep = options.sleep ?? wait

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await op()
    } catch (err) {
      lastError = err
      if (!isTransient(err) || attempt === attempts) break
      await sleep(baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw lastError
}
