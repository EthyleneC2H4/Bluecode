/**
 * Error codes shared by the rtk and headroomd wire protocols.
 *
 * Mapping conventions (agreed across all BlueCode protocol surfaces):
 * - unknown op              -> E_UNKNOWN_OP
 * - param validation failed -> E_INVALID_PARAMS
 * - frame parsing failed    -> E_PROTOCOL
 * - everything else         -> E_INTERNAL
 */
import { z } from "zod";

export const ErrorCode = {
  E_PROTOCOL: "E_PROTOCOL",
  E_UNKNOWN_OP: "E_UNKNOWN_OP",
  E_INVALID_PARAMS: "E_INVALID_PARAMS",
  E_INTERNAL: "E_INTERNAL",
} as const;

export type ErrorCode = keyof typeof ErrorCode;

/** Structured error payload carried by `ok:false` protocol responses. */
export interface ProtocolError {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

/**
 * Wire schema for {@link ProtocolError}.
 * The literal list mirrors {@link ErrorCode}; a runtime consistency check
 * lives in test/schema.test.ts.
 */
export const errorSchema = z.object({
  code: z.enum(["E_PROTOCOL", "E_UNKNOWN_OP", "E_INVALID_PARAMS", "E_INTERNAL"]),
  message: z.string(),
  detail: z.unknown().optional(),
});
