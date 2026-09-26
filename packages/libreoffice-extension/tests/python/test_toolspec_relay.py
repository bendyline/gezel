import json
import threading
import unittest

import _path  # noqa: F401
from gezel.client import HttpError
from gezel.relay import Relay
from gezel.toolspec import MAX_CELLS, ToolInputError, markdown_blocks, tools_for


class FakeWriter:
    def __init__(self):
        self.inserted = []

    def selection_text(self):
        return "picked"

    def read_selection(self):
        return "Hello", [("Hello", "Default")]

    def read_paragraphs(self):
        return [(f"Paragraph {i} " + "x" * 400, "Default") for i in range(10)]

    def search(self, query, match_case, max_results):
        return 2, [("plan", "The plan is simple.")]

    def insert(self, text, where, markdown):
        self.inserted.append((text, where, markdown))

    def replace_selection(self, text, markdown):
        self.inserted.append((text, "selection", markdown))


class FakeCalc:
    def __init__(self, rows=2, cols=2):
        self.size = {"sheet": "Sheet1", "address": "$Sheet1.$A$1:$B$2", "rowCount": rows, "columnCount": cols}
        self.read_calls = 0
        self.writes = []

    def selection_text(self):
        return "1\t2"

    def list_sheets(self):
        return [{"name": "Sheet1", "visible": True, "usedRange": "A1:B2", "tables": []}]

    def measure(self, sheet, address):
        return dict(self.size)

    def read(self, sheet, address, formulas):
        self.read_calls += 1
        return {**self.size, "values": [[1, 2], [3, 4]]}

    def list_tables(self):
        return []

    def read_table(self, name, max_rows):
        return {"name": name, "rows": []}

    def write(self, sheet, address, values, formulas):
        self.writes.append((sheet, address, values, formulas))
        return "$Sheet1.$A$1:$B$2"


def describe():
    return {"host": "Writer", "title": "a.odt", "path": "/a.odt", "projectId": "p", "projectName": "P",
            "projectReadOnly": True, "editsEnabled": True}


def call(tools, name, args=None):
    tool = next(t for t in tools if t["name"] == name)
    return json.loads(tool["handler"](args or {}))


class ToolspecTests(unittest.TestCase):
    def test_same_names_as_the_office_pane(self):
        names = {t["name"] for t in tools_for("writer", True, describe, lambda: "", FakeWriter())}
        self.assertEqual(
            names,
            {"office_describe_document", "office_read_selection", "doc_read_selection", "doc_read", "doc_search",
             "doc_insert_text", "doc_replace_selection"},
        )
        for kind, adapter in (("writer", FakeWriter()), ("calc", FakeCalc())):
            for tool in tools_for(kind, True, describe, lambda: "", adapter):
                self.assertRegex(tool["name"], r"^[a-z][a-z0-9_]{1,63}$")
                self.assertEqual(tool["inputSchema"]["type"], "object")

    def test_edits_off_withdraws_write_tools(self):
        names = {t["name"] for t in tools_for("writer", False, describe, lambda: "", FakeWriter())}
        self.assertNotIn("doc_insert_text", names)
        self.assertNotIn("doc_replace_selection", names)
        calc = {t["name"] for t in tools_for("calc", False, describe, lambda: "", FakeCalc())}
        self.assertNotIn("sheet_write_range", calc)

    def test_writer_pagination_and_insert(self):
        writer = FakeWriter()
        tools = tools_for("writer", True, describe, lambda: "sel", writer)
        first = call(tools, "doc_read", {"maxChars": 1000})
        self.assertEqual([p["index"] for p in first["paragraphs"]], [0, 1])
        self.assertEqual(first["nextStart"], 2)
        call(tools, "doc_insert_text", {"text": "# Hi", "format": "markdown", "where": "end"})
        self.assertEqual(writer.inserted[-1], ("# Hi", "end", True))
        self.assertEqual(call(tools, "office_read_selection"), {"isEmpty": False, "text": "sel", "truncated": False})
        with self.assertRaises(ToolInputError):
            call(tools, "doc_insert_text", {"text": "x", "where": "middle"})

    def test_calc_cap_and_validation(self):
        big = FakeCalc(rows=1000, cols=26)
        tools = tools_for("calc", True, describe, lambda: "", big)
        self.assertTrue(call(tools, "sheet_read_range", {"address": "A1:Z1000"})["tooLarge"])
        self.assertEqual(big.read_calls, 0)
        calc = FakeCalc()
        tools = tools_for("calc", True, describe, lambda: "", calc)
        call(tools, "sheet_write_range", {"address": "A1", "values": [["a", None], [1, True]]})
        self.assertEqual(calc.writes[-1][2], [["a", ""], [1, True]])
        with self.assertRaises(ToolInputError):
            call(tools, "sheet_write_range", {"address": "A1", "values": [[1, 2], [3]]})
        with self.assertRaises(ToolInputError):
            call(tools, "sheet_write_range", {"address": "A1", "values": [[1]] * (MAX_CELLS + 1)})

    def test_markdown_blocks(self):
        self.assertEqual(
            markdown_blocks("# Title\n\nSome **bold** text\n\n- one\n- two\n1. first"),
            [("Title", "heading1"), ("Some bold text", "paragraph"), ("one", "bullet"), ("two", "bullet"),
             ("first", "numbered")],
        )


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.events_frames = []
        self.results = []

    def request_json(self, method, path, body=None, token=None, timeout=30.0):
        self.calls.append((method, path, body))
        if path == "/api/app-tools/relays":
            return {"relayId": "r1"}
        if path.endswith("/result"):
            self.results.append(body)
        return {}

    def events(self, path, token=None, timeout=90.0, stop=None):
        for frame in self.events_frames:
            yield frame
        stop.wait(2)


