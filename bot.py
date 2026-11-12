import os
import re
import gc
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
    text = f"⚡ <b>FUNZOOKIDS PREMIUM UPGRADER</b>\n\n<code>[{bar}] {percent}%</code>\n🔄 {status_text}"
    try:
        requests.post(
            f"{TG_API}/editMessageText",
            json={"chat_id": chat_id, "message_id": msg_id, "text": text, "parse_mode": "HTML"},
            timeout=10
        )
    except Exception:
        pass

def get_media_duration(file_path):
    if file_path.endswith(".wav"):
        with wave.open(file_path, "rb") as wf:
            return wf.getnframes() / float(wf.getframerate())
    proc = subprocess.run([FFMPEG_EXE, "-i", file_path], capture_output=True, text=True)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", proc.stderr)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return 10.0

def extract_frames_base64(video_path, dur):
    frames_b64 = []
    points = [max(0.5, dur * 0.15), dur * 0.40, dur * 0.65, max(1.0, dur * 0.85)]
    for idx, sec in enumerate(points):
        img_path = f"frame_{idx}.jpg"
        subprocess.run(
            [FFMPEG_EXE, "-y", "-ss", f"{sec:.2f}", "-i", video_path, "-vf", "scale=420:-1", "-vframes", "1", "-q:v", "6", img_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        if os.path.exists(img_path):
            with open(img_path, "rb") as f:
                frames_b64.append(base64.b64encode(f.read()).decode("utf-8"))
            os.remove(img_path)
    return frames_b64

def analyze_video_with_gemini(frames_b64, clean_dur, user_hint=""):
    target_words = max(22, min(40, int(clean_dur * 2.6)))
    prompt = f"""
    You are an elite viral video strategist targeting High-CPM audiences (USA, Europe).
    Analyze these frames from a {clean_dur:.1f}-second smart gadget/life-hack video.
    User hint: {user_hint}
    
    Return ONLY valid JSON with these exact keys:
    {{
      "voice_gender": "female" or "male" (Choose strictly based on what fits this specific product's vibe best),
      "voiceover": "A hyper-engaging American English narration of roughly {target_words} words. Hook the viewer instantly, emphasize the premium quality/usefulness, and end with a viral comment-bait question.",
      "title": "High-CTR viral title tailored to current US Facebook Reels trends (No generic titles)",
      "description": "2-line engaging SEO description strictly customized for this exact item.",
      "tags": "15 highly specific, trendy comma-separated tags for this exact item (Do NOT use generic tags like 'gadget' or 'hack' alone).",
      "hashtags": "7 ultra-targeted trending hashtags for US/UK audiences.",
      "posting_time": "The single best time to post this for peak US/Europe views (e.g., '6:30 PM EST')"
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

    models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash"]
    last_err = ""
    for m in models:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}"
            res = requests.post(url, json=payload, timeout=60).json()
            if "candidates" in res and res["candidates"]:
                raw_text = res["candidates"][0]["content"]["parts"][0]["text"].strip()
                raw_text = raw_text.removeprefix("```json").removesuffix("```").strip()
                return json.loads(raw_text)
            last_err = str(res)
        except Exception as e:
            last_err = str(e)
            continue

    raise ValueError(f"API Response Issue: {last_err[:250]}")

def generate_human_voice(text, gender, wav_out="vo.wav"):
    is_male = "male" in gender.lower() and "female" not in gender.lower()
    gemini_voice = "Puck" if is_male else "Aoede"
    edge_voice = "en-US-AndrewMultilingualNeural" if is_male else "en-US-AvaMultilingualNeural"
    
    tts_models = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-2.5-flash-preview-tts"]
    for m in tts_models:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}"
            payload = {
                "contents": [{
                    "parts": [{
                        "text": f"Speak this in a highly engaging, professional, and natural American voice like a top lifestyle creator:\n{text}"
                    }]
                }],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {"voiceName": gemini_voice}
                        }
                    }
                }
            }
            res = requests.post(url, json=payload, timeout=25).json()
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

    mp3_out = "vo_backup.mp3"
    async def _run_tts():
        comm = edge_tts.Communicate(text, edge_voice, rate="+3%")
        await comm.save(mp3_out)
    asyncio.run(_run_tts())
    return mp3_out

def build_stylish_ass_subtitles(text, audio_file, ass_out="viral_subs.ass"):
    total_dur = get_media_duration(audio_file)
    words = text.upper().replace('"', '').replace("'", "").split()
    chunks = [words[i:i+3] for i in range(0, len(words), 3)]

    def fmt_ass_time(sec):
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        cs = int((sec - int(sec)) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    # और भी प्रीमियम वायरल फोंट स्टाइल (Neon Glow Effect के साथ)
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ViralPop,DejaVu Sans,54,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1.2,0,1,5,4,2,25,25,240,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    step = total_dur / max(len(chunks), 1)
    events = []
    for idx, word_group in enumerate(chunks):
        start = fmt_ass_time(idx * step)
        end = fmt_ass_time(min((idx + 1) * step, total_dur))
        
        highlight_color = "&H0000D7FF&" if idx % 2 == 0 else "&H0000FFFF&" # Gold & Cyan Highlights
        if len(word_group) > 1:
            styled_text = " ".join(word_group[:-1]) + f" {{\\c{highlight_color}}}{word_group[-1]}{{\\c&H00FFFFFF&}}"
        else:
            styled_text = f"{{\\c{highlight_color}}}{word_group[0]}"

        anim = "{\\fscx85\\fscy85\\t(0,60,\\fscx108\\fscy108)\\t(60,120,\\fscx100\\fscy100)}"
        events.append(f"Dialogue: 0,{start},{end},ViralPop,,0,0,0,,{anim}{styled_text}")

    with open(ass_out, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(events))

def upgrade_video_master(in_vid, vo_audio, ass_file, out_vid, target_dur):
    gc.collect()
    # प्रीमियम 4K-Level कलर ग्रेडिंग और शार्पनेस (Professional Look)
    vf = (
        "[0:v]scale=830:1476:force_original_aspect_ratio=increase,crop=720:1280,"
        "eq=contrast=1.15:saturation=1.40:brightness=0.02:gamma=1.05,"
        "colorbalance=rs=0.05:gs=0.02:bs=-0.02,"
        "unsharp=3:3:0.8:3:3:0.4,"
        f"ass={ass_file}[v_out];"
    )
    af = "[1:a]volume=1.6,equalizer=f=200:t=q:w=1:g=2,equalizer=f=4500:t=q:w=1:g=2,apad[a_out]"

    cmd = [
        FFMPEG_EXE, "-y", "-threads", "1", "-i", in_vid, "-i", vo_audio,
        "-filter_complex", vf + af,
        "-map", "[v_out]", "-map", "[a_out]",
        "-t", f"{target_dur:.2f}",
        "-c:v", "libx264", "-preset", "superfast", "-crf", "19",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", "-map_metadata", "-1", out_vid
    ]
    subprocess.run(cmd, check=True)

def process_video_task(chat_id, file_id, user_hint=""):
    status_id = tg_send(chat_id, "⚡ <b>FUNZOOKIDS PREMIUM UPGRADER</b>\n\n<code>[█░░░░░░░░░] 10%</code>\n📥 Video received! Downloading...")
    try:
        file_info = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}, timeout=20).json()
        file_path = file_info["result"]["file_path"]
        vid_bytes = requests.get(f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}", timeout=60).content
        with open("raw_input.mp4", "wb") as f:
            f.write(vid_bytes)
        del vid_bytes
        gc.collect()

        raw_dur = get_media_duration("raw_input.mp4")
        clean_dur = max(4.0, raw_dur - 2.4) if raw_dur > 7.5 else raw_dur

        tg_progress(chat_id, status_id, 40, "AI is researching US Trends & analyzing frames...")
        frames = extract_frames_base64("raw_input.mp4", clean_dur)
        ai_data = analyze_video_with_gemini(frames, clean_dur, user_hint)
        del frames
        gc.collect()

        voice_gender = ai_data.get("voice_gender", "female")
        tg_progress(chat_id, status_id, 65, f"Generating Professional {voice_gender.title()} Voice & Captions...")
        vo_file = generate_human_voice(ai_data["voiceover"], voice_gender)
        vo_dur = get_media_duration(vo_file)
        final_dur = max(clean_dur, min(raw_dur, vo_dur))
        build_stylish_ass_subtitles(ai_data["voiceover"], vo_file, "viral_subs.ass")

        tg_progress(chat_id, status_id, 85, "Upgrading Colors to Premium Quality & Rendering...")
        upgrade_video_master("raw_input.mp4", vo_file, "viral_subs.ass", "final_viral.mp4", final_dur)

        tg_progress(chat_id, status_id, 100, "Done! Sending the Viral Masterpiece to you...")
        
        # Telegram पर भेजे जाने वाले मैसेज में अब Posting Time भी मिलेगा
        final_caption = (
            f"🔥 <b>VIRAL VIDEO READY TO POST</b>\n\n"
            f"📌 <b>TITLE (Tap to Copy):</b>\n<code>{html.escape(ai_data.get('title', ''))}</code>\n\n"
            f"📝 <b>DESCRIPTION:</b>\n<code>{html.escape(ai_data.get('description', ''))}</code>\n\n"
            f"🏷️ <b>TRENDING TAGS:</b>\n<code>{html.escape(ai_data.get('tags', ''))}</code>\n\n"
            f"#️⃣ <b>HASHTAGS:</b>\n<code>{html.escape(ai_data.get('hashtags', ''))}</code>\n\n"
            f"🕒 <b>BEST POSTING TIME (US/EU):</b>\n<code>{html.escape(ai_data.get('posting_time', ''))}</code>"
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
    finally:
        for fn in ["raw_input.mp4", "vo.wav", "vo_backup.mp3", "viral_subs.ass", "final_viral.mp4"]:
            if os.path.exists(fn):
                try:
                    os.remove(fn)
                except Exception:
                    pass
        gc.collect()

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
