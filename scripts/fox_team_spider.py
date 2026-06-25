"""
fox_team_spider.py  -  BLACKOUT club / league / bio scraper (Fox Sports, from scratch)

Single file, no Scrapy project scaffolding needed. Run it with:

    scrapy runspider fox_team_spider.py

By default it reads the 48 national-team slugs from fox-urls.json sitting next to
this script and scrapes each national roster. Override the targets with either:

    scrapy runspider fox_team_spider.py -a roster_urls="https://www.foxsports.com/soccer/uruguay-men-team-roster"
    scrapy runspider fox_team_spider.py -a teams_file=team-urls.txt   # one base or roster URL per line

Other knobs:
    -a out=DIR        output directory (default: out)
    -a foxurls=PATH   path to fox-urls.json (default: fox-urls.json)
    -a season=YYYY    season label for the club-league mapping (default: 2025/2026)

------------------------------------------------------------------------------
Crawl shape (three levels)
------------------------------------------------------------------------------
  national roster page   ->  players: name, player URL, national squad number,
                             then a request to each player's bio page
  player bio page        ->  dob (y/m/d), birthplace, nationality, height/weight,
                             position, club (+ club number + club link), headshot,
                             then a request to that club's standings page (deduped)
  club standings page    ->  club crest + league name   (clubs only)

------------------------------------------------------------------------------
Output files (in ./out by default)
------------------------------------------------------------------------------
  team-info.json      the structured data (see shape below)
  leagues-logos.csv   league_key,league_name,logo_url  -> you fill logo_url,
                      it is read back and merged into team-info.json on re-run
  aliases.json        empty alias overlay keyed by id; fill it later (or have an
                      AI step fill it) and it is merged into team-info.json on re-run

team-info.json shape:
  {
    "generated": ISO8601,
    "default_season": "2025/2026",
    "teams":   { team_id:   {id, name, roster_url, players:[player_id...], aliases:[]} },
    "players": { player_id: {id, name, team, num, pos, dob:{year,month,date},
                             birthplace, nationality, height_in, weight_lb, photo,
                             club, club_num} },
    "clubs":   { club_id:   {id, name, crest, aliases:[]} },
    "leagues": { league_key:{key, name, logo, aliases:[]} },
    "seasons": { "2025/2026": { club_id: league_key } }
  }

IDs:
  player id  = the player's Fox URL  (matches players.json -> players[].stats)
  team id    = the national team's Fox -team URL
  club id    = the club's Fox -team URL  (from the bio club link)
  league key = lowercased, accent-stripped, whitespace-collapsed league name

Design notes:
  * Heights are stored as whole inches, weights as whole lbs. The website does the
    imperial/metric display and rounding (cm = round(in*2.54), kg = round(lb*0.45359237)).
  * The club lives in the season map, not on the club record, so a club can sit in a
    different league in a future season (promotion/relegation) without touching its crest.
  * Aliases are NOT generated here. Scraping cannot invent "Barca" for "Barcelona".
    aliases.json is the slot to add them later; it is merged back in on re-run.
  * Fox rate-limits. Polite throttle + an on-disk HTTP cache are enabled, so re-runs
    (for example while you tweak a selector) mostly hit the cache, not Fox.
"""

import csv
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import scrapy
from scrapy.downloadermiddlewares.retry import RetryMiddleware, get_retry_request
from scrapy.extensions.httpcache import DummyPolicy
from twisted.internet import reactor
from twisted.internet.task import deferLater


# --------------------------------------------------------------------------- #
# self-healing cache policy
# --------------------------------------------------------------------------- #
# HTTPCACHE_IGNORE_HTTP_CODES only stops a block response from being WRITTEN to
# the cache. It does NOT stop an already-cached block from being SERVED: Scrapy's
# default policy checks the ignore list on write, never on read. So a .fox_cache
# built by an older spider version (which DID cache 406s) keeps replaying those
# 406s from disk forever — no live request is ever made, and changing IP/network
# does nothing (httpcache/hit == request_count, with cached 406s among the hits).
# This policy closes that gap: a cached response with a block status is treated as
# stale, forcing a fresh live fetch. Combined with HTTPCACHE_IGNORE_HTTP_CODES
# (don't re-store it), the cache becomes self-cleaning with no manual purge.
class FreshCachePolicy(DummyPolicy):
    BLOCK_CODES = {403, 406, 408, 425, 429, 500, 502, 503, 504, 522, 524}

    def is_cached_response_fresh(self, cachedresponse, request):
        if cachedresponse.status in self.BLOCK_CODES:
            return False  # never serve a cached block/error — re-fetch it live
        return super().is_cached_response_fresh(cachedresponse, request)


