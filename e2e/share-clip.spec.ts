import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

import {
  advance,
  artifactPath,
  installDeterministicBrowser,
  PHASE_MS,
  reachBattle,
  reachPlacement,
} from './helpers'

interface VideoMetadata {
  duration: number
  height: number
  width: number
}

interface BrowserClipEvidence extends VideoMetadata {
  alignment: {
    eventOffsetMs: number
    eventProgress: number
    momentKey: string
  }
  base64: string
  mimeType: string
  reportedDurationMs: number
}

async function videoMetadata(page: Page, path: string, mimeType: string) {
  const clipBytes = readFileSync(path)
  expect(clipBytes.byteLength).toBeGreaterThan(1_000)
  return page.evaluate(async ({ base64, type }) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    const video = document.createElement('video')
    video.preload = 'metadata'
    try {
      return await new Promise<VideoMetadata>((resolve, reject) => {
        video.onloadedmetadata = () => resolve({
          duration: video.duration,
          height: video.videoHeight,
          width: video.videoWidth,
        })
        video.onerror = () => reject(
          new Error(video.error?.message ?? 'Clip metadata could not be decoded.'),
        )
        video.src = url
      })
    } finally {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
  }, { base64: clipBytes.toString('base64'), type: mimeType })
}

test('real-time Chromium compositor exports the authoritative held-near-miss step in every format', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-1280',
    'One real Chromium encoder signal covers the three fixed compositor surfaces.',
  )
  test.setTimeout(45_000)
  await page.goto('/__strikefall_clip_harness__')

  const evidence = await page.evaluate(async () => {
    const { CompositedShareRecorder } = await import('/src/share/compositedRecorder.ts')
    const source = document.createElement('canvas')
    source.width = 640
    source.height = 360
    document.body.append(source)
    const context = source.getContext('2d')
    let frame = 0
    const draw = () => {
      if (!context) return
      frame += 1
      context.fillStyle = frame % 2 === 0 ? '#10221e' : '#06100e'
      context.fillRect(0, 0, source.width, source.height)
      context.fillStyle = '#c7f36b'
      context.fillRect((frame * 7) % 560, 120, 80, 80)
      context.fillStyle = '#f1f7ee'
      context.font = '700 28px sans-serif'
      context.fillText(`FRAME ${frame}`, 24, 48)
    }
    draw()
    const animation = window.setInterval(draw, 50)
    const recorder = new CompositedShareRecorder(source, {
      brand: 'STRIKEFALL',
      deckName: 'Pulse',
      deckKicker: 'Double pressure',
      deckHue: 315,
      botCount: 19,
      multiplier: 4.25,
      outcome: 'survived',
      headline: 'THE LINE MISSED BY A BREATH.',
      kicker: 'NEAR MISS',
      detail: 'The exact closest-approach step stayed in frame.',
      accent: 'primary',
      stats: [
        { label: 'RANK', value: '#1' },
        { label: 'SCORE', value: '850' },
        { label: 'RISK', value: '4.25×' },
        { label: 'FIELD', value: '1 HELD' },
      ],
      chart: {
        points: [0.4, 0.7, 0.2, 0.8],
        flag: 0.82,
        final: 0.7,
        side: 'upper',
      },
      momentKind: 'near-miss',
    }, { frameRate: 15 })

    try {
      const started = recorder.start()
      if (Object.values(started).some((entry) => entry.status !== 'recording')) {
        throw new Error(`Chromium compositor did not start: ${JSON.stringify(started)}`)
      }
      await new Promise((resolve) => window.setTimeout(resolve, 4_000))
      const supersededKey = 'near-miss:held:16'
      const supersededPromise = recorder.retainLatestMoment('held-near-miss', supersededKey, {
        occurredAtMs: performance.now(),
        tailMs: 700,
        priority: 84,
      })
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      const momentKey = 'near-miss:held:18'
      const retained = await recorder.retainLatestMoment('held-near-miss', momentKey, {
        occurredAtMs: performance.now(),
        tailMs: 700,
        priority: 94,
      })
      if (Object.values(retained).some((entry) => entry.status !== 'ready')) {
        throw new Error(`Chromium compositor did not retain every format: ${JSON.stringify(retained)}`)
      }
      const superseded = await supersededPromise
      if (Object.values(superseded).some(
        (entry) => entry.status !== 'fallback' || entry.reason !== 'moment-not-retained',
      )) {
        throw new Error(`Superseded near-miss frame was not released: ${JSON.stringify(superseded)}`)
      }
      await recorder.freeze(0)

      const results: Record<string, BrowserClipEvidence> = {}
      for (const format of [
        'portrait-9x16',
        'square-1x1',
        'landscape-16x9',
      ] as const) {
        const clip = await recorder.captureRetainedMoment(format, momentKey)
        if (clip.status !== 'ready' || !clip.alignment) {
          throw new Error(`Missing retained ${format} clip: ${JSON.stringify(clip)}`)
        }
        const bytes = new Uint8Array(await clip.blob.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
        }
        results[format] = {
          alignment: clip.alignment,
          base64: btoa(binary),
          duration: clip.durationMs / 1_000,
          height: clip.height,
          mimeType: clip.mimeType,
          reportedDurationMs: clip.durationMs,
          width: clip.width,
        }
      }
      const unrelated = await recorder.captureRetainedMoment('square-1x1', supersededKey)
      if (unrelated.status !== 'fallback' || unrelated.reason !== 'moment-not-retained') {
        throw new Error(`Recorder substituted unrelated footage: ${JSON.stringify(unrelated)}`)
      }
      return results
    } finally {
      window.clearInterval(animation)
      recorder.dispose()
      source.remove()
    }
  })

  const expected = {
    'portrait-9x16': { width: 720, height: 1280, label: 'story' },
    'square-1x1': { width: 720, height: 720, label: 'square' },
    'landscape-16x9': { width: 1280, height: 720, label: 'wide' },
  } as const

  for (const [format, dimensions] of Object.entries(expected)) {
    const clip = evidence[format] as BrowserClipEvidence
    const extension = clip.mimeType.includes('mp4') ? 'mp4' : 'webm'
    const path = artifactPath(testInfo, `held-near-miss-${dimensions.label}.${extension}`)
    writeFileSync(path, Buffer.from(clip.base64, 'base64'))
    const intrinsic = await videoMetadata(page, path, clip.mimeType)
    expect(intrinsic.width).toBe(dimensions.width)
    expect(intrinsic.height).toBe(dimensions.height)
    expect(intrinsic.duration).toBeGreaterThanOrEqual(8)
    expect(intrinsic.duration).toBeLessThanOrEqual(12)
    expect(clip.reportedDurationMs / 1_000).toBeCloseTo(intrinsic.duration, 2)
    expect(clip.alignment.momentKey).toBe('near-miss:held:18')
    expect(clip.alignment.eventOffsetMs).toBeGreaterThanOrEqual(0)
    expect(clip.alignment.eventOffsetMs).toBeLessThanOrEqual(clip.reportedDurationMs)
  }
})

