/** diarchy vault store: files, locking, cursors, and the three rendered views. */
export {
  CONFIG_FILENAME,
  defaultVault,
  loadConfig,
  resolveVaultPaths,
  vaultPaths,
  type GoalPaths,
  type VaultPaths,
} from "./config.js";
export { atomicWrite } from "./files.js";
export { renderChat } from "./render/chat.js";
export { renderDecisions } from "./render/decisions.js";
export { renderGoal } from "./render/goal.js";
export { GENERATED, GLYPHS, type RenderOptions } from "./render/shared.js";
export { serializeKickoff, slugify, suffixSlug } from "./kickoff.js";
export { AgentLease, leaseHolder } from "./lease.js";
export { LOCK_HOST, releaseLock, tryLock, type LockOwner } from "./lock.js";
export { DEFAULT_POLL_MS, LOCK_STALE_MS, MAX_WAIT_MS, PROGRESS_MS, VaultStore, readInbox } from "./store.js";
export {
  CorruptVaultFileError,
  NoGoalError,
  type BudgetSnapshot,
  type GoalRef,
  type KickoffInput,
  type KickoffOk,
  type KickoffResult,
  type MessageDraft,
  type PostOk,
  type PostResult,
  type ReadResult,
  type ReplyOptions,
  type VaultStoreOptions,
  type WaitOptions,
  type WaitProgress,
  type WaitResult,
} from "./types.js";
