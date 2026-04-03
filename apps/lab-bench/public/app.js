const state = {
  overview: null,
  sessionId: null,
  turns: [],
  traceId: null,
  detail: null,
  actionStatus: '',
  actionBusy: false,
  treeCollapsedByTraceId: {},
  editorMode: 'observe',
  draftSeq: 0,
  editor: {
    sourceBlocks: [],
    draftBlocks: [],
    previewBlocks: [],
    previewMeta: null,
    selectedSourceIds: [],
    lastSourceIndex: null,
    dragPreviewId: null,
    syncScrollEnabled: true,
    syncScrollMute: false,
    expanded: null,
    pendingScrollToLatest: false,
    scrollTopByPane: {
      source: 0,
      draft: 0,
      candidate: 0,
    },
    busy: false,
    notice: '',
  },
};

const el = {
  drawer: document.getElementById('drawer'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  drawerOpenBtn: document.getElementById('drawerOpenBtn'),
  drawerCloseBtn: document.getElementById('drawerCloseBtn'),
  branchDrawer: document.getElementById('branchDrawer'),
  branchDrawerBackdrop: document.getElementById('branchDrawerBackdrop'),
  branchDrawerOpenBtn: document.getElementById('branchDrawerOpenBtn'),
  branchDrawerCloseBtn: document.getElementById('branchDrawerCloseBtn'),
  sessionsList: document.getElementById('sessionsList'),
  turnsList: document.getElementById('turnsList'),
  turnCountLabel: document.getElementById('turnCountLabel'),
  turnModeLabel: document.getElementById('turnModeLabel'),
  turnTitle: document.getElementById('turnTitle'),
  turnSubtitle: document.getElementById('turnSubtitle'),
  refreshBtn: document.getElementById('refreshBtn'),
  forkBtn: document.getElementById('forkBtn'),
  revertBtn: document.getElementById('revertBtn'),
  observeModeBtn: document.getElementById('observeModeBtn'),
  editModeBtn: document.getElementById('editModeBtn'),
  contextPanelTitle: document.getElementById('contextPanelTitle'),
  contextPanelSubtitle: document.getElementById('contextPanelSubtitle'),
  actionStatusBar: document.getElementById('actionStatusBar'),
  contextSummaryBar: document.getElementById('contextSummaryBar'),
  contextMonitor: document.getElementById('contextMonitor'),
  turnTreeSummary: document.getElementById('turnTreeSummary'),
  turnTreeList: document.getElementById('turnTreeList'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return Number(value).toLocaleString();
}

function fmtDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fmtPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return (Number(value) * 100).toFixed(1) + '%';
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function renderEmpty(target, message) {
  if (!target) return;
  target.innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let message = 'Request failed: ' + res.status;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

function openDrawer() {
  el.drawer.classList.remove('collapsed');
  el.drawerBackdrop.classList.remove('hidden');
}

function closeDrawer() {
  el.drawer.classList.add('collapsed');
  el.drawerBackdrop.classList.add('hidden');
}

function openBranchDrawer() {
  el.branchDrawer.classList.remove('collapsed');
  el.branchDrawerBackdrop.classList.remove('hidden');
}

function closeBranchDrawer() {
  el.branchDrawer.classList.add('collapsed');
  el.branchDrawerBackdrop.classList.add('hidden');
}

function sessionButton(session, active) {
  return '<button class="session-item ' + (active ? 'active' : '') + '" data-session-id="' + escapeHtml(session.id) + '">' +
    '<div class="item-title">' + escapeHtml(session.id) + '</div>' +
    '<div class="item-meta">' +
      '<span class="chip">' + escapeHtml(session.apiFamily) + '</span>' +
      '<span class="chip">turns ' + fmtNumber(session.turnCount) + '</span>' +
      '<span class="chip">cache ' + fmtNumber(session.cacheReadTokens) + '</span>' +
    '</div>' +
    '<div class="item-meta"><span class="muted">' + escapeHtml(fmtDate(session.lastAt)) + '</span></div>' +
  '</button>';
}

function turnButton(turn, active) {
  return '<button class="turn-item ' + (active ? 'active' : '') + '" data-trace-id="' + escapeHtml(turn.traceId) + '">' +
    '<div class="item-title">' + escapeHtml(turn.promptPreview || '(empty prompt)') + '</div>' +
    '<div class="item-meta">' +
      '<span class="chip">in ' + fmtNumber(turn.inputTokens) + '</span>' +
      '<span class="chip">cache ' + fmtNumber(turn.cacheReadTokens) + '</span>' +
      '<span class="chip">out ' + fmtNumber(turn.outputTokens) + '</span>' +
    '</div>' +
    '<div class="item-meta"><span class="muted">' + escapeHtml(fmtDate(turn.at)) + '</span></div>' +
  '</button>';
}

function turnTree() {
  return state.detail?.turnTree ?? null;
}

function selectedTurnNode() {
  const tree = turnTree();
  if (!tree) return null;
  const selectedId = state.traceId || tree.selectedTraceId || null;
  if (!selectedId) return null;
  return (tree.nodes || []).find((node) => node.traceId === selectedId) || null;
}

function activeReplayNode() {
  const tree = turnTree();
  if (!tree?.activePhysicalSessionId) return null;
  return (tree.nodes || []).find((node) => node.physicalSessionId === tree.activePhysicalSessionId) || null;
}

function visibleTurns() {
  return state.turns;
}

function turnNodeChildrenMap(tree) {
  const byParent = new Map();
  for (const node of tree?.nodes ?? []) {
    const parentId = node.parentTraceId || '__root__';
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(node);
  }
  for (const nodes of byParent.values()) {
    nodes.sort((a, b) => {
      const aTime = a.at || '';
      const bTime = b.at || '';
      if (aTime !== bTime) return aTime.localeCompare(bTime);
      return a.traceId.localeCompare(b.traceId);
    });
  }
  return byParent;
}

function traceNodeMap(tree) {
  const map = new Map();
  for (const node of tree?.nodes ?? []) {
    map.set(node.traceId, node);
  }
  return map;
}

function selectedTraceAncestors(tree, selectedTraceId) {
  const nodeMap = traceNodeMap(tree);
  const ancestors = new Set();
  let cursor = selectedTraceId ? nodeMap.get(selectedTraceId) : null;
  while (cursor?.parentTraceId) {
    ancestors.add(cursor.parentTraceId);
    cursor = nodeMap.get(cursor.parentTraceId) || null;
  }
  return ancestors;
}

function countDescendants(children, traceId) {
  const direct = children.get(traceId) || [];
  let total = direct.length;
  for (const child of direct) total += countDescendants(children, child.traceId);
  return total;
}

function defaultCollapsedForNode(children, node, selectedAncestors, selectedTraceId) {
  if (node.traceId === selectedTraceId || selectedAncestors.has(node.traceId)) return false;
  const directChildren = children.get(node.traceId) || [];
  if (!directChildren.length) return false;
  if (directChildren.length > 1) return false;
  return directChildren[0].physicalSessionId === node.physicalSessionId;
}

function isNodeCollapsed(children, node, selectedAncestors, selectedTraceId) {
  const override = state.treeCollapsedByTraceId[node.traceId];
  if (typeof override === 'boolean') return override;
  return defaultCollapsedForNode(children, node, selectedAncestors, selectedTraceId);
}

function turnTreeButton(node, active) {
  const chips = [
    '<span class="chip">' + escapeHtml(node.branchLabel || node.physicalSessionId) + '</span>',
    '<span class="chip">cache ' + fmtNumber(node.cacheReadTokens) + '</span>',
    '<span class="chip">in ' + fmtNumber(node.inputTokens) + '</span>',
  ];
  if (node.isActiveReplayBranch) chips.push('<span class="chip chip-accent">active replay</span>');
  if (node.branchStrategy) chips.push('<span class="chip">' + escapeHtml(node.branchStrategy) + '</span>');
  return (
    '<button class="branch-item ' + (active ? 'active' : '') + ' ' + (node.isActiveReplayBranch ? 'active-replay' : '') + '" data-trace-id="' + escapeHtml(node.traceId) + '">' +
      '<span class="branch-bullet" aria-hidden="true"></span>' +
      '<div class="branch-main">' +
        '<div class="item-title">' + escapeHtml(node.promptPreview || '(empty prompt)') + '</div>' +
        '<div class="item-meta">' + chips.join('') + '</div>' +
        '<div class="item-meta"><span class="muted">' + escapeHtml(fmtDate(node.at)) + '</span></div>' +
      '</div>' +
    '</button>'
  );
}

function turnTreeEntry(node, active, childHtml, collapsed, hiddenCount) {
  const toggle = hiddenCount > 0
    ? '<button class="tree-toggle" data-toggle-trace-id="' + escapeHtml(node.traceId) + '" aria-label="' + (collapsed ? 'Expand subtree' : 'Collapse subtree') + '">' +
        '<span class="tree-toggle-glyph">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="tree-toggle-label">' + (collapsed ? '展开 ' + fmtNumber(hiddenCount) + ' 个后续节点' : '收起') + '</span>' +
      '</button>'
    : '<span class="tree-toggle-spacer" aria-hidden="true"></span>';
  return (
    '<div class="branch-tree-entry">' +
      '<div class="tree-node-row">' +
        toggle +
        turnTreeButton(node, active) +
      '</div>' +
      childHtml +
    '</div>'
  );
}

function renderTurnTreeLevel(children, parentId, selectedTraceId, depth, selectedAncestors) {
  const nodes = children.get(parentId) || [];
  if (!nodes.length) return '';
  return (
    '<div class="branch-tree-level ' + (depth === 0 ? 'root' : 'nested') + '">' +
      nodes.map((node) => {
        const hiddenCount = countDescendants(children, node.traceId);
        const collapsed = isNodeCollapsed(children, node, selectedAncestors, selectedTraceId);
        const childHtml = collapsed
          ? ''
          : renderTurnTreeLevel(children, node.traceId, selectedTraceId, depth + 1, selectedAncestors);
        return turnTreeEntry(node, node.traceId === selectedTraceId, childHtml, collapsed, hiddenCount);
      }).join('') +
    '</div>'
  );
}

function renderTurnTree() {
  const tree = turnTree();
  if (!tree || !(tree.nodes || []).length) {
    el.turnTreeSummary.innerHTML = '';
    renderEmpty(el.turnTreeList, 'No turns have been observed for this session yet.');
    return;
  }

  const selectedTraceId = state.traceId || tree.selectedTraceId || null;
  const selectedNode = (tree.nodes || []).find((node) => node.traceId === selectedTraceId) || null;
  const activeNode = activeReplayNode();
  el.turnTreeSummary.innerHTML = [
    '<span class="status-pill">nodes ' + fmtNumber(tree.nodes.length) + '</span>',
    '<span class="status-pill">roots ' + fmtNumber((tree.rootTraceIds || []).length) + '</span>',
    selectedNode ? '<span class="status-pill cool">branch ' + escapeHtml(selectedNode.branchLabel || selectedNode.physicalSessionId) + '</span>' : '',
    activeNode ? '<span class="status-pill">active replay ' + escapeHtml(activeNode.branchLabel || activeNode.physicalSessionId) + '</span>' : '',
  ].filter(Boolean).join('');

  const children = turnNodeChildrenMap(tree);
  const selectedAncestors = selectedTraceAncestors(tree, selectedTraceId);
  el.turnTreeList.innerHTML = renderTurnTreeLevel(children, '__root__', selectedTraceId, 0, selectedAncestors);

  for (const button of el.turnTreeList.querySelectorAll('[data-trace-id]')) {
    button.addEventListener('click', async () => {
      const traceId = button.dataset.traceId;
      if (!traceId) return;
      state.traceId = traceId;
      await loadDetail(state.traceId);
      renderTurns();
      closeBranchDrawer();
    });
  }
  for (const button of el.turnTreeList.querySelectorAll('[data-toggle-trace-id]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const traceId = button.dataset.toggleTraceId;
      if (!traceId) return;
      const node = (tree.nodes || []).find((item) => item.traceId === traceId);
      if (!node) return;
      const nextValue = !isNodeCollapsed(children, node, selectedAncestors, selectedTraceId);
      state.treeCollapsedByTraceId[traceId] = nextValue;
      renderTurnTree();
    });
  }
}

function renderSessions() {
  const sessions = state.overview?.sessions ?? [];
  if (!sessions.length) {
    renderEmpty(el.sessionsList, 'No trace sessions found yet.');
    return;
  }
  el.sessionsList.innerHTML = sessions.map((session) => sessionButton(session, session.id === state.sessionId)).join('');
  for (const button of el.sessionsList.querySelectorAll('[data-session-id]')) {
    button.addEventListener('click', async () => {
      state.sessionId = button.dataset.sessionId;
      await loadTurns(state.sessionId);
      renderSessions();
      closeDrawer();
    });
  }
}

function renderTurns() {
  const turns = visibleTurns();
  if (!turns.length) {
    el.turnCountLabel.textContent = '';
    renderEmpty(el.turnsList, 'No turns found for this session.');
    return;
  }
  el.turnCountLabel.textContent =
    turns.length === state.turns.length ? String(turns.length) : String(turns.length) + ' / ' + String(state.turns.length);
  el.turnsList.innerHTML = turns.map((turn) => turnButton(turn, turn.traceId === state.traceId)).join('');
  for (const button of el.turnsList.querySelectorAll('[data-trace-id]')) {
    button.addEventListener('click', async () => {
      state.traceId = button.dataset.traceId;
      await loadDetail(state.traceId);
      renderTurns();
      closeDrawer();
    });
  }
}

function actualConversation() {
  return state.detail?.actualForwardedConversation ?? [];
}

function stripReplyTag(text) {
  return String(text ?? '').replace(/^\s*\[\[[^\]]+\]\]\s*/u, '').trim();
}

function roleLabel(block) {
  if (block.role === 'system') return 'Root';
  if (block.role === 'assistant') return 'Assistant';
  if (block.role === 'tool') return 'Tool';
  return 'User';
}

function buildContextTreeNodes(blocks) {
  if (!blocks.length) return [];
  return blocks.map((block, index) => ({
    ...block,
    treeParentId: index === 0 ? null : blocks[index - 1].id,
    treeDepth: index === 0 ? 0 : 1,
    branchId: state.detail?.physicalSessionId || state.detail?.sessionId || 'main',
    isRoot: index === 0,
    displayText: block.role === 'assistant' ? stripReplyTag(block.text) : block.text,
  }));
}

function conversationNodeCard(node, index, total) {
  const classes = [
    'context-node',
    'role-' + node.role,
    node.isRoot ? 'is-root' : '',
    index === total - 1 ? 'is-leaf' : '',
  ].filter(Boolean).join(' ');
  const tags = [
    '<span class="tag">' + escapeHtml(roleLabel(node)) + '</span>',
    '<span class="tag">' + escapeHtml('branch ' + node.branchId) + '</span>',
    '<span class="tag">' + escapeHtml('turn ' + node.turnIndex) + '</span>',
    node.source ? '<span class="tag">' + escapeHtml(node.source) + '</span>' : '',
    node.at ? '<span class="tag">' + escapeHtml(fmtDate(node.at)) + '</span>' : '',
  ].filter(Boolean).join('');
  return '<article class="' + classes + '">' +
    '<div class="context-tree-rail" aria-hidden="true">' +
      '<span class="context-tree-dot"></span>' +
      '<span class="context-tree-line"></span>' +
    '</div>' +
    '<div class="context-node-body">' +
      '<div class="segment-head">' +
        '<strong>' + escapeHtml(node.title) + '</strong>' +
        '<div class="segment-tags">' + tags + '</div>' +
      '</div>' +
      '<div class="row-inline"><span class="muted">chars ' + fmtNumber(node.chars) + '</span></div>' +
      '<pre class="segment-text">' + escapeHtml(node.displayText) + '</pre>' +
    '</div>' +
  '</article>';
}

function nextDraftId() {
  state.draftSeq += 1;
  return 'draft-' + state.draftSeq;
}

function createDraftBlock(block, extra = {}) {
  const sourceRefs = Array.isArray(extra.sourceRefs)
    ? extra.sourceRefs.slice()
    : block?.id
      ? [block.id]
      : [];
  const text = String(extra.text ?? block?.text ?? '');
  return {
    draftId: extra.draftId || nextDraftId(),
    role: extra.role || block?.role || 'user',
    title: extra.title || block?.title || 'Message',
    text,
    chars: text.length,
    source: extra.source || block?.source || 'draft',
    sourceRefs,
    origin: extra.origin || 'source',
    derivedLabel: extra.derivedLabel || '',
  };
}

function rebuildDraftChars() {
  state.editor.draftBlocks = state.editor.draftBlocks.map((block) => ({
    ...block,
    chars: String(block.text ?? '').length,
  }));
}

function resetEditorFromDetail(detail) {
  const sourceBlocks = (detail?.replayConversation ?? []).map((block) => ({ ...block }));
  state.editor.sourceBlocks = sourceBlocks;
  state.editor.draftBlocks = sourceBlocks.map((block) => createDraftBlock(block));
  state.editor.previewBlocks = [];
  state.editor.previewMeta = null;
  state.editor.selectedSourceIds = [];
  state.editor.lastSourceIndex = null;
  state.editor.dragPreviewId = null;
  state.editor.expanded = null;
  state.editor.pendingScrollToLatest = true;
  state.editor.scrollTopByPane = {
    source: 0,
    draft: 0,
    candidate: 0,
  };
  state.editor.busy = false;
  state.editor.notice = '';
}

function contextSummaryPills(detail) {
  const blocks = actualConversation();
  if (state.editorMode === 'edit') {
    const sourceCount = state.editor.sourceBlocks.length;
    const draftCount = state.editor.draftBlocks.length;
    const selectedCount = state.editor.selectedSourceIds.length;
    const stats = draftCharStats();
    const divergence = stats.divergenceIndex;
    return [
      { text: 'source ' + fmtNumber(sourceCount), cls: '' },
      { text: 'draft ' + fmtNumber(draftCount), cls: '' },
      { text: 'selected ' + fmtNumber(selectedCount), cls: selectedCount > 0 ? 'cool' : '' },
      { text: 'cache chars ' + fmtNumber(stats.cacheChars), cls: '' },
      { text: 'new chars ' + fmtNumber(stats.newChars), cls: stats.newChars > 0 ? 'warn' : '' },
      { text: divergence == null ? 'diff clean' : 'diff at #' + fmtNumber(divergence + 1), cls: divergence == null ? '' : 'warn' },
      { text: 'cache ' + fmtNumber(detail.usage.cacheReadTokens), cls: detail.usage.cacheReadTokens > 0 ? 'cool' : '' },
    ];
  }
  if (blocks.length) {
    const byRole = blocks.reduce((acc, block) => {
      acc[block.role] = (acc[block.role] || 0) + 1;
      return acc;
    }, {});
    const totalChars = blocks.reduce((sum, block) => sum + Number(block.chars || 0), 0);
    const locality = readLocalityState(detail);
    return [
      { text: 'blocks ' + fmtNumber(blocks.length), cls: '' },
      { text: 'chars ' + fmtNumber(totalChars), cls: '' },
      { text: 'user ' + fmtNumber(byRole.user || 0), cls: '' },
      { text: 'assistant ' + fmtNumber(byRole.assistant || 0), cls: '' },
      locality.signalCount
        ? { text: 'signals ' + fmtNumber(locality.signalCount), cls: 'cool' }
        : null,
      locality.dominantAction && locality.dominantAction !== 'observe'
        ? { text: 'policy ' + locality.dominantAction, cls: 'cool' }
        : null,
      { text: 'cache ' + fmtNumber(detail.usage.cacheReadTokens), cls: detail.usage.cacheReadTokens > 0 ? 'cool' : '' },
      { text: 'hit ' + fmtPercent(detail.usage.cacheHitRate), cls: detail.usage.cacheHitRate > 0 ? 'cool' : 'danger' },
    ].filter(Boolean);
  }
  return [
    { text: 'real payload unavailable', cls: 'danger' },
  ];
}

function readLocalityState(detail) {
  const policy = asRecord(detail?.policy) || {};
  const decisions = asRecord(policy.decisions) || {};
  const signals = asRecord(policy.signals) || {};
  const semantic = asRecord(decisions.semantic) || {};
  const summary = asRecord(decisions.summary) || {};
  const handoff = asRecord(decisions.handoff) || {};
  const compaction = asRecord(decisions.compaction) || {};
  const localityDecision = asRecord(decisions.locality) || {};
  const localitySignals = asRecord(signals.locality) || {};
  const signalList = asArray(localityDecision.signals).map(asRecord).filter(Boolean);
  return {
    policy,
    semantic,
    summary,
    handoff,
    compaction,
    localityDecision,
    localitySignals,
    signalList,
    signalCount: asNumber(localityDecision.signalCount ?? localitySignals.signalCount, 0),
    dominantAction: asString(localityDecision.dominantAction ?? localitySignals.dominantAction, 'observe'),
  };
}

function arrayOfStrings(value) {
  return asArray(value)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function compactSignalEntries(value) {
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .filter(([, value]) => value != null && value !== '')
    .slice(0, 8);
}

function renderSignalTargets(signal) {
  const targets = asRecord(signal.targets) || {};
  const messageIds = arrayOfStrings(targets.messageIds);
  const branchIds = arrayOfStrings(targets.branchIds);
  const chips = [];
  if (messageIds.length) chips.push('<span class="status-pill">messages ' + fmtNumber(messageIds.length) + '</span>');
  if (branchIds.length) chips.push('<span class="status-pill">branches ' + fmtNumber(branchIds.length) + '</span>');
  if (!chips.length) return '';
  return '<div class="signal-target-strip">' + chips.join('') + '</div>';
}

function renderSignalDetailGroup(label, value) {
  const entries = compactSignalEntries(value);
  if (!entries.length) return '';
  return '<div class="signal-metrics">' +
    '<span class="metric-pill"><strong>' + escapeHtml(label) + '</strong></span>' +
    entries.map(([key, value]) =>
      '<span class="metric-pill"><strong>' + escapeHtml(key) + '</strong><span>' + escapeHtml(String(value)) + '</span></span>'
    ).join('') +
  '</div>';
}

function renderSignalCard(signal) {
  const hints = arrayOfStrings(signal.actionHints);
  return '<article class="policy-signal-card">' +
    '<div class="policy-signal-head">' +
      '<div>' +
        '<h5>' + escapeHtml(asString(signal.kind, 'signal')) + '</h5>' +
        '<div class="item-meta">' +
          '<span class="status-pill">' + escapeHtml(asString(signal.scope, 'message')) + '</span>' +
          '<span class="status-pill">' + escapeHtml(asString(signal.confidence, 'low')) + '</span>' +
          '<span class="status-pill">score ' + escapeHtml(asNumber(signal.score, 0).toFixed(2)) + '</span>' +
        '</div>' +
      '</div>' +
      (
        hints.length
          ? '<div class="signal-hints">' + hints.map((hint) => '<span class="status-pill cool">' + escapeHtml(hint) + '</span>').join('') + '</div>'
          : ''
      ) +
    '</div>' +
    '<p class="signal-rationale">' + escapeHtml(asString(signal.rationale, '')) + '</p>' +
    renderSignalTargets(signal) +
    renderSignalDetailGroup('evidence', signal.evidence) +
    renderSignalDetailGroup('cost', signal.cost) +
  '</article>';
}

function renderCandidateList(label, ids, chars, cls = '') {
  const safeIds = arrayOfStrings(ids);
  return '<article class="policy-candidate-card ' + cls + '">' +
    '<div class="policy-candidate-head">' +
      '<strong>' + escapeHtml(label) + '</strong>' +
      '<div class="item-meta">' +
        '<span class="status-pill">' + fmtNumber(safeIds.length) + ' ids</span>' +
        '<span class="status-pill">chars ' + fmtNumber(chars) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="policy-candidate-body">' +
      (safeIds.length
        ? safeIds.slice(0, 8).map((id) => '<code class="candidate-id">' + escapeHtml(id) + '</code>').join('')
        : '<span class="muted">none</span>') +
      (safeIds.length > 8 ? '<span class="muted">+' + fmtNumber(safeIds.length - 8) + ' more</span>' : '') +
    '</div>' +
  '</article>';
}

function renderDecisionCard(title, decision, chars, fallbackLabel) {
  const requested = decision.requested === true;
  const reasons = arrayOfStrings(decision.reasons);
  return '<article class="policy-decision-card">' +
    '<div class="policy-candidate-head">' +
      '<strong>' + escapeHtml(title) + '</strong>' +
      '<div class="item-meta">' +
        '<span class="status-pill ' + (requested ? 'cool' : '') + '">' + (requested ? 'requested' : 'idle') + '</span>' +
        '<span class="status-pill">chars ' + fmtNumber(chars) + '</span>' +
        '<span class="status-pill">' + escapeHtml(asString(decision.generationMode, fallbackLabel)) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="policy-candidate-body">' +
      (reasons.length
        ? reasons.map((reason) => '<span class="status-pill">' + escapeHtml(reason) + '</span>').join('')
        : '<span class="muted">no active reasons</span>') +
    '</div>' +
  '</article>';
}

function localityPanel(detail) {
  const locality = readLocalityState(detail);
  if (!locality.signalCount && !locality.signalList.length) return '';

  const signalSummary = locality.localitySignals;
  const semantic = locality.semantic;
  const decision = locality.localityDecision;

  return '<section class="policy-panel">' +
    '<div class="policy-panel-head">' +
      '<div>' +
        '<h4>Locality Signals</h4>' +
        '<p class="subtitle">Current online policy view: signal-led candidates, execution decisions, and semantic-budget arbitration.</p>' +
      '</div>' +
      '<div class="item-meta">' +
        '<span class="status-pill cool">signals ' + fmtNumber(locality.signalCount) + '</span>' +
        '<span class="status-pill">' + escapeHtml(locality.dominantAction || 'observe') + '</span>' +
        (
          semantic.llmBudgetOwner
            ? '<span class="status-pill">llm owner ' + escapeHtml(String(semantic.llmBudgetOwner)) + '</span>'
            : ''
        ) +
      '</div>' +
    '</div>' +
    '<div class="policy-grid">' +
      renderDecisionCard('Summary', locality.summary, signalSummary.summaryCandidateChars, 'heuristic') +
      renderDecisionCard('Handoff', locality.handoff, signalSummary.handoffCandidateChars, 'heuristic') +
      renderDecisionCard('Compaction', locality.compaction, signalSummary.compactionCandidateReplayChars, 'heuristic') +
      renderCandidateList('Protected Prefix', decision.protectedMessageIds, signalSummary.protectedChars, 'protect') +
      renderCandidateList('Reduction Targets', decision.reductionCandidateMessageIds, signalSummary.reductionCandidateChars, 'reduce') +
      renderCandidateList('Error Targets', decision.errorCandidateMessageIds, signalSummary.reductionCandidateChars, 'warn') +
    '</div>' +
    '<div class="policy-signal-list">' +
      locality.signalList.map((signal) => renderSignalCard(signal)).join('') +
    '</div>' +
  '</section>';
}

function selectedSourceBlocks() {
  const selected = new Set(state.editor.selectedSourceIds);
  return state.editor.sourceBlocks.filter((block) => selected.has(block.id));
}

function selectedSourceIndices() {
  const selected = new Set(state.editor.selectedSourceIds);
  return state.editor.sourceBlocks
    .map((block, index) => ({ block, index }))
    .filter((item) => selected.has(item.block.id))
    .map((item) => item.index);
}

function setSourceSelectionRange(start, end) {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const range = state.editor.sourceBlocks.slice(from, to + 1).map((block) => block.id);
  state.editor.selectedSourceIds = range;
  state.editor.lastSourceIndex = end;
}

function toggleSingleSourceSelection(index) {
  const block = state.editor.sourceBlocks[index];
  if (!block) return;
  state.editor.selectedSourceIds = [block.id];
  state.editor.lastSourceIndex = index;
}

function normalizeSelectionFromEvent(index, event) {
  if (event.shiftKey && state.editor.lastSourceIndex != null) {
    setSourceSelectionRange(state.editor.lastSourceIndex, index);
  } else {
    toggleSingleSourceSelection(index);
  }
  renderContextMonitor();
}

function resolveDraftRangeForSelection(selectionIds) {
  const selected = new Set(selectionIds);
  const overlappingIndices = [];
  for (let index = 0; index < state.editor.draftBlocks.length; index += 1) {
    const block = state.editor.draftBlocks[index];
    const refs = Array.isArray(block.sourceRefs) ? block.sourceRefs : [];
    if (refs.some((ref) => selected.has(ref))) {
      overlappingIndices.push(index);
    }
  }
  if (!overlappingIndices.length) {
    return { error: 'The selected source range does not exist in the current draft anymore.' };
  }
  const start = overlappingIndices[0];
  const end = overlappingIndices[overlappingIndices.length - 1];
  if (overlappingIndices.length !== end - start + 1) {
    return { error: 'The selected source range maps to multiple draft islands. Reset the draft before replacing it.' };
  }

  const covered = new Set();
  for (let index = start; index <= end; index += 1) {
    const refs = Array.isArray(state.editor.draftBlocks[index].sourceRefs)
      ? state.editor.draftBlocks[index].sourceRefs
      : [];
    for (const ref of refs) {
      if (!selected.has(ref)) {
        return { error: 'The selected source range partially overlaps an already transformed draft block.' };
      }
      covered.add(ref);
    }
  }
  for (const ref of selectionIds) {
    if (!covered.has(ref)) {
      return { error: 'The selected source range is incomplete in the current draft.' };
    }
  }
  return { start, end };
}

function firstDraftDivergenceIndex() {
  const source = state.editor.sourceBlocks;
  const draft = state.editor.draftBlocks;
  const maxLen = Math.max(source.length, draft.length);
  for (let index = 0; index < maxLen; index += 1) {
    const sourceBlock = source[index] || null;
    const draftBlock = draft[index] || null;
    if (!sourceBlock || !draftBlock) return index;
    if (draftBlock.origin !== 'source') return index;
    if (draftBlock.text !== sourceBlock.text) return index;
    if (draftBlock.role !== sourceBlock.role) return index;
    const refs = Array.isArray(draftBlock.sourceRefs) ? draftBlock.sourceRefs : [];
    if (refs.length !== 1 || refs[0] !== sourceBlock.id) return index;
  }
  return null;
}

function commonPrefixLength(left, right) {
  const lhs = String(left ?? '');
  const rhs = String(right ?? '');
  const max = Math.min(lhs.length, rhs.length);
  let index = 0;
  while (index < max && lhs.charCodeAt(index) === rhs.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function draftCharStats() {
  const source = state.editor.sourceBlocks;
  const draft = state.editor.draftBlocks;
  const totalDraftChars = draft.reduce((sum, block) => sum + Number(block.chars || 0), 0);
  const maxLen = Math.max(source.length, draft.length);
  let cacheChars = 0;
  for (let index = 0; index < maxLen; index += 1) {
    const sourceBlock = source[index] || null;
    const draftBlock = draft[index] || null;
    if (
      sourceBlock &&
      draftBlock &&
      draftBlock.origin === 'source' &&
      Array.isArray(draftBlock.sourceRefs) &&
      draftBlock.sourceRefs.length === 1 &&
      draftBlock.sourceRefs[0] === sourceBlock.id &&
      draftBlock.role === sourceBlock.role &&
      draftBlock.text === sourceBlock.text
    ) {
      cacheChars += Number(draftBlock.chars || 0);
      continue;
    }
    let blockSharedChars = 0;
    if (sourceBlock && draftBlock && draftBlock.role === sourceBlock.role) {
      blockSharedChars = commonPrefixLength(sourceBlock.text, draftBlock.text);
      cacheChars += blockSharedChars;
    }
    return {
      divergenceIndex: index,
      cacheChars,
      newChars: Math.max(0, totalDraftChars - cacheChars),
      blockSharedChars,
    };
  }
  return {
    divergenceIndex: null,
    cacheChars: totalDraftChars,
    newChars: 0,
    blockSharedChars: 0,
  };
}

function sourceMessageCard(block, index, selected) {
  const classes = ['editor-message-card', 'source-card', selected ? 'selected' : ''].filter(Boolean).join(' ');
  return '<article class="' + classes + '">' +
    '<div class="editor-message-head">' +
      '<div>' +
        '<strong>' + escapeHtml(block.title) + '</strong>' +
        '<div class="item-meta">' +
          '<span class="chip">' + escapeHtml(roleLabel(block)) + '</span>' +
          '<span class="chip">#' + fmtNumber(index + 1) + '</span>' +
          '<span class="chip">chars ' + fmtNumber(block.chars) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        '<span class="selection-badge">' + (selected ? 'Selected' : 'Pick') + '</span>' +
        '<button class="ghost-button mini" data-expand-source-id="' + escapeHtml(block.id) + '">Expand</button>' +
      '</div>' +
    '</div>' +
    '<button class="editor-card-body" data-source-index="' + index + '">' +
      '<pre class="segment-text compact">' + escapeHtml(block.text) + '</pre>' +
    '</button>' +
  '</article>';
}

function draftOriginLabel(block) {
  if (block.origin === 'summary') return 'summary';
  if (block.origin === 'reduction') return 'reduced';
  if (block.origin === 'manual') return 'manual';
  return 'source';
}

function draftMessageCard(block, index, divergenceIndex) {
  const classes = [
    'editor-message-card',
    'draft-card',
    divergenceIndex != null && index >= divergenceIndex ? 'draft-changed' : '',
  ].filter(Boolean).join(' ');
  return '<article class="' + classes + '">' +
    '<div class="editor-message-head">' +
      '<div>' +
        '<strong>' + escapeHtml(block.title) + '</strong>' +
        '<div class="item-meta">' +
          '<span class="chip">' + escapeHtml(roleLabel(block)) + '</span>' +
          '<span class="chip">' + escapeHtml(draftOriginLabel(block)) + '</span>' +
          '<span class="chip">chars ' + fmtNumber(block.chars) + '</span>' +
          '<span class="chip">refs ' + fmtNumber((block.sourceRefs || []).length) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button class="ghost-button mini" data-expand-draft-id="' + escapeHtml(block.draftId) + '">Expand</button>' +
        '<button class="ghost-button mini" data-delete-draft-id="' + escapeHtml(block.draftId) + '">Delete</button>' +
      '</div>' +
    '</div>' +
    '<textarea class="draft-textarea" data-draft-id="' + escapeHtml(block.draftId) + '">' + escapeHtml(block.text) + '</textarea>' +
  '</article>';
}

function previewMessageCard(block, index) {
  const classes = ['editor-message-card', 'preview-card'].join(' ');
  return '<article class="' + classes + '" draggable="true" data-preview-id="' + escapeHtml(block.draftId) + '">' +
    '<div class="editor-message-head">' +
      '<div>' +
        '<strong>' + escapeHtml(block.title) + '</strong>' +
        '<div class="item-meta">' +
          '<span class="chip">' + escapeHtml(roleLabel(block)) + '</span>' +
          '<span class="chip">' + escapeHtml(draftOriginLabel(block)) + '</span>' +
          '<span class="chip">chars ' + fmtNumber(block.chars) + '</span>' +
          '<span class="chip">preview #' + fmtNumber(index + 1) + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="ghost-button mini" data-insert-preview-id="' + escapeHtml(block.draftId) + '">Insert At End</button>' +
    '</div>' +
    '<pre class="segment-text compact">' + escapeHtml(block.text) + '</pre>' +
  '</article>';
}

function draftDropZone(index, active) {
  return '<div class="draft-dropzone ' + (active ? 'active' : '') + '" data-drop-index="' + index + '">' +
    '<span>Drop preview here</span>' +
  '</div>';
}

function editorViewportRows(sourceCount, draftCount) {
  const total = Math.max(sourceCount, draftCount, 1);
  return Math.min(total, 10);
}

function sourceBlockById(sourceId) {
  return state.editor.sourceBlocks.find((block) => block.id === sourceId) || null;
}

function draftBlockById(draftId) {
  return state.editor.draftBlocks.find((block) => block.draftId === draftId) || null;
}

function draftForSourceId(sourceId) {
  return state.editor.draftBlocks.find((block) => Array.isArray(block.sourceRefs) && block.sourceRefs.includes(sourceId)) || null;
}

function sourcePreviewForDraftBlock(block) {
  if (!block) return null;
  const refs = Array.isArray(block.sourceRefs) ? block.sourceRefs.slice() : [];
  if (!refs.length) return null;
  const matched = refs.map((ref) => sourceBlockById(ref)).filter(Boolean);
  if (!matched.length) return null;
  if (matched.length === 1) return matched[0];
  return {
    id: 'source-range:' + refs.join(','),
    role: matched[0].role,
    title: 'Mapped Source Range (' + fmtNumber(matched.length) + ' messages)',
    text: matched.map((block) => '[' + block.title + ']\n' + block.text).join('\n\n'),
    chars: matched.reduce((sum, item) => sum + Number(item.chars || 0), 0),
    source: 'editor.mapped.source-range',
  };
}

function expandedEditorPair() {
  const expanded = state.editor.expanded;
  if (!expanded) return null;
  if (expanded.kind === 'source') {
    const sourceBlock = sourceBlockById(expanded.sourceId);
    const draftBlock = sourceBlock ? draftForSourceId(sourceBlock.id) : null;
    return sourceBlock ? { sourceBlock, draftBlock } : null;
  }
  if (expanded.kind === 'draft') {
    const draftBlock = draftBlockById(expanded.draftId);
    const sourceBlock = draftBlock ? sourcePreviewForDraftBlock(draftBlock) : null;
    return draftBlock ? { sourceBlock, draftBlock } : null;
  }
  return null;
}

function expandedModalMarkup() {
  const pair = expandedEditorPair();
  if (!pair) return '';
  const sourceBlock = pair.sourceBlock;
  const draftBlock = pair.draftBlock;
  return '<div class="editor-modal-backdrop" id="editorModalBackdrop">' +
    '<div class="editor-modal">' +
      '<div class="editor-modal-head">' +
        '<div>' +
          '<h4>Expanded Message View</h4>' +
          '<p class="subtitle">Inspect the source version on the left and edit the draft version on the right.</p>' +
        '</div>' +
        '<button class="icon-button" id="editorModalCloseBtn" aria-label="Close expanded message">×</button>' +
      '</div>' +
      '<div class="editor-modal-grid">' +
        '<section class="editor-modal-pane">' +
          '<div class="editor-pane-head">' +
            '<div>' +
              '<h4>Source</h4>' +
              '<p class="subtitle">' + escapeHtml(sourceBlock ? sourceBlock.title : 'No mapped source block') + '</p>' +
            '</div>' +
            '<div class="item-meta">' +
              '<span class="status-pill">' + escapeHtml(sourceBlock ? roleLabel(sourceBlock) : 'none') + '</span>' +
              '<span class="status-pill">chars ' + fmtNumber(sourceBlock ? sourceBlock.chars : 0) + '</span>' +
            '</div>' +
          '</div>' +
          '<pre class="editor-modal-text readonly">' + escapeHtml(sourceBlock ? sourceBlock.text : 'No source block is mapped to this draft message.') + '</pre>' +
        '</section>' +
        '<section class="editor-modal-pane">' +
          '<div class="editor-pane-head">' +
            '<div>' +
              '<h4>Draft</h4>' +
              '<p class="subtitle">' + escapeHtml(draftBlock ? draftBlock.title : 'No mapped draft block') + '</p>' +
            '</div>' +
            '<div class="item-meta">' +
              '<span class="status-pill">' + escapeHtml(draftBlock ? roleLabel(draftBlock) : 'none') + '</span>' +
              '<span class="status-pill">chars ' + fmtNumber(draftBlock ? draftBlock.chars : 0) + '</span>' +
            '</div>' +
          '</div>' +
          (
            draftBlock
              ? '<textarea class="editor-modal-text" id="editorExpandedDraftTextarea" data-expanded-draft-id="' + escapeHtml(draftBlock.draftId) + '">' + escapeHtml(draftBlock.text) + '</textarea>'
              : '<pre class="editor-modal-text readonly">No draft block is mapped to this source message yet.</pre>'
          ) +
        '</section>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function syncLinkedEditorPane(sourceKey, sourcePane) {
  if (!state.editor.syncScrollEnabled || state.editor.syncScrollMute) return;
  if (sourceKey !== 'source' && sourceKey !== 'draft') return;
  const targetKey = sourceKey === 'source' ? 'draft' : 'source';
  const targetPane = el.contextMonitor.querySelector('[data-scroll-pane="' + targetKey + '"]');
  if (!targetPane) return;
  const sourceMax = Math.max(1, sourcePane.scrollHeight - sourcePane.clientHeight);
  const targetMax = Math.max(0, targetPane.scrollHeight - targetPane.clientHeight);
  const ratio = sourcePane.scrollTop / sourceMax;
  state.editor.syncScrollMute = true;
  targetPane.scrollTop = ratio * targetMax;
  state.editor.scrollTopByPane[targetKey] = targetPane.scrollTop;
  state.editor.syncScrollMute = false;
}

function saveEditorScrollPositions() {
  if (!el.contextMonitor) return;
  for (const pane of el.contextMonitor.querySelectorAll('[data-scroll-pane]')) {
    const key = pane.dataset.scrollPane;
    if (!key) continue;
    state.editor.scrollTopByPane[key] = pane.scrollTop;
  }
}

function restoreEditorScrollPositions() {
  if (!el.contextMonitor) return;
  const shouldJumpToLatest = state.editor.pendingScrollToLatest;
  for (const pane of el.contextMonitor.querySelectorAll('[data-scroll-pane]')) {
    const key = pane.dataset.scrollPane;
    if (!key) continue;
    if (shouldJumpToLatest && (key === 'source' || key === 'draft')) {
      pane.scrollTop = pane.scrollHeight;
      state.editor.scrollTopByPane[key] = pane.scrollTop;
    } else {
      pane.scrollTop = Number(state.editor.scrollTopByPane[key] || 0);
    }
    pane.addEventListener('scroll', () => {
      state.editor.scrollTopByPane[key] = pane.scrollTop;
      syncLinkedEditorPane(key, pane);
    });
  }
  if (shouldJumpToLatest) {
    state.editor.pendingScrollToLatest = false;
  }
}

function insertPreviewBlockIntoDraft(previewId, insertIndex) {
  const previewBlock = state.editor.previewBlocks.find((block) => block.draftId === previewId);
  if (!previewBlock) return false;
  const safeIndex = Math.max(0, Math.min(insertIndex, state.editor.draftBlocks.length));
  const nextBlock = createDraftBlock(previewBlock, {
    role: previewBlock.role,
    title: previewBlock.title,
    text: previewBlock.text,
    source: previewBlock.source,
    sourceRefs: Array.isArray(previewBlock.sourceRefs) ? previewBlock.sourceRefs.slice() : [],
    origin: previewBlock.origin,
    derivedLabel: previewBlock.derivedLabel,
  });
  state.editor.draftBlocks.splice(safeIndex, 0, nextBlock);
  rebuildDraftChars();
  state.editor.notice = 'Inserted one generated block into the draft.';
  return true;
}

function renderObserveMonitor() {
  const conversation = buildContextTreeNodes(actualConversation());
  if (!conversation.length) {
    renderEmpty(el.contextMonitor, 'No true upstream payload was captured for this turn yet.');
    return;
  }
  el.contextMonitor.innerHTML =
    '<div class="observe-stack">' +
      localityPanel(state.detail) +
      '<div class="context-tree">' +
        conversation.map((node, index) => conversationNodeCard(node, index, conversation.length)).join('') +
      '</div>' +
    '</div>';
}

function renderEditorMonitor() {
  saveEditorScrollPositions();
  const sourceBlocks = state.editor.sourceBlocks;
  const draftBlocks = state.editor.draftBlocks;
  const previewBlocks = state.editor.previewBlocks;
  if (!sourceBlocks.length) {
    renderEmpty(el.contextMonitor, 'No forwarded conversation is available for this turn, so draft editing is unavailable.');
    return;
  }

  const selected = new Set(state.editor.selectedSourceIds);
  const selectedBlocks = selectedSourceBlocks();
  const divergenceIndex = firstDraftDivergenceIndex();
  const charStats = draftCharStats();
  const sourceChars = sourceBlocks.reduce((sum, block) => sum + Number(block.chars || 0), 0);
  const draftChars = draftBlocks.reduce((sum, block) => sum + Number(block.chars || 0), 0);
  const viewportRows = editorViewportRows(sourceBlocks.length, draftBlocks.length);

  el.contextMonitor.innerHTML =
    '<div class="editor-workbench">' +
    '<div class="editor-shell">' +
      '<section class="editor-pane">' +
        '<div class="editor-pane-head">' +
          '<div>' +
            '<h4>Replay Baseline</h4>' +
            '<p class="subtitle">Replay baseline for the active branch. Click to select one message. Use Shift-click to extend a contiguous range.</p>' +
          '</div>' +
          '<div class="item-meta">' +
            '<span class="status-pill">blocks ' + fmtNumber(sourceBlocks.length) + '</span>' +
            '<span class="status-pill">chars ' + fmtNumber(sourceChars) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="editor-scroll-window" data-scroll-pane="source" style="--editor-viewport-rows:' + viewportRows + ';">' +
          '<div class="editor-message-list editor-source-list">' +
            sourceBlocks.map((block, index) => sourceMessageCard(block, index, selected.has(block.id))).join('') +
          '</div>' +
        '</div>' +
      '</section>' +
      '<section class="editor-rail">' +
        '<div class="editor-rail-card">' +
          '<h4>Actions</h4>' +
          '<p class="subtitle">Generate summary or reduction candidates from the selected range, then drag the result into the draft on the right.</p>' +
          '<div class="editor-selection-summary">' +
            '<span class="status-pill ' + (selectedBlocks.length ? 'cool' : '') + '">selected ' + fmtNumber(selectedBlocks.length) + '</span>' +
            '<span class="status-pill">source chars ' + fmtNumber(selectedBlocks.reduce((sum, block) => sum + (block.chars || 0), 0)) + '</span>' +
          '</div>' +
          '<label class="editor-toggle-row">' +
            '<input type="checkbox" id="syncScrollToggle"' + (state.editor.syncScrollEnabled ? ' checked' : '') + ' />' +
            '<span>Sync Scroll</span>' +
          '</label>' +
          '<div class="editor-action-stack">' +
            '<button class="primary-button" id="summarySelectionBtn"' + (selectedBlocks.length ? '' : ' disabled') + '>Generate Summary</button>' +
            '<button class="ghost-button rail-button" id="reductionSelectionBtn"' + (selectedBlocks.length ? '' : ' disabled') + '>Generate Reduction</button>' +
            '<button class="ghost-button rail-button" id="clearSelectionBtn"' + (selectedBlocks.length ? '' : ' disabled') + '>Clear Selection</button>' +
            '<button class="ghost-button rail-button" id="resetDraftBtn">Reset Draft</button>' +
            '<button class="ghost-button rail-button" id="applyDraftBtn"' + (divergenceIndex == null || state.editor.busy ? ' disabled' : '') + '>Apply Draft</button>' +
          '</div>' +
          '<div class="editor-note ' + (state.editor.notice ? 'visible' : '') + '">' +
            escapeHtml(state.editor.notice || 'Generated summaries and reductions appear in the candidate tray below. Drag them into the draft when you want to use them.') +
          '</div>' +
        '</div>' +
      '</section>' +
      '<section class="editor-pane">' +
        '<div class="editor-pane-head">' +
          '<div>' +
            '<h4>Draft Branch</h4>' +
            '<p class="subtitle">Editable replay candidate. Divergence stays explicit: shared prefix remains reusable, and changed suffix becomes the new branch replay baseline after apply.</p>' +
          '</div>' +
          '<div class="item-meta">' +
            '<span class="status-pill">blocks ' + fmtNumber(draftBlocks.length) + '</span>' +
            '<span class="status-pill">chars ' + fmtNumber(draftChars) + '</span>' +
            '<span class="status-pill">cache chars ' + fmtNumber(charStats.cacheChars) + '</span>' +
            '<span class="status-pill ' + (charStats.newChars > 0 ? 'warn' : '') + '">new chars ' + fmtNumber(charStats.newChars) + '</span>' +
            '<span class="status-pill ' + (divergenceIndex == null ? '' : 'warn') + '">' +
              (divergenceIndex == null ? 'matches source' : 'diverges at #' + fmtNumber(divergenceIndex + 1)) +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div class="editor-scroll-window" data-scroll-pane="draft" style="--editor-viewport-rows:' + viewportRows + ';">' +
          '<div class="editor-message-list editor-draft-list">' +
            draftDropZone(0, divergenceIndex === 0) +
            draftBlocks.map((block, index) => draftMessageCard(block, index, divergenceIndex) + draftDropZone(index + 1, false)).join('') +
          '</div>' +
        '</div>' +
      '</section>' +
    '</div>' +
    '<section class="editor-candidate-stage">' +
      '<div class="editor-candidate-head">' +
        '<div>' +
          '<h4>Generated Blocks</h4>' +
          '<p class="subtitle">Summary and reduction candidates live here. They are not applied until you drag them into the draft.</p>' +
        '</div>' +
        '<div class="item-meta">' +
          '<span class="status-pill">candidates ' + fmtNumber(previewBlocks.length) + '</span>' +
          (
            state.editor.previewMeta
              ? '<span class="status-pill">from ' + fmtNumber(state.editor.previewMeta.originalChars || 0) + ' chars</span>' +
                '<span class="status-pill cool">to ' + fmtNumber(state.editor.previewMeta.replacementChars || 0) + ' chars</span>'
              : ''
          ) +
        '</div>' +
      '</div>' +
      (
        previewBlocks.length
          ? '<div class="editor-scroll-window editor-candidate-window" data-scroll-pane="candidate">' +
              '<div class="editor-candidate-list">' +
                previewBlocks.map((block, index) => previewMessageCard(block, index)).join('') +
              '</div>' +
            '</div>'
          : '<div class="empty-state">No generated blocks yet.</div>'
      ) +
    '</section>' +
    '</div>' +
    expandedModalMarkup();

  for (const button of el.contextMonitor.querySelectorAll('[data-source-index]')) {
    button.addEventListener('click', (event) => {
      const index = Number(button.dataset.sourceIndex);
      if (!Number.isFinite(index)) return;
      normalizeSelectionFromEvent(index, event);
    });
  }

  for (const button of el.contextMonitor.querySelectorAll('[data-expand-source-id]')) {
    button.addEventListener('click', () => {
      const sourceId = button.dataset.expandSourceId;
      if (!sourceId) return;
      state.editor.expanded = { kind: 'source', sourceId };
      renderContextMonitor();
    });
  }

  for (const button of el.contextMonitor.querySelectorAll('[data-expand-draft-id]')) {
    button.addEventListener('click', () => {
      const draftId = button.dataset.expandDraftId;
      if (!draftId) return;
      state.editor.expanded = { kind: 'draft', draftId };
      renderContextMonitor();
    });
  }

  for (const textarea of el.contextMonitor.querySelectorAll('[data-draft-id]')) {
    textarea.addEventListener('input', () => {
      const draftId = textarea.dataset.draftId;
      const block = state.editor.draftBlocks.find((item) => item.draftId === draftId);
      if (!block) return;
      block.text = textarea.value;
      if (block.origin === 'source') block.origin = 'manual';
      block.chars = textarea.value.length;
      renderContextSummary();
    });
    textarea.addEventListener('blur', () => {
      renderContextMonitor();
    });
  }

  for (const button of el.contextMonitor.querySelectorAll('[data-delete-draft-id]')) {
    button.addEventListener('click', () => {
      const draftId = button.dataset.deleteDraftId;
      state.editor.draftBlocks = state.editor.draftBlocks.filter((block) => block.draftId !== draftId);
      state.editor.notice = 'Removed one draft block.';
      rebuildDraftChars();
      renderContextMonitor();
      renderContextSummary();
    });
  }

  for (const card of el.contextMonitor.querySelectorAll('[data-preview-id]')) {
    card.addEventListener('dragstart', (event) => {
      const previewId = card.dataset.previewId;
      if (!previewId) return;
      state.editor.dragPreviewId = previewId;
      if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', previewId);
        event.dataTransfer.effectAllowed = 'copy';
      }
    });
    card.addEventListener('dragend', () => {
      state.editor.dragPreviewId = null;
      for (const zone of el.contextMonitor.querySelectorAll('[data-drop-index]')) {
        zone.classList.remove('over');
      }
    });
  }

  for (const button of el.contextMonitor.querySelectorAll('[data-insert-preview-id]')) {
    button.addEventListener('click', () => {
      const previewId = button.dataset.insertPreviewId;
      if (!previewId) return;
      if (insertPreviewBlockIntoDraft(previewId, state.editor.draftBlocks.length)) {
        renderContextMonitor();
        renderContextSummary();
      }
    });
  }

  for (const zone of el.contextMonitor.querySelectorAll('[data-drop-index]')) {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('over');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('over');
      const previewId =
        (event.dataTransfer && event.dataTransfer.getData('text/plain')) ||
        state.editor.dragPreviewId;
      const insertIndex = Number(zone.dataset.dropIndex);
      if (!previewId || !Number.isFinite(insertIndex)) return;
      if (insertPreviewBlockIntoDraft(previewId, insertIndex)) {
        state.editor.dragPreviewId = null;
        renderContextMonitor();
        renderContextSummary();
      }
    });
  }

  restoreEditorScrollPositions();

  const syncToggle = document.getElementById('syncScrollToggle');
  if (syncToggle) {
    syncToggle.addEventListener('change', () => {
      state.editor.syncScrollEnabled = Boolean(syncToggle.checked);
      state.editor.notice = state.editor.syncScrollEnabled
        ? 'Source and draft panes now scroll together.'
        : 'Source and draft panes now scroll independently.';
      if (state.editor.syncScrollEnabled) {
        const sourcePane = el.contextMonitor.querySelector('[data-scroll-pane="source"]');
        if (sourcePane) syncLinkedEditorPane('source', sourcePane);
      }
      renderContextSummary();
    });
  }

  const modalCloseBtn = document.getElementById('editorModalCloseBtn');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      state.editor.expanded = null;
      renderContextMonitor();
    });
  }

  const modalBackdrop = document.getElementById('editorModalBackdrop');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (event) => {
      if (event.target !== modalBackdrop) return;
      state.editor.expanded = null;
      renderContextMonitor();
    });
  }

  const expandedDraftTextarea = document.getElementById('editorExpandedDraftTextarea');
  if (expandedDraftTextarea) {
    expandedDraftTextarea.addEventListener('input', () => {
      const draftId = expandedDraftTextarea.dataset.expandedDraftId;
      const block = state.editor.draftBlocks.find((item) => item.draftId === draftId);
      if (!block) return;
      block.text = expandedDraftTextarea.value;
      if (block.origin === 'source') block.origin = 'manual';
      block.chars = expandedDraftTextarea.value.length;
      renderContextSummary();
    });
  }

  const summaryBtn = document.getElementById('summarySelectionBtn');
  if (summaryBtn) {
    summaryBtn.addEventListener('click', async () => {
      await applyEditorTransform('summary');
    });
  }
  const reductionBtn = document.getElementById('reductionSelectionBtn');
  if (reductionBtn) {
    reductionBtn.addEventListener('click', async () => {
      await applyEditorTransform('reduction');
    });
  }
  const clearBtn = document.getElementById('clearSelectionBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.editor.selectedSourceIds = [];
      state.editor.notice = 'Cleared the current source selection.';
      renderContextMonitor();
      renderContextSummary();
    });
  }
  const resetBtn = document.getElementById('resetDraftBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetEditorFromDetail(state.detail);
      state.editor.notice = 'Draft reset to the original forwarded timeline.';
      renderContextMonitor();
      renderContextSummary();
    });
  }
  const applyBtn = document.getElementById('applyDraftBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      await applyDraftPlanFromEditor();
    });
  }
}

