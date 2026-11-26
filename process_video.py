import argparse
import asyncio
import base64
import datetime
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests


def infer_cloudinary_cloud_name(url: str) -> str:
    match = re.search(r"res\.cloudinary\.com/([^/]+)/", url or "")
    return match.group(1) if match else ""


def infer_cloudinary_public_id(url: str) -> str:
    if "res.cloudinary.com" not in (url or ""):
        return ""
    parsed = urllib.parse.urlparse(url)
    match = re.search(r"/video/upload/(?:v\d+/)?(.+?)\.[a-zA-Z0-9]+$", parsed.path)
    return urllib.parse.unquote(match.group(1)) if match else ""


VIDEO_SOURCE = os.getenv("VIDEO_SOURCE", "").strip()
SOURCE_TYPE = (os.getenv("SOURCE_TYPE", "link").strip() or "link").lower()
LANGUAGE = (os.getenv("LANGUAGE", "en").strip() or "en").lower()
VOICE_GENDER = (os.getenv("VOICE_GENDER", "male").strip() or "male").lower()
CUSTOM_ANGLE = os.getenv("CUSTOM_ANGLE", "").strip()
CHARACTER_ENABLED = os.getenv("CHARACTER_ENABLED", "false").strip().lower() == "true"
CHARACTER_URL = os.getenv("CHARACTER_URL", "").strip()
OUTFIT_PROMPT = os.getenv("OUTFIT_PROMPT", "").strip()
RUN_TAG = os.getenv("RUN_TAG", "").strip() or f"run_{int(time.time())}"
SESSION_COOKIE = os.getenv("SESSION_COOKIE", "").strip()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "").strip()
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "").strip()
CLOUDINARY_CLOUD_NAME = (
    os.getenv("CLOUDINARY_CLOUD_NAME", "").strip()
    or infer_cloudinary_cloud_name(VIDEO_SOURCE)
    or infer_cloudinary_cloud_name(CHARACTER_URL)
)
CLOUDINARY_API_KEY = os.getenv("CLOUDINARY_API_KEY", "").strip()
CLOUDINARY_API_SECRET = os.getenv("CLOUDINARY_API_SECRET", "").strip()
CLOUDINARY_UPLOAD_PRESET = os.getenv("CLOUDINARY_UPLOAD_PRESET", "").strip()
WAV2LIP_ONNX_URL = os.getenv("WAV2LIP_ONNX_URL", "").strip()
MODEL_CACHE_DIR = Path(
    os.getenv("MODEL_CACHE_DIR", str(Path.home() / ".cache" / "explainer-models"))
)

STATE_FILE = Path("job_state.json")
RAW_VIDEO_PATH = Path("raw_input.mp4")
INFO_JSON_PATH = Path("raw_input.info.json")
CHAR_IMAGE_PATH = Path("character_portrait.png")
RESULT_MANIFEST_PATH = Path("result_manifest.json")

VISION_MODELS = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-4-hydrogen",
]
TTS_MODELS = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]
IMAGE_EDIT_MODELS = ["gemini-3.1-flash-lite-image"]
NVIDIA_NIM_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_NIM_MODEL = "meta/llama-3.3-70b-instruct"

IPHONE_14_PRO_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
)
ANDROID_MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
)


# ---------------------------------------------------------------------------
# 24-HOUR CLOUDINARY AUTO-CLEANUP (PRESERVES `keep_character` ASSETS)
# ---------------------------------------------------------------------------
def cleanup_expired_cloudinary_assets(max_age_hours: float = 24.0) -> int:
    """
    Purges Cloudinary video & raw assets older than `max_age_hours` (default 24h)
    while strictly preserving any asset tagged `keep_character` or inside
    `explainer-studio/characters/`.
    """
    if not (CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET):
        print("[cleanup] Skipping 24h Cloudinary cleanup (Admin API credentials not set).")
        return 0

    try:
        import cloudinary
        import cloudinary.api
    except ImportError as exc:
        print(f"[cleanup] cloudinary package unavailable: {exc}")
        return 0

    cloudinary.config(
        cloud_name=CLOUDINARY_CLOUD_NAME,
        api_key=CLOUDINARY_API_KEY,
        api_secret=CLOUDINARY_API_SECRET,
        secure=True,
    )

    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        hours=max_age_hours
    )
    total_deleted = 0

    for rtype in ("video", "raw"):
        expired_ids: List[str] = []
        next_cursor: Optional[str] = None

        while True:
            try:
                kwargs: Dict[str, Any] = {
                    "type": "upload",
                    "resource_type": rtype,
                    "tags": True,
                    "max_results": 100,
                }
                if next_cursor:
                    kwargs["next_cursor"] = next_cursor
                resp = cloudinary.api.resources(**kwargs)
            except Exception as exc:
                print(f"[cleanup] Failed listing Cloudinary {rtype} resources: {exc}")
                break

            for res in resp.get("resources") or []:
                pub_id = str(res.get("public_id") or "")
                tags = [str(t).lower() for t in (res.get("tags") or [])]
                if "keep_character" in tags or pub_id.startswith("explainer-studio/characters/"):
                    continue

                created_raw = str(res.get("created_at") or "").strip()
                if not created_raw:
                    continue
                try:
                    created_dt = datetime.datetime.fromisoformat(
                        created_raw.replace("Z", "+00:00")
                    )
                    if created_dt.tzinfo is None:
                        created_dt = created_dt.replace(tzinfo=datetime.timezone.utc)
                except ValueError:
                    continue

                if created_dt < cutoff:
                    expired_ids.append(pub_id)

            next_cursor = resp.get("next_cursor")
            if not next_cursor:
                break

        for i in range(0, len(expired_ids), 100):
            batch = expired_ids[i : i + 100]
            try:
                cloudinary.api.delete_resources(
                    batch, resource_type=rtype, invalidate=True
                )
                total_deleted += len(batch)
                print(
                    f"[cleanup] Deleted {len(batch)} expired {rtype} asset(s) (> {max_age_hours:.0f}h old)."
                )
            except Exception as exc:
                print(f"[cleanup] Batch delete failed for {rtype}: {exc}")

    print(
        f"[cleanup] 24-hour Cloudinary cleanup complete: {total_deleted} expired asset(s) purged "
        "(all keep_character assets preserved)."
    )
    return total_deleted


# ---------------------------------------------------------------------------
# CORE HELPERS
# ---------------------------------------------------------------------------
def load_state() -> Dict[str, Any]:
    if not STATE_FILE.exists():
        raise FileNotFoundError("Missing job_state.json from previous stage.")
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def save_state(state: Dict[str, Any]) -> None:
    STATE_FILE.write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def probe_video_info(file_path: Path) -> Dict[str, Any]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        str(file_path),
    ]
    raw = subprocess.check_output(cmd, text=True)
    parsed = json.loads(raw)
    stream = (parsed.get("streams") or [{}])[0]
    dur = float(parsed.get("format", {}).get("duration") or 0.0)
    return {
        "width": int(stream.get("width") or 1080),
        "height": int(stream.get("height") or 1920),
        "duration": max(1.0, dur),
    }


def get_audio_duration(file_path: Path) -> float:
    if file_path.suffix.lower() == ".wav":
        with wave.open(str(file_path), "rb") as wf:
            return wf.getnframes() / float(wf.getframerate())
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(file_path),
    ]
    return max(1.0, float(subprocess.check_output(cmd, text=True).strip()))


def strip_json_fences(raw_text: str) -> str:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        cleaned = cleaned[start : end + 1]
    return cleaned


def call_gemini_json(parts: List[Dict[str, Any]], label: str) -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        raise ValueError("GEMINI_API_KEY secret is not configured in GitHub Actions.")

    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json"},
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
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent?key={GEMINI_API_KEY}"
            )
            try:
                resp = requests.post(url, json=payload, timeout=90)
                if resp.status_code in (429, 500, 502, 503, 504):
                    last_err = f"{model} HTTP {resp.status_code}: {resp.text[:160]}"
                    print(
                        f"[{label}] Transient {resp.status_code} on {model} (attempt {attempt}), retrying..."
                    )
                    time.sleep(min(12, 2 ** attempt))
                    continue
                if resp.status_code == 404:
                    last_err = f"{model} unavailable (404)"
                    continue
                data = resp.json()
                candidates = data.get("candidates") or []
                if candidates:
                    text = candidates[0]["content"]["parts"][0]["text"]
                    parsed = json.loads(strip_json_fences(text))
                    print(f"[{label}] Gemini JSON parsed via {model}")
                    return parsed
                last_err = f"{model} empty candidates: {str(data)[:200]}"
            except Exception as exc:
                last_err = f"{model} error: {exc}"
                print(f"[{label}] {last_err}")
                continue
        time.sleep(min(10, attempt * 2))

    raise RuntimeError(f"Gemini {label} failed after retries: {last_err[:280]}")


