import {createServer} from 'node:http';
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULTS, CREDITS, PLANS, marketTypeFor, readGame, readBlock, alertFor, alertLine, costPlan, resolveLeagues, matchArbitrage, kickoffLabel, signed} from './engine.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const envFile = resolve(project, '.env');
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const unset = value => !value || /your[_ ]key|paste|example/i.test(value);
// Replay shows the saved board without calling the API, so looking at it again costs no credits.
const replay = process.env.BEST_ODDS_REPLAY === '1';
const key = [process.env.PREDICTEFY_API_KEY, local.PREDICTEFY_API_KEY].find(value => !unset(value));
if (!key && !replay) {
  console.error('Set PREDICTEFY_API_KEY in .env before starting. Create a key at https://portal.predictefy.com/keys');
  process.exit(1);
}
const port = Number(process.env.BEST_ODDS_PORT || local.BEST_ODDS_PORT || 8817);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('BEST_ODDS_PORT must be a port between 1024 and 65535.'); process.exit(1); }
const UPGRADE_URL = 'https://predictefy.com/en/pricing?utm_source=youtube&utm_medium=video&utm_campaign=best-odds-bot&utm_content=upgrade';

const dataDir = resolve(project, process.env.BEST_ODDS_DATA || 'data'); mkdirSync(dataDir, {recursive: true});
const stateFile = resolve(dataDir, 'best-odds-state.json');
let saved = {};
try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
const state = {
  replay, startedAt: new Date().toISOString(), lastRefresh: saved.lastRefresh || null, nextRefreshAt: null,
  config: {...DEFAULTS, ...saved.config}, leagues: saved.leagues || [], leagueList: saved.leagueList || [], leagueListAt: saved.leagueListAt || null,
  games: saved.games || [], feeds: saved.feeds || {}, alerts: saved.alerts || [], details: saved.details || {}, arbitrage: saved.arbitrage || null,
  counters: {refreshes: 0, requests: 0, credits: 0, ...saved.counters}, logs: [], busy: false, error: null, gate: null,
};

function log(text) { state.logs.unshift({at: new Date().toISOString(), text}); state.logs = state.logs.slice(0, 200); console.log(text); }
function save() {
  const {config, leagues, leagueList, leagueListAt, lastRefresh, games, feeds, alerts, details, arbitrage, counters} = state;
  writeFileSync(stateFile, JSON.stringify({savedAt: new Date().toISOString(), config, leagues, leagueList, leagueListAt, lastRefresh, games, feeds, alerts: alerts.slice(0, 300), details, arbitrage, counters}, null, 1));
}
const credits = n => `${n} credit${n === 1 ? '' : 's'}`;
const cents = value => value === null || value === undefined ? '  –  ' : `${value.toFixed(1)}¢`;

async function api(path, params = {}) {
  const url = new URL(path, 'https://data.predictefy.com');
  for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  state.counters.requests++;
  const response = await fetch(url, {headers: {authorization: `Bearer ${key}`, accept: 'application/json'}, signal: AbortSignal.timeout(30000), redirect: 'error'});
  const charged = Number(response.headers.get('x-credits-charged') || 0);
  state.counters.credits += charged;
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const error = new Error(`${response.status} ${body.error?.code || 'API_ERROR'}`);
    error.status = response.status; error.code = body.error?.code || 'API_ERROR'; error.route = url.pathname;
    // Out of credits, or a route the plan does not include: say so on the dashboard with the way to fix it.
    if (response.status === 402 || error.code === 'PLAN_REQUIRED') state.gate = {status: response.status, code: error.code, route: url.pathname, at: new Date().toISOString(), message: body.error?.message || '', upgradeUrl: UPGRADE_URL};
    throw error;
  }
  return {body, charged};
}

// The list of leagues is read once a day (1 credit) and the watched leagues are found in it by name.
async function readLeagues(force = false) {
  const fresh = state.leagueListAt && Date.now() - Date.parse(state.leagueListAt) < 24 * 3600 * 1000;
  if (!fresh || force || !state.leagueList.length) {
    const {body, charged} = await api('/v1/sports/competitions');
    state.leagueList = body.data.filter(c => c.active && c.venues.length).map(c => ({id: c.id, name: c.name, sport: c.sport, venues: c.venues}))
      .sort((a, b) => b.venues.length - a.venues.length || a.name.localeCompare(b.name));
    state.leagueListAt = new Date().toISOString();
    log(`GET /v1/sports/competitions${' '.repeat(22)}${String(body.data.length).padStart(4)} leagues  ${credits(charged)}`);
  }
  state.leagues = resolveLeagues(state.config.leagues, state.leagueList);
  for (const league of state.leagues.filter(l => l.missing)) log(`League not found in Predictefy's list: ${league.name}`);
}

