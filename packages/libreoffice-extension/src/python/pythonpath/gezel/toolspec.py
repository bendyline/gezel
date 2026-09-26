"""The document tools, as JSON-schema definitions plus handlers over small
adapter objects. The same names, caps, and behavior as the Office pane, so a
gezel's habits carry across both suites. UNO lives in `uno_docs.py`; this
module is pure and unit-tested with fake adapters."""

from __future__ import annotations

import json

RESULT_CHAR_BUDGET = 60_000
MAX_CELLS = 5_000
MAX_INSERT_CHARS = 50_000
READ_TIMEOUT_MS = 20_000
WRITE_TIMEOUT_MS = 60_000


class ToolInputError(Exception):
    pass


def _str(args, name, required=False, max_len=None):
    value = args.get(name)
    if value is None or value == "":
        if required:
            raise ToolInputError(f'"{name}" is required.')
        return None
    if not isinstance(value, str):
        raise ToolInputError(f'"{name}" must be a string.')
    if max_len is not None and len(value) > max_len:
        raise ToolInputError(f'"{name}" is too long ({len(value)} characters; at most {max_len}).')
    return value


def _int(args, name, lo, hi, fallback):
    value = args.get(name)
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, int):
        raise ToolInputError(f'"{name}" must be a whole number.')
    if value < lo or value > hi:
        raise ToolInputError(f'"{name}" must be between {lo} and {hi}.')
    return value


def _bool(args, name, fallback):
    value = args.get(name)
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    raise ToolInputError(f'"{name}" must be true or false.')


def _enum(args, name, allowed, fallback):
    value = args.get(name)
    if value in (None, ""):
        return fallback
    if value in allowed:
        return value
    raise ToolInputError(f'"{name}" must be one of: {", ".join(allowed)}.')


def clip(text, limit=RESULT_CHAR_BUDGET):
    return (text[:limit], True) if len(text) > limit else (text, False)


def _json(value):
    return json.dumps(value, ensure_ascii=False)


def _tool(name, description, properties, handler, required=(), write=False, timeout=READ_TIMEOUT_MS):
    schema = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = list(required)
    return {
        "name": name,
        "description": description,
        "inputSchema": schema,
        "timeoutMs": timeout,
        "handler": handler,
        "write": write,
    }


# ── common ───────────────────────────────────────────────────────────────

def common_tools(describe, read_selection):
    def describe_handler(_args):
        return _json(describe())

    def selection_handler(_args):
        text = read_selection() or ""
        clipped, truncated = clip(text)
        return _json({"isEmpty": not text.strip(), "text": clipped, "truncated": truncated})

    return [
        _tool(
            "office_describe_document",
            "Describe the document open beside this chat: which app, its name and location, its gezel project, and whether you may edit it.",
            {},
            describe_handler,
        ),
        _tool(
            "office_read_selection",
            "Read the text the user has selected in the open document.",
            {},
            selection_handler,
        ),
    ]


# ── Writer ───────────────────────────────────────────────────────────────

