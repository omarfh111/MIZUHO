"""Require the current main push and all release-critical GitHub Actions jobs."""

import json
import os
import re
import subprocess
import sys


REQUIRED_JOBS = {
    "ci.yml": {"Backend", "Frontend", "Digital twin browser tests", "AWS container and browser"},
    "security.yml": {"CodeQL (python)", "CodeQL (javascript-typescript)", "Secret scan"},
}


def verify_revision(sha, api):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Release requires a full Git commit SHA")
    if api("git/ref/heads/main")["object"]["sha"] != sha:
        raise ValueError("main has advanced. Dispatch a fresh release for the current tip")

    for workflow, required in REQUIRED_JOBS.items():
        runs = api(f"actions/workflows/{workflow}/runs?branch=main&event=push&head_sha={sha}&per_page=1")
        latest = next(iter(runs["workflow_runs"]), None)
        if not latest or (latest["head_sha"], latest["head_branch"], latest["event"],
                          latest["status"], latest["conclusion"]) != (sha, "main", "push", "completed", "success"):
            raise ValueError(f"{workflow} has no successful completed main push run for this revision")

        jobs = api(f"actions/runs/{latest['id']}/jobs?filter=latest&per_page=100")["jobs"]
        passed = {job["name"] for job in jobs if job["status"] == "completed" and job["conclusion"] == "success"}
        missing = required - passed
        if missing:
            raise ValueError(f"{workflow} has missing or unsuccessful jobs: {', '.join(sorted(missing))}")


def github_api(path):
    result = subprocess.run(
        ["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/{path}"],
        capture_output=True, text=True, check=True, timeout=30,
    )
    return json.loads(result.stdout)


if __name__ == "__main__":
    if os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        sys.exit("AWS releases require a manual dispatch from main")
    try:
        verify_revision(os.environ["GITHUB_SHA"], github_api)
    except (ValueError, KeyError, subprocess.SubprocessError) as exc:
        sys.exit(f"Release gate failed: {exc}")
    print(f"All required checks passed for {os.environ['GITHUB_SHA']}.")