function renderContextSummary() {
  const detail = state.detail;
  if (!detail) {
    el.contextSummaryBar.innerHTML = '';
    return;
  }
  el.contextSummaryBar.innerHTML = contextSummaryPills(detail)
    .map((pill) => '<span class="status-pill ' + pill.cls + '">' + escapeHtml(pill.text) + '</span>')
    .join('');
}

function renderContextMonitor() {
  const detail = state.detail;
  if (!detail) {
    renderEmpty(el.contextMonitor, 'Select a turn to inspect its context.');
    el.contextSummaryBar.innerHTML = '';
    return;
  }
  renderContextSummary();
  if (state.editorMode === 'edit') {
    renderEditorMonitor();
    return;
  }
  renderObserveMonitor();
}

function renderActionStatus() {
  const pills = [];
  if (state.actionBusy) pills.push('<span class="status-pill warn">applying branch action…</span>');
  if (state.actionStatus) pills.push('<span class="status-pill cool">' + escapeHtml(state.actionStatus) + '</span>');
  el.actionStatusBar.innerHTML = pills.join('');
  const disabled = !state.detail || state.actionBusy;
  el.forkBtn.disabled = disabled;
  el.revertBtn.disabled = disabled;
  el.observeModeBtn.classList.toggle('active', state.editorMode === 'observe');
  el.editModeBtn.classList.toggle('active', state.editorMode === 'edit');
}

