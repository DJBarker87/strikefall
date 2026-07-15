import { Pause, Play, RotateCcw, X } from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from 'react'
import type { Contender, ContenderOutcome, FeedEvent, ReplayBundle } from '../game'
import './localReplay.css'

const REPLAY_DURATION_MS = 60_000
const CHART_WIDTH = 1_000
const CHART_HEIGHT = 320
const CHART_GUTTER = 24

export interface LocalReplayTimelineEvent {
  id: string
  at: number
  type: FeedEvent['type']
  title: string
  detail: string
  contenderIds: string[]
}

export interface LocalReplayContenderFrame {
  id: string
  name: string
  persona: Contender['persona']
  isPlayer: boolean
  color: string
  outcome: ContenderOutcome
}

export interface LocalReplayFrame {
  progress: number
  elapsedSeconds: number
  frameIndex: number
  lineValue: number
  active: number
  struck: number
  escaped: number
  survived: number
  contenders: LocalReplayContenderFrame[]
  currentEvent: LocalReplayTimelineEvent | null
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.max(0, Math.min(1, progress))
}

export function localReplayTimeline(replay: ReplayBundle): LocalReplayTimelineEvent[] {
  return replay.result.feed
    .filter((event) => ['hit', 'cluster', 'escape', 'survivor'].includes(event.type))
    .map((event) => ({
      id: event.id,
      at: clampProgress(event.at),
      type: event.type,
      title: event.title,
      detail: event.detail,
      contenderIds: [...event.contenderIds],
    }))
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
}

function outcomeAt(contender: Contender, progress: number): ContenderOutcome {
  if (contender.outcome === 'hit') {
    return contender.hitAt !== null && contender.hitAt <= progress ? 'hit' : 'active'
  }
  if (contender.outcome === 'escaped') {
    return contender.escape && contender.escape.at <= progress ? 'escaped' : 'active'
  }
  if (contender.outcome === 'survived') return progress >= 1 ? 'survived' : 'active'
  return contender.outcome
}

export function deriveLocalReplayFrame(
  replay: ReplayBundle,
  requestedProgress: number,
): LocalReplayFrame {
  const progress = clampProgress(requestedProgress)
  const frameIndex = Math.floor(
    progress * Math.max(0, replay.path.battlePath.length - 1),
  )
  const contenders = replay.result.contenders.map((contender) => ({
    id: contender.id,
    name: contender.name,
    persona: contender.persona,
    isPlayer: contender.isPlayer,
    color: contender.color,
    outcome: outcomeAt(contender, progress),
  }))
  const timeline = localReplayTimeline(replay)
  const currentEvent = [...timeline].reverse().find((event) => event.at <= progress) ?? null
  return {
    progress,
    elapsedSeconds: progress * 60,
    frameIndex,
    lineValue: replay.path.battlePath[frameIndex] ?? replay.result.lineValue,
    active: contenders.filter((contender) => contender.outcome === 'active').length,
    struck: contenders.filter((contender) => contender.outcome === 'hit').length,
    escaped: contenders.filter((contender) => contender.outcome === 'escaped').length,
    survived: contenders.filter((contender) => contender.outcome === 'survived').length,
    contenders,
    currentEvent,
  }
}

