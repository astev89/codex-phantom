import type { MemoryContextEnvelope, MemoryEntry } from "../shared/types.ts";
import { decodeJson } from "../platform/database.ts";
import {
  clamp,
  isActive,
  type MemoryRow,
  toMemoryEntry,
  tokenize,
} from "./records.ts";

export type ScoredMemoryRow = {
  row: MemoryRow;
  score: number;
};

export type MemoryRetrievalPolicyInput = {
  rows: MemoryRow[];
  queryText: string;
  queryEmbedding: number[] | null;
  vectorScores?: Map<string, number>;
  memorySummaryLimit: number;
  memoryPerCategoryLimit: number;
  nowMs?: number;
};

export type MemoryRetrievalPolicyResult = {
  envelope: MemoryContextEnvelope;
  scoredRows: ScoredMemoryRow[];
  returnedEntries: MemoryEntry[];
  decayUpdates: Array<{ id: string; decayScore: number }>;
};

export function buildMemoryRetrievalContext(
  input: MemoryRetrievalPolicyInput
): MemoryRetrievalPolicyResult {
  const tokens = tokenize(input.queryText);
  const scoredRows = input.rows
    .filter((row) => isActive(row))
    .map((row) =>
      scoreMemoryRowHybrid(row, {
        tokens,
        queryEmbedding: input.queryEmbedding,
        vectorScore: input.vectorScores?.get(row.id),
        nowMs: input.nowMs,
      })
    )
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const summaries = scoredRows
    .filter((entry) => entry.row.is_summary === 1)
    .slice(0, input.memorySummaryLimit)
    .map(toMemoryEntry);
  const episodic = scoredRows
    .filter(
      (entry) => entry.row.category === "episodic" && entry.row.is_summary === 0
    )
    .slice(0, input.memoryPerCategoryLimit)
    .map(toMemoryEntry);
  const semantic = scoredRows
    .filter(
      (entry) => entry.row.category === "semantic" && entry.row.is_summary === 0
    )
    .slice(0, input.memoryPerCategoryLimit)
    .map(toMemoryEntry);
  const procedural = scoredRows
    .filter(
      (entry) =>
        entry.row.category === "procedural" && entry.row.is_summary === 0
    )
    .slice(0, input.memoryPerCategoryLimit)
    .map(toMemoryEntry);

  return {
    envelope: {
      episodic,
      semantic,
      procedural,
      summaries,
    },
    scoredRows,
    returnedEntries: [...summaries, ...episodic, ...semantic, ...procedural],
    decayUpdates: scoredRows.map((entry) => ({
      id: entry.row.id,
      decayScore: entry.row.decay_score ?? 0,
    })),
  };
}

export function scoreMemoryRowHybrid(
  row: MemoryRow,
  input: {
    tokens: string[];
    queryEmbedding: number[] | null;
    vectorScore?: number;
    nowMs?: number;
  }
): ScoredMemoryRow {
  const lowered = row.content.toLowerCase();
  const keywordBoost = input.tokens.reduce(
    (sum, token) => sum + (lowered.includes(token) ? 1.5 : 0),
    0
  );
  const ageDays = Math.max(
    0,
    ((input.nowMs ?? Date.now()) - Date.parse(row.created_at)) / 86_400_000
  );
  const recencyBoost = Math.max(0, 4 - Math.floor(ageDays));
  const decayPenalty = Math.min(3, ageDays / 30);
  const categoryBoost =
    row.category === "procedural"
      ? 2.2
      : row.category === "semantic"
        ? 1.8
        : 1.2;
  const summaryBoost = row.is_summary === 1 ? 1.6 : 0;
  const semanticSimilarity =
    input.vectorScore !== undefined
      ? input.vectorScore * 8
      : input.queryEmbedding
        ? cosineSimilarity(
            input.queryEmbedding,
            decodeJson(row.embedding_json, [])
          ) * 8
        : 0;
  const accessBoost = Math.min(1.5, Math.log1p(row.access_count) * 0.35);
  const reinforcementBoost = clamp(row.reinforcement_score ?? 0, -1, 3);
  const score =
    keywordBoost +
    recencyBoost +
    categoryBoost +
    summaryBoost +
    row.importance * 3 +
    semanticSimilarity +
    accessBoost +
    reinforcementBoost -
    decayPenalty;

  return {
    row: {
      ...row,
      decay_score: decayPenalty,
    },
    score,
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
