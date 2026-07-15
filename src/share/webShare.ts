import { shareCaption, shareFilename } from './artifact'
import type { ShareCardData } from './types'

export interface WebShareEnvironment {
  createFile?: (parts: readonly BlobPart[], name: string, options: FilePropertyBag) => File
  canShare?: (data: ShareData) => boolean
  share?: (data: ShareData) => Promise<void>
}

export interface StrikefallShareOptions {
  /** A validated, tokenless public replay URL created by the replay boundary. */
  publicReplayUrl?: string
}

export type ShareFileResult =
  | { status: 'ready'; file: File }
  | { status: 'unsupported'; reason: 'file-api-unavailable' }
  | { status: 'error'; error: Error }

export type WebShareResult =
  | { status: 'shared' }
  | { status: 'cancelled' }
  | {
      status: 'unsupported'
      reason: 'web-share-unavailable' | 'file-sharing-unavailable'
      fallback: 'download'
    }
  | { status: 'error'; error: Error; fallback: 'download' }

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function defaultEnvironment(): WebShareEnvironment {
  const FileConstructor = globalThis.File
  const navigatorApi = typeof navigator === 'undefined' ? undefined : navigator
  return {
    createFile: FileConstructor
      ? (parts, name, options) => new FileConstructor([...parts], name, options)
      : undefined,
    canShare: navigatorApi?.canShare?.bind(navigatorApi),
    share: navigatorApi?.share?.bind(navigatorApi),
  }
}

export function createShareFile(
  blob: Blob,
  data: ShareCardData,
  environment: WebShareEnvironment = defaultEnvironment(),
): ShareFileResult {
  if (!environment.createFile) return { status: 'unsupported', reason: 'file-api-unavailable' }
  try {
    const extension = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'png'
    return {
      status: 'ready',
      file: environment.createFile([blob], shareFilename(data, extension), {
        type: blob.type || (extension === 'png' ? 'image/png' : `video/${extension}`),
        lastModified: 0,
      }),
    }
  } catch (error) {
    return { status: 'error', error: errorOf(error) }
  }
}

export async function shareStrikefallFile(
  file: File,
  data: ShareCardData,
  environment: WebShareEnvironment = defaultEnvironment(),
  options: StrikefallShareOptions = {},
): Promise<WebShareResult> {
  if (!environment.share) {
    return { status: 'unsupported', reason: 'web-share-unavailable', fallback: 'download' }
  }
  const payload: ShareData = {
    title: 'Strikefall result',
    text: shareCaption(data),
    files: [file],
    ...(options.publicReplayUrl ? { url: options.publicReplayUrl } : {}),
  }
  try {
    if (!environment.canShare || !environment.canShare(payload)) {
      return { status: 'unsupported', reason: 'file-sharing-unavailable', fallback: 'download' }
    }
    await environment.share(payload)
    return { status: 'shared' }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { status: 'cancelled' }
    if (error instanceof Error && error.name === 'AbortError') return { status: 'cancelled' }
    return { status: 'error', error: errorOf(error), fallback: 'download' }
  }
}

export async function createAndShareStrikefallFile(
  blob: Blob,
  data: ShareCardData,
  environment: WebShareEnvironment = defaultEnvironment(),
  options: StrikefallShareOptions = {},
): Promise<ShareFileResult | WebShareResult> {
  const prepared = createShareFile(blob, data, environment)
  if (prepared.status !== 'ready') return prepared
  return shareStrikefallFile(prepared.file, data, environment, options)
}
