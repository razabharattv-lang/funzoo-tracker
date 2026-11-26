import argparse
import asyncio
import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Any, Dict, List, Set

import edge_tts
import requests


def infer_cloudinary_cloud_name(url: str) -> str:
    match = re.search(r"res\.cloudinary\.com/([^/]+)/", url or "")
    return match.group(1) if match else ""


JOB_ID = os.getenv("JOB_ID", "").strip() or f"job_{int(time.time())}"
RAW_VIDEO_URL = os.getenv("RAW_VIDEO_URL", "").strip()
RAW_PUBLIC_ID = os.getenv("RAW_PUBLIC_ID", "").strip()
CUSTOM_PROMPT = os.getenv("CUSTOM_PROMPT", "").strip()
VOICE_GENDER = (os.getenv("VOICE_GENDER", "female").strip() or "female").lower()
SHIELD_OPTIONS_RAW = os.getenv(
    "SHIELD_OPTIONS", "crop_watermark,micro_zoom,color_grade,strip_metadata"
).strip()
CAPTION_THEME = (
    os.getenv("CAPTION_THEME", "capcut_yellow_white").strip() or "capcut_yellow_white"
).lower()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
CLOUDINARY_CLOUD_NAME = (
    os.getenv("CLOUDINARY_CLOUD_NAME", "").strip()
    or infer_cloudinary_cloud_name(RAW_VIDEO_URL)
)
CLOUDINARY_API_KEY = os.getenv("CLOUDINARY_API_KEY", "").strip()
CLOUDINARY_API_SECRET = os.getenv("CLOUDINARY_API_SECRET", "").strip()
CLOUDINARY_UPLOAD_PRESET = os.getenv("CLOUDINARY_UPLOAD_PRESET", "").strip()

STATE_FILE = Path("job_state.json")
RAW_VIDEO_PATH = Path("raw_input.mp4")
ASS_SUBS_PATH = Path("viral_subs.ass")
FINAL_VIDEO_PATH = Path("final_viral.mp4")
RESULT_MANIFEST_PATH = Path("result_manifest.json")

VISION_MODELS = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"]
TTS_MODELS = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]


def parse_shield_options(raw: str) -> Set[str]:
    if not raw:
        return set()
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def load_state() -> Dict[str, Any]:
    if not STATE_FILE.exists():
        raise FileNotFoundError("Missing job_state.json from previous pipeline stage.")
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def save_state(state: Dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def get_media_duration(file_path: str) -> float:
    if file_path.endswith(".wav"):
        with wave.open(file_path, "rb") as wf:
            return wf.getnframes() / float(wf.getframerate())
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file_path,
    ]
    out = subprocess.check_output(cmd, text=True).strip()
    return max(1.0, float(out))


def download_raw_video(url: str, dest: Path) -> None:
    if not url:
        raise ValueError("RAW_VIDEO_URL is required.")
    print(f"[analyze] Downloading raw video from Cloudinary -> {dest}")
    for attempt in range(1, 4):
        try:
            with requests.get(url, stream=True, timeout=90) as resp:
                resp.raise_for_status()
                with dest.open("wb") as f:
                    for chunk in resp.iter_content(chunk_size=1024 * 512):
                        if chunk:
                            f.write(chunk)
            if dest.stat().st_size == 0:
                raise ValueError("Downloaded video file is empty.")
            print(f"[analyze] Downloaded {dest.stat().st_size / (1024 * 1024):.2f} MB")
            return
        except Exception as exc:
            print(f"[analyze] Download attempt {attempt} failed: {exc}")
            if attempt == 3:
                raise
            time.sleep(attempt * 2)


