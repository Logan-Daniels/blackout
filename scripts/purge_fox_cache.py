#!/usr/bin/env python3
"""
purge_fox_cache.py - remove cached BLOCK/ERROR responses from Scrapy's .fox_cache

Why this exists
---------------
An older version of fox_team_spider.py cached Fox's 406 "blocked" responses to
disk. Scrapy's default cache policy checks the ignore-list only when WRITING a
response, never when READING one, so those stale 406s get served back on every
run without a live request ever being made. Symptom: in the run stats,
`httpcache/hit` equals the total request count, the SAME urls fail in the SAME
order every time, and changing network/IP makes no difference because no packet
ever reaches Fox.

The patched spider now ships a self-healing cache policy (FreshCachePolicy) that
re-fetches cached blocks automatically, so you usually DON'T need this script.
Use it if you want to force a clean slate immediately, or you're running an older
spider. It deletes ONLY entries whose stored status is a block/error code; the
cached 200 pages (your real data) are kept, so the next crawl stays fast.

Usage
-----
    cd ~/Downloads/blackout
    python3 scripts/purge_fox_cache.py            # purge .fox_cache
    python3 scripts/purge_fox_cache.py --dry-run  # preview, delete nothing
    python3 scripts/purge_fox_cache.py PATH       # purge a cache dir elsewhere
"""
import ast
import os
import pickle
import shutil
import sys

# Match the spider's HTTPCACHE_IGNORE_HTTP_CODES / BlockBackoffMiddleware codes.
BLOCK_CODES = {403, 406, 408, 425, 429, 500, 502, 503, 504, 522, 524}


def read_status(entry_dir):
    """Return the cached HTTP status for one cache entry, or None if unreadable."""
    meta_path = os.path.join(entry_dir, "meta")
    # 1) the human-readable `meta` file is a repr() of a dict incl. 'status'
    try:
        with open(meta_path, "rb") as fh:
            data = fh.read().decode("utf-8", "replace")
        meta = ast.literal_eval(data)
        if isinstance(meta, dict) and "status" in meta:
            return int(meta["status"])
    except Exception:
        pass
    # 2) fall back to the pickled metadata
    try:
        with open(os.path.join(entry_dir, "pickled_meta"), "rb") as fh:
            meta = pickle.load(fh)
        if isinstance(meta, dict) and "status" in meta:
            return int(meta["status"])
    except Exception:
        pass
    return None


def main():
    args = [a for a in sys.argv[1:]]
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    cache_dir = args[0] if args else ".fox_cache"

    if not os.path.isdir(cache_dir):
        print("No cache directory at %r - nothing to do." % cache_dir)
        return 0

    scanned = kept = removed = unreadable = 0
    by_code = {}
    for root, dirs, files in os.walk(cache_dir):
        if "meta" not in files and "pickled_meta" not in files:
            continue  # not a leaf cache entry
        scanned += 1
        status = read_status(root)
        if status is None:
            unreadable += 1
            kept += 1
            continue
        if status in BLOCK_CODES:
            by_code[status] = by_code.get(status, 0) + 1
            removed += 1
            if not dry:
                shutil.rmtree(root, ignore_errors=True)
        else:
            kept += 1

    verb = "would remove" if dry else "removed"
    print("Scanned %d cache entries in %r" % (scanned, cache_dir))
    print("Kept %d good (200/3xx) entries%s" %
          (kept, " (incl. %d unreadable, left untouched)" % unreadable if unreadable else ""))
    if by_code:
        breakdown = ", ".join("%d×%d" % (n, code) for code, n in sorted(by_code.items()))
        print("%s %d blocked/error entries (%s)" % (verb.capitalize(), removed, breakdown))
    else:
        print("No blocked/error entries found - cache is clean.")
    if dry and removed:
        print("\nDry run: nothing deleted. Re-run without --dry-run to purge.")
    elif removed:
        print("\nDone. Re-run the spider; the purged URLs will be fetched live.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
