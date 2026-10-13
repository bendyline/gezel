"""No-weight regression coverage for image bounds, cache isolation and GPU ownership."""
import ast
import asyncio
import base64
import io
import json
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
import uuid

import vision_inputs

SOURCE = Path(__file__).with_name('gezel_mlx_server.py').read_text()
TREE = ast.parse(SOURCE)


class VisionTests(unittest.TestCase):
    def test_image_rope_state_cannot_contaminate_following_text(self):
        tower = NS(_position_ids='text-positions', _rope_deltas='text-deltas')
        with self.assertRaises(RuntimeError):
            with vision_inputs.isolated_position_state(NS(language_model=tower)):
                self.assertIsNone(tower._position_ids)
                tower._rope_deltas = 'image-deltas'
                raise RuntimeError('cancelled')
        self.assertEqual(tower._position_ids, 'text-positions')
        self.assertEqual(tower._rope_deltas, 'text-deltas')
    def test_placeholders_stay_in_the_message_that_owns_the_pixels(self):
        self.assertEqual(vision_inputs.message_content(NS(content='Inspect', images=['one', 'two'])),
                         [{'type':'image'}, {'type':'image'}, {'type':'text', 'text':'Inspect'}])
        with self.assertRaises(ValueError):
            vision_inputs.message_content(NS(content=[{'type':'image_url','image_url':'https://x'}], images=[]))

    def test_decode_real_pixels_and_reject_external_or_unbounded_inputs(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest('Pillow not installed; run this case in the MLX venv')
        buffer = io.BytesIO()
        Image.new('RGB', (2000, 1000), 'red').save(buffer, format='PNG')
        images = vision_inputs.decode_images([NS(images=[base64.b64encode(buffer.getvalue()).decode()])])
        self.assertEqual(images[0].size, (1024, 512))
        self.assertEqual(images[0].getpixel((0,0)), (255,0,0))
        for image in images: image.close()
        for values in [['https://example.test/image.png'], ['a'] * 33, ['a' * (12 * 1024 * 1024)]]:
            with self.assertRaises(ValueError):
                vision_inputs.decode_images([NS(images=values)])

    def test_vision_uses_pixels_without_text_cache_and_releases_generator_on_disconnect(self):
        async def run():
            function = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_vision_stream')
            lock = asyncio.Lock()
            calls, closed = [], []
            image = NS(close=lambda: closed.append('image'))
            def generate(**kwargs):
                calls.append(kwargs)
                try:
                    yield NS(text='seen', prompt_tokens=45, generation_tokens=1)
                    yield NS(text='next', prompt_tokens=45, generation_tokens=2)
                finally:
                    closed.append('generator')
            checks = 0
            async def disconnected():
                nonlocal checks
                checks += 1
                return checks > 2
            ns = dict(asyncio=asyncio, json=json, uuid=uuid, MODEL=object(), PROCESSOR=object(),
                      vision_inputs=vision_inputs,
                      ARGS=NS(prefill_step_size=128), _kv_quant_kwargs=lambda:{},
                      _build_prompt=lambda *args:'prompt', stream_generate=generate,
                      _get_generation_lock=lambda:lock, _scrub_leaked_markers=lambda s:s,
                      _reclaim_mlx_buffer_cache=lambda *a, **kw:None,
                      log_contained_exception=lambda tag:self.fail(tag))
            exec(compile(ast.Module(body=[function], type_ignores=[]), '<vision>', 'exec'), ns)
            request=NS(messages=[], tools=None, chat_template_override=None, chat_template_kwargs=None,
                       model='test', max_tokens=8, tool_grammar=None, max_thinking_tokens=None)
            parts=[p async for p in ns['_vision_stream'](request, NS(is_disconnected=disconnected), [image])]
            self.assertEqual(len(parts), 1)
            self.assertEqual(calls[0]['image'], [image])
            self.assertNotIn('prompt_cache_state', calls[0])
            self.assertEqual(closed, ['generator','image'])
            self.assertFalse(lock.locked())
        asyncio.run(run())

    def test_vision_waits_for_complete_text_wave_and_precedes_next_wave(self):
        async def run():
            cls=next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name=='BatchEngine')
            method=next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name=='_run')
            lock=asyncio.Lock(); started=asyncio.Event(); order=[]
            ns=dict(asyncio=asyncio, _get_generation_lock=lambda:lock)
            exec(compile(ast.Module(body=[method], type_ignores=[]), '<wave>', 'exec'), ns)
            state=NS(_pending=[1,2], _subs={}, _wake=asyncio.Event())
            async def step():
                if not state._subs:
                    n=state._pending.pop(0); state._subs[n]=True
                    order.append(f'text{n}-start'); started.set()
                    await asyncio.sleep(0)
                else:
                    n=next(iter(state._subs)); order.append(f'text{n}-end'); state._subs.clear()
            state._step_wave=step
            worker=asyncio.create_task(ns['_run'](state))
            await started.wait()
            async with lock: order.append('vision')
            while state._pending or state._subs: await asyncio.sleep(0)
            worker.cancel()
            try: await worker
            except asyncio.CancelledError: pass
            self.assertEqual(order, ['text1-start','text1-end','vision','text2-start','text2-end'])
        asyncio.run(run())


if __name__ == '__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(VisionTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful(): raise SystemExit(1)
    print('PASS vision inputs and scheduling')