# --------------------------------------------------------------------------- #
# escalating backoff for Fox's volume blocks (HTTP 406/403/429)
# --------------------------------------------------------------------------- #
class BlockBackoffMiddleware(RetryMiddleware):
    """
    Fox lets roughly ~200-250 requests through, then blocks the IP with HTTP 406
    for an extended period; the block does NOT clear in seconds. The previous
    design (escalating backoff up to ~5 min per retry, ~33 min per URL) was a
    mistake: once blocked, a single URL stalled the whole single-threaded crawl
    for half an hour while making zero progress, so an overnight run got nowhere.

    The working model is BURST crawling. Cached 200s don't count against Fox's
    budget (they're served from .fox_cache without a request), so each run fetches
    a fresh ~200 pages, banks them in the cache, and stops. Re-running later (after
    the block lapses) resumes from the cache and banks the next ~200. A few runs
    complete the whole crawl. To make that efficient this middleware:

      * fails FAST on a block — a couple of short retries (a few seconds), then it
        gives up on that URL for THIS run. The URL isn't cached (406 is in
        HTTPCACHE_IGNORE_HTTP_CODES), so the next run retries it cleanly.
      * trips a CIRCUIT BREAKER: once blocks come in a sustained streak (a run's
        budget is spent), it closes the spider gracefully instead of grinding
        through a thousand doomed requests. Successes reset the streak, so early
        one-off 406s don't trip it.

    Tune via env: FOX_BLOCK_RETRIES (per-URL quick retries), FOX_BLOCK_DELAY
    (seconds between them), FOX_BLOCK_TRIP (consecutive blocks that stop the run).
    """
    BLOCK_CODES = {403, 406, 429}
    QUICK_RETRIES = int(os.environ.get("FOX_BLOCK_RETRIES", "2"))
    QUICK_DELAY = float(os.environ.get("FOX_BLOCK_DELAY", "6"))
    TRIP = int(os.environ.get("FOX_BLOCK_TRIP", "25"))

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._streak = 0          # consecutive blocks (reset by any non-block response)
        self._tripped = False

    def _pause(self, seconds):
        # non-blocking delay (reactor keeps running: logging, shutdown, other slots)
        return deferLater(reactor, seconds, lambda: None)

    def process_response(self, request, response, spider):
        if response.status in self.BLOCK_CODES:
            self._streak += 1
            # circuit breaker: a sustained streak means this run's budget is spent.
            if not self._tripped and self._streak >= self.TRIP:
                self._tripped = True
                spider.logger.warning(
                    "blocked by Fox (%d 406s in a row) — stopping this run to keep "
                    "the cache. Wait ~30-60 min and re-run to resume from where it "
                    "left off; a few bursts will finish the crawl.", self._streak)
                try:
                    spider.crawler.engine.close_spider(spider, "fox-block-circuit-breaker")
                except Exception:
                    pass
                return response
            if self._tripped:
                return response   # draining: don't bother retrying once we're closing
            blk = request.meta.get("block_retries", 0)
            if blk < self.QUICK_RETRIES:
                request.meta["block_retries"] = blk + 1
                # small, lightly-jittered pause then retry the SAME url quickly
                import random
                delay = self.QUICK_DELAY * (0.7 + 0.6 * random.random())
                new_req = request.copy()
                new_req.dont_filter = True
                spider.logger.info("block %d on %s -> quick retry %d in %.0fs",
                                   response.status, request.url, blk + 1, delay)
                d = self._pause(delay)
                d.addCallback(lambda _: new_req)
                return d
            # out of quick retries: drop for this run (uncached -> a later run retries it)
            spider.logger.info("block %d on %s -> skipping this run", response.status, request.url)
            return response
        # any non-block response clears the streak
        self._streak = 0
        return super().process_response(request, response, spider)


# --------------------------------------------------------------------------- #
# small pure helpers (unit-tested separately)
# --------------------------------------------------------------------------- #

def nrm(s):
    """lowercase + strip accents (matches index.html nrm; no trim)."""
    s = s or ""
    return "".join(c for c in unicodedata.normalize("NFD", s.lower())
                   if unicodedata.category(c) != "Mn")


def keyify(s):
    """nrm + trim + collapse internal whitespace. Used for league keys + matching."""
    return re.sub(r"\s+", " ", nrm(s)).strip()


