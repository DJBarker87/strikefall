import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlphaApiError,
  createAlphaApiClient,
  createBearerFetch,
  type AlphaApiClient,
} from './client'
import { clearAlphaToken, readAlphaToken, writeAlphaToken } from './storage'
import type { AlphaSessionView } from './types'

export type ClosedAlphaSessionStatus =
  | 'disabled'
  | 'loading'
  | 'invite_required'
  | 'ready'
  | 'offline'
  | 'error'

export interface ClosedAlphaSessionState {
  status: ClosedAlphaSessionStatus
  session: AlphaSessionView | null
  message: string | null
}

export interface ClosedAlphaController extends ClosedAlphaSessionState {
  baseUrl: string | null
  token: string | null
  api: AlphaApiClient | null
  authorizedFetch: typeof globalThis.fetch | null
  join(inviteCode: string, telemetryConsent: boolean): Promise<boolean>
  rename(handle: string): Promise<boolean>
  setTelemetryConsent(consent: boolean): Promise<boolean>
  rotate(): Promise<boolean>
  clear(): void
  retry(): Promise<void>
}

export interface UseClosedAlphaSessionOptions {
  baseUrl: string | null
  telemetryConsent: boolean
}

function safeMessage(error: unknown): string {
  if (error instanceof AlphaApiError) {
    if (error.status === 401) return 'Your anonymous alpha session expired.'
    if (error.status === 403) return 'A valid closed-alpha invite is required.'
    if (error.status === 409) return 'That callsign is already in use.'
    if (error.status === 429) return 'Too many requests. Wait a moment and try again.'
  }
  return error instanceof TypeError
    ? 'The ranked service could not be reached.'
    : 'The alpha request could not be completed.'
}

export function useClosedAlphaSession(
  options: UseClosedAlphaSessionOptions,
): ClosedAlphaController {
  const [token, setToken] = useState<string | null>(() => readAlphaToken())
  const tokenRef = useRef(token)
  const bootstrappingRef = useRef(false)
  tokenRef.current = token
  const [state, setState] = useState<ClosedAlphaSessionState>(() => ({
    status: options.baseUrl ? 'loading' : 'disabled',
    session: null,
    message: null,
  }))

  const api = useMemo(() => options.baseUrl
    ? createAlphaApiClient({ baseUrl: options.baseUrl, token: () => tokenRef.current })
    : null, [options.baseUrl])

  const authorizedFetch = useMemo(() => api
    ? createBearerFetch(() => tokenRef.current)
    : null, [api])

  const acceptIssued = useCallback((issued: Awaited<ReturnType<AlphaApiClient['issueSession']>>) => {
    writeAlphaToken(issued.token)
    tokenRef.current = issued.token
    setToken(issued.token)
    setState({ status: 'ready', session: issued.session, message: null })
  }, [])

  const bootstrap = useCallback(async () => {
    if (bootstrappingRef.current) return
    bootstrappingRef.current = true
    try {
    if (!api || !options.baseUrl) {
      setState({ status: 'disabled', session: null, message: null })
      return
    }
    setState((current) => ({ ...current, status: 'loading', message: null }))
    if (tokenRef.current) {
      try {
        const session = await api.session()
        setState({ status: 'ready', session, message: null })
        return
      } catch (error) {
        if (!(error instanceof AlphaApiError) || error.status !== 401) {
          setState({ status: 'offline', session: null, message: safeMessage(error) })
          return
        }
        clearAlphaToken()
        tokenRef.current = null
        setToken(null)
      }
    }
    try {
      const issued = await api.issueSession({
        inviteCode: null,
        handle: null,
        telemetryConsent: options.telemetryConsent,
      })
      acceptIssued(issued)
    } catch (error) {
      if (error instanceof AlphaApiError && error.status === 403) {
        setState({ status: 'invite_required', session: null, message: safeMessage(error) })
      } else {
        setState({ status: 'offline', session: null, message: safeMessage(error) })
      }
    }
    } finally {
      bootstrappingRef.current = false
    }
  }, [acceptIssued, api, options.baseUrl, options.telemetryConsent])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const join = useCallback(async (inviteCode: string, telemetryConsent: boolean) => {
    if (!api) return false
    const cleaned = inviteCode.trim()
    if (cleaned.length < 8 || /\s/.test(cleaned)) {
      setState((current) => ({
        ...current,
        status: 'invite_required',
        message: 'Invite codes are at least eight characters with no spaces.',
      }))
      return false
    }
    setState((current) => ({ ...current, status: 'loading', message: null }))
    try {
      acceptIssued(await api.issueSession({
        inviteCode: cleaned,
        handle: null,
        telemetryConsent,
      }))
      return true
    } catch (error) {
      setState({ status: 'invite_required', session: null, message: safeMessage(error) })
      return false
    }
  }, [acceptIssued, api])

  const rename = useCallback(async (handle: string) => {
    if (!api || state.status !== 'ready') return false
    try {
      const session = await api.rename(handle)
      setState({ status: 'ready', session, message: null })
      return true
    } catch (error) {
      setState((current) => ({ ...current, message: safeMessage(error) }))
      return false
    }
  }, [api, state.status])

  const setTelemetryConsent = useCallback(async (consent: boolean) => {
    if (!api || state.status !== 'ready') return false
    try {
      const session = await api.setTelemetryConsent(consent)
      setState({ status: 'ready', session, message: null })
      return true
    } catch (error) {
      setState((current) => ({ ...current, message: safeMessage(error) }))
      return false
    }
  }, [api, state.status])

  const rotate = useCallback(async () => {
    if (!api || state.status !== 'ready') return false
    try {
      const issued = await api.rotate()
      acceptIssued(issued)
      return true
    } catch (error) {
      setState((current) => ({ ...current, message: safeMessage(error) }))
      return false
    }
  }, [acceptIssued, api, state.status])

  useEffect(() => {
    if (state.status !== 'ready' || !state.session) return
    const rotateBeforeMs = 6 * 60 * 60 * 1_000
    const delay = Math.max(60_000, state.session.expiresAtMs - Date.now() - rotateBeforeMs)
    const timer = window.setTimeout(() => void rotate(), Math.min(delay, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [rotate, state.session, state.status])

  const clear = useCallback(() => {
    clearAlphaToken()
    tokenRef.current = null
    setToken(null)
    setState({
      status: options.baseUrl ? 'invite_required' : 'disabled',
      session: null,
      message: options.baseUrl ? 'Anonymous alpha session cleared.' : null,
    })
  }, [options.baseUrl])

  return {
    ...state,
    baseUrl: options.baseUrl,
    token,
    api,
    authorizedFetch,
    join,
    rename,
    setTelemetryConsent,
    rotate,
    clear,
    retry: bootstrap,
  }
}
