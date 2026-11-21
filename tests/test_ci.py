from pathlib import Path

from yaml import BaseLoader, load


def test_ci_triggers_run_all_checks_with_cached_dependencies():
    path = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "ci.yml"
    workflow = load(path.read_text(encoding="utf-8"), Loader=BaseLoader)
    assert {"push", "pull_request"} <= workflow["on"].keys()
    assert workflow["permissions"] == {"contents": "read"}

    backend = workflow["jobs"]["backend"]
    python = next(step["with"] for step in backend["steps"] if step.get("uses", "").startswith("actions/setup-python@"))
    assert python["cache"] == "pip"
    assert set(python["cache-dependency-path"].split()) == {"requirements.txt", "requirements-dev.txt"}
    assert [step["run"] for step in backend["steps"] if "run" in step] == [
        "python -m pip install -r requirements-dev.txt", "python -m pytest -ra",
    ]

    frontend = workflow["jobs"]["frontend"]
    node = next(step["with"] for step in frontend["steps"] if step.get("uses", "").startswith("actions/setup-node@"))
    assert node["cache"] == "npm"
    assert node["cache-dependency-path"] == "frontend/package-lock.json"
    assert frontend["defaults"]["run"]["working-directory"] == "frontend"
    assert [step["run"] for step in frontend["steps"] if "run" in step] == [
        "npm ci", "npm test", "npm exec -- tsc --noEmit", "npm run build",
    ]
