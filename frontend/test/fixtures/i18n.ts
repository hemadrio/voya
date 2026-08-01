/**
 * i18n test fixtures — message catalogues, priced responses in two currencies,
 * and locale negotiation inputs for unit and integration tests.
 */

// ---------------------------------------------------------------------------
// Minimal message catalogues for testing
// ---------------------------------------------------------------------------

export const EN_MESSAGES = {
  nav: {
    searchFlights: "Search Flights",
    searchHotels: "Find Hotels",
    myTrips: "My Trips",
    signIn: "Sign in",
    signOut: "Sign out",
    account: "Account",
  },
  home: {
    title: "Your journey starts here",
    subtitle: "Search flights, hotels, and cars.",
    cta: { flights: "Search Flights", hotels: "Find Hotels" },
  },
  search: {
    title: "Search results",
    noResults: "No results found.",
    loading: "Searching…",
    perNight: "per night",
    bookNow: "Book now",
  },
  common: {
    loading: "Loading…",
    error: "Something went wrong",
    retry: "Try again",
    currency: "Currency",
    language: "Language",
  },
  listing: {
    nights: "{count} nights",
    guests: "{count} guests",
    reserve: "Reserve",
    reviews: "{count} reviews",
  },
  errors: {
    notFound: "Page not found",
    serverError: "A server error occurred.",
    unauthorized: "You must be signed in.",
  },
} as const;

export const ES_MESSAGES = {
  nav: {
    searchFlights: "Buscar vuelos",
    searchHotels: "Buscar hoteles",
    myTrips: "Mis viajes",
    signIn: "Iniciar sesión",
    signOut: "Cerrar sesión",
    account: "Cuenta",
  },
  home: {
    title: "Tu viaje comienza aquí",
    subtitle: "Busca vuelos, hoteles y coches.",
    cta: { flights: "Buscar vuelos", hotels: "Buscar hoteles" },
  },
  search: {
    title: "Resultados de búsqueda",
    noResults: "No se encontraron resultados.",
    loading: "Buscando…",
    perNight: "por noche",
    bookNow: "Reservar ahora",
  },
  common: {
    loading: "Cargando…",
    error: "Algo salió mal",
    retry: "Intentar de nuevo",
    currency: "Moneda",
    language: "Idioma",
  },
  listing: {
    nights: "{count} noches",
    guests: "{count} huéspedes",
    reserve: "Reservar",
    reviews: "{count} opiniones",
  },
  errors: {
    notFound: "Página no encontrada",
    serverError: "Se produjo un error.",
    unauthorized: "Debes iniciar sesión.",
  },
} as const;

export const AR_MESSAGES = {
  nav: {
    searchFlights: "البحث عن رحلات",
    searchHotels: "البحث عن فنادق",
    myTrips: "رحلاتي",
    signIn: "تسجيل الدخول",
    signOut: "تسجيل الخروج",
    account: "حسابي",
  },
  home: {
    title: "رحلتك تبدأ من هنا",
    subtitle: "ابحث عن الرحلات والفنادق والسيارات.",
    cta: { flights: "البحث عن رحلات", hotels: "البحث عن فنادق" },
  },
  search: {
    title: "نتائج البحث",
    noResults: "لم يتم العثور على نتائج.",
    loading: "جارٍ البحث…",
    perNight: "في الليلة",
    bookNow: "احجز الآن",
  },
  common: {
    loading: "جارٍ التحميل…",
    error: "حدث خطأ ما",
    retry: "حاول مرة أخرى",
    currency: "العملة",
    language: "اللغة",
  },
  listing: {
    nights: "{count} ليالٍ",
    guests: "{count} ضيوف",
    reserve: "احجز",
    reviews: "{count} تقييمات",
  },
  errors: {
    notFound: "الصفحة غير موجودة",
    serverError: "حدث خطأ في الخادم.",
    unauthorized: "يجب عليك تسجيل الدخول.",
  },
} as const;

// ---------------------------------------------------------------------------
// Priced search responses in two currencies (USD and EUR)
// ---------------------------------------------------------------------------

export const PRICED_RESPONSE_USD = {
  currency: "USD",
  results: [
    {
      id: "offer-001",
      title: "Beachfront Suite",
      price: { currency: "USD", nightly: 150, total: 1050, nights: 7, taxesIncluded: true },
    },
    {
      id: "offer-002",
      title: "City Center Hotel",
      price: { currency: "USD", nightly: 89, total: 623, nights: 7, taxesIncluded: false },
    },
  ],
};

export const PRICED_RESPONSE_EUR = {
  currency: "EUR",
  results: [
    {
      id: "offer-001",
      title: "Beachfront Suite",
      price: { currency: "EUR", nightly: 138, total: 966, nights: 7, taxesIncluded: true },
    },
    {
      id: "offer-002",
      title: "City Center Hotel",
      price: { currency: "EUR", nightly: 82, total: 574, nights: 7, taxesIncluded: false },
    },
  ],
};

// ---------------------------------------------------------------------------
// Locale negotiation test cases
// ---------------------------------------------------------------------------

export const NEGOTIATION_CASES = [
  { description: "cookie present and valid", cookieLocale: "es", acceptLanguage: undefined, expected: "es" },
  { description: "cookie present but unsupported", cookieLocale: "fr", acceptLanguage: "en-US", expected: "en" },
  { description: "no cookie, Accept-Language exact match", cookieLocale: undefined, acceptLanguage: "ar", expected: "ar" },
  { description: "no cookie, Accept-Language region variant", cookieLocale: undefined, acceptLanguage: "es-419,es;q=0.9", expected: "es" },
  { description: "no cookie, Accept-Language unsupported", cookieLocale: undefined, acceptLanguage: "fr,de;q=0.8", expected: "en" },
  { description: "no cookie, no header", cookieLocale: undefined, acceptLanguage: undefined, expected: "en" },
  { description: "malformed Accept-Language falls back to default", cookieLocale: undefined, acceptLanguage: ";;", expected: "en" },
  { description: "cookie takes precedence over Accept-Language", cookieLocale: "ar", acceptLanguage: "en-US,en;q=0.9", expected: "ar" },
] as const;