// One refresh: one /v1/sports/screen call per watched league.
async function readLeague(league) {
  const rows = []; let cursor, pages = 0, charged = 0, meta = null;
  do {
    const result = await api('/v1/sports/screen', {competition: league.id, marketType: marketTypeFor(league.sport), status: 'scheduled,live', limit: 200, cursor});
    rows.push(...result.body.data); meta = result.body.meta; charged += result.charged; cursor = result.body.nextCursor; pages++;
  } while (cursor && pages < 3);
  writeFileSync(resolve(dataDir, `last-screen-${league.id}.json`), JSON.stringify({request: `/v1/sports/screen?competition=${league.id}&marketType=${marketTypeFor(league.sport)}&status=scheduled,live&limit=200`, fetchedAt: new Date().toISOString(), meta, data: rows}));
  state.feeds[league.id] = {name: league.name, asOf: meta?.asOf || null, degraded: Boolean(meta?.degraded), degradedReason: meta?.degradedReason || null, freshness: meta?.freshness || null, games: rows.length, credits: charged, readAt: new Date().toISOString()};
  log(`GET /v1/sports/screen  ${league.name.padEnd(26)}${String(rows.length).padStart(4)} games    ${credits(charged)}`);
  return rows.map(row => readGame(row, state.config));
}

function noteAlerts(firstRun) {
  const now = new Date().toISOString(), known = new Map(state.alerts.map(a => [a.key, a]));
  for (const alert of state.alerts) alert.active = false;
  const fresh = [];
  for (const alert of state.games.flatMap(g => g.alerts)) {
    const before = known.get(alert.key);
    if (before) Object.assign(before, alert, {lastSeen: now, active: true});
    else { const entry = {...alert, firstSeen: now, lastSeen: now, active: true}; state.alerts.unshift(entry); fresh.push(entry); }
  }
  state.alerts.sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeen.localeCompare(a.lastSeen) || b.lead - a.lead);
  for (const alert of fresh.slice(0, firstRun ? 4 : 20)) log(alertLine(alert));
  if (fresh.length > 4 && firstRun) log(`       ...and ${fresh.length - 4} more on the Alerts tab`);
  return fresh.length;
}

function printBoard() {
  const upcoming = state.games.filter(g => g.outcomes.length && g.liveVenues.length >= state.config.minVenues).slice(0, 2);
  for (const game of upcoming) {
    log(`  ${kickoffLabel(game)}  ${game.title}  ·  ${game.liveVenues.length} venues live`);
    for (const o of game.outcomes) log(`      ${o.name.slice(0, 28).padEnd(28)} best ${cents(o.best?.price)} ${String(o.best?.name || '').padEnd(12)} avg ${cents(o.avg)}  fair ${cents(o.fair)}  edge ${signed(o.edge)}`);
  }
  if (state.games.length > upcoming.length) log(`  ...and ${state.games.length - upcoming.length} more games on the dashboard`);
}

let timer = null;
async function refresh(reason = 'timer') {
  if (state.busy || replay) return;
  state.busy = true; state.error = null;
  const before = state.counters.credits, firstRun = state.counters.refreshes === 0 || reason === 'start';
  try {
    await readLeagues();
    const games = [];
    for (const league of state.leagues.filter(l => !l.missing)) games.push(...await readLeague(league));
    state.games = games.sort((a, b) => String(a.kickoffAt || a.eventDate).localeCompare(String(b.kickoffAt || b.eventDate)));
    state.lastRefresh = new Date().toISOString(); state.counters.refreshes++; state.gate = null;
    if (firstRun) printBoard();
    const fresh = noteAlerts(firstRun), active = state.alerts.filter(a => a.active).length;
    log(`${state.games.length} games · ${active} alert${active === 1 ? '' : 's'}${fresh && !firstRun ? ` (${fresh} new)` : ''} · ${credits(state.counters.credits - before)} this refresh`);
  } catch (error) {
    state.error = error.message;
    log(error.code === 'PLAN_REQUIRED' || error.status === 402 ? `Predictefy answered ${error.message}. Plans: ${UPGRADE_URL}` : `Refresh failed: ${error.message}`);
  } finally {
    state.busy = false; save(); schedule();
  }
}
function schedule() {
  clearTimeout(timer);
  if (replay) return;
  const wait = state.config.refreshMinutes * 60000;
  state.nextRefreshAt = new Date(Date.now() + wait).toISOString();
  timer = setTimeout(() => refresh('timer'), wait);
}

// Spread and total for one game, at each one's main line: one fixture read, 5 credits.
async function gameDetail(fixtureId) {
  const cached = state.details[fixtureId];
  if (replay || (cached && Date.now() - Date.parse(cached.readAt) < 60000)) return cached || null;
  const {body, charged} = await api(`/v1/sports/fixtures/${encodeURIComponent(fixtureId)}`);
  const full = type => readBlock((body.data.markets || []).find(m => m.marketType === type && m.period === 'full'));
  const detail = {fixtureId, readAt: new Date().toISOString(), credits: charged, asOf: body.meta?.asOf || null, spread: full('spread'), total: full('total')};
  state.details[fixtureId] = detail;
  // Keep the saved file small: only the most recently opened games.
  for (const id of Object.keys(state.details).sort((a, b) => state.details[b].readAt.localeCompare(state.details[a].readAt)).slice(12)) delete state.details[id];
  log(`GET /v1/sports/fixtures/${fixtureId}  spread and total  ${credits(charged)}`);
  save();
  return detail;
}

