import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { GameErrorBoundary } from './components/GameErrorBoundary'
import { ScoringEngineGate } from './engine/ScoringEngineGate'
import { OfflineStatusBadge, registerPracticeServiceWorker } from './pwa'
import { installGlobalClientErrorTelemetry } from './runtimeErrors'
import './styles.css'

installGlobalClientErrorTelemetry()

const root = document.getElementById('root')

if (!root) {
  throw new Error('Strikefall could not find its app root.')
}

createRoot(root).render(
  <StrictMode>
    <GameErrorBoundary>
      <ScoringEngineGate>
        <App />
      </ScoringEngineGate>
      <OfflineStatusBadge />
    </GameErrorBoundary>
  </StrictMode>,
)

void registerPracticeServiceWorker()
