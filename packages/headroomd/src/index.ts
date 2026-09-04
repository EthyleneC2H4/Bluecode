/**
 * @bluecode/headroomd — long-session context daemon.
 *
 * Public surface: the engine (business layer), the UDS server and the
 * client. COMPACTION_MARKER is re-exported so the plugin can stamp
 * replacement messages without importing daemon internals (it must never
 * import turns/store directly — the daemon owns segmentation).
 */
export { VERSION } from "./version";
export {
  createEngine,
  type Engine,
  type EngineOptions,
} from "./engine";
export { startHeadroomServer, type HeadroomServerOptions, type HeadroomServerStart } from "./server";
export { HeadroomClient, type HeadroomClientOptions } from "./client";
export { COMPACTION_MARKER } from "./turns";
export {
  buildReplacementMessage,
  buildReplacementText,
  materializeCompaction,
  type CompactionApplyStatus,
  type CompactionPlan,
  type MaterializedCompaction,
} from "./compaction";
