import type { RuntimeTurnResult } from "@ecoclaw/kernel";
import type { ReductionSummary } from "@ecoclaw/layer-execution";

type EcoclawEvent = {
  type: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function readReductionSummary(
  result: RuntimeTurnResult,
  phase: "beforeCallSummary" | "afterCallSummary",
): ReductionSummary | undefined {
  const metadata = asRecord(result.metadata);
  const reduction = asRecord(metadata?.reduction);
  const summary = reduction?.[phase];
  return asRecord(summary) as ReductionSummary | undefined;
}

export function readEcoclawEvents(result: RuntimeTurnResult): EcoclawEvent[] {
  const metadata = asRecord(result.metadata);
  const events = metadata?.ecoclawEvents;
  return Array.isArray(events) ? (events as EcoclawEvent[]) : [];
}

export function readFinalContextEvents(result: RuntimeTurnResult): EcoclawEvent[] {
  const metadata = asRecord(result.metadata);
  const trace = asRecord(metadata?.ecoclawTrace);
  const finalContext = asRecord(trace?.finalContext);
  const finalContextMetadata = asRecord(finalContext?.metadata);
  const events = finalContextMetadata?.ecoclawEvents;
  return Array.isArray(events) ? (events as EcoclawEvent[]) : [];
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

export function printReductionSummary(title: string, summary?: ReductionSummary) {
  console.log(title);
  if (!summary) {
    console.log("  no reduction summary");
    return;
  }

  console.log(
    `  saved ${summary.savedChars} chars (${formatPercent(summary.savingsRatio)}) | before=${summary.beforeChars} after=${summary.afterChars}`,
  );
  console.log(
    `  passes=${summary.passCount} changed=${summary.changedPassCount} skipped=${summary.skippedPassCount}`,
  );

  if (summary.topContributor) {
    console.log(
      `  top contributor: ${summary.topContributor.id} saved=${summary.topContributor.savedChars} (${formatPercent(summary.topContributor.savingsRatio)})`,
    );
  } else {
    console.log("  top contributor: none");
  }

  if (!summary.passBreakdown.length) {
    console.log("  breakdown: none");
    return;
  }

  console.log("  breakdown:");
  for (const pass of summary.passBreakdown) {
    const extras: string[] = [];
    if (pass.skippedReason) {
      extras.push(`skipped=${pass.skippedReason}`);
    }
    if (pass.note) {
      extras.push(`note=${pass.note}`);
    }
    if (pass.touchedSegmentIds?.length) {
      extras.push(`segments=${pass.touchedSegmentIds.join(",")}`);
    }
    const suffix = extras.length ? ` | ${extras.join(" | ")}` : "";
    console.log(
      `    ${pass.order}. ${pass.id} [${pass.phase}/${pass.target}] changed=${pass.changed} saved=${pass.savedChars} cumulative=${pass.cumulativeSavedChars}${suffix}`,
    );
  }
}

export function printTurnReport(label: string, result: RuntimeTurnResult) {
  const metadata = asRecord(result.metadata);
  const trace = asRecord(metadata?.ecoclawTrace);
  const finalContext = asRecord(trace?.finalContext);
  const finalContextMetadata = asRecord(finalContext?.metadata);

  console.log(`\n=== ${label} ===`);
  console.log("Usage:", result.usage);
  console.log("Event types:", readEcoclawEvents(result).map((event) => event.type));
  console.log("FinalContext event types:", readFinalContextEvents(result).map((event) => event.type));
  printReductionSummary("Reduction before-call ROI:", readReductionSummary(result, "beforeCallSummary"));
  printReductionSummary("Reduction after-call ROI:", readReductionSummary(result, "afterCallSummary"));
  console.log("Summary meta:", metadata?.summary);
  console.log("FinalContext stabilizer:", finalContextMetadata?.stabilizer);
  console.log("FinalContext policy:", finalContextMetadata?.policy);
  console.log("FinalContext policy ROI:", asRecord(asRecord(finalContextMetadata?.policy)?.roi));
}
