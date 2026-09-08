from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import importlib.metadata
import io
import json
import math
import os
import posixpath
import re
import stat
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from xml.parsers import expat

POLICY_VERSION = "document-quality-1"
ENGINE_VERSION = "pdfium-docx-rapidocr-1"
MAX_FILE = 50 * 1024 * 1024
MAX_PAGES = 1000
MAX_ZIP_ENTRIES = 4096
MAX_UNPACKED = 200 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024
MAX_PIXELS = 4_000_000
MAX_IMAGE_PIXELS = 20_000_000
MAX_DIMENSION = 2400
MIN_CONFIDENCE = 0.85
DEPENDENCIES = ("pypdfium2", "Pillow", "rapidocr-onnxruntime", "onnxruntime", "numpy",
                "opencv-python", "opencv-python-headless", "pyclipper", "Shapely", "PyYAML")
CJK = re.compile(r"[\u3400-\u9fff\U00020000-\U0003134f]")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


class DiagnosticError(Exception):
    pass


class UnsafePath(DiagnosticError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def versions():
    result = {"python": ".".join(map(str, sys.version_info[:3]))}
    for name in DEPENDENCIES:
        try:
            result[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            result[name] = "missing"
    return result


def regular(info):
    return (stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and not getattr(info, "st_file_attributes", 0) & 0x400)


def windows_handle(path, directory=False):
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handle = create(str(path), 0 if directory else 0x80000000,
                    3 if directory else 1, None, 3,
                    0x00200000 | (0x02000000 if directory else 0), None)
    if handle == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), "Cannot securely open path", str(path))
    return handle, close


