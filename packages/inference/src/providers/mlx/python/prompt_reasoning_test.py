"""Exercise the real prompt builder without importing MLX or loading weights."""
import ast
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any, Dict, List, Optional
import unittest

import think_budget


SOURCE = Path(__file__).with_name('gezel_mlx_server.py').read_text()
FUNCTION = next(n for n in ast.parse(SOURCE).body
                if isinstance(n, ast.FunctionDef) and n.name == '_build_prompt')
HEADERS = next(n for n in ast.parse(SOURCE).body
               if isinstance(n, ast.FunctionDef) and n.name == '_stream_headers')


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


class ReasoningOpenTests(unittest.TestCase):
    # The client seeds its live reasoning split from this; a wrong answer
    # streams the model's thoughts as its reply.
    def test_rendered_prompt_tails(self):
        cases = {
            # Qwen 3.5 0.8B renders this only for an explicit enable_thinking=True.
            '<|im_start|>assistant\n<think>\n': True,
            '<|im_start|>assistant\n<think>\n\n</think>\n\n': False,
            # Gemma 4 after a tool response, thinking on.
            '<|turn>model\n<|channel>thought\n': True,
            # Gemma 4 12B, thinking off.
            '<|turn>model\n<|channel>thought\n<channel|>': False,
            '<|turn>model\n': False,
            '[INST]hi[/INST][THINK]': True,
            '': False,
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt[-24:]):
                self.assertIs(think_budget.prompt_opens_reasoning(prompt), expected)

    # The response grammar waits for the closer of whichever block is open;
    # waiting for `</think>` on Gemma held its thought channel to the answer.
    def test_open_reasoning_names_its_closer(self):
        cases = {
            '<|im_start|>assistant\n<think>\n': ('<think>', '</think>'),
            '<|turn>model\n<|channel>thought\n': ('<|channel>', '<channel|>'),
            '[INST]hi[/INST][THINK]': ('[THINK]', '[/THINK]'),
            'assistant\n<reasoning>\n': ('<reasoning>', '</reasoning>'),
            '<|turn>model\n<|channel>thought\n<channel|>': None,
            '<|im_start|>assistant\n<think>\n\n</think>\n\n': None,
            '': None,
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt[-24:]):
                self.assertEqual(think_budget.open_reasoning_tags(prompt), expected)

    def test_every_stream_reports_it(self):
        namespace = dict(Dict=Dict, think_budget=think_budget)
        exec(compile(ast.Module(body=[HEADERS], type_ignores=[]), '<headers>', 'exec'), namespace)
        headers = namespace['_stream_headers']
        self.assertEqual(headers('assistant\n<think>\n')['X-Gezel-Reasoning-Open'], '1')
        self.assertEqual(headers('assistant\n')['X-Gezel-Reasoning-Open'], '0')
        self.assertEqual(headers('')['Cache-Control'], 'no-cache')
        # Text (batched + serial) and vision responses all carry it.
        self.assertEqual(SOURCE.count('headers=_stream_headers(prompt_text)'), 2)
        self.assertEqual(SOURCE.count('headers=_stream_headers(prompt)'), 1)
        self.assertNotIn('headers={"Cache-Control"', SOURCE)


if __name__ == '__main__':
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite([loader.loadTestsFromTestCase(PromptThinkingTests),
                                loader.loadTestsFromTestCase(ReasoningOpenTests)])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('PASS prompt reasoning controls')
