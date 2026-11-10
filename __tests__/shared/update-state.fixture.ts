import type {
  UpdateActivity,
  UpdateContext,
  UpdateInfo,
  UpdateState,
} from "../../lib/types";

const CONTEXT: UpdateContext = {
  revision: 3,
  currentVersion: "1.4.0",
  policy: {
    verdict: "recommended",
    latestVersion: "1.5.0",
    minSupportedVersion: null,
    checkedAt: 1_800_000_000_000,
  },
  checkedAt: 1_800_000_000_000,
  isInstallPending: false,
};

const UPDATE: UpdateInfo = {
  version: "1.5.0",
  releaseDate: "2026-11-09T10:00:00.000Z",
  releaseNotes: "E-fatura eklendi.",
  sizeBytes: 84_200_000,
};

const PROGRESS = {
  percent: 50,
  transferredBytes: 42_100_000,
  totalBytes: 84_200_000,
  bytesPerSecond: 1_200_000,
};

/** One complete state per status, plus the variants with nulls. */
const VALID_STATES: readonly UpdateState[] = [
  { status: "idle", ...CONTEXT },
  {
    status: "idle",
    ...CONTEXT,
    revision: 0,
    checkedAt: null,
    policy: {
      verdict: "ok",
      latestVersion: null,
      minSupportedVersion: null,
      checkedAt: null,
    },
  },
  { status: "unsupported", reason: "development", ...CONTEXT },
  { status: "checking", ...CONTEXT },
  { status: "not-available", ...CONTEXT },
  { status: "available", update: UPDATE, ...CONTEXT },
  {
    status: "available",
    update: {
      version: "1.5.0",
      releaseDate: null,
      releaseNotes: null,
      sizeBytes: null,
    },
    ...CONTEXT,
  },
  { status: "downloading", update: UPDATE, progress: PROGRESS, ...CONTEXT },
  {
    status: "downloaded",
    update: UPDATE,
    ...CONTEXT,
    isInstallPending: true,
    policy: { ...CONTEXT.policy, verdict: "required" },
  },
  {
    status: "error",
    error: { code: "OFFLINE", message: "İnternet bağlantısı yok." },
    update: null,
    ...CONTEXT,
  },
  {
    status: "error",
    error: { code: "CHECKSUM", message: "İndirilen dosya bozuk." },
    update: UPDATE,
    ...CONTEXT,
  },
];

const IDLE = { status: "idle", ...CONTEXT };
const AVAILABLE = { status: "available", update: UPDATE, ...CONTEXT };
const DOWNLOADING = {
  status: "downloading",
  update: UPDATE,
  progress: PROGRESS,
  ...CONTEXT,
};
const FAILED = {
  status: "error",
  error: { code: "OFFLINE", message: "Yok." },
  update: null,
  ...CONTEXT,
};

/** What must never pass for a state, each with the reason it is here. */
const INVALID_STATES: readonly (readonly [string, unknown])[] = [
  ["nothing", undefined],
  ["null", null],
  ["text", "idle"],
  ["a list", [IDLE]],
  ["no status", { ...CONTEXT }],
  ["a status that is not text", { ...IDLE, status: 1 }],
  ["an unknown status", { ...IDLE, status: "paused" }],
  ["a status from the prototype", { ...IDLE, status: "constructor" }],
  ["a negative revision", { ...IDLE, revision: -1 }],
  ["a revision that is not a number", { ...IDLE, revision: "3" }],
  ["an infinite revision", { ...IDLE, revision: Number.POSITIVE_INFINITY }],
  ["no current version", { ...IDLE, currentVersion: undefined }],
  ["no policy", { ...IDLE, policy: null }],
  [
    "an unknown verdict",
    { ...IDLE, policy: { ...CONTEXT.policy, verdict: "blocked" } },
  ],
  [
    "a verdict that is not text",
    { ...IDLE, policy: { ...CONTEXT.policy, verdict: 2 } },
  ],
  [
    "a latest version that is a number",
    { ...IDLE, policy: { ...CONTEXT.policy, latestVersion: 15 } },
  ],
  [
    "a minimum that is a number",
    { ...IDLE, policy: { ...CONTEXT.policy, minSupportedVersion: 14 } },
  ],
  [
    "a policy time that is text",
    { ...IDLE, policy: { ...CONTEXT.policy, checkedAt: "now" } },
  ],
  ["a check time that is text", { ...IDLE, checkedAt: "now" }],
  ["a pending flag that is text", { ...IDLE, isInstallPending: "no" }],
  ["unsupported without a reason", { status: "unsupported", ...CONTEXT }],
  [
    "unsupported for an unknown reason",
    { status: "unsupported", reason: "weather", ...CONTEXT },
  ],
  ["available without an update", { status: "available", ...CONTEXT }],
  ["an update that is text", { ...AVAILABLE, update: "1.5.0" }],
  [
    "an update without a version",
    { ...AVAILABLE, update: { ...UPDATE, version: 15 } },
  ],
  [
    "a release date that is a number",
    { ...AVAILABLE, update: { ...UPDATE, releaseDate: 1 } },
  ],
  [
    "release notes that are a list",
    { ...AVAILABLE, update: { ...UPDATE, releaseNotes: [] } },
  ],
  ["a negative size", { ...AVAILABLE, update: { ...UPDATE, sizeBytes: -1 } }],
  ["downloading without progress", { ...DOWNLOADING, progress: undefined }],
  ["progress that is a number", { ...DOWNLOADING, progress: 50 }],
  [
    "a percent that is text",
    { ...DOWNLOADING, progress: { ...PROGRESS, percent: "50" } },
  ],
  [
    "no transferred bytes",
    { ...DOWNLOADING, progress: { ...PROGRESS, transferredBytes: null } },
  ],
  [
    "no total bytes",
    { ...DOWNLOADING, progress: { ...PROGRESS, totalBytes: undefined } },
  ],
  [
    "a negative speed",
    { ...DOWNLOADING, progress: { ...PROGRESS, bytesPerSecond: -1 } },
  ],
  ["downloading without an update", { ...DOWNLOADING, update: null }],
  ["downloaded without an update", { status: "downloaded", ...CONTEXT }],
  ["an error without the error", { ...FAILED, error: undefined }],
  [
    "an error with an unknown code",
    { ...FAILED, error: { code: "E42", message: "x" } },
  ],
  ["an error without a message", { ...FAILED, error: { code: "OFFLINE" } }],
  ["an error whose update is missing", { ...FAILED, update: undefined }],
  ["an error whose update is broken", { ...FAILED, update: { version: 1 } }],
];

/** A complete state from the part that matters to a test. */
const stateOf = <A extends UpdateActivity>(
  activity: A,
  context: Partial<UpdateContext> = {}
): A & UpdateContext => ({ ...activity, ...CONTEXT, ...context });

/** The context of a version below the supported minimum. */
const REQUIRED: Partial<UpdateContext> = {
  policy: {
    verdict: "required",
    latestVersion: "1.5.0",
    minSupportedVersion: "1.4.5",
    checkedAt: 1_800_000_000_000,
  },
};

export {
  CONTEXT,
  INVALID_STATES,
  PROGRESS,
  REQUIRED,
  stateOf,
  UPDATE,
  VALID_STATES,
};
