"""Writer, Calc and Impress adapters for the document tools (see toolspec).
Every method runs on the main thread (the relay routes calls through
dispatch.MainThread)."""

from __future__ import annotations

import uno
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK

from .toolspec import ToolInputError, markdown_blocks

HEADING_STYLES = {f"heading{n}": f"Heading {n}" for n in range(1, 7)}


def document_kind(model):
    if model is None:
        return None
    if model.supportsService("com.sun.star.text.TextDocument"):
        return "writer"
    if model.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        return "calc"
    if model.supportsService("com.sun.star.presentation.PresentationDocument"):
        return "impress"
    return None


def document_path(model):
    url = model.getURL() if model is not None else ""
    if url and url.startswith("file:"):
        return uno.fileUrlToSystemPath(url)
    return None


def column_letters(index):
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


# ── Writer ───────────────────────────────────────────────────────────────

class WriterDoc:
    def __init__(self, model):
        self.model = model

    def _selected_ranges(self):
        sel = self.model.getCurrentController().getSelection()
        if sel is None:
            return []
        if sel.supportsService("com.sun.star.text.TextRanges"):
            return [sel.getByIndex(i) for i in range(sel.getCount())]
        return [sel] if hasattr(sel, "getString") else []

    def selection_text(self):
        return "\n".join(r.getString() for r in self._selected_ranges() if r.getString())

    def read_selection(self):
        text = self.selection_text()
        return text, [(line, "") for line in text.split("\n")] if text else []

    def read_paragraphs(self):
        out = []
        enum = self.model.getText().createEnumeration()
        while enum.hasMoreElements():
            element = enum.nextElement()
            if element.supportsService("com.sun.star.text.Paragraph"):
                out.append((element.getString(), element.ParaStyleName))
            elif element.supportsService("com.sun.star.text.TextTable"):
                try:
                    rows = element.getDataArray()
                    out.append(("\n".join("\t".join(str(c) for c in row) for row in rows), "Table"))
                except Exception:  # noqa: BLE001 - merged cells refuse getDataArray
                    out.append(("[table]", "Table"))
        return out

    def search(self, query, match_case, max_results):
        desc = self.model.createSearchDescriptor()
        desc.SearchString = query
        desc.SearchCaseSensitive = match_case
        found = self.model.findAll(desc)
        total = found.getCount() if found is not None else 0
        matches = []
        for i in range(min(total, max_results)):
            hit = found.getByIndex(i)
            cursor = hit.getText().createTextCursorByRange(hit)
            cursor.gotoStartOfParagraph(False)
            cursor.gotoEndOfParagraph(True)
            matches.append((hit.getString(), cursor.getString()))
        return total, matches

    def _insert(self, text, position, content, markdown):
        cursor = text.createTextCursorByRange(position)
        base_style = cursor.ParaStyleName
        blocks = markdown_blocks(content) if markdown else [(line, "paragraph") for line in content.split("\n")]
        number = 0
        for i, (line, kind) in enumerate(blocks):
            if i > 0:
                text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
            if markdown:
                try:
                    cursor.ParaStyleName = HEADING_STYLES.get(kind, base_style)
                except Exception:  # noqa: BLE001 - a localized style set may lack one
                    pass
            number = number + 1 if kind == "numbered" else 0
            prefix = "• " if kind == "bullet" else f"{number}. " if kind == "numbered" else ""
            text.insertString(cursor, prefix + line, False)

    def insert(self, content, where, markdown):
        if where == "cursor":
            view = self.model.getCurrentController().getViewCursor()
            self._insert(view.getText(), view.getEnd(), content, markdown)
            return
        text = self.model.getText()
        self._insert(text, text.getStart() if where == "start" else text.getEnd(), content, markdown)

    def replace_selection(self, content, markdown):
        ranges = self._selected_ranges()
        if not ranges:
            raise ToolInputError("Nothing is selected in the document.")
        target = ranges[0]
        text = target.getText()
        target.setString("")
        self._insert(text, target.getStart(), content, markdown)


