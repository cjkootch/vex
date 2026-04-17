export {
  buildNormalizationProcessor,
  type NormalizationProcessorDeps,
} from "./normalization-processor.js";
export {
  buildDlqProcessor,
  registerDlqDepthGauge,
  type DlqProcessorDeps,
} from "./dlq-processor.js";
export {
  buildTranscriptProcessor,
  type TranscriptProcessorDeps,
  type TranscriptProcessorOutcome,
} from "./transcript-processor.js";
