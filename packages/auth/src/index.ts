export type {
  KeyMaterial,
  KeyPair,
  KeyStore,
  KeyProviderOptions,
} from './keys/keyProvider.js';

export { KeyProvider } from './keys/keyProvider.js';
export { SecretsManagerKeyStore } from './keys/secretsManagerKeyStore.js';
export type { GetSecretFn } from './keys/secretsManagerKeyStore.js';
