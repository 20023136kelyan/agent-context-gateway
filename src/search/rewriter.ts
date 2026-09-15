/**
 * Conversational Query Rewriting & Multi-Query Expansion (TREC CAsT & SIGIR '24).
 * De-contextualizes conversational agent utterances by:
 * 1. Resolving topology references ("my parent", "my child", "my sibling") into explicit session filters
 * 2. Stripping conversational filler ("can you find out", "what did the other session say about")
 * 3. Generating semantically expanded variants (synonyms for actions, performance, components)
 * 4. Yielding multiple query variants for RRF fusion
 */
import type { TopologyStore, SessionRef } from "../topology/store.js";
import type { Harness } from "../core/models.js";

export interface RewrittenQuery {
  original: string;
  primaryQuery: string;
  variants: string[];
  resolvedTarget?: SessionRef;
  expandedTerms: string[];
}

const FILLER_PATTERNS = [
  /^(can\s+you\s+(please\s+)?(find\s+out|find|check|tell\s+me|search|look\s+up)\s+(what|if|why|how)?\s*)/i,
  /^(do\s+you\s+know\s+(what|if|why|how)?\s*)/i,
  /^(what\s+did\s+(the\s+other\s+agent|someone|we)\s+(decide|say|conclude|find)\s+(about|regarding|on)?\s*)/i,
  /^(find\s+out\s+(what|if|why|how)?\s*)/i,
  /^(tell\s+me\s+(about)?\s*)/i,
];

// Developer vocabulary equivalence maps for multi-query variant generation
const SYNONYM_MAP: Record<string, string[]> = {
  replace: ["swap", "substitute", "migrate", "switch"],
  replaced: ["swapped", "substituted", "migrated", "switched"],
  replacing: ["swapping", "substituting", "migrating", "switching"],
  slow: ["sluggish", "latency", "lag", "delays", "performance", "drops frames"],
  sluggish: ["slow", "latency", "frame drop", "performance"],
  resizing: ["resize", "window bounds", "window border", "dimensions"],
  blur: ["transparency", "vibrancy", "backdrop", "visualEffectState"],
  collaboration: ["jointly edit", "co-author", "shared workbench", "realtime sync"],
  "jointly edit": ["collaboration", "shared workbench", "live session"],
  render: ["rendering", "paint", "draw", "display", "canvas", "export"],
  presentation: ["powerpoint", "pptx", "slides", "deck"],
  powerpoint: ["pptx", "slides", "presentation"],
};

export function cleanPreamble(query: string): string {
  let cleaned = query.trim();
  for (const pat of FILLER_PATTERNS) {
    cleaned = cleaned.replace(pat, "").trim();
  }
  return cleaned.replace(/^[?.,!\s]+|[?.,!\s]+$/g, "").trim();
}

/**
 * Resolves conversational references like "my parent", "my sibling", "my child"
 * into actual session references using the TopologyStore.
 */
export function resolveTopologyReferences(
  query: string,
  callerSessionId?: string,
  topology?: TopologyStore | null,
  callerHarness?: Harness,
): { cleanedQuery: string; target?: SessionRef } {
  if (!callerSessionId || !topology) {
    return { cleanedQuery: query };
  }

  const callerRef: SessionRef = {
    harness: callerHarness ?? "claude-code",
    sessionId: callerSessionId,
  };

  const lower = query.toLowerCase();
  let target: SessionRef | undefined;
  let cleaned = query;

  if (/\b(my\s+parent|the\s+parent(\s+agent)?)\b/i.test(lower)) {
    const parents = topology.parentsOf(callerRef);
    if (parents.length > 0) {
      target = parents[0];
      cleaned = cleaned.replace(/\b(my\s+parent|the\s+parent(\s+agent)?)\b/gi, "").trim();
    }
  } else if (/\b(my\s+children|any\s+child(\s+agent)?|the\s+child(\s+agent)?)\b/i.test(lower)) {
    const children = topology.childrenOf(callerRef);
    if (children.length > 0) {
      target = children[0];
      cleaned = cleaned.replace(/\b(my\s+children|any\s+child(\s+agent)?|the\s+child(\s+agent)?)\b/gi, "").trim();
    }
  } else if (/\b(my\s+sibling|the\s+sibling(\s+agent)?)\b/i.test(lower)) {
    const siblings = topology.siblingsOf(callerRef);
    if (siblings.length > 0) {
      target = siblings[0];
      cleaned = cleaned.replace(/\b(my\s+sibling|the\s+sibling(\s+agent)?)\b/gi, "").trim();
    }
  }

  return { cleanedQuery: cleaned, target };
}

/**
 * Generates 1-3 query variants for multi-query retrieval and RRF fusion.
 */
export function generateQueryVariants(cleanedQuery: string): { primary: string; variants: string[]; expandedTerms: string[] } {
  const words = cleanedQuery.toLowerCase().split(/\s+/);
  const expandedTerms: string[] = [];
  const variantWords: string[] = [...words];

  let swappedAny = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^a-z0-9]/g, "");
    if (SYNONYM_MAP[w]) {
      const syns = SYNONYM_MAP[w];
      expandedTerms.push(...syns);
      variantWords[i] = syns[0];
      swappedAny = true;
    }
  }

  const variants: string[] = [];
  if (swappedAny) {
    variants.push(variantWords.join(" "));
  }

  // Check multi-word synonyms
  const lower = cleanedQuery.toLowerCase();
  for (const [key, syns] of Object.entries(SYNONYM_MAP)) {
    if (key.includes(" ") && lower.includes(key)) {
      expandedTerms.push(...syns);
      variants.push(cleanedQuery.replace(new RegExp(key, "gi"), syns[0]));
    }
  }

  return {
    primary: cleanedQuery,
    variants: [...new Set(variants.filter((v) => v !== cleanedQuery))],
    expandedTerms: [...new Set(expandedTerms)],
  };
}

export function rewriteConversationalQuery(
  rawQuery: string,
  callerSessionId?: string,
  topology?: TopologyStore | null,
  callerHarness?: Harness,
): RewrittenQuery {
  // 1. Resolve topology references
  const { cleanedQuery: topoCleaned, target } = resolveTopologyReferences(
    rawQuery,
    callerSessionId,
    topology,
    callerHarness,
  );

  // 2. Strip conversational preamble
  const cleaned = cleanPreamble(topoCleaned);

  // 3. Generate multi-query variants
  const { primary, variants, expandedTerms } = generateQueryVariants(cleaned.length > 0 ? cleaned : rawQuery);

  return {
    original: rawQuery,
    primaryQuery: primary,
    variants,
    resolvedTarget: target,
    expandedTerms,
  };
}