function renderModeChrome() {
  const observe = state.editorMode === 'observe';
  if (el.turnModeLabel) {
    el.turnModeLabel.textContent = observe ? 'Actual Payload' : 'Replay Baseline';
  }
  if (el.contextPanelTitle) {
    el.contextPanelTitle.textContent = observe ? 'Actual Payload' : 'Replay Baseline';
  }
  if (el.contextPanelSubtitle) {
    el.contextPanelSubtitle.textContent = observe
      ? 'Observe the exact forwarded payload captured for this turn. If no real payload was captured, this view stays unavailable.'
      : 'Edit the active branch replay baseline. Apply Draft updates the branch baseline; the next real user message materializes a new actual payload.';
  }
}

async function applyEditorTransform(mode) {
  if (state.editor.busy) return;
  const selectedIds = state.editor.selectedSourceIds.slice();
  if (!selectedIds.length) {
    state.editor.notice = 'Select a contiguous source range first.';
    renderContextMonitor();
    return;
  }
  const selectedBlocks = selectedSourceBlocks();
  state.editor.busy = true;
  state.editor.notice = 'Generating ' + mode + ' candidate blocks from the selected range…';
  renderContextMonitor();
  try {
    const preview = await postJson('/api/editor/transform', {
      mode,
      blocks: selectedBlocks,
    });
    const sourceRefsList =
      mode === 'reduction' && preview.replacementBlocks.length === selectedIds.length
        ? preview.replacementBlocks.map((_, index) => [selectedIds[index]])
        : preview.replacementBlocks.map(() => selectedIds.slice());
    const previewDraft = preview.replacementBlocks.map((block, index) =>
      createDraftBlock(block, {
        role: block.role,
        title: block.title,
        text: block.text,
        source: block.source,
        sourceRefs: sourceRefsList[index],
        origin: mode,
        derivedLabel: mode,
      }),
    );
    state.editor.previewBlocks = previewDraft;
    state.editor.previewMeta = preview.meta || null;
    state.editor.notice = preview.meta?.note || ('Generated ' + mode + ' candidate blocks. Drag them into the draft when you want to use them.');
  } catch (error) {
    state.editor.notice = mode + ' preview failed: ' + (error?.message || String(error));
  } finally {
    state.editor.busy = false;
    renderContextMonitor();
    renderContextSummary();
  }
}

