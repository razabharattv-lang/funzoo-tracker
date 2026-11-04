import os
import random
import requests
import html
import time
from datetime import datetime, timezone, timedelta
import google.generativeai as genai

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MY_CHANNEL_ID = os.getenv("MY_CHANNEL_ID", "")

ORGANIC_THEMES = [
    "ORGANIC WATERMELON HUNT: Rolling a giant ripe melon downhill into a bouncy mud puddle.",
    "BEE TREE HONEY SLIDE: Reaching a wild honeycomb using banana leaves as trampolines.",
    "MEGA CHILLI SNEEZE: Leo bites a mega farm chilli and rockets backwards with steam ears.",
    "MUDDY PADDY OBSTACLE RUN: Summer rain turns farmland into a slide where Shelly surfs like a pro.",
    "PUMPKIN HARVEST ROLLERS: Hollow giant pumpkins racing down a slope with soft vegetable obstacles."
]

SEARCH_QUERIES = [
    "funny 3D animation animal slapstick",
    "cute 3D cartoon animal farm comedy",
    "Pixar style funny cartoon kids slapstick",
    "non verbal funny animal animation shorts"
]

def scan_realtime_breakout_trends():
    now_utc = datetime.now(timezone.utc)
    three_days_ago = (now_utc - timedelta(days=3)).isoformat("T").split(".")[0] + "Z"
    query = random.choice(SEARCH_QUERIES)

    url = (
        f"https://www.googleapis.com/youtube/v3/search"
        f"?part=snippet&q={requests.utils.quote(query)}"
        f"&type=video&videoCategoryId=1&order=viewCount"
        f"&publishedAfter={three_days_ago}&regionCode=US&maxResults=8&key={YOUTUBE_API_KEY}"
    )

    try:
        res = requests.get(url, timeout=15).json()
        items = res.get("items", [])
        v_ids = [i["id"]["videoId"] for i in items if "videoId" in i.get("id", {}) and i["snippet"].get("liveBroadcastContent") == "none"]
        
        if not v_ids:
            return fallback_trends()

        stats_url = f"https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id={','.join(v_ids[:5])}&key={YOUTUBE_API_KEY}"
        stats_res = requests.get(stats_url, timeout=15).json()
        
        ranked, tags = [], []
        for v in stats_res.get("items", []):
            views = int(v.get("statistics", {}).get("viewCount", 0))
            if views < 10000:
                continue
            title = v.get("snippet", {}).get("title", "")[:45]
            pub = v.get("snippet", {}).get("publishedAt", "")
            hours = 24.0
            if pub:
                try:
                    pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
                    hours = max((now_utc - pub_dt).total_seconds() / 3600.0, 1.0)
                except Exception:
                    pass
            ranked.append((int(views / hours), views, title))
            for t in v.get("snippet", {}).get("tags", [])[:6]:
                if t.lower() not in [x.lower() for x in tags]:
                    tags.append(t)

        ranked.sort(key=lambda x: x[0], reverse=True)
        if not ranked:
            return fallback_trends()

        trend_lines = [f"⚡ {t}... ({v:,} views | 🚀 {vph:,}/hr)" for vph, v, t in ranked[:3]]
        return "\n".join(trend_lines), ", ".join(tags[:15])
    except Exception:
        return fallback_trends()

def fallback_trends():
    return (
        "⚡ 3D Animal Watermelon Mud Slide (1,450,000 views | 🚀 14,200/hr)\n"
        "⚡ Funny Animal Farmland Trap Compilation (920,000 views | 🚀 8,400/hr)",
        "3d animation, funny cartoon, slapstick, cute animal, farm adventure, pixar style"
    )

def extract_block(text, marker, next_marker=None):
    if marker not in text:
        return ""
    sub = text.split(marker, 1)[1]
    if next_marker and next_marker in sub:
        sub = sub.split(next_marker, 1)[0]
    return sub.strip()

