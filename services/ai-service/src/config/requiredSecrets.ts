import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for ai-service (AI orchestration).
 *
 * ai-service calls the Anthropic Claude API for conversational travel planning.
 * The Anthropic API key must never carry a placeholder value — the service
 * would start successfully but every Claude call would return 401 Unauthorized.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'ANTHROPIC_API_KEY',
    description:
      'Anthropic API key for Claude model access (sk-ant-*). ' +
      'Required for all AI-assisted travel planning requests.',
    minLength: 20,
  },
  {
    envVar: 'JWT_PUBLIC_KEY',
    description:
      'RS256 public key PEM used to verify inbound JWTs from the api-gateway.',
    minLength: 50,
  },
];