class RelayTests(unittest.TestCase):
    def test_answers_a_tool_call_on_the_main_thread(self):
        http = FakeHttp()
        http.events_frames = [json.dumps({"type": "tool_call", "callId": "c1", "tool": "echo", "arguments": {"x": 1}})]
        ran_on = []

        def run_on_main(fn):
            ran_on.append(threading.current_thread().name)
            return fn()

        tool = {"name": "echo", "description": "d", "inputSchema": {"type": "object"}, "handler": lambda a: json.dumps(a)}
        relay = Relay(http, "t", "p1", "Writer: a.odt", [tool], run_on_main, sleep=lambda _s: None)
        relay.start()
        for _ in range(100):
            if http.results:
                break
            threading.Event().wait(0.02)
        relay.stop()
        self.assertEqual(http.results[0], {"ok": True, "content": '{"x": 1}'})
        self.assertTrue(ran_on)
        published = next(c for c in http.calls if c[0] == "PUT")
        self.assertEqual(published[2]["projectId"], "p1")
        self.assertEqual(published[2]["tools"][0]["name"], "echo")
        self.assertTrue(any(c[0] == "DELETE" for c in http.calls))

    def test_a_failing_handler_is_an_ordinary_tool_failure(self):
        http = FakeHttp()
        http.events_frames = [json.dumps({"type": "tool_call", "callId": "c2", "tool": "boom", "arguments": {}})]

        def boom(_args):
            raise ToolInputError('"x" is required.')

        tool = {"name": "boom", "description": "d", "inputSchema": {"type": "object"}, "handler": boom}
        relay = Relay(http, "t", "p1", "x", [tool], lambda fn: fn(), sleep=lambda _s: None)
        relay.start()
        for _ in range(100):
            if http.results:
                break
            threading.Event().wait(0.02)
        relay.stop()
        self.assertEqual(http.results[0], {"ok": False, "error": '"x" is required.'})

    def test_unauthorized_stops_the_relay(self):
        class Refusing(FakeHttp):
            def request_json(self, method, path, body=None, token=None, timeout=30.0):
                raise HttpError(401, {"error": "unauthorized"})

        statuses = []
        relay = Relay(Refusing(), "t", "p", "x", [], lambda fn: fn(), on_status=statuses.append, sleep=lambda _s: None)
        relay.start()
        relay._thread.join(2)
        self.assertEqual(statuses[-1], "unauthorized")


if __name__ == "__main__":
    unittest.main()
