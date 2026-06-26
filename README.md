# BLACKOUT, the 2026 FIFA World Cup with no spoilers

Catch up on the 2026 World Cup on your own schedule, without anyone spoiling the result.

Scores and the bracket stay blacked out until you choose to reveal them, one day at a time. Official match highlights are gathered in one place and shown for your region, you can fill in your own bracket prediction and save it as an image, and there is nothing to install, no account, and no API key needed to use it. Just open the site.

It follows the real men's tournament (11 June to 19 July 2026). Live results come from the public-domain [openfootball](https://github.com/openfootball/worldcup.json) dataset.

This is a non-commercial fan project and is not affiliated with FIFA or any broadcaster. Broadcaster logos are used only to identify the source of each highlight.

**Live:** https://logan-daniels.github.io/blackout

## How it works

The whole front end is a single, self-contained `index.html`: all the markup, styles and logic live in that one file, and it is served as a static page from GitHub Pages. There is no framework and no build step to view it.

At load it fetches a handful of JSON files from `data/`. Those files are produced by the scripts in `scripts/` and committed to the repo, so the site itself never calls a paid API or needs a key. The build does that work ahead of time: it reads results from openfootball, resolves the official highlight links for each match per broadcaster and region, and bakes in squads, player cards, club and league data, and crests.

### The spoiler model

Everything that could give a result away (final scores, the knockout bracket, group standings) is hidden behind a reveal control. You move it forward to the date you have caught up to, and only matches up to that point are uncovered. Highlights and fixtures are visible the whole time; the outcomes are what stay dark until you ask for them.

## Repository layout

```
blackout/
  index.html                 the entire app (markup, CSS, JS in one file)
  manifest.webmanifest       PWA manifest (kept at the root, scope is "./")
  README.md
  .gitignore

  data/                      all data the site fetches at load, plus build inputs
    data.json                results + highlight links, rebuilt live (the main file)
    players.json             squad and photo dictionary
    players-clubs.json       player -> current club overlay
    photos-extra.json        photo gap-fills
    team-info.json           player bios for the cards (from the Fox spider)
    managers.json            manager history
    clubs.json               club and league data
    club-overrides.json      manual club fixes the data misses
    league-logos.json        league crest overrides
    federations.json         confederation lookup
    fifa-squads.json         official squad data (baked from the FIFA squad PDF)
    fox-urls.json            resolved Fox player-page URLs
    aliases.json             club and country name aliases for filtering
    wc-fixtures.json         the fixture schedule and build config (hand-edited)
    country-names-i18n.json  (legacy, see note below)

  i18n/                      UI strings per language: en, fr, es, de
  images/
    icons/                   app icons (180, 192, 512)
    broadcasters/            highlight-source logos (one file per source)
  scripts/                   the data pipeline (see below)
  .github/workflows/         the two automation jobs
```

A note on `data/country-names-i18n.json`: nothing in the current site or scripts reads it, so it looks like a leftover. It has been kept in `data/` for now; once you have confirmed nothing needs it, it is safe to delete.

## Local development

You only need a static server to view the site. Python's built-in one is enough.

```bash
git clone https://github.com/Logan-Daniels/blackout.git
cd blackout
python3 -m http.server 8000
```

Then open http://localhost:8000 and hard-refresh with Cmd+Shift+R after any change, so the browser does not serve a stale cached copy. The data files already in `data/` are all the site needs, so it works offline-ish straight away; you only have to run the scripts below when you want to refresh that data.

## The data pipeline

Two GitHub Actions workflows keep the committed data current, and you can run any script by hand locally too. They are plain Node and Python and read their inputs from `data/`.

The live updater, `.github/workflows/update-data.yml`, wakes every five minutes during the UTC hours that cover match time, runs the schedule guard, and only rebuilds when a match is actually due, so most runs exit in a second or two. The squad rebuild, `.github/workflows/update-squads.yml`, is the slow job and is run by hand from the Actions tab; it refreshes the squads, photos and player bios.

The scripts, roughly in the order they feed each other:

- `should-build.mjs` decides whether a match is due, so the live job can exit fast when nothing is happening. Used by the live workflow.
- `build-data.mjs` is the main builder. It reads results from openfootball, resolves highlight links, merges with the previous `data/data.json` so links persist across runs, and optionally adds player stats and AI-resolved recap titles. It writes `data/data.json` and maintains `data/managers.json`. A normal run crawls each highlight feed shallowly; `DEEP=1` deep-crawls them all and `DEEP_ONLY=<src>` deep-crawls a single feed back to the tournament start while the rest stay shallow, which is how `add-broadcaster.mjs` fills in a freshly added source.
- `build-rosters.mjs` resolves each squad's Fox player-page URLs into `data/fox-urls.json`.
- `build-players.mjs` builds the squad and photo dictionary, `data/players.json`.
- `fox_team_spider.py` is a Scrapy spider that crawls Fox politely for player bios and writes `data/team-info.json` (the data behind the player cards).
- `build-photos.mjs` fills photo gaps into `data/photos-extra.json`.
- `build-clubs.mjs` builds `data/clubs.json` and the `data/players-clubs.json` overlay.
- `build-logos.mjs` gap-fills club and league crests.