// The arbitrage check. Only this feed may call a gap arbitrage, and it is not on the Free plan.
async function arbitrageCheck() {
  if (replay) return state.arbitrage;
  const {body, charged} = await api('/api/router/fetchArbitrage', {executableOnly: 'true', limit: 500});
  const result = matchArbitrage(body.data || [], state.games.map(g => g.fixtureId));
  state.arbitrage = {...result, checkedAt: new Date().toISOString(), asOf: body.meta?.asOf || null, contracts: body.meta?.contracts ?? null, games: state.games.length, credits: charged};
  log(`GET /api/router/fetchArbitrage  ${result.passed} gate-checked rows, ${result.sports} in sports, ${result.onBoard.length} on this board  ${credits(charged)}`);
  save();
  return state.arbitrage;
}

function applyConfig(input) {
  const next = {...state.config};
  const number = (name, min, max, whole = false) => {
    if (input[name] === undefined) return;
    const value = Number(input[name]);
    if (!Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) throw new Error(`${name} must be between ${min} and ${max}`);
    next[name] = value;
  };
  number('refreshMinutes', 1, 1440, true); number('minVenues', 2, 12, true); number('minLeadCents', 0.1, 50); number('minSize', 0, 10000000); number('wideHold', 0.005, 1);
  if (input.leagues !== undefined) {
    if (!Array.isArray(input.leagues) || input.leagues.length < 1 || input.leagues.length > 8) throw new Error('Choose between 1 and 8 leagues');
    next.leagues = input.leagues.map(id => { const hit = state.leagueList.find(l => l.id === id); if (!hit) throw new Error('Unknown league'); return {id: hit.id, name: hit.name, sport: hit.sport}; });
  }
  const leaguesChanged = JSON.stringify(next.leagues) !== JSON.stringify(state.config.leagues);
  state.config = next;
  // The alert rule is applied to the prices already on the board, so changing it costs nothing.
  for (const game of state.games) game.alerts = game.outcomes.map(o => alertFor(game, o, next)).filter(Boolean);
  noteAlerts(false); save();
  if (!replay) { if (leaguesChanged) refresh('settings'); else schedule(); }
}

const view = () => ({
  replay, startedAt: state.startedAt, lastRefresh: state.lastRefresh, nextRefreshAt: state.nextRefreshAt, busy: state.busy, error: state.error, gate: state.gate,
  config: state.config, leagues: state.leagues, leagueList: state.leagueList, feeds: state.feeds, games: state.games, alerts: state.alerts, arbitrage: state.arbitrage,
  details: Object.fromEntries(Object.entries(state.details).map(([id, d]) => [id, d.readAt])), counters: state.counters, logs: state.logs.slice(0, 60),
  cost: costPlan(state.config), plans: PLANS, creditTable: CREDITS, upgradeUrl: UPGRADE_URL,
});

const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png'};
const publicDir = resolve(project, 'bot/public');
const send = (res, status, body) => { res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); };
async function readBody(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 20000) throw new Error('Request too large'); } return text ? JSON.parse(text) : {}; }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'POST') {
      // Only this dashboard may change settings or spend credits.
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return send(res, 403, {error: 'Wrong origin'});
      if (url.pathname === '/api/refresh') { if (!replay) await refresh('button'); return send(res, 200, view()); }
      if (url.pathname === '/api/config') { applyConfig(await readBody(req)); return send(res, 200, view()); }
      if (url.pathname === '/api/game') { const detail = await gameDetail(String(url.searchParams.get('id') || '')); return send(res, 200, {detail, replay, counters: state.counters}); }
      if (url.pathname === '/api/arbitrage') { const result = await arbitrageCheck(); return send(res, 200, {arbitrage: result, replay, counters: state.counters}); }
      return send(res, 404, {error: 'Not found'});
    }
    if (url.pathname === '/api/state') return send(res, 200, view());
    if (url.pathname === '/engine.mjs') { res.writeHead(200, {'content-type': types['.mjs'], 'cache-control': 'no-store'}); return res.end(readFileSync(resolve(project, 'bot/engine.mjs'))); }
    const file = resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(publicDir + sep) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(readFileSync(file));
  } catch (error) {
    send(res, error.status === 402 || error.code === 'PLAN_REQUIRED' ? 200 : 500, {error: error.message, gate: state.gate, counters: state.counters});
  }
});

server.listen(port, '127.0.0.1', async () => {
  const cost = costPlan(state.config);
  console.log('Best Odds Bot · a price comparison across prediction markets, read through Predictefy');
  if (replay) {
    console.log(`Replay: showing the board saved at ${state.lastRefresh || 'never'}. No API calls, no credits.`);
  } else {
    console.log(`Watching ${state.config.leagues.map(l => l.name).join(', ')} · refresh every ${state.config.refreshMinutes} min · ${cost.perRefresh} credits a refresh`);
    console.log(`About ${cost.perMonth.toLocaleString('en-US')} credits over a 31-day month (the Free plan has 25,000)`);
    await refresh('start');
  }
  console.log(`Dashboard: http://127.0.0.1:${port}`);
});
