import { useSyncExternalStore } from 'react'

export type PracticeWorkerPhase =
  | 'idle'
  | 'disabled'
  | 'installing'
  | 'ready'
  | 'unsupported'
  | 'error'

export interface PracticeAvailability {
  phase: PracticeWorkerPhase
  online: boolean
}

type Listener = () => void

const listeners = new Set<Listener>()
let monitoringConnectivity = false
let snapshot: PracticeAvailability = {
  phase: 'idle',
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
}

export function getPracticeAvailability(): PracticeAvailability {
  return snapshot
}

export function subscribePracticeAvailability(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updatePracticeAvailability(next: Partial<PracticeAvailability>): void {
  const updated = { ...snapshot, ...next }
  if (updated.phase === snapshot.phase && updated.online === snapshot.online) return
  snapshot = updated
  listeners.forEach((listener) => listener())
}

export function monitorPracticeConnectivity(): void {
  if (monitoringConnectivity || typeof window === 'undefined') return
  monitoringConnectivity = true
  const update = () => updatePracticeAvailability({ online: navigator.onLine })
  window.addEventListener('online', update)
  window.addEventListener('offline', update)
  update()
}

export function usePracticeAvailability(): PracticeAvailability {
  return useSyncExternalStore(
    subscribePracticeAvailability,
    getPracticeAvailability,
    getPracticeAvailability,
  )
}

export function canOpenRanked(baseUrl: string | null, online: boolean): boolean {
  return Boolean(baseUrl) && online
}

/** Public builds lead with the verified service whenever it is configured and
 * reachable. Installed/offline and endpoint-free builds lead with Practice. */
export function defaultPlayMode(baseUrl: string | null, online: boolean): 'ranked' | 'practice' {
  return canOpenRanked(baseUrl, online) ? 'ranked' : 'practice'
}
