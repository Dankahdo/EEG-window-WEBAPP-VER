from __future__ import annotations

import copy
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any

try:
    import mne
except ImportError:  # pragma: no cover - handled at runtime
    mne = None


def get_channel_names(eeg_data: dict[str, Any]) -> list[str]:
    if "channel_names" in eeg_data:
        return list(eeg_data["channel_names"])
    return list(eeg_data.get("channels", []))


def get_sampling_rate(eeg_data: dict[str, Any]) -> float | None:
    sampling_rate = eeg_data.get("sampling_rate")
    return float(sampling_rate) if sampling_rate is not None else None


def get_signal_data(eeg_data: dict[str, Any], channel_name: str) -> list[float]:
    channels = eeg_data.get("channels")
    if isinstance(channels, list):
        for channel_data in channels:
            if channel_data.get("channel_name") == channel_name:
                return list(channel_data.get("y", []))

    signals = eeg_data.get("signals", {})
    channel_data = signals.get(channel_name, {})
    return list(channel_data.get("y", []))


def get_time_vector(eeg_data: dict[str, Any], channel_name: str | None = None) -> list[float]:
    if "time_vector" in eeg_data:
        return list(eeg_data["time_vector"])

    channels = eeg_data.get("channels")
    if isinstance(channels, list) and channels:
        if channel_name is not None:
            for channel_data in channels:
                if channel_data.get("channel_name") == channel_name and "x" in channel_data:
                    return list(channel_data["x"])
        if "x" in channels[0]:
            return list(channels[0]["x"])

    sampling_rate = get_sampling_rate(eeg_data)
    channel_names = get_channel_names(eeg_data)
    if not sampling_rate or not channel_names:
        return []

    first_channel = channel_names[0]
    signal_data = get_signal_data(eeg_data, first_channel)
    return [index / sampling_rate for index in range(len(signal_data))]


def list_events(eeg_data: dict[str, Any]) -> list[dict[str, Any]]:
    return list(eeg_data.get("events", []))


def ensure_mne_available() -> None:
    if mne is None:
        raise RuntimeError(
            "MNE is not installed. EDF conversion is unavailable until the webapp requirements are installed."
        )


def raw_to_eeg_json(raw: Any) -> dict[str, Any]:
    data = raw.get_data()
    channel_names = list(raw.ch_names)
    sampling_rate = float(raw.info["sfreq"])
    signal_length = data.shape[1]
    duration_seconds = signal_length / sampling_rate
    time_vector = [index / sampling_rate for index in range(signal_length)]

    channels = []
    for index, channel_name in enumerate(channel_names):
        channels.append({
            "channel_name": channel_name,
            "y": data[index].tolist(),
        })

    events = []
    if getattr(raw, "annotations", None) is not None:
        for annotation in raw.annotations:
            events.append({
                "time": float(annotation["onset"]),
                "duration": float(annotation["duration"]),
                "description": annotation["description"],
                "type": annotation["description"],
            })

    return {
        "sampling_rate": sampling_rate,
        "channel_names": channel_names,
        "duration_seconds": duration_seconds,
        "time_vector": time_vector,
        "channels": channels,
        "events": events,
    }


def parse_edf_bytes(file_bytes: bytes, filename: str = "upload.edf") -> dict[str, Any]:
    ensure_mne_available()

    suffix = Path(filename).suffix or ".edf"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(file_bytes)
            temp_path = temp_file.name

        raw = mne.io.read_raw_edf(temp_path, preload=True, verbose=False)
        return raw_to_eeg_json(raw)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def segment_eeg_json(eeg_data: dict[str, Any], segment_duration_sec: float = 60) -> list[tuple[str, dict[str, Any]]]:
    sampling_rate = get_sampling_rate(eeg_data)
    if not sampling_rate:
        raise ValueError("EEG data is missing a sampling_rate.")

    channel_names = get_channel_names(eeg_data)
    if not channel_names:
        raise ValueError("EEG data is missing channel_names.")

    total_samples = len(get_time_vector(eeg_data))
    segment_samples = max(1, int(segment_duration_sec * sampling_rate))
    num_segments = (total_samples + segment_samples - 1) // segment_samples
    events = list_events(eeg_data)
    segments: list[tuple[str, dict[str, Any]]] = []

    for segment_index in range(num_segments):
        start = segment_index * segment_samples
        end = min((segment_index + 1) * segment_samples, total_samples)
        signal_length = end - start
        segment_duration = signal_length / sampling_rate
        time_vector = [(start + offset) / sampling_rate for offset in range(signal_length)]

        channels = []
        for channel_name in channel_names:
            channels.append({
                "channel_name": channel_name,
                "y": get_signal_data(eeg_data, channel_name)[start:end],
            })

        segment_start_time = start / sampling_rate
        segment_end_time = end / sampling_rate
        segment_events = [
            event
            for event in events
            if segment_start_time <= float(event.get("time", 0)) < segment_end_time
        ]

        payload = {
            "sampling_rate": sampling_rate,
            "channel_names": channel_names,
            "duration_seconds": segment_duration,
            "time_vector": time_vector,
            "channels": channels,
            "events": segment_events,
        }
        filename = f"segment_{segment_index + 1:03d}.json"
        segments.append((filename, payload))

    return segments


def build_clips(eeg_data: dict[str, Any], selections: list[list[float] | tuple[float, float]]) -> list[tuple[str, dict[str, Any]]]:
    channel_names = get_channel_names(eeg_data)
    sampling_rate = get_sampling_rate(eeg_data)
    original_time = get_time_vector(eeg_data)

    if not channel_names or not sampling_rate or not original_time:
        raise ValueError("EEG data is missing required fields for clipping.")

    clips: list[tuple[str, dict[str, Any]]] = []
    sorted_selections = sorted(
        [(float(start), float(end)) for start, end in selections if float(end) > float(start)],
        key=lambda item: item[0],
    )

    for index, (start_time, end_time) in enumerate(sorted_selections):
        start_idx = None
        end_idx = None
        for sample_index, timestamp in enumerate(original_time):
            if start_idx is None and timestamp >= start_time:
                start_idx = sample_index
            if timestamp <= end_time:
                end_idx = sample_index

        if start_idx is None or end_idx is None or end_idx < start_idx:
            continue

        segment_time = original_time[start_idx : end_idx + 1]
        adjusted_time = [timestamp - start_time for timestamp in segment_time]
        clip_channels = []

        for channel_name in channel_names:
            signal_data = get_signal_data(eeg_data, channel_name)
            clip_channels.append({
                "channel_name": channel_name,
                "y": signal_data[start_idx : end_idx + 1],
            })

        new_events = []
        for event in list_events(eeg_data):
            event_time = float(event.get("time", 0))
            if start_time <= event_time <= end_time:
                clipped_event = copy.deepcopy(event)
                clipped_event["time"] = event_time - start_time
                new_events.append(clipped_event)

        clip_duration = end_time - start_time
        payload = {
            "sampling_rate": sampling_rate,
            "channel_names": channel_names,
            "duration_seconds": clip_duration,
            "time_vector": adjusted_time,
            "channels": clip_channels,
            "events": new_events,
        }
        filename = f"clip_{index + 1:03d}_{start_time:.2f}s-{end_time:.2f}s.json"
        clips.append((filename, payload))

    return clips


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, indent=2).encode("utf-8")


def zip_json_payloads(items: list[tuple[str, dict[str, Any]]]) -> io.BytesIO:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename, payload in items:
            archive.writestr(filename, json_bytes(payload))
    buffer.seek(0)
    return buffer