class SafeDirectory:
    def __init__(self, path, create=False):
        self.path = Path(path)
        self.fd = None
        self.handles = []
        if (not self.path.is_absolute() or ".." in self.path.parts
                or str(path).startswith(("\\\\", "//"))):
            raise UnsafePath("Paths must be absolute local paths without parent traversal")
        if os.name == "nt" and any(":" in p for p in self.path.parts[1:]):
            raise UnsafePath("Alternate data streams are forbidden")
        try:
            if os.name == "nt":
                current = Path(self.path.anchor)
                for part in (None, *self.path.parts[1:]):
                    if part is not None:
                        current /= part
                    if create and not os.path.lexists(current):
                        current.mkdir()
                    handle, close = windows_handle(current, directory=True)
                    self.handles.append((handle, close))
                    info = current.lstat()
                    if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                        raise UnsafePath("Output/input parent is a link or reparse point")
            else:
                self.fd = os.open(self.path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                for part in self.path.parts[1:]:
                    if create:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=self.fd)
                        except FileExistsError:
                            pass
                    new_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
                    os.close(self.fd)
                    self.fd = new_fd
        except Exception:
            self.close()
            raise

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        for handle, close in reversed(self.handles):
            close(handle)
        self.handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def check(self, name):
        if not name or name in (".", "..") or any(c in name for c in "/\\:\0"):
            raise UnsafePath("Invalid output basename")
        try:
            info = (os.stat(name, dir_fd=self.fd, follow_symlinks=False) if self.fd is not None
                    else (self.path / name).lstat())
        except FileNotFoundError:
            return
        if not regular(info):
            raise UnsafePath("Refusing non-regular, linked or shared file: " + name)

    def read(self, name, limit=MAX_FILE):
        self.check(name)
        if os.name == "nt":
            import msvcrt

            handle, close = windows_handle(self.path / name)
            try:
                fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except Exception:
                close(handle)
                raise
        else:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        with os.fdopen(fd, "rb") as stream:
            if not regular(os.fstat(stream.fileno())):
                raise UnsafePath("Refusing unsafe file: " + name)
            if os.fstat(stream.fileno()).st_size > limit:
                raise DiagnosticError("File exceeds size limit: " + name)
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise DiagnosticError("File exceeds size limit: " + name)
        return data

    def write(self, name, data):
        self.check(name)
        temp = ".worker-" + uuid.uuid4().hex + ".tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        fd = (os.open(temp, flags, 0o600, dir_fd=self.fd) if self.fd is not None
              else os.open(self.path / temp, flags, 0o600))
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.check(name)
            if self.fd is not None:
                os.replace(temp, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            else:
                os.replace(self.path / temp, self.path / name)
        finally:
            try:
                if self.fd is not None:
                    os.unlink(temp, dir_fd=self.fd)
                else:
                    (self.path / temp).unlink()
            except FileNotFoundError:
                pass

    def json(self, name, value):
        self.write(name, json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8"))


def text_issues(text, name, mixed=False):
    compact = "".join(text.split())
    issues = []
    if len(compact) < 32:
        issues.append("sparse_text")
    bad = sum(c == "\ufffd" or 0xE000 <= ord(c) <= 0xF8FF or
              (ord(c) < 32 and c not in "\n\r\t") for c in text)
    if bad or re.search(r"(?:Ã.|Â.|锟斤拷)", text):
        issues.append("garbled_text")
    if CJK.search(name) and not CJK.search(text) and re.search(r"[A-Za-z0-9]", text):
        issues.append("suspected_missing_chinese")
    if mixed:
        issues.append("mixed_image_page")
    return issues


def bounded_image(image, resize=True):
    from PIL import Image

    width, height = image.size
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise DiagnosticError("Image exceeds decoded pixel limit")
    scale = min(1.0, MAX_DIMENSION / width, MAX_DIMENSION / height,
                math.sqrt(MAX_PIXELS / (width * height)))
    if resize and scale < 1:
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.Resampling.LANCZOS)
    if image.mode == "RGBA" or "transparency" in image.info or image.mode == "LA":
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", image.size, "white")
        background.alpha_composite(rgba)
        return background.convert("RGB")
    return image.convert("RGB")


def is_blank(image):
    # Faint marks are not evidence of an empty page.
    return image.convert("L").getextrema() == (255, 255)


class LocalOCR:
    def __init__(self):
        self.engine = None

    def __call__(self, image):
        if self.engine is None:
            for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
                os.environ[key] = "2"
            try:
                import rapidocr_onnxruntime
                from rapidocr_onnxruntime import RapidOCR
            except ImportError as exc:
                raise DiagnosticError("Missing local OCR dependency: rapidocr-onnxruntime/onnxruntime; install separately") from exc
            model_dir = Path(rapidocr_onnxruntime.__file__).parent / "models"
            model_names = ("ch_PP-OCRv4_det_infer.onnx", "ch_ppocr_mobile_v2.0_cls_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx")
            paths = [model_dir / name for name in model_names]
            if any(not path.is_file() for path in paths):
                raise DiagnosticError("Missing bundled local RapidOCR models; network/download is disabled")
            self.engine = RapidOCR(det_model_path=str(paths[0]), cls_model_path=str(paths[1]),
                                   rec_model_path=str(paths[2]), intra_op_num_threads=2,
                                   inter_op_num_threads=1, det_use_cuda=False, cls_use_cuda=False,
                                   rec_use_cuda=False, det_use_dml=False, cls_use_dml=False,
                                   rec_use_dml=False, print_verbose=False, text_score=0.0,
                                   det_limit_type="max", det_limit_side_len=1600,
                                   min_side_len=1, max_side_len=MAX_DIMENSION,
                                   rec_batch_num=1, cls_batch_num=1)
            import cv2

            cv2.setNumThreads(2)
        import numpy as np

        result, _ = self.engine(np.asarray(image)[:, :, ::-1].copy())
        return result or []


def ocr_page(page, image, original, reasons, ocr):
    entry = {"page": page, "method": "ocr", "status": "needs_review",
             "textPath": f"page-{page:04d}.txt", "imagePath": f"page-{page:04d}.png",
             "confidence": 0.0, "warnings": list(reasons)}
    warnings = entry["warnings"]
    warnings.extend(["ocr_layout_not_preserved", "ocr_key_numbers_require_review"])
    try:
        rows = ocr(image)
        lines, scores = [], []
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) != 3 or not isinstance(row[1], str):
                raise DiagnosticError("Invalid local OCR result")
            score = float(row[2])
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise DiagnosticError("Invalid local OCR confidence")
            if row[1].strip():
                lines.append(row[1])
                scores.append(score)
        if not lines:
            raise DiagnosticError("OCR returned no text on a nonblank image")
        recognized = "\n".join(lines)
        entry["confidence"] = min(scores)
        if min(scores) < MIN_CONFIDENCE:
            warnings.append("low_ocr_confidence")
        if "suspected_missing_chinese" in reasons:
            warnings.append("chinese_recovered_by_ocr" if CJK.search(recognized)
                            else "missing_chinese_unresolved_after_ocr_comparison")
        if original.strip():
            if "".join(original.split()) != "".join(recognized.split()):
                warnings.append("text_ocr_disagreement")
            if re.findall(r"\d+(?:[.,]\d+)*", original) != re.findall(r"\d+(?:[.,]\d+)*", recognized):
                warnings.append("numeric_text_ocr_disagreement")
        annotated = "\n".join(f"[confidence={score:.4f}] {line}" for line, score in zip(lines, scores))
        text = (("[Extracted text]\n" + original + "\n\n") if original.strip() else "") + "[Local OCR]\n" + annotated
    except Exception as exc:  # noqa: BLE001 - OCR backends expose vendor-specific exceptions.
        # OCR failure: downgrade to needs_review so partial docs don't block Agent startup
        entry.update(method="failed", status="needs_review")
        warnings.append("ocr_failed: " + str(exc)[:1000])
        text = original
    return entry, text