def canon_url(base, href):
    """absolute, query/fragment stripped, no trailing slash."""
    if not href:
        return None
    if base:
        # scrapy Response has urljoin; fall back to plain join logic for tests
        href = base.urljoin(href) if hasattr(base, "urljoin") else _join(base, href)
    href = href.split("#", 1)[0].split("?", 1)[0]
    return href.rstrip("/")


def _join(base, href):
    if href.startswith(("http://", "https://")):
        return href
    if href.startswith("/"):
        m = re.match(r"^(https?://[^/]+)", base or "")
        return (m.group(1) if m else "") + href
    return (base or "").rstrip("/") + "/" + href


def base_from_team_url(u):
    """strip a trailing -roster / -standings to get the base -team URL."""
    u = (u or "").rstrip("/")
    for suf in ("-roster", "-standings"):
        if u.endswith(suf):
            u = u[: -len(suf)]
    return u


def parse_dob(text):
    """'6/16/1986' -> {'year':1986,'month':6,'date':16}, else None."""
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", text or "")
    if not m:
        return None
    mo, da, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return {"year": yr, "month": mo, "date": da}


def parse_height_in(text):
    """\"6'2\\\"\" -> 74 inches, else None."""
    m = re.search(r"(\d+)\s*'\s*(\d+)", text or "")
    if not m:
        return None
    return int(m.group(1)) * 12 + int(m.group(2))


def parse_weight_lb(text):
    """'187 lbs' -> 187, else None."""
    m = re.search(r"(\d+)\s*lb", (text or "").lower())
    return int(m.group(1)) if m else None


def pos_letter(text):
    """first alphabetic character, uppercased ('GOALIE' -> 'G'), else None."""
    for ch in (text or ""):
        if ch.isalpha():
            return ch.upper()
    return None


# words that may appear as labels rather than values; ignored when picking the
# two free-text fields (birthplace / nationality) out of the .bold span list
_BIO_LABELS = {"age", "dob", "born", "birthdate", "birthday", "ht", "wt", "ht/wt",
               "height", "weight", "from", "birthplace", "nationality", "nation"}


def classify_bio_spans(spans):
    """
    Given the raw text of the five `.bold span` values (in any order), pull out the
    fields by pattern so a missing value cannot shift the others:
      - date of birth   : matches M/D/YYYY
      - height + weight  : contains feet/inches and/or 'lbs'
      - age              : a bare integer (discarded)
      - the remaining free-text values, in document order, are birthplace then
        nationality (nationality preferred if only one survives, since the club
        match needs it)
    Returns {'dob','height_in','weight_lb','birthplace','nationality'}.
    """
    out = {"dob": None, "height_in": None, "weight_lb": None,
           "birthplace": None, "nationality": None}
    free = []
    for raw in spans:
        s = (raw or "").strip()
        if not s:
            continue
        if out["dob"] is None and re.search(r"\b\d{1,2}/\d{1,2}/\d{4}\b", s):
            out["dob"] = parse_dob(s)
            continue
        if ("'" in s and '"' in s) or re.search(r"\blb", s.lower()):
            hi, wl = parse_height_in(s), parse_weight_lb(s)
            if hi is not None:
                out["height_in"] = hi
            if wl is not None:
                out["weight_lb"] = wl
            continue
        if re.fullmatch(r"\d{1,3}", s):          # bare age -> discard
            continue
        if keyify(s) in _BIO_LABELS:             # a label, not a value
            continue
        free.append(s)
    if len(free) >= 2:
        out["birthplace"], out["nationality"] = free[0], free[1]
    elif len(free) == 1:
        out["nationality"] = free[0]
    return out


def parse_club_line(text, nationality):
    """
    '#16 - GOALIE - ESTUDIANTES DE LA PLATA'  -> (16, 'G', 'Estudiantes De La Plata raw...')
    'DEFENDER - NO TEAM'                       -> (None, 'D', None)
    '#12 - MIDFIELDER - QATAR' (nat=Qatar)     -> (None, 'M', None)   # club == nationality
    Returns (club_num|None, pos_letter|None, club_name|None).
    When the club is null the club number is forced null too, and the caller drops
    the club link.
    """
    if not text:
        return None, None, None
    # canonicalise any spaced dash variant to ' - '; leave in-name hyphens (no
    # surrounding spaces) such as Saint-Etienne untouched
    t = text.replace("\xa0", " ")
    t = re.sub(r"\s+[\u2012\u2013\u2014\u2015-]\s+", " - ", t)
    t = re.sub(r"\s+", " ", t).strip()
    parts = [p.strip() for p in t.split(" - ") if p.strip()]

    club_num = None
    if parts and re.match(r"^#?\d+$", parts[0].replace(" ", "")):
        club_num = int(re.sub(r"\D", "", parts[0]))
        parts = parts[1:]

    pos = pos_letter(parts[0]) if parts else None
    club = " - ".join(parts[1:]).strip() if len(parts) > 1 else None

    if club is not None:
        ck = keyify(club)
        if ck in ("no team", "") or (nationality and ck == keyify(nationality)):
            club = None
    if club is None:
        club_num = None
    return club_num, pos, club


