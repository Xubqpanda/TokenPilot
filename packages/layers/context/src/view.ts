import type {
  PersistedBranchRecord,
  PersistedMessageKind,
  PersistedMessageOrigin,
  PersistedMessageRecord,
  PersistedMessageRole,
  PersistedSessionMeta,
  RuntimeStateStore,
} from "@ecoclaw/kernel";

export type ContextViewMessage = PersistedMessageRecord & {
  chars: number;
  approxTokens: number;
  childMessageIds: string[];
};

export type ContextViewBranch = PersistedBranchRecord & {
  directMessageIds: string[];
  replayMessageIds: string[];
  lineageBranchIds: string[];
  directMessageCount: number;
  replayMessageCount: number;
  syntheticMessageCount: number;
  observedMessageCount: number;
};

export type ContextSessionView = {
  sessionId: string;
  meta: PersistedSessionMeta | null;
  turnsCount: number;
  messagesById: Record<string, ContextViewMessage>;
  branchesById: Record<string, ContextViewBranch>;
  messages: ContextViewMessage[];
  branches: ContextViewBranch[];
  activeBranchId?: string;
  activeReplayMessageIds: string[];
  activeReplayMessages: ContextViewMessage[];
  stats: {
    branchCount: number;
    messageCount: number;
    syntheticMessageCount: number;
    observedMessageCount: number;
    toolMessageCount: number;
    summaryMessageCount: number;
    checkpointSeedCount: number;
  };
};

export type ContextViewMessageSnapshot = {
  messageId: string;
  branchId: string;
  parentMessageId?: string;
  role: PersistedMessageRole;
  kind: PersistedMessageKind;
  origin: PersistedMessageOrigin;
  content: string;
  createdAt: string;
  chars: number;
  approxTokens: number;
  source?: string;
  replacesMessageIds?: string[];
  derivedFromArtifactId?: string;
  metadata?: Record<string, unknown>;
};

export type ContextViewBranchSnapshot = {
  branchId: string;
  parentBranchId?: string;
  forkedFromMessageId?: string;
  headMessageId?: string;
  createdAt: string;
  source: string;
  directMessageCount: number;
  replayMessageCount: number;
  syntheticMessageCount: number;
  observedMessageCount: number;
  lineageBranchIds: string[];
};

export type ContextViewSnapshot = {
  sessionId: string;
  activeBranchId?: string;
  meta: PersistedSessionMeta | null;
  turnsCount: number;
  branchCount: number;
  messageCount: number;
  activeReplayChars: number;
  activeReplayTokens: number;
  activeReplayMessages: ContextViewMessageSnapshot[];
  branches: ContextViewBranchSnapshot[];
  stats: ContextSessionView["stats"];
};

const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function resolveHeadMessageId(
  branch: PersistedBranchRecord,
  directMessages: ContextViewMessage[],
): string | undefined {
  if (branch.headMessageId) return branch.headMessageId;
  const latestDirect = sortByCreatedAt(directMessages).at(-1);
  if (latestDirect?.messageId) return latestDirect.messageId;
  return branch.forkedFromMessageId;
}

function resolveReplayMessageIds(
  headMessageId: string | undefined,
  messagesById: Map<string, ContextViewMessage>,
): string[] {
  if (!headMessageId) return [];
  const visited = new Set<string>();
  const chain: string[] = [];
  let currentId: string | undefined = headMessageId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messagesById.get(currentId);
    if (!message) break;
    chain.push(currentId);
    currentId = message.parentMessageId;
  }
  return chain.reverse();
}

function resolveBranchLineage(
  branchId: string,
  branchesById: Map<string, PersistedBranchRecord>,
): string[] {
  const lineage: string[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = branchId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    lineage.push(currentId);
    currentId = branchesById.get(currentId)?.parentBranchId;
  }
  return lineage.reverse();
}

