/**
 * @bluecode/rtk — long-lived rtk server subprocess + plugin-side client.
 *
 * The plugin (M5) imports only RtkClient; the server entry (src/bin.ts) is
 * spawned by the client itself. Wire schemas live in @bluecode/contracts,
 * the compression pipeline in @bluecode/rtk-core.
 */
export const VERSION = "0.1.0" as const;

export {
  RtkClient,
  RtkServerError,
  type ClientDiag,
  type CompressInput,
  type CompressOutcome,
  type FetchOutcome,
  type RtkClientOptions,
} from "./client";
