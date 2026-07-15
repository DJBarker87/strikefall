export const PRACTICE_NETWORK_ONLY_PATHS = ['/api', '/ranked', '/replay'] as const

export function isPracticeNetworkOnlyPath(pathname: string): boolean {
  return PRACTICE_NETWORK_ONLY_PATHS.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))
}

export interface PracticeCacheRequest {
  method: string
  requestUrl: string
  scopeOrigin: string
  hasAuthorization?: boolean
}

/** Mirrors the generated worker's outer safety gate for focused unit tests. */
export function shouldPracticeWorkerHandle(request: PracticeCacheRequest): boolean {
  if (request.method !== 'GET' || request.hasAuthorization) return false
  const scopeOrigin = request.scopeOrigin.replace(/\/+$/, '')
  let pathname: string
  if (request.requestUrl.startsWith('/')) {
    pathname = request.requestUrl
  } else if (request.requestUrl === scopeOrigin) {
    pathname = '/'
  } else if (request.requestUrl.startsWith(`${scopeOrigin}/`)) {
    pathname = request.requestUrl.slice(scopeOrigin.length)
  } else {
    return false
  }
  pathname = pathname.split(/[?#]/, 1)[0] || '/'
  return !isPracticeNetworkOnlyPath(pathname)
}
