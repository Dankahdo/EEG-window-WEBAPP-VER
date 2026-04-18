# EEG Clipper Webapp

This folder contains a standalone web version of the desktop EEG clipper.

## What it does

- Load EEG JSON files directly in the browser
- Convert EDF files to the project JSON format through the Python backend
- Preview multichannel EEG traces in a browser canvas viewer
- Drag to select time regions across the visible channels
- Export selected regions as JSON clips packed into a ZIP file
- Export EDF files as one JSON file or as segmented JSON files

## Structure

- `server/app.py`: FastAPI app and HTTP endpoints
- `server/eeg_service.py`: JSON normalization, EDF conversion, segmentation, and clip export logic
- `static/index.html`: Web UI shell
- `static/styles.css`: Styles based on the current graph-page layout direction
- `static/app.js`: Viewer rendering, selections, uploads, and downloads

## Run

1. Create or activate a Python environment.
2. Install dependencies:

```bash
pip install -r webapp/requirements.txt
```

3. Start the server from the repository root:

```bash
uvicorn webapp.server.app:app --reload
```

4. Open `http://127.0.0.1:8000`.

## API endpoints

- `POST /api/edf/convert`
  - multipart fields:
    - `file`: EDF file
    - `action`: `preview`, `full`, or `segments`
    - `segment_duration`: seconds per segment when `action=segments`
- `POST /api/clips/export`
  - JSON body with `eeg_data` and `selections`

## Notes

- Clip export follows the same shared `time_vector` format used by the desktop tool.
- EDF support depends on `mne` being installed in the Python environment used for the web server.
