"""M1 - download the reference documents used by the assistant (RAG).

Run from the repo root:
    .\\.venv\\Scripts\\python.exe scripts\\m1_fetch_docs.py

Raw files go to data/rag/raw/ (git-ignored: third-party content). The list of
sources with URL, retrieval time and SHA-256 is written to data/rag/sources.json.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAG = ROOT / "data" / "rag"
UA = {"User-Agent": "mizu-nexus-hackathon/0.1"}

EXTERNAL = [
    {"source_id": "fao56-ch1", "title": "FAO-56, chapitre 1 : introduction à l'évapotranspiration",
     "organisation": "FAO", "license": "FAO copyright, usage non commercial",
     "url": "https://www.fao.org/3/X0490E/x0490e04.htm"},
    {"source_id": "fao56-ch5", "title": "FAO-56, chapitre 5 : évapotranspiration de la culture (Kc)",
     "organisation": "FAO", "license": "FAO copyright, usage non commercial",
     "url": "https://www.fao.org/3/X0490E/x0490e0a.htm"},
    {"source_id": "fao56-ch2", "title": "FAO-56, chapitre 2 : équation de Penman-Monteith (ET de référence)",
     "organisation": "FAO", "license": "FAO copyright, usage non commercial",
     "url": "https://www.fao.org/3/X0490E/x0490e06.htm"},
    {"source_id": "fao56-ch8", "title": "FAO-56, chapitre 8 : ETc en conditions de stress hydrique",
     "organisation": "FAO", "license": "FAO copyright, usage non commercial",
     "url": "https://www.fao.org/3/X0490E/x0490e0e.htm"},
    {"source_id": "wapor-data", "title": "FAO WaPOR : données et produits",
     "organisation": "FAO", "license": "FAO copyright",
     "url": "https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data/en"},
    {"source_id": "power-method", "title": "NASA POWER : méthodologie des données",
     "organisation": "NASA Langley (POWER)", "license": "données publiques NASA",
     "url": "https://power.larc.nasa.gov/docs/methodology/"},
]

# Project documents, read from the working tree at ingestion time.
INTERNAL = [
    {"source_id": "m1-data", "title": "M1 : sources, méthode et limites des données", "organisation": "Équipe MIZU NEXUS",
     "path": "docs/M1_DATA.md"},
    {"source_id": "m1-causes", "title": "M1 : entonnoir des causes", "organisation": "Équipe MIZU NEXUS",
     "path": "docs/M1_CAUSES.md"},
    {"source_id": "cdc-v5", "title": "Cahier des charges MIZU NEXUS Tunisie v5", "organisation": "Équipe MIZU NEXUS",
     "path": "Cahier des charges MIZU NEXUS Tunisie v5.docx", "local_only": True},
]


def main() -> None:
    raw = RAG / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    out = []
    for s in EXTERNAL:
        r = requests.get(s["url"], headers=UA, timeout=60)
        entry = {**s, "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "status_code": r.status_code}
        if r.ok and len(r.content) > 500:
            ext = ".pdf" if "pdf" in r.headers.get("content-type", "") else ".html"
            path = raw / f"{s['source_id']}{ext}"
            path.write_bytes(r.content)
            entry.update(file=path.relative_to(ROOT).as_posix(), sha256=hashlib.sha256(r.content).hexdigest(), bytes=len(r.content))
        print(s["source_id"], r.status_code, len(r.content))
        out.append(entry)
    for s in INTERNAL:
        p = ROOT / s["path"]
        out.append({**s, "file": s["path"], "exists": p.exists(),
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None})
    (RAG / "sources.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
