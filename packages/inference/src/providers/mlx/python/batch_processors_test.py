"""A constrained request must stay constrained after a plain one.

Drives mlx_lm's real BatchGenerator with a tiny random model: a plain
sequence runs to completion, then a sequence whose processor forces one
token is inserted. With the lists from `per_sequence_processors`, the
processor must hold for every generated token, not just the first — the
failure mode `batch_processors.py` describes. Skips without mlx_lm, so it is
meaningful on a laptop with the MLX venv and harmless on a bare python3.
"""

import sys

import batch_processors as bp


def _tiny_model():
    import mlx.core as mx
    from mlx_lm.models import llama

    mx.random.seed(0)
    args = llama.ModelArgs(
        model_type="llama",
        hidden_size=32,
        num_hidden_layers=1,
        intermediate_size=64,
        num_attention_heads=2,
        num_key_value_heads=2,
        rms_norm_eps=1e-5,
        vocab_size=64,
    )
    model = llama.Model(args)
    mx.eval(model.parameters())
    return model


def _drain(gen, uid):
    out = []
    while True:
        responses = gen.next_generated()
        for r in responses:
            if r.uid == uid:
                out.append(r.token)
                if r.finish_reason is not None:
                    return out


def test_constraint_holds_on_the_wave_after_a_plain_one():
    try:
        import mlx.core as mx
        from mlx_lm.generate import BatchGenerator
    except ModuleNotFoundError:
        print("  (skipped: mlx_lm not installed)")
        return
    model = _tiny_model()
    # Force a token the model would not pick on its own, so a lapsed
    # constraint shows in the tokens as well as in the call count.
    probe = BatchGenerator(model, max_tokens=6)
    [p] = probe.insert([[4, 5, 6]], max_tokens=[6], logits_processors=[bp.per_sequence_processors([])])
    natural = set(_drain(probe, p))
    a, b = [t for t in range(64) if t not in natural][:2]
    # Alternating, so a model that merely repeats its last input cannot
    # pass for a constraint that is still holding.
    wanted = [a, b] * 3

    gen = BatchGenerator(model, max_tokens=4)
    calls = []

    def force(tokens, logits):
        mask = mx.full(logits.shape, -1e9)
        mask[..., wanted[min(len(calls), len(wanted) - 1)]] = 0.0
        calls.append(1)
        return logits + mask

    [plain] = gen.insert([[1, 2, 3]], max_tokens=[4], logits_processors=[bp.per_sequence_processors([])])
    _drain(gen, plain)
    [constrained] = gen.insert([[4, 5, 6]], max_tokens=[6], logits_processors=[bp.per_sequence_processors([force])])
    tokens = _drain(gen, constrained)
    assert tokens == wanted, f"constraint lapsed after the first token: {tokens} (wanted {wanted})"
    assert len(calls) >= 6, f"processor ran {len(calls)} times for 6 tokens"


def test_lists_are_never_empty():
    assert bp.per_sequence_processors([]) == [bp.pass_through_logits]
    f = lambda t, l: l  # noqa: E731
    assert bp.per_sequence_processors([f]) == [f]
    assert bp.pass_through_logits(None, "logits") == "logits"


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