def safe_xml(data):
    if len(data) > MAX_XML:
        raise DiagnosticError("DOCX XML exceeds size limit")
    parser = expat.ParserCreate()

    def reject(*args):
        raise DiagnosticError("DTD/entities are forbidden in DOCX")

    parser.StartDoctypeDeclHandler = reject
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    parser.Parse(data, True)
    return ET.fromstring(data)


def paragraph_text(node):
    parts = []
    for element in node.iter():
        if element.tag == W + "t":
            parts.append(element.text or "")
        elif element.tag == W + "tab":
            parts.append("\t")
        elif element.tag in (W + "br", W + "cr"):
            parts.append("\n")
    return "".join(parts)


def block_text(node):
    if node.tag == W + "tbl":
        rows = []
        for row in node.findall(W + "tr"):
            cells = [" / ".join(block_text(child) for child in cell if child.tag in (W + "p", W + "tbl"))
                     for cell in row.findall(W + "tc")]
            rows.append("\t".join(cells))
        return "[Table: tab-separated cells]\n" + "\n".join(rows)
    return paragraph_text(node)


def docx_blocks(data):
    warnings = ["docx_page_numbers_are_logical_blocks_not_Word_pages",
                "docx_layout_numbering_and_media_positions_not_preserved"]
    blocks = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_UNPACKED:
            raise DiagnosticError("DOCX archive entry/uncompressed-size limit exceeded")
        seen = set()
        for info in infos:
            name = info.filename
            if (name in seen or name.startswith(("/", "\\")) or "\\" in name
                    or ".." in name.split("/") or ":" in name or info.flag_bits & 1
                    or stat.S_ISLNK(info.external_attr >> 16)):
                raise DiagnosticError("Unsafe or duplicate DOCX ZIP entry")
            seen.add(name)
        xml = {}
        for info in infos:
            name = info.filename
            if name.lower().endswith((".xml", ".rels")):
                if info.file_size > MAX_XML:
                    raise DiagnosticError("DOCX XML exceeds size limit")
                xml[name] = safe_xml(archive.read(info))
                if (name.endswith(".rels") and "external_links_not_followed" not in warnings
                        and any(e.get("TargetMode", "").lower() == "external" for e in xml[name].iter())):
                    warnings.append("external_links_not_followed")
            if "vbaproject" in name.lower() or name.startswith("word/embeddings/"):
                warnings.append("active_or_embedded_content_ignored: " + name)
        root = xml.get("word/document.xml")
        if root is None:
            raise DiagnosticError("DOCX is missing word/document.xml")
        body = root.find(W + "body")
        if body is None:
            raise DiagnosticError("DOCX has no document body")
        sources = [("word/document.xml", body)]
        sources.extend((name, xml[name]) for name in sorted(xml)
                       if re.fullmatch(r"word/(?:header|footer|footnotes|endnotes)[^/]*\.xml", name))
        for source, container in sources:
            parent, _, basename = source.rpartition("/")
            relations_root = xml.get(parent + "/_rels/" + basename + ".rels")
            relations = {} if relations_root is None else {e.get("Id"): e for e in relations_root}
            for element in container.iter():
                if element.tag not in ("{http://schemas.openxmlformats.org/drawingml/2006/main}blip",
                                       "{urn:schemas-microsoft-com:vml}imagedata"):
                    continue
                relation_id = element.get(R + "embed") or element.get(R + "id") or element.get(R + "link")
                relation = relations.get(relation_id)
                if relation is None:
                    blocks.append((source, "", None, "missing_embedded_image_relationship"))
                    continue
                if relation.get("TargetMode", "").lower() == "external":
                    continue
                target = relation.get("Target", "")
                target = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                                           else posixpath.join(parent, target))
                if target not in seen or not target.startswith("word/media/"):
                    blocks.append((source, "", None, "missing_or_unsupported_embedded_media: " + target))
            nodes = list(container)
            if source.endswith(("footnotes.xml", "endnotes.xml")):
                nodes = [child for note in container for child in note]
            for node in nodes:
                if node.tag == W + "sectPr":
                    continue
                text = block_text(node)
                if text.strip():
                    blocks.append((source, text, None, None))
        unsupported_tags = {W + "object", W + "altChunk",
                            "{http://schemas.openxmlformats.org/drawingml/2006/chart}chart",
                            "{http://schemas.openxmlformats.org/drawingml/2006/diagram}relIds"}
        for source, root in xml.items():
            if not source.startswith("word/"):
                continue
            if any(e.tag in unsupported_tags for e in root.iter()):
                blocks.append((source, "", None, "unsupported_embedded_content_not_executed"))
            if source.endswith(".rels"):
                for relation in root.iter():
                    if (relation.get("Type", "").endswith("/image")
                            and relation.get("TargetMode", "").lower() == "external"):
                        blocks.append((source, "", None, "external_image_not_fetched"))
        for info in infos:
            if info.filename.startswith("word/media/") and not info.is_dir():
                if info.file_size > MAX_FILE:
                    raise DiagnosticError("DOCX media exceeds size limit")
                blocks.append((info.filename, "", info.filename, None))
        if not blocks:
            has_drawing = any(e.tag in (W + "drawing", W + "pict") for e in body.iter())
            blocks.append(("word/document.xml", "", None,
                           "missing_embedded_media" if has_drawing else None))
        if len(blocks) > MAX_PAGES:
            raise DiagnosticError("DOCX exceeds 1000 logical blocks")
        for source, text, media, problem in blocks:
            yield source, text, archive.read(media) if media else None, problem, warnings, len(blocks)


