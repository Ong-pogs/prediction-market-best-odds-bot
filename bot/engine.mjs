// Pure logic for the best-odds board: reading Predictefy's sports screen rows, the alert rule and the cost maths.
// Nothing here calls the network, so every function can be tested with saved responses.

export const DEFAULTS = {
  leagues: [{name: 'NFL', sport: 'american_football'}, {name: 'College Football', sport: 'american_football'}],
  refreshMinutes: 30, // one screen call per league per refresh
  minVenues: 3,       // an alert needs this many venues with a live ask on the outcome
  minLeadCents: 1,    // ...the best price at least this far under the next venue
  minSize: 25,        // ...and at least this many contracts offered at the best price
  wideHold: 0.05,     // above this average hold at least one book is wide: the average is distorted, so no alert
};

export const CREDITS = {screen: 5, fixture: 5, leagues: 1, arbitrage: 15};
export const PLANS = [
  {name: 'Free', credits: 25000, price: '$0'},
  {name: 'Builder', credits: 250000, price: '$48.88 a month'},
  {name: 'Pro', credits: 2000000, price: '$149 a month'},
];

export const VENUE_NAMES = {
  kalshi: 'Kalshi', polymarket: 'Polymarket', polymarket_us: 'Polymarket US', predictfun: 'Predict.fun', sxbet: 'SX Bet',
  pred: 'PRED', pascal: 'Pascal', novig: 'Novig', limitless: 'Limitless', opinion: 'Opinion', myriad: 'Myriad', gemini: 'Gemini',
  hyperliquid: 'Hyperliquid', rain: 'Rain', xo: 'XO Market', predictstreet: 'PredictStreet',
};
export const venueName = slug => VENUE_NAMES[slug] || slug;

// Soccer has a draw, so its two-way "moneyline" leaves an outcome out. Its full market is match_result.
export const marketTypeFor = sport => sport === 'soccer' ? 'match_result' : 'moneyline';

const round = (value, places = 2) => Number(value.toFixed(places));
const cents = probability => probability === null || probability === undefined ? null : round(probability * 100, 2);

// What a venue's cell is worth for the comparison.
export function cellState(cell) {
  if (!cell.gross) return 'none';               // no ask to buy at; an empty cell is absent, never zero
  if (cell.source !== 'live') return 'catalog'; // a listed price, not a live ask
  if (cell.stale) return 'stale';               // too old for how close the game is
  return 'live';
}
// The price that can be compared across venues: with fees when the fee is known, the bare ask otherwise.
export function comparable(cell) {
  if (!cell?.gross) return null;
  if (cell.feeUnknown || !cell.net) return {probability: cell.gross.probability, withFees: false};
  return {probability: cell.net.probability, withFees: true};
}

function readVenue(cell) {
  const state = cellState(cell), price = comparable(cell);
  return {
    venue: cell.venue, name: venueName(cell.venue), state, reason: cell.grossReason || null,
    ask: cents(cell.gross?.probability), withFees: cell.feeUnknown ? null : cents(cell.net?.probability), feeUnknown: Boolean(cell.feeUnknown),
    compare: price ? cents(price.probability) : null, american: cell.net?.american ?? cell.gross?.american ?? null,
    size: cell.sizeAtPrice ?? null, asOf: cell.asOf || null,
  };
}

const label = key => key.charAt(0).toUpperCase() + key.slice(1); // draw, over, under

// One outcome of one game: Predictefy's best, average, fair and edge, plus how far the best is ahead of the next venue.
export function readOutcome(selection) {
  const venues = selection.cells.map(readVenue).sort((a, b) => (a.compare ?? 999) - (b.compare ?? 999));
  const live = venues.filter(v => v.state === 'live');
  const bestCell = selection.best ? readVenue(selection.best) : null;
  // The next venue is the cheapest live ask that is not the best venue, compared on the same basis.
  const next = bestCell ? live.find(v => v.venue !== bestCell.venue) || null : null;
  const lead = bestCell && next ? round(next.compare - bestCell.compare, 2) : null;
  return {
    key: selection.selection.key, name: selection.selection.team?.name || label(selection.selection.key),
    best: bestCell && {venue: bestCell.venue, name: bestCell.name, price: bestCell.compare, ask: bestCell.ask, withFees: bestCell.withFees !== null, american: bestCell.american, size: bestCell.size, asOf: bestCell.asOf},
    next: next && {venue: next.venue, name: next.name, price: next.compare},
    lead, liveVenues: live.length,
    avg: cents(selection.avg?.probability), fair: cents(selection.fair?.probability),
    edge: selection.edge ?? null, edgeOnGross: Boolean(selection.edgeOnGross),
    venues,
  };
}

export function readBlock(market) {
  if (!market) return null;
  const outcomes = market.selections.map(readOutcome);
  const hold = market.hold?.average ?? null;
  return {marketType: market.marketType, period: market.period, line: market.line ?? null, lineTeam: market.lineTeam?.team?.name || null, hold, holdByVenue: market.hold?.byVenue || {}, outcomes};
}

