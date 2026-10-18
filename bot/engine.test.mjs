import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULTS, cellState, comparable, readGame, alertFor, alertLine, costPlan, shortestInterval, resolveLeagues, matchArbitrage, marketTypeFor, kickoffLabel, signed} from './engine.mjs';

// Real rows saved from Predictefy on 2026-10-08, so the tests read what the API actually returns.
const rows = JSON.parse(readFileSync(new URL('./testdata/screen-rows.json', import.meta.url), 'utf8'));
const arbitrage = JSON.parse(readFileSync(new URL('./testdata/arbitrage-rows.json', import.meta.url), 'utf8')).rows;

test('a cell is live, stale, a listed price or empty', () => {
  assert.equal(cellState({gross: {probability: 0.2}, source: 'live', stale: false}), 'live');
  assert.equal(cellState({gross: {probability: 0.2}, source: 'live', stale: true}), 'stale');
  assert.equal(cellState({gross: {probability: 0.2}, source: 'catalog', stale: false}), 'catalog');
  assert.equal(cellState({gross: null, grossReason: 'no_asks', source: 'live'}), 'none');
});

test('prices compare with fees when the fee is known, on the bare ask when it is not', () => {
  assert.deepEqual(comparable({gross: {probability: 0.21}, net: {probability: 0.2217}, feeUnknown: false}), {probability: 0.2217, withFees: true});
  assert.deepEqual(comparable({gross: {probability: 0.2025}, net: null, feeUnknown: true}), {probability: 0.2025, withFees: false});
  assert.equal(comparable({gross: null}), null);
});

test('the board keeps the best price Predictefy returned and never invents one', () => {
  const game = readGame(rows.tight);
  assert.equal(game.title, 'Tampa Bay Buccaneers at Dallas Cowboys');
  const bucs = game.outcomes.find(o => o.name === 'Tampa Bay Buccaneers');
  assert.equal(bucs.best.venue, rows.tight.market.selections.find(s => s.selection.key === bucs.key).best.venue);
  assert.equal(bucs.best.price, 19.75);
  assert.equal(bucs.fair, 19.98);
  assert.equal(bucs.edge, 0.0119);
  // Kalshi's ask is 21.0 cents and 22.17 with its fee, so it sorts last even though its book is the deepest.
  const kalshi = bucs.venues.find(v => v.venue === 'kalshi');
  assert.equal(kalshi.ask, 21); assert.equal(kalshi.withFees, 22.17);
  assert.equal(bucs.venues.filter(v => v.state === 'live').at(-1).venue, 'kalshi');
});

test('stale quotes and listed prices are shown but cannot be the next venue', () => {
  const bucs = readGame(rows.tight).outcomes.find(o => o.name === 'Tampa Bay Buccaneers');
  assert.equal(bucs.venues.find(v => v.venue === 'polymarket_us').state, 'catalog');
  assert.equal(bucs.venues.find(v => v.venue === 'novig').state, 'stale');
  assert.equal(bucs.next.venue, 'pascal');
  assert.equal(bucs.lead, 0.65);
  assert.equal(bucs.liveVenues, 5);
});

test('an alert needs a clear lead, enough venues and enough size', () => {
  const tight = readGame(rows.tight);
  assert.equal(tight.alerts.length, 0, 'a 0.65 cent lead with 4 contracts is not an alert');
  const game = readGame(rows.alert);
  assert.equal(game.alerts.length, 1);
  const alert = game.alerts[0];
  assert.equal(alert.outcome, 'Las Vegas Raiders'); assert.equal(alert.venue, 'sxbet'); assert.equal(alert.label, 'indicative');
  assert.ok(alert.lead >= DEFAULTS.minLeadCents && alert.size >= DEFAULTS.minSize && alert.liveVenues >= DEFAULTS.minVenues);
  assert.match(alertLine(alert), /^ALERT  Las Vegas Raiders 37\.3¢ on SX Bet · 1\.5¢ under Novig · size 82 · indicative$/);
  // The same prices stop being an alert when the rule is stricter.
  const raiders = game.outcomes.find(o => o.name === 'Las Vegas Raiders');
  assert.equal(alertFor(game, raiders, {...DEFAULTS, minSize: 500}), null);
  assert.equal(alertFor(game, raiders, {...DEFAULTS, minLeadCents: 2}), null);
  assert.equal(alertFor({...game, status: 'final'}, raiders), null);
});