async function applyDraftPlanFromEditor() {
  if (!state.traceId || state.editor.busy) return;
  const divergenceIndex = firstDraftDivergenceIndex();
  if (divergenceIndex == null) {
    state.editor.notice = 'Draft still matches the source timeline; nothing to apply.';
    renderContextMonitor();
    return;
  }
  state.editor.busy = true;
  state.editor.notice = 'Creating a new branch, writing the apply plan, and materializing the changed suffix…';
  renderContextMonitor();
  try {
    const result = await postJson('/api/editor/apply-draft', {
      traceId: state.traceId,
      draftBlocks: state.editor.draftBlocks,
    });
    state.actionStatus =
      'Draft applied. Future TUI messages now replay from ' +
      (result.physicalSessionId || 'the new branch') +
      ' (anchor ' +
      (result.anchorTraceId || state.traceId) +
      ').';
    state.editor.notice =
      'Apply completed: diff at #' + fmtNumber((result.divergenceIndex ?? 0) + 1) +
      ', cache chars=' + fmtNumber(result.cacheChars) +
      ', new chars=' + fmtNumber(result.newChars) +
      ', seed blocks=' + fmtNumber(result.seedBlockCount) +
      ', user turns=' + fmtNumber(result.userTurnCount) +
      ', materialized turns=' + fmtNumber(result.materializedTurnCount) +
      (result.seedTextPreview ? '. Seed preview: ' + result.seedTextPreview : '.');
    await loadOverview();
    state.traceId = result.traceId || state.traceId;
    await loadDetail(state.traceId);
    state.editorMode = 'edit';
    state.editor.notice =
      'Apply completed on branch ' + (result.physicalSessionId || 'new branch') +
      '. Future TUI messages now replay from this branch. Shared prefix is preserved as cacheable context, and the changed suffix has been materialized into branch-local turns.';
  } catch (error) {
    state.editor.notice = 'Apply Draft failed: ' + (error?.message || String(error));
  } finally {
    state.editor.busy = false;
    renderActionStatus();
    renderContextMonitor();
    renderTurnTree();
  }
}