def extract_frames_base64(video_path: Path, dur: float) -> List[str]:
    frames_b64: List[str] = []
    ratios = [0.10, 0.30, 0.50, 0.70, 0.88]
    for idx, ratio in enumerate(ratios):
        sec = max(0.3, min(dur - 0.2, dur * ratio))
        img_path = Path(f"frame_{idx}.jpg")
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{sec:.2f}",
                "-i",
                str(video_path),
                "-vf",
                "scale=512:-1",
                "-vframes",
                "1",
                "-q:v",
                "5",
                str(img_path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if img_path.exists() and img_path.stat().st_size > 0:
            frames_b64.append(base64.b64encode(img_path.read_bytes()).decode("utf-8"))
    if not frames_b64:
        raise RuntimeError("Failed to extract visual frames from raw video.")
    return frames_b64


def strip_json_fences(raw_text: str) -> str:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    return cleaned


def analyze_video_with_gemini(
    frames_b64: List[str], clean_dur: float, custom_prompt: str
) -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        raise ValueError("GEMINI_API_KEY secret is not configured in GitHub Actions.")

    target_words = max(24, min(46, int(clean_dur * 2.65)))
    if custom_prompt:
        angle_instruction = (
            f"CREATOR CUSTOM EXPLANATION / ANGLE:\n\"{custom_prompt}\"\n\n"
            "Expand this exact idea/hook into a punchy, high-retention US explainer narration "
            "that stays grounded in what is visibly happening in the frames."
        )
    else:
        angle_instruction = (
            "No custom angle was provided. Analyze the video frames closely using vision and write "
            "a curiosity-driven US explainer script automatically: open with a scroll-stopping hook "
            "in the first 1.5 seconds, explain the clever visual payoff in natural American English, "
            "and close with an engaging comment-bait question."
        )

    prompt = f"""
You are an elite short-form US explainer video strategist targeting High-CPM audiences (United States, UK, Canada, Europe) on YouTube Shorts, Instagram Reels, and Facebook Reels.
Video duration: {clean_dur:.1f} seconds.

{angle_instruction}

Rules:
- Voiceover must be natural spoken American English, roughly {target_words} words, punchy short sentences, zero hashtags or stage directions inside the voiceover text.
- Title must be a crisp, high-CTR US Reels/Shorts title (under 68 characters, no generic filler).
- Description must be 2 engaging SEO-optimized lines tailored specifically to this video.
- Tags must be 15 high-intent comma-separated trending US search tags for this exact subject.
- Hashtags must be 7 ultra-targeted US/EU hashtags starting with # separated by spaces.
- Posting time must be the single best US/EU posting window (e.g., "6:30 PM EST / 11:30 PM GMT — Peak US Commute & Evening Scroll").

Return ONLY valid JSON matching this exact schema:
{{
  "voiceover": "...",
  "title": "...",
  "description": "...",
  "tags": "...",
  "hashtags": "...",
  "posting_time": "..."
}}
""".strip()

    parts: List[Dict[str, Any]] = [{"text": prompt}]
    for b64 in frames_b64:
        parts.append({"inlineData": {"mimeType": "image/jpeg", "data": b64}})

    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ],
    }

    last_err = ""
    for attempt in range(1, 5):
        for model in VISION_MODELS:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"
            try:
                resp = requests.post(url, json=payload, timeout=75)
                if resp.status_code in (429, 500, 502, 503, 504):
                    last_err = f"{model} HTTP {resp.status_code}: {resp.text[:180]}"
                    print(f"[analyze] Transient {resp.status_code} on {model} (attempt {attempt}), retrying...")
                    time.sleep(min(12, 2 ** attempt))
                    continue
                data = resp.json()
                candidates = data.get("candidates") or []
                if candidates:
                    raw_text = candidates[0]["content"]["parts"][0]["text"]
                    parsed = json.loads(strip_json_fences(raw_text))
                    if parsed.get("voiceover"):
                        print(f"[analyze] Script & metadata generated via {model}")
                        return parsed
                last_err = f"{model} invalid response: {str(data)[:220]}"
            except Exception as exc:
                last_err = f"{model} error: {exc}"
                print(f"[analyze] {last_err}")
                continue
        time.sleep(min(10, attempt * 3))

    raise RuntimeError(f"Gemini Vision & Script failed after retries: {last_err[:280]}")


