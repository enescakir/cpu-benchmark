#!/usr/bin/env ruby
# frozen_string_literal: true

# Turn one workflow run's benchmark jobs into stored rows.
#
# Usage:
#   store.rb collect --results DIR --out rows.json
#       Reads every benchmark job of the current run attempt from the GitHub
#       API (queue time = started_at - created_at) and joins it with the
#       result file that job uploaded, if any. A job that never got a runner
#       still becomes a row, with no scores.
#   store.rb append rows.json --data DIR
#       Appends rows to DIR/runs/YYYY-MM.jsonl (skipping ones already stored)
#       and rewrites DIR/index.json, the list of months the site loads.
#
# Environment for collect: GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY,
# GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_API_URL.
#
# Standard library only: runner images ship Ruby 3.2.

require "fileutils"
require "json"
require "net/http"
require "optparse"
require "set"
require "time"
require "uri"

# Benchmark jobs are named "bench (<runner label>)" in cpu-benchmark.yml.
JOB_NAME = /\Abench \((?<label>[^)]+)\)\z/

def api(path)
  uri = URI("#{ENV.fetch("GITHUB_API_URL", "https://api.github.com")}#{path}")
  req = Net::HTTP::Get.new(uri)
  req["Authorization"] = "Bearer #{ENV.fetch("GITHUB_TOKEN")}"
  req["Accept"] = "application/vnd.github+json"
  req["X-GitHub-Api-Version"] = "2022-11-28"
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 30, read_timeout: 30) do |http|
    http.request(req)
  end
  raise "GET #{path}: HTTP #{res.code} #{res.body.to_s[0, 200]}" unless res.is_a?(Net::HTTPSuccess)

  JSON.parse(res.body)
end

def run_jobs(repo, run_id, attempt)
  jobs = []
  page = 1
  loop do
    data = api("/repos/#{repo}/actions/runs/#{run_id}/attempts/#{attempt}/jobs?per_page=100&page=#{page}")
    jobs.concat(data["jobs"])
    return jobs if jobs.size >= data["total_count"] || data["jobs"].empty?

    page += 1
  end
end

def seconds(start, finish)
  return nil unless start && finish

  [(Time.iso8601(finish) - Time.iso8601(start)).round, 0].max
end

def blank?(value)
  value.nil? || value.to_s.empty?
end

# {label => result} from the artifacts (results/<artifact>/<label>.json).
def load_results(dir)
  Dir.glob(File.join(dir, "**", "*.json")).sort.each_with_object({}) do |path, out|
    data = JSON.parse(File.read(path))
    out[data["label"] || File.basename(path, ".json")] = data
  rescue JSON::ParserError, SystemCallError => e
    puts "::warning::skipping #{path}: #{e.message}"
  end
end

def collect(results_dir, out)
  repo = ENV.fetch("GITHUB_REPOSITORY")
  run_id = Integer(ENV.fetch("GITHUB_RUN_ID"))
  attempt = Integer(ENV.fetch("GITHUB_RUN_ATTEMPT", "1"))
  results = load_results(results_dir)

  rows = run_jobs(repo, run_id, attempt).filter_map do |job|
    m = JOB_NAME.match(job["name"]) or next
    label = m[:label]
    result = results.delete(label) || {}
    # A job cancelled before any runner picked it up has no runner_name;
    # its started_at is the cancellation time, not a start.
    started = blank?(job["runner_name"]) ? nil : job["started_at"]
    row = {
      "created_at" => job["created_at"],
      "started_at" => started,
      "completed_at" => job["completed_at"],
      "queue_seconds" => seconds(job["created_at"], started),
      "label" => label,
      "conclusion" => job["conclusion"] || job["status"],
      "run_id" => run_id,
      "run_attempt" => attempt,
      "job_id" => job["id"],
      "url" => job["html_url"],
      "runner_name" => blank?(job["runner_name"]) ? result["runner_name"] : job["runner_name"]
    }
    result.each { |k, v| row[k] = v unless row.key?(k) }
    row
  end

  results.each_key { |label| puts "::warning::result for #{label} has no matching job in this run attempt" }
  File.write(out, "#{JSON.pretty_generate(rows)}\n")
  rows.each do |row|
    queue = row["queue_seconds"].nil? ? "-" : "#{row["queue_seconds"]}s"
    puts format("%-28s queue=%s cpu_mark=%s single=%s cpu=%p %s",
      row["label"], queue, row["cpu_mark"].inspect, row["single_thread"].inspect, row["cpu_model"], row["conclusion"])
  end
  0
end

def row_key(row)
  [row["run_id"], row["run_attempt"], row["label"]]
end

def append(rows_file, data_dir)
  rows = JSON.parse(File.read(rows_file))
  runs = File.join(data_dir, "runs")
  FileUtils.mkdir_p(runs)
  added = 0
  rows.map { |r| r["created_at"][0, 7] }.uniq.sort.each do |month|
    path = File.join(runs, "#{month}.jsonl")
    seen = Set.new
    File.foreach(path) { |line| seen << row_key(JSON.parse(line)) unless line.strip.empty? } if File.exist?(path)
    fresh = rows.select { |r| r["created_at"][0, 7] == month && !seen.include?(row_key(r)) }
    next if fresh.empty?

    File.open(path, "a") do |f|
      fresh.sort_by { |r| [r["created_at"], r["label"]] }.each { |r| f.puts(JSON.generate(r)) }
    end
    added += fresh.size
  end

  months = Dir.glob(File.join(runs, "*.jsonl")).map { |p| File.basename(p, ".jsonl") }.sort
  index_path = File.join(data_dir, "index.json")
  if added.positive? || !File.exist?(index_path)
    index = {"updated_at" => Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ"), "months" => months}
    File.write(index_path, "#{JSON.pretty_generate(index)}\n")
  end
  puts "added #{added} row(s); #{months.size} month file(s)"
  0
end

def main(argv)
  cmd = argv.shift
  opts = {}
  parser = OptionParser.new do |o|
    o.banner = "Usage: store.rb collect --results DIR --out rows.json\n       store.rb append rows.json --data DIR"
    o.on("--results DIR", "downloaded result artifacts") { |v| opts[:results] = v }
    o.on("--out FILE", "rows JSON to write") { |v| opts[:out] = v }
    o.on("--data DIR", "data branch checkout") { |v| opts[:data] = v }
  end
  parser.parse!(argv)
  case cmd
  when "collect"
    abort parser.help unless opts[:results] && opts[:out]
    collect(opts[:results], opts[:out])
  when "append"
    abort parser.help unless argv.size == 1 && opts[:data]
    append(argv.first, opts[:data])
  else
    abort parser.help
  end
end

if $PROGRAM_NAME == __FILE__
  $stdout.sync = true
  exit main(ARGV.dup)
end
