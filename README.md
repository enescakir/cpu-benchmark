# Ubicloud runner CPU benchmark

Every hour, [`cpu-benchmark.yml`](.github/workflows/cpu-benchmark.yml) runs the
PassMark PerformanceTest CPU suite on each of these runner labels:

- `ubicloud-standard-2`
- `ubicloud-premium-2`
- `ubicloud-standard-2-arm`

For every job it records:

- **PassMark CPU Mark** (`SUMM_CPU`), **single-thread score** (`CPU_SINGLETHREAD`) and every
  CPU sub-test, from `pt_linux -r 1 -i 2 -d 2 -p $(nproc)`
- **CPU model** from `lscpu`, plus PassMark's own CPUID-based processor name
- **Queue time**: the job's `started_at - created_at` from the GitHub Jobs API

The results are appended to the `data` branch and published with GitHub Pages
as charts.

## How it works

```
bench (matrix, one job per label)          publish (ubuntu-latest)                pages (ubuntu-slim)
  scripts/bench.rb system                    download result artifacts             site/ + data branch
  scripts/install-passmark.sh       ──►      scripts/store.rb collect     ──►      → GitHub Pages
  scripts/bench.rb passmark                    (Jobs API: created/started_at)
  upload result-<label> artifact             scripts/push-data.sh → data branch
```

- Queue time is read in the `publish` job, after every benchmark job has finished.
  A job that never got a runner still becomes a row: it has no scores and a
  `cancelled` conclusion.
- `data` branch layout: `runs/YYYY-MM.jsonl` (one JSON object per job) and
  `index.json` (the list of months). Rows are keyed by `(run_id, run_attempt, label)`,
  so a re-run never adds duplicates. Concurrent pushes retry on top of the latest branch.
- The site in `site/` is plain HTML/JS with no dependencies. It loads only the months
  the selected time range needs. Charts plot one point per label per UTC hour, the
  median of that hour's runs; the runs table lists every run.

## Setup

1. Make sure the Ubicloud GitHub App is installed on this repository so the
   `ubicloud-*` labels get runners.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   (On a private repository this needs a paid GitHub plan. Unless you are on
   Enterprise Cloud with private Pages, the site is public.)
3. Push to `main`. The first push deploys an empty site.
4. Run **Actions → CPU benchmark → Run workflow** once to get the first data
   without waiting for the schedule. Scheduled runs fire at minute 17 of every hour.

To benchmark more labels, add them to the matrix in `cpu-benchmark.yml`. They show up
on the site automatically. To give a new label a fixed chart color, add it to
`KNOWN_LABELS` in `site/app.js`.

## Preview the site locally

```sh
git fetch origin data
mkdir -p /tmp/bench-site/data && cp -R site/. /tmp/bench-site/
git archive origin/data | tar -x -C /tmp/bench-site/data
ruby -run -e httpd /tmp/bench-site -p 8000   # needs: gem install webrick
```