def generate_production_package(is_long_mode, trends_text, tags_text):
    genai.configure(api_key=GEMINI_API_KEY)
    theme = random.choice(ORGANIC_THEMES)
    aspect_ratio = "16:9 Widescreen" if is_long_mode else "9:16 Vertical Portrait"

    dna = (
        "Attached image reference: Leo (fluffy baby leopard cub), Froggo (green tree frog), Shelly (turtle with blue shell).\n"
        "Ignore the white studio background. Seamlessly integrate them into an organic farm environment.\n"
        "Rule: Only ONE character moves aggressively per shot to prevent AI glitches. Hyper-fast physical slapstick. Zero dialogue."
    )

    if is_long_mode:
        prompt = f"""
Act as Animation Director for 'FunzooKids' (8-10 Min Long Episode).
Theme: {theme}
Trending Tags: {tags_text}
{dna}

Structure 4 progressive Chapters (4 modular shots per chapter, 10s each). Format: {aspect_ratio}.
Use ONLY these exact markers:

[THUMBNAIL_PROMPT]
(High-CTR 3D Pixar Image Prompt, {aspect_ratio}, extreme shock expression, zero text)

[CHAPTER_1]
(Chapter 1 Discovery: 4 distinct 10s shots with high-speed slapstick and audio cues)

[CHAPTER_2]
(Chapter 2 Escalation: 4 distinct 10s shots with fast motion and audio cues)

[CHAPTER_3]
(Chapter 3 Chaos: 4 distinct 10s shots with mud/water physics and audio cues)

[CHAPTER_4]
(Chapter 4 Climax: 4 distinct 10s shots with grand splash and loop reset)

[TITLE]
(1 High-CTR Viral Title with emojis using {tags_text})

[DESCRIPTION]
(SEO description + Chapter Timestamps 0:00, 2:15, 4:30, 6:45 + Mid-Roll Ad slots + CTA)

[TAGS]
(20 comma-separated tags prioritizing {tags_text})

[HASHTAGS]
(8 viral hashtags)
"""
    else:
        prompt = f"""
Act as Animation Director for 'FunzooKids' (30-Sec Viral Short).
Theme: {theme}
Trending Tags: {tags_text}
{dna}

Write 3 fast-paced shots (10s each). Format: {aspect_ratio}.
Use ONLY these exact markers:

[THUMBNAIL_PROMPT]
(High-CTR 3D Pixar Image Prompt, {aspect_ratio}, extreme close-up shock, zero text)

[SCENE_1]
(0-10s Hook: 3D Pixar CGI, {aspect_ratio}, locked shot, single fast action trigger, SFX cues)

[SCENE_2]
(10-20s Reaction: 3D Pixar CGI, {aspect_ratio}, fast tracking, comical slapstick blunder, SFX cues)

[SCENE_3]
(20-30s Climax & Loop: 3D Pixar CGI, {aspect_ratio}, satisfying soft splash, seamless loop reset, SFX cues)

[TITLE]
(1 High-CTR Viral Title with emojis using {tags_text})

[DESCRIPTION]
(2-line SEO description weaving in {tags_text} + CTA)

[TAGS]
(15 comma-separated tags prioritizing {tags_text})

[HASHTAGS]
(6 viral hashtags)
"""

    models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]
    for m in models:
        try:
            model = genai.GenerativeModel(m)
            res = model.generate_content(prompt)
            if res and res.text:
                return theme, aspect_ratio, res.text
        except Exception:
            continue
    return theme, aspect_ratio, ""

def send_telegram_in_chunks(chat_id, token, text_parts):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for part in text_parts:
        if not part.strip():
            continue
        payload = {"chat_id": chat_id, "text": part, "parse_mode": "HTML"}
        res = requests.post(url, json=payload, timeout=25)
        if res.status_code != 200:
            payload.pop("parse_mode", None)
            requests.post(url, json=payload, timeout=25)
        time.sleep(1)