def call_nvidia_nim_json(prompt: str, label: str) -> Optional[Dict[str, Any]]:
    """
    Calls NVIDIA NIM API (meta/llama-3.3-70b-instruct) for high-suspense narration
    and YouTube-grounded metadata JSON. Returns None if NVIDIA_API_KEY is unset
    or if all retries fail (so caller falls back cleanly to Gemini).
    """
    if not NVIDIA_API_KEY:
        return None

    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    payload = {
        "model": NVIDIA_NIM_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an elite US YouTube Shorts viral suspense scriptwriter and SEO strategist. "
                    "Return strictly valid JSON only with zero markdown wrappers or commentary."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.65,
        "top_p": 0.9,
        "max_tokens": 1400,
        "response_format": {"type": "json_object"},
    }

    for attempt in range(1, 4):
        try:
            resp = requests.post(
                NVIDIA_NIM_ENDPOINT, headers=headers, json=payload, timeout=75
            )
            if resp.status_code in (429, 500, 502, 503, 504):
                print(
                    f"[{label}] NVIDIA NIM HTTP {resp.status_code} (attempt {attempt}), retrying..."
                )
                time.sleep(min(10, 2 ** attempt))
                continue
            if not resp.ok:
                print(
                    f"[{label}] NVIDIA NIM error HTTP {resp.status_code}: {resp.text[:180]}"
                )
                return None
            data = resp.json()
            content = (
                (data.get("choices") or [{}])[0]
                .get("message", {})
                .get("content", "")
            )
            parsed = json.loads(strip_json_fences(content))
            if isinstance(parsed, dict) and parsed.get("voiceover") and parsed.get("title"):
                print(f"[{label}] Script & SEO metadata generated via NVIDIA NIM ({NVIDIA_NIM_MODEL})")
                return parsed
        except Exception as exc:
            print(f"[{label}] NVIDIA NIM attempt {attempt} failed: {exc}")
            time.sleep(2 * attempt)

    return None


# ---------------------------------------------------------------------------
# STAGE 1: 24H CLEANUP + 3-LAYER DOWNLOADER + AUTO MAIN-SCENE / LONG CLIPPER
# ---------------------------------------------------------------------------
def extract_clean_url(raw_text: str) -> str:
    match = re.search(r"https?://[^\s]+", raw_text or "")
    if not match:
        return (raw_text or "").strip()
    url = match.group(0).strip()
    url = re.sub(r"[.,;!?)\"'】》」』，。！？、]+$", "", url)
    return url


def validate_video_file(file_path: Path) -> Optional[Dict[str, Any]]:
    if not file_path.exists() or file_path.stat().st_size < 25_000:
        return None
    try:
        info = probe_video_info(file_path)
        if info["width"] > 0 and info["height"] > 0 and info["duration"] >= 0.5:
            return info
    except Exception as exc:
        print(f"[fetch] ffprobe validation failed for {file_path}: {exc}")
    return None


def prepare_cookie_args(session_cookie: str) -> Tuple[List[str], Optional[Path]]:
    if not session_cookie:
        return [], None
    if "\t" in session_cookie or "# Netscape HTTP Cookie File" in session_cookie:
        cookie_file = Path("session_cookies.txt")
        content = session_cookie
        if "# Netscape" not in content:
            content = "# Netscape HTTP Cookie File\n" + content
        cookie_file.write_text(content, encoding="utf-8")
        return ["--cookies", str(cookie_file)], cookie_file
    return ["--add-header", f"Cookie:{session_cookie}"], None


def download_stream_to_path(
    url: str,
    dest: Path,
    headers: Dict[str, str],
    cookies: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, Any]]:
    if dest.exists():
        dest.unlink()
    try:
        with requests.get(
            url,
            headers=headers,
            cookies=cookies,
            stream=True,
            timeout=120,
            allow_redirects=True,
        ) as resp:
            if not resp.ok:
                return None
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if "text/html" in ctype or "application/json" in ctype:
                return None
            with dest.open("wb") as fh:
                for chunk in resp.iter_content(chunk_size=1024 * 512):
                    if chunk:
                        fh.write(chunk)
        return validate_video_file(dest)
    except Exception as exc:
        print(f"[fetch] Direct stream download failed ({url[:80]}...): {exc}")
        return None


def try_layer1_ytdlp(clean_url: str) -> Optional[Dict[str, Any]]:
    print(f"[fetch][Layer B] Running yt-dlp on: {clean_url}")
    cookie_args, cookie_file = prepare_cookie_args(SESSION_COOKIE)
    attempts = [
        (IPHONE_14_PRO_UA, "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"),
        (ANDROID_MOBILE_UA, "best[ext=mp4]/best"),
    ]

    try:
        for idx, (ua, fmt) in enumerate(attempts, start=1):
            if RAW_VIDEO_PATH.exists():
                RAW_VIDEO_PATH.unlink()
            if INFO_JSON_PATH.exists():
                INFO_JSON_PATH.unlink()
            cmd = [
                "yt-dlp",
                "--no-playlist",
                "--no-check-certificates",
                "--geo-bypass",
                "--write-info-json",
                "--user-agent",
                ua,
                "--add-header",
                "Accept-Language:en-US,en;q=0.9,zh-CN;q=0.8",
                "--format",
                fmt,
                "--merge-output-format",
                "mp4",
                "--retries",
                "3",
                "--socket-timeout",
                "30",
                "--output",
                "raw_input.%(ext)s",
                *cookie_args,
                clean_url,
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if not RAW_VIDEO_PATH.exists():
                for candidate in Path(".").glob("raw_input.*"):
                    if candidate.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}:
                        if candidate.suffix.lower() != ".mp4":
                            subprocess.run(
                                [
                                    "ffmpeg",
                                    "-y",
                                    "-i",
                                    str(candidate),
                                    "-c:v",
                                    "libx264",
                                    "-preset",
                                    "veryfast",
                                    "-c:a",
                                    "aac",
                                    str(RAW_VIDEO_PATH),
                                ],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                                check=False,
                            )
                        else:
                            candidate.rename(RAW_VIDEO_PATH)
                        break

            if res.returncode == 0:
                valid = validate_video_file(RAW_VIDEO_PATH)
                if valid:
                    print(
                        f"[fetch][Layer B] yt-dlp succeeded on pass {idx} "
                        f"({valid['width']}x{valid['height']}, {valid['duration']:.2f}s)"
                    )
                    return valid
            err_tail = (res.stderr or res.stdout or "").strip()[-260:]
            print(f"[fetch][Layer B] yt-dlp pass {idx} did not yield valid MP4: {err_tail}")
    finally:
        if cookie_file and cookie_file.exists():
            cookie_file.unlink(missing_ok=True)

    return None