# ── Calc ─────────────────────────────────────────────────────────────────

class CalcDoc:
    def __init__(self, model):
        self.model = model

    def _sheets(self):
        return self.model.getSheets()

    def _range(self, sheet, address):
        controller = self.model.getCurrentController()
        if not address:
            sel = controller.getSelection()
            if sel is not None and sel.supportsService("com.sun.star.sheet.SheetCellRanges"):
                sel = sel.getByIndex(0)
            if sel is None or not sel.supportsService("com.sun.star.sheet.SheetCellRange"):
                raise ToolInputError("Select some cells first.")
            return sel
        sheets = self._sheets()
        if sheet and not sheets.hasByName(sheet):
            raise ToolInputError(f'There is no sheet named "{sheet}".')
        target = sheets.getByName(sheet) if sheet else controller.getActiveSheet()
        try:
            return target.getCellRangeByName(address)
        except Exception as err:  # noqa: BLE001
            raise ToolInputError(f'"{address}" is not a cell address or named range.') from err

    def _info(self, rng):
        addr = rng.getRangeAddress()
        return {
            "sheet": self._sheets().getElementNames()[addr.Sheet],
            "address": rng.AbsoluteName,
            "rowCount": addr.EndRow - addr.StartRow + 1,
            "columnCount": addr.EndColumn - addr.StartColumn + 1,
        }

    def selection_text(self):
        try:
            rng = self._range(None, None)
        except ToolInputError:
            return ""
        return "\n".join("\t".join(str(c) for c in row) for row in rng.getDataArray())

    def measure(self, sheet, address):
        return self._info(self._range(sheet, address))

    def read(self, sheet, address, formulas):
        rng = self._range(sheet, address)
        out = {**self._info(rng), "values": [list(row) for row in rng.getDataArray()]}
        if formulas:
            out["formulas"] = [list(row) for row in rng.getFormulaArray()]
        return out

    def list_sheets(self):
        sheets = self._sheets()
        names = sheets.getElementNames()
        tables_by_sheet = {}
        try:
            ranges = self.model.DatabaseRanges
            for name in ranges.getElementNames():
                area = ranges.getByName(name).getDataArea()
                tables_by_sheet.setdefault(area.Sheet, []).append(name)
        except Exception:  # noqa: BLE001
            pass
        out = []
        for index, name in enumerate(names):
            sheet = sheets.getByName(name)
            cursor = sheet.createCursor()
            cursor.gotoEndOfUsedArea(False)
            end = cursor.getRangeAddress()
            out.append(
                {
                    "name": name,
                    "visible": bool(sheet.IsVisible),
                    "usedRange": f"A1:{column_letters(end.EndColumn)}{end.EndRow + 1}",
                    "tables": tables_by_sheet.get(index, []),
                }
            )
        return out

    def _table(self, name):
        ranges = self.model.DatabaseRanges
        if not ranges.hasByName(name):
            raise ToolInputError(f'There is no table named "{name}".')
        db = ranges.getByName(name)
        area = db.getDataArea()
        sheet = self._sheets().getByIndex(area.Sheet)
        rng = sheet.getCellRangeByPosition(area.StartColumn, area.StartRow, area.EndColumn, area.EndRow)
        data = [list(row) for row in rng.getDataArray()]
        header = bool(getattr(db, "ContainsHeader", True))
        return {
            "name": name,
            "sheet": self._sheets().getElementNames()[area.Sheet],
            "address": rng.AbsoluteName,
            "headers": data[0] if header and data else [],
            "rowCount": len(data) - (1 if header and data else 0),
        }, data[1:] if header else data

    def list_tables(self):
        try:
            names = self.model.DatabaseRanges.getElementNames()
        except Exception:  # noqa: BLE001
            return []
        return [self._table(name)[0] for name in names]

    def read_table(self, name, max_rows):
        summary, rows = self._table(name)
        return {**summary, "rows": rows[:max_rows]}

    def write(self, sheet, address, values, formulas):
        rng = self._range(sheet, address)
        info = self._info(rng)
        rows, cols = len(values), len(values[0])
        if info["rowCount"] == 1 and info["columnCount"] == 1 and (rows > 1 or cols > 1):
            addr = rng.getRangeAddress()
            host = self._sheets().getByIndex(addr.Sheet)
            rng = host.getCellRangeByPosition(
                addr.StartColumn, addr.StartRow, addr.StartColumn + cols - 1, addr.StartRow + rows - 1
            )
        elif info["rowCount"] != rows or info["columnCount"] != cols:
            raise ToolInputError(
                f"The range is {info['rowCount']}x{info['columnCount']} but the values are {rows}x{cols}. "
                "Give a matching range or just its top-left cell."
            )
        if formulas:
            rng.setFormulaArray(tuple(tuple(str(c) for c in row) for row in values))
        else:

            def cell(value):
                if isinstance(value, bool):
                    return 1.0 if value else 0.0
                if isinstance(value, (int, float)):
                    return float(value)
                return value

            rng.setDataArray(tuple(tuple(cell(c) for c in row) for row in values))
        return rng.AbsoluteName


