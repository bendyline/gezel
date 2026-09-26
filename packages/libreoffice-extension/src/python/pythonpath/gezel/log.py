"""File log beside Gezel's own: <home>/logs/libreoffice-extension.log."""

from __future__ import annotations

import logging
import logging.handlers
import os

from .discovery import gezel_home

_logger = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger
    logger = logging.getLogger("gezel.libreoffice")
    logger.setLevel(logging.INFO)
    try:
        folder = os.path.join(gezel_home(), "logs")
        os.makedirs(folder, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            os.path.join(folder, "libreoffice-extension.log"), maxBytes=1_000_000, backupCount=2, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
    except OSError:
        logger.addHandler(logging.NullHandler())
    _logger = logger
    return logger
