export type RankedClientErrorCode =
  | 'aborted'
  | 'authentication_unavailable'
  | 'http_error'
  | 'malformed_response'
  | 'network_error'
  | 'protocol_mismatch'
  | 'ranked_submission_disabled'
  | 'stream_gap'
  | 'stream_malformed'
  | 'timeout'
  | 'unsupported_protocol'
  | 'verification_failed'
  | 'verification_unavailable'

export class RankedClientError extends Error {
  readonly code: RankedClientErrorCode

  constructor(code: RankedClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RankedClientError'
    this.code = code
  }
}

export class RankedHttpError extends RankedClientError {
  readonly status: number
  readonly apiCode: string | null
  readonly retryAfterMs: number | null

  constructor(options: {
    status: number
    message: string
    apiCode?: string | null
    retryAfterMs?: number | null
    cause?: unknown
  }) {
    super('http_error', options.message, { cause: options.cause })
    this.name = 'RankedHttpError'
    this.status = options.status
    this.apiCode = options.apiCode ?? null
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

export class RankedPayloadError extends RankedClientError {
  readonly path: string

  constructor(path: string, expectation: string, options?: ErrorOptions) {
    super(
      'malformed_response',
      `Malformed ranked payload at ${path}: expected ${expectation}`,
      options,
    )
    this.name = 'RankedPayloadError'
    this.path = path
  }
}

export class UnsupportedRankedProtocolError extends RankedClientError {
  readonly protocolVersion: string

  constructor(protocolVersion: string) {
    super('unsupported_protocol', `Unsupported ranked protocol: ${protocolVersion}`)
    this.name = 'UnsupportedRankedProtocolError'
    this.protocolVersion = protocolVersion
  }
}

export class RankedSubmissionDisabledError extends RankedClientError {
  constructor(message = 'This round is local practice; ranked submissions are disabled.') {
    super('ranked_submission_disabled', message)
    this.name = 'RankedSubmissionDisabledError'
  }
}

export class RankedReplayVerificationError extends RankedClientError {
  readonly check: string

  constructor(
    code: 'verification_failed' | 'verification_unavailable',
    check: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options)
    this.name = 'RankedReplayVerificationError'
    this.check = check
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
