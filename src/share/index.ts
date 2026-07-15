export {
  createShareArtifact,
  shareCaption,
  shareFilename,
} from './artifact'
export {
  detectDramaticMoments,
  isShareableResult,
  selectPrimaryDramaticMoment,
} from './moments'
export {
  createShareCardLayout,
  isRectInsideCard,
  shareCardDimensions,
} from './layout'
export {
  createShareClipLayout,
  isClipRectInside,
  shareClipDimensions,
} from './clipLayout'
export {
  ESCAPE_CAPTURE_KEY,
  battleMomentClockTime,
  battleStepClockTime,
  clusterWipeCaptureKey,
  nearMissCaptureKey,
  shareMomentCaptureKey,
  shareMomentCaptureLabel,
  shareMomentSupportsClip,
} from './clipMoments'
export {
  CompositedShareRecorder,
  createCompositedShareRecorder,
} from './compositedRecorder'
export {
  exportShareCard,
  renderShareCard,
} from './renderCard'
export {
  RollingArenaRecorder,
  createRollingArenaRecorder,
} from './recorder'
export {
  createAndShareStrikefallFile,
  createShareFile,
  shareStrikefallFile,
} from './webShare'

export type {
  BotRivalryMoment,
  ClusterWipeMoment,
  DramaticMoment,
  DramaticMomentAccent,
  DramaticMomentKind,
  EscapeRegretMoment,
  EscapeSaveMoment,
  GreedHoldMoment,
  NearMissMoment,
  NormalizedShareChart,
  PerfectEscapeMoment,
  CreateShareArtifactOptions,
  RivalryShareContext,
  ShareArtifact,
  ShareCardData,
  ShareCardFormat,
  ShareClipFormat,
  ShareCardStat,
  ShareRoundInput,
} from './types'
export type {
  ShareClipLayout,
} from './clipLayout'
export type {
  CompositedShareRecorderEnvironment,
  CompositedShareRecorderOptions,
  ShareClipCanvasSurface,
  ShareClipCaptureResult,
  ShareClipMomentReport,
  ShareClipStartReport,
} from './compositedRecorder'
export type {
  ShareCardLayout,
  ShareRect,
} from './layout'
export type {
  ShareCanvasSurface,
  ShareCardExportResult,
  ShareCardRenderEnvironment,
  ShareCardRenderOptions,
  ShareCardRenderResult,
} from './renderCard'
export type {
  ArenaCaptureCanvas,
  MediaRecorderLike,
  MediaStreamLike,
  MediaStreamTrackLike,
  RecorderClipResult,
  RecorderFallbackReason,
  RecorderMomentAlignment,
  RecorderStartResult,
  RetainMomentOptions,
  RollingArenaRecorderOptions,
  RollingRecorderEnvironment,
  RollingRecorderStats,
  RollingRecorderStatus,
} from './recorder'
export type {
  ShareFileResult,
  StrikefallShareOptions,
  WebShareEnvironment,
  WebShareResult,
} from './webShare'
