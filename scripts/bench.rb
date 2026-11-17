#!/usr/bin/env ruby
# frozen_string_literal: true

# CPU and network benchmark for the runner this job landed on.
#
# Usage:
#   bench.rb system   --out result.json
#   bench.rb network  --out result.json
#   bench.rb passmark --out result.json --binary /tmp/passmark/pt_linux [--raw DIR]
#
# Each subcommand merges its fields into the result file, so a failed PassMark
# run still leaves the machine's CPU model behind. Job queue time is not
# measured here: the publish job reads it from the GitHub API once every
# benchmark job has finished (see store.rb).
#
# Standard library only: runner images ship Ruby 3.2.

require "etc"
require "fileutils"
require "json"
require "open3"
require "optparse"
require "tmpdir"

# CPU suite only (-r 1), two iterations (-i 2), one process per vCPU (-p),
# medium test duration (-d 2).
PASSMARK_ARGS = %w[-r 1 -i 2 -d 2].freeze
PASSMARK_TIMEOUT = 20 * 60

# Every download fetches this many bytes, so the targets compare. Cloudflare's
# speed test endpoint refuses 100 MB or more.
DOWNLOAD_BYTES = 64 * 1024 * 1024
DOWNLOAD_TIMEOUT = 60
DOWNLOADS = {
  # A pinned Actions runner release tarball (217 MiB; a Range request takes the
  # first 64 MiB). Release assets, checkout and ghcr.io pulls are all served
  # from GitHub's own network.
  "github" => "https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-x64-2.338.2.tar.gz",
  # Cloudflare's speed test endpoint, from the nearest edge. Docker Hub and many
  # package registries sit behind Cloudflare. It ignores Range and sends `bytes`.
  "cloudflare" => "https://speed.cloudflare.com/__down?bytes=#{DOWNLOAD_BYTES}"
}.freeze

def nproc
  Etc.nprocessors
end

def read_file(path)
  File.read(path)
rescue SystemCallError
  nil
end

def monotonic
  Process.clock_gettime(Process::CLOCK_MONOTONIC)
end

# ── system ───────────────────────────────────────────────────────────────

def lscpu
  out, status = Open3.capture2({"LC_ALL" => "C"}, "lscpu")
  return {} unless status.success?

  out.each_line.with_object({}) do |line, info|
    key, sep, value = line.partition(":")
    # Hybrid ARM parts list one "Model name" per cluster: keep the first.
    info[key.strip] ||= value.strip unless sep.empty?
  end
rescue SystemCallError
  {}
end

def cpuinfo_model
  read_file("/proc/cpuinfo")&.[](/^model name\s*:\s*(.+)$/, 1)&.strip
end

def memory_mib
  kb = read_file("/proc/meminfo")&.[](/^MemTotal:\s+(\d+) kB/, 1)
  kb && kb.to_i / 1024
end

def os_name
  read_file("/etc/os-release")&.[](/^PRETTY_NAME="?([^"\n]+)"?/, 1)
end

def group_system
  cpu = lscpu
  model = cpu["Model name"]
  model = cpuinfo_model if model.nil? || model.empty? || model == "-"
  threads = cpu["Thread(s) per core"]
  {
    "label" => ENV["BENCH_LABEL"],
    "runner_name" => ENV["RUNNER_NAME"],
    "image_version" => ENV["ImageVersion"],
    "arch" => Etc.uname[:machine],
    "cpu_model" => model,
    "cpu_vendor" => cpu["Vendor ID"],
    "cpus" => nproc,
    "threads_per_core" => threads&.match?(/\A\d+\z/) ? threads.to_i : nil,
    "hypervisor" => cpu["Hypervisor vendor"],
    "memory_mib" => memory_mib,
    "os" => os_name,
    "kernel" => Etc.uname[:release]
  }
end

# ── network ──────────────────────────────────────────────────────────────

