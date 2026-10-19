# Polymarket and Kalshi Best Odds Bot with the Predictefy API

A small, read-only bot that lists upcoming games and, for each side, shows the best price on offer across Polymarket, Kalshi and the other prediction markets Predictefy covers: which venue has it, the average, the no-vig fair price, and how far the best price is ahead of the next venue.

It runs on your own computer, gets every number from the [Predictefy API](https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=best-odds-bot&utm_content=github), and opens a local dashboard in your browser. It never places orders and never asks for a venue account or a wallet key.

This example uses Node.js's built-in `fetch` to call the REST API directly. No SDK is required. If you prefer a typed client, see the official [Predictefy TypeScript SDK](https://docs.predictefy.com/guides/sdk/); Python users can start with the [Python SDK](https://docs.predictefy.com/guides/python-sdk/).

[![Tests](https://github.com/Ong-pogs/prediction-market-best-odds-bot/actions/workflows/test.yml/badge.svg)](https://github.com/Ong-pogs/prediction-market-best-odds-bot/actions/workflows/test.yml)

![Best Odds dashboard](docs/dashboard.png)

> This is a price comparison. A gap between two venues is an indicative price difference, not arbitrage.

## What it does

1. Reads Predictefy's sports screen for each league you watch (NFL and College Football by default) every 30 minutes.
2. For each side of each game, shows Predictefy's `best`, `avg`, `fair`, `edge` and `hold`, and every venue's price on one short scale.
3. Works out the **lead**: the best price against the next venue's live price.
4. Prints an `ALERT` line, and lists it on the Alerts tab, when one venue is clearly ahead of the rest.
5. On request, loads a game's spread and total, and runs Predictefy's arbitrage check.

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer and a Predictefy API key from [portal.predictefy.com/keys](https://portal.predictefy.com/keys). The Free plan is enough for the defaults.

```bash
git clone https://github.com/Ong-pogs/prediction-market-best-odds-bot
cd prediction-market-best-odds-bot
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Open `.env`, paste your key after `PREDICTEFY_API_KEY=`, then start the bot:

```bash
node bot/server.mjs
```

Open the address it prints, `http://127.0.0.1:8817`. There is nothing to install: the bot uses only what ships with Node.

## Build it yourself

If you would rather have an AI coding tool write the bot from scratch, [`build-prompt.txt`](build-prompt.txt) is the full specification: the endpoints, the alert rule, the cost maths and the dashboard. Paste it into your AI coding tool in an empty folder.

## The recorded walkthrough

The video uses an archived **October 8, 2026** board with 126 games and five qualifying alerts. A displayed 441% edge illustrated how a distorted average can mislead. These are dated observations, not current quotes or promises about what a new run will return.

The source, dashboard screenshot and small test fixtures are included here. Local `.env` files and the full saved dashboard state are excluded. Fetch your own board before using replay mode; the archived video snapshot is not bundled. Prices, coverage and alert counts will differ on a new run.

## How to read the numbers

`best`, `avg`, `fair`, `edge` and `hold` are Predictefy's own calculations, returned by `GET /v1/sports/screen` ([sports guide](https://docs.predictefy.com/guides/sports/)). The bot shows them as returned and does not recompute them.

| Number | In plain words |
|---|---|
| Best | The cheapest live ask for that side, with fees when the venue's fee is known. Stale quotes and listed prices cannot win. |
| Avg | The plain average of the live asks across venues, before fees. The margin is still inside it. |
| Fair | The no-vig price: the averages for all sides, scaled so they add up to 100. |
| Edge | Fair divided by best, minus one. Above zero, the best price is cheaper than fair. It is usually a little below zero. |
| Hold | How far the averages add up past 100: the margin built into the prices. A big hold means a wide book. |

Prices are in cents on the dollar: a 20¢ price pays $1 if that side wins.

The bot adds two things of its own:

- **Lead**: the best price compared with the next venue's live price, in cents.
- **Alert**: the lead is 1¢ or more, at least 3 venues have a live price on that side, at least 25 contracts sit at the best price, and the game's hold is under 5%. Games where a side has no live ask, or where one venue is quoting far from the rest, never alert, because the average means little there.

## Is a gap arbitrage?

No. A gap on this board compares the top of each venue's book. It says nothing about depth beyond the size shown, and the venues' settlement rules can differ.

Only Predictefy's arbitrage feed, `GET /api/router/fetchArbitrage`, checks live asks, depth, fees and settlement rules together. The **Run the check** button on the Alerts tab calls it with `executableOnly=true` (15 credits) and marks any game on your board that has a row passing every gate. That feed is on the Pro plan and higher. On Free and Builder, Predictefy answers `403 PLAN_REQUIRED` and the dashboard shows where to upgrade; everything else keeps working.

## What it costs to run

| Call | Credits | When |
|---|---|---|
| `GET /v1/sports/screen` | 5 per league | every refresh |
| `GET /v1/sports/competitions` | 1 | once a day |
| `GET /v1/sports/fixtures/{id}` | 5 | when you load a game's spread and total |
| `GET /api/router/fetchArbitrage` | 15 | when you run the arbitrage check |

With the defaults, two leagues every 30 minutes is 10 credits a refresh, 481 credits a day and about 14,911 over a 31-day month. The Free plan has 25,000 credits a month. The Settings tab redoes this sum as you change the leagues or the interval and tells you which plan the new pace needs. With two leagues, the fastest refresh that still fits Free is every 18 minutes.

A league with more than 200 upcoming games takes a second page, which is another 5 credits.

## Settings

Change these on the dashboard's **Settings & cost** tab.

| Setting | Default | What it does |
|---|---|---|
| Leagues | NFL, College Football | Any league from Predictefy's list. Soccer leagues use the three-way match result |
| Refresh every | 30 minutes | How often the screen is read |
| Alert lead | 1¢ | How far under the next venue the best price must be |
| Venues needed | 3 | Venues with a live price on that side |
| Smallest size | 25 contracts | Size on offer at the best price |

Optional environment variables: `BEST_ODDS_PORT` (default `8817`), `BEST_ODDS_DATA` (the folder for saved state, default `data`) and `BEST_ODDS_REPLAY=1`, which shows the saved board without calling the API, so looking at it again costs no credits.

To see what Predictefy returns for one side of one game:

```bash
node bot/peek.mjs            # or: node bot/peek.mjs "Premier League"
```

## What it cannot tell you

- **It cannot tell you who wins.** The fair price is an average of market prices, not a prediction of its own.
- **The best price may be small.** The size shown is only what sits at that price. A bigger order moves down the book.
- **Coverage changes through the week.** Some venues only show a live price close to kick-off. Before that their price is "listed, not live" and cannot win best.
- **Fees are sometimes unknown.** Then the price shown is the bare ask and is labelled that way.
- **Team names come from Predictefy's catalogue.** College teams are listed by nickname.
- **It is not a betting recommendation**, and whether you may use a given venue depends on where you live.

## Tests

```bash
node --test
```

The tests run on real rows saved from the API in `bot/testdata/`.

GitHub Actions runs them on Windows, macOS and Linux with Node.js 22. Tests use local fixtures and do not call the API or need a key.

## Predictefy API and SDK resources

| Resource | What it helps with |
|---|---|
| [Prediction market API](https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=best-odds-bot&utm_content=resources) | API overview and access |
| [API quickstart](https://docs.predictefy.com/quickstart/) | Your first authenticated request |
| [Get an API key](https://portal.predictefy.com/keys) | The key used by this bot |
| [Sports data guide](https://docs.predictefy.com/guides/sports/) | Fixtures, live quotes, fair prices and edge calculations |
| [Arbitrage scanner guide](https://docs.predictefy.com/guides/cookbook/arbitrage-scanner/) | Understanding the separate assessed-arbitrage feed and its plan requirement |
| [TypeScript SDK](https://docs.predictefy.com/guides/sdk/) | An alternative to direct REST calls for a TypeScript app |
| [Python SDK](https://docs.predictefy.com/guides/python-sdk/) | Using the API from Python |
| [API reference](https://docs.predictefy.com/api/) | Request parameters and response schemas |
| [Venue coverage](https://docs.predictefy.com/reference/venues/) | Checking supported market data before comparing venues |
| [Credits and plan entitlements](https://docs.predictefy.com/guides/credits/) | Budgeting refreshes and understanding feature access |
| [Pricing](https://predictefy.com/en/pricing) | Current plan prices and allowances |
| [Rate limits and retries](https://docs.predictefy.com/guides/rate-limits/) | Pacing requests and handling temporary failures |
| [API error reference](https://docs.predictefy.com/guides/errors/) | Authentication, plan and data-availability errors |

Questions about the API: [Predictefy Discord](https://discord.gg/KVrWkhD8S).

## License

MIT. See [LICENSE](LICENSE).
