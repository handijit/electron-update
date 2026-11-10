import { evaluateUpdatePolicy, isVersion } from "@handijit/core/version";

import type { UpdatePolicyState } from "../types";

/** The last policy the backend answered with, as it is kept between starts. */
type StoredPolicy = {
  /** The newest published version. */
  readonly latestVersion: string;
  /** The oldest supported version; `null` when no release sets a floor. */
  readonly minSupportedVersion: string | null;
  /** When the backend answered, by this computer's clock (epoch milliseconds). */
  readonly fetchedAt: number;
};

type EvaluateOptions = {
  /** The stored policy, or `null` when the backend never answered (or has no release). */
  stored: StoredPolicy | null;
  /** The version that is running. */
  currentVersion: string;
  /** The current time (epoch milliseconds). */
  now: number;
  /** How long a "required" verdict holds without the backend confirming it. */
  requiredTtlMs: number;
  /** When the backend last answered at all, for a policy that has no release. */
  answeredAt: number | null;
};

/** Whether a value read from disk is a policy this package wrote. */
const isStoredPolicy = (value: unknown): value is StoredPolicy => {
  if (typeof value !== "object" || value === null) return false;
  const { latestVersion, minSupportedVersion, fetchedAt } = value as Readonly<
    Record<string, unknown>
  >;
  return (
    isVersion(latestVersion) &&
    (minSupportedVersion === null || isVersion(minSupportedVersion)) &&
    typeof fetchedAt === "number" &&
    Number.isFinite(fetchedAt)
  );
};

/**
 * What the stored policy means for the running version right now.
 *
 * Without a stored policy the verdict is `ok`: a customer is never locked out because the
 * backend could not be reached. A stored "required" holds for `requiredTtlMs` around the
 * moment it was fetched and then weakens to `recommended` until the backend confirms it. The
 * window is symmetric, so a clock moved in either direction can only end the lock early, never
 * extend it; the lock is a courtesy to the customer, not a security boundary.
 */
const evaluateStoredPolicy = ({
  stored,
  currentVersion,
  now,
  requiredTtlMs,
  answeredAt,
}: EvaluateOptions): UpdatePolicyState => {
  if (stored === null) {
    return {
      verdict: "ok",
      latestVersion: null,
      minSupportedVersion: null,
      checkedAt: answeredAt,
    };
  }

  const status = evaluateUpdatePolicy(currentVersion, {
    latestVersion: stored.latestVersion,
    ...(stored.minSupportedVersion === null
      ? {}
      : { minSupportedVersion: stored.minSupportedVersion }),
  });
  const isFresh = Math.abs(now - stored.fetchedAt) <= requiredTtlMs;

  return {
    verdict:
      status === "up-to-date"
        ? "ok"
        : status === "update-required" && isFresh
          ? "required"
          : "recommended",
    latestVersion: stored.latestVersion,
    minSupportedVersion: stored.minSupportedVersion,
    checkedAt: stored.fetchedAt,
  };
};

export type { StoredPolicy };
export { evaluateStoredPolicy, isStoredPolicy };
