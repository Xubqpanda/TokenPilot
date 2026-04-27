/* eslint-disable @typescript-eslint/no-explicit-any */
import { runReductionAfterCall, resolveReductionPasses } from "../../execution/reduction/pipeline.js";
import type { RuntimeTurnResult } from "../../../../kernel/src/types.js";

export type AfterCallPassToggles = {
  repeatedReadDedup?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
};

export type ProxyAfterCallReductionResult = {
  changed: boolean;
  savedChars: number;
  passCount: number;
  skippedReason?: string;
  report?: Array<any>;
  mode?: "json" | "sse";
  patchedEvents?: number;
};

type AfterCallHelpers = {
  buildLayeredReductionContext: (
    payload: any,
    triggerMinChars: number,
    sessionId: string,
    passToggles?: AfterCallPassToggles,
    passOptions?: Record<string, Record<string, unknown>>,
  ) => { turnCtx: any };
  isReductionPassEnabled: (passId: string, passToggles?: AfterCallPassToggles) => boolean;
};

export function extractProxyResponseText(parsedResponse: any): string {
  if (!parsedResponse || typeof parsedResponse !== "object") return "";
  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text.trim().length > 0) {
    return parsedResponse.output_text;
  }
  const response = parsedResponse?.response;
  if (response && typeof response === "object") {
    return extractProxyResponseText(response);
  }
  const output = Array.isArray(parsedResponse?.output) ? parsedResponse.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "output_text" && typeof item.text === "string" && item.text.trim().length > 0) {
      return item.text;
    }
    if (type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        if (String(block.type ?? "").toLowerCase() !== "output_text") continue;
        if (typeof block.text === "string" && block.text.trim().length > 0) {
          return block.text;
        }
      }
    }
  }
  return "";
}

export function patchProxyResponseText(parsedResponse: any, nextText: string): boolean {
  if (!parsedResponse || typeof parsedResponse !== "object") return false;
  let changed = false;

  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text !== nextText) {
    parsedResponse.output_text = nextText;
    changed = true;
  }

  const output = Array.isArray(parsedResponse.output) ? parsedResponse.output : [];
  let replacedNested = false;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "output_text" && typeof item.text === "string") {
      if (item.text !== nextText) {
        item.text = nextText;
        changed = true;
      }
      replacedNested = true;
      break;
    }
    if (type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        if (String(block.type ?? "").toLowerCase() !== "output_text") continue;
        if (typeof block.text !== "string") continue;
        if (block.text !== nextText) {
          block.text = nextText;
          changed = true;
        }
        replacedNested = true;
        break;
      }
      if (replacedNested) break;
    }
  }

  return changed;
}

export function isSseContentType(contentType: string | null | undefined): boolean {
  return String(contentType ?? "").toLowerCase().includes("text/event-stream");
}

function rewriteSseJsonEvents(
  rawSse: string,
  mutator: (event: any) => boolean,
): { text: string; parsedEvents: number; changedEvents: number } {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return { text: normalized, parsedEvents: 0, changedEvents: 0 };
  const blocks = normalized.split(/\r?\n\r?\n/u);
  let parsedEvents = 0;
  let changedEvents = 0;
  const rewrittenBlocks = blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return block;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") return block;
    let parsed: any = null;
    try {
      parsed = JSON.parse(payloadText);
      parsedEvents += 1;
    } catch {
      return block;
    }
    if (!mutator(parsed)) return block;
    changedEvents += 1;
    const nonData = lines.filter((line) => !line.startsWith("data:"));
    return [...nonData, `data: ${JSON.stringify(parsed)}`].join("\n");
  });
  const text = rewrittenBlocks.join("\n\n");
  return { text, parsedEvents, changedEvents };
}

function collectSseOutputText(rawSse: string): string {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return "";
  const blocks = normalized.split(/\r?\n\r?\n/u);
  const doneTexts: string[] = [];
  let deltaText = "";
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const event = JSON.parse(payloadText) as any;
      const type = String(event?.type ?? "").toLowerCase();
      if (type === "response.output_text.done" && typeof event?.text === "string" && event.text.trim().length > 0) {
        doneTexts.push(event.text);
        continue;
      }
      if (type === "response.content_part.done") {
        const partType = String(event?.part?.type ?? "").toLowerCase();
        if (partType === "output_text" && typeof event?.part?.text === "string" && event.part.text.trim().length > 0) {
          doneTexts.push(event.part.text);
          continue;
        }
      }
      if (type === "response.output_text.delta" && typeof event?.delta === "string") {
        deltaText += event.delta;
      }
    } catch {
      // ignore malformed fragments
    }
  }
  if (doneTexts.length > 0) return doneTexts.join("\n").trim();
  return deltaText.trim();
}