def generate_human_voice(text: str, gender: str, wav_out: str = "vo.wav") -> Dict[str, str]:
    is_male = gender == "male"
    gemini_voice = "Puck" if is_male else "Aoede"
    edge_voice = (
        "en-US-AndrewMultilingualNeural" if is_male else "en-US-AvaMultilingualNeural"
    )

    if GEMINI_API_KEY:
        for model in TTS_MODELS:
            for attempt in range(1, 3):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"
                payload = {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "text": text,
                                    "speechMetadata": {
                                        "style": "Engaging, energetic, natural American short-form explainer narrator"
                                    },
                                }
                            ],
                        }
                    ],
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {"voiceName": gemini_voice}
                            }
                        },
                    },
                }
                try:
                    resp = requests.post(url, json=payload, timeout=45)
                    if resp.status_code in (429, 500, 502, 503, 504):
                        print(f"[voice] Gemini TTS {model} returned {resp.status_code}, retrying...")
                        time.sleep(2 * attempt)
                        continue
                    data = resp.json()
                    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    inline = parts[0].get("inlineData", {}) if parts else {}
                    audio_b64 = inline.get("data")
                    if not audio_b64:
                        break
                    audio_bytes = base64.b64decode(audio_b64)
                    if audio_bytes[:4] == b"RIFF":
                        Path(wav_out).write_bytes(audio_bytes)
                    else:
                        with wave.open(wav_out, "wb") as wf:
                            wf.setnchannels(1)
                            wf.setsampwidth(2)
                            wf.setframerate(24000)
                            wf.writeframes(audio_bytes)
                    print(f"[voice] Synthesized voiceover via {model} ({gemini_voice})")
                    return {"file": wav_out, "engine": f"{model} ({gemini_voice})"}
                except Exception as exc:
                    print(f"[voice] Gemini TTS {model} fallback note: {exc}")
                    break

    mp3_out = "vo_edge.mp3"
    print(f"[voice] Falling back to Edge-TTS ({edge_voice})")

    async def _run_edge_tts() -> None:
        comm = edge_tts.Communicate(text, edge_voice, rate="+4%")
        await comm.save(mp3_out)

    asyncio.run(_run_edge_tts())
    return {"file": mp3_out, "engine": f"Edge-TTS ({edge_voice})"}


