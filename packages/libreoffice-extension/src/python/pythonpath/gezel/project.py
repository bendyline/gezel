"""The Gezel project for the open document: the daemon's folder inference."""

from __future__ import annotations


def infer_project(http, token, path):
    body = {"kind": "document", "source": "libreoffice"}
    if path:
        body["path"] = path
    res = http.request_json("POST", "/api/projects/infer-for-path", body, token=token)
    project = res.get("project") or {}
    return {
        "id": project.get("id", "default"),
        "name": project.get("name", "Default"),
        "readOnly": bool(res.get("readOnly")),
        "voormanGezelId": project.get("voormanGezelId"),
        "gezelIds": project.get("gezelIds") or [],
        "matchedBy": res.get("matchedBy"),
    }


def list_gezels(http, token):
    return http.request_json("GET", "/api/gezels", token=token).get("gezels", [])


def pick_default_gezel(project, roster, meester_id=None, remembered=None):
    ids = {g.get("id") for g in roster}
    for candidate in [remembered, project.get("voormanGezelId"), *(project.get("gezelIds") or []), meester_id]:
        if candidate and candidate in ids:
            return candidate
    return roster[0]["id"] if roster else ""
