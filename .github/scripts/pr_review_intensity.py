#!/usr/bin/env python3
"""Decide how hard Claude should review one pull request.

A single fixed review setting is wrong in both directions at once. Reviewing a
two-line README fix with the most expensive model wastes money on every push,
and reviewing `supabase/migrations/0013_*.sql` with the cheapest one is worse
than not reviewing it at all — a green check that looked at nothing is
indistinguishable from a green check that looked hard. So the cost of the
review is chosen from what the pull request actually touches, before any model
starts.

WHAT ACTUALLY VARIES

The review itself is the `code-review` plugin command, and its procedure is
fixed: it launches its own agents and validates its own findings. Intensity
therefore has to come from outside it, and three things out here genuinely
change the outcome:

  1. whether the review runs at all
  2. which models the agents that actually review run on
  3. how long it is allowed to run

The second one is worth being precise about, because the obvious way to do it
does not work. `--model` sets the ORCHESTRATOR, and the orchestrator does no
reviewing — the command names a model per subagent in its own text ("Opus bug
agent", "sonnet agents for CLAUDE.md violations"), so every tier would spawn the
same Opus reviewers however the flag is set. The only channel that reaches them
is the directive appended to the command, which is why the light tier's
directive re-specifies the subagent models rather than the tier table doing it.

That is also the boundary of what a directive can do. The command's procedure is
numbered and explicit, so contradicting it outright ("use eight agents, not
four") is a coin flip. Moving a default it leaves open, or re-specifying a choice
it delegates to the orchestrator, lands. Only the second kind is used here.

Deliberately NOT levers, both tried:

  `--max-turns` — cutting the turn budget does not buy a cheaper review, it buys
  one that stops halfway and reports whatever subset it reached, which reads
  exactly like a clean result. The cost ceiling is the job timeout, which fails
  loudly instead.

  Withholding `--comment` at the cheap tier — it looked like the natural way to
  make a cheap review quieter, and it is wrong twice. The findings land in the
  summary of a green job that nobody opens; and the command's step 1 stops when
  Claude has already commented on the pull request, so a tier that never
  comments never trips that check and re-runs in full on every push forever.
  Every tier that runs now comments.

HOW THE TIER IS CHOSEN

First matching rule wins; there is no score. When someone asks why their pull
request got the tier it got, a precedence list answers in one line ("it touches
supabase/migrations/"), while a points total answers "47, and the threshold was
40" — which explains nothing and invites tuning the thresholds forever.

CI does not lint or collect this file: ci.yml lints `swarmtrace tests` and
pytest's testpaths is `["tests"]`, so nothing under .github/ is reached by
either. `--selftest` is the substitute, and the review workflow runs it on
every pull request before the classifier is allowed to decide anything.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from fnmatch import fnmatchcase

# ---------------------------------------------------------------------------
# The tables to edit when the repository's layout changes.
#
# Patterns match a changed file's path, POSIX-style, relative to the repository
# root. Three shapes, and the difference between the last two matters:
#
#   "dir/"           a directory prefix
#   "*.sql"          a glob; slash-free AND wildcarded, so it also matches the
#                    bare filename and therefore catches a file at any depth
#   "pyproject.toml" a literal path, matched whole and only whole
#
# A literal deliberately does NOT fall back to the filename. It used to, and
# "pyproject.toml" then silently also claimed "frontend-next/pyproject.toml" —
# a different file with different stakes. When a literal really is wanted at any
# depth, write it with a wildcard ("*package-lock.json") and say so.
# ---------------------------------------------------------------------------

# Where a defect is expensive, silent, or reaches past the pull request that
# introduced it. Every entry below has a specific reason to be here, and the
# audit trail for most of them is in AUDIT_REPORT.md.
CRITICAL = (
    # Append-only and applied in order against every tenant's data. RLS and the
    # SECURITY DEFINER ingest RPCs live here (0001, 0007, 0010, 0012).
    "supabase/migrations/",
    "frontend-next/scripts/run-migrations.mjs",
    "frontend-next/scripts/e2e_migrations.py",
    "*.sql",
    # The definition of "green". A change here decides what every later pull
    # request is allowed to get away with, and this repo has the receipt: CI ran
    # 3.12 only while pyproject advertised 3.10, where `import tomllib` aborted
    # collection — so all 421 tests were unrunnable on the advertised floor and
    # the badge stayed green (see the matrix comment in ci.yml).
    ".github/workflows/",
    # The boundary between a request and another tenant's rows.
    "frontend-next/lib/api-auth.ts",
    "frontend-next/lib/supabase.ts",
    "frontend-next/app/api/",
    "frontend-next/proxy.ts",
    "frontend-next/next.config.mjs",
    # Redaction and ingest validation: what stops a trace from carrying a
    # customer's secrets into storage. F1 in the audit was exactly this.
    "swarmtrace/redact.py",
    "frontend-next/lib/redact.ts",
    "frontend-next/lib/validate-ingest.ts",
    "frontend-next/lib/sanitize-mcp-trace.ts",
    # Durable state and the threads that write it. A defect here loses traces
    # that were never anywhere else, and the suite does not catch it: three of
    # this repo's bugs shipped with 196+ tests passing because nothing exercised
    # a real database (the reasoning is spelled out on ci.yml's integration job).
    "swarmtrace/storage.py",
    "swarmtrace/adapters/",
    "swarmtrace/delivery/",
)

# Wrong here breaks the product or the build, but stays inside it.
SENSITIVE = (
    "pyproject.toml",
    "frontend-next/package.json",
    # Executable documentation: tests/test_architecture_boundaries.py enforces
    # the boundaries this file describes, so editing it edits a contract. It is
    # listed here so it outranks the "prose only" rule below.
    "docs/ARCHITECTURE.md",
    "docs/SDK_DASHBOARD_CONTRACT.md",
    "swarmtrace/config.py",
    "swarmtrace/ports.py",
    "swarmtrace/tracer.py",
    "swarmtrace/fov.py",
    "swarmtrace/gateway_config.py",
    "swarmtrace/mcp_gateway.py",
    "swarmtrace/otlp.py",
    # Monkeypatches third-party SDKs at import; blast radius is every user's
    # process, not just ours.
    "swarmtrace/auto_instrument.py",
)

# Written by a tool, read by nobody. Still shown to the reviewer, but not
# counted towards the size of the change: a lockfile refresh is five thousand
# lines and deserves less attention than twelve lines of api-auth.ts.
GENERATED = (
    "*.lock",
    "*package-lock.json",
    "*.snap",
    "dist/",
    "frontend-next/.next/",
    "frontend-next/public/",
    "frontend-next/stitch_swarmtrace_developer_dashboard/",
    "CHANGELOG.md",
    "assets/",
)

# Prose and illustrations. A pull request made only of these gets no model
# review; a person reading it is the review. Note that the two contract
# documents above are checked first and are not covered by this.
PROSE = (
    "*.md",
    "docs/",
    "examples/",
    "LICENSE",
    "*.gitignore",
)

# ---------------------------------------------------------------------------
# Tiers.
# ---------------------------------------------------------------------------

# Model aliases rather than pinned identifiers, so this table keeps selecting the
# current model in each class instead of quietly going stale and spending the
# most expensive tier's budget on last year's model.
#
# `model` is the ORCHESTRATOR only, and saying so matters: the plugin command
# names a model per subagent in its own text ("Opus bug agent", "sonnet agents
# for CLAUDE.md violations"), so --model does not touch the agents that do the
# reviewing. Moving those is the light tier's directive below, which is the only
# channel that reaches them.
#
# Every tier that runs also comments. Withholding --comment at the cheap tier
# was tried and is wrong twice over: findings land in the summary of a green job
# that nobody opens, and the command's "stop if Claude already commented here"
# check never trips, so the cheapest-looking tier is the one that re-runs on
# every push forever.
TIERS = {
    "skip": {"model": "", "timeout_minutes": "5", "comment": "false"},
    "light": {"model": "sonnet", "timeout_minutes": "15", "comment": "true"},
    "standard": {"model": "sonnet", "timeout_minutes": "25", "comment": "true"},
    "deep": {"model": "opus", "timeout_minutes": "40", "comment": "true"},
}

# Appended verbatim to the review command, as a constant chosen by tier.
#
# These are constants and nothing derived from the pull request is interpolated
# into them. On a fork pull request the title, the body, the labels and the file
# paths are all written by whoever opened it; none of that reaches the prompt. It
# reaches the job summary, which is text, not an instruction.
#
# What these can and cannot do: the command's procedure is numbered and explicit,
# so an instruction contradicting it outright ("use eight agents, not four") is a
# coin flip. An instruction that moves a DEFAULT the command leaves open, or that
# re-specifies a choice the command delegates to the orchestrator — such as which
# model each subagent runs on — lands reliably. Only the second kind is here.
DIRECTIVES = {
    "skip": "",
    "light": (
        "This is a small change on a low-risk surface and it is being reviewed "
        "cheaply on purpose. Two adjustments for this review only. Run the two "
        "bug-finding agents in step 4, and their validators in step 5, on Sonnet "
        "rather than Opus: the diff is small enough to hold in one pass and the "
        "extra depth is not worth its cost here. And hold the highest confidence "
        "bar: report only a defect that will certainly misbehave, and prefer "
        "reporting nothing at all over reporting something you are unsure of."
    ),
    "standard": "",
    "deep": (
        "This pull request touches a surface where a defect is expensive, "
        "silent, or reaches past this pull request: schema and migrations, the "
        "CI definition itself, request authorisation, redaction, or durable "
        "storage. Two adjustments, for this review only. First, give the "
        "changed hunks on those surfaces a second independent pass before you "
        "conclude. Second, on those surfaces a data-loss, authorisation, "
        "redaction-bypass or migration-ordering defect is in scope even when "
        "confirming it needs context from outside the diff: go read that "
        "context and settle it, rather than dropping the finding for being "
        "unconfirmable from the diff alone. Everywhere else in this pull "
        "request the usual bar stands."
    ),
}

ORDER = ("skip", "light", "standard", "deep")

# Anyone can overrule the classifier from the pull request itself.
LABEL_TIERS = {
    "review:skip": "skip",
    "review:light": "light",
    "review:standard": "standard",
    "review:deep": "deep",
}

# WHO OPENED IT IS NOT AN INPUT HERE, and that is a decision rather than an
# oversight. The obvious rule — "raise the tier for a fork or a first-time
# contributor" — cannot fire: claude-code-action refuses to run for an actor
# without write access (it throws "Actor does not have write permissions"), and
# a pull request from a fork receives no repository secrets, so the workflow
# gates both away before this file is consulted. Only someone who can push a
# branch here reaches the classifier, and that is precisely the set the rule
# would have exempted.
#
# So the trust question is answered once, in the workflow, where getting it
# wrong shows up as a red X on an outside contribution. A second copy here would
# be a branch that no pull request can take, which is the same thing as a check
# that cannot fail.

# 50 lines is a change that fits on one screen. 400 is roughly where a reader's
# defect-detection rate is known to fall off, which is also where "I read it all
# carefully" stops describing what anyone actually does. Past that the tier does
# keep climbing, to deep: a diff nobody can hold at once is exactly the one worth
# spending the most capable review on, even though that review will not finish
# reading it either. The bulk-edit shapes that used to be the argument for
# capping here — rename sweeps, vendored drops, lockfile refreshes — are handled
# where they belong instead, by the generated-file discount and the zero-line
# rule in classify().
SMALL_LINES, SMALL_FILES = 50, 5
MEDIUM_LINES, MEDIUM_FILES = 400, 25


def matches(path: str, patterns: tuple[str, ...]) -> bool:
    """True when `path` is covered by any of `patterns`. See the note above."""
    name = path.rsplit("/", 1)[-1]
    for pattern in patterns:
        if pattern.endswith("/"):
            if path.startswith(pattern):
                return True
        elif fnmatchcase(path, pattern) or (
            "/" not in pattern
            and ("*" in pattern or "?" in pattern)
            and fnmatchcase(name, pattern)
        ):
            return True
    return False


def classify(pr, files):
    """Return (tier, reason). `files` is a list of (path, added, deleted).

    Read this top to bottom: the first rule that matches is the answer, and the
    reason it returns is the whole explanation.
    """
    labels = {str(name).lower() for name in pr.get("labels", ())}
    for label, tier in LABEL_TIERS.items():
        if label in labels:
            return tier, f"the {label} label is set, which overrules the classifier"

    if pr.get("draft"):
        return "skip", "the pull request is a draft"

    if not files:
        return "skip", "no files changed"

    reviewable = [f for f in files if not matches(f[0], GENERATED)]
    if not reviewable:
        return "skip", "every changed file is generated or vendored"

    # Risk is settled before size, before prose and before who opened it, so
    # that three lines of migration outrank four thousand lines of ordinary
    # code, a document the test suite enforces is not dismissed as prose, and a
    # bot bumping an action version in .github/workflows/ is not waved through
    # by the rule below. That ordering is not a detail: this file calls the CI
    # definition "the definition of green", and the one bot pull request that
    # must be read is the one that edits it.
    critical = [path for path, _, _ in reviewable if matches(path, CRITICAL)]
    if critical:
        first = critical[0]
        return "deep", f"touches {len(critical)} critical path(s), first: {first}"

    sensitive = [path for path, _, _ in reviewable if matches(path, SENSITIVE)]
    if sensitive:
        first = sensitive[0]
        return "standard", f"touches {len(sensitive)} sensitive path(s), first: {first}"

    # Dependency bots open a steady stream of pull requests whose whole diff is
    # a version number and a lockfile. Reviewing every one is a subscription,
    # not a safeguard. Anything of theirs that reached a risky path was already
    # answered above; a label turns the rest back on one at a time.
    if str(pr.get("author_type", "")).lower() == "bot":
        return "skip", "opened by a bot, touching nothing risky"

    substantive = [f for f in reviewable if not matches(f[0], PROSE)]
    if not substantive:
        return "skip", "prose and examples only, and no contract document among them"

    lines = sum(added + deleted for _, added, deleted in substantive)
    count = len(substantive)

    # No changed lines at all, across any number of files: a rename sweep, a
    # move, a mode change. GitHub reports a pure rename as 0 added and 0
    # deleted, and the size rule below used to read that as "0 lines across 30
    # files, too large to skim" and buy it the deepest tier — forty minutes of
    # the most expensive review to look at nothing.
    if lines == 0:
        return "skip", f"{count} file(s) changed, none of them by a single line"

    if lines <= SMALL_LINES and count <= SMALL_FILES:
        return "light", f"{lines} line(s) across {count} file(s), no risky path"
    if lines <= MEDIUM_LINES and count <= MEDIUM_FILES:
        return "standard", f"{lines} line(s) across {count} file(s)"
    return "deep", f"{lines} line(s) across {count} file(s), too large to skim"


def decide(pr, files):
    tier, reason = classify(pr, files)
    settings = dict(TIERS[tier])
    settings["tier"] = tier
    settings["reason"] = reason
    settings["directive"] = DIRECTIVES[tier]
    return settings


def read_files(path):
    """Read the changed-file list: `path<TAB>added<TAB>deleted` per line.

    GitHub reports the two counts as "-" for a binary file; those read as zero,
    which is right — a binary blob has no hunks for anyone to read.
    """
    out = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if not parts[0]:
                continue
            added = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            deleted = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
            out.append((parts[0], added, deleted))
    return out


def read_event(path):
    """Flatten the pull_request webhook payload down to what the rules read."""
    with open(path, encoding="utf-8") as handle:
        event = json.load(handle)
    pr = event.get("pull_request") or {}
    return {
        "draft": bool(pr.get("draft")),
        "labels": [label.get("name", "") for label in pr.get("labels") or ()],
        "author_type": (pr.get("user") or {}).get("type", ""),
    }


DELIMITER = "PR_REVIEW_INTENSITY_EOF"


def emit(settings, stream):
    for key in ("tier", "model", "timeout_minutes", "comment", "reason", "directive"):
        value = str(settings[key])
        if "\n" in value or "\r" in value:
            # Only `directive` is ever multi-line and its values are constants in
            # this file, but a heredoc whose body contains its own delimiter
            # silently swallows the rest of the step's outputs. The guard costs
            # nothing and the failure it prevents is invisible.
            if DELIMITER in value:
                raise ValueError(f"output {key!r} contains the heredoc delimiter")
            stream.write(f"{key}<<{DELIMITER}\n{value}\n{DELIMITER}\n")
        else:
            stream.write(f"{key}={value}\n")


def selftest():
    def pr(**kw):
        base = {
            "draft": False,
            "labels": [],
            "author_type": "User",
        }
        base.update(kw)
        return base

    def tier(files, **kw):
        return decide(pr(**kw), files)["tier"]

    small = [("swarmtrace/utils.py", 5, 2)]
    medium = [("swarmtrace/utils.py", 200, 100)]
    huge = [("swarmtrace/utils.py", 4000, 10)]

    # A label beats every rule below it, in both directions.
    assert tier(huge, labels=["review:skip"]) == "skip"
    assert tier(small, labels=["review:deep"]) == "deep"
    assert tier([("supabase/migrations/0013_x.sql", 3, 0)], labels=["review:light"]) == "light"
    # GitHub labels are case-insensitive, so the match has to be too.
    assert tier(huge, labels=["Review:Skip"]) == "skip"

    # A draft is not finished being written, and a bot's version bump is not
    # waiting on anyone's opinion. Both still yield to an explicit label.
    assert tier(small, draft=True) == "skip"
    assert tier(small, author_type="Bot") == "skip"
    assert tier(small, draft=True, labels=["review:deep"]) == "deep"
    assert tier(small, author_type="Bot", labels=["review:standard"]) == "standard"

    # Nothing a model should be reading.
    assert tier([]) == "skip"
    assert tier([("package-lock.json", 5000, 4000)]) == "skip"
    assert tier([("README.md", 40, 3), ("CHANGELOG.md", 20, 0)]) == "skip"
    # Prose next to code is a code change with a note attached.
    assert tier([("README.md", 40, 3), ("swarmtrace/utils.py", 5, 1)]) == "light"

    # Risk outranks size in both directions.
    assert tier([("supabase/migrations/0013_x.sql", 3, 0)]) == "deep"
    assert tier([(".github/workflows/ci.yml", 2, 1)]) == "deep"
    assert tier([("frontend-next/app/api/ingest/route.ts", 4, 4)]) == "deep"
    assert tier([("frontend-next/lib/api-auth.ts", 1, 1)]) == "deep"
    assert tier([("swarmtrace/delivery/sender.py", 2, 2)]) == "deep"
    assert tier([("pyproject.toml", 2, 2)]) == "standard"
    assert tier(small) == "light"
    assert tier(medium) == "standard"
    assert tier(huge) == "deep"

    # Executable documentation is not prose: tests/test_architecture_boundaries.py
    # enforces what docs/ARCHITECTURE.md says, so editing it edits a contract.
    assert tier([("docs/ARCHITECTURE.md", 6, 2)]) == "standard"
    assert tier([("docs/PRD.md", 600, 200)]) == "skip"

    # A lockfile refresh must not inflate the tier of the change beside it.
    assert tier([("swarmtrace/utils.py", 5, 2), ("package-lock.json", 6000, 5000)]) == "light"

    # A bot reaches the risk table before it reaches the bot rule. The one bot
    # pull request that must be read is the one editing the CI definition.
    assert tier([(".github/workflows/ci.yml", 2, 1)], author_type="Bot") == "deep"
    assert tier([("frontend-next/package.json", 1, 1)], author_type="Bot") == "standard"
    assert tier([("frontend-next/package-lock.json", 900, 800)], author_type="Bot") == "skip"

    # A pure rename sweep: GitHub reports 0 added and 0 deleted, and 30 files of
    # nothing is nothing to read, not a diff too large to skim.
    assert tier([(f"swarmtrace/m{i}.py", 0, 0) for i in range(30)]) == "skip"
    assert tier([("swarmtrace/m.py", 0, 0), ("swarmtrace/n.py", 1, 0)]) == "light"
    # ...but a rename that touches a critical path is still read.
    assert tier([("swarmtrace/storage.py", 0, 0)]) == "deep"

    # A literal pattern is a whole path and does not leak to the same filename
    # somewhere else; a wildcard one deliberately does.
    assert matches("pyproject.toml", SENSITIVE)
    assert not matches("frontend-next/pyproject.toml", SENSITIVE)
    assert matches("frontend-next/package-lock.json", GENERATED)
    assert matches("frontend-next/.gitignore", PROSE)

    # Every tier that runs comments; see the note on TIERS.
    for name in ("light", "standard", "deep"):
        assert TIERS[name]["comment"] == "true"
    assert TIERS["skip"]["comment"] == "false"

    # Prefixes, globs at depth, and no accidental neighbours.
    assert matches("supabase/migrations/0001_init.sql", CRITICAL)
    assert matches("anywhere/deep/x.sql", CRITICAL)
    assert not matches("supabase_notes.md", CRITICAL)
    assert not matches("swarmtrace/storage_helpers.py", CRITICAL)
    assert matches("swarmtrace/storage.py", CRITICAL)

    # The parser: GitHub reports "-" for both counts on a binary file, and a
    # trailing blank line is the normal shape of the file, not an edge case.
    with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False) as tmp:
        tmp.write("assets/logo.png\t-\t-\nswarmtrace/storage.py\t3\t1\n\n")
        path = tmp.name
    try:
        assert read_files(path) == [
            ("assets/logo.png", 0, 0),
            ("swarmtrace/storage.py", 3, 1),
        ]
    finally:
        os.unlink(path)

    # A typo in one of the tables should surface here, not at 3am in a job.
    for name in ORDER:
        assert name in TIERS
        assert name in DIRECTIVES
    for settings in TIERS.values():
        assert set(settings) == {"model", "timeout_minutes", "comment"}
        assert settings["comment"] in ("true", "false")

    print("pr_review_intensity: all self-tests passed")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Pick a review intensity for a pull request.")
    parser.add_argument("--event", help="path to the GitHub event payload JSON")
    parser.add_argument("--files", help="path to a `name<TAB>added<TAB>deleted` list")
    parser.add_argument(
        "--github-output",
        default=os.environ.get("GITHUB_OUTPUT"),
        help="where to append step outputs (default: $GITHUB_OUTPUT)",
    )
    parser.add_argument("--selftest", action="store_true", help="run the built-in assertions")
    args = parser.parse_args(argv)

    if args.selftest:
        selftest()
        return 0
    if not args.event or not args.files:
        parser.error("--event and --files are required unless --selftest is given")

    settings = decide(read_event(args.event), read_files(args.files))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            emit(settings, handle)
    emit(settings, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