def try_layer2_playwright(clean_url: str) -> Optional[Dict[str, Any]]:
    print(f"[fetch][Layer C] Launching Playwright mobile Chromium for: {clean_url}")
    from playwright.sync_api import sync_playwright

    captured_network: List[Tuple[int, str, str]] = []
    seen_urls = set()

    def record_candidate(candidate_url: str, size_hint: int, referer: str) -> None:
        if not candidate_url or not candidate_url.startswith("http"):
            return
        cleaned = (
            candidate_url.replace("\\u002F", "/").replace("\\/", "/").replace("&amp;", "&")
        )
        if any(
            skip in cleaned.lower()
            for skip in [
                ".m3u8",
                ".ts?",
                "blob:",
                "avatar",
                "cover",
                ".jpg",
                ".png",
                ".webp",
            ]
        ):
            return
        if cleaned not in seen_urls:
            seen_urls.add(cleaned)
            captured_network.append((size_hint, cleaned, referer))

    final_page_url = clean_url
    browser_cookies: Dict[str, str] = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        extra_headers: Dict[str, str] = {
            "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        }
        if SESSION_COOKIE and "\t" not in SESSION_COOKIE:
            extra_headers["Cookie"] = SESSION_COOKIE

        context = browser.new_context(
            user_agent=IPHONE_14_PRO_UA,
            viewport={"width": 393, "height": 852},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
            ignore_https_errors=True,
            extra_http_headers=extra_headers,
        )
        page = context.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        def on_response(resp: Any) -> None:
            try:
                r_url = resp.url or ""
                headers = resp.headers or {}
                ctype = (headers.get("content-type") or "").lower()
                clen = int(headers.get("content-length") or 0)
                is_video_type = "video/mp4" in ctype or ctype.startswith("video/")
                is_video_url = any(
                    hint in r_url.lower()
                    for hint in [
                        ".mp4",
                        "xhscdn.com",
                        "douyinvod.com",
                        "iesdouyin.com/aweme/v1/play",
                        "fbcdn.net",
                        "tiktok.com/video",
                        "kwimgs.com",
                        "bytecdn",
                    ]
                ) and ("video" in ctype or "octet-stream" in ctype or ".mp4" in r_url.lower())
                if is_video_type or is_video_url:
                    record_candidate(r_url, clen, page.url or clean_url)
            except Exception:
                pass

        page.on("response", on_response)

        try:
            page.goto(clean_url, wait_until="domcontentloaded", timeout=35_000)
        except Exception as nav_err:
            print(f"[fetch][Layer C] Navigation note: {nav_err}")

        page.wait_for_timeout(4500)
        final_page_url = page.url or clean_url

        try:
            page.evaluate(
                """() => {
                    const v = document.querySelector('video');
                    if (v) { v.muted = true; v.play().catch(() => {}); }
                }"""
            )
            page.wait_for_timeout(2500)
        except Exception:
            pass

        try:
            dom_candidates = page.evaluate(
                """() => {
                    const urls = [];
                    document.querySelectorAll('video, video source').forEach((el) => {
                        if (el.src) urls.push(el.src);
                        if (el.currentSrc) urls.push(el.currentSrc);
                    });
                    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]').forEach((m) => {
                        if (m.content) urls.push(m.content);
                    });
                    try { if (window.__INITIAL_STATE__) urls.push(JSON.stringify(window.__INITIAL_STATE__)); } catch (e) {}
                    try { if (window._ROUTER_DATA) urls.push(JSON.stringify(window._ROUTER_DATA)); } catch (e) {}
                    return urls;
                }"""
            )
            for item in dom_candidates or []:
                if not isinstance(item, str):
                    continue
                if item.startswith("http"):
                    record_candidate(item, 500_000, final_page_url)
                else:
                    for found in re.findall(
                        r'https?:\\?/\\?/[^"\'\\\s<>]+?(?:\.mp4|xhscdn\.com|douyinvod\.com|fbcdn\.net|kwimgs\.com|tiktokcdn)[^"\'\\\s<>]*',
                        item,
                    ):
                        record_candidate(found, 400_000, final_page_url)
        except Exception:
            pass

        try:
            html_content = page.content()
            for found in re.findall(
                r'https?:\\?/\\?/[^"\'\\\s<>]+?\.mp4[^"\'\\\s<>]*',
                html_content,
            ):
                record_candidate(found, 250_000, final_page_url)
        except Exception:
            pass

        try:
            for c in context.cookies():
                browser_cookies[c["name"]] = c["value"]
        except Exception:
            pass

        browser.close()

    captured_network.sort(key=lambda item: item[0], reverse=True)
    print(f"[fetch][Layer C] Found {len(captured_network)} candidate MP4 stream(s).")

    for size_hint, stream_url, ref_url in captured_network[:10]:
        dl_headers = {
            "User-Agent": IPHONE_14_PRO_UA,
            "Referer": ref_url or final_page_url,
            "Accept": "*/*",
        }
        if SESSION_COOKIE and "\t" not in SESSION_COOKIE:
            dl_headers["Cookie"] = SESSION_COOKIE
        valid = download_stream_to_path(
            stream_url, RAW_VIDEO_PATH, dl_headers, cookies=browser_cookies
        )
        if valid:
            print(
                f"[fetch][Layer C] Playwright stream validated "
                f"({valid['width']}x{valid['height']}, {valid['duration']:.2f}s, hint={size_hint})"
            )
            return valid

    return None


def compute_action_energy_profile(video_path: Path, total_dur: float) -> List[float]:
    """
    Computes a combined per-second Audio RMS + Visual Motion Energy score (0..1)
    across the video to pinpoint high-action main scenes and trim dead intros/outros.
    """
    import cv2
    import numpy as np

    num_secs = max(1, int(math.floor(total_dur)))
    audio_scores = np.zeros(num_secs, dtype=np.float32)
    motion_scores = np.zeros(num_secs, dtype=np.float32)

    audio_tmp = Path("energy_scan.wav")
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(video_path),
                "-vn",
                "-ar",
                "8000",
                "-ac",
                "1",
                str(audio_tmp),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        with wave.open(str(audio_tmp), "rb") as wf:
            sr = wf.getframerate()
            pcm = (
                np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(
                    np.float32
                )
                / 32768.0
            )
        for sec in range(num_secs):
            s0, s1 = sec * sr, min(len(pcm), (sec + 1) * sr)
            if s1 > s0:
                audio_scores[sec] = float(np.sqrt(np.mean(pcm[s0:s1] ** 2)))
    except Exception:
        pass
    finally:
        audio_tmp.unlink(missing_ok=True)

    # Lightweight visual motion scan (1 sample per second up to 900s, or 1 per 2s for very long clips)
    motion_dir = Path("motion_scan_frames")
    if motion_dir.exists():
        shutil.rmtree(motion_dir)
    motion_dir.mkdir(parents=True, exist_ok=True)
    fps_rate = 1.0 if total_dur <= 600 else 0.5
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(video_path),
                "-vf",
                f"fps={fps_rate},scale=160:-1",
                "-q:v",
                "8",
                str(motion_dir / "m_%05d.jpg"),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        m_files = sorted(motion_dir.glob("m_*.jpg"))
        prev_gray = None
        for idx, fp in enumerate(m_files):
            gray = cv2.imread(str(fp), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                continue
            if prev_gray is not None and prev_gray.shape == gray.shape:
                diff_val = float(np.mean(cv2.absdiff(prev_gray, gray))) / 255.0
                sec_pos = min(num_secs - 1, int(idx / fps_rate))
                motion_scores[sec_pos] = max(motion_scores[sec_pos], diff_val)
            prev_gray = gray
    except Exception:
        pass
    finally:
        if motion_dir.exists():
            shutil.rmtree(motion_dir)

    if float(np.max(audio_scores)) > 0:
        audio_scores = audio_scores / float(np.percentile(audio_scores, 95) or 1.0)
    if float(np.max(motion_scores)) > 0:
        motion_scores = motion_scores / float(np.percentile(motion_scores, 95) or 1.0)

    combined = np.clip(0.55 * audio_scores + 0.45 * motion_scores, 0.0, 1.5)
    return [float(v) for v in combined]


def slice_video_segment(
    src_path: Path, start_sec: float, duration_sec: float, out_path: Path
) -> Dict[str, Any]:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{max(0.0, start_sec):.2f}",
            "-i",
            str(src_path),
            "-t",
            f"{max(4.0, duration_sec):.2f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(out_path),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    return probe_video_info(out_path)


def extract_short_main_scene(video_path: Path, total_dur: float) -> List[Dict[str, Any]]:
    """
    Short video (<= 65s): trims slow intros/outros and extracts the highest-action
    main scene (20–40s).
    """
    clip1 = Path("clip_1_raw.mp4")
    if total_dur <= 21.0:
        trim_dur = max(4.0, total_dur - 1.0) if total_dur > 8.5 else total_dur
        s_info = slice_video_segment(video_path, 0.0, trim_dur, clip1)
        return [
            {
                "clip_index": 1,
                "start_sec": 0.0,
                "end_sec": round(trim_dur, 2),
                "reason": "Main Scene Short Cut",
                "raw_file": str(clip1),
                "width": s_info["width"],
                "height": s_info["height"],
                "duration": s_info["duration"],
            }
        ]

    energy = compute_action_energy_profile(video_path, total_dur)
    n = len(energy)

    if total_dur > 40.0:
        # Pick highest-action continuous 34s window (20-40s target)
        win = min(34, max(20, n))
        best_start = 0
        best_sum = -1.0
        for s in range(0, max(1, n - win + 1)):
            score = sum(energy[s : s + win])
            if score > best_sum:
                best_sum = score
                best_start = s
        start_sec = float(best_start)
        dur_sec = min(40.0, max(20.0, float(win)))
        reason = "Auto-Trimmed Peak Action Main Scene (20–40s)"
    else:
        # 21s to 40s: trim slow dead intro/outro up to 3s while keeping >= 20s
        avg_e = sum(energy) / max(n, 1)
        thresh = avg_e * 0.45
        start_i = 0
        while start_i < min(3, n - 20) and energy[start_i] < thresh:
            start_i += 1
        end_i = n
        while end_i > start_i + 20 and (n - end_i) < 3 and energy[end_i - 1] < thresh:
            end_i -= 1
        start_sec = float(start_i)
        dur_sec = min(40.0, max(20.0, float(end_i - start_i)))
        reason = "Trimmed Dead Intro/Outro Main Scene"

    s_info = slice_video_segment(video_path, start_sec, dur_sec, clip1)
    print(
        f"[clipper] Short video ({total_dur:.1f}s <= 65s) -> main scene "
        f"{start_sec:.1f}s–{start_sec + dur_sec:.1f}s ({s_info['duration']:.1f}s)"
    )
    return [
        {
            "clip_index": 1,
            "start_sec": round(start_sec, 2),
            "end_sec": round(start_sec + s_info["duration"], 2),
            "reason": reason,
            "raw_file": str(clip1),
            "width": s_info["width"],
            "height": s_info["height"],
            "duration": s_info["duration"],
        }
    ]


def pick_long_video_viral_segments(
    video_path: Path, total_dur: float
) -> List[Dict[str, Any]]:
    """
    Long Video Clipper (> 65s):
    Parses YouTube Most-Replayed heatmap spikes (from yt-dlp info.json) AND
    audio+motion energy peaks to slice top 3–4 non-overlapping viral scenes
    with varied high-retention lengths (30s, 40s, and 60s; plus a 4th 35s clip
    when duration >= 240s).
    """
    target_lengths = [30.0, 40.0, 60.0] if total_dur < 240.0 else [30.0, 40.0, 60.0, 35.0]
    if total_dur < 135.0:
        # Fit 3 distinct clips cleanly inside 65s–135s videos
        base = max(20.0, (total_dur - 4.0) / 3.0)
        target_lengths = [min(30.0, base), min(40.0, base), min(45.0, base)]

    candidate_peaks: List[Tuple[float, float, str]] = []

    # 1. YouTube Most-Replayed heatmap spikes
    if INFO_JSON_PATH.exists():
        try:
            meta = json.loads(INFO_JSON_PATH.read_text(encoding="utf-8"))
            heatmap = meta.get("heatmap") or []
            if isinstance(heatmap, list) and len(heatmap) >= 6:
                for b in heatmap:
                    val = float(b.get("value") or 0.0)
                    peak_t = (
                        float(b.get("start_time") or 0.0)
                        + float(b.get("end_time") or 0.0)
                    ) / 2.0
                    candidate_peaks.append((val * 1.4, peak_t, "YouTube Most-Replayed Spike"))
                print(f"[clipper] Parsed {len(heatmap)} YouTube Most-Replayed heatmap bins.")
        except Exception as exc:
            print(f"[clipper] Heatmap parse note: {exc}")

    # 2. Combined Audio + Motion energy peaks
    energy = compute_action_energy_profile(video_path, total_dur)
    for sec, val in enumerate(energy):
        candidate_peaks.append((val, float(sec), "Audio & Motion Energy Peak"))

    candidate_peaks.sort(key=lambda item: item[0], reverse=True)

    selected: List[Tuple[float, float, str]] = []

    def overlaps_existing(s0: float, e0: float) -> bool:
        for ex_s, ex_e, _ in selected:
            if not (e0 <= ex_s + 2.0 or s0 >= ex_e - 2.0):
                return True
        return False

    for target_len in target_lengths:
        picked = False
        for _, peak_t, reason in candidate_peaks:
            s0 = max(0.0, min(total_dur - target_len, peak_t - target_len * 0.30))
            e0 = min(total_dur, s0 + target_len)
            if e0 - s0 < 18.0:
                continue
            if not overlaps_existing(s0, e0):
                selected.append((round(s0, 2), round(e0, 2), f"{reason} ({int(round(e0 - s0))}s)"))
                picked = True
                break
        if not picked:
            # Fallback evenly spaced non-overlapping window
            step = max(1.0, (total_dur - target_len) / max(len(target_lengths), 1))
            for k in range(len(target_lengths) + 2):
                s0 = max(0.0, min(total_dur - target_len, k * step))
                e0 = min(total_dur, s0 + target_len)
                if not overlaps_existing(s0, e0) and e0 - s0 >= 18.0:
                    selected.append(
                        (round(s0, 2), round(e0, 2), f"Action Highlight ({int(round(e0 - s0))}s)")
                    )
                    break

    selected.sort(key=lambda item: item[0])
    segments: List[Dict[str, Any]] = []
    for idx, (s0, e0, reason) in enumerate(selected[:4], start=1):
        out_slice = Path(f"clip_{idx}_raw.mp4")
        s_info = slice_video_segment(video_path, s0, e0 - s0, out_slice)
        segments.append(
            {
                "clip_index": idx,
                "start_sec": s0,
                "end_sec": round(s0 + s_info["duration"], 2),
                "reason": reason,
                "raw_file": str(out_slice),
                "width": s_info["width"],
                "height": s_info["height"],
                "duration": s_info["duration"],
            }
        )
    print(f"[clipper] Sliced {len(segments)} viral scenes from {total_dur:.1f}s long video.")
    return segments


def stage_fetch() -> None:
    # Step 1: Run 24-hour Cloudinary auto-cleanup at the start of every run
    cleanup_expired_cloudinary_assets(max_age_hours=24.0)

    if not VIDEO_SOURCE:
        raise ValueError("VIDEO_SOURCE input is required.")

    if RAW_VIDEO_PATH.exists():
        RAW_VIDEO_PATH.unlink()

    clean_url = extract_clean_url(VIDEO_SOURCE)
    if not clean_url.startswith("http"):
        raise ValueError(
            f"Could not find a valid http/https URL inside video_source: {VIDEO_SOURCE[:120]}"
        )

    info: Optional[Dict[str, Any]] = None
    if SOURCE_TYPE == "link":
        print(f"[fetch][Layer A] Sanitized URL: {clean_url}")
        info = try_layer1_ytdlp(clean_url)
        if info is None:
            info = try_layer2_playwright(clean_url)
        if info is None:
            raise RuntimeError(
                "Could not extract a playable MP4 via yt-dlp or Playwright mobile browser. "
                "If this link is login-walled or private, add your optional Session Cookie in the Fallback Drawer."
            )
    else:
        print("[fetch] Downloading uploaded raw clip from Cloudinary...")
        for attempt in range(1, 4):
            valid = download_stream_to_path(
                clean_url, RAW_VIDEO_PATH, headers={"User-Agent": IPHONE_14_PRO_UA}
            )
            if valid:
                info = valid
                break
            time.sleep(attempt * 2)
        if info is None:
            raise RuntimeError("Uploaded Cloudinary video failed ffprobe validation.")

    raw_dur = float(info["duration"])
    if raw_dur <= 65.0:
        clips = extract_short_main_scene(RAW_VIDEO_PATH, raw_dur)
    else:
        print(
            f"[fetch] Long video detected ({raw_dur:.1f}s > 65s) -> slicing top 3–4 viral scenes (30s / 40s / 60s)..."
        )
        clips = pick_long_video_viral_segments(RAW_VIDEO_PATH, raw_dur)

    raw_public_id = infer_cloudinary_public_id(clean_url) if SOURCE_TYPE == "upload" else ""
    state = {
        "run_tag": RUN_TAG,
        "source_type": SOURCE_TYPE,
        "video_source": clean_url,
        "raw_public_id": raw_public_id,
        "language": LANGUAGE,
        "voice_gender": VOICE_GENDER,
        "custom_angle": CUSTOM_ANGLE,
        "character_enabled": CHARACTER_ENABLED,
        "character_url": CHARACTER_URL,
        "outfit_prompt": OUTFIT_PROMPT,
        "source_total_duration": round(raw_dur, 2),
        "is_long_video_split": raw_dur > 65.0,
        "clips": clips,
    }
    save_state(state)
    print(f"[fetch] Prepared {len(clips)} clip(s) for 1-Call Vision & NVIDIA Dual Engine.")


# ---------------------------------------------------------------------------
# STAGE 2: QUOTA-SAVING 1-CALL CONTACT-SHEET VISION + YOUTUBE API + NVIDIA NIM
# ---------------------------------------------------------------------------
def build_contact_sheet(
    frame_files: List[Path], timestamps_sec: List[int], out_path: Path
) -> Tuple[Path, int, int]:
    """
    Stitches evenly sampled 1-FPS frames into ONE single compressed contact-sheet
    grid image with timestamp stamps (`00:01`, `00:02`...) to save Gemini Vision quota.
    """
    import cv2
    import numpy as np

    max_tiles = 30
    if len(frame_files) > max_tiles:
        indices = np.linspace(0, len(frame_files) - 1, max_tiles, dtype=int)
        frame_files = [frame_files[i] for i in indices]
        timestamps_sec = [timestamps_sec[i] for i in indices]

    tiles: List[Any] = []
    tile_w = 240
    tile_h = 320

    for idx, (fp, sec_val) in enumerate(zip(frame_files, timestamps_sec)):
        img = cv2.imread(str(fp))
        if img is None:
            continue
        if idx == 0:
            h0, w0 = img.shape[:2]
            tile_h = max(140, min(360, int(round(tile_w * (h0 / max(w0, 1))))))
        resized = cv2.resize(img, (tile_w, tile_h), interpolation=cv2.INTER_AREA)
        label = f"{sec_val // 60:02d}:{sec_val % 60:02d}"
        cv2.rectangle(resized, (4, 4), (74, 28), (15, 23, 42), -1)
        cv2.putText(
            resized,
            label,
            (9, 22),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        tiles.append(resized)

    if not tiles:
        raise RuntimeError("No readable video frames for contact-sheet generation.")

    cols = min(6, max(3, int(math.ceil(math.sqrt(len(tiles))))))
    rows = int(math.ceil(len(tiles) / cols))
    pad = 4
    canvas = np.full(
        (rows * tile_h + (rows + 1) * pad, cols * tile_w + (cols + 1) * pad, 3),
        18,
        dtype=np.uint8,
    )

    for i, tile in enumerate(tiles):
        r = i // cols
        c = i % cols
        y = pad + r * (tile_h + pad)
        x = pad + c * (tile_w + pad)
        canvas[y : y + tile_h, x : x + tile_w] = tile

    cv2.imwrite(str(out_path), canvas, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
    return out_path, rows, cols


def fetch_live_youtube_trends(queries: List[str]) -> List[Dict[str, Any]]:
    if not YOUTUBE_API_KEY:
        raise ValueError(
            "YOUTUBE_API_KEY secret is required in GitHub Actions Secrets for live YouTube Data API v3 trend research."
        )

    published_after = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    video_ids: List[str] = []
    seen_ids = set()

    for query in queries[:3]:
        q = str(query).strip()
        if not q:
            continue
        search_resp = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": q,
                "regionCode": "US",
                "type": "video",
                "videoDuration": "short",
                "order": "viewCount",
                "publishedAfter": published_after,
                "maxResults": 6,
                "key": YOUTUBE_API_KEY,
            },
            timeout=25,
        )
        if not search_resp.ok:
            raise RuntimeError(
                f"YouTube Data API search.list failed (HTTP {search_resp.status_code}): {search_resp.text[:220]}"
            )
        for item in search_resp.json().get("items") or []:
            vid = item.get("id", {}).get("videoId")
            if vid and vid not in seen_ids:
                seen_ids.add(vid)
                video_ids.append(vid)

    if not video_ids:
        broader_after = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=90)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        fallback_q = str(queries[0]).strip() if queries else "viral product hack"
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": fallback_q,
                "regionCode": "US",
                "type": "video",
                "videoDuration": "short",
                "order": "viewCount",
                "publishedAfter": broader_after,
                "maxResults": 10,
                "key": YOUTUBE_API_KEY,
            },
            timeout=25,
        )
        if resp.ok:
            for item in resp.json().get("items") or []:
                vid = item.get("id", {}).get("videoId")
                if vid and vid not in seen_ids:
                    seen_ids.add(vid)
                    video_ids.append(vid)

    if not video_ids:
        raise RuntimeError(
            "YouTube Data API v3 returned 0 matching US Shorts for the detected topic queries."
        )

    details_resp = requests.get(
        "https://www.googleapis.com/youtube/v3/videos",
        params={
            "part": "snippet,statistics",
            "id": ",".join(video_ids[:20]),
            "key": YOUTUBE_API_KEY,
        },
        timeout=25,
    )
    if not details_resp.ok:
        raise RuntimeError(
            f"YouTube Data API videos.list failed (HTTP {details_resp.status_code}): {details_resp.text[:220]}"
        )

    trends: List[Dict[str, Any]] = []
    for item in details_resp.json().get("items") or []:
        snippet = item.get("snippet", {})
        stats = item.get("statistics", {})
        trends.append(
            {
                "title": snippet.get("title", ""),
                "channel": snippet.get("channelTitle", ""),
                "published_at": snippet.get("publishedAt", ""),
                "view_count": int(stats.get("viewCount") or 0),
                "like_count": int(stats.get("likeCount") or 0),
                "tags": (snippet.get("tags") or [])[:15],
            }
        )

    trends.sort(key=lambda x: x["view_count"], reverse=True)
    return trends[:12]


