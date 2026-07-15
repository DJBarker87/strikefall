import { loadStrikefallWasm } from '../../src/wasm'

const output = document.querySelector<HTMLOutputElement>('#output')
if (!output) throw new Error('smoke output is missing')

const invalidModule = new URLSearchParams(window.location.search).has('invalid')
const result = await loadStrikefallWasm(
  invalidModule ? { moduleOrPath: new Uint8Array([0x00, 0x61, 0x73]) } : undefined,
)
document.documentElement.dataset.wasmStatus = result.status

if (result.status === 'ready') {
  const decks = result.client.deckCatalog()
  const quote = result.client.quoteNoTouch({
    spot: '100000000000000',
    barrier: '110000000000000',
    remainingVariance: '6400000000',
    driftPerVariance: '-500000000000',
    side: 'upper',
  })
  const barrier = result.client.barrierForSurvival({
    spot: '100000000000000',
    targetSurvival: '450000000000',
    remainingVariance: '6400000000',
    driftPerVariance: '-500000000000',
    side: 'upper',
  })
  output.value = `${decks.length} decks · quote ${quote.survivalProbability} · barrier ${barrier}`
} else if (result.status === 'unsupported') {
  output.value = result.reason
} else {
  output.value = result.error.message
}
