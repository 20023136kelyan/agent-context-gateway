/**
 * One harness read from several locations (`acg paths add`): two Claude
 * profiles, or an archive copied from another machine next to the live one.
 *
 * The rest of the gateway looks adapters up by harness and expects one per
 * harness, so this presents the parts as a single adapter. Sync needs nothing
 * special: it is keyed by each session's source file, which differs per
 * location.
 *
 * A session id found in more than one location (an archive that includes a
 * session still live elsewhere) is kept once, from the first location listed:
 * the order `acg paths` shows is the order of preference.
 */
import type { Harness, Session, Turn } from "../core/models.js";
import type { Action } from "../actions/store.js";
import type { ContextAdapter, FileCursor } from "./types.js";

export class CombinedAdapter implements ContextAdapter {
  private owner = new Map<string, ContextAdapter>();

  constructor(
    readonly harness: Harness,
    readonly parts: ContextAdapter[],
  ) {}

  capabilities() {
    return this.parts[0]!.capabilities();
  }

  async listSessions(): Promise<Session[]> {
    const out: Session[] = [];
    const seen = new Set<string>();
    for (const part of this.parts) {
      for (const s of await part.listSessions().catch(() => [] as Session[])) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        this.owner.set(s.id, part);
        out.push(s);
      }
    }
    return out;
  }

  private async ownerOf(sessionId: string): Promise<ContextAdapter | undefined> {
    if (!this.owner.has(sessionId)) await this.listSessions();
    return this.owner.get(sessionId);
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const part = await this.ownerOf(sessionId);
    return part ? part.listTurns(sessionId) : [];
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const part = await this.ownerOf(sessionId);
    if (!part) throw new Error(`turn not found: ${turnId}`);
    return part.getTurn(sessionId, turnId);
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    const out: Record<string, FileCursor> = {};
    for (const part of this.parts) Object.assign(out, await part.getCursor().catch(() => ({})));
    return out;
  }

  async listActions(sessionId: string): Promise<Action[]> {
    const part = await this.ownerOf(sessionId);
    return (await part?.listActions?.(sessionId)) ?? [];
  }
}