function renderDetail() {
  const detail = state.detail;
  if (!detail) {
    el.turnTitle.textContent = 'Select a turn';
    el.turnSubtitle.textContent = 'Observe the exact model-facing payload, or switch to edit mode for the branch replay baseline.';
    state.actionStatus = '';
    renderModeChrome();
    renderActionStatus();
    renderContextMonitor();
    renderTurnTree();
    return;
  }
  const turnNode = selectedTurnNode();
  const activeNode = activeReplayNode();
  const selectedBranchLabel = turnNode?.branchLabel || detail.physicalSessionId || detail.sessionId;
  const selectedPhysicalSessionId = turnNode?.physicalSessionId || detail.physicalSessionId || detail.sessionId;
  const activeBranchLabel = activeNode?.branchLabel || detail.turnTree?.activePhysicalSessionId || detail.sessionId;
  const activePhysicalSessionId = activeNode?.physicalSessionId || detail.turnTree?.activePhysicalSessionId || detail.sessionId;
  el.turnTitle.textContent = detail.promptPreview || '(empty prompt)';
  el.turnSubtitle.textContent =
    detail.sessionId +
    ' • selected branch ' + selectedBranchLabel +
    ' • active replay ' + activeBranchLabel +
    ' • selected physical ' + selectedPhysicalSessionId +
    ' • active physical ' + activePhysicalSessionId +
    ' • ' + detail.provider + '/' + detail.model +
    ' • ' + fmtDate(detail.at);
  renderModeChrome();
  renderActionStatus();
  renderContextMonitor();
  renderTurnTree();
}