test('accelerated gameplay refuses to label a truncated recording as a clip', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1280', 'One strict fallback signal is enough.')
  await installDeterministicBrowser(page)
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined })
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: undefined })
    localStorage.setItem('strikefall.preferences.v1', JSON.stringify({
      version: 1,
      motion: 'full',
      mutedFlash: false,
      telemetry: 'local',
      breakReminderRounds: 0,
      onboardingComplete: true,
    }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Quick run' }).click()
  await reachPlacement(page)
  await reachBattle(page)
  await advance(page, 10_000)
  await page.waitForTimeout(750)
  await advance(page, PHASE_MS.battle)
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')

  await page.getByRole('button', { name: 'Share result' }).click()
  const dialog = page.getByRole('dialog', { name: 'Frame the strike' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('radio', { name: /Square/ }).check()
  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: /Share Square (clip|card)/ }).click()
  await advance(page, 750)
  await page.waitForTimeout(100)
  await advance(page, 1)
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^strikefall-[a-z0-9-]+\.png$/)

  const clipEvents = await page.evaluate(() => {
    const events = JSON.parse(
      localStorage.getItem('strikefall.prototype.telemetry.v1') ?? '[]',
    ) as Array<{ name?: string }>
    return events.filter((event) => event.name === 'clip_exported').length
  })
  expect(clipEvents).toBe(0)
})