def writer_tools(doc):
    def read_selection(_args):
        text, paragraphs = doc.read_selection()
        clipped, truncated = clip(text)
        return _json(
            {
                "isEmpty": not text.strip(),
                "text": clipped,
                "truncated": truncated,
                "paragraphs": None if truncated else [{"text": t, "style": s} for t, s in paragraphs],
            }
        )

    def read(args):
        start = _int(args, "start", 0, 10_000_000, 0)
        budget = _int(args, "maxChars", 1000, RESULT_CHAR_BUDGET, RESULT_CHAR_BUDGET)
        allp = doc.read_paragraphs()
        out, used, index = [], 0, start
        while index < len(allp):
            text, style = allp[index]
            if out and used + len(text) > budget:
                break
            clipped, _ = clip(text, budget)
            out.append({"index": index, "text": clipped, "style": style})
            used += len(clipped)
            index += 1
        return _json({"totalParagraphs": len(allp), "paragraphs": out, "nextStart": index if index < len(allp) else None})

    def search(args):
        query = _str(args, "query", required=True, max_len=255)
        match_case = _bool(args, "matchCase", False)
        max_results = _int(args, "maxResults", 1, 50, 20)
        total, matches = doc.search(query, match_case, max_results)
        return _json(
            {
                "total": total,
                "matches": [
                    {"index": i, "text": t, "paragraph": clip(p, 600)[0]} for i, (t, p) in enumerate(matches)
                ],
            }
        )

    def insert(args):
        text = _str(args, "text", required=True, max_len=MAX_INSERT_CHARS)
        where = _enum(args, "where", ("cursor", "start", "end"), "cursor")
        fmt = _enum(args, "format", ("plain", "markdown"), "plain")
        doc.insert(text, where, fmt == "markdown")
        return _json({"inserted": True, "where": where, "characters": len(text)})

    def replace(args):
        text = _str(args, "text", max_len=MAX_INSERT_CHARS) or ""
        fmt = _enum(args, "format", ("plain", "markdown"), "plain")
        doc.replace_selection(text, fmt == "markdown")
        return _json({"replaced": True, "characters": len(text)})

    text_fmt = {"type": "string", "enum": ["plain", "markdown"]}
    return [
        _tool(
            "doc_read_selection",
            "Read the text the user has selected in the open Writer document, paragraph by paragraph. Empty when nothing is selected.",
            {},
            read_selection,
        ),
        _tool(
            "doc_read",
            "Read the open Writer document paragraph by paragraph. Returns paragraphs from `start` until about `maxChars` characters, and `nextStart` to continue (null at the end).",
            {
                "start": {"type": "integer", "minimum": 0},
                "maxChars": {"type": "integer", "minimum": 1000, "maximum": RESULT_CHAR_BUDGET},
            },
            read,
        ),
        _tool(
            "doc_search",
            "Find text in the open Writer document. Returns each match with the paragraph around it.",
            {
                "query": {"type": "string", "minLength": 1, "maxLength": 255},
                "matchCase": {"type": "boolean"},
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            search,
            required=("query",),
        ),
        _tool(
            "doc_insert_text",
            'Insert text into the open Writer document at the cursor, the start, or the end. Use format "markdown" for headings and lists.',
            {
                "text": {"type": "string", "minLength": 1, "maxLength": MAX_INSERT_CHARS},
                "where": {"type": "string", "enum": ["cursor", "start", "end"]},
                "format": text_fmt,
            },
            insert,
            required=("text",),
            write=True,
            timeout=WRITE_TIMEOUT_MS,
        ),
        _tool(
            "doc_replace_selection",
            'Replace the text the user has selected in the open Writer document. Use format "markdown" for headings and lists.',
            {"text": {"type": "string", "maxLength": MAX_INSERT_CHARS}, "format": text_fmt},
            replace,
            required=("text",),
            write=True,
            timeout=WRITE_TIMEOUT_MS,
        ),
    ]


# ── Calc ─────────────────────────────────────────────────────────────────

def _values(args):
    raw = args.get("values")
    if not isinstance(raw, list) or not raw:
        raise ToolInputError('"values" must be a non-empty array of rows.')
    if not isinstance(raw[0], list) or not raw[0]:
        raise ToolInputError('"values" must be an array of rows, each an array of cells.')
    width = len(raw[0])
    rows = []
    for row in raw:
        if not isinstance(row, list) or len(row) != width:
            raise ToolInputError('Every row in "values" must have the same number of cells.')
        cells = []
        for cell in row:
            if cell is None:
                cells.append("")
            elif isinstance(cell, (str, int, float, bool)):
                cells.append(cell)
            else:
                raise ToolInputError("Cells must be text, numbers, or true/false.")
        rows.append(cells)
    if len(rows) * width > MAX_CELLS:
        raise ToolInputError(f"That is {len(rows) * width} cells; write at most {MAX_CELLS} at a time.")
    return rows


def calc_tools(book):
    def read_capped(sheet, address, formulas):
        size = book.measure(sheet, address)
        cells = size["rowCount"] * size["columnCount"]
        if cells > MAX_CELLS:
            return _json(
                {
                    **size,
                    "tooLarge": True,
                    "message": f"That range has {cells} cells; read at most {MAX_CELLS} at a time by asking for a smaller address.",
                }
            )
        return _json(book.read(sheet, address, formulas))

    def list_sheets(_args):
        return _json({"sheets": book.list_sheets()})

    def read_selection(args):
        return read_capped(None, None, _bool(args, "includeFormulas", False))

    def read_range(args):
        address = _str(args, "address", required=True, max_len=255)
        return read_capped(_str(args, "sheet", max_len=255), address, _bool(args, "includeFormulas", False))

    def describe_table(args):
        name = _str(args, "name", max_len=255)
        if not name:
            return _json({"tables": book.list_tables()})
        return _json(book.read_table(name, _int(args, "maxRows", 1, 200, 50)))

    def write_range(args):
        address = _str(args, "address", required=True, max_len=255)
        values = _values(args)
        written = book.write(_str(args, "sheet", max_len=255), address, values, _bool(args, "asFormulas", False))
        return _json({"written": True, "address": written, "rows": len(values), "columns": len(values[0])})

    range_props = {
        "sheet": {"type": "string", "description": "Sheet name. Default: the active sheet."},
        "address": {"type": "string", "description": 'Address like "B2:D20", or a named range.'},
    }
    return [
        _tool("sheet_list", "List the sheets in the open Calc spreadsheet, with each used range and its database ranges.", {}, list_sheets),
        _tool(
            "sheet_read_selection",
            f"Read the cells the user has selected in Calc: values, and formulas when asked. At most {MAX_CELLS} cells.",
            {"includeFormulas": {"type": "boolean"}},
            read_selection,
        ),
        _tool(
            "sheet_read_range",
            f"Read a range of cells from the open Calc spreadsheet. At most {MAX_CELLS} cells per read.",
            {**range_props, "includeFormulas": {"type": "boolean"}},
            read_range,
            required=("address",),
        ),
        _tool(
            "sheet_describe_table",
            "Describe the database ranges (tables) in the spreadsheet. Without a name, lists them with headers and size; with a name, also returns its first rows.",
            {"name": {"type": "string"}, "maxRows": {"type": "integer", "minimum": 1, "maximum": 200}},
            describe_table,
        ),
        _tool(
            "sheet_write_range",
            f"Write values (or formulas) into the open Calc spreadsheet. Give the full range, or just its top-left cell. At most {MAX_CELLS} cells.",
            {
                **range_props,
                "values": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": ["string", "number", "boolean", "null"]}},
                },
                "asFormulas": {"type": "boolean"},
            },
            write_range,
            required=("address", "values"),
            write=True,
            timeout=WRITE_TIMEOUT_MS,
        ),
    ]


