import re
from pathlib import Path

from yaml import BaseLoader, load


def test_security_workflow_keeps_write_access_and_secret_output_bounded():
    path = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "security.yml"
    workflow = load(path.read_text(encoding="utf-8"), Loader=BaseLoader)
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
