/**
 * AI assistant tool-call payload fixtures.
 *
 * Represents the shape of a Claude tool-call result that ai-service receives
 * and forwards to search-service or booking-service. Synthetic values only.
 */

export const SYNTHETIC_AI_TOOL_CALL_PAYLOAD = {
  tool_use_id: "SYNTH-TOOL-USE-0000000001",
  tool_name: "search_flights",
  input: {
    departureAirport: "LHR",
    arrivalAirport: "JFK",
    departureDate: "2027-03-01T00:00:00.000Z",
    returnDate: "2027-03-08T00:00:00.000Z",
    passengers: 1,
    seatClass: "ECONOMY",
    currency: "USD",
  },
};

export const SYNTHETIC_AI_ITINERARY_RESPONSE = {
  id: "SYNTH-ITINERARY-AI-0001",
  title: "Synthetic AI-Generated Itinerary",
  summary: "A synthetic itinerary produced by the AI assistant for test purposes.",
  legs: [
    {
      type: "FLIGHT",
      offerId: "SYNTH-AMADEUS-FL-001",
      description: "Outbound LHR → JFK",
    },
    {
      type: "HOTEL",
      offerId: "SYNTH-RAPIDAPI-HT-001",
      description: "New York hotel, 7 nights",
    },
    {
      type: "CAR",
      offerId: "SYNTH-AMADEUS-CR-001",
      description: "Compact car rental, 7 days",
    },
  ],
};
