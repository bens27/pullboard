/** Shared decoded payload, request-body and pairing-package limits for every relay client. */
export const RELAY_BODY_BYTES = 100_000;
export const SEALED_SNAPSHOT_BYTES = 64_000_000;
export const SNAPSHOT_BODY_BYTES = 90_000_000;
export const PAIR_PACKAGE_BYTES = 90_000_000;
export const PAIR_ENVELOPE_BYTES = PAIR_PACKAGE_BYTES + 28;
export const PAIR_PACKAGE_BODY_BYTES = Math.ceil(PAIR_ENVELOPE_BYTES * 4 / 3) + 32;
export const PAIR_STORED_BYTES = PAIR_ENVELOPE_BYTES * 3;
