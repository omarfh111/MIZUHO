"""Run three live Vultr calls using synthetic French speech, without recording any audio."""

import argparse
import asyncio
import unicodedata
from pathlib import Path

from dotenv import load_dotenv

from backend.guardian_provider import GuardianProvider, GuardianProviderError


async def check():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    provider = GuardianProvider.from_env()
    if not all(provider.capabilities.values()):
        raise SystemExit("Configure the Vultr inference subscription and all three models.")
    sample = "Bonjour. Vérifiez le réservoir avant de reprendre la distribution."
    audio, mime = await provider.speak(sample)
    print(f"French synthesis: {len(audio)} bytes of {mime}.", flush=True)
    transcript = await provider.transcribe(audio, mime)
    words = "".join(c for c in unicodedata.normalize("NFD", transcript.lower()) if not unicodedata.combining(c))
    if not all(term in words for term in ("bonjour", "reservoir", "distribution")):
        raise SystemExit("French synthesis/transcription did not preserve the expected terms.")
    print("Whisper recovered all three expected terms.", flush=True)
    tools = [{"type": "function", "function": {"name": name, "description": description, "parameters": {
        "type": "object", "properties": {}, "additionalProperties": False}}}
        for name, description in (("inspect_tank", "Read the remaining water in the tank."),
                                  ("inspect_solar", "Read the solar energy profile."))]
    messages = [{"role": "system", "content": "Select the appropriate tool to answer the question. These tools take no arguments, as all inputs are already in the session context."},
                {"role": "user", "content": "Quel volume d'eau reste-t-il dans le réservoir ?"}]
    chosen = await provider.choose_tool(messages, tools)
    if chosen != ("inspect_tank", {}):
        raise SystemExit("French tool routing selected an unexpected operation.")
    print("The tool-calling model selected the reservoir inspection.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True, help="Use the configured billable Vultr endpoint.")
    parser.parse_args()
    try:
        asyncio.run(check())
    except GuardianProviderError as error:
        raise SystemExit(f"{error.service} failed (HTTP {error.status or 'unavailable'}).") from None