export async function buildContextSessionView(params: {
  store: RuntimeStateStore;
  sessionId: string;
  activeBranchId?: string;
}): Promise<ContextSessionView> {
  const { store, sessionId, activeBranchId } = params;
  const [meta, rawBranches, rawMessages] = await Promise.all([
    store.readSessionMeta(sessionId),
    store.listBranches(sessionId),
    store.listMessages(sessionId),
  ]);
  const turns =
    rawBranches.length > 0
      ? (await Promise.all(rawBranches.map((branch) => store.listTurns(branch.branchId)))).flat()
      : await store.listTurns(sessionId);

  const messageNodes = sortByCreatedAt(rawMessages).map<ContextViewMessage>((message) => ({
    ...message,
    chars: message.content.length,
    approxTokens: estimateTokens(message.content.length),
    childMessageIds: [],
  }));
  const messagesById = new Map(messageNodes.map((message) => [message.messageId, message]));
  for (const message of messageNodes) {
    if (!message.parentMessageId) continue;
    messagesById.get(message.parentMessageId)?.childMessageIds.push(message.messageId);
  }

  const branchesById = new Map(rawBranches.map((branch) => [branch.branchId, branch]));
  const branchViews = rawBranches
    .map<ContextViewBranch>((branch) => {
      const directMessages = messageNodes.filter((message) => message.branchId === branch.branchId);
      const directMessageIds = sortByCreatedAt(directMessages).map((message) => message.messageId);
      const headMessageId = resolveHeadMessageId(branch, directMessages);
      const replayMessageIds = resolveReplayMessageIds(headMessageId, messagesById);
      const replayMessages = replayMessageIds
        .map((messageId) => messagesById.get(messageId))
        .filter((message): message is ContextViewMessage => Boolean(message));
      return {
        ...branch,
        headMessageId,
        directMessageIds,
        replayMessageIds,
        lineageBranchIds: resolveBranchLineage(branch.branchId, branchesById),
        directMessageCount: directMessageIds.length,
        replayMessageCount: replayMessageIds.length,
        syntheticMessageCount: replayMessages.filter((message) => message.origin !== "provider_observed").length,
        observedMessageCount: replayMessages.filter((message) => message.origin === "provider_observed").length,
      };
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const branchViewMap = new Map(branchViews.map((branch) => [branch.branchId, branch]));
  const resolvedActiveBranchId =
    activeBranchId && branchViewMap.has(activeBranchId)
      ? activeBranchId
      : branchViews.at(-1)?.branchId;
  const activeReplayMessageIds: string[] =
    resolvedActiveBranchId != null
      ? [...(branchViewMap.get(resolvedActiveBranchId)?.replayMessageIds ?? [])]
      : [];
  const activeReplayMessages = activeReplayMessageIds
    .map((messageId) => messagesById.get(messageId))
    .filter((message): message is ContextViewMessage => Boolean(message));

  return {
    sessionId,
    meta,
    turnsCount: turns.length,
    messagesById: Object.fromEntries(messageNodes.map((message) => [message.messageId, message])),
    branchesById: Object.fromEntries(branchViews.map((branch) => [branch.branchId, branch])),
    messages: messageNodes,
    branches: branchViews,
    activeBranchId: resolvedActiveBranchId,
    activeReplayMessageIds,
    activeReplayMessages,
    stats: {
      branchCount: branchViews.length,
      messageCount: messageNodes.length,
      syntheticMessageCount: messageNodes.filter((message) => message.origin !== "provider_observed").length,
      observedMessageCount: messageNodes.filter((message) => message.origin === "provider_observed").length,
      toolMessageCount: messageNodes.filter((message) => message.role === "tool").length,
      summaryMessageCount: messageNodes.filter((message) => message.kind === "summary").length,
      checkpointSeedCount: messageNodes.filter((message) => message.kind === "checkpoint_seed").length,
    },
  };
}

export function buildContextViewSnapshot(view: ContextSessionView): ContextViewSnapshot {
  const activeReplayMessages = view.activeReplayMessages.map<ContextViewMessageSnapshot>((message) => ({
    messageId: message.messageId,
    branchId: message.branchId,
    parentMessageId: message.parentMessageId,
    role: message.role,
    kind: message.kind,
    origin: message.origin,
    content: message.content,
    createdAt: message.createdAt,
    chars: message.chars,
    approxTokens: message.approxTokens,
    source: message.source,
    replacesMessageIds: message.replacesMessageIds,
    derivedFromArtifactId: message.derivedFromArtifactId,
    metadata: message.metadata,
  }));
  return {
    sessionId: view.sessionId,
    activeBranchId: view.activeBranchId,
    meta: view.meta,
    turnsCount: view.turnsCount,
    branchCount: view.stats.branchCount,
    messageCount: view.stats.messageCount,
    activeReplayChars: activeReplayMessages.reduce((sum, message) => sum + message.chars, 0),
    activeReplayTokens: activeReplayMessages.reduce((sum, message) => sum + message.approxTokens, 0),
    activeReplayMessages,
    branches: view.branches.map<ContextViewBranchSnapshot>((branch) => ({
      branchId: branch.branchId,
      parentBranchId: branch.parentBranchId,
      forkedFromMessageId: branch.forkedFromMessageId,
      headMessageId: branch.headMessageId,
      createdAt: branch.createdAt,
      source: branch.source,
      directMessageCount: branch.directMessageCount,
      replayMessageCount: branch.replayMessageCount,
      syntheticMessageCount: branch.syntheticMessageCount,
      observedMessageCount: branch.observedMessageCount,
      lineageBranchIds: branch.lineageBranchIds,
    })),
    stats: view.stats,
  };
}