# ── Impress ──────────────────────────────────────────────────────────────

def impress_tools(deck):
    def list_slides(_args):
        slides = deck.list_slides()
        return _json({"count": len(slides), "slides": slides})

    def read_slide(args):
        index = _int(args, "index", 0, 10_000, 0)
        slide = deck.read_slide(index)
        if slide is None:
            raise ToolInputError(f"There is no slide {index}. Use slides_list to see the slides.")
        for shape in slide["shapes"]:
            if shape.get("text") is not None:
                shape["text"] = clip(shape["text"], 8_000)[0]
        return _json(slide)

    def insert_slide(args):
        title = _str(args, "title", required=True, max_len=300)
        bullets = args.get("bullets") or []
        if not isinstance(bullets, list) or any(not isinstance(b, str) for b in bullets):
            raise ToolInputError('"bullets" must be a list of strings.')
        if len(bullets) > 12:
            raise ToolInputError("At most 12 bullets per slide.")
        after = args.get("afterIndex")
        after = None if after is None else _int(args, "afterIndex", 0, 10_000, 0)
        return _json({"inserted": True, **deck.insert_slide(title, bullets, after)})

    return [
        _tool("slides_list", "List the slides in the open Impress presentation with each slide's title.", {}, list_slides),
        _tool(
            "slide_read",
            "Read one slide of the open Impress presentation: every shape and its text. Slides count from 0.",
            {"index": {"type": "integer", "minimum": 0}},
            read_slide,
            required=("index",),
        ),
        _tool(
            "slide_insert",
            "Add a slide with a title and optional bullet points to the open Impress presentation, after `afterIndex` or at the end.",
            {
                "title": {"type": "string", "minLength": 1, "maxLength": 300},
                "bullets": {"type": "array", "items": {"type": "string", "maxLength": 500}, "maxItems": 12},
                "afterIndex": {"type": "integer", "minimum": 0},
            },
            insert_slide,
            required=("title",),
            write=True,
            timeout=WRITE_TIMEOUT_MS,
        ),
    ]


def tools_for(kind, edits, describe, read_selection, adapter):
    """Tools for a document kind (`writer`, `calc`, `impress`). Write tools
    are withdrawn, not refused, while edits are off."""
    tools = common_tools(describe, read_selection)
    if kind == "writer":
        tools += writer_tools(adapter)
    elif kind == "calc":
        tools += calc_tools(adapter)
    elif kind == "impress":
        tools += impress_tools(adapter)
    return [t for t in tools if edits or not t["write"]]


def markdown_blocks(markdown):
    """Markdown → [(text, kind)] with kind in heading1..6 / bullet / numbered / paragraph.
    Inline markup is stripped: Writer gets clean text in the right styles."""
    import re

    blocks = []
    paragraph = []

    def flush():
        if paragraph:
            blocks.append((" ".join(paragraph), "paragraph"))
            paragraph.clear()

    def inline(text):
        text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
        text = re.sub(r"__([^_]+)__", r"\1", text)
        text = re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*", r"\1", text)
        text = re.sub(r"`([^`]+)`", r"\1", text)
        text = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", r"\1 (\2)", text)
        return text

    in_code = False
    for line in markdown.replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```"):
            flush()
            in_code = not in_code
            continue
        if in_code:
            blocks.append((line, "code"))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush()
            blocks.append((inline(m.group(2).strip()), f"heading{len(m.group(1))}"))
            continue
        m = re.match(r"^\s*[-*+]\s+(.*)$", line)
        if m:
            flush()
            blocks.append((inline(m.group(1)), "bullet"))
            continue
        m = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if m:
            flush()
            blocks.append((inline(m.group(1)), "numbered"))
            continue
        if not line.strip():
            flush()
            continue
        paragraph.append(inline(line.strip()))
    flush()
    return blocks