The rest are helpers: `audit-photos.mjs` reports photo coverage, `photo-overrides.mjs` applies manual photo fixes, `clean-team-info.mjs` tidies a bios file without re-crawling, and `add-broadcaster.mjs` wires up a new broadcaster (see below). `yt-check.mjs` reports, for any YouTube video URL, whether it allows embedding and which countries it is available in. `check-apifootball.mjs`, `league-tiers.mjs`, `playlist-dump.mjs`, `build-surnames.mjs` and `purge_fox_cache.py` are diagnostic and one-off tools.

Several data files have no generator and are hand-maintained: `wc-fixtures.json` (the schedule, which most builds read), `federations.json`, `league-logos.json`, `club-overrides.json` and `aliases.json`. `fifa-squads.json` is produced separately by parsing the official FIFA squad PDF, a step that is not part of `scripts/`; if you regenerate it, point that step at `data/fifa-squads.json`.

## API keys

The site needs none. The build scripts read keys from environment variables, and every one of them is optional except for highlight links:

- `YT_API_KEY` resolves the YouTube highlight links. Without it, results, lineups and stats still build; only the highlight links are skipped.
- `ANTHROPIC_API_KEY` (with optional `CLAUDE_MODEL`) lets a model tidy up the few recap titles the rules miss.
- `API_FOOTBALL_KEY` adds per-player stats and ratings.
- `TSDB_KEY` (TheSportsDB) helps gap-fill logos.
- `GEMINI_API_KEY` is used by optional AI steps: `add-broadcaster.mjs`'s title spoiler check, and translation.

In CI these are set as GitHub repository secrets (Settings > Secrets and variables > Actions); unset secrets simply leave that feature off. Locally, export them in your shell before running a script. A `keys/` folder is a convenient place to keep the raw values and source them into your environment; keep it out of git (see `.gitignore`).

## Languages

The interface is available in English, French, Spanish and German. English is the default and the source of truth; the other languages are loaded on demand from `i18n/<lang>.json`. New or changed strings start in `i18n/en.json` and the translations are generated from there.

## Adding a broadcaster

First drop the broadcaster's logo in `images/broadcasters/<slug>-<hex>.png` (or `.svg`), where `<hex>` is the dominant brand colour the card is tinted with. The colour is read straight from that filename, so there is no colour flag to pass.

Then point the helper at the broadcaster's YouTube highlights playlist, or at its channel when there is no single tidy playlist:

```bash
node scripts/add-broadcaster.mjs "https://www.youtube.com/playlist?list=PL..."
node scripts/add-broadcaster.mjs "https://www.youtube.com/@SomeBroadcaster"
```

From that it works out the rest. It reads the broadcaster's name from the channel, registers the feed in `data/wc-fixtures.json` and `build-data.mjs`, then rebuilds, deep-crawling only the new feed (a channel is crawled back to the start of the tournament, not its whole history). It then inspects the first real highlight through the YouTube API and writes what it finds into the `index.html` source entry: whether the clips can be embedded (`linkOut`), which countries they are allowed in (`regions`, so the broadcaster shows up for viewers in exactly those countries, or `blocked` for the inverse), and the audio language (`lang`). If the clips cannot be embedded it asks Gemini whether the real titles reveal scores and chooses the warning accordingly: the gentle `rds` notice when they do not, the `fifa` spoiler warning when they do.

Anything it detects can be overridden with a flag: `--name`, `--id`, `--tint`, `--lang`, `--regions CA,US`, `--blocked RU`, `--linkout`/`--no-linkout`, `--warn rds|fifa`. `--no-build` skips the rebuild and `--no-ai` skips the title check. Keys come from `keys/youtube.txt` (or `YT_API_KEY`) and `keys/gemini.txt` (or `GEMINI_API_KEY`).

To check a single video yourself, `node scripts/yt-check.mjs "<youtube-url>"` prints whether it can be embedded and which countries it is available in.

## Data sources and credits

Match results: [openfootball/worldcup.json](https://github.com/openfootball/worldcup.json) (public domain). Highlights are official, linked from each broadcaster. This project is a non-commercial fan tool and is not affiliated with FIFA or any broadcaster; logos identify the source of each clip and nothing more.
