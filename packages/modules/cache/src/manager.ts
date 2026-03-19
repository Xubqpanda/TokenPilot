import type {
  CacheBranchCandidate,
  CacheNode,
  CacheNodeId,
  CacheTreeOptions,
  CacheTreeRegisterInput,
  CacheTreeState,
} from "./types.js";

type CacheTreeClock = () => Date;

function toIso(d: Date): string {
  return d.toISOString();
}

function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}

export class CacheTreeManager {
  private readonly stateBySession = new Map<string, CacheTreeState>();
  private readonly clock: CacheTreeClock;
  private readonly defaultBranch: string;
  private readonly ttlSeconds: number;
  private nodeCounter = 0;

  constructor(options: CacheTreeOptions = {}, clock: CacheTreeClock = () => new Date()) {
    this.clock = clock;
    this.defaultBranch = options.defaultBranch ?? "main";
    this.ttlSeconds = Math.max(60, options.ttlSeconds ?? 600);
  }

  getState(sessionId: string): CacheTreeState {
    let state = this.stateBySession.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        nodes: {},
        headByBranch: {},
      };
      this.stateBySession.set(sessionId, state);
    }
    return state;
  }

  registerTurn(input: CacheTreeRegisterInput): CacheNode {
    const now = this.clock();
    const state = this.getState(input.snapshot.sessionId);
    const parent = this.resolveParent(state, input.preferredParentId);
    const branch = input.branch ?? parent?.branch ?? this.defaultBranch;
    const id = this.nextNodeId();
    const node: CacheNode = {
      id,
      parentId: parent?.id,
      branch,
      children: [],
      ttlSeconds: this.ttlSeconds,
      expiresAt: toIso(addSeconds(now, this.ttlSeconds)),
      hitCount: 0,
      lastHitAt: toIso(now),
      ...input.snapshot,
    };
    state.nodes[id] = node;
    state.headByBranch[branch] = id;
    state.latestNodeId = id;
    if (parent) {
      parent.children.push(id);
    }
    return node;
  }

  markHit(sessionId: string, nodeId: CacheNodeId): void {
    const state = this.getState(sessionId);
    const node = state.nodes[nodeId];
    if (!node) return;
    const now = this.clock();
    node.hitCount += 1;
    node.lastHitAt = toIso(now);
    node.expiresAt = toIso(addSeconds(now, node.ttlSeconds));
  }

  listCandidates(sessionId: string, provider: string, model: string): CacheBranchCandidate[] {
    const state = this.getState(sessionId);
    const now = this.clock().toISOString();
    const candidates: CacheBranchCandidate[] = [];
    for (const node of Object.values(state.nodes)) {
      if (node.provider !== provider || node.model !== model) continue;
      if (node.expiresAt <= now) continue;
      const freshness = Math.max(0, new Date(node.expiresAt).getTime() - Date.now()) / 1000;
      const score = node.hitCount * 2 + freshness / 60 - (node.contextChars ?? 0) / 5000;
      candidates.push({
        nodeId: node.id,
        branch: node.branch,
        provider: node.provider,
        model: node.model,
        expiresAt: node.expiresAt,
        score,
        reason: `hits=${node.hitCount}, freshness_s=${Math.round(freshness)}, context_chars=${node.contextChars ?? 0}`,
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  pruneExpired(sessionId: string): CacheNodeId[] {
    const state = this.getState(sessionId);
    const now = this.clock().toISOString();
    const removed: CacheNodeId[] = [];
    for (const [id, node] of Object.entries(state.nodes)) {
      if (node.expiresAt > now) continue;
      if (node.children.length > 0) continue;
      delete state.nodes[id];
      removed.push(id);
      if (state.headByBranch[node.branch] === id) {
        delete state.headByBranch[node.branch];
      }
    }
    if (state.latestNodeId && !state.nodes[state.latestNodeId]) {
      state.latestNodeId = undefined;
    }
    return removed;
  }

  private resolveParent(state: CacheTreeState, preferredParentId?: CacheNodeId): CacheNode | undefined {
    if (preferredParentId && state.nodes[preferredParentId]) {
      return state.nodes[preferredParentId];
    }
    if (state.latestNodeId && state.nodes[state.latestNodeId]) {
      return state.nodes[state.latestNodeId];
    }
    return undefined;
  }

  private nextNodeId(): CacheNodeId {
    this.nodeCounter += 1;
    return `cache-node-${this.nodeCounter.toString().padStart(6, "0")}`;
  }
}

