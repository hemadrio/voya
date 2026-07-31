import { SupplierHttpClient } from '../../src/SupplierHttpClient.js';
import type { Clock } from '../../src/SupplierHttpClient.js';
import type { EgressAllowList } from '../../src/EgressAllowList.js';
import {
  SupplierTimeoutError,
  SupplierUnavailableError,
  SupplierRejectedRequestError,
  SupplierEgressBlockedError,
} from '../../src/errors.js';
import type { HardenedFetch, HardenedResponse } from '@travel/suppliers';
import { EgressDeniedError } from '@travel/suppliers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, body = '{}'): HardenedResponse {
  return {
    status,
    headers: {},
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async <T>() => JSON.parse(body) as T,
  };
}

const INSTANT_CLOCK: Clock = {
  now: () => 0,
  sleep: async (_ms: number) => undefined,
};

function makeAllowList(shouldBlock = false, blockedHost = ''): EgressAllowList {
  return {
    assert: jest.fn((url: string) => {
      if (shouldBlock) {
        const host = blockedHost || new URL(url).hostname;
        throw new SupplierEgressBlockedError('test-supplier', 'test-corr', host);
      }
    }),
  } as unknown as EgressAllowList;
}

function makeClient(
  transport: HardenedFetch,
  opts: { blockEgress?: boolean; blockedHost?: string } = {},
): SupplierHttpClient {
  return new SupplierHttpClient({
    supplierName: 'test-supplier',
    transport,
    egressAllowList: makeAllowList(opts.blockEgress ?? false, opts.blockedHost ?? ''),
    defaultTimeoutMs: 2_200,
    jitter: () => 0,
    clock: INSTANT_CLOCK,
  });
}

