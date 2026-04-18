from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .eeg_service import build_clips, json_bytes, parse_edf_bytes, segment_eeg_json, zip_json_payloads


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="EEG Clipper Webapp")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ClipExportRequest(BaseModel):
    eeg_data: dict[str, Any]
    selections: list[tuple[float, float]]


@app.get("/api/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/edf/convert", response_model=None)
async def convert_edf(
    file: UploadFile = File(...),
    action: str = Form("preview"),
    segment_duration: float = Form(60),
) -> JSONResponse | StreamingResponse:
    try:
        file_bytes = await file.read()
        eeg_data = parse_edf_bytes(file_bytes, file.filename or "upload.edf")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read EDF file: {exc}") from exc

    stem = Path(file.filename or "eeg_data").stem
    if action == "preview":
        return JSONResponse(content=eeg_data)

    if action == "full":
        payload = json_bytes(eeg_data)
        headers = {"Content-Disposition": f'attachment; filename="{stem}.json"'}
        return StreamingResponse(iter([payload]), media_type="application/json", headers=headers)

    if action == "segments":
        try:
            segments = segment_eeg_json(eeg_data, segment_duration_sec=segment_duration)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to segment EDF file: {exc}") from exc

        archive = zip_json_payloads(segments)
        headers = {"Content-Disposition": f'attachment; filename="{stem}_segments.zip"'}
        return StreamingResponse(archive, media_type="application/zip", headers=headers)

    raise HTTPException(status_code=400, detail="Unsupported action. Use preview, full, or segments.")


@app.post("/api/clips/export")
def export_clips(request: ClipExportRequest) -> StreamingResponse:
    try:
        clips = build_clips(request.eeg_data, request.selections)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to build clips: {exc}") from exc

    if not clips:
        raise HTTPException(status_code=400, detail="No valid selections were provided.")

    archive = zip_json_payloads(clips)
    headers = {"Content-Disposition": 'attachment; filename="eeg_clips.zip"'}
    return StreamingResponse(archive, media_type="application/zip", headers=headers)


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