// One row of /v1/sports/screen turned into what the board shows.
export function readGame(row, config = DEFAULTS) {
  const block = readBlock(row.market);
  const liveVenues = block ? [...new Set(block.outcomes.flatMap(o => o.venues.filter(v => v.state === 'live').map(v => v.venue)))] : [];
  const game = {
    fixtureId: row.fixtureId, sport: row.sport, league: row.competition?.name || '', leagueId: row.competition?.id || null, timeZone: row.competition?.timeZone || 'UTC',
    home: row.home?.name || null, away: row.away?.name || null, teams: (row.teams || []).map(t => t.name),
    kickoffAt: row.kickoffAt, kickoffExact: row.kickoffPrecision === 'exact', eventDate: row.eventDate, status: row.status,
    listedVenues: row.venues || [], liveVenues,
    marketType: block?.marketType || null, hold: block?.hold ?? null, holdByVenue: block?.holdByVenue || {},
    wideBook: block?.hold !== null && block?.hold !== undefined && block.hold > config.wideHold,
    outcomes: block?.outcomes || [],
  };
  game.title = game.home && game.away ? `${game.away} at ${game.home}` : game.teams.join(' vs ');
  game.alerts = game.outcomes.map(outcome => alertFor(game, outcome, config)).filter(Boolean);
  return game;
}

// The bot's own rule for "one venue is clearly better than the rest". It is a price comparison, not an arbitrage claim.
export function alertFor(game, outcome, config = DEFAULTS) {
  if (!['scheduled', 'live'].includes(game.status) || !outcome.best || outcome.lead === null) return null;
  if (outcome.liveVenues < config.minVenues) return null;
  if (outcome.lead < config.minLeadCents) return null;
  if (outcome.best.size === null || outcome.best.size < config.minSize) return null;
  // No fair price means a side has no live ask at all; a wide book means one venue is quoting far from the rest.
  // Either way the next price and the average stop meaning much, so there is no alert.
  if (outcome.fair === null || game.hold === null || game.wideBook) return null;
  return {
    key: `${game.fixtureId}|${game.marketType}|${outcome.key}|${outcome.best.venue}`,
    fixtureId: game.fixtureId, game: game.title, league: game.league, kickoffAt: game.kickoffAt, outcome: outcome.name,
    venue: outcome.best.venue, venueName: outcome.best.name, price: outcome.best.price, size: outcome.best.size,
    nextVenue: outcome.next.venue, nextVenueName: outcome.next.name, nextPrice: outcome.next.price, lead: outcome.lead,
    liveVenues: outcome.liveVenues, fair: outcome.fair, edge: outcome.edge, label: 'indicative',
  };
}
export const alertLine = a => `ALERT  ${a.outcome} ${a.price.toFixed(1)}¢ on ${a.venueName} · ${a.lead.toFixed(1)}¢ under ${a.nextVenueName} · size ${Math.round(a.size).toLocaleString('en-US')} · indicative`;

// What the chosen settings cost, and the smallest plan that covers a month of them.
export function costPlan(config = DEFAULTS, days = 31) {
  const leagues = Math.max(0, config.leagues.length);
  const perRefresh = leagues * CREDITS.screen;
  const refreshesPerDay = Math.floor(1440 / config.refreshMinutes);
  const perDay = perRefresh * refreshesPerDay + CREDITS.leagues; // the league list is read once a day
  const perMonth = perDay * days;
  const plan = PLANS.find(p => p.credits >= perMonth) || null;
  return {leagues, perRefresh, refreshesPerDay, perDay, perMonth, days, plan: plan?.name || null, fitsFree: perMonth <= PLANS[0].credits, spare: PLANS[0].credits - perMonth};
}
// The shortest refresh interval, in whole minutes, that still fits a plan for a month.
export function shortestInterval(leagues, credits = PLANS[0].credits, days = 31) {
  for (let minutes = 1; minutes <= 1440; minutes++) {
    if (costPlan({leagues: Array(leagues).fill(0), refreshMinutes: minutes}, days).perMonth <= credits) return minutes;
  }
  return null;
}

// Finds the watched leagues in the list from /v1/sports/competitions.
export function resolveLeagues(wanted, competitions) {
  return wanted.map(w => {
    const hit = competitions.find(c => w.id ? c.id === w.id : c.name === w.name && (!w.sport || c.sport === w.sport));
    return hit ? {id: hit.id, name: hit.name, sport: hit.sport, venues: hit.venues || []} : {...w, missing: true};
  });
}

// The arbitrage check: only rows that passed every gate count, and only when they belong to a game on the board.
export function matchArbitrage(rows, fixtureIds) {
  const wanted = new Set(fixtureIds);
  const passed = rows.filter(r => r.label === 'arbitrage' && r.executable === true);
  const sports = passed.filter(r => r.sports?.fixtureId);
  const onBoard = sports.filter(r => wanted.has(r.sports.fixtureId)).map(r => ({
    fixtureId: r.sports.fixtureId, question: r.question, marketType: r.sports.marketType, buyYes: r.legs.buyYes.venue, buyNo: r.legs.buyNo.venue,
    roi: r.roi, netEdge: r.netEdge, contracts: r.contracts, asOf: r.asOf,
  }));
  return {passed: passed.length, sports: sports.length, onBoard};
}

// Kick-off in the league's own time zone, the way the fixture is advertised.
export function kickoffLabel(game, locale = 'en-US') {
  if (!game.kickoffAt) return game.eventDate || 'Date not set';
  const options = {weekday: 'short', month: 'short', day: 'numeric', timeZone: game.timeZone};
  if (game.kickoffExact) Object.assign(options, {hour: 'numeric', minute: '2-digit', timeZoneName: 'short'});
  return new Intl.DateTimeFormat(locale, options).format(new Date(game.kickoffAt));
}
export const signed = (value, places = 1) => value === null || value === undefined ? '–' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(places)}%`;
