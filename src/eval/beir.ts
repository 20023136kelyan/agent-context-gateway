/**
 * BEIR dataset adapter.
 *
 * Every number this system reports comes from one synthetic 72-session corpus
 * whose documents and queries were authored together. That is a real risk of
 * fitting the corpus to itself, and the constants most exposed to it are the
 * engine-calibrated ones — `GATEWAY_SIM_FLOOR` above all, whose failure mode is
 * silent. This module exists to re-measure them against corpora nobody here
 * wrote.
 *
 * BEIR standardises on three files, so one adapter covers ~18 datasets:
 *   corpus.jsonl    {_id, title, text}
 *   queries.jsonl   {_id, text}
 *   qrels/<split>.tsv   query-id \t corpus-id \t score   (with a header row)
 *
 * MAPPING: one document becomes one session holding one turn. ACG scores
 * relevance per session, and BEIR judges per document, so collapsing the two
 * makes the existing metrics correct without touching them. It costs a file per
 * document, which is why `maxDocs` exists — Quora's 523k would be absurd, and
 * `listSessions` stats every file on each refresh.
 *
 * TWO CAVEATS on comparing to published BEIR numbers:
 *   - `dcgAtK` treats relevance as binary, so a graded qrel (nfcorpus has 1 and
 *     2) is flattened to "relevant". This is binarized NDCG, not BEIR's graded
 *     NDCG.
 *   - BEIR reports NDCG@10; the runner computes NDCG@5.
 * Both make our figures NOT directly comparable to a published leaderboard.
 * They remain valid for comparing OUR arms against each other on outside data,
 * which is the question being asked.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { GoldenQuery } from "./runner.js";

export interface BeirBuildOptions {
  split?: string;
  /** Cap on judged queries, taken in sorted id order so a run is reproducible. */
  maxQueries?: number;
  /** Cap on total documents. Judged documents are ALWAYS kept; the remainder
   *  fills with unjudged documents as distractors. */
  maxDocs?: number;
  /** Which domain bucket these queries report under. */
  domain?: GoldenQuery["domain"];
}

export interface BeirCorpus {
  claudeDir: string;
  queries: GoldenQuery[];
  stats: {
    name: string;
    docsWritten: number;
    judgedDocs: number;
    distractors: number;
    queries: number;
    meanRelevantPerQuery: number;
    corpusTruncated: boolean;
  };
}

/** Filesystem- and turn-id-safe. `parseTurnId` splits on ":", so it must go. */
const safeId = (raw: string): string => raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";

async function* jsonl(path: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A malformed line is a dataset problem, not ours: skip it rather than
      // abort a run that is otherwise valid.
    }
  }
}

/** query-id -> relevant corpus-ids (score > 0). */
async function readQrels(path: string): Promise<Map<string, string[]>> {
  const raw = await readFile(path, "utf8");
  const out = new Map<string, string[]>();
  for (const [i, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const [qid, did, score] = line.split("\t");
    if (i === 0 && score === "score") continue; // header
    if (!qid || !did) continue;
    if (Number(score) <= 0) continue; // binarized: graded levels collapse to relevant
    const list = out.get(qid);
    if (list) list.push(did);
    else out.set(qid, [did]);
  }
  return out;
}

export async function buildBeirCorpus(
  datasetDir: string,
  root: string,
  opts: BeirBuildOptions = {},
): Promise<BeirCorpus> {
  const name = datasetDir.replace(/\/+$/, "").split("/").pop() ?? "beir";
  const split = opts.split ?? "test";
  const domain = opts.domain ?? "prose";

  const qrels = await readQrels(join(datasetDir, "qrels", `${split}.tsv`));
  if (qrels.size === 0) throw new Error(`beir: no judgments in ${name}/qrels/${split}.tsv`);

  // Sorted, then truncated: the selection must not depend on file order or a
  // random seed, or two runs measure two different benchmarks.
  const chosenQueryIds = [...qrels.keys()].sort().slice(0, opts.maxQueries ?? qrels.size);
  const chosen = new Set(chosenQueryIds);

  const queryText = new Map<string, string>();
  for await (const q of jsonl(join(datasetDir, "queries.jsonl"))) {
    const id = String(q._id ?? "");
    if (chosen.has(id)) queryText.set(id, String(q.text ?? ""));
  }

  const judged = new Set<string>();
  for (const qid of chosenQueryIds) for (const did of qrels.get(qid) ?? []) judged.add(did);

  const maxDocs = opts.maxDocs ?? Infinity;
  if (judged.size > maxDocs) {
    throw new Error(
      `beir: ${name} needs ${judged.size} judged docs for ${chosenQueryIds.length} queries but maxDocs is ${maxDocs}. ` +
        `Lower --beir-queries instead: dropping judged docs would silently make queries unanswerable.`,
    );
  }

  const claudeDir = join(root, "claude");
  const dir = join(claudeDir, name);
  await mkdir(dir, { recursive: true });

  // Fixed base so timestamps are deterministic and asOf bounds are predictable.
  const base = Date.parse("2026-01-01T00:00:00Z");
  const seenSafe = new Map<string, string>();
  let written = 0;
  let distractors = 0;
  let truncated = false;
  let pending: Promise<void>[] = [];

  const flush = async () => {
    await Promise.all(pending);
    pending = [];
  };

  for await (const doc of jsonl(join(datasetDir, "corpus.jsonl"))) {
    const id = String(doc._id ?? "");
    if (!id) continue;
    const isJudged = judged.has(id);
    if (!isJudged) {
      if (written >= maxDocs) {
        truncated = true;
        continue;
      }
      distractors += 1;
    }

    const sid = safeId(id);
    const clash = seenSafe.get(sid);
    if (clash !== undefined && clash !== id) {
      throw new Error(`beir: doc ids "${clash}" and "${id}" both sanitize to "${sid}"`);
    }
    seenSafe.set(sid, id);

    const title = String(doc.title ?? "").trim();
    const text = String(doc.text ?? "").trim();
    const content = title && text ? `${title}\n\n${text}` : title || text;
    if (!content) continue;

    const ts = new Date(base + written * 60_000).toISOString();
    const line = JSON.stringify({
      type: "assistant",
      uuid: `${sid}-u0`,
      parentUuid: null,
      timestamp: ts,
      sessionId: sid,
      cwd: `/beir/${name}`,
      message: { role: "assistant", content },
    });
    pending.push(writeFile(join(dir, `${sid}.jsonl`), line + "\n"));
    written += 1;
    if (pending.length >= 256) await flush();
  }
  await flush();

  const queries: GoldenQuery[] = [];
  let relTotal = 0;
  for (const qid of chosenQueryIds) {
    const text = queryText.get(qid);
    if (!text) continue; // judged but absent from queries.jsonl
    const rel = (qrels.get(qid) ?? []).map(safeId).filter((d) => seenSafe.has(d));
    if (rel.length === 0) continue; // every relevant doc missing: unanswerable, so not a fair query
    relTotal += rel.length;
    queries.push({
      id: `${name}-${qid}`,
      domain,
      query: text,
      description: `BEIR ${name} ${split} query ${qid}`,
      relevantSessionIds: rel,
    });
  }

  return {
    claudeDir,
    queries,
    stats: {
      name,
      docsWritten: written,
      judgedDocs: judged.size,
      distractors,
      queries: queries.length,
      meanRelevantPerQuery: queries.length ? Number((relTotal / queries.length).toFixed(1)) : 0,
      corpusTruncated: truncated,
    },
  };
}
