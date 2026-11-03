/**
 * Security gates run by the orchestrator before every QA review.
 *
 * - gitleaks: secrets in what the build changed (commits since the base, plus
 *   uncommitted and untracked files).
 * - OSV-Scanner: known vulnerabilities newly introduced in changed lockfiles
 *   (compared with the same lockfile at the base, so pre-existing issues don't
 *   block the task).
 *
 * Findings are hard gates: QA cannot approve while any remain. Results are
 * written to <spec>/security_gates.json and security_gates.md for the QA agents
 * and the task workspace. A missing scanner skips its gate (and says so); it
 * never fails the build.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type GateName = "gitleaks" | "osv-scanner";

export interface GateFinding {
  gate: GateName;
  /** Stable key used to compare iterations */
  key: string;
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}

export interface GateReport {
  ran: GateName[];
  skipped: { gate: GateName; reason: string }[];
  findings: GateFinding[];
  baseRef?: string;
}

export interface GateOptions {
  projectDir: string;
  specDir: string;
  gitleaksBin?: string;
  osvScannerBin?: string;
  /** Base to diff against; resolved from the default branch when omitted */
  baseRef?: string;
  timeoutMs?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : -1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const git = (args: string[], cwd: string) => run("git", args, cwd, 30_000);

/** Lockfiles OSV-Scanner understands, by file name. */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "requirements.txt",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "Cargo.lock",
  "go.mod",
  "Gemfile.lock",
  "composer.lock",
  "pubspec.lock",
  "mix.lock",
  "gradle.lockfile",
  "packages.lock.json",
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

/** Merge-base of HEAD with the repository's default branch, if any. */
export async function resolveBaseRef(cwd: string): Promise<string | undefined> {
  const candidates: string[] = [];
  const originHead = await git(
    ["rev-parse", "--abbrev-ref", "origin/HEAD"],
    cwd,
  );
  if (originHead.code === 0 && originHead.stdout.trim())
    candidates.push(originHead.stdout.trim());
  candidates.push("main", "master", "origin/main", "origin/master");
  for (const ref of candidates) {
    const base = await git(["merge-base", "HEAD", ref], cwd);
    if (base.code === 0 && base.stdout.trim()) return base.stdout.trim();
  }
  return undefined;
}

/** Files changed relative to the base: committed, uncommitted and untracked. */
export async function changedFiles(
  cwd: string,
  baseRef?: string,
): Promise<string[]> {
  const files = new Set<string>();
  const diff = await git(
    ["diff", "--name-only", "--diff-filter=ACMR", baseRef ?? "HEAD"],
    cwd,
  );
  if (diff.code === 0)
    for (const f of diff.stdout.split("\n")) if (f.trim()) files.add(f.trim());
  const untracked = await git(
    ["ls-files", "--others", "--exclude-standard"],
    cwd,
  );
  if (untracked.code === 0)
    for (const f of untracked.stdout.split("\n"))
      if (f.trim()) files.add(f.trim());
  return [...files];
}

// ---------------------------------------------------------------------------
// gitleaks
// ---------------------------------------------------------------------------

interface GitleaksLeak {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  Commit?: string;
}

export function parseGitleaks(json: string, root?: string): GateFinding[] {
  let leaks: GitleaksLeak[];
  try {
    const parsed = JSON.parse(json || "[]");
    leaks = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  return leaks.map((leak) => {
    const file =
      root && leak.File?.startsWith(root + "/")
        ? leak.File.slice(root.length + 1)
        : leak.File;
    return {
      gate: "gitleaks" as const,
      key: `gitleaks:${leak.RuleID ?? "secret"}:${file ?? ""}:${leak.StartLine ?? 0}`,
      title: `Secret detected: ${leak.Description || leak.RuleID || "credential"}`,
      file,
      line: leak.StartLine,
      detail: leak.Commit
        ? `in commit ${leak.Commit.slice(0, 10)}`
        : "in the working tree",
    };
  });
}

async function runGitleaks(
  bin: string,
  cwd: string,
  baseRef: string | undefined,
  files: string[],
): Promise<GateFinding[]> {
  const work = mkdtempSync(join(tmpdir(), "vtl-gitleaks-"));
  try {
    const findings: GateFinding[] = [];
    const common = [
      "--no-banner",
      "--redact",
      "--exit-code",
      "0",
      "--report-format",
      "json",
    ];

    // Committed history since the base (catches a secret added then deleted).
    if (baseRef) {
      const report = join(work, "git.json");
      await run(
        bin,
        [
          "git",
          ...common,
          "--report-path",
          report,
          "--log-opts",
          `${baseRef}..HEAD`,
          ".",
        ],
        cwd,
      );
      if (existsSync(report))
        findings.push(...parseGitleaks(await readText(report)));
    }

    // Current content of every changed file.
    for (const file of files) {
      const abs = join(cwd, file);
      if (!existsSync(abs)) continue;
      const report = join(work, "dir.json");
      await run(bin, ["dir", ...common, "--report-path", report, abs], cwd);
      if (existsSync(report)) {
        findings.push(...parseGitleaks(await readText(report), cwd));
        rmSync(report, { force: true });
      }
    }
    return dedupe(findings);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// OSV-Scanner
// ---------------------------------------------------------------------------

interface OsvOutput {
  results?: {
    source?: { path?: string };
    packages?: {
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: { id?: string; summary?: string; aliases?: string[] }[];
      groups?: { ids?: string[]; max_severity?: string }[];
    }[];
  }[];
}

export function parseOsv(json: string, file?: string): GateFinding[] {
  let out: OsvOutput;
  try {
    out = JSON.parse(json || "{}");
  } catch {
    return [];
  }
  const findings: GateFinding[] = [];
  for (const result of out.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const name = pkg.package?.name ?? "unknown";
      const version = pkg.package?.version ?? "";
      // One finding per vulnerability group (aliases of the same advisory).
      const groups = pkg.groups?.length
        ? pkg.groups
        : (pkg.vulnerabilities ?? []).map((v) => ({
            ids: [v.id ?? ""],
            max_severity: undefined,
          }));
      for (const group of groups) {
        const ids = (group.ids ?? []).filter(Boolean);
        if (!ids.length) continue;
        const primary = ids[0];
        const vuln = pkg.vulnerabilities?.find((v) => v.id === primary);
        const severity = group.max_severity
          ? ` (CVSS ${group.max_severity})`
          : "";
        findings.push({
          gate: "osv-scanner",
          key: `osv:${name}@${version}:${primary}`,
          title: `Vulnerable dependency: ${name}@${version} — ${primary}${severity}`,
          file: file ?? result.source?.path,
          detail: vuln?.summary,
        });
      }
    }
  }
  return dedupe(findings);
}

async function scanLockfile(
  bin: string,
  path: string,
  cwd: string,
): Promise<GateFinding[]> {
  const res = await run(
    bin,
    ["scan", "source", "--format", "json", "--lockfile", path],
    cwd,
  );
  return parseOsv(res.stdout);
}

async function runOsv(
  bin: string,
  cwd: string,
  baseRef: string | undefined,
  files: string[],
): Promise<GateFinding[]> {
  const findings: GateFinding[] = [];
  for (const file of files.filter(isLockfile)) {
    const current = (await scanLockfile(bin, join(cwd, file), cwd)).map(
      (f) => ({ ...f, file }),
    );
    if (!current.length) continue;

    // Only vulnerabilities this build introduced: subtract the base lockfile's.
    let baseKeys = new Set<string>();
    if (baseRef) {
      const old = await git(["show", `${baseRef}:${file}`], cwd);
      if (old.code === 0) {
        const dir = mkdtempSync(join(tmpdir(), "vtl-osv-"));
        try {
          const copy = join(dir, basename(file));
          writeFileSync(copy, old.stdout);
          baseKeys = new Set(
            (await scanLockfile(bin, copy, cwd)).map((f) => f.key),
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    findings.push(...current.filter((f) => !baseKeys.has(f.key)));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function dedupe(findings: GateFinding[]): GateFinding[] {
  const seen = new Map<string, GateFinding>();
  for (const f of findings) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()];
}

function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

export function formatGateReport(report: GateReport): string {
  const lines = ["# Security gates", ""];
  lines.push(
    report.findings.length
      ? `**Status: BLOCKED** — ${report.findings.length} finding(s) must be fixed before QA can approve.`
      : "**Status: CLEAR**",
  );
  lines.push("");
  lines.push(`Ran: ${report.ran.length ? report.ran.join(", ") : "none"}`);
  for (const s of report.skipped) lines.push(`Skipped ${s.gate}: ${s.reason}`);
  if (report.findings.length) {
    lines.push("", "## Findings", "");
    for (const f of report.findings) {
      const where = f.file
        ? ` — \`${f.file}${f.line ? `:${f.line}` : ""}\``
        : "";
      lines.push(
        `- [${f.gate}] ${f.title}${where}${f.detail ? `. ${f.detail}` : ""}`,
      );
    }
    lines.push(
      "",
      "## How to fix",
      "",
      "- Secrets: remove the value from code and history, load it from configuration or the environment, and treat it as leaked (tell the user to rotate it).",
      "- Vulnerable dependencies: upgrade to a fixed version, or pick a different package. Re-run the tests after changing dependencies.",
    );
  }
  return lines.join("\n") + "\n";
}

export async function runSecurityGates(
  options: GateOptions,
): Promise<GateReport> {
  const { projectDir, specDir } = options;
  const report: GateReport = { ran: [], skipped: [], findings: [] };

  const inRepo =
    (await git(["rev-parse", "--is-inside-work-tree"], projectDir)).code === 0;
  if (!inRepo) {
    report.skipped.push(
      { gate: "gitleaks", reason: "not a git repository" },
      { gate: "osv-scanner", reason: "not a git repository" },
    );
  } else {
    const baseRef = options.baseRef ?? (await resolveBaseRef(projectDir));
    report.baseRef = baseRef;
    const files = await changedFiles(projectDir, baseRef);

    if (options.gitleaksBin) {
      report.ran.push("gitleaks");
      report.findings.push(
        ...(await runGitleaks(options.gitleaksBin, projectDir, baseRef, files)),
      );
    } else {
      report.skipped.push({
        gate: "gitleaks",
        reason: "gitleaks is not available",
      });
    }

    if (!options.osvScannerBin) {
      report.skipped.push({
        gate: "osv-scanner",
        reason: "OSV-Scanner is not available",
      });
    } else if (!files.some(isLockfile)) {
      report.skipped.push({
        gate: "osv-scanner",
        reason: "no dependency lockfiles changed",
      });
    } else {
      report.ran.push("osv-scanner");
      report.findings.push(
        ...(await runOsv(options.osvScannerBin, projectDir, baseRef, files)),
      );
    }
  }

  try {
    await writeFile(
      join(specDir, "security_gates.json"),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
    await writeFile(
      join(specDir, "security_gates.md"),
      formatGateReport(report),
      "utf-8",
    );
  } catch {
    // Non-fatal: the gate result is still returned to the orchestrator.
  }
  return report;
}