test('a wide book never alerts, however large its edge looks', () => {
  const game = readGame(rows.wide);
  const longShot = game.outcomes.slice().sort((a, b) => b.edge - a.edge)[0];
  assert.ok(longShot.edge > 4, 'Predictefy reports an edge above 400% here');
  assert.ok(game.hold > 0.2 && game.wideBook);
  assert.equal(game.alerts.length, 0);
});

test('a game with one side missing has no fair price and no alert', () => {
  const game = readGame(rows.oneSided);
  assert.equal(game.hold, null);
  assert.ok(game.outcomes.every(o => o.fair === null));
  assert.equal(game.alerts.length, 0);
  // An empty cell stays empty: no price, never a zero.
  const empty = game.outcomes.flatMap(o => o.venues).find(v => v.state === 'none');
  assert.equal(empty.ask, null); assert.equal(empty.compare, null);
});

test('the default settings fit the Free plan for a whole month', () => {
  const cost = costPlan(DEFAULTS);
  assert.deepEqual({perRefresh: cost.perRefresh, refreshesPerDay: cost.refreshesPerDay, perDay: cost.perDay, perMonth: cost.perMonth}, {perRefresh: 10, refreshesPerDay: 48, perDay: 481, perMonth: 14911});
  assert.ok(cost.fitsFree); assert.equal(cost.plan, 'Free'); assert.equal(cost.spare, 10089);
});

test('a faster refresh is costed honestly and names the plan it needs', () => {
  const fast = costPlan({...DEFAULTS, refreshMinutes: 5});
  assert.equal(fast.perMonth, 89311); assert.equal(fast.fitsFree, false); assert.equal(fast.plan, 'Builder');
  assert.equal(shortestInterval(2), 18); assert.equal(shortestInterval(1), 9);
  assert.equal(costPlan({leagues: Array(8).fill(0), refreshMinutes: 1}).plan, 'Pro');
});

test('leagues are found by name and sport, and soccer uses the three-way market', () => {
  const list = [{id: 'comp_a', name: 'NFL', sport: 'american_football', venues: ['kalshi']}, {id: 'comp_b', name: 'National League', sport: 'soccer', venues: []}, {id: 'comp_c', name: 'National League', sport: 'ice_hockey', venues: []}];
  const found = resolveLeagues([{name: 'NFL', sport: 'american_football'}, {name: 'National League', sport: 'ice_hockey'}, {name: 'XFL', sport: 'american_football'}], list);
  assert.equal(found[0].id, 'comp_a'); assert.equal(found[1].id, 'comp_c'); assert.equal(found[2].missing, true);
  assert.equal(marketTypeFor('soccer'), 'match_result'); assert.equal(marketTypeFor('american_football'), 'moneyline');
});

test('only a row that passed every gate, for a game on the board, counts as arbitrage', () => {
  const sportsRow = arbitrage.find(r => r.sports);
  const none = matchArbitrage(arbitrage, [sportsRow.sports.fixtureId]);
  assert.deepEqual({passed: none.passed, sports: none.sports, onBoard: none.onBoard.length}, {passed: 1, sports: 0, onBoard: 0});
  const passedSports = {...sportsRow, label: 'arbitrage', executable: true};
  const hit = matchArbitrage([...arbitrage, passedSports], [sportsRow.sports.fixtureId]);
  assert.equal(hit.onBoard.length, 1); assert.equal(hit.onBoard[0].fixtureId, sportsRow.sports.fixtureId);
  assert.equal(matchArbitrage([passedSports], ['fx_other']).onBoard.length, 0);
});

test('kick-off is shown in the league time zone and edges keep their sign', () => {
  const game = readGame(rows.tight);
  assert.equal(kickoffLabel(game), 'Thu, Oct 8, 8:15 PM EDT');
  assert.equal(signed(0.0119), '+1.2%'); assert.equal(signed(-0.006), '−0.6%'); assert.equal(signed(null), '–');
});