function patchSseEventForReducedText(event: any, nextText: string): boolean {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type ?? "").toLowerCase();
  let changed = false;
  if (type === "response.output_text.done" && typeof event.text === "string" && event.text !== nextText) {
    event.text = nextText;
    changed = true;
  }
  if (type === "response.content_part.done" && event.part && typeof event.part === "object") {
    const partType = String(event.part.type ?? "").toLowerCase();
    if (partType === "output_text" && typeof event.part.text === "string" && event.part.text !== nextText) {
      event.part.text = nextText;
      changed = true;
    }
  }
  if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
    changed = patchProxyResponseText(event.item, nextText) || changed;
  }
  if (type === "response.completed" && event.response && typeof event.response === "object") {
    changed = patchProxyResponseText(event.response, nextText) || changed;
  }
  return changed;
}

export async function applyLayeredReductionAfterCall(
  requestPayload: any,
  parsedResponse: any,
  maxToolChars: number,
  triggerMinChars: number,
  passToggles: AfterCallPassToggles | undefined,
  passOptions: Record<string, Record<string, unknown>> | undefined,
  helpers: AfterCallHelpers,
): Promise<ProxyAfterCallReductionResult> {
  const responseText = extractProxyResponseText(parsedResponse);
  if (!responseText) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "empty_response_text" };
  }

  const { turnCtx } = helpers.buildLayeredReductionContext(
    requestPayload,
    triggerMinChars,
    "proxy-session",
    passToggles,
    passOptions,
  );
  const passes = resolveReductionPasses({ maxToolChars, passOptions }).filter(
    (p) => p.phase === "after_call" && helpers.isReductionPassEnabled(p.id, passToggles),
  );
  if (passes.length === 0) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "no_after_call_passes" };
  }

  const result: RuntimeTurnResult = {
    content: responseText,
    metadata: {},
  };
  const { result: reducedResult, report: afterReport } = await runReductionAfterCall({
    turnCtx,
    result,
    passes,
  });

  const nextText = String(reducedResult?.content ?? "");
  if (!nextText || nextText === responseText) {
    return {
      changed: false,
      savedChars: 0,
      passCount: passes.length,
      skippedReason: "pipeline_no_effect",
      report: afterReport,
    };
  }

  const patched = patchProxyResponseText(parsedResponse, nextText);
  if (!patched) {
    return {
      changed: false,
      savedChars: 0,
      passCount: passes.length,
      skippedReason: "response_patch_no_effect",
      report: afterReport,
    };
  }
  return {
    changed: true,
    savedChars: Math.max(0, responseText.length - nextText.length),
    passCount: passes.length,
    report: afterReport,
  };
}

export async function applyLayeredReductionAfterCallToSse(
  requestPayload: any,
  rawSse: string,
  maxToolChars: number,
  triggerMinChars: number,
  passToggles: AfterCallPassToggles | undefined,
  passOptions: Record<string, Record<string, unknown>> | undefined,
  helpers: AfterCallHelpers,
): Promise<{ text: string; reduction: ProxyAfterCallReductionResult }> {
  let completedResponse: any = null;
  const probe = rewriteSseJsonEvents(rawSse, (event) => {
    if (!event || typeof event !== "object") return false;
    const type = String(event.type ?? "").toLowerCase();
    if (type !== "response.completed" || !event.response || typeof event.response !== "object") return false;
    completedResponse = event.response;
    return false;
  });
  if (!completedResponse) {
    return {
      text: rawSse,
      reduction: {
        changed: false,
        savedChars: 0,
        passCount: 0,
        skippedReason: "sse_missing_response_completed",
        mode: "sse",
        patchedEvents: probe.changedEvents,
      },
    };
  }

  const reconstructedText = collectSseOutputText(rawSse);
  if (!extractProxyResponseText(completedResponse) && reconstructedText) {
    if (typeof completedResponse.output_text === "string" || completedResponse.output_text === undefined) {
      completedResponse.output_text = reconstructedText;
    }
  }

  const afterCallReduction = await applyLayeredReductionAfterCall(
    requestPayload,
    completedResponse,
    maxToolChars,
    triggerMinChars,
    passToggles,
    passOptions,
    helpers,
  );
  if (!afterCallReduction.changed) {
    return { text: rawSse, reduction: { ...afterCallReduction, mode: "sse" } };
  }
  const nextText = extractProxyResponseText(completedResponse);
  if (!nextText) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_reduced_text_empty",
        mode: "sse",
      },
    };
  }

  const rewritten = rewriteSseJsonEvents(rawSse, (event) => patchSseEventForReducedText(event, nextText));
  if (rewritten.changedEvents <= 0) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_patch_no_effect",
        mode: "sse",
        patchedEvents: 0,
      },
    };
  }
  return {
    text: rewritten.text,
    reduction: { ...afterCallReduction, mode: "sse", patchedEvents: rewritten.changedEvents },
  };
}
