import {
  CalendarDays,
  Check,
  FlagTriangleRight,
  LockKeyhole,
  Sparkles,
  Target,
} from 'lucide-react'
import type {
  DailyChallenge,
  DailyChallengeProgress,
  DeckMastery,
} from './progression'
import './progression.css'

export interface DailyChallengeCardProps {
  challenge: DailyChallenge
  progress: DailyChallengeProgress
  onPlay?: (challenge: DailyChallenge) => void
  starting?: boolean
  disabled?: boolean
}

export interface DailyChallengeLaunchProps extends Omit<DailyChallengeCardProps, 'onPlay'> {
  onPlay: (challenge: DailyChallenge) => void
}

export interface DeckMasteryPanelProps {
  mastery: readonly DeckMastery[]
}

export interface ProgressionPanelProps extends DailyChallengeCardProps, DeckMasteryPanelProps {}

function friendlyDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function DailyChallengeCard({
  challenge,
  progress,
  onPlay,
  starting = false,
  disabled = false,
}: DailyChallengeCardProps) {
  return (
    <section
      className={`daily-challenge daily-challenge--${challenge.deck.id}`}
      aria-labelledby="daily-challenge-title"
    >
      <header className="daily-challenge__header">
        <span className="daily-challenge__eyebrow">
          <CalendarDays size={14} aria-hidden="true" /> Daily Deck · {friendlyDate(challenge.date)}
        </span>
        <span className={progress.completed ? 'daily-challenge__status daily-challenge__status--complete' : 'daily-challenge__status'}>
          {progress.completed ? <Check size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
          {progress.completed ? 'Cleared' : 'Fresh paths'}
        </span>
      </header>

      <div className="daily-challenge__deck">
        <span className="daily-challenge__glyph" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <div>
          <h3 id="daily-challenge-title">{challenge.deck.name}</h3>
          <p>{challenge.deck.kicker}</p>
        </div>
      </div>

      <div className="daily-challenge__mission">
        <Target size={18} aria-hidden="true" />
        <span>
          <small>Today’s mission</small>
          <strong>{challenge.mission.title}</strong>
          <span>{challenge.mission.description}</span>
        </span>
      </div>

      <footer className="daily-challenge__footer">
        <p>
          {progress.completed
            ? `Mission cleared in ${progress.attempts} ${progress.attempts === 1 ? 'attempt' : 'attempts'}.`
            : progress.attempts > 0
              ? `${progress.attempts} ${progress.attempts === 1 ? 'attempt' : 'attempts'} · every run draws a new unseen line.`
              : 'Featured deck, new unseen line on every attempt.'}
        </p>
        {onPlay && (
          <button
            type="button"
            disabled={starting || disabled}
            aria-busy={starting}
            onClick={() => onPlay(challenge)}
          >
            <FlagTriangleRight size={16} aria-hidden="true" />
            {starting ? 'Seeding…' : progress.completed ? 'Run again' : 'Play Daily'}
          </button>
        )}
      </footer>
    </section>
  )
}

/** Compact home-screen entry point; the full card remains available in progression views. */
export function DailyChallengeLaunch({
  challenge,
  progress,
  onPlay,
  starting = false,
  disabled = false,
}: DailyChallengeLaunchProps) {
  return (
    <button
      className={`daily-launch daily-launch--${challenge.deck.id}`}
      type="button"
      disabled={starting || disabled}
      aria-busy={starting}
      onClick={() => onPlay(challenge)}
    >
      <span className="daily-launch__icon" aria-hidden="true">
        {progress.completed ? <Check size={17} /> : <CalendarDays size={17} />}
      </span>
      <span className="daily-launch__copy">
        <small>{progress.completed ? 'Daily cleared · run again' : 'Today’s Daily Deck'}</small>
        <strong>{challenge.deck.name}</strong>
        <span>{challenge.mission.title} · fresh unseen path</span>
      </span>
      <span className="daily-launch__action" aria-hidden="true">
        {starting ? 'Seeding…' : 'Play'} <FlagTriangleRight size={15} />
      </span>
    </button>
  )
}

function unlockedCopy(deck: DeckMastery) {
  if (deck.unlocked.length === 0) return 'No cosmetics yet'
  return deck.unlocked.map((unlock) => unlock.name).join(' · ')
}

export function DeckMasteryPanel({ mastery }: DeckMasteryPanelProps) {
  return (
    <section className="deck-mastery" aria-labelledby="deck-mastery-title">
      <header className="deck-mastery__header">
        <div>
          <span><Sparkles size={14} aria-hidden="true" /> Deck mastery</span>
          <h3 id="deck-mastery-title">Make every storm yours</h3>
        </div>
        <p>Points-only cosmetic unlocks. No purchase, boost, or tradable value.</p>
      </header>

      <div className="deck-mastery__grid">
        {mastery.map((deck) => (
          <article
            className={`mastery-card mastery-card--${deck.deck.id}`}
            key={deck.deck.id}
          >
            <header>
              <span className="mastery-card__level">LV {deck.tier.level}</span>
              <span className="mastery-card__name">
                <strong>{deck.deck.name}</strong>
                <small>{deck.tier.name}</small>
              </span>
              <strong className="mastery-card__xp">{deck.xp} XP</strong>
            </header>
            <progress
              max={1}
              value={deck.progress}
              aria-label={`${deck.deck.name} mastery progress`}
            >
              {Math.round(deck.progress * 100)}%
            </progress>
            <div className="mastery-card__stats" aria-label={`${deck.deck.name} records`}>
              <span><strong>{deck.rounds}</strong> runs</span>
              <span><strong>{deck.held}</strong> held</span>
              <span><strong>{deck.bestScore}</strong> best</span>
            </div>
            <p className="mastery-card__unlocked">
              <Sparkles size={13} aria-hidden="true" />
              <span>{unlockedCopy(deck)}</span>
            </p>
            <p className="mastery-card__next">
              {deck.nextUnlock ? <LockKeyhole size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
              <span>
                {deck.nextUnlock
                  ? `${deck.nextUnlock.name} at LV ${deck.nextUnlock.level}`
                  : 'All deck cosmetics unlocked'}
              </span>
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function ProgressionPanel({
  challenge,
  progress,
  mastery,
  onPlay,
  starting,
  disabled,
}: ProgressionPanelProps) {
  return (
    <div className="progression-panel">
      <DailyChallengeCard
        challenge={challenge}
        progress={progress}
        onPlay={onPlay}
        starting={starting}
        disabled={disabled}
      />
      <DeckMasteryPanel mastery={mastery} />
    </div>
  )
}
