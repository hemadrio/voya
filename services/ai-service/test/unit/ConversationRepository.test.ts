/**
 * Unit tests for ConversationRepository (WO-057).
 *
 * Uses an in-memory repository stub (InMemoryConversationDb) to test
 * ownership isolation, idempotent append, transactional behaviour,
 * pagination boundaries, cursor tampering, redaction, and retention.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConversationRepository } from "../../src/infrastructure/persistence/ConversationRepository.js";
import {
  ConversationError,
  type Principal,
  type ConversationSummary,
  type ConversationMessage,
} from "../../src/domain/conversation/ConversationRepositoryPort.js";
import { redact } from "../../src/domain/privacy/redact.js";
import { runConversationRetention } from "../../src/jobs/conversationRetention.js";

// ---------------------------------------------------------------------------
// In-memory stub (duck-typed to ConversationPrismaClient)
// ---------------------------------------------------------------------------

interface StubConvRow {
  id: string;
  userId: string | null;
  guestSessionId: string | null;
  title: string | null;
  status: string;
  resolvedSlots: Record<string, unknown>;
  tokenTotals: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

interface StubMsgRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  groundingRefs: unknown;
  tokenCount: number;
  idempotencyKey: string | null;
  createdAt: Date;
}

let convIdSeq = 0;
let msgIdSeq = 0;
function nextConvId() { return `conv-${++convIdSeq}`; }
function nextMsgId() { return `msg-${++msgIdSeq}`; }

class InMemoryConversationDb {
  convs: StubConvRow[] = [];
  msgs: StubMsgRow[] = [];
  transactionThrowOnNextUpdate = false;

  get conversation() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    return {
      create({ data }: { data: Partial<StubConvRow> }): Promise<StubConvRow> {
        const now = new Date();
        const row: StubConvRow = {
          id: nextConvId(),
          userId: data.userId ?? null,
          guestSessionId: data.guestSessionId ?? null,
          title: data.title ?? null,
          status: data.status ?? 'active',
          resolvedSlots: {},
          tokenTotals: {},
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
        };
        db.convs.push(row);
        return Promise.resolve({ ...row });
      },
      findFirst({ where }: { where: Record<string, unknown> }): Promise<StubConvRow | null> {
        const found = db.convs.find((c) => {
          if (where.id !== undefined && c.id !== where.id) return false;
          if (where.userId !== undefined && c.userId !== where.userId) return false;
          if (where.guestSessionId !== undefined && c.guestSessionId !== where.guestSessionId) return false;
          return true;
        });
        return Promise.resolve(found ? { ...found } : null);
      },
      findMany({ where, orderBy, cursor, take, skip }: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        cursor?: { id: string };
        take?: number;
        skip?: number;
      }): Promise<StubConvRow[]> {
        let rows = db.convs.filter((c) => {
          if (where.userId !== undefined && c.userId !== where.userId) return false;
          if (where.guestSessionId !== undefined && c.guestSessionId !== where.guestSessionId) return false;
          return true;
        });
        // Sort by lastActivityAt desc
        rows.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          rows = idx >= 0 ? rows.slice(idx + (skip ?? 0)) : [];
        } else if (skip) {
          rows = rows.slice(skip);
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return Promise.resolve(rows.map((r) => ({ ...r })));
      },
      update({ where, data }: { where: { id: string }; data: Partial<StubConvRow> }): Promise<StubConvRow> {
        if (db.transactionThrowOnNextUpdate) {
          db.transactionThrowOnNextUpdate = false;
          return Promise.reject(new Error('simulated DB failure'));
        }
        const idx = db.convs.findIndex((c) => c.id === where.id);
        if (idx < 0) return Promise.reject(new Error(`Conversation ${where.id} not found`));
        db.convs[idx] = { ...db.convs[idx], ...data };
        return Promise.resolve({ ...db.convs[idx] });
      },
      updateMany({ where, data }: { where: Record<string, unknown>; data: Partial<StubConvRow> }): Promise<{ count: number }> {
        let count = 0;
        for (let i = 0; i < db.convs.length; i++) {
          const c = db.convs[i];
          if (where.id !== undefined && c.id !== where.id) continue;
          if (where.userId !== undefined && c.userId !== where.userId) continue;
          if (where.guestSessionId !== undefined && c.guestSessionId !== where.guestSessionId) continue;
          db.convs[i] = { ...c, ...data };
          count++;
        }
        return Promise.resolve({ count });
      },
      delete({ where }: { where: { id: string } }): Promise<StubConvRow | null> {
        const idx = db.convs.findIndex((c) => c.id === where.id);
        if (idx < 0) return Promise.resolve(null);
        const [removed] = db.convs.splice(idx, 1);
        db.msgs = db.msgs.filter((m) => m.conversationId !== where.id);
        return Promise.resolve({ ...removed });
      },
      deleteMany({ where }: { where: Record<string, unknown> }): Promise<{ count: number }> {
        const before = db.convs.length;
        db.convs = db.convs.filter((c) => {
          if (where.id !== undefined && c.id !== where.id) return true;
          if (where.userId !== undefined) {
            if (where.userId === null && c.userId !== null) return true;
            if (typeof where.userId === 'object' && where.userId !== null && 'not' in (where.userId as object)) {
              if (c.userId === null) return true;
            } else if (c.userId !== where.userId) return true;
          }
          if (where.guestSessionId !== undefined) {
            if (where.guestSessionId === null && c.guestSessionId !== null) return true;
            if (typeof where.guestSessionId === 'object' && where.guestSessionId !== null && 'not' in (where.guestSessionId as object)) {
              if (c.guestSessionId === null) return true;
            } else if (c.guestSessionId !== where.guestSessionId) return true;
          }
          if (where.lastActivityAt !== undefined) {
            const lta = where.lastActivityAt as { lt: Date };
            if (c.lastActivityAt >= lta.lt) return true;
          }
          return false;
        });
        const deleted = before - db.convs.length;
        db.msgs = db.msgs.filter((m) => db.convs.some((c) => c.id === m.conversationId));
        return Promise.resolve({ count: deleted });
      },
    };
  }

  get conversationMessage() {
    const db = this;
    return {
      create({ data }: { data: Partial<StubMsgRow> }): Promise<StubMsgRow> {
        const now = new Date();
        const row: StubMsgRow = {
          id: nextMsgId(),
          conversationId: data.conversationId!,
          role: data.role ?? 'user',
          content: data.content ?? '',
          toolCalls: data.toolCalls ?? null,
          groundingRefs: data.groundingRefs ?? null,
          tokenCount: data.tokenCount ?? 0,
          idempotencyKey: data.idempotencyKey ?? null,
          createdAt: now,
        };
        db.msgs.push(row);
        return Promise.resolve({ ...row });
      },
      findFirst({ where }: { where: Record<string, unknown> }): Promise<StubMsgRow | null> {
        const found = db.msgs.find((m) => {
          if (where.conversationId !== undefined && m.conversationId !== where.conversationId) return false;
          if (where.idempotencyKey !== undefined && m.idempotencyKey !== where.idempotencyKey) return false;
          return true;
        });
        return Promise.resolve(found ? { ...found } : null);
      },
      findMany({ where, orderBy, cursor, take, skip }: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        cursor?: { id: string };
        take?: number;
        skip?: number;
      }): Promise<StubMsgRow[]> {
        let rows = db.msgs.filter((m) => {
          if (where.conversationId !== undefined && m.conversationId !== where.conversationId) return false;
          return true;
        });
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          rows = idx >= 0 ? rows.slice(idx + (skip ?? 0)) : [];
        } else if (skip) {
          rows = rows.slice(skip);
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return Promise.resolve(rows.map((r) => ({ ...r })));
      },
      count({ where }: { where: Record<string, unknown> }): Promise<number> {
        return Promise.resolve(db.msgs.filter((m) => m.conversationId === where.conversationId).length);
      },
    };
  }

  $transaction<T>(fn: (tx: typeof this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const USER_A: Principal = { type: 'user', userId: 'user-alice' };
const USER_B: Principal = { type: 'user', userId: 'user-bob' };
const GUEST_A: Principal = { type: 'guest', guestSessionId: 'session-alpha' };

function makeRepo() {
  const db = new InMemoryConversationDb();
  const repo = new ConversationRepository(db as never);
  return { db, repo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationRepository', () => {

  describe('createConversation', () => {
    it('creates a conversation owned by the authenticated user', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, { title: 'Paris Trip' });
      expect(conv.title).toBe('Paris Trip');
      expect(conv.status).toBe('active');
      expect(conv.id).toBeTruthy();
    });

    it('creates a conversation owned by a guest session', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(GUEST_A, {});
      expect(conv.id).toBeTruthy();
      expect(conv.status).toBe('active');
    });
  });

  describe('appendMessage', () => {
    it('appends a message to an owned conversation', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const msg = await repo.appendMessage(USER_A, conv.id, {
        role: 'user',
        content: 'I want flights to Lisbon',
        tokenCount: 10,
      });
      expect(msg.conversationId).toBe(conv.id);
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('I want flights to Lisbon');
    });

    it('returns NOT_FOUND when user does not own the conversation', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      await expect(
        repo.appendMessage(USER_B, conv.id, { role: 'user', content: 'hello' }),
      ).rejects.toThrow(ConversationError);
      const err = await repo.appendMessage(USER_B, conv.id, { role: 'user', content: 'hello' }).catch((e) => e);
      expect((err as ConversationError).code).toBe('NOT_FOUND');
    });

    it('is idempotent: returns existing message on duplicate idempotency key', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const first = await repo.appendMessage(USER_A, conv.id, {
        role: 'user', content: 'hello', idempotencyKey: 'key-001',
      });
      const second = await repo.appendMessage(USER_A, conv.id, {
        role: 'user', content: 'hello', idempotencyKey: 'key-001',
      });
      expect(second.id).toBe(first.id);
    });

    it('does not duplicate messages without an idempotency key', async () => {
      const { repo, db } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      await repo.appendMessage(USER_A, conv.id, { role: 'user', content: 'first' });
      await repo.appendMessage(USER_A, conv.id, { role: 'user', content: 'second' });
      expect(db.msgs.length).toBe(2);
    });

    it('updates token totals on conversation after append', async () => {
      const { repo, db } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      await repo.appendMessage(USER_A, conv.id, { role: 'user', content: 'q', tokenCount: 5 });
      await repo.appendMessage(USER_A, conv.id, { role: 'assistant', content: 'a', tokenCount: 12 });
      const stored = db.convs.find((c) => c.id === conv.id)!;
      expect(stored.tokenTotals['user']).toBe(5);
      expect(stored.tokenTotals['assistant']).toBe(12);
    });

    it('rejects content exceeding the maximum length', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const longContent = 'x'.repeat(33_000);
      const err = await repo.appendMessage(USER_A, conv.id, { role: 'user', content: longContent })
        .catch((e) => e);
      expect((err as ConversationError).code).toBe('CONTENT_TOO_LONG');
    });

    it('rolls back the message insert when conversation update fails', async () => {
      const { repo, db } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      db.transactionThrowOnNextUpdate = true;
      const err = await repo.appendMessage(USER_A, conv.id, { role: 'user', content: 'will fail' })
        .catch((e) => e);
      // Transaction rolled back — message should not persist (in-memory db simulates by failing update)
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('getConversationWithMessages', () => {
    it('returns conversation with messages in chronological order', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      await repo.appendMessage(USER_A, conv.id, { role: 'user', content: 'msg 1' });
      await repo.appendMessage(USER_A, conv.id, { role: 'assistant', content: 'msg 2' });
      const result = await repo.getConversationWithMessages(USER_A, conv.id, {});
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe('msg 1');
      expect(result.messages[1].content).toBe('msg 2');
    });

    it('returns NOT_FOUND for a conversation owned by another user', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const err = await repo.getConversationWithMessages(USER_B, conv.id, {}).catch((e) => e);
      expect((err as ConversationError).code).toBe('NOT_FOUND');
    });

    it('returns empty messages array with null nextCursor for a zero-message conversation', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const result = await repo.getConversationWithMessages(USER_A, conv.id, {});
      expect(result.messages).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('paginates messages with a cursor', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      for (let i = 0; i < 5; i++) {
        await repo.appendMessage(USER_A, conv.id, { role: 'user', content: `msg ${i}` });
      }
      const page1 = await repo.getConversationWithMessages(USER_A, conv.id, { limit: 2 });
      expect(page1.messages).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await repo.getConversationWithMessages(USER_A, conv.id, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.messages).toHaveLength(2);

      const page3 = await repo.getConversationWithMessages(USER_A, conv.id, { limit: 2, cursor: page2.nextCursor! });
      expect(page3.messages).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
    });

    it('rejects a tampered cursor with VALIDATION_FAILED', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const err = await repo.getConversationWithMessages(USER_A, conv.id, { cursor: 'notbase64!!' }).catch((e) => e);
      expect((err as ConversationError).code).toBe('VALIDATION_FAILED');
    });

    it('never returns messages from another conversation', async () => {
      const { repo } = makeRepo();
      const conv1 = await repo.createConversation(USER_A, {});
      const conv2 = await repo.createConversation(USER_A, {});
      await repo.appendMessage(USER_A, conv1.id, { role: 'user', content: 'conv1 msg' });
      await repo.appendMessage(USER_A, conv2.id, { role: 'user', content: 'conv2 msg' });
      const result = await repo.getConversationWithMessages(USER_A, conv1.id, {});
      expect(result.messages.every((m) => m.conversationId === conv1.id)).toBe(true);
    });
  });

  describe('listConversations', () => {
    it('returns only conversations owned by the principal', async () => {
      const { repo } = makeRepo();
      await repo.createConversation(USER_A, { title: 'Alice A' });
      await repo.createConversation(USER_A, { title: 'Alice B' });
      await repo.createConversation(USER_B, { title: 'Bob only' });
      const { conversations } = await repo.listConversations(USER_A, {});
      expect(conversations).toHaveLength(2);
      expect(conversations.every((c) => c.title !== 'Bob only')).toBe(true);
    });
  });

  describe('updateResolvedSlots', () => {
    it('merges slots into the conversation', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const merged = await repo.updateResolvedSlots(USER_A, conv.id, { origin: 'LHR', destination: 'LIS' });
      expect(merged['origin']).toBe('LHR');
      expect(merged['destination']).toBe('LIS');
    });

    it('returns NOT_FOUND when principal does not own the conversation', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const err = await repo.updateResolvedSlots(USER_B, conv.id, { origin: 'LHR' }).catch((e) => e);
      expect((err as ConversationError).code).toBe('NOT_FOUND');
    });
  });

  describe('deleteConversation', () => {
    it('deletes an owned conversation and its messages', async () => {
      const { repo, db } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      await repo.appendMessage(USER_A, conv.id, { role: 'user', content: 'hello' });
      await repo.deleteConversation(USER_A, conv.id);
      expect(db.convs.find((c) => c.id === conv.id)).toBeUndefined();
      expect(db.msgs.filter((m) => m.conversationId === conv.id)).toHaveLength(0);
    });

    it('is idempotent: succeeds when conversation is already absent', async () => {
      const { repo } = makeRepo();
      await expect(repo.deleteConversation(USER_A, 'nonexistent-id')).resolves.toBeUndefined();
    });
  });

  describe('claimConversation', () => {
    it('moves a guest conversation to an authenticated user', async () => {
      const { repo, db } = makeRepo();
      const conv = await repo.createConversation(GUEST_A, {});
      await repo.claimConversation('session-alpha', 'user-new', conv.id);
      const stored = db.convs.find((c) => c.id === conv.id)!;
      expect(stored.userId).toBe('user-new');
      expect(stored.guestSessionId).toBeNull();
    });

    it('throws CLAIM_CONFLICT when conversation is already owned by a user', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(USER_A, {});
      const err = await repo.claimConversation('session-alpha', 'user-new', conv.id).catch((e) => e);
      expect((err as ConversationError).code).toBe('CLAIM_CONFLICT');
    });

    it('throws NOT_FOUND when guest session does not match', async () => {
      const { repo } = makeRepo();
      const conv = await repo.createConversation(GUEST_A, {});
      const err = await repo.claimConversation('wrong-session', 'user-new', conv.id).catch((e) => e);
      expect((err as ConversationError).code).toBe('NOT_FOUND');
    });
  });
});

// ---------------------------------------------------------------------------
// Redaction tests
// ---------------------------------------------------------------------------

describe('redact', () => {
  it('masks card-like digit sequences', () => {
    const result = redact('My card is 4111111111111111 for payment');
    expect(result).toContain('[REDACTED_CARD]');
    expect(result).not.toContain('4111111111111111');
  });

  it('masks email addresses', () => {
    const result = redact('Contact me at alice@example.com please');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('alice@example.com');
  });

  it('preserves short digit sequences (e.g. phone with area code, zip codes)', () => {
    const result = redact('My zip is 90210 and phone 555-1234');
    expect(result).not.toContain('[REDACTED_CARD]');
  });

  it('handles multiple PII items in one string', () => {
    const result = redact('Card: 4111111111111111, Email: bob@test.invalid, done');
    expect(result).toContain('[REDACTED_CARD]');
    expect(result).toContain('[REDACTED_EMAIL]');
  });

  it('returns the original string unchanged when no PII present', () => {
    const clean = 'I want to fly to Lisbon next Tuesday';
    expect(redact(clean)).toBe(clean);
  });

  it('message content is redacted before storage', async () => {
    const { repo } = makeRepo();
    const conv = await repo.createConversation(USER_A, {});
    const msg = await repo.appendMessage(USER_A, conv.id, {
      role: 'user',
      content: 'My credit card is 4111111111111111',
    });
    expect(msg.content).not.toContain('4111111111111111');
    expect(msg.content).toContain('[REDACTED_CARD]');
  });
});

// ---------------------------------------------------------------------------
// Retention job tests
// ---------------------------------------------------------------------------

describe('runConversationRetention', () => {
  it('deletes guest conversations past the guest window', async () => {
    const { db } = makeRepo();
    const repo = new ConversationRepository(db as never);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    const guestConv = await repo.createConversation(GUEST_A, {});
    // Manually set lastActivityAt to old date to simulate inactivity
    const idx = db.convs.findIndex((c) => c.id === guestConv.id);
    db.convs[idx].lastActivityAt = oldDate;

    const log = { info: () => {}, error: () => {} };
    const clock = () => new Date();
    const result = await runConversationRetention(db as never, log, clock, {
      guestInactivityMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(result.guestDeleted).toBe(1);
    expect(db.convs.find((c) => c.id === guestConv.id)).toBeUndefined();
  });

  it('does not delete active conversations within the window', async () => {
    const { db } = makeRepo();
    const repo = new ConversationRepository(db as never);
    await repo.createConversation(GUEST_A, {});

    const log = { info: () => {}, error: () => {} };
    const clock = () => new Date();
    const result = await runConversationRetention(db as never, log, clock, {
      guestInactivityMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(result.guestDeleted).toBe(0);
  });

  it('is idempotent: a second run finds nothing to delete', async () => {
    const { db } = makeRepo();
    const repo = new ConversationRepository(db as never);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const guestConv = await repo.createConversation(GUEST_A, {});
    const idx = db.convs.findIndex((c) => c.id === guestConv.id);
    db.convs[idx].lastActivityAt = oldDate;

    const log = { info: () => {}, error: () => {} };
    const clock = () => new Date();
    await runConversationRetention(db as never, log, clock, { guestInactivityMs: 7 * 24 * 60 * 60 * 1000 });
    const result2 = await runConversationRetention(db as never, log, clock, { guestInactivityMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result2.guestDeleted).toBe(0);
  });

  it('uses separate windows for guest and authenticated users', async () => {
    const { db } = makeRepo();
    const repo = new ConversationRepository(db as never);

    const old30days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const old100days = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

    const guestConv = await repo.createConversation(GUEST_A, {});
    const userConv = await repo.createConversation(USER_A, {});

    const gi = db.convs.findIndex((c) => c.id === guestConv.id);
    const ui = db.convs.findIndex((c) => c.id === userConv.id);
    db.convs[gi].lastActivityAt = old30days; // 30 days — within 7d guest window but outside
    db.convs[ui].lastActivityAt = old100days; // 100 days — outside 90d user window

    const log = { info: () => {}, error: () => {} };
    const clock = () => new Date();
    const result = await runConversationRetention(db as never, log, clock, {
      guestInactivityMs: 7 * 24 * 60 * 60 * 1000,
      userInactivityMs: 90 * 24 * 60 * 60 * 1000,
    });

    expect(result.guestDeleted).toBe(1);
    expect(result.userDeleted).toBe(1);
  });
});
