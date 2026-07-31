/**
 * Strip any inbound x-internal-actor header at the gateway edge.
 *
 * This header is set by the gateway after successful JWT verification to pass
 * the verified actor context to downstream services. A client that sends this
 * header must not be able to forge actor context; this middleware removes any
 * inbound value before authentication runs.
 *
 * Mount this as the FIRST middleware in the chain, before authentication, so
 * no path can forward a client-supplied actor context to a backend service.
 */

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

type NextFn = () => void;

export function stripInternalActorHeader(
  req: RequestLike,
  _res: unknown,
  next: NextFn,
): void {
  // delete is safe even when the header is absent
  delete req.headers['x-internal-actor'];
  next();
}
