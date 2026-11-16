#!/usr/bin/env python3
"""Seed Verta's usage archive with what Token Monitor kept for sessions this machine no longer has.

Why: the usage window re-reads every agent store from scratch, so a session somebody deleted takes its
tokens out of the picture. Token Monitor scanned before the deletion and archived per-session totals; the
archive is the only place those numbers still exist. Verta's own archive (`verta-usage-archive.json`,
written by every read now) keeps them from here on, and this script puts the history in.

What it does, in order:
  1. reads Token Monitor's `session-usage-archive.sqlite`;
  2. drops every session this machine can still read - otherwise the seed would count live usage twice,
     because the next scan adds it again;
  3. spreads each remaining session evenly over the days between its first and last use (Token Monitor
     keeps no per-day breakdown for them: its per-day file only starts 2026-11-10), splitting the token
     classes and the model dimension by the proportions the session itself reports;
  4. writes the result into Verta's archive as its `seeded` half - kept apart from the half reads write,
     because a read recounts a cell and a seed contributes to it, and the two are added together.

Two approximations, both deliberate:
  - the day of a session is spread, not observed (see above) - the totals are exact, the daily shape is
    not;
  - Token Monitor records providers per session, not per model, so each model's cell carries the
    session's largest provider. The window never draws a provider, so this only affects how cells merge.

Usage:
  python scripts/dev/import-token-monitor-archive.py --dry-run
  python scripts/dev/import-token-monitor-archive.py
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
import tempfile

DAY_MS = 86_400_000

# The token classes, in the order the archive stores them.
CLASSES = ("input", "output", "reasoning", "cacheRead", "cacheWrite", "unsplit")


def day_of(at_ms: int, offset_minutes: int) -> int:
    """The day index, counted the way `usage::day_of` counts it (days since 1970-01-01, floored)."""
    return (at_ms + offset_minutes * 60_000) // DAY_MS


def parse_ms(text: str | None) -> int | None:
    if not text:
        return None
    try:
        stamp = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=datetime.timezone.utc)
    return int(stamp.timestamp() * 1000)


def parse_day_hint(entry: dict) -> int | None:
    """The day an entry was last seen, for the sessions that carry no first/last use.

    Token Monitor stamps every session it archives with the `day` (and `month`) it was captured on; an old
    entry can have totals and no use times at all, and dropping those silently lost ~0.3e9 tokens on the
    first run of this script.
    """
    local = datetime.datetime.now().astimezone().tzinfo
    for key, text in (("day", entry.get("day")), ("month", entry.get("month"))):
        if not text:
            continue
        try:
            stamp = datetime.datetime.fromisoformat(text if key == "day" else f"{text}-01")
        except ValueError:
            continue
        return int(stamp.replace(tzinfo=local).timestamp() * 1000)
    # The keys are often there with a null value and only the capture stamp is filled (`day` and `month`
    # are written by a newer collector than the entries that predate it).
    return parse_ms(entry.get("capturedAt"))


def split_int(total: int, weights: list[int]) -> list[int]:
    """Split `total` over `weights` by largest remainder; the parts always add up to `total`."""
    if total <= 0 or not weights:
        return [0] * len(weights)
    whole = sum(weights)
    if whole <= 0:
        return [total] + [0] * (len(weights) - 1)
    exact = [total * weight / whole for weight in weights]
    parts = [int(value) for value in exact]
    left = total - sum(parts)
    order = sorted(range(len(weights)), key=lambda i: (exact[i] - parts[i], weights[i]), reverse=True)
    for index in order[:left]:
        parts[index] += 1
    return parts


def spread(total: int, days: int) -> list[int]:
    """`total` over `days` days, evenly, with the remainder on the last day."""
    if days <= 1:
        return [total]
    each = total // days
    return [each] * (days - 1) + [total - each * (days - 1)]


def cells_of(parts: dict[str, int]) -> dict[str, int]:
    """The six classes, all present, with `input` absorbing nothing and `unsplit` staying non-negative."""
    return {name: int(parts.get(name) or 0) for name in CLASSES}


def session_cells(entry: dict, offset_minutes: int) -> list[tuple[int, str, str | None, str | None, dict[str, int], int]]:
    """One session -> `(day, tool, provider, model, parts, events)` cells, totals preserved exactly."""
    all_time = ((entry.get("periods") or {}).get("allTime")) or {}
    tool = entry.get("client") or "unknown"
    total = int(all_time.get("totalTokens") or 0)
    if total <= 0:
        return []
    cache_read = int(all_time.get("cacheReadTokens") or 0)
    cache_write = int(all_time.get("cacheWriteTokens") or 0)
    output = int(all_time.get("outputTokens") or 0)
    reasoning = int(all_time.get("reasoningTokens") or 0)
    # Input is what is left: Token Monitor has no input field of its own, and never reports negatives.
    input_tokens = total - cache_read - cache_write - output - reasoning
    unsplit = 0
    if input_tokens < 0:
        unsplit = -input_tokens
        input_tokens = 0

    started = parse_ms(all_time.get("startedAt")) or parse_ms(all_time.get("lastUsedAt"))
    last_used = parse_ms(all_time.get("lastUsedAt")) or started
    if last_used is None:
        # No use times at all: the entry's own capture day is the only date there is.
        last_used = parse_day_hint(entry)
        started = last_used
        if last_used is None:
            return []
    if started is None or started > last_used:
        started = last_used
    first_day, last_day = day_of(started, offset_minutes), day_of(last_used, offset_minutes)
    days = max(1, last_day - first_day + 1)

    models: dict[str, int] = {str(k): int(v or 0) for k, v in (all_time.get("models") or {}).items()}
    models = {name: value for name, value in models.items() if value > 0}
    if not models:
        models = {"": total}
    names = list(models)
    weights = [models[name] for name in names]

    providers: dict[str, int] = {str(k): int(v or 0) for k, v in (all_time.get("providers") or {}).items()}
    provider = max(providers, key=providers.get) if providers else None

    per_day_total = spread(total, days)
    per_day_class = {name: spread(value, days) for name, value in (
        ("cacheRead", cache_read), ("cacheWrite", cache_write), ("output", output),
        ("reasoning", reasoning), ("unsplit", unsplit), ("input", input_tokens),
    )}
    per_day_events = spread(int(all_time.get("messageCount") or 0), days)

    cells = []
    for index in range(days):
        day = first_day + index
        # Both splits are per day and over the whole session's weights: the classes are split across
        # models, and the day's total is split across models separately, so the cells of one day add up
        # to that day's slice and nothing is counted twice.
        part_split = {name: split_int(per_day_class[name][index], weights) for name in CLASSES}
        model_total = split_int(per_day_total[index], weights)
        for model_index, model in enumerate(names):
            parts = {name: part_split[name][model_index] for name in CLASSES}
            # Rounding can leave the classes a few tokens away from the model's share of the day. Put the
            # difference on the class that holds the most: the cell's total is what every view sums, and it
            # has to be the number Token Monitor reported.
            gap = model_total[model_index] - sum(parts.values())
            if gap:
                holder = max(parts, key=parts.get)
                if parts[holder] + gap < 0:
                    parts = {name: 0 for name in CLASSES}
                    parts["unsplit"] = model_total[model_index]
                else:
                    parts[holder] += gap
            cells.append(
                (
                    day,
                    tool,
                    provider,
                    model or None,
                    parts,
                    per_day_events[index] if model_index == 0 else 0,
                )
            )
    return cells


def live_sessions(home: str) -> dict[str, str]:
    """One searchable blob per tool: every session id its store still holds, so the seed can skip them.

    Matched by substring rather than equality because these stores put a session id *inside* a longer path
    segment (`sessions/<project>/2026-09-09T05-47-23-952Z_<sessionId>/<turn>/...`). Comparing whole names
    missed every one of those, which is how the first version of this script seeded 2.2e9 tokens of pi
    usage that was still on disk - the same usage Verta's own scan already counts.
    """
    live: dict[str, str] = {}

    ids: list[str] = []
    db = os.path.join(home, ".local", "share", "opencode", "opencode.db")
    if os.path.exists(db):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            ids = [
                str(row[0])
                for row in con.execute(
                    "select distinct session_id from session_message where session_id is not null"
                )
            ]
            con.close()
        except sqlite3.Error:
            pass
    live["opencode"] = "\n".join(ids).lower()

    # These stores name the session in the path, so the paths are the index.
    roots = {
        "claude": [os.path.join(home, ".claude", "projects"), os.path.join(home, ".claude", "transcripts")],
        "pi": [os.path.join(home, ".pi", "agent", "sessions")],
        "dsh": [os.environ.get("DSH_HOME") or os.path.join(home, ".dsh")],
        "workbuddy": [os.path.join(home, ".workbuddy", "projects"), os.path.join(home, ".workbuddy-ai", "projects")],
    }
    for tool, paths in roots.items():
        names: list[str] = []
        for root in paths:
            for dirpath, _dirs, files in os.walk(root):
                names.append(dirpath)
                names.extend(os.path.join(dirpath, name) for name in files)
        live[tool] = "\n".join(names).lower()
    return live


def seed_section(cells) -> dict[str, list]:
    """The import as the archive's `seeded` half: one entry per day, same-key cells summed.

    Summed, not maxed: two seeded cells of the same day, tool and model are two sessions' worth of usage.
    The section is rebuilt on every run, so importing twice writes the same numbers instead of doubling.
    """
    days: dict[str, list] = {}
    for day, tool, provider, model, parts, events in cells:
        bucket = days.setdefault(str(day), [])
        held = next(
            (
                cell
                for cell in bucket
                if cell["tool"] == tool
                and cell["provider"] == provider
                and cell["model"] == model
            ),
            None,
        )
        if held is None:
            bucket.append(
                {"tool": tool, "provider": provider, "model": model, "parts": parts, "events": events}
            )
        else:
            held["parts"] = {name: int(held["parts"].get(name) or 0) + int(parts.get(name) or 0) for name in CLASSES}
            held["events"] = int(held.get("events") or 0) + events
    return days


def cells_total(days: dict) -> int:
    return sum(
        sum(int(value or 0) for value in (cell.get("parts") or {}).values())
        for cells in (days or {}).values()
        for cell in cells
    )


def archive_total(archive: dict) -> int:
    return cells_total(archive.get("days") or {}) + cells_total(archive.get("seeded") or {})


def write_archive(path: str, archive: dict) -> None:
    """Write it the way the Rust side does: a temporary file beside it, then a rename."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="verta-usage-archive-", suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as out:
        json.dump(archive, out, ensure_ascii=False, separators=(",", ":"))
    os.replace(temp, path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report what would be written and write nothing")
    local_offset = int(datetime.datetime.now().astimezone().utcoffset().total_seconds() // 60)
    parser.add_argument("--offset-minutes", type=int, default=local_offset,
                        help="the day boundary the window reads with (default: this machine's offset)")
    parser.add_argument("--token-monitor", default=os.path.join(os.environ.get("APPDATA", ""), "Token Monitor"))
    parser.add_argument("--archive", default=os.path.join(os.environ.get("APPDATA", ""), "app.verta", "verta-usage-archive.json"))
    args = parser.parse_args()

    source = os.path.join(args.token_monitor, "session-usage-archive.sqlite")
    if not os.path.exists(source):
        print(f"no Token Monitor archive at {source}", file=sys.stderr)
        return 1

    home = os.path.expanduser("~")
    live = live_sessions(home)

    con = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    rows = con.execute("select session_key, entry_json from sessions").fetchall()
    con.close()

    seeds = []
    skipped_live = 0
    per_tool: dict[str, list[int]] = {}
    for key, entry_json in rows:
        entry = json.loads(entry_json)
        tool = entry.get("client") or key.split(":")[0]
        session_id = str(entry.get("sessionId") or key.split(":", 1)[-1]).lower()
        if session_id in live.get(tool, ""):
            skipped_live += 1
            continue
        cells = session_cells(entry, args.offset_minutes)
        if not cells:
            continue
        tokens = sum(sum(parts.values()) for _day, _tool, _provider, _model, parts, _events in cells)
        bucket = per_tool.setdefault(tool, [0, 0])
        bucket[0] += 1
        bucket[1] += tokens
        seeds.extend(cells)

    seeded = sum(sum(parts.values()) for _day, _tool, _provider, _model, parts, _events in seeds)
    print(f"Token Monitor archive: {len(rows)} sessions")
    print(f"  still readable, left alone: {skipped_live}")
    print(f"  seeded: {len(rows) - skipped_live} sessions / {seeded:,} tokens")
    for tool, (count, tokens) in sorted(per_tool.items(), key=lambda item: -item[1][1]):
        print(f"    {tool:<10} {count:>5} sessions  {tokens:>15,} tokens")

    archive = {"version": 1, "offsetMinutes": args.offset_minutes, "days": {}, "seeded": {}}
    if os.path.exists(args.archive):
        with open(args.archive, encoding="utf-8") as existing:
            archive = json.load(existing)
        archive.setdefault("days", {})
        archive["offsetMinutes"] = args.offset_minutes
    before = archive_total(archive)
    archive["seeded"] = seed_section(seeds)
    after = archive_total(archive)
    seeded_cells = sum(len(cells) for cells in archive["seeded"].values())
    print(
        f"archive: {before:,} -> {after:,} tokens ({after - before:+,}); "
        f"the seeded half is {cells_total(archive['seeded']):,} tokens in {seeded_cells} cells"
    )

    if args.dry_run:
        print("dry run: nothing written")
        return 0
    write_archive(args.archive, archive)
    print(f"written: {args.archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