class Worker:
    def __init__(self, output, source_hash, source_name, ocr=None, emit=None):
        self.output = output
        self.source_hash = source_hash
        self.source_name = source_name
        self.ocr = ocr if ocr is not None else LocalOCR()
        self.emit = emit if emit is not None else lambda value: None
        self.signature = {"sourceHash": source_hash, "sourceName": source_name,
                          "engineVersion": ENGINE_VERSION, "policyVersion": POLICY_VERSION,
                          "dependencies": versions()}
        self.report = {"schemaVersion": 1, "sourceHash": source_hash, "sourceName": source_name,
                       "status": "failed", "pageCount": 0, "ocrPages": 0, "cachedPages": 0,
                       "pages": [], "warnings": []}
        self.texts = []
        self.logical = False

    def cached(self, page):
        prefix = f"page-{page:04d}"
        for suffix in (".json", ".txt", ".png"):
            self.output.check(prefix + suffix)
        try:
            cache = json.loads(self.output.read(prefix + ".json", MAX_XML))
            if (not isinstance(cache, dict) or type(cache.get("schemaVersion")) is not int
                    or cache["schemaVersion"] != 1 or cache.get("signature") != self.signature):
                return None
            entry = cache["entry"]
            if (not isinstance(entry, dict) or set(entry) - {"page", "method", "status", "textPath", "imagePath", "confidence", "warnings"}
                    or type(entry.get("page")) is not int or entry["page"] != page
                    or entry.get("textPath") != prefix + ".txt"
                    or entry.get("method") not in ("text", "ocr", "blank")
                    or entry.get("status") not in ("ready", "needs_review")
                    or not isinstance(entry.get("warnings"), list)
                    or not all(isinstance(w, str) for w in entry["warnings"])):
                return None
            entry_data = json.dumps(entry, sort_keys=True, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if digest(entry_data) != cache.get("entryHash"):
                return None
            if entry["method"] == "ocr":
                confidence = entry.get("confidence")
                if (type(confidence) not in (float, int) or not math.isfinite(confidence)
                        or not 0 <= confidence <= 1 or entry["status"] != "needs_review"
                        or entry.get("imagePath") != prefix + ".png"):
                    return None
            elif ("imagePath" in entry or "confidence" in entry
                    or (entry["status"] != "ready"
                        and not (entry["method"] == "blank"
                                 and entry["status"] == "needs_review"))):
                return None
            text_data = self.output.read(prefix + ".txt")
            if digest(text_data) != cache.get("textHash"):
                return None
            if "imagePath" in entry and digest(self.output.read(prefix + ".png")) != cache.get("imageHash"):
                return None
            text = text_data.decode("utf-8")
            if entry["method"] == "text" and not text.strip():
                return None
            return entry, text
        except UnsafePath:
            raise
        except (ValueError, KeyError, TypeError, OSError, DiagnosticError, RecursionError, OverflowError):
            return None

    def save(self, entry, text, image=None):
        page = entry["page"]
        encoded = text.encode("utf-8")
        self.output.write(f"page-{page:04d}.txt", encoded)
        image_hash = None
        if image is not None:
            stream = io.BytesIO()
            image.save(stream, format="PNG")
            image_data = stream.getvalue()
            self.output.write(f"page-{page:04d}.png", image_data)
            image_hash = digest(image_data)
        entry_data = json.dumps(entry, sort_keys=True, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.output.json(f"page-{page:04d}.json", {"schemaVersion": 1, "signature": self.signature, "entry": entry,
                 "entryHash": digest(entry_data),
                         "textHash": digest(encoded), "imageHash": image_hash})

    def accept(self, entry, text, total, cached=False):
        self.report["pages"].append(entry)
        self.report["cachedPages"] += int(cached)
        self.report["ocrPages"] += int("imagePath" in entry)
        self.texts.append(text)
        self.emit({"type": "progress", "page": entry["page"], "total": total, "method": entry["method"]})

    def basic(self, page, method, warnings=None):
        return {"page": page, "method": method, "status": "failed" if method == "failed" else "ready",
                "textPath": f"page-{page:04d}.txt", "warnings": warnings or []}

    def pdf(self, data):
        try:
            import pypdfium2 as pdfium
            from PIL import Image
        except ImportError as exc:
            raise DiagnosticError("Missing PDF dependency: pypdfium2/Pillow") from exc
        with pdfium.PdfDocument(data) as document:
            total = len(document)
            self.report["pageCount"] = total
            if not 1 <= total <= MAX_PAGES:
                raise DiagnosticError("PDF must have 1..1000 pages")
            if pdfium.raw.FPDF_GetFormType(document) in (2, 3):
                raise DiagnosticError("XFA forms are unsupported; active content is not executed")
            self.report["warnings"].append("pdf_reading_order_and_table_layout_not_guaranteed")
            for index in range(total):
                number = index + 1
                cached = self.cached(number)
                if cached:
                    self.accept(*cached, total, cached=True)
                    continue
                image, text = None, ""
                try:
                    with contextlib.closing(document[index]) as page:
                        extraction_error = None
                        try:
                            with contextlib.closing(page.get_textpage()) as textpage:
                                text = textpage.get_text_range().replace("\r\n", "\n")
                        except Exception as exc:  # noqa: BLE001 - Text decoding failure still permits local OCR.
                            extraction_error = "text_extraction_failed: " + str(exc)[:500]
                        mixed, image_pixels = False, 0
                        for image_object in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE]):
                            mixed = True
                            image_width, image_height = image_object.get_px_size()
                            image_pixels += image_width * image_height
                            if image_width <= 0 or image_height <= 0 or image_pixels > MAX_IMAGE_PIXELS:
                                raise DiagnosticError("PDF embedded images exceed decoded pixel limit")
                        reasons = text_issues(text, self.source_name, mixed)
                        if extraction_error:
                            reasons.append(extraction_error)
                        annotations = pdfium.raw.FPDFPage_GetAnnotCount(page)
                        if annotations < 0:
                            raise DiagnosticError("Unable to inspect PDF annotations")
                        if annotations:
                            reasons.append("annotations_or_forms_require_review; interactive content not executed")
                        if not reasons:
                            entry = self.basic(number, "text")
                        else:
                            width, height = page.get_size()
                            if not all(math.isfinite(v) and v > 0 for v in (width, height)):
                                raise DiagnosticError("Invalid PDF page dimensions")
                            scale = min(2.0, (MAX_DIMENSION - 1) / width, (MAX_DIMENSION - 1) / height,
                                        math.sqrt((MAX_PIXELS - 2 * MAX_DIMENSION) / (width * height)))
                            bitmap = page.render(scale=scale, may_draw_forms=False)
                            try:
                                rendered = bitmap.to_pil()
                                if not isinstance(rendered, Image.Image):
                                    raise DiagnosticError("PDF renderer did not return an image")
                                image = bounded_image(rendered)
                            finally:
                                bitmap.close()
                            if not text.strip() and not extraction_error and not annotations and is_blank(image):
                                entry = self.basic(number, "blank")
                                image = None
                            else:
                                entry, text = ocr_page(number, image, text, reasons, self.ocr)
                except Exception as exc:  # noqa: BLE001 - Decoder failures must remain page-local.
                    entry = self.basic(number, "failed", ["pdf_page_failed: " + str(exc)[:1000]])
                    image = None
                self.save(entry, text, image)
                self.accept(entry, text, total)

    def docx(self, data):
        self.logical = True
        for number, (source, text, media, problem, warnings, total) in enumerate(docx_blocks(data), 1):
            self.report["pageCount"] = total
            self.report["warnings"] = warnings
            cached = self.cached(number)
            if cached:
                self.accept(*cached, total, cached=True)
                continue
            image = None
            if problem:
                peripheral_missing_media = (source.startswith(("word/header", "word/footer")) and
                                            problem.startswith(("missing_embedded_image_relationship",
                                                                "missing_or_unsupported_embedded_media")))
                entry = self.basic(number, "blank" if peripheral_missing_media else "failed",
                                   [problem, "embedded_media_source: " + source])
                if peripheral_missing_media:
                    entry["status"] = "needs_review"
            elif media is None:
                entry = self.basic(number, "text" if text.strip() else "blank")
            else:
                try:
                    from PIL import Image

                    with Image.open(io.BytesIO(media), formats=("PNG", "JPEG", "TIFF", "BMP", "GIF", "WEBP")) as opened:
                        if getattr(opened, "n_frames", 1) != 1:
                            raise DiagnosticError("Multi-frame media requires separate review")
                        original_image = bounded_image(opened, resize=False)
                    blank = is_blank(original_image)
                    image = bounded_image(original_image)
                    if blank:
                        entry = self.basic(number, "blank", ["embedded_media_source: " + source])
                        image = None
                    else:
                        entry, text = ocr_page(number, image, "", ["embedded_media_source: " + source,
                                                "media_has_no_physical_page_number"], self.ocr)
                except Exception as exc:  # noqa: BLE001 - Unsupported media must not become blank blocks.
                    entry = self.basic(number, "failed", ["embedded_image_failed: " + str(exc)[:1000],
                                                         "embedded_media_source: " + source])
                    image = None
            text = "[DOCX source: " + source + "; logical block, not a Word page]\n" + text
            self.save(entry, text, image)
            self.accept(entry, text, total)

    def finish(self, fatal=None):
        entries = self.report["pages"]
        if fatal:
            self.report["status"] = "failed"
            self.report["warnings"].append("diagnostic: " + str(fatal)[:2000])
        elif entries and all(e["status"] == "ready" for e in entries):
            self.report["status"] = "ready"
        elif entries and any(e["status"] != "failed" for e in entries):
            self.report["status"] = "needs_review"
        label = "Logical block (not Word page)" if self.logical else "Page"
        full = "\n\n".join(f"===== {label} {entry['page']} | {entry['method']} | {entry['status']} =====\n{text}"
                            for entry, text in zip(entries, self.texts))
        self.output.write("full.txt", full.encode("utf-8"))
        self.output.json("report.json", self.report)
        return self.report


