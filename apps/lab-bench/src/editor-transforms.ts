export type EditorConversationBlock = {
  id?: string;
  role?: string;
  title?: string;
  text?: string;
  chars?: number;
  source?: string;
  payloadKind?: string;
  toolName?: string;
};

export type EditorPreviewBlock = {
  role: "system" | "user" | "assistant" | "tool";
  title: string;
  text: string;
  chars: number;
  source: string;
};

export type EditorTransformPreview = {
  mode: "summary" | "reduction";
  replacementBlocks: EditorPreviewBlock[];
  meta: {
    selectedCount: number;
    originalChars: number;
    replacementChars: number;
    note: string;
  };
};

type NormalizedBlock = {
  role: "system" | "user" | "assistant" | "tool";
  title: string;
  text: string;
  chars: number;
  source: string;
  payloadKind?: string;
  toolName?: string;
};

function clipText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

function normalizeRole(value: unknown): NormalizedBlock["role"] {
  const role = String(value ?? "user").trim().toLowerCase();
  if (role === "system") return "system";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  return "user";
}

function normalizeBlocks(input: unknown): NormalizedBlock[] {
  if (!Array.isArray(input)) return [];
  const out: NormalizedBlock[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = String(record.text ?? "").trim();
    if (!text) continue;
    const title = String(record.title ?? "").trim() || "Message";
    out.push({
      role: normalizeRole(record.role),
      title,
      text,
      chars: text.length,
      source: String(record.source ?? "editor.preview"),
      payloadKind:
        typeof record.payloadKind === "string" && record.payloadKind.trim().length > 0
          ? record.payloadKind.trim()
          : undefined,
      toolName:
        typeof record.toolName === "string" && record.toolName.trim().length > 0
          ? record.toolName.trim()
          : undefined,
    });
  }
  return out;
}

function renderSummaryText(blocks: NormalizedBlock[]): string {
  const bullets = blocks.slice(0, 6).map((block) => {
    if (block.role === "system") {
      return "- Developer/system context describing the assistant role, tool access, session rules, and runtime constraints.";
    }
    if (block.role === "user") {
      return `- User request: ${clipText(block.text, 220)}`;
    }
    if (block.role === "assistant") {
      return `- Assistant response: ${clipText(block.text, 220)}`;
    }
    return `- Tool output${block.toolName ? ` (${block.toolName})` : ""}: ${clipText(block.text, 220)}`;
  });
  if (blocks.length > 6) {
    bullets.push(`- ${blocks.length - 6} additional selected messages were omitted from this compact summary.`);
  }
  return [
    "Compact summary of the selected context:",
    "",
    ...(bullets.length > 0 ? bullets : ["- No non-empty messages were available."]),
  ].join("\n");
}

function summarizeStructuredBlock(label: string, text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const head = lines.slice(0, 6);
  const tail = lines.slice(-4);
  const omitted = Math.max(0, lines.length - head.length - tail.length);
  return [
    ...head,
    `...[${label} reduced: omittedLines=${omitted} originalChars=${text.length}]`,
    ...tail,
  ].join("\n").trim();
}

function slimTextByRole(block: NormalizedBlock): string {
  let next = block.text;
  next = next.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/\n```/g, "");
  next = next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (block.role === "tool" || block.payloadKind === "json") {
    return summarizeStructuredBlock("json/tool", next, 900);
  }
  if (block.payloadKind === "stdout" || block.payloadKind === "stderr") {
    return summarizeStructuredBlock(block.payloadKind, next, 1000);
  }
  if (next.length > 1200) {
    return `${next.slice(0, 700)}\n\n...[reduced text, originalChars=${next.length}]...\n\n${next.slice(-260)}`.trim();
  }
  return next;
}

export function buildSummaryPreview(input: unknown): EditorTransformPreview {
  const blocks = normalizeBlocks(input);
  const originalChars = blocks.reduce((sum, block) => sum + block.chars, 0);
  const text = renderSummaryText(blocks);
  return {
    mode: "summary",
    replacementBlocks: [
      {
        role: "assistant",
        title: `Generated Summary`,
        text,
        chars: text.length,
        source: "editor.preview.summary",
      },
    ],
    meta: {
      selectedCount: blocks.length,
      originalChars,
      replacementChars: text.length,
      note: "Generated one summary candidate block. Drag it into the draft if you want to use it.",
    },
  };
}

export function buildReductionPreview(input: unknown): EditorTransformPreview {
  const blocks = normalizeBlocks(input);
  const replacementBlocks = blocks.map((block, index) => {
    const text = slimTextByRole(block);
    const changed = text !== block.text;
    return {
      role: block.role,
      title: changed ? `${block.title} [Reduced]` : `${block.title} [Unchanged]`,
      text,
      chars: text.length,
      source: changed ? "editor.preview.reduction" : block.source || `editor.preview.${index + 1}`,
    } satisfies EditorPreviewBlock;
  });
  const originalChars = blocks.reduce((sum, block) => sum + block.chars, 0);
  const replacementChars = replacementBlocks.reduce((sum, block) => sum + block.chars, 0);
  return {
    mode: "reduction",
    replacementBlocks,
    meta: {
      selectedCount: blocks.length,
      originalChars,
      replacementChars,
      note: "Generated reduced candidate blocks while preserving message boundaries. Drag the ones you want into the draft.",
    },
  };
}