def stage_analyze() -> None:
    state = load_state()
    lang_label = (
        "Hindi (natural conversational Hindi/Hinglish in Devanagari script)"
        if state["language"] == "hi"
        else "American English (high-retention US suspense narrator)"
    )

    for clip in state["clips"]:
        c_idx = clip["clip_index"]
        raw_path = Path(clip["raw_file"])
        clean_dur = float(clip["duration"])

        frames_dir = Path(f"frames_clip_{c_idx}")
        if frames_dir.exists():
            shutil.rmtree(frames_dir)
        frames_dir.mkdir(parents=True, exist_ok=True)

        scan_dur = min(clean_dur, 60.0)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(raw_path),
                "-t",
                f"{scan_dur:.2f}",
                "-vf",
                "fps=1,scale=360:-1",
                "-q:v",
                "6",
                str(frames_dir / "sec_%03d.jpg"),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )

        frame_files = sorted(frames_dir.glob("sec_*.jpg"))
        if not frame_files:
            raise RuntimeError(f"Clip {c_idx}: failed to extract 1-FPS frames.")

        timestamps_sec = list(range(1, len(frame_files) + 1))
        sheet_path = Path(f"contact_sheet_clip_{c_idx}.jpg")
        sheet_path, rows, cols = build_contact_sheet(
            frame_files, timestamps_sec, sheet_path
        )
        print(
            f"[analyze] Clip {c_idx}: stitched {len(frame_files)} 1-FPS frames into "
            f"1 compressed {rows}x{cols} contact-sheet ({sheet_path.stat().st_size // 1024} KB)."
        )

        vision_prompt = f"""
You are a precision short-form video analyst and computer-vision inspector.
This single image is a {rows}x{cols} chronological contact-sheet grid of frames sampled at 1 FPS (each tile has a top-left timestamp `00:01`, `00:02`...) from a {clean_dur:.1f}-second clip.
{f'Creator custom suspense angle: "{state["custom_angle"]}"' if state.get("custom_angle") else ''}

Return ONLY valid JSON:
{{
  "core_topic": "Exact specific object, action, or product in this clip",
  "climax_second": 6.5,
  "timeline": [
    {{"second": 1, "timestamp": "00:01", "action": "..."}},
    {{"second": 4, "timestamp": "00:04", "action": "..."}}
  ],
  "watermark_boxes": [[15, 20, 95, 280]],
  "search_queries": [
    "specific US Shorts search query 1",
    "specific US Shorts search query 2",
    "specific US Shorts search query 3"
  ]
}}

Rules:
- `climax_second`: exact second (between 3.0 and {max(3.5, clean_dur - 2.5):.1f}) of the biggest mid-video twist/climax visible in the timestamped tiles.
- `watermark_boxes`: normalized `[ymin, xmin, ymax, xmax]` (0–1000) coordinates RELATIVE TO AN INDIVIDUAL VIDEO FRAME TILE (not the whole grid!) for EVERY visible platform watermark, logo, username handle, or floating corner text (ignore the dark `00:XX` timestamp label in the top-left corner). Return `[]` if clean.
""".strip()

        vision_parts: List[Dict[str, Any]] = [
            {"text": vision_prompt},
            {
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": base64.b64encode(sheet_path.read_bytes()).decode("utf-8"),
                }
            },
        ]

        vision = call_gemini_json(vision_parts, f"vision_clip_{c_idx}")
        queries = vision.get("search_queries") or [vision.get("core_topic", "")]

        print(f"[analyze] Clip {c_idx}: querying YouTube Data API v3 for {queries}...")
        trends = fetch_live_youtube_trends(queries)

        target_words = max(32, min(145, int(clean_dur * 2.85)))
        custom_note = (
            f'CREATOR CUSTOM SUSPENSE HOOK / ANGLE:\n"{state["custom_angle"]}"\nBuild the narration around this exact angle while staying synced to the 1-FPS visual events.'
            if state.get("custom_angle")
            else "Build a maximum-suspense curiosity-gap hook automatically from the 1-FPS visual timeline."
        )

        script_prompt = f"""
You are an elite viral short-form suspense scriptwriter and YouTube Shorts SEO strategist.

CORE TOPIC: {vision.get("core_topic", "")}
1-FPS VISUAL TIMELINE ({clean_dur:.1f}s clip):
{json.dumps(vision.get("timeline", []), ensure_ascii=False)}
MID-VIDEO CLIMAX SECOND: {vision.get("climax_second", clean_dur * 0.5)}s

LIVE YOUTUBE DATA API v3 TOP US SHORTS (last 30 days, real view counts & tags):
{json.dumps(trends, ensure_ascii=False)}

OUTPUT LANGUAGE: {lang_label}
{custom_note}

SCRIPT RULES (ZERO DEAD AIR):
1. Write roughly {target_words} spoken words (~2.9 words/sec).
2. 0.0s–2.5s OPENING HOOK: Scroll-stopping suspense hook immediately on frame 1.
3. EVERY 2–3 SECONDS: Trigger fresh curiosity/tension synced to the visual timeline.
4. SEAMLESS LOOP ENDING: The final phrase connects grammatically back into the opening hook and provokes comments.
5. Plain spoken words ONLY inside `voiceover` (no brackets, no emojis, no timestamps).

METADATA RULES (STRICTLY GROUNDED IN THE LIVE YOUTUBE API DATA ABOVE):
- `title`: High-CTR title modeled on the fetched top-performing US Shorts titles (max 68 chars).
- `description`: 2-line SEO description incorporating real high-view keywords from the fetched data.
- `tags`: 15 specific comma-separated trending tags grounded in the live YouTube API tags above.
- `hashtags`: 7 targeted hashtags starting with # separated by spaces.
- `posting_time`: Best Upload Time derived from the top-performing video `published_at` timestamps above, formatted explicitly with BOTH USA EST + India IST (e.g., "6:30 PM EST / 5:00 AM IST — Peak US Evening & Early India Feed").

Return ONLY valid JSON:
{{
  "voiceover": "...",
  "title": "...",
  "description": "...",
  "tags": "...",
  "hashtags": "...",
  "posting_time": "..."
}}
""".strip()

        # Primary: NVIDIA NIM (meta/llama-3.3-70b-instruct), Fallback: Gemini
        ai_pack = call_nvidia_nim_json(script_prompt, f"script_clip_{c_idx}")
        if ai_pack is None:
            ai_pack = call_gemini_json([{"text": script_prompt}], f"script_clip_{c_idx}")

        if not ai_pack.get("voiceover") or not ai_pack.get("title"):
            raise RuntimeError(
                f"Clip {c_idx}: AI dual engine failed to return grounded script and metadata."
            )

        clip["clean_duration"] = round(clean_dur, 2)
        clip["vision"] = vision
        clip["youtube_trends_count"] = len(trends)
        clip["ai_pack"] = ai_pack
        print(
            f"[analyze] Clip {c_idx} ready: {ai_pack['title']} ({len(trends)} YouTube trends)"
        )

    save_state(state)


