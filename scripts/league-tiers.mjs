// league-tiers.mjs
//
// Flight (tier) of each league WITHIN ITS OWN COUNTRY, for every league likely to
// appear on a 2026 World Cup roster. 1 = top flight, 2 = second, etc. "NA" = a real
// competition with no clean national-tier answer (state championships, breakaway or
// amateur leagues): the tier column shows nothing and the tier filter skips it.
//
// build-clubs.mjs handles the rest structurally: cups, continental competitions,
// women's, youth, reserve/development and other-sport leagues are skipped entirely
// (never reach this map); season prefixes ("2005-06 Serie C1") are stripped; country
// labels are canonicalised (West Germany, Second Polish Republic, Czech Republic,
// Ivory Coast, etc.); and when a league has no country in Wikidata the club's own
// country picks the bucket. Names are read case- and accent-insensitively. Country
// buckets disambiguate names shared across countries (Ligue 1, Serie A, A-League...).
//
// Anything still unmatched is written to clubs.json -> unmappedLeagues.

export const LEAGUE_TIERS = {
  // ----- UEFA -----
  England: {
    "Premier League": 1,
    "EFL Championship": 2, "Championship": 2,
    "EFL League One": 3, "League One": 3,
    "EFL League Two": 4, "League Two": 4,
    "National League": 5,
    "National League North": 6, "National League South": 6,
    "Northern Premier League": 7, "Northern Premier League Premier Division": 7,
    "Southern Football League": 7, "Isthmian League": 7,
    "United Counties League": 9,
  },
  Scotland: {
    "Scottish Premiership": 1, "Premiership": 1,
    "Scottish Premier League": 1, "Scottish Football League": 1, // historical (pre-2013) senior leagues
    "Scottish Championship": 2, "Scottish Football League First Division": 2,
    "Scottish League One": 3, "Scottish Football League Second Division": 3,
    "Scottish League Two": 4, "Scottish Football League Third Division": 4,
    "Lowland Football League": 5, "Highland Football League": 5,
    "Scottish Professional Football League": "NA", // the 4-division body, no single tier
  },
  Wales: { "Cymru Premier": 1 },
  Ireland: { "League of Ireland Premier Division": 1, "Premier Division": 1, "League of Ireland First Division": 2 },
  Spain: {
    "LaLiga": 1, "La Liga": 1, "Primera Division": 1, "LaLiga EA Sports": 1,
    "LaLiga2": 2, "LaLiga 2": 2, "Segunda Division": 2, "LaLiga Hypermotion": 2,
    "Primera Federacion": 3, "Segunda División B": 3, // Segunda B = old third tier (pre-2021)
    "Segunda Federación": 4, "Tercera División": 4,
    "Tercera Federación": 5,
  },
  Italy: { "Serie A": 1, "Serie B": 2, "Serie C": 3, "Serie C1": 3, "Serie C2": 4, "Serie D": 4 },
  Germany: {
    "Bundesliga": 1,
    "2. Bundesliga": 2, "2 Bundesliga": 2, "Zweite Bundesliga": 2,
    "2. Fußball-Bundesliga": 2, "2. Fußball-Bundesliga Süd": 2, "2. Fußball-Bundesliga Nord": 2,
    "3. Liga": 3, "3 Liga": 3,
    "Regionalliga": 4, "Regionalliga Nord": 4, "Regionalliga Nordost": 4, "Regionalliga West": 4,
    "Regionalliga Südwest": 4, "Fußball-Regionalliga Südwest": 4, "Regionalliga Bayern": 4,
    "Regionalliga Süd": 4,
    "Oberliga": 5, "Oberliga Hamburg": 5, "Oberliga Baden-Württemberg": 5, "Oberliga Westfalen": 5,
    "Hessenliga": 5, "NRW-Liga": 5,
  },
  France: {
    "Ligue 1": 1, "Ligue 1 Uber Eats": 1,
    "Ligue 2": 2,
    "Championnat National": 3, "National": 3, "Championnat National 1": 3,
    "Championnat National 2": 4, "Championnat National 3": 5,
    "Ligue 3": "NA", // no real French "Ligue 3"; surfaced as a Wikidata oddity
  },
  Netherlands: {
    "Eredivisie": 1, "Eerste Divisie": 2, "Keuken Kampioen Divisie": 2,
    "Tweede Divisie": 3, "Derde Divisie": 4, "Vierde divisie": 5,
  },
  Portugal: {
    "Primeira Liga": 1, "Liga Portugal": 1, "Liga Portugal Betclic": 1,
    "Liga Portugal 2": 2, "Segunda Liga": 2, "Liga Portugal 2 Meu Super": 2,
    "Liga 3": 3, "Segunda Divisão": 3,
    "Campeonato de Portugal": 4, "Terceira Divisão": 4,
    "Porto Football Association": "NA", "Portuguese District Football Associations": "NA", // regional, not a national tier
  },
  Belgium: {
    "Belgian Pro League": 1, "Jupiler Pro League": 1, "Pro League": 1, "Belgian First Division A": 1,
    "Challenger Pro League": 2, "Belgian First Division B": 2,
    "Belgian Third Division": 3,
    "Belgian Division 1": "NA", // era-dependent Belgian naming, ambiguous tier
  },
  Switzerland: {
    "Swiss Super League": 1, "Super League": 1,
    "Swiss Challenge League": 2, "Challenge League": 2,
    "Promotion League": 3,
  },
  Austria: {
    "Austrian Bundesliga": 1, "Bundesliga": 1,
    "2. Liga": 2, "Zweite Liga": 2, "Austrian Football Second League": 2,
    "Regionalliga": 3, "Austrian Regional League": 3, "Austrian Regional League East": 3,
    "Regionalliga Salzburg": 3, "Regionalliga Ost": 3, "Regionalliga Mitte": 3, "Regionalliga West": 3,
  },
  Greece: { "Super League Greece": 1, "Super League": 1, "Super League Greece 2": 2 },
  Turkey: {
    "Super Lig": 1, "Suuper Lig": 1,
    "TFF First League": 2, "TFF 1. Lig": 2, "1. Lig": 2,
    "TFF Second League": 3, "TFF 2. Lig": 3,
    "TFF Third League": 4, "TFF 3. Lig": 4,
    "A2 Ligi": "NA", "Milli Küme Şampiyonası": "NA", // reserve league; defunct 1930s-50s championship
  },
  Croatia: {
    "Croatian Football League": 1, "HNL": 1, "Prva HNL": 1, "SuperSport HNL": 1,
    "First Football League": 2, "Prva nogometna liga": 2,
  },
  Czechia: {
    "Czech First League": 1, "Fortuna Liga": 1, "Chance Liga": 1,
    "Czech National Football League": 2, "Czech FNL": 2,
    "Bohemian Football League": 3, "Moravian-Silesian Football League": 3,
  },
  Denmark: { "Danish Superliga": 1, "Superliga": 1, "Danish 1st Division": 2, "1st Division": 2, "Zealand Series": "NA" },
  Norway: {
    "Eliteserien": 1,
    "OBOS-ligaen": 2, "First Division": 2, "1. divisjon": 2, "1. divisjon football": 2,
    "Norwegian Second Division": 3, "Norwegian Third Division": 4,
  },
  Sweden: {
    "Allsvenskan": 1, "Superettan": 2,
    "Ettan": 3, "Ettan Fotboll": 3, "Ettan Norra": 3, "Ettan Södra": 3,
    "Swedish Football Division 2": 4, "Swedish Football Division 3": 5,
  },
  Poland: { "Ekstraklasa": 1, "I liga": 2 },
  Ukraine: { "Ukrainian Premier League": 1, "Premier League": 1 },
  Russia: {
    "Russian Premier League": 1, "Premier League": 1,
    "Russian First League": 2, "Russian Football National League": 2,
    "Russian Second League": 3,
    "Russian Amateur Football League Competition": "NA",
  },
  Serbia: { "Serbian SuperLiga": 1, "SuperLiga": 1, "Serbian First League": 2, "Prva Liga": 2 },
  Romania: { "Liga I": 1, "SuperLiga": 1, "Superliga": 1, "Liga II": 2, "Liga III": 3, "Liga IV": 4, "Liga IV Cluj": 4 },
  Hungary: { "Nemzeti Bajnoksag I": 1, "NB I": 1, "NB1": 1, "Nemzeti Bajnokság II": 2, "NB II": 2 },
  Bulgaria: { "First Professional Football League": 1, "Parva liga": 1 },
  Slovakia: { "Slovak First Football League": 1, "Niké liga": 1, "Super Liga": 1, "Slovak Second Football League": 2 },
  Slovenia: { "Slovenian PrvaLiga": 1, "PrvaLiga": 1, "Slovenian Second League": 2 },
  Cyprus: { "Cypriot First Division": 1, "First Division": 1 },
  "Bosnia and Herzegovina": {
    "Premier League of Bosnia and Herzegovina": 1, "Premijer Liga": 1,
    "First League of the Republika Srpska": 2, "First League of the Federation of Bosnia and Herzegovina": 2,
  },
  Moldova: { "Moldovan National Division": 1, "Divizia Nationala": 1 },
  Kazakhstan: { "Kazakhstan Premier League": 1, "Kazakhstan First League": 2 },
  Israel: { "Israeli Premier League": 1, "Ligat ha'Al": 1, "Liga Leumit": 2 },

  // ----- CONCACAF -----
  // North America is one market: MLS above the USL pyramid and above CPL. CPL = 2 is the
  // judgment call you described; flip to 1 to treat it as Canada's standalone top flight.
  // The old USL/A-League names below are the defunct US lower divisions (Charleston Battery
  // history); "A-League" resolves to tier 1 in Australia and tier 2 here via the country bucket.
  "United States": {
    "Major League Soccer": 1, "MLS": 1,
    "USL Championship": 2, "United Soccer League": 2, "USL First Division": 2, "A-League": 2,
    "USL League One": 3, "MLS Next Pro": 3, "USL Second Division": 3, "National Independent Soccer Association": 3,
    "North American Soccer League": 2,
    "USL League Two": 4, // pre-professional / amateur
    "NCAA Division I men's soccer": "NA", "Big Ten Conference": "NA", "Atlantic Coast Conference": "NA",
    "National Premier Soccer League": "NA", "Cosmopolitan Soccer League": "NA",
  },
  Canada: {
    "Canadian Premier League": 2, // judgment call (see note above)
    "Major League Soccer": 1, "MLS": 1,
    "United Soccer League": 2, "USL First Division": 2, "USL Second Division": 3, // ambiguous-country old USL
    "Canadian Soccer League": "NA",
  },
  Mexico: {
    "Liga MX": 1, "Primera Division": 1,
    "Liga de Expansion MX": 2, "MX Expansion League": 2, "Ascenso MX": 2, "Liga de Ascenso": 2,
    "Liga de Balompié Mexicano": "NA",
  },
  "Costa Rica": { "Liga FPD": 1, "Primera Division": 1 },
  Panama: { "Liga Panamena de Futbol": 1, "LPF": 1 },
  Honduras: { "Liga Nacional": 1 },
  Jamaica: { "Jamaica Premier League": 1, "National Premier League": 1 },
  Haiti: { "Ligue Haitienne": 1 },

  // ----- CONMEBOL -----
  // Brazilian state championships run alongside the national Serie A/B/C/D and are not a
  // national tier, so they are NA.
  Brazil: {
    "Campeonato Brasileiro Serie A": 1, "Serie A": 1, "Brasileirao": 1,
    "Campeonato Brasileiro Serie B": 2, "Serie B": 2,
    "Campeonato Brasileiro Serie C": 3, "Serie C": 3,
    "Campeonato Brasileiro Serie D": 4, "Serie D": 4,
    "Campeonato Paulista": "NA", "Campeonato Paulista de Futebol": "NA", "Campeonato Paulista Série A2": "NA",
    "Campeonato Carioca": "NA", "Campeonato Mineiro": "NA", "Campeonato Gaúcho": "NA", "Campeonato Baiano": "NA",
    "Campeonato Pernambucano": "NA", "Campeonato Paranaense": "NA", "Campeonato Cearense": "NA",
    "Campeonato Goiano": "NA", "Campeonato Catarinense": "NA", "Campeonato Mato-Grossense": "NA",
  },
  Argentina: {
    "Argentine Primera Division": 1, "Primera Division": 1, "Liga Profesional de Futbol": 1, "Liga Profesional": 1,
    "Primera Nacional": 2,
  },
  Colombia: { "Categoria Primera A": 1, "Primera A": 1, "Liga BetPlay": 1, "Categoria Primera B": 2, "Primera B": 2 },
  Uruguay: { "Uruguayan Primera Division": 1, "Primera Division": 1, "Uruguayan Segunda División": 2, "Segunda Division": 2 },
  Paraguay: {
    "Paraguayan Primera Division": 1, "Primera Division": 1, "Division Profesional": 1,
    "Paraguayan División Intermedia": 2, "Division Intermedia": 2,
  },
  Ecuador: {
    "Ecuadorian Serie A": 1, "Serie A": 1, "Ecuador Serie A": 1, "LigaPro": 1,
    "Ecuadorian Serie B": 2, "Serie B": 2, "Second category of Ecuador": 3, "Segunda Categoria": 3,
  },
  Chile: { "Chilean Primera Division": 1, "Primera Division": 1, "Chilean First B Division": 2, "Primera B": 2 },
  Peru: { "Liga 1": 1, "Primera Division": 1, "Peruvian Primera División": 1 },
  Bolivia: { "Bolivian Primera Division": 1, "Division Profesional": 1 },

  // ----- AFC -----
  "Saudi Arabia": {
    "Saudi Pro League": 1, "Saudi Professional League": 1,
    "Saudi First Division League": 2, "Saudi The first Division": 2, "First Division": 2,
  },
  Qatar: { "Qatar Stars League": 1, "Stars League": 1, "Qatar Stars League 2": 2, "Qatari Second Division": 2 },
  "United Arab Emirates": { "UAE Pro League": 1, "Pro League": 1, "UAE First Division League": 2 },
  Iran: {
    "Persian Gulf Pro League": 1, "Pro League": 1,
    "Azadegan League": 2,
    "Iran Football's 2nd Division": 3, "2nd Division": 3,
  },
  Iraq: { "Iraq Stars League": 1, "Iraqi Premier League": 1, "Stars League": 1, "Iraqi First Division League": 2 },
  Japan: { "J1 League": 1, "J2 League": 2, "J3 League": 3 },
  "South Korea": { "K League 1": 1, "K League 2": 2, "K3 League": 3 },
  Australia: {
    "A-League Men": 1, "A-League": 1,
    "National Premier Leagues": 2, "National Premier Leagues Victoria": 2,
    "National Premier Leagues New South Wales": 2, "National Premier Leagues Queensland": 2,
    "National Premier Leagues South Australia": 2, "National Premier Leagues Western Australia": 2,
    "National Premier Leagues Northern NSW": 2,
    "Victorian State League": 3,
  },
  Uzbekistan: { "Uzbekistan Super League": 1, "Superliga": 1 },
  Jordan: { "Jordanian Pro League": 1, "Pro League": 1, "Jordan Premier League": 1 },
  China: { "Chinese Super League": 1, "Super League": 1, "China League One": 2 },
  Thailand: { "Thai League 1": 1, "Thai League": 1, "Thai League 2": 2 },
  India: { "Indian Super League": 1 },
  Lebanon: { "Lebanese Premier League": 1 },
  Malaysia: { "Malaysia Super League": 1, "Malaysian Super League": 1 },
  Bahrain: { "Bahraini Premier League": 1 },
  Kuwait: { "Kuwaiti Premier League": 1, "Kuwait Premier League": 1 },
  Oman: { "Oman Professional League": 1 },
  Myanmar: { "Myanmar National League": 1 },
  Vietnam: { "V.League 1": 1, "V.League 2": 2, "Vietnamese Second Division": 3 },

  // ----- CAF -----
  Egypt: { "Egyptian Premier League": 1, "Premier League": 1, "Egyptian Second Division": 2 },
  Morocco: { "Botola Pro": 1, "Botola Pro 1": 1, "Botola": 1, "Botola Pro 2": 2 },
  Tunisia: {
    "Tunisian Ligue Professionnelle 1": 1, "Ligue 1": 1, "Ligue Professionnelle 1": 1,
    "Tunisian Ligue Professionnelle 2": 2,
  },
  Algeria: {
    "Algerian Ligue Professionnelle 1": 1, "Ligue 1": 1, "Ligue Professionnelle 1": 1,
    "Algerian Ligue Professionnelle 2": 2, "Ligue 2": 2,
  },
  "South Africa": {
    "Premier Soccer League": 1, "Betway Premiership": 1, "Premiership": 1, "South African Premier Division": 1,
    "National First Division": 2,
  },
  Ghana: { "Ghana Premier League": 1, "Premier League": 1 },
  Senegal: { "Senegal Premier League": 1, "Ligue 1": 1 },
  "Cote d'Ivoire": { "Ligue 1": 1 },
  "DR Congo": { "Linafoot": 1, "Ligue Nationale de Football": 1 },
  Nigeria: { "Nigeria Premier Football League": 1, "NPFL": 1 },
  Angola: { "Girabola": 1, "Angolan Girabola": 1 },
  Sudan: { "Sudani Premier League": 1, "Sudan Premier League": 1 },
  "Cape Verde": { "Cape Verdean Football Championship": 1, "Campeonato Nacional de Cabo Verde": 1 },
  "Cabo Verde": { "Cape Verdean Football Championship": 1, "Campeonato Nacional de Cabo Verde": 1 },

  // ----- OFC -----
  // New Zealand's regional leagues feed the National League but are not a clean tier below it.
  "New Zealand": {
    "National League": 1,
    "New Zealand Northern League": "NA", "New Zealand Central League": "NA", "New Zealand Southern League": "NA",
    "Lotto Sport Italia NRFL Division 1": "NA", "Northern Regional Football League": "NA",
  },
};

export default LEAGUE_TIERS;
