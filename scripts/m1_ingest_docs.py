"""M1 - ingest the reference documents into Qdrant for the assistant.

Run after scripts/m1_fetch_docs.py, from the repo root (stop the test server first
when Qdrant is local, because a local Qdrant folder can be opened by one process):
    .\\.venv\\Scripts\\python.exe scripts\\m1_ingest_docs.py
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import rag  # noqa: E402

CHUNK, OVERLAP = 1200, 200


def html_text(raw: bytes) -> str:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(raw, "html.parser")
    for t in soup(["script", "style", "nav", "header", "footer", "noscript", "form"]):
        t.decompose()
    return soup.get_text("\n")


def docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        x = z.read("word/document.xml").decode("utf-8")
    x = re.sub(r"</w:p>", "\n", x)
    x = re.sub(r"<w:tab/>", "\t", x)
    return re.sub(r"<[^>]+>", "", x)


def clean(t: str) -> str:
    t = t.replace("\xa0", " ")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n\n", t)
    return t.strip()


def chunks(text: str) -> list[str]:
    paras = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 40]
    out, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 2 > CHUNK and cur:
            out.append(cur)
            cur = cur[-OVERLAP:] + "\n\n" + p
        else:
            cur = (cur + "\n\n" + p).strip()
        while len(cur) > CHUNK * 1.5:
            out.append(cur[:CHUNK])
            cur = cur[CHUNK - OVERLAP:]
    if cur:
        out.append(cur)
    return out


def main() -> None:
    sources = json.loads((ROOT / "data" / "rag" / "sources.json").read_text(encoding="utf-8"))
    all_chunks = []
    for s in sources:
        f = ROOT / s.get("file", "")
        if not s.get("file") or not f.exists():
            print("skip", s["source_id"], "(missing)")
            continue
        if f.suffix == ".html":
            text = html_text(f.read_bytes())
        elif f.suffix == ".docx":
            text = docx_text(f)
        else:
            text = f.read_text(encoding="utf-8")
        parts = chunks(clean(text))
        for i, c in enumerate(parts):
            all_chunks.append({"source_id": s["source_id"], "title": s["title"], "organisation": s.get("organisation"),
                               "url": s.get("url"), "path": s.get("path"), "chunk": i, "text": c})
        print(s["source_id"], len(parts), "chunks")
    vectors = []
    for i in range(0, len(all_chunks), 16):
        vectors += rag.embed([c["text"] for c in all_chunks[i:i + 16]], kind="passage")
        print(f"embedded {min(i + 16, len(all_chunks))}/{len(all_chunks)}", flush=True)
    rag.reset_collection(len(vectors[0]))
    rag.upsert(all_chunks, vectors)
    print("collection", rag.config()["collection"], "points", rag.count(), "at", rag.public_config()["qdrant"])
    rag.client().close()


if __name__ == "__main__":
    main()
