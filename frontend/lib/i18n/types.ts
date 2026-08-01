/**
 * TypeScript types for the i18n message catalogue.
 *
 * `Messages` is the runtime shape of a locale JSON file.
 * `MessageKey` is a union of all dot-notation keys — missing or misspelled keys
 * fail typecheck.
 */

export type Messages = Record<string, unknown>;

/** All valid dot-notation message keys in the catalogue. */
export type MessageKey =
  | "nav.searchFlights"
  | "nav.searchHotels"
  | "nav.searchCars"
  | "nav.myTrips"
  | "nav.signIn"
  | "nav.signUp"
  | "nav.signOut"
  | "nav.account"
  | "home.title"
  | "home.subtitle"
  | "home.cta.flights"
  | "home.cta.hotels"
  | "search.title"
  | "search.noResults"
  | "search.loading"
  | "search.filterLabel"
  | "search.sortLabel"
  | "search.nightsLabel"
  | "search.guestsLabel"
  | "search.priceLabel"
  | "search.perNight"
  | "search.totalPrice"
  | "search.bookNow"
  | "search.viewDetails"
  | "checkout.title"
  | "checkout.summary"
  | "checkout.payNow"
  | "checkout.cancel"
  | "checkout.priceChangedTitle"
  | "checkout.priceChangedBody"
  | "listing.nights"
  | "listing.guests"
  | "listing.reserve"
  | "listing.reviews"
  | "common.loading"
  | "common.error"
  | "common.retry"
  | "common.back"
  | "common.save"
  | "common.cancel"
  | "common.confirm"
  | "common.close"
  | "common.currency"
  | "common.language"
  | "auth.signIn"
  | "auth.signUp"
  | "auth.email"
  | "auth.password"
  | "auth.forgotPassword"
  | "auth.continueWithGoogle"
  | "account.title"
  | "account.profile"
  | "account.security"
  | "account.trips"
  | "account.wishlist"
  | "errors.notFound"
  | "errors.serverError"
  | "errors.unauthorized";

/** Plural-sensitive message keys. */
export type PluralMessageKey = "listing.nights" | "listing.guests" | "search.nightsLabel";
