#!/usr/bin/env python3
"""Stdlib-only regression test for scalar leaves in MLX prompt caches."""

from __future__ import annotations

import pickle
import sys
import tempfile
import types
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace


class FakeArray:
    def __init__(self, value):
        self.value = value


def tree_flatten(tree, prefix="", is_leaf=None, destination=None):
    destination = [] if destination is None else destination
    if is_leaf is not None and is_leaf(tree):
        destination.append((prefix[1:], tree))
    elif isinstance(tree, (list, tuple)):
        for index, value in enumerate(tree):
            tree_flatten(value, f"{prefix}.{index}", is_leaf, destination)
    elif isinstance(tree, dict):
        for key, value in tree.items():
            tree_flatten(value, f"{prefix}.{key}", is_leaf, destination)
    else:
        destination.append((prefix[1:], tree))
    return destination


def tree_unflatten(tree):
    items = list(tree.items()) if isinstance(tree, dict) else list(tree)
    if len(items) == 1 and items[0][0] == "":
        return items[0][1]
    children = defaultdict(list)
    for key, value in items:
        current, *rest = key.split(".", maxsplit=1)
        children[current].append((rest[0] if rest else "", value))
    try:
        integer_keys = {int(key): key for key in children}
        is_list = len(integer_keys) == len(children)
    except ValueError:
        is_list = False
    if is_list:
        result = []
        for index, key in sorted(integer_keys.items()):
            result.extend({} for _ in range(index - len(result)))
            result.append(tree_unflatten(children[key]))
        return result
    return {key: tree_unflatten(value) for key, value in children.items()}


def save_safetensors(path, arrays, metadata):
    # Match the real API's array-only contract so an integer leaf reproduces
    # the 0.7.1 QSA failure this regression protects against.
    assert all(isinstance(value, FakeArray) for value in arrays.values())
    Path(path).write_bytes(pickle.dumps((arrays, metadata)))


def load_safetensors(path, return_metadata=False):
    payload = pickle.loads(Path(path).read_bytes())
    return payload if return_metadata else payload[0]


mlx = types.ModuleType("mlx")
mlx_core = types.ModuleType("mlx.core")
mlx_core.save_safetensors = save_safetensors
mlx_core.load = load_safetensors
mlx_utils = types.ModuleType("mlx.utils")
mlx_utils.tree_flatten = tree_flatten
mlx_utils.tree_unflatten = tree_unflatten
mlx.core = mlx_core
sys.modules["mlx"] = mlx
sys.modules["mlx.core"] = mlx_core
sys.modules["mlx.utils"] = mlx_utils


class QSAKVCache:
    def __init__(self, state=None, meta_state=None):
        self.state = state
        self.meta_state = meta_state or {}

    @classmethod
    def from_state(cls, state, meta_state):
        return cls(state, meta_state)


QSAKVCache.__module__ = "mlx_vlm.models.qwen4_exp.language"


mlx_lm = types.ModuleType("mlx_lm")
mlx_lm_models = types.ModuleType("mlx_lm.models")
mlx_lm_cache = types.ModuleType("mlx_lm.models.cache")
mlx_lm_cache.QSAKVCache = QSAKVCache
sys.modules["mlx_lm"] = mlx_lm
sys.modules["mlx_lm.models"] = mlx_lm_models
sys.modules["mlx_lm.models.cache"] = mlx_lm_cache

mlx_vlm = types.ModuleType("mlx_vlm")
mlx_vlm_generate = types.ModuleType("mlx_vlm.generate")
mlx_vlm_generate.PromptCacheState = lambda: SimpleNamespace(cache=[], token_ids=[])
mlx_vlm_models = types.ModuleType("mlx_vlm.models")
mlx_vlm_qwen4 = types.ModuleType("mlx_vlm.models.qwen4_exp")
mlx_vlm_qwen4_language = types.ModuleType("mlx_vlm.models.qwen4_exp.language")
mlx_vlm_qwen4_language.QSAKVCache = QSAKVCache
sys.modules["mlx_vlm"] = mlx_vlm
sys.modules["mlx_vlm.generate"] = mlx_vlm_generate
sys.modules["mlx_vlm.models"] = mlx_vlm_models
sys.modules["mlx_vlm.models.qwen4_exp"] = mlx_vlm_qwen4
sys.modules["mlx_vlm.models.qwen4_exp.language"] = mlx_vlm_qwen4_language

import cache_persist  # noqa: E402 - install the fake MLX modules first


def test_qsa_scalar_round_trip():
    qsa_state = (
        FakeArray("keys"),
        FakeArray("values"),
        FakeArray("index-keys"),
        None,
        FakeArray("block-keys"),
        4,
    )
    state = SimpleNamespace(
        cache=[QSAKVCache(qsa_state, {"offset": 12})],
        token_ids=[1, 2, 3],
    )
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        assert cache_persist.save_cache(root, "model", "session", state)
        restored = cache_persist.load_cache(root, "model", "session")
        assert restored is not None
        assert restored.token_ids == [1, 2, 3]
        layer_state = restored.cache[0].state
        assert layer_state[3] is None
        assert layer_state[5] == 4
        assert layer_state[4].value == "block-keys"
    print("PASS Qwen4 QSA scalar cache-state round trip")


if __name__ == "__main__":
    test_qsa_scalar_round_trip()
