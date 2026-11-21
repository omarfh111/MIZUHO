"""BM25 over the local evidence excerpts and their multilingual search metadata."""

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping

_FOLD = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ى٫", "01234567890123456789ي.")
_TOKEN = re.compile(r"\d+(?:\.\d+)?|[^\W\d_]+", re.UNICODE)
_ARTICLE = re.compile(r"^[وبفل]?ال(?=[\u0621-\u064a]{3})")
_STOP_WORDS = frozenset("""
    a an and of for from in is it on that the to was what where which with
    au aux avec ce cet d dans de des du en et l la le les ou par pour que quel
    quelle quelles qui se un une
    او ان اي الى عن على في ما من هل هو هي الذي التي و
""".split())
_RRF_OFFSET = 2
_LEXICAL_WEIGHT = 0.6


def tokenize(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", text.casefold()).translate(_FOLD)
    folded = "".join(char for char in folded if not unicodedata.combining(char) and char != "ـ")
    folded = re.sub(r"(?<=\d)[,٬](?=\d{3}\b)", "", folded)
    folded = re.sub(r"(?<=\d),(?=\d)", ".", folded)
    words = (_ARTICLE.sub("", token) for token in _TOKEN.findall(folded))
    return [word for word in words if word not in _STOP_WORDS]


class BM25:
    def __init__(self, documents: Mapping[str, str]):
        self.documents = {key: Counter(tokenize(text)) for key, text in documents.items()}
        lengths = {key: sum(words.values()) for key, words in self.documents.items()}
        average = sum(lengths.values()) / max(1, len(lengths)) or 1
        self.length_factors = {key: 1.2 * (0.25 + 0.75 * length / average) for key, length in lengths.items()}
        frequencies = Counter(term for words in self.documents.values() for term in words)
        self.idf = {
            term: math.log1p((len(lengths) - count + 0.5) / (count + 0.5))
            for term, count in frequencies.items()
        }

    def rank(self, query: str, limit: int) -> list[str]:
        terms = dict.fromkeys(tokenize(query))
        scores = {}
        for key, words in self.documents.items():
            score = sum(
                self.idf[term] * (2.2 * words[term]) / (words[term] + self.length_factors[key])
                for term in terms if term in words
            )
            if score > 0:
                scores[key] = score
        return sorted(scores, key=lambda key: (-scores[key], key))[:limit]


def fuse_ranks(dense: Iterable[str], lexical: Iterable[str]) -> list[str]:
    """Weighted reciprocal rank fusion keeps semantic matches strong when keywords are weak."""
    ranks = {key: rank for rank, key in enumerate(dict.fromkeys(dense), 1)}
    scores = {key: 1 / (_RRF_OFFSET + rank) for key, rank in ranks.items()}
    for rank, key in enumerate(dict.fromkeys(lexical), 1):
        scores[key] = scores.get(key, 0) + _LEXICAL_WEIGHT / (_RRF_OFFSET + rank)
    return sorted(scores, key=lambda key: (-scores[key], ranks.get(key, math.inf), key))
