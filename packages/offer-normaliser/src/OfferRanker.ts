import type { Offer } from '@travel/contracts';
import type {
  MemberPreferences,
  RankedOffer,
  RankerConfig,
  RankingExplanation,
} from './types.js';
import { validateWeights } from './rankingWeights.js';

interface ScoredOffer {
  readonly offer: Offer;
  readonly score: number;
  readonly priceComponent: number;
  readonly bonuses: Record<string, number>;
  readonly matchedPreferences: string[];
}

export class OfferRanker {
  private readonly config: RankerConfig;

  constructor(opts: { config: RankerConfig }) {
    validateWeights(opts.config.weights);
    this.config = opts.config;
  }

  rank(
    offers: ReadonlyArray<Offer>,
    preferences: MemberPreferences,
  ): ReadonlyArray<RankedOffer> {
    const bookable = offers.filter((o) => o.bookable);
    const nonBookable = offers.filter((o) => !o.bookable);

    return [
      ...this._rankGroup(bookable, preferences),
      ...this._rankGroup(nonBookable, preferences),
    ];
  }

  private _rankGroup(
    offers: ReadonlyArray<Offer>,
    preferences: MemberPreferences,
  ): ReadonlyArray<RankedOffer> {
    if (offers.length === 0) return [];

    const { weights } = this.config;
    const prices = offers.map((o) => o.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice;

    const scored: ScoredOffer[] = offers.map((offer): ScoredOffer => {
      const priceComponent =
        priceRange > 0
          ? (weights.priceWeight * (maxPrice - offer.price)) / priceRange
          : 0;

      const bonuses: Record<string, number> = {};
      const matchedPreferences: string[] = [];
      const details = offer.details as Record<string, unknown>;

      // Cabin class bonus (flight preference)
      if (
        preferences.cabinClass !== undefined &&
        typeof details['cabinClass'] === 'string' &&
        details['cabinClass'] === preferences.cabinClass
      ) {
        bonuses['cabinClass'] = weights.cabinClassMatchBonus;
        matchedPreferences.push('cabinClass');
      }

      // Hotel star bonus (uses offer.rating field; absent rating is not penalised)
      if (
        preferences.minHotelStars !== undefined &&
        offer.rating !== undefined &&
        offer.rating >= preferences.minHotelStars
      ) {
        bonuses['hotelStars'] = weights.hotelStarMatchBonus;
        matchedPreferences.push('hotelStars');
      }

      // Car class bonus
      if (
        preferences.carClass !== undefined &&
        typeof details['vehicleClass'] === 'string' &&
        details['vehicleClass'] === preferences.carClass
      ) {
        bonuses['carClass'] = weights.carClassMatchBonus;
        matchedPreferences.push('carClass');
      }

      // Home airport bonus (departure airport in offer details)
      if (
        preferences.homeAirports !== undefined &&
        preferences.homeAirports.length > 0
      ) {
        const depAirport = details['departureAirport'];
        if (
          typeof depAirport === 'string' &&
          preferences.homeAirports.includes(depAirport)
        ) {
          bonuses['homeAirport'] = weights.homeAirportMatchBonus;
          matchedPreferences.push('homeAirport');
        }
      }

      const totalBonus = Object.values(bonuses).reduce((sum, v) => sum + v, 0);
      const score = priceComponent + totalBonus;

      return { offer, score, priceComponent, bonuses, matchedPreferences };
    });

    scored.sort((a, b) => {
      // Score descending
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break 1: price ascending
      if (a.offer.price !== b.offer.price) return a.offer.price - b.offer.price;
      // Tie-break 2: supplier name ascending
      const aSupplier = this._supplierName(a.offer);
      const bSupplier = this._supplierName(b.offer);
      if (aSupplier !== bSupplier) return aSupplier.localeCompare(bSupplier);
      // Tie-break 3: offer id ascending
      return a.offer.id.localeCompare(b.offer.id);
    });

    return scored.map((s): RankedOffer => {
      if (!this.config.exposeRankingExplanation) {
        return { offer: s.offer };
      }
      const explanation: RankingExplanation = {
        score: s.score,
        priceComponent: s.priceComponent,
        bonuses: s.bonuses,
        matchedPreferences: s.matchedPreferences,
      };
      return { offer: s.offer, rankingExplanation: explanation };
    });
  }

  private _supplierName(offer: Offer): string {
    const details = offer.details as Record<string, unknown>;
    const detailsSupplier = details['supplier'];
    if (typeof detailsSupplier === 'string') return detailsSupplier;
    return offer.provenance;
  }
}