const URL = 'https://api.supplier.com/search';
const CORR = 'test-correlation-id';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('SupplierHttpClient — happy path', () => {
  it('returns a 2xx response unchanged', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(200, '{"ok":true}'));
    const client = makeClient(transport);

    const response = await client.request(URL, CORR);

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('forwards X-Correlation-Id header on every call', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(200));
    const client = makeClient(transport);

    await client.request(URL, CORR);

    const [, opts] = transport.mock.calls[0]!;
    expect(opts?.headers?.['x-correlation-id']).toBe(CORR);
  });

  it('merges caller-supplied headers with the correlation header', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(200));
    const client = makeClient(transport);

    await client.request(URL, CORR, {
      headers: { authorization: 'Bearer token123' },
    });

    const [, opts] = transport.mock.calls[0]!;
    expect(opts?.headers?.['authorization']).toBe('Bearer token123');
    expect(opts?.headers?.['x-correlation-id']).toBe(CORR);
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe('SupplierHttpClient — retry', () => {
  it('retries once on HTTP 503 and succeeds on second attempt', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));
    const client = makeClient(transport);

    const response = await client.request(URL, CORR);

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('throws SupplierUnavailableError after two 5xx responses', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(503));
    const client = makeClient(transport);

    await expect(client.request(URL, CORR)).rejects.toThrow(SupplierUnavailableError);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on HTTP 422 (4xx)', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(422));
    const client = makeClient(transport);

    await expect(client.request(URL, CORR)).rejects.toThrow(SupplierRejectedRequestError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when allowRetry is false', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(503));
    const client = makeClient(transport);

    await expect(
      client.request(URL, CORR, { allowRetry: false }),
    ).rejects.toThrow(SupplierUnavailableError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('calls clock.sleep with jitter value before the retry', async () => {
    const sleepSpy = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));

    const client = new SupplierHttpClient({
      supplierName: 'test-supplier',
      transport,
      egressAllowList: makeAllowList(),
      jitter: () => 50,
      clock: { now: () => 0, sleep: sleepSpy },
    });

    await client.request(URL, CORR);

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(50);
  });

  it('retries on network error (transport throws plain Error)', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeResponse(200));
    const client = makeClient(transport);

    const response = await client.request(URL, CORR);

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('SupplierHttpClient — timeout', () => {
  it('throws SupplierTimeoutError when transport throws with "timed out"', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockRejectedValue(new Error('Request timed out after 2200ms'));
    const client = makeClient(transport);

    const err = await client.request(URL, CORR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierTimeoutError);
    expect((err as SupplierTimeoutError).timeoutMs).toBe(2_200);
  });

  it('throws SupplierTimeoutError when transport throws with "timeout"', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockRejectedValue(new Error('socket hang up: timeout'));
    const client = makeClient(transport);

    await expect(client.request(URL, CORR)).rejects.toBeInstanceOf(SupplierTimeoutError);
  });

  it('uses per-call timeoutMs if provided', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockRejectedValue(new Error('Request timed out'));
    const client = makeClient(transport);

    const err = await client.request(URL, CORR, { timeoutMs: 500 }).catch((e: unknown) => e);

    expect((err as SupplierTimeoutError).timeoutMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Egress allow-list enforcement
// ---------------------------------------------------------------------------

describe('SupplierHttpClient — egress allow-list', () => {
  it('throws SupplierEgressBlockedError without calling transport when allow-list denies', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(200));
    const client = makeClient(transport, {
      blockEgress: true,
      blockedHost: 'api.supplier.com',
    });

    await expect(client.request(URL, CORR)).rejects.toThrow(SupplierEgressBlockedError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('wraps EgressDeniedError from transport into SupplierEgressBlockedError', async () => {
    const denied = new EgressDeniedError('api.supplier.com', 'not in allow-list');
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockRejectedValue(denied);
    const client = makeClient(transport);

    const err = await client.request(URL, CORR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierEgressBlockedError);
  });

  it('SupplierEgressBlockedError carries supplierName and correlationId', async () => {
    const client = makeClient(
      jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>().mockResolvedValue(makeResponse(200)),
      { blockEgress: true, blockedHost: 'blocked.com' },
    );

    const err = await client.request(URL, CORR).catch((e: unknown) => e);

    expect((err as SupplierEgressBlockedError).supplierName).toBe('test-supplier');
    expect((err as SupplierEgressBlockedError).correlationId).toBe(CORR);
    expect((err as SupplierEgressBlockedError).attemptedHost).toBe('blocked.com');
  });
});

// ---------------------------------------------------------------------------
// Error normalization — HTTP 4xx
// ---------------------------------------------------------------------------

describe('SupplierHttpClient — 4xx error mapping', () => {
  it('maps 404 to SupplierRejectedRequestError with httpStatus 404', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(404));
    const client = makeClient(transport);

    const err = await client.request(URL, CORR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierRejectedRequestError);
    expect((err as SupplierRejectedRequestError).httpStatus).toBe(404);
  });

  it('maps 401 to SupplierRejectedRequestError', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(401));
    const client = makeClient(transport);

    await expect(client.request(URL, CORR)).rejects.toBeInstanceOf(SupplierRejectedRequestError);
  });
});

// ---------------------------------------------------------------------------
// Error normalization — HTTP 5xx
// ---------------------------------------------------------------------------

describe('SupplierHttpClient — 5xx error mapping', () => {
  it('carries httpStatus on SupplierUnavailableError from 5xx response', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockResolvedValue(makeResponse(503));
    const client = makeClient(transport);

    const err = await client.request(URL, CORR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierUnavailableError);
    expect((err as SupplierUnavailableError).httpStatus).toBe(503);
  });

  it('carries undefined httpStatus on SupplierUnavailableError from network error', async () => {
    const transport = jest.fn<ReturnType<HardenedFetch>, Parameters<HardenedFetch>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeClient(transport);

    const err = await client.request(URL, CORR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierUnavailableError);
    expect((err as SupplierUnavailableError).httpStatus).toBeUndefined();
  });
});
