from hashlib import sha256
from io import BytesIO
from json import dumps, loads
from pathlib import Path
import re
from uuid import NAMESPACE_URL, uuid5

import httpx
from pypdf import PdfReader

from .rag_store import CORPUS, ROOT, config, connect, words


def download(client: httpx.Client, source: dict) -> bytes:
    limit = 40 * 1024 * 1024
    revision = sha256(source["url"].encode()).hexdigest()[:12]
    cached = CORPUS.parent / f"{source['id']}-{revision}.pdf"
    if cached.is_file():
        return cached.read_bytes()
    with client.stream("GET", source["url"], follow_redirects=True) as response:
        response.raise_for_status()
        content = bytearray()
        for chunk in response.iter_bytes():
            content.extend(chunk)
            if len(content) > limit:
                raise ValueError("Le PDF dépasse la taille maximale.")
    if not content[:1024].lstrip().startswith(b"%PDF-"):
        raise ValueError("La source ne renvoie pas un PDF.")
    cached.write_bytes(content)
    return bytes(content)


def extract(source: dict, pdf: bytes) -> tuple[dict, list[dict]]:
    digest = sha256(pdf).hexdigest()
    reader = PdfReader(BytesIO(pdf))
    passages = []
    pages_indexed = 0
    for index, page in enumerate(reader.pages, start=1):
        text = re.sub(r"-\s*\n\s*(?=\w)", "", page.extract_text() or "")
        tokens = text.split()
        if len(tokens) < 35:
            continue
        pages_indexed += 1
        for offset in range(0, len(tokens), 155):
            passage = " ".join(tokens[offset:offset + 190])
            if len(words(passage)) < 20:
                continue
            passages.append({
                "id": str(uuid5(NAMESPACE_URL, f"{source['id']}/{digest}/{index}/{offset}")),
                "source_id": source["id"], "url": source["url"], "themes": source["themes"],
                "page": index, "sha256": digest, "text": passage,
            })
    if not passages:
        raise ValueError("Aucun passage exploitable dans le PDF.")
    report = {**source, "sha256": digest, "pages": len(reader.pages), "pages_indexed": pages_indexed,
              "passages": len(passages)}
    return report, passages


def main() -> None:
    catalog = loads((ROOT / "data" / "rag_sources.json").read_text(encoding="utf-8"))
    CORPUS.parent.mkdir(exist_ok=True)
    sources, docs = [], []
    with httpx.Client(timeout=35.0) as client:
        for source in catalog:
            try:
                report, passages = extract(source, download(client, source))
            except (httpx.HTTPError, OSError, ValueError) as error:
                print(f"{source['id']}: indisponible ({type(error).__name__})", flush=True)
                continue
            sources.append(report)
            docs.extend(passages)
            print(f"{source['id']}: {report['pages_indexed']}/{report['pages']} pages, {len(passages)} passages", flush=True)
        if not docs:
            raise SystemExit("Aucun document officiel indexable.")
        corpus_id = sha256("\n".join(doc["id"] for doc in docs).encode()).hexdigest()
        remote = connect(client, config())
        indexed = False
        if remote:
            try:
                remote.index(corpus_id, docs)
                indexed = True
            except httpx.HTTPError as error:
                status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else "réseau"
                print(f"Qdrant: échec ({status}), corpus local disponible", flush=True)
        temp = CORPUS.with_suffix(".tmp")
        temp.write_text(dumps({"id": corpus_id, "sources": sources, "passages": docs,
                               "qdrant_indexed": indexed}, ensure_ascii=False), encoding="utf-8")
        Path(temp).replace(CORPUS)
        print(f"Total : {len(sources)}/{len(catalog)} sources, {len(docs)} passages, Qdrant {indexed}.", flush=True)


if __name__ == "__main__":
    main()