# Download url once with curl and report how fast the body arrived.
#
# mbps counts only the body transfer, from the first byte to the last, so it
# measures bandwidth. Everything before the first byte (DNS, TCP, TLS,
# redirects, server think time) is ttfb_ms.
def download(url)
  out, err, = Open3.capture3("curl", "--silent", "--show-error", "--location", "--fail",
    "--range", "0-#{DOWNLOAD_BYTES - 1}", "--connect-timeout", "15", "--max-time", DOWNLOAD_TIMEOUT.to_s,
    "--output", "/dev/null", "--write-out", "%{json}", url)
  info = begin
    JSON.parse(out)
  rescue JSON::ParserError
    {"exitcode" => -1, "errormsg" => err.strip.empty? ? "curl wrote no timing data" : err.strip}
  end

  bytes = info["size_download"].to_i
  first_byte = info["time_starttransfer"].to_f
  body_seconds = info["time_total"].to_f - first_byte
  code = info["exitcode"].to_i
  # A timeout (28) still measured a rate, just a slow one; other failures did not.
  rate = (code.zero? || code == 28) && bytes.positive? && body_seconds.positive?
  # curl reports 0 / "0" / "" for what it never got to (no DNS, no connection).
  {
    "url" => url,
    "http_code" => info["http_code"].to_i.nonzero?,
    "http_version" => (info["http_version"] unless ["0", ""].include?(info["http_version"].to_s)),
    "remote_ip" => (info["remote_ip"] unless info["remote_ip"].to_s.empty?),
    "bytes" => bytes,
    "seconds" => info["time_total"]&.round(3),
    "ttfb_ms" => first_byte.positive? ? (first_byte * 1000).round : nil,
    "mbps" => rate ? (bytes * 8 / body_seconds / 1e6).round(1) : nil,
    "error" => code.zero? ? nil : "curl exit #{code}: #{info["errormsg"]}"
  }.compact
rescue SystemCallError => e
  {"url" => url, "error" => e.message}
end

# A failed download is recorded, not raised, so the CPU benchmark still runs.
def group_network
  results = DOWNLOADS.to_h do |name, url|
    puts "+ curl #{url}"
    result = download(url)
    puts "::warning::#{name} download failed: #{result["error"]}" if result["error"]
    puts format("  %s: %s Mbit/s, first byte after %s ms, %d bytes",
      name, result["mbps"] || "-", result["ttfb_ms"] || "-", result["bytes"].to_i)
    [name, result]
  end
  results.to_h { |name, r| ["#{name}_mbps", r["mbps"]] }.merge("network" => results)
end

# ── passmark ─────────────────────────────────────────────────────────────

# Split PassMark's results_cpu.yml into {section => {key => value}}.
#
# Only the top two levels matter (Version, Results, SystemInformation), so
# this avoids depending on the YAML parser's handling of PassMark's quirks.
def parse_results(text)
  sections = {}
  current = nil
  text.each_line do |line|
    line = line.chomp
    stripped = line.strip
    next if stripped.empty? || stripped.start_with?("#")

    key, sep, value = stripped.partition(":")
    next if sep.empty?

    indent = line[/\A */].length
    if indent.zero?
      current = (sections[key.strip] ||= {})
    elsif indent == 2 && current
      # Quoted values can carry padding inside the quotes (Processor).
      current[key.strip] = value.strip.delete_prefix('"').delete_suffix('"').strip
    end
  end
  sections
end

def number(value)
  Float(value)
rescue ArgumentError, TypeError
  nil
end