async function loadOverview() {
  state.overview = await getJson('/api/overview');
  if (!state.sessionId) {
    state.sessionId = state.overview.sessions?.[0]?.id ?? null;
  }
  renderSessions();
  if (state.sessionId) {
    await loadTurns(state.sessionId);
  } else {
    renderTurns();
  }
}

async function loadTurns(sessionId) {
  state.turns = await getJson('/api/session-turns?sessionId=' + encodeURIComponent(sessionId));
  const turns = visibleTurns();
  state.traceId = turns?.[0]?.traceId ?? state.turns?.[0]?.traceId ?? null;
  renderTurns();
  if (state.traceId) {
    await loadDetail(state.traceId);
  } else {
    state.detail = null;
    renderDetail();
  }
}

async function loadDetail(traceId) {
  state.detail = await getJson('/api/turn?traceId=' + encodeURIComponent(traceId));
  state.traceId = state.detail?.traceId || traceId;
  resetEditorFromDetail(state.detail);
  renderDetail();
}

async function applyBranchAction(action) {
  if (!state.traceId || state.actionBusy) return;
  state.actionBusy = true;
  state.actionStatus = '';
  renderActionStatus();
  try {
    const result = await postJson('/api/branch-action', {
      traceId: state.traceId,
      action,
    });
    await loadOverview();
    state.traceId = result.traceId || state.traceId;
    await loadDetail(state.traceId);
    state.actionStatus =
      (action === 'fork' ? 'Forked' : 'Reverted') +
      ' logical head to ' +
      (result.physicalSessionId || 'new branch') +
      '. Future TUI messages now replay from that branch.';
  } catch (error) {
    state.actionStatus = 'Branch action failed: ' + (error?.message || String(error));
  } finally {
    state.actionBusy = false;
    renderActionStatus();
    renderTurnTree();
  }
}

el.drawerOpenBtn.addEventListener('click', openDrawer);
el.drawerCloseBtn.addEventListener('click', closeDrawer);
el.drawerBackdrop.addEventListener('click', closeDrawer);
el.branchDrawerOpenBtn.addEventListener('click', openBranchDrawer);
el.branchDrawerCloseBtn.addEventListener('click', closeBranchDrawer);
el.branchDrawerBackdrop.addEventListener('click', closeBranchDrawer);
el.forkBtn.addEventListener('click', async () => {
  await applyBranchAction('fork');
});
el.revertBtn.addEventListener('click', async () => {
  await applyBranchAction('revert');
});
el.observeModeBtn.addEventListener('click', () => {
  state.editorMode = 'observe';
  renderDetail();
});
el.editModeBtn.addEventListener('click', () => {
  state.editorMode = 'edit';
  state.editor.pendingScrollToLatest = true;
  renderDetail();
});
el.refreshBtn.addEventListener('click', async () => {
  await loadOverview();
});

loadOverview().catch((error) => {
  console.error(error);
  renderEmpty(el.sessionsList, 'Failed to load dashboard data. ' + error.message);
});