# ---------------------------------------------------------------------------
# STAGE 3: POWERFUL MALE/FEMALE VOICEOVER & FACE-LOCKED CHARACTER LIP-SYNC
# ---------------------------------------------------------------------------
def synthesize_voiceover(
    text: str, language: str, gender: str, clip_idx: int
) -> Tuple[Path, str]:
    import edge_tts

    is_male = gender == "male"
    gemini_voices = ["Fenrir", "Charon"] if is_male else ["Aoede"]
    if language == "hi":
        edge_voice = "hi-IN-MadhurNeural" if is_male else "hi-IN-SwaraNeural"
    else:
        edge_voice = (
            "en-US-AndrewMultilingualNeural"
            if is_male
            else "en-US-AvaMultilingualNeural"
        )

    raw_audio = Path(f"vo_raw_{clip_idx}.wav")
    master_audio = Path(f"vo_master_{clip_idx}.wav")
    audio_source: Optional[Path] = None
    engine_used = ""

    if GEMINI_API_KEY:
        style_desc = (
            "Deep, authoritative, fast-paced, high-energy suspense narrator with zero dead air"
            if is_male
            else "Bright, sharp, fast-paced, high-energy suspense narrator with zero dead air"
        )
        style_desc += (
            " speaking natural energetic Hindi"
            if language == "hi"
            else " speaking natural punchy American English"
        )

        for g_voice in gemini_voices:
            for model in TTS_MODELS:
                for attempt in range(1, 3):
                    url = (
                        f"https://generativelanguage.googleapis.com/v1beta/models/"
                        f"{model}:generateContent?key={GEMINI_API_KEY}"
                    )
                    payload = {
                        "contents": [
                            {
                                "role": "user",
                                "parts": [
                                    {
                                        "text": text,
                                        "speechMetadata": {"style": style_desc},
                                    }
                                ],
                            }
                        ],
                        "generationConfig": {
                            "responseModalities": ["AUDIO"],
                            "speechConfig": {
                                "voiceConfig": {
                                    "prebuiltVoiceConfig": {"voiceName": g_voice}
                                }
                            },
                        },
                    }
                    try:
                        resp = requests.post(url, json=payload, timeout=75)
                        if resp.status_code in (429, 500, 502, 503, 504):
                            time.sleep(2 * attempt)
                            continue
                        if not resp.ok:
                            break
                        data = resp.json()
                        parts = (
                            data.get("candidates", [{}])[0]
                            .get("content", {})
                            .get("parts", [])
                        )
                        for part in parts:
                            inline = part.get("inlineData") or {}
                            if inline.get("data"):
                                audio_bytes = base64.b64decode(inline["data"])
                                if audio_bytes[:4] == b"RIFF":
                                    raw_audio.write_bytes(audio_bytes)
                                else:
                                    with wave.open(str(raw_audio), "wb") as wf:
                                        wf.setnchannels(1)
                                        wf.setsampwidth(2)
                                        wf.setframerate(24000)
                                        wf.writeframes(audio_bytes)
                                audio_source = raw_audio
                                engine_used = f"Gemini TTS ({g_voice})"
                                print(
                                    f"[voice] Clip {clip_idx}: synthesized via {model} ({g_voice})"
                                )
                                break
                        if audio_source:
                            break
                    except Exception as exc:
                        print(f"[voice] {model} ({g_voice}) fallback note: {exc}")
                if audio_source:
                    break
            if audio_source:
                break

    if audio_source is None:
        mp3_tmp = Path(f"vo_edge_{clip_idx}.mp3")
        pitch = "-4Hz" if is_male else "+2Hz"

        async def _run_edge() -> None:
            comm = edge_tts.Communicate(text, edge_voice, rate="+10%", pitch=pitch)
            await comm.save(str(mp3_tmp))

        asyncio.run(_run_edge())
        audio_source = mp3_tmp
        engine_used = f"Edge TTS ({edge_voice} +10%)"
        print(f"[voice] Clip {clip_idx}: synthesized via {engine_used}")

    # Broadcast presence EQ + compression (deep warm chest boost for male)
    eq_filter = (
        "highpass=f=70,equalizer=f=130:t=q:w=1.1:g=4.0,"
        "equalizer=f=3200:t=q:w=1.2:g=3.2,"
        "acompressor=threshold=-17dB:ratio=3.5:attack=4:release=50:makeup=3,"
        "loudnorm=I=-13.5:TP=-1.2:LRA=6"
        if is_male
        else "highpass=f=90,equalizer=f=3600:t=q:w=1.2:g=3.2,"
        "acompressor=threshold=-17dB:ratio=3.2:attack=4:release=50:makeup=2.5,"
        "loudnorm=I=-13.5:TP=-1.2:LRA=6"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_source),
            "-af",
            eq_filter,
            "-ar",
            "44100",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(master_audio),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    return master_audio, engine_used


