"""Exercise real speech, translation and tool routing with short synthetic prompts."""

import argparse
import asyncio
import re
import unicodedata
from pathlib import Path

from dotenv import load_dotenv

from backend.guardian_provider import GuardianProvider, GuardianProviderError, LANGUAGES


# Each regex checks a concept, allowing common transcription variants.
SAMPLES = {
    "en": ("Please check the water tank before starting the pump.", ("tank", "pump", "before")),
    "ja": ("ポンプを動かす前に、水タンクを確認してください。", ("ポンプ", "前", "タンク|たんく")),
    "aeb": ("بالله ثبّت في خزّان الما قبل ما نشغّلوا المضخّة.", ("خزان", "قبل", "مضخ")),
    "fr": ("Bonjour. Vérifiez le réservoir avant de reprendre la distribution.", ("bonjour", "reservoir", "distribution")),
}


def normalize(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFD", text.lower()) if not unicodedata.combining(char))


def check_words(output: str, concepts: tuple[str, ...], label: str):
    if not all(re.search(normalize(term), normalize(output)) for term in concepts):
        raise SystemExit(f"{label}: a required meaning or numerical value was missing.")


async def check(languages):
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    provider = GuardianProvider.from_env()
    for language in languages:
        if not all(provider.capabilities_for(language).values()):
            raise SystemExit(f"Configure speech and language inference for {language}.")
        sample, terms = SAMPLES[language]
        audio, mime = await provider.speak(sample, language, seed=42)
        transcript = await provider.transcribe(audio, mime, language)
        check_words(transcript, terms, f"{language} speech round-trip")
        print(f"{LANGUAGES[language]}: {len(audio)} bytes of {mime}; Whisper recovered all three concepts.", flush=True)

        source, text = ("aeb", "الخزّان فيه 13 متر مكعّب ما. بالله ثبّت في المضخّة.") if language == "en" else (
            "en", "The tank holds 13 cubic metres of water. Please check the pump.")
        translated = await provider.translate(text, source, language)
        expected = {"en": ("13", "tank|reservoir", "pump"), "ja": ("13", "タンク|貯水|水槽", "ポンプ"),
                    "aeb": ("13", "خزان|صهريج|سيترن|تانكي", "مضخ|موتور|[بپ]ومب", "بالله|يعيشك|ثبت|تفقّد|شوف"),
                    "fr": ("13", "cuve|reservoir", "pompe")}
        check_words(translated, expected[language], f"{language} translation")
        if language == "aeb" and re.search(r"عافاك|دابا|دلوقتي", normalize(translated)):
            raise SystemExit("The Tunisian translation used a different dialect's expression.")
        print(f"Translation {source} → {language} preserved the tank, pump and amount.", flush=True)
        question = await provider.presentation_opener("The display compares two simulated delivery plans.",
                                                      language, "water allocation")
        if question[-1] not in "?؟？":
            raise SystemExit(f"{language}: the presentation opener is not a question.")
        print(f"{language}: the configured model supplied a presentation question.", flush=True)

    tools = [{"type": "function", "function": {"name": name, "description": description, "parameters": {
        "type": "object", "properties": {}, "additionalProperties": False}}}
        for name, description in (("inspect_tank", "Read the remaining water in the tank."),
                                  ("inspect_solar", "Read the solar energy profile."))]
    messages = [{"role": "system", "content": "Select the tool for this question. Both tools take no arguments."},
                {"role": "user", "content": "قداش بقى ما في الخزّان؟"}]
    if await provider.choose_tool(messages, tools) != ("inspect_tank", {}):
        raise SystemExit("The language model selected an unexpected operation for the Tunisian question.")
    print("Tunisian question routed to the reservoir tool.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True, help="Use the configured billable inference endpoint.")
    parser.add_argument("--languages", nargs="+", choices=SAMPLES, default=["en", "ja", "aeb"])
    args = parser.parse_args()
    try:
        asyncio.run(check(args.languages))
    except GuardianProviderError as error:
        raise SystemExit(f"{error.service} failed (HTTP {error.status or 'unavailable'}).") from None
