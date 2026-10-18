// Print what Predictefy returns for one side of one game, so you can see what the board is built from.
// Usage: node bot/peek.mjs [league name]   (default NFL; the league list and one screen call, 6 credits)
import {existsSync, readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const unset = value => !value || /your[_ ]key|paste|example/i.test(value);
const key = [process.env.PREDICTEFY_API_KEY, local.PREDICTEFY_API_KEY].find(value => !unset(value));
if (!key) { console.error('Set PREDICTEFY_API_KEY in .env first.'); process.exit(1); }
const get = async path => {
  const response = await fetch(`https://data.predictefy.com${path}`, {headers: {authorization: `Bearer ${key}`}});
  const body = await response.json();
  if (!response.ok) { console.error(`${response.status} ${body.error?.code || ''}`); process.exit(1); }
  return body;
};

const want = process.argv.slice(2).join(' ') || 'NFL';
const league = (await get('/v1/sports/competitions')).data.find(c => c.name.toLowerCase() === want.toLowerCase());
if (!league) { console.error(`No league called "${want}".`); process.exit(1); }
const path = `/v1/sports/screen?competition=${league.id}&marketType=${league.sport === 'soccer' ? 'match_result' : 'moneyline'}&status=scheduled,live&limit=200`;
console.log(`GET ${path}\n`);
const rows = (await get(path)).data.filter(row => row.market);
const live = cell => cell.gross && !cell.stale && cell.source === 'live';
// The game with the most venues quoting live, and the side whose prices are furthest apart.
const game = rows.sort((a, b) => b.market.selections[0].cells.filter(live).length - a.market.selections[0].cells.filter(live).length)[0];
if (!game) { console.log('No games with prices in this league right now.'); process.exit(0); }
const spread = s => { const p = s.cells.filter(live).map(c => (c.net || c.gross).probability); return Math.max(...p) - Math.min(...p); };
const side = game.market.selections.slice().sort((a, b) => spread(b) - spread(a))[0];
console.log(`${game.teams.map(t => t.name).join(' vs ')} · ${game.kickoffAt}`);
console.log(`selection: ${side.selection.team?.name || side.selection.key}`);
console.log('cells:');
for (const c of side.cells) console.log('  ' + JSON.stringify({venue: c.venue, gross: c.gross?.probability ?? null, net: c.net?.probability ?? null, sizeAtPrice: c.sizeAtPrice, stale: c.stale, source: c.source}));
console.log('best: ' + JSON.stringify({venue: side.best?.venue, net: side.best?.net?.probability, sizeAtPrice: side.best?.sizeAtPrice}));
console.log(`avg:  ${side.avg?.probability}   fair: ${side.fair?.probability}   edge: ${side.edge}`);
console.log(`hold: ${JSON.stringify(game.market.hold)}`);
console.log(`\n${rows.length} games in ${league.name}. Fields trimmed; every cell also carries american and decimal odds, fees and a quote time.`);