def send_telegram_package(is_long_mode, trends_text, theme, aspect_ratio, raw_text):
    ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    upload_target = ist_now + timedelta(hours=1)
    time_str = ist_now.strftime("%d %b %Y | %I:%M %p IST")
    upload_str = upload_target.strftime("%I:%M %p IST")

    if not raw_text:
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, ["⚠️ API error. Check quota."])
        return

    thumb = html.escape(extract_block(raw_text, "[THUMBNAIL_PROMPT]", "[CHAPTER_1]" if is_long_mode else "[SCENE_1]"))
    title = html.escape(extract_block(raw_text, "[TITLE]", "[DESCRIPTION]"))
    desc = html.escape(extract_block(raw_text, "[DESCRIPTION]", "[TAGS]"))
    tags = html.escape(extract_block(raw_text, "[TAGS]", "[HASHTAGS]"))
    hashtags = html.escape(extract_block(raw_text, "[HASHTAGS]"))

    header = (
        f"⚡ <b>FUNZOOKIDS PRODUCTION ENGINE</b>\n"
        f"🕒 <b>Alert Time:</b> {time_str}\n"
        f"⏰ <b>Target Upload Time:</b> <b>{upload_str}</b> (1 Hour Window)\n"
        f"🎯 <b>Format:</b> <b>{html.escape(aspect_ratio)}</b>\n"
        f"🌾 <b>Theme:</b> {html.escape(theme)}\n\n"
        f"📈 <b>FASTEST BREAKING US TRENDS:</b>\n{html.escape(trends_text)}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🖼️ <b>ZERO-TEXT THUMBNAIL PROMPT (Tap to Copy)</b>\n"
        f"<code>{thumb}</code>\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
    )

    if is_long_mode:
        ch1 = html.escape(extract_block(raw_text, "[CHAPTER_1]", "[CHAPTER_2]"))
        ch2 = html.escape(extract_block(raw_text, "[CHAPTER_2]", "[CHAPTER_3]"))
        ch3 = html.escape(extract_block(raw_text, "[CHAPTER_3]", "[CHAPTER_4]"))
        ch4 = html.escape(extract_block(raw_text, "[CHAPTER_4]", "[TITLE]"))
        
        part1 = header + f"🎬 <b>CHAPTER 1: DISCOVERY</b>\n<code>{ch1}</code>\n\n\n"
        part2 = f"🎬 <b>CHAPTER 2: ESCALATION</b>\n<code>{ch2}</code>\n\n\n🎬 <b>CHAPTER 3: CHAOS</b>\n<code>{ch3}</code>\n\n\n"
        part3 = f"🎬 <b>CHAPTER 4: CLIMAX & WIN</b>\n<code>{ch4}</code>\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 <b>TITLE</b>\n<code>{title}</code>\n\n📝 <b>DESCRIPTION</b>\n<code>{desc}</code>\n\n🏷️ <b>TAGS</b>\n<code>{tags}</code>\n\n#️⃣ <b>HASHTAGS</b>\n<code>{hashtags}</code>"
        
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, [part1, part2, part3])
    else:
        s1 = html.escape(extract_block(raw_text, "[SCENE_1]", "[SCENE_2]"))
        s2 = html.escape(extract_block(raw_text, "[SCENE_2]", "[SCENE_3]"))
        s3 = html.escape(extract_block(raw_text, "[SCENE_3]", "[TITLE]"))
        
        part1 = header + f"🎬 <b>SCENE 1 (0-10s Hook)</b>\n<code>{s1}</code>\n\n\n🎬 <b>SCENE 2 (10-20s Action)</b>\n<code>{s2}</code>\n\n\n"
        part2 = f"🎬 <b>SCENE 3 (20-30s Loop)</b>\n<code>{s3}</code>\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 <b>TITLE</b>\n<code>{title}</code>\n\n📝 <b>DESCRIPTION</b>\n<code>{desc}</code>\n\n🏷️ <b>TAGS</b>\n<code>{tags}</code>\n\n#️⃣ <b>HASHTAGS</b>\n<code>{hashtags}</code>"
        
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, [part1, part2])

if __name__ == "__main__":
    weekday = datetime.now(timezone.utc).weekday()
    # सोमवार (0) और गुरुवार (3) को 10-मिनट लॉन्ग वीडियो मोड, बाकी दिन शॉर्ट्स
    is_long_mode = (weekday in [0, 3])

    trends, tags = scan_realtime_breakout_trends()
    theme, aspect_ratio, content = generate_production_package(is_long_mode, trends, tags)
    send_telegram_package(is_long_mode, trends, theme, aspect_ratio, content)
