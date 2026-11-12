import os
import re
import json
import wave
import base64
import asyncio
import threading
import requests
import html
import subprocess
import edge_tts
import imageio_ffmpeg
from flask import Flask, request

app = Flask(__name__)

# Render के Environment Variables से चाबियां अपने आप उठेंगी
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
RENDER_URL = os.getenv("RENDER_EXTERNAL_URL", "").strip()

TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
PROCESSED_UPDATES = set()

def tg_send(chat_id, text):
    res = requests.post(
        f"{TG_API}/sendMessage",
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
        timeout=20
    ).json()
    return res.get("result", {}).get("message_id")

def tg_progress(chat_id, msg_id, percent, status_text):
    if not msg_id:
        return
    filled = int(percent // 10)
    bar = "█" * filled + "░" * (10 - filled)
    text = f"⚡ <b>FUNZOOKIDS VIDEO UPGRADER</b>\n\n<code>[{bar}] {percent}%</code>\n🔄 {status_text}"
    requests.post(
        f"{TG_API}/editMessageText",
        json={"chat_id": chat_id, "message_id": msg_id, "text": text, "parse_mode": "HTML"},
        timeout=15
    )

def get_audio_duration(audio_path):
    if audio_path.endswith(".wav"):
        with wave.open(audio_path, "rb") as wf:
            return wf.getnframes() / float(wf.getframerate())
    proc = subprocess.run([FFMPEG_EXE, "-i", audio_path], capture_output=True, text=True)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", proc.stderr)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return 8.0

def extract_frames_base64(video_path):
    frames_b64 = []
    for idx, sec in enumerate(["00:00:01", "00:00:03", "00:00:05"]):
        img_path = f"frame_{idx}.jpg"
        subprocess.run(
            [FFMPEG_EXE, "-y", "-ss", sec, "-i", video_path, "-vframes", "1", "-q:v", "2", img_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        if os.path.exists(img_path):
            with open(img_path, "rb") as f:
                frames_b64.append(base64.b64encode(f.read()).decode("utf-8"))
    return frames_b64

def analyze_video_with_gemini(frames_b64, user_hint=""):
    prompt = f"""
    You are an expert viral short-form video creator for US, Europe, and Ukraine audiences.
    Look at these frames from a smart gadget / kitchen / life-hack video.
    User hint: {user_hint}
    
    Return ONLY valid JSON with these exact keys:
    {{
      "voiceover": "A punchy, energetic 2-sentence narration in natural American English (MAX 22 WORDS). Start with a curiosity hook and end with a question that forces comments.",
      "title": "High-CTR viral title (under 50 chars) with 1-2 emojis",
      "description": "2-line engaging SEO description for Facebook Reels & YouTube Shorts",
      "tags": "15 comma-separated viral search tags",
      "hashtags": "#smartgadgets #homehacks #kitchenhacks #lifehacks #amazonfinds #gadgets #reels #shorts"
    }}
    """
    parts = [{"text": prompt}]
    for b64 in frames_b64:
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": b64}})

    payload = {
        "contents": [{"parts": parts}],
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
        ]
    }

    # लेटेस्ट 2026 Gemini मॉडल्स
    models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash"]
    last_err = ""
    for m in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}"
        res = requests.post(url, json=payload, timeout=40).json()
        if "candidates" in res and res["candidates"]:
            raw_text = res["candidates"][0]["content"]["parts"][0]["text"].strip()
            raw_text = raw_text.removeprefix("```json").removesuffix("```").strip()
            return json.loads(raw_text)
        last_err = str(res)

    raise ValueError(f"API Response Issue: {last_err[:250]}")

def generate_human_voice(text, wav_out="vo.wav"):
    # पहले लेटेस्ट Gemini Audio मॉडल्स से असली Human Voice निकालने की कोशिश
    tts_models = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-2.5-flash-preview-tts"]
    for m in tts_models:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}"
            payload = {
                "contents": [{
                    "parts": [{
                        "text": f"Speak this like an excited, natural American YouTube Shorts creator with real human emotion:\n{text}"
                    }]
                }],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {"voiceName": "Fenrir"}
                        }
                    }
                }
            }
            res = requests.post(url, json=payload, timeout=35).json()
            audio_b64 = res["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            pcm_bytes = base64.b64decode(audio_b64)
            with wave.open(wav_out, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(24000)
                wf.writeframes(pcm_bytes)
            return wav_out
        except Exception:
            continue

    # Ultra-Natural American Human Voice Backup (Zero Robotic Tone)
    mp3_out = "vo_backup.mp3"
    async def _run_tts():
        comm = edge_tts.Communicate(text, "en-US-AndrewMultilingualNeural", rate="+7%")
        await comm.save(mp3_out)
    asyncio.run(_run_tts())
    return mp3_out

def build_stylish_ass_subtitles(text, audio_file, ass_out="viral_subs.ass"):
    total_dur = get_audio_duration(audio_file)
    words = text.upper().replace('"', '').replace("'", "").split()
    chunks = [" ".join(words[i:i+3]) for i in range(0, len(words), 3)]

    def fmt_ass_time(sec):
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        cs = int((sec - int(sec)) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ViralPop,DejaVu Sans,72,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,6,4,2,40,40,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    step = total_dur / max(len(chunks), 1)
    events = []
    for idx, chunk in enumerate(chunks):
        start = fmt_ass_time(idx * step)
        end = fmt_ass_time(min((idx + 1) * step, total_dur))
        events.append(f"Dialogue: 0,{start},{end},ViralPop,,0,0,0,,{{\\fad(80,80)}}{chunk}")

    with open(ass_out, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(events))

def upgrade_video_master(in_vid, vo_audio, ass_file, out_vid):
    vf = (
        "[0:v]scale=1220:2170:force_original_aspect_ratio=increase,crop=1080:1920,"
        "eq=contrast=1.09:saturation=1.18:brightness=0.01,"
        "unsharp=5:5:1.0:3:3:0.5,"
        "setpts=0.96*PTS,fps=60,"
        "drawbox=x=30:y=1280:w=1020:h=340:color=black@0.90:t=fill,"
        f"ass={ass_file}[v_out];"
    )
    af = "[1:a]volume=1.5,equalizer=f=120:t=q:w=1:g=3,equalizer=f=5000:t=q:w=1:g=2,loudnorm=I=-16:TP=-1.5:LRA=11[a_out]"

    cmd = [
        FFMPEG_EXE, "-y", "-i", in_vid, "-i", vo_audio,
        "-filter_complex", vf + af,
        "-map", "[v_out]", "-map", "[a_out]",
        "-c:v", "libx264", "-preset", "fast", "-profile:v", "high", "-level", "4.2", "-b:v", "5M", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-map_metadata", "-1", out_vid
    ]
    subprocess.run(cmd, check=True)

def process_video_task(chat_id, file_id, user_hint=""):
    status_id = tg_send(chat_id, "⚡ <b>FUNZOOKIDS VIDEO UPGRADER</b>\n\n<code>[█░░░░░░░░░] 10%</code>\n📥 Video received! Downloading...")
    try:
        file_info = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}, timeout=20).json()
        file_path = file_info["result"]["file_path"]
        vid_bytes = requests.get(f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}", timeout=60).content
        with open("raw_input.mp4", "wb") as f:
            f.write(vid_bytes)

        tg_progress(chat_id, status_id, 40, "AI is analyzing frames and writing viral hooks...")
        frames = extract_frames_base64("raw_input.mp4")
        ai_data = analyze_video_with_gemini(frames, user_hint)

        tg_progress(chat_id, status_id, 65, "Generating Real Human Voice & Pop-up Captions...")
        vo_file = generate_human_voice(ai_data["voiceover"])
        build_stylish_ass_subtitles(ai_data["voiceover"], vo_file, "viral_subs.ass")

        tg_progress(chat_id, status_id, 85, "Upscaling Quality, Removing Chinese Text & Rendering...")
        upgrade_video_master("raw_input.mp4", vo_file, "viral_subs.ass", "final_viral.mp4")

        tg_progress(chat_id, status_id, 100, "Done! Sending the Viral Masterpiece to you...")
        final_caption = (
            f"🔥 <b>VIRAL VIDEO READY TO POST</b>\n\n"
            f"📌 <b>TITLE (Tap to Copy):</b>\n<code>{html.escape(ai_data['title'])}</code>\n\n"
            f"📝 <b>DESCRIPTION:</b>\n<code>{html.escape(ai_data['description'])}</code>\n\n"
            f"🏷️ <b>TAGS:</b>\n<code>{html.escape(ai_data['tags'])}</code>\n\n"
            f"#️⃣ <b>HASHTAGS:</b>\n<code>{html.escape(ai_data['hashtags'])}</code>"
        )

        with open("final_viral.mp4", "rb") as f:
            requests.post(
                f"{TG_API}/sendVideo",
                data={"chat_id": chat_id, "caption": final_caption, "parse_mode": "HTML"},
                files={"video": f},
                timeout=120
            )

        requests.post(f"{TG_API}/deleteMessage", json={"chat_id": chat_id, "message_id": status_id}, timeout=10)

    except Exception as e:
        requests.post(
            f"{TG_API}/editMessageText",
            json={"chat_id": chat_id, "message_id": status_id, "text": f"❌ Error: {html.escape(str(e))}"},
            timeout=15
        )

@app.route("/", methods=["GET"])
def home():
    if RENDER_URL and TELEGRAM_BOT_TOKEN:
        requests.get(f"{TG_API}/setWebhook", params={"url": f"{RENDER_URL}/webhook"}, timeout=10)
    return "FunzooKids Video Upgrader is Live!", 200

@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(silent=True) or {}
    upd_id = data.get("update_id")
    if upd_id in PROCESSED_UPDATES:
        return "OK", 200
    if upd_id:
        PROCESSED_UPDATES.add(upd_id)

    msg = data.get("message", {})
    video_obj = msg.get("video") or msg.get("document")
    if video_obj:
        chat_id = msg.get("chat", {}).get("id") or TELEGRAM_CHAT_ID
        file_id = video_obj["file_id"]
        hint = msg.get("caption", "")
        threading.Thread(target=process_video_task, args=(chat_id, file_id, hint)).start()

    return "OK", 200

if RENDER_URL and TELEGRAM_BOT_TOKEN:
    try:
        requests.get(f"{TG_API}/setWebhook", params={"url": f"{RENDER_URL}/webhook"}, timeout=10)
    except Exception:
        pass

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
