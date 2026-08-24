/**
 * Cross-strategy trim priority constants.
 */

/**
 * Trim priority constants (higher = trimmed later; anchor lines ignore this).
 * Strategies must reference these instead of magic numbers so that relative
 * ordering stays consistent across strategies.
 */
export const PRI = { critical: 100, high: 70, normal: 40, low: 10 } as const;
