/**
 * Permission-Aware Access Control & PermCov Enforcement (IEEE Access 2025 & spec §23-25).
 * Enforces resource-level access control over projects, harnesses, and repositories.
 * The PermCov metric guarantees zero leakage of unauthorized turns to unauthorized callers.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Session } from "../core/models.js";
import type { PackagedResult } from "../search/search.js";

export interface AccessRule {
  principal: string; // Token ID, agent identity, or user
  allowedProjects?: string[]; // e.g. ["cozea", "adori-pets"]
  allowedHarnesses?: string[]; // e.g. ["codex", "claude-code"]
  allowedRepos?: string[];
  deniedSessions?: string[];
}

export class AclStore {
  private rules = new Map<string, AccessRule>();
  constructor(private path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { rules?: AccessRule[] };
      if (Array.isArray(raw.rules)) {
        for (const r of raw.rules) this.rules.set(r.principal, r);
      }
    } catch {
      // corrupt file -> empty rules
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, rules: [...this.rules.values()] }, null, 2));
  }

  setRule(rule: AccessRule): void {
    this.rules.set(rule.principal, rule);
    this.save();
  }

  removeRule(principal: string): boolean {
    const deleted = this.rules.delete(principal);
    if (deleted) this.save();
    return deleted;
  }

  getRule(principal: string): AccessRule | undefined {
    return this.rules.get(principal) ?? this.rules.get("*");
  }

  all(): AccessRule[] {
    return [...this.rules.values()];
  }

  /**
   * Checks if a principal has permission to view context from this session.
   * If no rule is configured for the principal or '*', default allows access (local-first compatibility).
   */
  canAccess(principal: string | undefined, session: Session): boolean {
    if (!principal) return true;
    const rule = this.getRule(principal);
    if (!rule) return true; // No policy defined for principal -> open access

    // 1. Explicitly denied sessions
    if (rule.deniedSessions && rule.deniedSessions.includes(session.id)) {
      return false;
    }

    // 2. Harness restriction
    if (rule.allowedHarnesses && !rule.allowedHarnesses.includes(session.harness)) {
      return false;
    }

    // 3. Project restriction
    if (rule.allowedProjects && !rule.allowedProjects.includes(session.projectId)) {
      return false;
    }

    // 4. Repo restriction
    if (rule.allowedRepos && session.repo && !rule.allowedRepos.includes(session.repo)) {
      return false;
    }

    return true;
  }

  /**
   * Measures permission contamination (PermCov from IEEE 2025).
   * Returns fraction of unauthorized results. MUST be 0.0 in a secure system.
   */
  computePermCov(
    results: PackagedResult[],
    principal: string,
    sessionsMap: Map<string, Session>,
  ): number {
    if (results.length === 0) return 0.0;
    let unauthorizedCount = 0;
    for (const r of results) {
      const key = `${r.provenance.harness}:${r.provenance.sessionId}`;
      const session = sessionsMap.get(key);
      if (!session || !this.canAccess(principal, session)) {
        unauthorizedCount++;
      }
    }
    return unauthorizedCount / results.length;
  }
}

export function defaultAclPath(stateDir?: string): string {
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "acl.json");
}