def prepare_character_portrait(character_url: str, outfit_prompt: str) -> Path:
    print("[character] Downloading portrait image...")
    resp = requests.get(character_url, timeout=45)
    resp.raise_for_status()
    orig_bytes = resp.content
    orig_mime = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
    CHAR_IMAGE_PATH.write_bytes(orig_bytes)

    if outfit_prompt and GEMINI_API_KEY:
        print(f"[character] Applying face-locked outfit change: {outfit_prompt}")
        edit_prompt = (
            "Keep the person's exact face, facial structure, eyes, nose, mouth, skin tone, hair, "
            "and identity 100% locked and identical to the reference photo. "
            f"Change ONLY their outfit/clothing to: {outfit_prompt}. "
            "Clean studio portrait lighting, crisp edges, front-facing head-and-shoulders framing."
        )
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": orig_mime
                                if orig_mime.startswith("image/")
                                else "image/jpeg",
                                "data": base64.b64encode(orig_bytes).decode("utf-8"),
                            }
                        },
                        {"text": edit_prompt},
                    ],
                }
            ]
        }
        for model in IMAGE_EDIT_MODELS:
            try:
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}:generateContent?key={GEMINI_API_KEY}"
                )
                r = requests.post(url, json=payload, timeout=75)
                if not r.ok:
                    continue
                parts = (
                    r.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
                )
                for part in parts:
                    inline = part.get("inlineData") or {}
                    if inline.get("data"):
                        CHAR_IMAGE_PATH.write_bytes(base64.b64decode(inline["data"]))
                        print(f"[character] Face-locked outfit swap generated via {model}")
                        return CHAR_IMAGE_PATH
            except Exception as exc:
                print(f"[character] Outfit swap fallback to original portrait: {exc}")

    return CHAR_IMAGE_PATH


