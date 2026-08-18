# PRD: Duration Baseline + Drift Layer (feeds into Schedule Trend)

## Status
Not yet started. This document is the starting brief for a Claude Code session — expect it to get interviewed/refined further once building begins. Nothing here should be treated as final if it conflicts with what comes out of that interview.

## What this is
NOT a 5th standalone tool. This is a data/reference layer that feeds into the existing **Schedule Trend** tool, so it should be built inside that repo, not a new one.

## The problem being solved
Schedule Trend currently shows week-to-week movement (or lack of movement) per house/task, but has no reference point for what "normal" looks like per task. Right now, "no movement this week" is ambiguous:
- Sheetrock sitting idle 1.5 weeks = normal
- Rough-In Inspect stuck 3 weeks = a real problem

Without a duration baseline, both look identical in the current data.

## Core goal
A per-task duration reference (min / typical / max), learned from real historical houses — not guessed, not fixed numbers. Feed this into Schedule Trend so slippage flags get judged against actual historical variance instead of a static assumption.

## Requirements (decided so far)

### Duration table
- Built from real historical house data, not estimated top-down
- Captures a range (min/typical/max), not a single number — e.g. a nominal "5 day" task often actually runs 6-7 working days, or compresses if a vendor adds a second worker mid-job
- Starting scope: 5-10 representative houses to build the initial rubric, not the full historical dataset at once

### Drift layer (on top of the duration table)
- Tracks whether actual performance is trending better or worse than the baseline *over recent months* — not just "this week vs. a static number"
- This is a trend-over-time signal, separate from the per-task min/typical/max table itself

### Data source
- Leaning toward **CoConstruct's full project export** (Settings → Account → Other Settings → Download Project Data) as the primary source, over the paper notebook
- Reasoning: the notebook only tracks foundation → paint-ready; CoConstruct's export covers the entire project through completion (tile, countertops, finish schedule, HVAC/plumbing/electrical finish, fireplace, mirrors, hardware, delivery), and likely has real start/finish dates per task already, avoiding ambiguous-date inference
- Notebook caveat if it's used at all: dates next to a stage are START dates, not finish dates — never infer duration directly from them

### Naming mismatch — OPEN QUESTION, not yet resolved
- CoConstruct data uses Chris's own full task names (e.g. "HVAC Rough In")
- The Thursday-meeting weekly PDF (already ingested by Schedule Trend) uses his boss's shorthand (e.g. "MMAC")
- These need to map to the same underlying task for the duration baseline to line up with Schedule Trend's existing data
- Open question to resolve during build: does Schedule Trend already have a name-mapping/normalization layer from solving this for its existing data? If so, reuse it here rather than building a second one. If not, this may need to be solved once, shared by both.

### Build process rule
- No guessing on rubric or timeline assumptions — interview Chris thoroughly on anything uncertain rather than inferring
- Wrong assumptions are the worst-case failure mode here, worse than the extra time spent asking

## Next session prep
- Bring notebook photos
- Pick 5-10 representative real houses to seed the initial rubric (not the whole history at once)

## Explicitly out of scope for now
- Full historical backfill (all houses, all years) — starting scope is 5-10 houses
- A separate standalone tool/repo/frontend — this lives inside Schedule Trend
