"""
gezel_video_server — a small HTTP server around `diffusers` that turns a
text (or image) prompt into a short video clip (LTX today; WAN via the
same server once a `--family wan` model is installed).

Design notes
------------
* **stdlib only for the server.** We use `http.server` rather than
  FastAPI/uvicorn so the video venv stays lean — the heavy dependency is
  already torch + diffusers. The server runs one generation at a time
  (GPU-bound), so a threading server with a generation lock is plenty.

* **Lazy model load.** torch/diffusers imports and the pipeline load are
  deferred to the first `/generate` so `/health` answers immediately once
  the socket is listening (the supervisor's readiness probe doesn't pay a
  multi-minute model load). The first generation is therefore slow; every
  one after reuses the resident pipeline.

* **Progress to stdout.** Each sampling step prints `step N/M` on its own
  line. The TS provider subscribes to the supervisor's log stream and
  parses these into `onProgress` events — the same mechanism the sd-cpp
  image engine uses.

* **Offline.** Weights are pre-downloaded and sha256-verified by the TS
  `VideoModelManager`; we run with `HF_HUB_OFFLINE=1` so diffusers never
  reaches for the network.

Request/response (POST /generate, JSON):
    in : { prompt, negativePrompt?, numFrames?, fps?, width?, height?,
            steps?, seed?, inputImage? (base64 png) }
    out: { video: <base64 mp4>, poster: <base64 png>, meta: { ... } }
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional


def log(msg: str) -> None:
    """Single-line stdout log; the TS supervisor captures these."""
    print(f"[video-server] {msg}", flush=True)


# Per-family default negative prompt. These mirror the strings the
# official LTX / WAN diffusers examples ship — they materially improve
# output quality and every reference pipeline includes one.
# LTX-2 audio is generated at 24 kHz (per the diffusers LTX-2 reference).
LTX2_AUDIO_SAMPLE_RATE = 24000

DEFAULT_NEGATIVE_PROMPT = {
    "ltx": "worst quality, inconsistent motion, blurry, jittery, distorted",
    "ltx2": "worst quality, inconsistent motion, blurry, jittery, distorted, static",
    "wan": (
        "bright tones, overexposed, static, blurred details, subtitles, style, works, "
        "paintings, images, static, overall gray, worst quality, low quality, "
        "JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, "
        "poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, "
        "still picture, messy background, three legs, many people in the background, "
        "walking backwards"
    ),
}


class Engine:
    """Holds the lazily-loaded diffusers pipeline for one model dir.

    The pipeline shape is driven by catalog-supplied load config so a new
    checkpoint is data, not an engine edit:

    * ``pipeline_class`` pins the exact diffusers class (the 0.9.7/0.9.8
      repos omit ``_class_name`` from ``model_index.json``, and two ``ltx``
      models can want different classes), falling back to family/auto
      detection when unset.
    * ``load_strategy`` is ``diffusers-tree`` (``from_pretrained`` over a
      full repo) or ``single-file`` (build the transformer from one
      checkpoint with ``from_single_file`` and graft it onto the component
      subfolders — how LTX-2.3's fp8 transformer rides the LTX-2 stack).
    * ``vae_dtype`` forces the VAE precision independent of the transformer
      (WAN and LTX-2 need a float32 VAE or the decode washes out).
    * ``audio`` muxes the LTX-2 audio track into the MP4.
    """

    def __init__(
        self,
        model_dir: str,
        family: str,
        accelerator: str,
        *,
        pipeline_class: Optional[str] = None,
        load_strategy: str = "diffusers-tree",
        single_file_name: Optional[str] = None,
        transformer_class: Optional[str] = None,
        vae_dtype: Optional[str] = None,
        audio: bool = False,
    ) -> None:
        self.model_dir = model_dir
        self.family = family
        self.accelerator = accelerator
        self.pipeline_class = pipeline_class
        self.load_strategy = load_strategy
        self.single_file_name = single_file_name
        self.transformer_class = transformer_class
        self.vae_dtype = vae_dtype
        self.audio = audio
        self._pipe: Any = None
        self._pipe_sig: Optional[str] = None  # the loaded pipeline class name
        self._ltx_condition = False  # True for the *Condition unified pipelines
        self._lock = threading.Lock()

    # ── device / dtype ────────────────────────────────────────────────
    def _device(self) -> str:
        return {"cuda": "cuda", "mps": "mps", "cpu": "cpu"}.get(self.accelerator, "cpu")

    def _dtype(self):  # noqa: ANN201 - torch dtype
        import torch

        # LTX and WAN are both designed for bfloat16. fp16 has too small a
        # range for these diffusion transformers + their video VAEs — on
        # MPS it doesn't NaN outright but it decodes into heavy grain (the
        # subject forms, then drowns in snow). Modern torch supports bf16
        # on MPS, so use it everywhere except the CPU fallback (where bf16
        # is slow/unsupported for many ops → fp32).
        if self.accelerator == "cpu":
            return torch.float32
        return torch.bfloat16

    # ── pipeline construction ─────────────────────────────────────────
    def _model_index_class(self) -> Optional[str]:
        """The `_class_name` diffusers recorded in model_index.json — tells
        us which concrete pipeline a repo wants (e.g. the LTX 0.9.7
        *distilled* model declares `LTXConditionPipeline`, not `LTXPipeline`)."""
        try:
            with open(os.path.join(self.model_dir, "model_index.json")) as f:
                return json.load(f).get("_class_name")
        except Exception:  # noqa: BLE001
            return None

    def _import_diffusers_class(self, name: str):  # noqa: ANN201
        """Resolve a diffusers export by name (pipeline / model / VAE)."""
        import importlib

        return getattr(importlib.import_module("diffusers"), name)

    # Per-family VAE class, for the precision override below.
    _VAE_CLASS = {
        "ltx": "AutoencoderKLLTXVideo",
        "ltx2": "AutoencoderKLLTX2Video",
        "wan": "AutoencoderKLWan",
    }
    # Per-family transformer class, for the single-file load path.
    _TRANSFORMER_CLASS = {
        "ltx": "LTXVideoTransformer3DModel",
        "ltx2": "LTX2VideoTransformer3DModel",
    }

    def _resolve_pipeline_class(self, want_i2v: bool):  # noqa: ANN201
        """Return (PipelineClass, is_condition).

        An explicit catalog ``pipeline_class`` always wins (the 0.9.7/0.9.8
        repos omit ``_class_name`` from ``model_index.json``, and the LTX
        family spans both ``LTXPipeline`` and ``LTXConditionPipeline``).
        Otherwise fall back to the legacy ``model_index.json`` sniff (base
        LTX repo) and then to per-family t2v/i2v defaults."""
        explicit = self.pipeline_class or (
            self._model_index_class() if self.family in ("ltx", "ltx2") else None
        )
        if explicit:
            return self._import_diffusers_class(explicit), explicit.endswith("ConditionPipeline")
        defaults = {
            "ltx": ("LTXImageToVideoPipeline" if want_i2v else "LTXPipeline"),
            "ltx2": ("LTX2ImageToVideoPipeline" if want_i2v else "LTX2Pipeline"),
            "wan": ("WanImageToVideoPipeline" if want_i2v else "WanPipeline"),
        }
        name = defaults.get(self.family)
        if not name:
            raise ValueError(f"unknown model family: {self.family}")
        return self._import_diffusers_class(name), False

    def _resolve_vae_dtype(self):  # noqa: ANN201
        """VAE precision, independent of the transformer dtype. WAN always
        needs float32; LTX-2 declares it via ``vae_dtype``. ``None`` → leave
        the VAE at the transformer dtype (LTX 0.9.x)."""
        import torch

        if self.vae_dtype == "float32" or self.family == "wan":
            return torch.float32
        if self.vae_dtype == "bfloat16":
            return torch.bfloat16
        return None

    def _build_single_file_transformer(self, dtype):  # noqa: ANN201
        """Build the transformer from one checkpoint (``single-file``
        strategy) so an out-of-tree checkpoint (e.g. LTX-2.3's fp8
        transformer) can ride a different repo's component stack."""
        if not self.single_file_name:
            raise ValueError("single-file load strategy requires --single-file-name")
        cls_name = self.transformer_class or self._TRANSFORMER_CLASS.get(self.family)
        if not cls_name:
            raise ValueError(f"no transformer class known for single-file family '{self.family}'")
        path = os.path.join(self.model_dir, self.single_file_name)
        # `from_single_file` still needs the transformer's *config*. Without an
        # explicit ``config=``, diffusers resolves it from a built-in
        # checkpoint→repo map (LTX → ``Lightricks/LTX-Video-0.9.7-dev``) and
        # fetches ``transformer/config.json`` from the Hub — which fails under
        # our ``HF_HUB_OFFLINE=1``. Point it at the local component tree so the
        # load stays offline; the catalog ships ``transformer/config.json``
        # next to the single-file checkpoint for exactly this.
        config_json = os.path.join(self.model_dir, "transformer", "config.json")
        if not os.path.exists(config_json):
            raise FileNotFoundError(
                f"single-file transformer requires {config_json}; the model's catalog "
                "entry must list `transformer/config.json` in its files so it lands on disk"
            )
        log(f"building transformer from single file {self.single_file_name} ({cls_name})")
        return self._import_diffusers_class(cls_name).from_single_file(
            path,
            config=self.model_dir,
            subfolder="transformer",
            local_files_only=True,
            torch_dtype=dtype,
        )

    def _build_pipeline(self, pipe_class):  # noqa: ANN001,ANN201
        dtype = self._dtype()
        from_pretrained_kwargs = {"torch_dtype": dtype}

        # VAE precision override (WAN/LTX-2 decode washes out in low
        # precision). Loaded separately so the transformer stays at `dtype`.
        vae_dtype = self._resolve_vae_dtype()
        vae_cls_name = self._VAE_CLASS.get(self.family)
        if vae_dtype is not None and vae_cls_name:
            from_pretrained_kwargs["vae"] = self._import_diffusers_class(vae_cls_name).from_pretrained(
                self.model_dir, subfolder="vae", torch_dtype=vae_dtype
            )

        # Single-file: graft the checkpoint's transformer onto the component
        # subfolders that `from_pretrained` loads from disk.
        if self.load_strategy == "single-file":
            from_pretrained_kwargs["transformer"] = self._build_single_file_transformer(dtype)

        pipe = pipe_class.from_pretrained(self.model_dir, **from_pretrained_kwargs)

        # MPS has no float64: force LTX-2 RoPE tables to float32 (see helper).
        self._patch_rope_for_mps(pipe)

        # The 19–22B LTX-2 models don't fit alongside their Gemma text
        # encoder in VRAM, so stream submodules on/off the GPU on CUDA. For
        # the smaller models (and MPS, which lacks the accelerate hooks) a
        # plain device move is faster.
        if (
            self.family == "ltx2"
            and self.accelerator == "cuda"
            and hasattr(pipe, "enable_model_cpu_offload")
        ):
            pipe.enable_model_cpu_offload()
        else:
            pipe.to(self._device())
        # Free VRAM headroom: slice attention + tile the VAE decode on
        # constrained devices. Cheap insurance against OOM on the final
        # decode step (where the whole latent video is materialized).
        if hasattr(pipe, "enable_attention_slicing"):
            try:
                pipe.enable_attention_slicing()
            except Exception:  # noqa: BLE001
                pass
        if self.accelerator == "cuda" and hasattr(pipe, "enable_vae_tiling"):
            try:
                pipe.enable_vae_tiling()
            except Exception:  # noqa: BLE001
                pass
        return pipe

    def _patch_rope_for_mps(self, pipe) -> None:  # noqa: ANN001
        """MPS has no float64. LTX-2's RoPE — in both the transformer and the
        text connector — builds its frequency table in float64 when
        ``rope_double_precision`` is set, which raises on MPS. The table is cast
        to float32 immediately afterward, so forcing float32 here is numerically
        negligible while making the LTX-2 family runnable on Apple Silicon. We
        flip the live `double_precision` flag on every module that carries it
        (the flag is read at forward time), across all pipeline components."""
        if self._device() != "mps":
            return
        patched = 0
        for component in getattr(pipe, "components", {}).values():
            if not hasattr(component, "modules"):
                continue
            for module in component.modules():
                if getattr(module, "double_precision", False):
                    module.double_precision = False
                    patched += 1
        if patched:
            log(f"patched {patched} RoPE module(s) to float32 (MPS has no float64)")

    def _ensure_pipeline(self, want_i2v: bool):  # noqa: ANN201
        pipe_class, is_condition = self._resolve_pipeline_class(want_i2v)
        sig = pipe_class.__name__
        kind = "i2v" if want_i2v else "t2v"
        # Cache by pipeline CLASS, not kind: the unified LTXConditionPipeline
        # serves both t2v and i2v, so we don't reload 47 GB just to switch.
        if self._pipe is not None and self._pipe_sig == sig:
            return self._pipe
        # The TS warm-up status parser matches "loading <family> <kind> pipeline".
        log(f"loading {self.family} {kind} pipeline ({sig}) on {self._device()} …")
        self._pipe = self._build_pipeline(pipe_class)
        self._pipe_sig = sig
        self._ltx_condition = is_condition
        log("pipeline ready")
        return self._pipe

    # ── generation ────────────────────────────────────────────────────
    def generate(self, req: Dict[str, Any]) -> Dict[str, Any]:
        import torch
        from diffusers.utils import export_to_video

        prompt = req.get("prompt") or ""
        # A negative prompt is not optional polish for these models — the
        # canonical LTX/WAN pipelines always pass one, and omitting it is a
        # primary cause of grainy, low-quality output. Fall back to the
        # family's standard negative when the caller doesn't supply one.
        negative = req.get("negativePrompt") or DEFAULT_NEGATIVE_PROMPT.get(
            self.family, DEFAULT_NEGATIVE_PROMPT["ltx"]
        )
        num_frames = int(req.get("numFrames") or 97)
        fps = int(req.get("fps") or 24)
        width = int(req.get("width") or 704)
        height = int(req.get("height") or 480)
        steps = int(req.get("steps") or 40)
        # Classifier-free guidance. Distilled few-step models want ≈1, dev
        # models ≈3 (LTX-2 ≈4). None → the pipeline's own default.
        guidance_scale = req.get("guidanceScale")
        seed = req.get("seed")
        input_image_b64 = req.get("inputImage")

        want_i2v = bool(input_image_b64)
        # Only one generation at a time — the GPU can't share anyway, and
        # the resident pipeline isn't reentrant.
        with self._lock:
            pipe = self._ensure_pipeline(want_i2v)

            device = self._device()
            generator = None
            if seed is not None:
                generator = torch.Generator(device=device if device != "mps" else "cpu")
                generator = generator.manual_seed(int(seed))

            def on_step(_pipe, step_index, _timestep, callback_kwargs):
                # diffusers calls this after each denoising step; emit a
                # line the TS side parses into onProgress.
                log(f"step {step_index + 1}/{steps}")
                return callback_kwargs

            kwargs: Dict[str, Any] = dict(
                prompt=prompt,
                width=width,
                height=height,
                num_frames=num_frames,
                num_inference_steps=steps,
                callback_on_step_end=on_step,
            )
            if negative:
                kwargs["negative_prompt"] = negative
            if guidance_scale is not None:
                kwargs["guidance_scale"] = float(guidance_scale)
            # LTX-2 takes the clip frame rate as a generation parameter (it
            # conditions motion on it); LTX 0.9.x only uses fps at encode.
            if self.family == "ltx2":
                kwargs["frame_rate"] = float(fps)
            if generator is not None:
                kwargs["generator"] = generator
            if want_i2v:
                kwargs["image"] = _decode_image(input_image_b64)

            result = pipe(**kwargs)
            frames = result.frames[0]
            # LTX-2 also returns a synchronized audio waveform [B, C, samples].
            audio = getattr(result, "audio", None)

        # Encode to mp4 in a temp file (the encoders want a path), read the
        # bytes back, and pull a PNG poster from the first frame.
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "out.mp4")
            if self.audio and audio is not None:
                # Mux the LTX-2 audio track alongside the frames.
                from diffusers.pipelines.ltx2.export_utils import encode_video

                encode_video(
                    video=frames,
                    fps=fps,
                    audio=audio[0].float().cpu(),
                    audio_sample_rate=LTX2_AUDIO_SAMPLE_RATE,
                    output_path=out_path,
                )
            else:
                export_to_video(frames, out_path, fps=fps)
            video_bytes = Path(out_path).read_bytes()

        poster_b64 = _poster_png_b64(frames[0])
        return {
            "video": base64.b64encode(video_bytes).decode("ascii"),
            "poster": poster_b64,
            "meta": {
                "widthPx": width,
                "heightPx": height,
                "numFrames": num_frames,
                "fps": fps,
                "steps": steps,
                "seed": int(seed) if seed is not None else -1,
                "mimeType": "video/mp4",
            },
        }


