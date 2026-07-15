import {
  track,
  type ClientErrorCode,
  type ClientErrorProperties,
  type ClientErrorSurface,
  type ClientRuntimeErrorCode,
} from './telemetry'

export interface ClientErrorInput {
  readonly code: ClientErrorCode
  readonly surface?: ClientErrorSurface
  /** Used only for in-memory identity deduplication; it is never serialized. */
  readonly cause?: unknown
}

export interface ClientRuntimeErrorInput extends Omit<ClientErrorInput, 'code'> {
  readonly code: ClientRuntimeErrorCode
}

export type ClientErrorTransport = (properties: ClientErrorProperties) => void

type RuntimeErrorTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

export interface ClientRuntimeErrorReporter {
  report(input: ClientErrorInput): boolean
  captureWindowError(event: Pick<ErrorEvent, 'error'>): boolean
  captureUnhandledRejection(event: Pick<PromiseRejectionEvent, 'reason'>): boolean
  setTransport(transport: ClientErrorTransport): () => void
  install(target?: RuntimeErrorTarget | null): () => void
}

interface ReporterOptions {
  readonly emitLocal?: ClientErrorTransport
  readonly resolveSurface?: () => ClientErrorSurface
}

interface InstalledListeners {
  references: number
  readonly onError: EventListener
  readonly onUnhandledRejection: EventListener
}

export function clientErrorSurface(pathname = typeof window === 'undefined'
  ? '/'
  : window.location.pathname): ClientErrorSurface {
  if (pathname.startsWith('/replay/')) return 'replay'
  if (pathname.startsWith('/leaderboard')) return 'leaderboard'
  if (pathname.startsWith('/session')) return 'session'
  return 'arena'
}

function identity(value: unknown, fallback: object): object {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    return value as object
  }
  return fallback
}

/**
 * Creates a privacy-bounded reporter. Error objects are retained only in a
 * WeakSet so React and Window reporting the same failure cannot double count.
 */
export function createClientRuntimeErrorReporter(
  options: ReporterOptions = {},
): ClientRuntimeErrorReporter {
  const emitted = options.emitLocal ?? ((properties) => {
    track('client_error', { code: properties.code, surface: properties.surface })
  })
  const resolveSurface = options.resolveSurface ?? clientErrorSurface
  const seen = new WeakSet<object>()
  const installations = new WeakMap<RuntimeErrorTarget, InstalledListeners>()
  let transport: ClientErrorTransport | null = null
  let reporting = false

  const report = (input: ClientRuntimeErrorInput): boolean => {
    if (reporting) return false
    const seenIdentity = (typeof input.cause === 'object' && input.cause !== null)
      || typeof input.cause === 'function'
      ? input.cause as object
      : null
    if (seenIdentity && seen.has(seenIdentity)) return false
    if (seenIdentity) seen.add(seenIdentity)

    const properties: ClientErrorProperties = Object.freeze({
      code: input.code,
      surface: input.surface ?? resolveSurface(),
    })
    reporting = true
    try {
      try {
        emitted(properties)
      } catch {
        // Error reporting must never become another application failure.
      }
      try {
        transport?.(properties)
      } catch {
        // The shared transport is best-effort and has no implicit retry.
      }
    } finally {
      reporting = false
    }
    return true
  }

  const captureWindowError = (event: Pick<ErrorEvent, 'error'>): boolean => report({
    code: 'uncaught_exception',
    cause: identity(event.error, event as object),
  })

  const captureUnhandledRejection = (
    event: Pick<PromiseRejectionEvent, 'reason'>,
  ): boolean => report({
    code: 'unhandled_rejection',
    cause: identity(event.reason, event as object),
  })

  const setTransport = (next: ClientErrorTransport): (() => void) => {
    transport = next
    return () => {
      if (transport === next) transport = null
    }
  }

  const install = (target: RuntimeErrorTarget | null = typeof window === 'undefined'
    ? null
    : window): (() => void) => {
    if (!target) return () => undefined
    const existing = installations.get(target)
    if (existing) {
      existing.references += 1
    } else {
      const onError: EventListener = (event) => {
        captureWindowError(event as ErrorEvent)
      }
      const onUnhandledRejection: EventListener = (event) => {
        captureUnhandledRejection(event as PromiseRejectionEvent)
      }
      installations.set(target, { references: 1, onError, onUnhandledRejection })
      target.addEventListener('error', onError)
      target.addEventListener('unhandledrejection', onUnhandledRejection)
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const current = installations.get(target)
      if (!current) return
      current.references -= 1
      if (current.references > 0) return
      target.removeEventListener('error', current.onError)
      target.removeEventListener('unhandledrejection', current.onUnhandledRejection)
      installations.delete(target)
    }
  }

  return {
    report,
    captureWindowError,
    captureUnhandledRejection,
    setTransport,
    install,
  }
}

const reporter = createClientRuntimeErrorReporter()

export function reportClientRuntimeError(input: ClientRuntimeErrorInput): boolean {
  return reporter.report(input)
}

/** Reports an expected operational failure through the same bounded transport. */
export function reportClientError(input: ClientErrorInput): boolean {
  return reporter.report(input)
}

export function setClientErrorTransport(transport: ClientErrorTransport): () => void {
  return reporter.setTransport(transport)
}

export function installGlobalClientErrorTelemetry(
  target?: RuntimeErrorTarget | null,
): () => void {
  return reporter.install(target)
}