def extract_img(sel):
    """
    First image URL from a SelectorList. Handles the class being on the <img>
    itself or on a container, and src / data-src / srcset / inline background.
    """
    if not sel:
        return None
    el = sel[0]
    for q in ("::attr(src)", "::attr(data-src)",
              "img::attr(src)", "img::attr(data-src)",
              "img::attr(srcset)", "source::attr(srcset)"):
        v = el.css(q).get()
        if v:
            v = v.strip()
            if "srcset" in q:
                v = v.split(",")[0].strip().split(" ")[0]
            if v:
                return v
    style = el.css("::attr(style)").get() or ""
    m = re.search(r"url\(([^)]+)\)", style)
    if m:
        return m.group(1).strip("'\" ")
    return None


def is_national_team_url(url):
    """A Fox national-team page, e.g. .../algeria-men-team. These are not clubs."""
    u = (url or "").rstrip("/")
    return bool(re.search(r"-men-team$|-women-team$", u))


def is_national_crest(url):
    """Fox serves national sides a country flag-logo, not a club crest."""
    return "/countries/flag-logos/" in (url or "")


def clean_crest(url):
    """
    Normalise a scraped crest. Returns None for the cases that should fall back
    to initials/another source:
      * Fox's generic 'Placeholder' image (club has no real crest on Fox)
      * a country flag-logo (a national team mis-scraped as a club)
      * an empty/whitespace value
    """
    u = (url or "").strip()
    if not u:
        return None
    if is_national_crest(u):
        return None
    if re.search(r"/placeholder\.", u, re.I):
        return None
    return u


# --------------------------------------------------------------------------- #
# spider
# --------------------------------------------------------------------------- #

FOX = "https://www.foxsports.com/soccer/"
FSSTA_HEAD = "https://b.fssta.com/uploads/application/soccer/headshots/"


