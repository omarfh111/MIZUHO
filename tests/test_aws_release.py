import os
from pathlib import Path
import shutil
import subprocess

import pytest
from yaml import BaseLoader, load

from deploy.aws.verify_release import REQUIRED_JOBS, verify_revision


SHA = "a" * 40
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def responses():
    result = {"git/ref/heads/main": {"object": {"sha": SHA}}}
    for run_id, (workflow, required) in enumerate(REQUIRED_JOBS.items(), 1):
        result[f"actions/workflows/{workflow}/runs?branch=main&event=push&head_sha={SHA}&per_page=1"] = {
            "workflow_runs": [{"id": run_id, "head_sha": SHA, "head_branch": "main", "event": "push",
                               "status": "completed", "conclusion": "success"}]
        }
        result[f"actions/runs/{run_id}/jobs?filter=latest&per_page=100"] = {
            "jobs": [{"name": name, "status": "completed", "conclusion": "success"} for name in required]
        }
    return result


def test_green_main_push_is_releasable(responses):
    verify_revision(SHA, responses.__getitem__)


def test_new_main_tip_stops_old_dispatch(responses):
    responses["git/ref/heads/main"]["object"]["sha"] = "b" * 40
    with pytest.raises(ValueError, match="main has advanced"):
        verify_revision(SHA, responses.__getitem__)


@pytest.mark.parametrize("field,value", [("head_sha", "b" * 40), ("head_branch", "topic"),
                                         ("event", "pull_request"), ("conclusion", "failure"),
                                         ("status", "in_progress")])
def test_unsuitable_security_run_blocks_release(responses, field, value):
    path = next(path for path in responses if "security.yml" in path)
    responses[path]["workflow_runs"][0][field] = value
    with pytest.raises(ValueError, match="security.yml"):
        verify_revision(SHA, responses.__getitem__)


@pytest.mark.parametrize("name", ["Digital twin browser tests", "AWS container and browser", "CodeQL (python)", "Secret scan"])
def test_skipped_required_jobs_block_successful_workflows(responses, name):
    for data in responses.values():
        for job in data.get("jobs", []):
            if job["name"] == name:
                job["conclusion"] = "skipped"
    with pytest.raises(ValueError, match="missing or unsuccessful"):
        verify_revision(SHA, responses.__getitem__)


def test_release_can_only_run_manually_and_federate_after_verification():
    workflow = load((ROOT / ".github/workflows/aws-release.yml").read_text(), Loader=BaseLoader)
    assert set(workflow["on"]) == {"workflow_dispatch"}
    assert workflow["concurrency"]["cancel-in-progress"] == "false"
    assert "id-token" not in workflow["permissions"]
    assert all(job["if"] == "github.ref == 'refs/heads/main'" for job in workflow["jobs"].values())
    deploy = workflow["jobs"]["deploy"]
    assert deploy["needs"] == "verify"
    assert deploy["environment"] == "aws-demo"
    assert deploy["permissions"]["id-token"] == "write"


def test_oidc_role_stays_bound_to_this_repository_and_environment():
    template = load((ROOT / "deploy/aws/bootstrap.yml").read_text(), Loader=BaseLoader)
    role = template["Resources"]["GitHubReleaseRole"]["Properties"]
    trust, = role["AssumeRolePolicyDocument"]["Statement"]
    assert trust["Action"] == "sts:AssumeRoleWithWebIdentity"
    assert trust["Condition"]["StringEquals"] == {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:omarfh111@163393752/MIZUHO@1466609894:environment:aws-demo",
    }
    statements = role["Policies"][0]["PolicyDocument"]["Statement"]
    wildcard = [item["Action"] for item in statements if item["Effect"] == "Allow" and item["Resource"] == "*"]
    assert wildcard == ["ecr:GetAuthorizationToken"]
    delegate = next(item for item in statements if item["Action"] == "iam:PassRole")
    assert delegate["Resource"] == "CloudFormationRoleArn"
    assert delegate["Condition"]["StringEquals"]["iam:PassedToService"] == "cloudformation.amazonaws.com"


@pytest.mark.parametrize("state", ["present", "missing", "denied", "stale"])
def test_publisher_reuses_immutable_tag_and_fails_closed(tmp_path, state):
    if os.name == "nt" or not shutil.which("bash") or not shutil.which("jq"):
        pytest.skip("This test exercises the Linux release runner's Bash and jq")
    scripts = {
        "aws": """case "$2" in
          batch-get-image)
            if [[ $STATE == denied ]]; then exit 1; fi
            if [[ $STATE == present || -f pushed ]]; then
              echo '{"digests":["sha256:%s"],"failures":[]}'
            else
              echo '{"digests":[],"failures":["ImageNotFound"]}'
            fi ;;
          get-login-password) echo local-test-input ;;
          *) exit 2 ;;
        esac""" % ("d" * 64),
        "docker": """echo "$1" >> calls
          if [[ $1 == login ]]; then cat >/dev/null; fi
          if [[ $1 == push ]]; then touch pushed; fi""",
        "python3": "echo verify >> calls; [[ $STATE != stale ]]",
    }
    for name, script in scripts.items():
        executable = tmp_path / name
        executable.write_text("#!/usr/bin/env bash\n" + script + "\n")
        executable.chmod(0o755)
    output = tmp_path / "outputs"
    result = subprocess.run(
        ["bash", ROOT / "deploy/aws/publish_image.sh", "registry.invalid/demo"],
        cwd=tmp_path, capture_output=True, text=True,
        env={**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
             "GITHUB_SHA": SHA, "GITHUB_OUTPUT": str(output), "STATE": state},
        timeout=20,
    )
    calls_file = tmp_path / "calls"
    calls = calls_file.read_text().splitlines() if calls_file.exists() else []
    if state in {"present", "missing"}:
        assert result.returncode == 0, result.stderr
        assert output.read_text().strip() == "image_uri=registry.invalid/demo@sha256:" + "d" * 64
        assert calls == ([] if state == "present" else ["buildx", "verify", "login", "push", "logout"])
    else:
        assert result.returncode != 0
        assert not output.exists()
        assert calls == ([] if state == "denied" else ["buildx", "verify"])