def summarize(sections)
  version = sections.fetch("Version", {})
  results = sections.fetch("Results", {})
  system = sections.fetch("SystemInformation", {})
  tests = {}
  results.each do |key, value|
    next unless key.start_with?("CPU_", "m_CPU_") || key == "SUMM_CPU"

    v = number(value)
    tests[key] = v.abs < 1e6 ? v.round(1) : v.round if v
  end
  ver = %w[Major Minor Build].map { |k| version[k] }.reject { |v| v.nil? || v.empty? }.join(".")
  processes = number(results["NumTestProcesses"])&.to_i
  processor = system["Processor"]
  {
    "passmark_version" => ver.empty? ? nil : ver,
    "passmark_complete" => results["Results Complete"] == "true",
    "passmark_processes" => processes&.positive? ? processes : nil,
    "passmark_processor" => processor.nil? || processor.empty? ? nil : processor,
    "cpu_mark" => tests["SUMM_CPU"],
    "single_thread" => tests["CPU_SINGLETHREAD"],
    "passmark" => tests
  }
end

def group_passmark(binary, raw_dir)
  binary = File.expand_path(binary)
  raise "PassMark binary not found at #{binary}" unless File.exist?(binary)

  workdir = Dir.mktmpdir("passmark-")
  log = File.join(workdir, "passmark.log")
  cmd = [binary, *PASSMARK_ARGS, "-p", nproc.to_s].join(" ")
  puts "+ #{cmd}"
  started = monotonic
  # pt_linux is an ncurses program and needs a terminal: script(1) gives it
  # a pty. Its screen output is escape-code noise, so it goes to a file.
  pid = Process.spawn({"TERM" => "xterm"}, "script", "-q", "-c", cmd, "/dev/null",
    chdir: workdir, out: log, err: [:child, :out], pgroup: true)
  status = nil
  until (status = Process.wait2(pid, Process::WNOHANG)&.last)
    if monotonic - started > PASSMARK_TIMEOUT
      Process.kill("KILL", -pid)
      Process.wait(pid)
      raise "PassMark timed out after #{PASSMARK_TIMEOUT}s"
    end
    sleep 1
  end
  elapsed = (monotonic - started).round(1)

  results = File.join(workdir, "results_cpu.yml")
  if raw_dir
    FileUtils.mkdir_p(raw_dir)
    [results, log].each { |f| FileUtils.cp(f, raw_dir) if File.exist?(f) }
  end
  raise "PassMark (#{status}) did not write results_cpu.yml" unless File.exist?(results)

  text = File.read(results).scrub
  puts text
  summary = summarize(parse_results(text))
  summary["passmark_seconds"] = elapsed
  raise "PassMark results are incomplete (no SUMM_CPU)" if !summary["passmark_complete"] || summary["cpu_mark"].nil?

  summary
end

# ── main ─────────────────────────────────────────────────────────────────

def main(argv)
  group = argv.shift
  opts = {binary: "/tmp/passmark/pt_linux"}
  parser = OptionParser.new do |o|
    o.banner = "Usage: bench.rb {system|network|passmark} --out FILE [--binary PATH] [--raw DIR]"
    o.on("--out FILE", "result JSON to merge fields into") { |v| opts[:out] = v }
    o.on("--binary PATH", "PassMark pt_linux binary") { |v| opts[:binary] = v }
    o.on("--raw DIR", "directory to copy results_cpu.yml and the PassMark log into") { |v| opts[:raw] = v }
  end
  parser.parse!(argv)
  abort parser.help unless %w[system network passmark].include?(group) && opts[:out]

  path = opts[:out]
  result = File.exist?(path) ? JSON.parse(File.read(path)) : {}
  status = 0
  begin
    case group
    when "system"
      result.merge!(group_system)
    when "network"
      result.merge!(group_network)
    else
      result.delete("error")
      result.merge!(group_passmark(opts[:binary], opts[:raw]))
    end
  rescue => e # keep whatever was already collected
    puts "::error::#{group} failed: #{e.message}"
    result["error"] = "#{group}: #{e.message}"[0, 500]
    status = 1
  end
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, "#{JSON.pretty_generate(result)}\n")
  puts JSON.pretty_generate(result.reject { |k, _| %w[passmark network].include?(k) })
  status
end

if $PROGRAM_NAME == __FILE__
  $stdout.sync = true
  exit main(ARGV.dup)
end
