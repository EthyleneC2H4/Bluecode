/**
 * Process-unique identifier generation for protocol envelopes.
 */

let counter = 0;

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** `${prefix}_${process-lifetime monotonic counter}_${random hex suffix}`. */
export function newRequestId(prefix = "r"): string {
  counter += 1;
  return `${prefix}_${counter}_${randomSuffix()}`;
}