class FoxTeamSpider(scrapy.Spider):
    name = "fox_team"

    # Pacing is intentionally gentle so a full crawl completes overnight without
    # tripping Fox's volume-based blocking (which returns HTTP 406). The earlier
    # fast settings (4 concurrent, 1s delay, ~50 pages/min) sailed for ~180 pages
    # then hit a wall of 406s. Key facts that shape this config:
    #   * 406 was NOT retried and NOT cache-ignored before, so blocked URLs were
    #     stored in .fox_cache as 406 and served back forever. Both fixed below.
    #   * AutoThrottle cannot save us here: a 406 block returns FAST, so AutoThrottle
    #     reads low latency and would speed up. We add explicit escalating backoff
    #     on 406/403/429 via BlockBackoffMiddleware instead.
    # Tune without editing via env vars: FOX_DELAY (seconds), FOX_CONCURRENCY.
    custom_settings = {
        "USER_AGENT": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "ROBOTSTXT_OBEY": False,
        # one request at a time, with a randomised gap, keeps us under the radar
        "CONCURRENT_REQUESTS": int(os.environ.get("FOX_CONCURRENCY", "1")),
        "CONCURRENT_REQUESTS_PER_DOMAIN": int(os.environ.get("FOX_CONCURRENCY", "1")),
        "DOWNLOAD_DELAY": float(os.environ.get("FOX_DELAY", "2.5")),
        "RANDOMIZE_DOWNLOAD_DELAY": True,   # actual gap is 0.5x..1.5x DOWNLOAD_DELAY
        # AutoThrottle still helps smooth genuine slow responses, but kept conservative.
        "AUTOTHROTTLE_ENABLED": True,
        "AUTOTHROTTLE_START_DELAY": 2.5,
        "AUTOTHROTTLE_MAX_DELAY": 90.0,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 1.0,
        # Retry blocks aggressively; the backoff middleware spaces the retries out.
        "RETRY_ENABLED": True,
        "RETRY_TIMES": int(os.environ.get("FOX_RETRIES", "10")),
        "RETRY_HTTP_CODES": [403, 406, 408, 425, 429, 500, 502, 503, 504, 522, 524],
        # Never cache a failure: blocked/erroring URLs must be re-fetched next run,
        # not served from disk. (This is what poisoned the cache before.)
        "HTTPCACHE_ENABLED": True,
        "HTTPCACHE_EXPIRATION_SECS": 0,
        "HTTPCACHE_DIR": ".fox_cache",
        "HTTPCACHE_IGNORE_HTTP_CODES": [403, 406, 408, 425, 429, 500, 502, 503, 504, 522, 524],
        # Belt-and-braces: IGNORE_HTTP_CODES stops blocks being written; this policy
        # stops an already-cached block (from an older run) being served. Together
        # they make a poisoned .fox_cache re-fetch its 406s live on the next run,
        # so no manual cache surgery is needed. Referenced by __name__ for the same
        # reason as the middleware below.
        "HTTPCACHE_POLICY": __name__ + ".FreshCachePolicy",
        # Our middleware subclasses RetryMiddleware and handles ALL retries (it
        # delegates normal retry codes to super()), so disable the stock one to
        # avoid retrying twice.
        # Reference the middleware by this module's real name. Under
        # `scrapy runspider fox_team_spider.py` the module is imported as
        # "fox_team_spider" (NOT "__main__"), so a hard-coded "__main__." path
        # makes Scrapy fail to find the class and abort on startup. __name__
        # resolves correctly however the file is invoked.
        "DOWNLOADER_MIDDLEWARES": {
            "scrapy.downloadermiddlewares.retry.RetryMiddleware": None,
            __name__ + ".BlockBackoffMiddleware": 550,
        },
        # browser-like headers reduce the chance a request looks automated
        "DEFAULT_REQUEST_HEADERS": {
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                       "image/avif,image/webp,*/*;q=0.8"),
            "Accept-Encoding": "gzip, deflate, br",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
        },
        "LOG_LEVEL": "INFO",
        "FEED_EXPORT_ENCODING": "utf-8",
    }

    def __init__(self, foxurls="data/fox-urls.json", out="out", season="2025/2026",
                 teams=None, probe=None, bio_suffix="-bio", *args, **kw):
        # NOTE: the physical bio (DOB/height/weight/birthplace/nationality) lives
        # on the player's "-bio" page, not the bare "-player" page. The "-player"
        # page only carries club/position/photo. So "-bio" is the DEFAULT, not an
        # opt-in flag. Pass `-a bio_suffix=` (empty) to fetch the bare page.
        super().__init__(*args, **kw)
        self.out = out
        self.season = season
        self.bio_suffix = bio_suffix or ""
        self.probe = probe
        self.only_teams = (
            set(t.strip().lower() for t in re.split(r"[,]+", teams) if t.strip())
            if teams else None)

        # accumulators
        self.teams, self.players, self.clubs, self.leagues = {}, {}, {}, {}
        self.seasons = {self.season: {}}
        self._seen_clubs = set()
        self._bio_ok, self._bio_empty = 0, 0

        # overlays read at start, merged at close
        os.makedirs(self.out, exist_ok=True)
        self.logo_map = self._read_logo_csv(os.path.join(self.out, "leagues-logos.csv"))
        self.alias_overlay = self._read_aliases(os.path.join(self.out, "aliases.json"))

        # The squad list is already resolved by build-rosters.mjs, so read the
        # players straight from fox-urls.json rather than re-scraping each roster
        # page (that re-scrape was fragile and is what returned 0 players).
        self.fox = {}
        if os.path.exists(foxurls):
            self.fox = json.load(open(foxurls, encoding="utf-8"))
        elif not probe:
            self.logger.error(
                "fox-urls.json not found at %s - run build-rosters.mjs first", foxurls)

    # ---- start ------------------------------------------------------------ #

    def _bio_url(self, url):
        u = url.rstrip("/")
        return (u + self.bio_suffix) if self.bio_suffix else u

    def start_requests(self):
        # Diagnostic: fetch ONE page and dump what each selector finds, so the
        # real Fox markup can be confirmed without guessing. Example:
        #   scrapy runspider fox_team_spider.py -a probe=fernando-muslera-player
        if self.probe:
            url = self.probe if self.probe.startswith("http") else (FOX + self.probe.strip("/"))
            yield scrapy.Request(url, callback=self.parse_probe, dont_filter=True,
                                 meta={"probe_url": url})
            return

        teams = self.fox.get("teams", {})
        queued = 0
        for name, obj in teams.items():
            if self.only_teams and name.lower() not in self.only_teams:
                continue
            slug = obj.get("slug")
            team_id = (FOX + slug + "-team") if slug else name
            self.teams.setdefault(team_id, {
                "id": team_id, "name": name,
                "roster_url": (FOX + slug + "-team-roster") if slug else None,
                "players": [], "aliases": [],
            })
            for p in (obj.get("players") or []):
                url, nm = p.get("url"), p.get("name")
                if not url or not nm:
                    continue
                if url not in self.teams[team_id]["players"]:
                    self.teams[team_id]["players"].append(url)
                queued += 1
                yield scrapy.Request(
                    self._bio_url(url), callback=self.parse_bio,
                    meta={"team_id": team_id, "player_url": url,
                          "name": nm, "num": p.get("num"), "fid": p.get("fid")},
                )
        self.logger.info("queued %d players across %d teams from fox-urls.json",
                         queued, len(self.teams))

    # ---- diagnostic probe ------------------------------------------------- #

    def parse_probe(self, response):
        def texts(sel):
            return [t.strip() for t in response.css(sel + "::text").getall() if t.strip()]
        report = {
            "url": response.url,
            "http_status": response.status,
            "html_bytes": len(response.body),
            "a[href*=-player]": len(response.css('a[href*="-player"]')),
            ".ls-pt5 (numbers)": texts(".ls-pt5")[:6],
            ".bold span": texts(".bold span")[:10],
            ".desktop-only .cl-wht": (" ".join(texts(".desktop-only .cl-wht")))[:160],
            ".cl-wht (any)": (" ".join(texts(".cl-wht")))[:160],
            ".entity-card-logo img": (response.css(".entity-card-logo img::attr(src)").get()
                                      or response.css(".entity-card-logo::attr(src)").get()),
            ".pointer count": len(response.css(".pointer")),
            "h1": texts("h1")[:3],
            "title": (response.css("title::text").get() or "").strip()[:120],
        }
        print("\n================ FOX PROBE ================")
        for k, v in report.items():
            print(f"{k:24}: {v}")
        print("==========================================")
        path = os.path.join(self.out, "_probe.html")
        with open(path, "wb") as fh:
            fh.write(response.body)
        print(f"raw HTML saved to {path} ({len(response.body)} bytes)\n")

    # ---- level 2: player bio --------------------------------------------- #

    def parse_bio(self, response):
        m = response.meta
        spans = response.css(".bold span::text").getall()
        bio = classify_bio_spans(spans)

        cl = response.css(".desktop-only .cl-wht")
        cl_text = " ".join(x.strip() for x in cl.css("::text").getall() if x.strip())
        club_num, pos, club_name = parse_club_line(cl_text, bio["nationality"])

        club_id = None
        if club_name is not None:
            href = cl.css("a::attr(href)").get() or (cl[0].attrib.get("href") if cl else None)
            cand = canon_url(response, href)
            # A player's "club" can be their own national team (e.g. a domestic-based
            # player whose Fox club link is .../qatar-men-team). That is not a club:
            # drop it so national sides never pollute the club list or the season map.
            if cand and is_national_team_url(cand):
                cand = None
            club_id = cand
            if club_id:
                self.clubs.setdefault(club_id, {
                    "id": club_id, "name": club_name.title(),
                    "crest": None, "aliases": [],
                })
                if club_id not in self._seen_clubs:
                    self._seen_clubs.add(club_id)
                    yield scrapy.Request(
                        club_id + "-standings", callback=self.parse_standings,
                        meta={"club_id": club_id})
            else:
                club_num = None  # club text present but no usable (club) link

        # Honest bio coverage: count this player only if a *physical-bio* field
        # parsed. Clubs are NOT a bio (a player can have a club and no bio, e.g. a
        # player whose -bio page lacks the stats). Lumping club_name in here is
        # what made "bio fields on N" read high while DOB/height/weight stayed 0.
        if any(v is not None for v in (bio["dob"], bio["height_in"], bio["weight_lb"],
                                       bio["nationality"], bio["birthplace"])):
            self._bio_ok += 1
        else:
            self._bio_empty += 1
            self.logger.debug("no bio fields parsed from %s", response.url)

        self.players[m["player_url"]] = {
            "id": m["player_url"],
            "name": m["name"],
            "team": m["team_id"],
            "num": m.get("num"),
            "pos": pos,
            "dob": bio["dob"],
            "birthplace": bio["birthplace"],
            "nationality": bio["nationality"],
            "height_in": bio["height_in"],
            "weight_lb": bio["weight_lb"],
            "photo": extract_img(response.css(".entity-card-logo")) or self._fid_photo(m.get("fid")),
            "club": club_id,
            "club_num": club_num,
        }

    @staticmethod
    def _fid_photo(fid):
        return (FSSTA_HEAD + str(fid) + ".png") if fid else None

    # ---- level 3: club standings ----------------------------------------- #

    def parse_standings(self, response):
        club_id = response.meta["club_id"]
        # Defensive: if a national-team standings page slipped through, do not record it.
        if is_national_team_url(club_id):
            self.clubs.pop(club_id, None)
            return
        club = self.clubs.setdefault(
            club_id, {"id": club_id, "name": None, "crest": None, "aliases": []})

        # Real club crest only: drop Fox's Placeholder image and any flag-logo.
        club["crest"] = clean_crest(extract_img(response.css(".entity-card-logo")))

        pointers = response.css(".pointer")
        league_name = None
        if len(pointers) >= 3:
            league_name = " ".join(
                x.strip() for x in pointers[2].css("::text").getall() if x.strip()).strip()
        if not league_name:
            # fallback: the standings page heading, e.g. "Serie A Standings".
            # drop the trailing word "standings" (and the space before it).
            uc = " ".join(
                x.strip() for x in response.css(".ls-pt25 .uc::text").getall() if x.strip()).strip()
            if uc:
                league_name = re.sub(r"\s+standings\s*$", "", uc, flags=re.I).strip()
        if league_name:
            key = keyify(league_name)
            # Fox standings pages carry no league/competition logo, so we never
            # scrape one. A logo only ever comes from a hand-filled leagues-logos.csv
            # (e.g. sourced elsewhere); otherwise it stays null and the site falls
            # back to the league's initials.
            logo = self.logo_map.get(key) or None
            existing = self.leagues.get(key)
            if existing:
                if not existing.get("logo") and logo:
                    existing["logo"] = logo
            else:
                self.leagues[key] = {"key": key, "name": league_name, "logo": logo, "aliases": []}
            self.seasons[self.season][club_id] = key
        else:
            self.logger.warning("no league found on %s", response.url)

    # ---- write out -------------------------------------------------------- #

    def closed(self, reason):
        # MERGE WITH EXISTING OUTPUT so repeated bursts accumulate. Fox blocks the
        # IP after ~230 requests, so a full crawl is done across several runs; each
        # run only processes the pages it dequeued before the circuit breaker
        # tripped. Without merging, a short run would overwrite a fuller file with
        # less data (and two runs at once would clobber each other). We load the
        # previous team-info.json and fold it in: this run's freshly-scraped record
        # wins for any key it has, and older records are kept for everything else.
        prev_path = os.path.join(self.out, "team-info.json")
        if os.path.exists(prev_path):
            try:
                with open(prev_path, encoding="utf-8") as fh:
                    prev = json.load(fh)
                merged = 0
                for attr in ("teams", "players", "clubs", "leagues"):
                    cur = getattr(self, attr)
                    for k, v in (prev.get(attr) or {}).items():
                        if k not in cur:
                            cur[k] = v
                            merged += 1
                # Field-level backfill: for records present in BOTH, keep this run's
                # values but fill any field that is missing/empty here from the
                # carried-over record. Without this, a partial re-parse (e.g. a run
                # stopped early, or a page that momentarily lacked bio fields) could
                # overwrite a fuller record with a thinner one and *lose* a bio that
                # an earlier burst had captured. This makes "never shrink" hold at
                # the field level, not just the record level.
                def _empty(x):
                    return x is None or x == "" or x == {} or x == []
                backfilled = 0
                for attr in ("teams", "players", "clubs", "leagues"):
                    cur = getattr(self, attr)
                    for k, old in (prev.get(attr) or {}).items():
                        new = cur.get(k)
                        if isinstance(old, dict) and isinstance(new, dict):
                            for fk, fv in old.items():
                                if _empty(new.get(fk)) and not _empty(fv):
                                    new[fk] = fv
                                    backfilled += 1
                if backfilled:
                    self.logger.info("backfilled %d missing field(s) from existing team-info.json", backfilled)
                # seasons: merge per-club rows (this run wins on conflicts)
                for cid, rows in (prev.get("seasons") or {}).items():
                    dst = self.seasons.setdefault(cid, {})
                    for season_k, row in rows.items():
                        dst.setdefault(season_k, row)
                self.logger.info("merged %d carried-over records from existing team-info.json", merged)
            except Exception as e:
                self.logger.warning("could not merge existing team-info.json (%s); writing this run only", e)

        # Final sweep: drop any national-team entries that slipped into clubs, and
        # normalise crests (no Placeholder, no flag-logo). Also detach those ids from
        # the season map and any player's club field so nothing points at a non-club.
        bad_clubs = set()
        for cid, c in list(self.clubs.items()):
            c["crest"] = clean_crest(c.get("crest"))
            if is_national_team_url(cid) or is_national_crest((c or {}).get("crest")):
                bad_clubs.add(cid)
        for cid in bad_clubs:
            self.clubs.pop(cid, None)
        for season in self.seasons.values():
            for cid in list(season.keys()):
                if cid in bad_clubs:
                    season.pop(cid, None)
        for p in self.players.values():
            if p.get("club") in bad_clubs:
                p["club"] = None
                p["club_num"] = None
        if bad_clubs:
            self.logger.info("dropped %d national-team entr%s from clubs",
                             len(bad_clubs), "y" if len(bad_clubs) == 1 else "ies")

        # merge alias overlay into each record
        for tid, t in self.teams.items():
            t["aliases"] = list(self.alias_overlay.get("teams", {}).get(tid, []))
        for cid, c in self.clubs.items():
            c["aliases"] = list(self.alias_overlay.get("clubs", {}).get(cid, []))
        for k, lg in self.leagues.items():
            lg["aliases"] = list(self.alias_overlay.get("leagues", {}).get(k, []))

        doc = {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "default_season": self.season,
            "teams": self.teams,
            "players": self.players,
            "clubs": self.clubs,
            "leagues": self.leagues,
            "seasons": self.seasons,
        }
        self._dump_json(os.path.join(self.out, "team-info.json"), doc)
        self._write_logo_csv(os.path.join(self.out, "leagues-logos.csv"))
        self._write_aliases(os.path.join(self.out, "aliases.json"))

        self.logger.info(
            "done: %d teams, %d players, %d clubs, %d leagues; bio fields on %d, empty on %d",
            len(self.teams), len(self.players), len(self.clubs), len(self.leagues),
            self._bio_ok, self._bio_empty)

    # ---- file helpers ----------------------------------------------------- #

    @staticmethod
    def _read_logo_csv(path):
        out = {}
        if os.path.exists(path):
            with open(path, newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    key = (row.get("league_key") or "").strip()
                    logo = (row.get("logo_url") or "").strip()
                    if key and logo:
                        out[key] = logo
        return out

    def _write_logo_csv(self, path):
        rows = sorted(self.leagues.values(), key=lambda lg: lg["name"].lower())
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["league_key", "league_name", "logo_url"])
            for lg in rows:
                w.writerow([lg["key"], lg["name"], self.logo_map.get(lg["key"], "")])

    @staticmethod
    def _read_aliases(path):
        if os.path.exists(path):
            try:
                return json.load(open(path, encoding="utf-8"))
            except Exception:
                pass
        return {"teams": {}, "clubs": {}, "players": {}, "leagues": {}}

    def _write_aliases(self, path):
        # keep any filled arrays, add empty slots for every current id/key
        ov = self.alias_overlay
        merged = {"teams": {}, "clubs": {}, "players": {}, "leagues": {}}
        for tid in self.teams:
            merged["teams"][tid] = ov.get("teams", {}).get(tid, [])
        for cid in self.clubs:
            merged["clubs"][cid] = ov.get("clubs", {}).get(cid, [])
        for pid in self.players:
            merged["players"][pid] = ov.get("players", {}).get(pid, [])
        for k in self.leagues:
            merged["leagues"][k] = ov.get("leagues", {}).get(k, [])
        self._dump_json(path, merged)

    @staticmethod
    def _dump_json(path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=1)
            fh.write("\n")


if __name__ == "__main__":
    # Lets you run with a plain "python fox_team_spider.py" (the VS Code Run
    # button uses that). It is exactly equivalent to running, from a terminal:
    #     scrapy runspider fox_team_spider.py
    # The spider's own custom_settings (throttle, on-disk cache, retries) still
    # apply. Output lands in ./out next to wherever you run this from.
    from scrapy.crawler import CrawlerProcess

    process = CrawlerProcess(settings={"TELNETCONSOLE_ENABLED": False})
    process.crawl(FoxTeamSpider)
    process.start()
