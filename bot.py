import os
import random
import requests
import html
import time
from datetime import datetime, timezone, timedelta
import google.generativeai as genai

# ==============================================================================
# 🔑 CREDENTIALS & SECRETS
# ==============================================================================
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

ORGANIC_TREND_THEMES = [
    "ORGANIC HARVEST: Rolling a 100kg juicy watermelon downhill.",
    "BEE TREE: Reaching a honeycomb using banana leaves as trampolines.",
    "GIANT CHILLI: Leo bites a mega chilli and rockets backwards.",
]

SEARCH_QUERIES = ["funny 3D animation animal slapstick", "cute 3D cartoon animal farm comedy"]

def scan_realtime_breakout_trends():
    now_utc = datetime.now(timezone.utc)
    three_days_ago = (now_utc - timedelta(days=3)).isoformat("T").split(".")[0] + "Z"
    query = random.choice(SEARCH_QUERIES)
    url = (f"https://www.googleapis.com/youtube/v3/search?part=snippet&q={requests.utils.quote(query)}"
           f"&type=video&videoCategoryId=1&order=viewCount&publishedAfter={three_days_ago}&regionCode=US&maxResults=8&key={YOUTUBE_API_KEY}")

    try:
        res = requests.get(url, timeout=15).json()
        items = res.get("items", [])
        v_ids = [i["id"]["videoId"] for i in items if "videoId" in i.get("id", {}) and i["snippet"].get("liveBroadcastContent") == "none"]
        
        if not v_ids: return fallback_trends()

        stats_url = f"https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id={','.join(v_ids[:5])}&key={YOUTUBE_API_KEY}"
        stats_res = requests.get(stats_url, timeout=15).json()
        
        ranked, tags = [], []
        for v in stats_res.get("items", []):
            views = int(v.get("statistics", {}).get("viewCount", 0))
            if views < 10000: continue
            title = v.get("snippet", {}).get("title", "")[:45]
            pub = v.get("snippet", {}).get("publishedAt", "")
            hours = max((now_utc - datetime.fromisoformat(pub.replace("Z", "+00:00"))).total_seconds() / 3600.0, 1.0) if pub else 24.0
            ranked.append((int(views / hours), views, title))
            for t in v.get("snippet", {}).get("tags", [])[:6]:
                if t.lower() not in [x.lower() for x in tags]: tags.append(t)

        ranked.sort(key=lambda x: x[0], reverse=True)
        if not ranked: return fallback_trends()
        trend_lines = [f"⚡ {t}... ({v:,} views | 🚀 {vph:,}/hr)" for vph, v, t in ranked[:3]]
        return "\n".join(trend_lines), ", ".join(tags[:15])
    except Exception:
        return fallback_trends()

def fallback_trends():
    return ("⚡ 3D Animal Watermelon Mud Slide (1,450,000 views | 🚀 14,200/hr)\n"
            "⚡ Funny Animal Farmland Trap Compilation (920,000 views | 🚀 8,400/hr)",
            "3d animation, funny cartoon, slapstick, cute animal, farm adventure, pixar style")

def extract_block(text, marker, next_marker=None):
    if marker not in text: return ""
    sub = text.split(marker, 1)[1]
    if next_marker and next_marker in sub: sub = sub.split(next_marker, 1)[0]
    return sub.strip()