def build_ass_subtitles(
    text: str, audio_file: str, theme: str, ass_out: Path = ASS_SUBS_PATH
) -> str:
    if theme == "none":
        return ""

    total_dur = get_media_duration(audio_file)
    clean_words = (
        text.replace('"', "")
        .replace("“", "")
        .replace("”", "")
        .replace("\n", " ")
        .upper()
        .split()
    )
    chunks = [clean_words[i : i + 3] for i in range(0, len(clean_words), 3)]

    def fmt_ass_time(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        cs = int(round((sec - int(sec)) * 100))
        if cs >= 100:
            s += 1
            cs = 0
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    # ASS colors are &HAABBGGRR&
    if theme == "clean_white":
        primary_color = "&H00FFFFFF"
        accent_even = "&H00FFFFFF&"
        accent_odd = "&H00E8E8E8&"
        outline_px = 6
    elif theme == "coral_pop":
        primary_color = "&H00FFFFFF"
        accent_even = "&H004417FF&"  # #FF1744 in BGR
        accent_odd = "&H0000D7FF&"
        outline_px = 7
    else:
        # capcut_yellow_white default
        primary_color = "&H00FFFFFF"
        accent_even = "&H0000D7FF&"  # Gold Yellow
        accent_odd = "&H0000FFFF&"  # Bright Yellow
        outline_px = 7

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ViralPop,DejaVu Sans,76,{primary_color},&H0000FFFF,&H00000000,&H90000000,-1,0,0,0,100,100,1.2,0,1,{outline_px},4,2,42,42,350,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    step = total_dur / max(len(chunks), 1)
    events: List[str] = []
    for idx, word_group in enumerate(chunks):
        start = fmt_ass_time(idx * step)
        end = fmt_ass_time(min((idx + 1) * step, total_dur))
        highlight = accent_even if idx % 2 == 0 else accent_odd
        if len(word_group) > 1:
            styled_text = (
                " ".join(word_group[:-1])
                + f" {{\\c{highlight}}}{word_group[-1]}{{\\c&H00FFFFFF&}}"
            )
        else:
            styled_text = f"{{\\c{highlight}}}{word_group[0]}"

        anim = "{\\fscx86\\fscy86\\t(0,65,\\fscx108\\fscy108)\\t(65,130,\\fscx100\\fscy100)}"
        events.append(f"Dialogue: 0,{start},{end},ViralPop,,0,0,0,,{anim}{styled_text}")

    ass_out.write_text(header + "\n".join(events), encoding="utf-8")
    print(f"[voice] Built ASS pop-up captions ({theme}, {len(events)} cue blocks)")
    return str(ass_out)


def render_ffmpeg_master(
    in_vid: Path,
    vo_audio: str,
    ass_file: str,
    out_vid: Path,
    target_dur: float,
    shield: Set[str],
) -> None:
    filters: List[str] = []

    if "crop_watermark" in shield:
        # 15% overscale + center crop removes TikTok/Douyin/RedNote edge watermarks
        filters.append("scale=1242:2208:force_original_aspect_ratio=increase")
        filters.append("crop=1080:1920")
    else:
        filters.append("scale=1080:1920:force_original_aspect_ratio=increase")
        filters.append("crop=1080:1920")

    if "micro_zoom" in shield:
        filters.append(
            "zoompan=z='1.0+0.04*abs(sin(on/50))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30"
        )
    else:
        filters.append("fps=30")

    if "color_grade" in shield:
        filters.append("eq=contrast=1.14:saturation=1.35:brightness=0.02:gamma=1.04")
        filters.append("colorbalance=rs=0.04:gs=0.02:bs=-0.02")
        filters.append("unsharp=5:5:0.80:3:3:0.35")

    if ass_file and Path(ass_file).exists():
        filters.append(f"ass={ass_file}")

    filters.append("format=yuv420p")

    vf = "[0:v]" + ",".join(filters) + "[v_out];"
    af = "[1:a]volume=1.55,equalizer=f=180:t=q:w=1:g=2,equalizer=f=4200:t=q:w=1:g=2.5,alimiter=limit=0.95,apad[a_out]"

    cmd = [
        "ffmpeg",
        "-y",
        "-stream_loop",
        "-1",
        "-i",
        str(in_vid),
        "-i",
        vo_audio,
        "-filter_complex",
        vf + af,
        "-map",
        "[v_out]",
        "-map",
        "[a_out]",
        "-t",
        f"{target_dur:.2f}",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "19",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
    ]
    if "strip_metadata" in shield:
        cmd.extend(["-map_metadata", "-1", "-fflags", "+bitexact"])

    cmd.append(str(out_vid))
    print(f"[render] Executing FFmpeg 1080x1920 anti-copyright render (shield={sorted(shield)})")
    subprocess.run(cmd, check=True)
    print(
        f"[render] Render complete: {out_vid} ({out_vid.stat().st_size / (1024 * 1024):.2f} MB)"
    )


def sign_cloudinary_params(params: Dict[str, Any]) -> str:
    sorted_pairs = sorted(
        (k, str(v)) for k, v in params.items() if v is not None and str(v) != ""
    )
    to_sign = "&".join(f"{k}={v}" for k, v in sorted_pairs) + CLOUDINARY_API_SECRET
    return hashlib.sha1(to_sign.encode("utf-8")).hexdigest()


def cloudinary_upload(
    file_path: Path, resource_type: str, public_id: str
) -> Dict[str, Any]:
    if not CLOUDINARY_CLOUD_NAME:
        raise ValueError("CLOUDINARY_CLOUD_NAME secret is not configured.")

    endpoint = (
        f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/{resource_type}/upload"
    )
    data: Dict[str, Any] = {"public_id": public_id}

    if CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET:
        timestamp = str(int(time.time()))
        sign_payload = {
            "overwrite": "true",
            "public_id": public_id,
            "timestamp": timestamp,
        }
        data.update(
            {
                "api_key": CLOUDINARY_API_KEY,
                "overwrite": "true",
                "timestamp": timestamp,
                "signature": sign_cloudinary_params(sign_payload),
            }
        )
    elif CLOUDINARY_UPLOAD_PRESET:
        data["upload_preset"] = CLOUDINARY_UPLOAD_PRESET
    else:
        raise ValueError(
            "Provide CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET (recommended) or CLOUDINARY_UPLOAD_PRESET."
        )

    with file_path.open("rb") as fh:
        resp = requests.post(
            endpoint,
            data=data,
            files={"file": (file_path.name, fh)},
            timeout=180,
        )
    if not resp.ok:
        raise RuntimeError(
            f"Cloudinary {resource_type} upload failed ({resp.status_code}): {resp.text[:260]}"
        )
    return resp.json()


def delete_raw_cloudinary_video(public_id: str) -> bool:
    if not public_id:
        return False
    if not (CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET):
        print(
            "[cleanup] Skipping Cloudinary raw deletion: CLOUDINARY_API_KEY/SECRET not set."
        )
        return False

    endpoint = f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/video/destroy"
    timestamp = str(int(time.time()))
    sign_payload = {
        "invalidate": "true",
        "public_id": public_id,
        "timestamp": timestamp,
    }
    payload = {
        "public_id": public_id,
        "invalidate": "true",
        "timestamp": timestamp,
        "api_key": CLOUDINARY_API_KEY,
        "signature": sign_cloudinary_params(sign_payload),
    }
    resp = requests.post(endpoint, data=payload, timeout=30)
    if resp.ok:
        print(f"[cleanup] Deleted temporary raw video from Cloudinary: {public_id}")
        return True
    print(f"[cleanup] Warning: Could not delete {public_id}: {resp.text[:180]}")
    return False


def stage_analyze() -> None:
    shield = parse_shield_options(SHIELD_OPTIONS_RAW)
    download_raw_video(RAW_VIDEO_URL, RAW_VIDEO_PATH)
    raw_dur = get_media_duration(str(RAW_VIDEO_PATH))
    if "crop_watermark" in shield and raw_dur > 7.5:
        clean_dur = max(4.5, raw_dur - 1.8)
    else:
        clean_dur = raw_dur

    frames = extract_frames_base64(RAW_VIDEO_PATH, clean_dur)
    ai_data = analyze_video_with_gemini(frames, clean_dur, CUSTOM_PROMPT)

    state = {
        "job_id": JOB_ID,
        "raw_public_id": RAW_PUBLIC_ID,
        "raw_dur": raw_dur,
        "clean_dur": clean_dur,
        "voice_gender": VOICE_GENDER,
        "shield_options": sorted(shield),
        "caption_theme": CAPTION_THEME,
        "custom_prompt": CUSTOM_PROMPT,
        "ai_data": ai_data,
    }
    save_state(state)
    print(f"[analyze] Saved job state for {JOB_ID}")


def stage_voice() -> None:
    state = load_state()
    ai_data = state["ai_data"]
    vo_info = generate_human_voice(ai_data["voiceover"], state["voice_gender"])
    vo_dur = get_media_duration(vo_info["file"])
    final_dur = max(state["clean_dur"], min(max(state["raw_dur"], vo_dur + 0.35), 59.0))
    ass_file = build_ass_subtitles(
        ai_data["voiceover"], vo_info["file"], state["caption_theme"], ASS_SUBS_PATH
    )

    state["vo_file"] = vo_info["file"]
    state["voice_engine"] = vo_info["engine"]
    state["vo_dur"] = vo_dur
    state["final_dur"] = final_dur
    state["ass_file"] = ass_file
    save_state(state)


def stage_render() -> None:
    state = load_state()
    shield = set(state.get("shield_options", []))
    render_ffmpeg_master(
        RAW_VIDEO_PATH,
        state["vo_file"],
        state.get("ass_file", ""),
        FINAL_VIDEO_PATH,
        float(state["final_dur"]),
        shield,
    )


def stage_publish() -> None:
    state = load_state()
    ai_data = state["ai_data"]

    video_public_id = f"us-explainer-studio/processed/final_{JOB_ID}"
    upload_res = cloudinary_upload(FINAL_VIDEO_PATH, "video", video_public_id)
    final_video_url = upload_res["secure_url"]

    manifest = {
        "job_id": JOB_ID,
        "video_url": final_video_url,
        "video_public_id": upload_res.get("public_id", video_public_id),
        "duration_sec": round(float(state["final_dur"]), 2),
        "width": 1080,
        "height": 1920,
        "file_size_bytes": FINAL_VIDEO_PATH.stat().st_size,
        "voice_gender": state["voice_gender"],
        "voice_engine": state.get("voice_engine", ""),
        "shield_options": state.get("shield_options", []),
        "caption_theme": state.get("caption_theme", "capcut_yellow_white"),
        "voiceover": ai_data.get("voiceover", ""),
        "title": ai_data.get("title", ""),
        "description": ai_data.get("description", ""),
        "tags": ai_data.get("tags", ""),
        "hashtags": ai_data.get("hashtags", ""),
        "posting_time": ai_data.get("posting_time", ""),
        "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    RESULT_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # Upload JSON manifest as a raw Cloudinary asset so Cloudflare Pages can fetch it via CORS
    manifest_public_id = f"us-explainer-studio/results/{JOB_ID}.json"
    cloudinary_upload(RESULT_MANIFEST_PATH, "raw", manifest_public_id)
    print(f"[publish] Uploaded manifest to Cloudinary: {manifest_public_id}")

    # Clean up temporary raw clip from Cloudinary
    delete_raw_cloudinary_video(state.get("raw_public_id") or RAW_PUBLIC_ID)

    # Write clean GitHub Actions Step Summary
    summary_path = os.getenv("GITHUB_STEP_SUMMARY", "")
    if summary_path:
        summary_md = (
            f"## US Explainer Video Render Complete (`{JOB_ID}`)\n\n"
            f"- **Output MP4 (`1080x1920`)**: {final_video_url}\n"
            f"- **Voice Engine**: {manifest['voice_engine']}\n"
            f"- **High-CTR Title**: {manifest['title']}\n"
            f"- **Best Posting Time**: {manifest['posting_time']}\n"
        )
        with open(summary_path, "a", encoding="utf-8") as sf:
            sf.write(summary_md)


def main() -> None:
    parser = argparse.ArgumentParser(description="US Explainer Video Studio 7GB Cloud Engine")
    parser.add_argument(
        "--stage",
        choices=["analyze", "voice", "render", "publish", "cleanup_raw", "all"],
        default="all",
    )
    args = parser.parse_args()

    if args.stage == "analyze":
        stage_analyze()
    elif args.stage == "voice":
        stage_voice()
    elif args.stage == "render":
        stage_render()
    elif args.stage == "publish":
        stage_publish()
    elif args.stage == "cleanup_raw":
        delete_raw_cloudinary_video(RAW_PUBLIC_ID)
    elif args.stage == "all":
        stage_analyze()
        stage_voice()
        stage_render()
        stage_publish()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
