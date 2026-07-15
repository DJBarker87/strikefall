import { CloudCheck, LoaderCircle, TriangleAlert, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePracticeAvailability } from './status'
import './offline-status.css'

export function OfflineStatusBadge() {
  const availability = usePracticeAvailability()
  const [readyDismissed, setReadyDismissed] = useState(false)

  useEffect(() => {
    if (!availability.online || availability.phase !== 'ready') {
      setReadyDismissed(false)
      return
    }
    const timer = window.setTimeout(() => setReadyDismissed(true), 4_500)
    return () => window.clearTimeout(timer)
  }, [availability.online, availability.phase])

  if (availability.phase === 'idle'
    || availability.phase === 'disabled'
    || availability.phase === 'unsupported'
    || (availability.online && availability.phase === 'ready' && readyDismissed)) {
    return null
  }

  const content = !availability.online
    ? {
        icon: <WifiOff size={13} aria-hidden="true" />,
        label: 'Offline · practice only',
        modifier: 'offline',
        title: 'Local practice is available. Ranked and public replays require a connection.',
      }
    : availability.phase === 'ready'
      ? {
          icon: <CloudCheck size={13} aria-hidden="true" />,
          label: 'Offline ready',
          modifier: 'ready',
          title: 'This version of local practice is saved for offline play.',
        }
      : availability.phase === 'installing'
        ? {
            icon: <LoaderCircle className="offline-status__spinner" size={13} aria-hidden="true" />,
            label: 'Preparing offline',
            modifier: 'installing',
            title: 'Saving the local practice shell for offline play.',
          }
        : {
            icon: <TriangleAlert size={13} aria-hidden="true" />,
            label: 'Online only',
            modifier: 'error',
            title: 'The offline practice shell could not be saved on this device.',
          }

  return (
    <div
      className={`offline-status offline-status--${content.modifier}`}
      role="status"
      aria-live="polite"
      title={content.title}
    >
      {content.icon}
      <span>{content.label}</span>
    </div>
  )
}