def ensure_wav2lip_onnx() -> Optional[Path]:
    MODEL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_CACHE_DIR / "wav2lip.onnx"
    if model_path.exists() and model_path.stat().st_size > 1_000_000:
        return model_path
    if WAV2LIP_ONNX_URL:
        try:
            with requests.get(WAV2LIP_ONNX_URL, stream=True, timeout=120) as resp:
                resp.raise_for_status()
                with model_path.open("wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1024 * 512):
                        if chunk:
                            fh.write(chunk)
            if model_path.stat().st_size > 1_000_000:
                return model_path
        except Exception as exc:
            print(f"[character] Wav2Lip ONNX download skipped: {exc}")
    return None


def compute_audio_envelope(wav_path: Path, fps: int, num_frames: int) -> Any:
    import numpy as np

    with wave.open(str(wav_path), "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        return np.zeros(num_frames, dtype=np.float32)
    step = max(1, int(sr / fps))
    env = np.zeros(num_frames, dtype=np.float32)
    for idx in range(num_frames):
        s0 = idx * step
        s1 = min(samples.size, s0 + step)
        if s0 < samples.size:
            seg = samples[s0:s1]
            env[idx] = float(np.sqrt(np.mean(seg * seg)))
    peak = float(np.percentile(env, 96)) if env.size else 1.0
    return np.clip(env / max(peak, 1e-4), 0.0, 1.0)


def generate_talking_character_video(
    portrait_path: Path, vo_wav: Path, duration: float, out_video: Path
) -> str:
    import cv2
    import numpy as np
    import onnxruntime as ort
    from scipy.signal import stft

    fps = 25
    num_frames = max(10, int(math.ceil(duration * fps)))
    img_bgr = cv2.imread(str(portrait_path))
    if img_bgr is None:
        raise RuntimeError("Could not decode character portrait image.")

    h, w = img_bgr.shape[:2]
    side = min(h, w)
    y0 = max(0, int((h - side) * 0.22))
    x0 = (w - side) // 2
    crop = img_bgr[y0 : y0 + side, x0 : x0 + side]
    base_frame = cv2.resize(crop, (420, 420), interpolation=cv2.INTER_AREA)

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(cascade_path)
    gray = cv2.cvtColor(base_frame, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=4, minSize=(70, 70)
    )

    onnx_model = ensure_wav2lip_onnx()
    used_mode = "audio-reactive-motion"
    tmp_raw_mp4 = out_video.with_suffix(".tmp.mp4")

    writer = cv2.VideoWriter(
        str(tmp_raw_mp4), cv2.VideoWriter_fourcc(*"mp4v"), fps, (420, 420)
    )

    if onnx_model is not None and len(faces) > 0:
        try:
            fx, fy, fw, fh = sorted(faces, key=lambda b: b[2] * b[3], reverse=True)[0]
            pad_y = int(fh * 0.08)
            y1, y2 = max(0, fy), min(420, fy + fh + pad_y)
            x1, x2 = max(0, fx), min(420, fx + fw)
            face_crop = cv2.resize(base_frame[y1:y2, x1:x2], (96, 96))

            with wave.open(str(vo_wav), "rb") as wf:
                sr = wf.getframerate()
                pcm = (
                    np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(
                        np.float32
                    )
                    / 32768.0
                )
            _, _, zxx = stft(pcm, fs=sr, nperseg=512, noverlap=312)
            spec = np.log1p(np.abs(zxx))
            spec_80 = cv2.resize(spec, (max(16, spec.shape[1]), 80)).astype(np.float32)

            session = ort.InferenceSession(
                str(onnx_model), providers=["CPUExecutionProvider"]
            )
            input_names = [inp.name for inp in session.get_inputs()]

            face_norm = face_crop.astype(np.float32) / 255.0
            masked_face = face_norm.copy()
            masked_face[48:, :, :] = 0.0
            img_in = np.transpose(
                np.concatenate([masked_face, face_norm], axis=2), (2, 0, 1)
            )[None, ...]

            for idx in range(num_frames):
                t_pos = int((idx / max(num_frames, 1)) * max(1, spec_80.shape[1] - 16))
                mel_chunk = spec_80[:, t_pos : t_pos + 16]
                if mel_chunk.shape[1] < 16:
                    mel_chunk = np.pad(mel_chunk, ((0, 0), (0, 16 - mel_chunk.shape[1])))
                mel_in = mel_chunk[None, None, :, :].astype(np.float32)

                feed = {
                    name: (
                        mel_in
                        if ("mel" in name.lower() or "audio" in name.lower())
                        else img_in
                    )
                    for name in input_names
                }
                pred = session.run(None, feed)[0][0]
                pred_img = (
                    np.clip(np.transpose(pred, (1, 2, 0)), 0.0, 1.0) * 255.0
                ).astype(np.uint8)
                frame = base_frame.copy()
                frame[y1:y2, x1:x2] = cv2.resize(pred_img, (x2 - x1, y2 - y1))
                writer.write(frame)

            used_mode = "wav2lip-onnx-cpu"
        except Exception as exc:
            print(f"[character] Wav2Lip ONNX fallback: {exc}")
            writer.release()
            writer = cv2.VideoWriter(
                str(tmp_raw_mp4), cv2.VideoWriter_fourcc(*"mp4v"), fps, (420, 420)
            )
            used_mode = "audio-reactive-motion"

    if used_mode == "audio-reactive-motion":
        env = compute_audio_envelope(vo_wav, fps, num_frames)
        env = np.convolve(env, np.array([0.2, 0.6, 0.2], dtype=np.float32), mode="same")

        mouth_box: Optional[Tuple[int, int, int, int]] = None
        if len(faces) > 0:
            fx, fy, fw, fh = sorted(faces, key=lambda b: b[2] * b[3], reverse=True)[0]
            mx1, mx2 = max(0, fx + int(fw * 0.24)), min(420, fx + int(fw * 0.76))
            my1, my2 = max(0, fy + int(fh * 0.62)), min(420, fy + int(fh * 0.90))
            if mx2 > mx1 + 12 and my2 > my1 + 10:
                mouth_box = (mx1, my1, mx2, my2)

        for idx in range(num_frames):
            energy = float(env[idx])
            frame = base_frame.copy()
            scale = 1.0 + 0.032 * energy + 0.008 * math.sin(idx * 0.18)
            angle = 1.5 * energy * math.sin(idx * 0.35)
            mat = cv2.getRotationMatrix2D((210.0, 210.0), angle, scale)
            frame = cv2.warpAffine(frame, mat, (420, 420), borderMode=cv2.BORDER_REFLECT)

            if mouth_box and energy > 0.14:
                mx1, my1, mx2, my2 = mouth_box
                roi = frame[my1:my2, mx1:mx2]
                rh, rw = roi.shape[:2]
                stretched = cv2.resize(
                    roi, (rw, max(rh, int(rh * (1.0 + 0.10 * energy))))
                )
                y_cut = (stretched.shape[0] - rh) // 2
                frame[my1:my2, mx1:mx2] = stretched[y_cut : y_cut + rh, :rw]

            border_color = (0, 171, 255) if energy > 0.35 else (254, 90, 61)
            cv2.rectangle(frame, (0, 0), (419, 419), border_color, thickness=10)
            writer.write(frame)

    writer.release()
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(tmp_raw_mp4),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            str(out_video),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    tmp_raw_mp4.unlink(missing_ok=True)
    return used_mode


def stage_voice_character() -> None:
    state = load_state()
    use_char = bool(state.get("character_enabled")) and bool(state.get("character_url"))
    portrait_path: Optional[Path] = None

    if use_char:
        portrait_path = prepare_character_portrait(
            state["character_url"], state.get("outfit_prompt", "")
        )

    for clip in state["clips"]:
        c_idx = clip["clip_index"]
        vo_file, engine = synthesize_voiceover(
            clip["ai_pack"]["voiceover"],
            state["language"],
            state["voice_gender"],
            c_idx,
        )
        vo_dur = get_audio_duration(vo_file)
        clean_dur = float(clip["clean_duration"])
        final_dur = max(4.5, min(max(vo_dur + 0.15, clean_dur / 1.03), 60.0))

        clip["vo_file"] = str(vo_file)
        clip["voice_engine"] = engine
        clip["final_duration"] = round(final_dur, 2)

        if portrait_path is not None:
            char_vid = Path(f"char_synced_{c_idx}.mp4")
            mode = generate_talking_character_video(
                portrait_path, vo_file, final_dur, char_vid
            )
            clip["char_video"] = str(char_vid)
            clip["character_mode"] = mode
        else:
            clip["char_video"] = ""
            clip["character_mode"] = "disabled"

    save_state(state)


# ---------------------------------------------------------------------------
# STAGE 4: AUTOMATIC ANTI-COPYRIGHT RENDER, DELOGO, CAPTIONS & POP-INS
# ---------------------------------------------------------------------------
def build_capcut_ass_captions(
    text: str, audio_file: Path, language: str, out_ass: Path
) -> Path:
    total_dur = get_audio_duration(audio_file)
    clean_words = (
        text.replace('"', "")
        .replace("“", "")
        .replace("”", "")
        .replace("\n", " ")
        .split()
    )
    if language != "hi":
        clean_words = [w.upper() for w in clean_words]

    chunks = [clean_words[i : i + 3] for i in range(0, len(clean_words), 3)]
    font_name = "Noto Sans Devanagari" if language == "hi" else "DejaVu Sans"
    font_size = 70 if language == "hi" else 76

    def fmt_ass_time(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        cs = int(round((sec - int(sec)) * 100))
        if cs >= 100:
            s += 1
            cs = 0
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CapCutPop,{font_name},{font_size},&H00FFFFFF,&H0000FFFF,&H00000000,&H90000000,-1,0,0,0,100,100,1.0,0,1,7,4,2,42,42,330,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    step = total_dur / max(len(chunks), 1)
    events: List[str] = []
    for idx, group in enumerate(chunks):
        start = fmt_ass_time(idx * step)
        end = fmt_ass_time(min((idx + 1) * step, total_dur))
        accent = "&H0000D7FF&" if idx % 2 == 0 else "&H0000FFFF&"
        if len(group) > 1:
            styled = (
                " ".join(group[:-1]) + f" {{\\c{accent}}}{group[-1]}{{\\c&H00FFFFFF&}}"
            )
        else:
            styled = f"{{\\c{accent}}}{group[0]}"
        anim = "{\\fscx86\\fscy86\\t(0,65,\\fscx108\\fscy108)\\t(65,130,\\fscx100\\fscy100)}"
        events.append(f"Dialogue: 0,{start},{end},CapCutPop,,0,0,0,,{anim}{styled}")

    out_ass.write_text(header + "\n".join(events), encoding="utf-8")
    return out_ass


def build_delogo_filters(boxes: List[Any], src_w: int, src_h: int) -> List[str]:
    filters: List[str] = []
    for box in (boxes or [])[:6]:
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            continue
        try:
            ymin, xmin, ymax, xmax = [float(v) for v in box]
        except Exception:
            continue
        scale = 1000.0 if max(ymin, xmin, ymax, xmax) > 1.5 else 1.0
        x = max(2, int((xmin / scale) * src_w) - 4)
        y = max(2, int((ymin / scale) * src_h) - 4)
        w = int(((xmax - xmin) / scale) * src_w) + 8
        h = int(((ymax - ymin) / scale) * src_h) + 8
        w = max(8, min(w, src_w - x - 2))
        h = max(8, min(h, src_h - y - 2))
        if w >= 10 and h >= 10 and w < src_w * 0.75 and h < src_h * 0.5:
            filters.append(f"delogo=x={x}:y={y}:w={w}:h={h}")
    return filters


def stage_render() -> None:
    state = load_state()

    for clip in state["clips"]:
        c_idx = clip["clip_index"]
        raw_path = Path(clip["raw_file"])
        vo_path = Path(clip["vo_file"])
        final_dur = float(clip["final_duration"])
        out_mp4 = Path(f"final_clip_{c_idx}.mp4")
        ass_path = build_capcut_ass_captions(
            clip["ai_pack"]["voiceover"],
            vo_path,
            state["language"],
            Path(f"subs_{c_idx}.ass"),
        )

        vision = clip["vision"]
        delogo_chain = build_delogo_filters(
            vision.get("watermark_boxes") or [], int(clip["width"]), int(clip["height"])
        )

        v_steps: List[str] = []
        v_steps.extend(delogo_chain)
        v_steps.append("setpts=PTS/1.03")
        v_steps.append("scale=1242:2208:force_original_aspect_ratio=increase")
        v_steps.append("crop=1080:1920")
        v_steps.append(
            "zoompan=z='1.0+0.035*abs(sin(on/50))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30"
        )
        v_steps.append("eq=contrast=1.14:saturation=1.34:brightness=0.02:gamma=1.04")
        v_steps.append("colorbalance=rs=0.04:gs=0.02:bs=-0.02")
        v_steps.append("unsharp=5:5:0.80:3:3:0.35")

        climax = float(vision.get("climax_second") or (final_dur * 0.5)) / 1.03
        climax_s = max(3.2, min(climax, max(3.5, final_dur - 3.6)))
        climax_e = min(final_dur - 2.1, climax_s + 1.5)
        outro_s = max(2.8, final_dur - 1.8)

        char_vid = Path(clip["char_video"]) if clip.get("char_video") else None
        if char_vid and char_vid.exists():
            # Opening Hook (0.0s–2.5s), Mid-Video Climax (1.5s), Loop Outro (last 1.8s)
            windows = ["between(t,0,2.5)"]
            if final_dur >= 7.0 and climax_e > climax_s + 0.4:
                windows.append(f"between(t,{climax_s:.2f},{climax_e:.2f})")
                outro_s = max(climax_e + 0.35, final_dur - 1.8)
            if outro_s < final_dur - 0.3:
                windows.append(f"between(t,{outro_s:.2f},{final_dur:.2f})")
            enable_expr = "+".join(windows)
            filter_complex = (
                f"[0:v]{','.join(v_steps)}[v_base];"
                f"[2:v]scale=420:420[char_fg];"
                f"[v_base][char_fg]overlay=x=(W-w)/2:y=1080:enable='{enable_expr}',"
                f"ass={ass_path},format=yuv420p[v_out];"
                f"[1:a]apad[a_out]"
            )
            cmd = [
                "ffmpeg",
                "-y",
                "-stream_loop",
                "-1",
                "-i",
                str(raw_path),
                "-i",
                str(vo_path),
                "-stream_loop",
                "-1",
                "-i",
                str(char_vid),
                "-filter_complex",
                filter_complex,
                "-map",
                "[v_out]",
                "-map",
                "[a_out]",
                "-t",
                f"{final_dur:.2f}",
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
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                str(out_mp4),
            ]
        else:
            v_steps.append(f"ass={ass_path}")
            v_steps.append("format=yuv420p")
            filter_complex = f"[0:v]{','.join(v_steps)}[v_out];[1:a]apad[a_out]"
            cmd = [
                "ffmpeg",
                "-y",
                "-stream_loop",
                "-1",
                "-i",
                str(raw_path),
                "-i",
                str(vo_path),
                "-filter_complex",
                filter_complex,
                "-map",
                "[v_out]",
                "-map",
                "[a_out]",
                "-t",
                f"{final_dur:.2f}",
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
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                str(out_mp4),
            ]

        print(
            f"[render] Clip {c_idx}: rendering 1080x1920 MP4 (delogo={len(delogo_chain)}, "
            f"char={clip['character_mode']}, dur={final_dur:.2f}s)"
        )
        subprocess.run(cmd, check=True)

        clip["output_mp4"] = str(out_mp4)
        clip["file_size_bytes"] = out_mp4.stat().st_size
        clip["watermark_boxes_removed"] = len(delogo_chain)
        clip["climax_second"] = round(climax_s, 2)

    save_state(state)


# ---------------------------------------------------------------------------
# STAGE 5: CLOUDINARY OUTPUT DELIVERY (`auto_expire_24h`) & RAW CLEANUP
# ---------------------------------------------------------------------------
def sign_cloudinary_params(params: Dict[str, Any]) -> str:
    pairs = sorted(
        (k, str(v)) for k, v in params.items() if v is not None and str(v) != ""
    )
    payload = "&".join(f"{k}={v}" for k, v in pairs) + CLOUDINARY_API_SECRET
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def cloudinary_upload(
    file_path: Path, resource_type: str, public_id: str, tags: str
) -> Dict[str, Any]:
    if not CLOUDINARY_CLOUD_NAME:
        raise ValueError("CLOUDINARY_CLOUD_NAME is not configured.")

    endpoint = (
        f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/{resource_type}/upload"
    )
    data: Dict[str, Any] = {"public_id": public_id, "tags": tags}

    if CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET:
        timestamp = str(int(time.time()))
        sign_dict = {
            "overwrite": "true",
            "public_id": public_id,
            "tags": tags,
            "timestamp": timestamp,
        }
        data.update(
            {
                "api_key": CLOUDINARY_API_KEY,
                "overwrite": "true",
                "timestamp": timestamp,
                "signature": sign_cloudinary_params(sign_dict),
            }
        )
    elif CLOUDINARY_UPLOAD_PRESET:
        data["upload_preset"] = CLOUDINARY_UPLOAD_PRESET
    else:
        raise ValueError(
            "Configure CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET or CLOUDINARY_UPLOAD_PRESET in GitHub Secrets."
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
            f"Cloudinary {resource_type} upload failed ({resp.status_code}): {resp.text[:240]}"
        )
    return resp.json()


def delete_raw_cloudinary_video(public_id: str) -> None:
    if not public_id:
        return
    if not (CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET):
        return
    timestamp = str(int(time.time()))
    sign_dict = {
        "invalidate": "true",
        "public_id": public_id,
        "timestamp": timestamp,
    }
    requests.post(
        f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/video/destroy",
        data={
            "public_id": public_id,
            "invalidate": "true",
            "timestamp": timestamp,
            "api_key": CLOUDINARY_API_KEY,
            "signature": sign_cloudinary_params(sign_dict),
        },
        timeout=30,
    )


def stage_publish() -> None:
    state = load_state()
    run_tag = state["run_tag"]
    asset_tags = f"{run_tag},auto_expire_24h"
    published_clips: List[Dict[str, Any]] = []

    for clip in state["clips"]:
        c_idx = clip["clip_index"]
        out_mp4 = Path(clip["output_mp4"])
        pub_id = f"explainer-studio/processed/final_{run_tag}_c{c_idx}"
        up = cloudinary_upload(out_mp4, "video", pub_id, asset_tags)
        ai_pack = clip["ai_pack"]

        published_clips.append(
            {
                "clip_index": c_idx,
                "start_sec": clip["start_sec"],
                "end_sec": clip["end_sec"],
                "reason": clip.get("reason", ""),
                "video_url": up["secure_url"],
                "video_public_id": up.get("public_id", pub_id),
                "duration_sec": clip["final_duration"],
                "width": 1080,
                "height": 1920,
                "file_size_bytes": clip["file_size_bytes"],
                "voice_engine": clip.get("voice_engine", ""),
                "character_mode": clip.get("character_mode", "disabled"),
                "watermark_boxes_removed": clip.get("watermark_boxes_removed", 0),
                "climax_second": clip.get("climax_second", 0),
                "youtube_trends_count": clip.get("youtube_trends_count", 0),
                "voiceover": ai_pack.get("voiceover", ""),
                "title": ai_pack.get("title", ""),
                "description": ai_pack.get("description", ""),
                "tags": ai_pack.get("tags", ""),
                "hashtags": ai_pack.get("hashtags", ""),
                "posting_time": ai_pack.get("posting_time", ""),
            }
        )

    primary = published_clips[0]
    manifest = {
        "run_tag": run_tag,
        "language": state["language"],
        "voice_gender": state["voice_gender"],
        "is_long_video_split": state.get("is_long_video_split", False),
        "source_total_duration": state.get("source_total_duration", primary["duration_sec"]),
        "clips": published_clips,
        # Top-level mirrors for Clip 1 compatibility
        "video_url": primary["video_url"],
        "video_public_id": primary["video_public_id"],
        "duration_sec": primary["duration_sec"],
        "width": 1080,
        "height": 1920,
        "file_size_bytes": primary["file_size_bytes"],
        "voice_engine": primary["voice_engine"],
        "character_mode": primary["character_mode"],
        "watermark_boxes_removed": primary["watermark_boxes_removed"],
        "mid_twist_second": primary["climax_second"],
        "youtube_trends_count": primary["youtube_trends_count"],
        "voiceover": primary["voiceover"],
        "title": primary["title"],
        "description": primary["description"],
        "tags": primary["tags"],
        "hashtags": primary["hashtags"],
        "posting_time": primary["posting_time"],
        "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }

    RESULT_MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    manifest_pub_id = f"explainer-studio/results/{run_tag}.json"
    cloudinary_upload(RESULT_MANIFEST_PATH, "raw", manifest_pub_id, asset_tags)
    print(
        f"[publish] Published {len(published_clips)} clip(s) & manifest to Cloudinary (tagged auto_expire_24h)."
    )

    if state.get("source_type") == "upload" and state.get("raw_public_id"):
        delete_raw_cloudinary_video(state["raw_public_id"])
        print("[publish] Deleted temporary uploaded raw source video from Cloudinary.")

    summary_path = os.getenv("GITHUB_STEP_SUMMARY", "")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as sf:
            sf.write(f"## Production Render Complete (`{run_tag}`)\n\n")
            for c in published_clips:
                sf.write(
                    f"### Clip {c['clip_index']} ({c['reason']})\n"
                    f"- **MP4 (1080x1920)**: {c['video_url']}\n"
                    f"- **Title**: {c['title']}\n"
                    f"- **Best Upload Time**: {c['posting_time']}\n\n"
                )


def stage_cleanup_raw() -> None:
    if SOURCE_TYPE == "upload" and VIDEO_SOURCE:
        pub_id = infer_cloudinary_public_id(extract_clean_url(VIDEO_SOURCE))
        if pub_id:
            delete_raw_cloudinary_video(pub_id)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="High-Retention Production Video Engine"
    )
    parser.add_argument(
        "--cleanup-only",
        action="store_true",
        help="Run 24-hour Cloudinary auto-cleanup only (preserves keep_character assets).",
    )
    parser.add_argument(
        "--stage",
        choices=[
            "fetch",
            "analyze",
            "voice_character",
            "render",
            "publish",
            "cleanup_raw",
            "all",
        ],
        default="all",
    )
    args = parser.parse_args()

    if args.cleanup_only:
        cleanup_expired_cloudinary_assets(max_age_hours=24.0)
        return

    if args.stage == "fetch":
        stage_fetch()
    elif args.stage == "analyze":
        stage_analyze()
    elif args.stage == "voice_character":
        stage_voice_character()
    elif args.stage == "render":
        stage_render()
    elif args.stage == "publish":
        stage_publish()
    elif args.stage == "cleanup_raw":
        stage_cleanup_raw()
    elif args.stage == "all":
        stage_fetch()
        stage_analyze()
        stage_voice_character()
        stage_render()
        stage_publish()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
