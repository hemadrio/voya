import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for search-service.
 *
 * search-service fans out to Amadeus GDS (flights) and RapidAPI (hotels, cars).
 * Supplier keys are marked allowEmptyInDev because local development typically
 * runs against mock suppliers; they are strictly required in staging/production.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'AMADEUS_CLIENT_SECRET',
    description:
      'Amadeus GDS OAuth2 client secret used to obtain bearer tokens for ' +
      'flight search API calls.',
    allowEmptyInDev: true,
  },
  {
    envVar: 'AMADEUS_CLIENT_ID',
    description:
      'Amadeus GDS OAuth2 client ID (paired with AMADEUS_CLIENT_SECRET).',
    allowEmptyInDev: true,
  },
  {
    envVar: 'RAPIDAPI_KEY',
    description:
      'RapidAPI key for hotel and car rental provider calls.',
    allowEmptyInDev: true,
  },
];
