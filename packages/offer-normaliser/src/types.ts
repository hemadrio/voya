import type { Offer } from '@travel/contracts';

export interface MemberPreferences {
  readonly cabinClass?: 'ECONOMY' | 'BUSINESS' | 'FIRST';
  readonly minHotelStars?: number;
  readonly carClass?: 'ECONOMY' | 'COMPACT' | 'MIDSIZE' | 'PREMIUM';
  readonly homeAirports?: ReadonlyArray<string>;
}

export interface RankingWeights {
  readonly priceWeight: number;
  readonly cabinClassMatchBonus: number;
  readonly hotelStarMatchBonus: number;
  readonly carClassMatchBonus: number;
  readonly homeAirportMatchBonus: number;
}

export interface RankingExplanation {
  readonly score: number;
  readonly priceComponent: number;
  readonly bonuses: Readonly<Record<string, number>>;
  readonly matchedPreferences: ReadonlyArray<string>;
}

export interface RankedOffer {
  readonly offer: Offer;
  readonly rankingExplanation?: RankingExplanation;
}

export interface NormaliserConfig {
  readonly category: string;
}

export interface RankerConfig {
  readonly weights: RankingWeights;
  readonly exposeRankingExplanation: boolean;
}

export interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}