def _decode_image(b64: str):  # noqa: ANN201 - PIL image
    from PIL import Image

    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _poster_png_b64(frame: Any) -> str:
    """First frame → base64 PNG. `frame` is a PIL image or a numpy array."""
    from PIL import Image
    import numpy as np

    if isinstance(frame, Image.Image):
        img = frame
    else:
        arr = np.asarray(frame)
        if arr.dtype != np.uint8:
            arr = (arr * 255).clip(0, 255).astype("uint8")
        img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def make_handler(engine: Engine):  # noqa: ANN201
    class Handler(BaseHTTPRequestHandler):
        # Quiet the default per-request stderr logging; we log ourselves.
        def log_message(self, *_args: Any) -> None:  # noqa: D401
            pass

        def _send_json(self, code: int, payload: Dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send_json(200, {"status": "ok", "accelerator": engine.accelerator})
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/generate":
                self._send_json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                req = json.loads(raw or b"{}")
            except Exception as err:  # noqa: BLE001
                self._send_json(400, {"error": f"bad request: {err}"})
                return
            try:
                out = engine.generate(req)
                self._send_json(200, out)
            except Exception as err:  # noqa: BLE001
                log(f"generation failed: {err}\n{traceback.format_exc()}")
                self._send_json(500, {"error": str(err)})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="path to the model directory")
    parser.add_argument("--family", default="ltx", choices=["ltx", "ltx2", "wan"])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--accelerator", default="cpu", choices=["cuda", "mps", "cpu"])
    # Catalog-driven load descriptor (see Engine docstring). All optional —
    # a plain diffusers-tree model needs none of these.
    parser.add_argument("--pipeline-class", default=None, help="explicit diffusers pipeline class")
    parser.add_argument(
        "--load-strategy", default="diffusers-tree", choices=["diffusers-tree", "single-file"]
    )
    parser.add_argument("--single-file-name", default=None, help="single-file: transformer checkpoint")
    parser.add_argument("--transformer-class", default=None, help="single-file: transformer model class")
    parser.add_argument("--vae-dtype", default=None, choices=["float32", "bfloat16"])
    parser.add_argument("--audio", action="store_true", help="mux the pipeline's audio track")
    args = parser.parse_args()

    # Belt-and-suspenders: the supervisor sets these too, but pin offline
    # here so a stray import can't reach the network.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    engine = Engine(
        args.model,
        args.family,
        args.accelerator,
        pipeline_class=args.pipeline_class,
        load_strategy=args.load_strategy,
        single_file_name=args.single_file_name,
        transformer_class=args.transformer_class,
        vae_dtype=args.vae_dtype,
        audio=args.audio,
    )
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine))
    log(
        f"listening on http://{args.host}:{args.port} (family={args.family}, "
        f"accel={args.accelerator}, strategy={args.load_strategy}, "
        f"pipeline={args.pipeline_class or 'auto'})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