def generate_production_package(is_long_mode, trends_text, tags_text):
    genai.configure(api_key=GEMINI_API_KEY)
    theme = random.choice(ORGANIC_TREND_THEMES)
    aspect_ratio = "16:9 Widescreen" if is_long_mode else "9:16 Vertical"

    prompt = f"""
You are the Creative Director of 'FunzooKids'. 
Theme: {theme}
Tags: {tags_text}

CRITICAL RULES FOR AI VIDEO GENERATORS (VEO/KLING):
1. ONE ACTION PER SCENE: Focus on ONE fast, exaggerated main action per scene. Do NOT mix character actions.
2. SHORT & FAST: Keep prompts punchy (50-60 words). Use words like 'zooms', 'rockets', 'motion blur'.
3. AVOID CONFUSION: If one character is acting, others are static or absent. 
4. ALWAYS start with: '3D Pixar CGI, {aspect_ratio}, hyper-fast action:'

Use these exact markers:

[THUMBNAIL_PROMPT]
(Zero-text 3D Pixar prompt. Extreme close up.)

[SCENE_1]
(0-10s: 3D Pixar CGI, {aspect_ratio}, hyper-fast action: ONE extreme setup.)

[SCENE_2]
(10-20s: 3D Pixar CGI, {aspect_ratio}, hyper-fast action: ONE fast reaction.)

[SCENE_3]
(20-30s: 3D Pixar CGI, {aspect_ratio}, hyper-fast action: Impact/splash.)

[TITLE]
(1 Viral Title)

[DESCRIPTION]
(Short SEO description)

[TAGS]
(15 tags based on {tags_text})

[HASHTAGS]
(6 hashtags)
"""
    model = genai.GenerativeModel("gemini-3.5-flash-lite")
    res = model.generate_content(prompt)
    return theme, aspect_ratio, res.text if res and res.text else ""

def send_telegram_in_chunks(chat_id, token, text_parts):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for part in text_parts:
        if not part.strip(): continue
        payload = {"chat_id": chat_id, "text": part, "parse_mode": "HTML"}
        res = requests.post(url, json=payload, timeout=25)
        if res.status_code != 200:
            payload.pop("parse_mode", None)
            requests.post(url, json=payload, timeout=25)
        time.sleep(1)

def send_telegram_package(is_long_mode, trends_text, theme, aspect_ratio, raw_text):
    ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    time_str = ist_now.strftime("%d %b %Y | %I:%M %p IST")
    
    if not raw_text:
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, ["⚠️ Gemini API Generation Error."])
        return

    thumb = html.escape(extract_block(raw_text, "[THUMBNAIL_PROMPT]", "[SCENE_1]"))
    title = html.escape(extract_block(raw_text, "[TITLE]", "[DESCRIPTION]"))
    desc = html.escape(extract_block(raw_text, "[DESCRIPTION]", "[TAGS]"))
    tags = html.escape(extract_block(raw_text, "[TAGS]", "[HASHTAGS]"))
    hashtags = html.escape(extract_block(raw_text, "[HASHTAGS]"))

    header = (f"⚡ <b>FUNZOOKIDS ENGINE</b>\n🕒 <b>Time:</b> {time_str}\n🎯 <b>Format:</b> <b>{html.escape(aspect_ratio)}</b>\n🌾 <b>Theme:</b> {html.escape(theme)}\n\n📈 <b>TRENDS:</b>\n{html.escape(trends_text)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🖼️ <b>THUMBNAIL</b>\n<code>{thumb}</code>\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n")

    s1 = html.escape(extract_block(raw_text, "[SCENE_1]", "[SCENE_2]"))
    s2 = html.escape(extract_block(raw_text, "[SCENE_2]", "[SCENE_3]"))
    s3 = html.escape(extract_block(raw_text, "[SCENE_3]", "[TITLE]"))
    
    part1 = header + f"🎬 <b>SCENE 1</b>\n<code>{s1}</code>\n\n🎬 <b>SCENE 2</b>\n<code>{s2}</code>\n\n"
    part2 = f"🎬 <b>SCENE 3</b>\n<code>{s3}</code>\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 <b>TITLE</b>\n<code>{title}</code>\n📝 <b>DESCRIPTION</b>\n<code>{desc}</code>\n🏷️ <b>TAGS</b>\n<code>{tags}</code>\n#️⃣ <b>HASHTAGS</b>\n<code>{hashtags}</code>"
    
    send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, [part1, part2])

if __name__ == "__main__":
    now_utc = datetime.now(timezone.utc)
    is_long_mode = (now_utc.hour >= 14)
    trends, tags = scan_realtime_breakout_trends()
    theme, aspect_ratio, content = generate_production_package(is_long_mode, trends, tags)
    send_telegram_package(is_long_mode, trends, theme, aspect_ratio, content)
