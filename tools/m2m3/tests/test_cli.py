import json

import pytest

from mizu_energy import main


@pytest.mark.parametrize(("arguments", "field"), [
    (["solar", "--site", "jendouba-pilote", "--options", "toiture", "ombriere"], "options"),
    (["forecast", "--site", "jendouba-pilote", "--as-of", "2026-11-20T18:00:00+01:00"], "points"),
    (["anomalies", "--reference-kwh-per-m3", "0.5"], "alerts"),
    (["weather", "--pair", "jplus1-demo"], "central"),
])
def test_commands_output_json(arguments, field, capsys):
    assert main(arguments) == 0
    assert json.loads(capsys.readouterr().out)[field]


def test_cli_invalid_pair_exits_with_a_field_error(capsys):
    with pytest.raises(SystemExit) as error:
        main(["weather", "--pair", "invalid"])
    assert error.value.code == 2
    assert "pair: unknown weather pair" in capsys.readouterr().err
