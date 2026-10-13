"""Exercise the real prompt builder without importing MLX or loading weights."""
import ast
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any, Dict, List, Optional
import unittest


SOURCE = Path(__file__).with_name('gezel_mlx_server.py').read_text()
FUNCTION = next(n for n in ast.parse(SOURCE).body
                if isinstance(n, ast.FunctionDef) and n.name == '_build_prompt')


class Tokenizer:
    def __init__(self, reject_depth=False):
        self.calls = []
        self.reject_depth = reject_depth

    def apply_chat_template(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        if self.reject_depth and 'reasoning_effort' in kwargs:
            raise RuntimeError('unsupported depth')
        # Qwen's generation suffix: omitting the switch opens reasoning.
        return '<think>\n' if kwargs.get('enable_thinking', True) else '<think>\n\n</think>\n\n'


def builder(tokenizer, tower='mlx_lm', wrapped=False):
    fallback = []
    def vlm_fallback(*args):
        fallback.append(args)
        return 'legacy vlm prompt'
    namespace = dict(List=List, Dict=Dict, Any=Any, Optional=Optional, ChatMessageReq=NS,
                     PROCESSOR=NS(tokenizer=tokenizer) if wrapped else tokenizer,
                     MODEL=NS(config={}), STABLE_CHAT_TEMPLATE=None, _TEXT_TOWER=tower,
                     _REASONING_DEPTH_KWARGS=frozenset({'reasoning_effort', 'reasoning_strength'}),
                     vision_inputs=NS(message_content=lambda m: m.content),
                     apply_chat_template=vlm_fallback)
    exec(compile(ast.Module(body=[FUNCTION], type_ignores=[]), '<prompt>', 'exec'), namespace)
    return namespace['_build_prompt'], fallback


def message(images=None):
    return NS(role='user', content='Rewrite this clearly.', tool_calls=None,
              tool_call_id=None, images=images)


class PromptThinkingTests(unittest.TestCase):
    def test_text_only_off_reaches_both_towers_and_processor_shapes(self):
        for tower in ('mlx_lm', 'mlx_vlm'):
            for wrapped in (False, True):
                with self.subTest(tower=tower, wrapped=wrapped):
                    tok = Tokenizer()
                    render, fallback = builder(tok, tower, wrapped)
                    prompt = render([message()], chat_template_kwargs={'enable_thinking': False})
                    self.assertEqual(prompt, '<think>\n\n</think>\n\n')
                    self.assertIs(tok.calls[-1][1]['enable_thinking'], False)
                    self.assertEqual(fallback, [])

    def test_text_only_on_and_depth_are_forwarded(self):
        for kwargs in ({'enable_thinking': True}, {'reasoning_effort': 'medium'},
                       {'enable_thinking': False, 'reasoning_strength': 'low'}):
            with self.subTest(kwargs=kwargs):
                tok = Tokenizer()
                render, _ = builder(tok)
                render([message()], chat_template_kwargs=kwargs)
                for key, value in kwargs.items():
                    self.assertEqual(tok.calls[-1][1][key], value)

    def test_rejected_depth_retains_the_off_switch_without_tools(self):
        tok = Tokenizer(reject_depth=True)
        render, _ = builder(tok)
        with contextlib.redirect_stdout(io.StringIO()):
            prompt = render([message()], chat_template_kwargs={
                'enable_thinking': False, 'reasoning_effort': 'unsupported'})
        self.assertEqual(prompt, '<think>\n\n</think>\n\n')
        self.assertEqual(len(tok.calls), 2)
        self.assertIs(tok.calls[-1][1]['enable_thinking'], False)

    def test_existing_tool_override_and_image_paths_still_honor_off(self):
        tool = {'type': 'function', 'function': {'name': 'lookup'}}
        for inputs in ({'tools': [tool]}, {'chat_template_override': 'custom'},
                       {'messages': [message(images=['image'])]}):
            with self.subTest(inputs=inputs):
                tok = Tokenizer()
                render, _ = builder(tok)
                options = {'messages': [message()], **inputs}
                prompt = render(**options, chat_template_kwargs={'enable_thinking': False})
                self.assertEqual(prompt, '<think>\n\n</think>\n\n')
                if 'tools' in inputs:
                    self.assertEqual(tok.calls[-1][1]['tools'], [tool])
                if 'chat_template_override' in inputs:
                    self.assertEqual(tok.calls[-1][1]['chat_template'], 'custom')

    def test_unspecified_or_empty_controls_preserve_legacy_path(self):
        for kwargs in (None, {}):
            tok = Tokenizer()
            render, _ = builder(tok)
            self.assertEqual(render([message()], chat_template_kwargs=kwargs), '<think>\n')
            self.assertNotIn('enable_thinking', tok.calls[-1][1])
            render, fallback = builder(tok, 'mlx_vlm')
            self.assertEqual(render([message()], chat_template_kwargs=kwargs), 'legacy vlm prompt')
            self.assertEqual(len(fallback), 1)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(PromptThinkingTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('PASS prompt reasoning controls')