# ── Impress ──────────────────────────────────────────────────────────────

TITLE_SHAPE = "com.sun.star.presentation.TitleTextShape"
OUTLINE_SHAPE = "com.sun.star.presentation.OutlinerShape"
TITLE_AND_CONTENT_LAYOUT = 1


class ImpressDoc:
    def __init__(self, model):
        self.model = model

    def _pages(self):
        return self.model.getDrawPages()

    @staticmethod
    def _shape_text(shape):
        try:
            return shape.getString()
        except Exception:  # noqa: BLE001 - not every shape carries text
            return None

    def selection_text(self):
        sel = self.model.getCurrentController().getSelection()
        if sel is None:
            return ""
        if hasattr(sel, "getCount") and hasattr(sel, "getByIndex"):
            parts = [self._shape_text(sel.getByIndex(i)) for i in range(sel.getCount())]
            return "\n".join(p for p in parts if p)
        return self._shape_text(sel) or ""

    def list_slides(self):
        pages = self._pages()
        out = []
        for i in range(pages.getCount()):
            page = pages.getByIndex(i)
            title = None
            for j in range(page.getCount()):
                shape = page.getByIndex(j)
                if shape.getShapeType() == TITLE_SHAPE:
                    title = (self._shape_text(shape) or "").strip().split("\n")[0] or None
                    break
            out.append({"index": i, "id": page.Name, "title": title, "shapeCount": page.getCount()})
        return out

    def read_slide(self, index):
        pages = self._pages()
        if index >= pages.getCount():
            return None
        page = pages.getByIndex(index)
        shapes = []
        for j in range(page.getCount()):
            shape = page.getByIndex(j)
            shapes.append(
                {
                    "id": str(j),
                    "name": getattr(shape, "Name", "") or "",
                    "type": shape.getShapeType().rsplit(".", 1)[-1],
                    "text": self._shape_text(shape),
                }
            )
        return {"index": index, "id": page.Name, "shapes": shapes}

    def insert_slide(self, title, bullets, after_index):
        pages = self._pages()
        count = pages.getCount()
        anchor = count - 1 if after_index is None else min(after_index, count - 1)
        page = pages.insertNewByIndex(anchor)
        page.Layout = TITLE_AND_CONTENT_LAYOUT
        for j in range(page.getCount()):
            shape = page.getByIndex(j)
            kind = shape.getShapeType()
            if kind == TITLE_SHAPE:
                shape.setString(title)
            elif kind == OUTLINE_SHAPE and bullets:
                shape.setString("\n".join(bullets))
        index = next((i for i in range(pages.getCount()) if pages.getByIndex(i).Name == page.Name), anchor + 1)
        return {"index": index, "id": page.Name, "positioned": True}


def adapter_for(kind, model):
    if kind == "writer":
        return WriterDoc(model)
    if kind == "calc":
        return CalcDoc(model)
    if kind == "impress":
        return ImpressDoc(model)
    return None