function formatReplayTime(progress: number): string {
  const seconds = Math.round(clampProgress(progress) * 60)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

interface ReplayChart {
  allPoints: string
  wicks: Array<{ x: number; highY: number; lowY: number }>
  yFor: (value: number) => number
}

function replayChart(replay: ReplayBundle): ReplayChart {
  const path = replay.path.battlePath
  const barriers = replay.lockedContenders.map((contender) => contender.barrier)
  const values = [
    ...path,
    ...replay.path.battleExtrema.flatMap((extrema) => [extrema.high, extrema.low]),
    ...barriers,
  ]
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = Math.max(maximum - minimum, 0.001)
  const low = minimum - range * 0.08
  const high = maximum + range * 0.08
  const usableHeight = CHART_HEIGHT - CHART_GUTTER * 2
  const yFor = (value: number) => (
    CHART_GUTTER + ((high - value) / (high - low)) * usableHeight
  )
  const allPoints = path.map((value, index) => {
    const x = CHART_GUTTER + (index / Math.max(1, path.length - 1)) * (
      CHART_WIDTH - CHART_GUTTER * 2
    )
    return `${x.toFixed(2)},${yFor(value).toFixed(2)}`
  }).join(' ')
  const wicks = replay.path.battleExtrema.map((extrema, index) => ({
    x: CHART_GUTTER + (index / Math.max(1, path.length - 1)) * (
      CHART_WIDTH - CHART_GUTTER * 2
    ),
    highY: yFor(extrema.high),
    lowY: yFor(extrema.low),
  }))
  return { allPoints, wicks, yFor }
}

function outcomeLabel(outcome: ContenderOutcome): string {
  if (outcome === 'hit') return 'struck'
  if (outcome === 'escaped') return 'escaped'
  if (outcome === 'survived') return 'held'
  return 'live'
}

export interface LocalReplayViewerProps {
  replay: ReplayBundle
  onClose?: () => void
}

export function LocalReplayViewer({ replay, onClose }: LocalReplayViewerProps) {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timeline = useMemo(() => localReplayTimeline(replay), [replay])
  const chart = useMemo(() => replayChart(replay), [replay])
  const frame = useMemo(
    () => deriveLocalReplayFrame(replay, progress),
    [progress, replay],
  )
  const chartId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const player = replay.lockedContenders.find((contender) => contender.isPlayer)
  const playedPointCount = Math.max(1, frame.frameIndex + 1)
  const playedPoints = chart.allPoints.split(' ').slice(0, playedPointCount).join(' ')
  const currentX = CHART_GUTTER + frame.progress * (CHART_WIDTH - CHART_GUTTER * 2)
  const chartStyle = {
    '--replay-progress': `${frame.progress * 100}%`,
  } as CSSProperties

  useEffect(() => {
    if (!playing) return
    const startedAt = performance.now()
    const startedProgress = progress
    let animationFrame = 0
    const animate = (now: number) => {
      const next = Math.min(
        1,
        startedProgress + (now - startedAt) / REPLAY_DURATION_MS,
      )
      setProgress(next)
      if (next >= 1) {
        setPlaying(false)
        return
      }
      animationFrame = window.requestAnimationFrame(animate)
    }
    animationFrame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [playing])

  const togglePlaying = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (progress >= 1) setProgress(0)
    setPlaying(true)
  }

  const jumpTo = (nextProgress: number) => {
    setPlaying(false)
    setProgress(clampProgress(nextProgress))
  }

  return (
    <section className="local-replay" aria-label="Local round replay">
      <header className="local-replay__header">
        <div>
          <span className="local-replay__eyebrow">Verified local proof</span>
          <h2>Replay the strike</h2>
          <p>
            {replay.deck.name} · deck v{replay.deck.version} · {replay.botProfiles.length} bots · proof {replay.commitment.value.slice(0, 12)}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            className="local-replay__close"
            aria-label="Close local replay"
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div className="local-replay__scoreboard" role="group" aria-label="Replay status">
        <div>
          <span>Clock</span>
          <strong>{formatReplayTime(frame.progress)}</strong>
        </div>
        <div>
          <span>Live</span>
          <strong>{frame.active}</strong>
        </div>
        <div>
          <span>Struck</span>
          <strong>{frame.struck}</strong>
        </div>
        <div>
          <span>Out safe</span>
          <strong>{frame.escaped + frame.survived}</strong>
        </div>
      </div>

      <div className="local-replay__chart" style={chartStyle}>
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={`Battle path at ${formatReplayTime(frame.progress)}. ${frame.active} flags still live.`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={`local-replay-glow-${chartId}`} x1="0" x2="1">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0.9" />
            </linearGradient>
          </defs>
          <g className="local-replay__grid" aria-hidden="true">
            <line x1="24" x2="976" y1="80" y2="80" />
            <line x1="24" x2="976" y1="160" y2="160" />
            <line x1="24" x2="976" y1="240" y2="240" />
          </g>
          {player ? (
            <line
              className="local-replay__player-barrier"
              x1="24"
              x2="976"
              y1={chart.yFor(player.barrier)}
              y2={chart.yFor(player.barrier)}
            />
          ) : null}
          <g className="local-replay__wicks" aria-hidden="true">
            {chart.wicks.map((wick, index) => (
              <line
                key={index}
                x1={wick.x}
                x2={wick.x}
                y1={wick.highY}
                y2={wick.lowY}
                opacity={index <= frame.frameIndex ? 0.42 : 0.1}
              />
            ))}
          </g>
          <polyline className="local-replay__path local-replay__path--future" points={chart.allPoints} />
          <polyline
            className="local-replay__path local-replay__path--played"
            points={playedPoints}
            stroke={`url(#local-replay-glow-${chartId})`}
          />
          {timeline.filter((event) => event.type === 'hit' || event.type === 'cluster').map((event) => {
            const pathIndex = Math.floor(event.at * Math.max(0, replay.path.battlePath.length - 1))
            const lineValue = replay.path.battlePath[pathIndex] ?? replay.result.lineValue
            const eventX = CHART_GUTTER + event.at * (CHART_WIDTH - CHART_GUTTER * 2)
            return (
              <circle
                key={event.id}
                className={`local-replay__strike${event.at <= frame.progress ? ' local-replay__strike--revealed' : ''}`}
                cx={eventX}
                cy={chart.yFor(lineValue)}
                r={event.type === 'cluster' ? 8 : 4}
              />
            )
          })}
          <line className="local-replay__cursor" x1={currentX} x2={currentX} y1="18" y2="302" />
          <circle
            className="local-replay__cursor-dot"
            cx={currentX}
            cy={chart.yFor(frame.lineValue)}
            r="7"
          />
        </svg>
        <div className="local-replay__now">
          <span>Now</span>
          <strong>{frame.lineValue.toFixed(2)}</strong>
          <small>{frame.currentEvent?.title ?? 'Line entering the arena'}</small>
        </div>
      </div>

      <div className="local-replay__controls">
        <button type="button" className="local-replay__play" onClick={togglePlaying}>
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          {playing ? 'Pause replay' : progress >= 1 ? 'Replay again' : 'Play replay'}
        </button>
        <button
          type="button"
          className="local-replay__restart"
          aria-label="Restart replay"
          onClick={() => jumpTo(0)}
        >
          <RotateCcw size={18} aria-hidden="true" />
        </button>
        <label className="local-replay__scrubber">
          <span className="sr-only">Replay timeline</span>
          <input
            type="range"
            min="0"
            max="1000"
            step="1"
            value={Math.round(frame.progress * 1_000)}
            aria-label="Replay timeline"
            aria-valuetext={`${formatReplayTime(frame.progress)}, ${frame.active} flags live`}
            onChange={(event) => jumpTo(Number(event.currentTarget.value) / 1_000)}
          />
        </label>
        <output>{formatReplayTime(frame.progress)} / 1:00</output>
      </div>

      <div className="local-replay__body">
        <section className="local-replay__roster" aria-labelledby="local-replay-roster-title">
          <div className="local-replay__section-heading">
            <span>At the cursor</span>
            <h3 id="local-replay-roster-title">Flag board</h3>
          </div>
          <ol tabIndex={0} aria-label="Replay flag board; scroll for all contenders">
            {frame.contenders.map((contender) => (
              <li
                key={contender.id}
                className={`local-replay__contender local-replay__contender--${contender.outcome}${contender.isPlayer ? ' local-replay__contender--player' : ''}`}
                style={{ '--replay-flag-color': contender.color } as CSSProperties}
              >
                <span aria-hidden="true" />
                <strong>{contender.name}</strong>
                <small>{contender.isPlayer ? 'Player' : `${contender.persona} · BOT`}</small>
                <em>{outcomeLabel(contender.outcome)}</em>
              </li>
            ))}
          </ol>
        </section>

        <section className="local-replay__timeline" aria-labelledby="local-replay-events-title">
          <div className="local-replay__section-heading">
            <span>Jump to impact</span>
            <h3 id="local-replay-events-title">Strike timeline</h3>
          </div>
          {timeline.length > 0 ? (
            <ol>
              {timeline.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    aria-current={event.id === frame.currentEvent?.id ? 'true' : undefined}
                    onClick={() => jumpTo(event.at)}
                  >
                    <time>{formatReplayTime(event.at)}</time>
                    <span>
                      <strong>{event.title}</strong>
                      <small>{event.detail}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="local-replay__empty">No strikes recorded. Scrub the untouched line above.</p>
          )}
        </section>
      </div>
    </section>
  )
}
