import type { RankingWeights } from './types.js';

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  priceWeight: 100,
  cabinClassMatchBonus: 20,
  hotelStarMatchBonus: 15,
  carClassMatchBonus: 10,
  homeAirportMatchBonus: 5,
};

export function validateWeights(weights: RankingWeights): void {
  const keys: ReadonlyArray<keyof RankingWeights> = [
    'priceWeight',
    'cabinClassMatchBonus',
    'hotelStarMatchBonus',
    'carClassMatchBonus',
    'homeAirportMatchBonus',
  ];
  for (const key of keys) {
    const value = weights[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Invalid ranking weight for "${key}": must be a non-negative finite number, got ${String(value)}`,
      );
    }
  }
}