def run(input_path, output_path, source_hash, source_name, ocr=None, emit=None):
    if not re.fullmatch(r"[0-9a-fA-F]{64}", source_hash):
        raise DiagnosticError("sha256 must be 64 hexadecimal characters")
    source_hash = source_hash.lower()
    input_path = Path(input_path)
    if not input_path.is_absolute():
        raise UnsafePath("Input must be an absolute path")
    if input_path.is_relative_to(Path(output_path)):
        raise UnsafePath("Input must be outside the output directory")
    if not source_name or len(source_name) > 1024 or any(ord(c) < 32 for c in source_name):
        raise DiagnosticError("Invalid original source name")
    with SafeDirectory(output_path, create=True) as output:
        for name in ("report.json", "full.txt"):
            output.check(name)
        worker = Worker(output, source_hash, source_name, ocr, emit)
        try:
            with SafeDirectory(input_path.parent) as parent:
                if os.path.samefile(parent.path, output.path):
                    raise UnsafePath("Input must be outside the output directory")
                data = parent.read(input_path.name)
            if digest(data) != source_hash:
                raise DiagnosticError("Input SHA-256 mismatch")
            suffix = Path(source_name).suffix.lower()
            if suffix == ".pdf" and data.startswith(b"%PDF-"):
                worker.pdf(data)
            elif suffix == ".docx" and data.startswith(b"PK"):
                worker.docx(data)
            else:
                raise DiagnosticError("Only matching PDF/DOCX file types are supported")
        except UnsafePath:
            raise
        except Exception as exc:  # noqa: BLE001 - A terminal document error must produce a failed report.
            return worker.finish(exc)
        return worker.finish()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args(argv)
    protocol = sys.stdout

    def emit(value):
        print(json.dumps(value, ensure_ascii=True, allow_nan=False), file=protocol, flush=True)

    code = 1
    try:
        with contextlib.redirect_stdout(sys.stderr):
            report = run(args.input, args.output, args.sha256, args.name, emit=emit)
        code = 1 if report["status"] == "failed" else 0
        if code:
            print(json.dumps({"diagnostic": report["warnings"], "failedPages": [p for p in report["pages"] if p["status"] == "failed"]},
                             ensure_ascii=True), file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001 - Preserve protocol completion even on output failures.
        print(json.dumps({"diagnostic": str(exc)}, ensure_ascii=True), file=sys.stderr, flush=True)
    finally:
        emit({"type": "done"})
    return code


if __name__ == "__main__":
    raise SystemExit(main())
