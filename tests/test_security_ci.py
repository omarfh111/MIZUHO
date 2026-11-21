import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from yaml import BaseLoader, load


@pytest.fixture(scope="module")
def workflow():
    path = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "security.yml"
    return load(path.read_text(encoding="utf-8"), Loader=BaseLoader)


def test_security_workflow_keeps_write_access_and_secret_output_bounded(workflow):
    assert {"push", "pull_request", "schedule"} <= workflow["on"].keys()
    assert "pull_request_target" not in workflow["on"]
    assert workflow["permissions"] == {"contents": "read"}

    jobs = workflow["jobs"]
    codeql = jobs["codeql"]
    assert set(codeql["strategy"]["matrix"]["language"]) == {"python", "javascript-typescript"}
    assert codeql["permissions"] == {"contents": "read", "security-events": "write"}
    assert jobs["dependency-review"]["if"] == "github.event_name == 'pull_request'"
    assert all("permissions" not in jobs[name] for name in ("secrets", "dependency-review"))

    review_checkout, detect, install_osv, compare = jobs["dependency-review"]["steps"]
    assert review_checkout["with"]["fetch-depth"] == "0"
    assert 'git diff --name-only "$BASE_SHA" "$GITHUB_SHA"' in detect["run"]
    assert install_osv["if"] == compare["if"] == "steps.manifests.outputs.changed == 'true'"
    assert re.fullmatch(r"[0-9a-f]{64}", install_osv["env"]["OSV_SHA256"])
    assert "sha256sum --check --strict" in install_osv["run"]
    assert 'scan "$BASE_SHA" base' in compare["run"]
    assert 'scan "$GITHUB_SHA" candidate' in compare["run"]
    assert "comm -13" in compare["run"]

    for job in jobs.values():
        for step in job["steps"]:
            if "uses" in step:
                assert re.fullmatch(r"[^@]+@[0-9a-f]{40}", step["uses"])
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] == "false"

    checkout, install, scan = jobs["secrets"]["steps"]
    assert checkout["with"]["fetch-depth"] == "0"
    assert "sha256sum --check --strict" in install["run"]
    assert re.fullmatch(r"[0-9a-f]{64}", install["env"]["GITLEAKS_SHA256"])
    assert {"git", "--redact=100", "--log-opts=HEAD"} <= set(scan["run"].split())
    assert "--report-path" not in scan["run"]


@pytest.mark.parametrize("base_has_manifest", [False, True])
def test_dependency_scan_uses_only_manifests_tracked_at_each_revision(workflow, tmp_path, base_has_manifest):
    git = shutil.which("git")
    bash = shutil.which("bash")
    if os.name == "nt" and git:
        git_bash = Path(git).resolve().parents[1] / "bin" / "bash.exe"
        bash = str(git_bash) if git_bash.is_file() else None
    if not git or not bash:
        pytest.skip("Git and Bash are required to execute the workflow step.")

    repo = tmp_path / "repo"
    repo.mkdir()

    def run_git(*args):
        return subprocess.check_output([git, "-C", str(repo), *args], text=True).strip()

    def commit(message):
        run_git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
                "commit", "--allow-empty", "-m", message)
        return run_git("rev-parse", "HEAD")

    run_git("init", "--quiet")
    if base_has_manifest:
        (repo / "requirements.txt").write_text("fastapi==0.115.12\n", encoding="utf-8")
        run_git("add", "requirements.txt")
    base = commit("Base revision")
    (repo / "frontend").mkdir()
    (repo / "frontend" / "package-lock.json").write_text("{}\n", encoding="utf-8")
    (repo / "tools" / "tunisia").mkdir(parents=True)
    (repo / "tools" / "tunisia" / "requirements.txt").write_text("Pillow==13.0.0\n", encoding="utf-8")
    run_git("add", "frontend/package-lock.json", "tools/tunisia/requirements.txt")
    candidate = commit("Add frontend and atlas manifests")

    runner = tmp_path / "runner"
    runner.mkdir()
    scanner = runner / "osv-scanner"
    # Stop when the scanner is reached so the test can inspect its manifest arguments.
    scanner.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\nexit 2\n', encoding="utf-8", newline="\n")
    scanner.chmod(0o755)
    compare = workflow["jobs"]["dependency-review"]["steps"][-1]["run"]
    result = subprocess.run(
        [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", compare],
        cwd=repo, env={**os.environ, "BASE_SHA": base, "GITHUB_SHA": candidate, "RUNNER_TEMP": runner.as_posix()},
        text=True, capture_output=True, timeout=20,
    )
    assert result.returncode == 2, result.stdout + result.stderr
    files = [line.split("/dependencies-", 1)[-1] for line in result.stdout.splitlines()
             if line.startswith("--lockfile=")]
    if base_has_manifest:
        assert files == ["base/requirements.txt"]
    else:
        assert (runner / "dependencies-base" / "advisories.tsv").read_text(encoding="utf-8") == ""
        assert files == ["candidate/frontend/package-lock.json", "candidate/tools/tunisia/requirements.txt"]
