export type {
  KeyMaterial,
  KeyPair,
  KeyStore,
  KeyProviderOptions,
} from './keys/keyProvider.js';

export { KeyProvider } from './keys/keyProvider.js';
export { SecretsManagerKeyStore } from './keys/secretsManagerKeyStore.js';
export type { GetSecretFn } from './keys/secretsManagerKeyStore.js';

// Authorization middleware
export {
  mintActorContext,
  verifyActorContext,
  createActorContextMiddleware,
} from './middleware/actorContextVerifier.js';
export type {
  ActorContextPayload,
  ActorContextMiddlewareOptions,
  VerifyActorContextResult,
} from './middleware/actorContextVerifier.js';

export {
  requireRole,
  allowGuest,
  denyByDefault,
  registerRouteGuard,
  getGuardRegistry,
  assertAllRoutesGuarded,
  GUEST_ROUTES,
  _clearGuardRegistry,
} from './middleware/authorize.js';
export type { GuardType } from './middleware/authorize.js';
