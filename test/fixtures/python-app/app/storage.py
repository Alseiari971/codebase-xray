import os.path
from typing import Any


def save(item: Any) -> None:
    path = os.path.join("data", "item")
    _write(path, item)


def _write(path, item):
    pass
