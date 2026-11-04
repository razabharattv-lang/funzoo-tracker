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
MY_CHANNEL_ID = os.getenv("MY_CHANNEL_ID", "")

ORGANIC_THEMES = [
    "ORGANIC WATERMELON ROLL: Leo tries to steal a giant ripe watermelon, rolls down a muddy hill, and triggers a giant bouncy squash.",
    "WILD HONEYCOMB AMBUSH: Leo aims a stone at a sweet honeycomb, accidentally knocks down a harmless berry cluster that covers Froggo in pink sticky juice.",
    "MEGA CHILLI BITE: Leo bites a massive fiery farm chilli, shoots backward with comical smoke puffs, while Shelly drifts past like a rescue board.",
    "MUDDY PADDY OBSTACLE SLIDE: A sudden downpour turns farmland into a natural mud slide where Shelly surfs and saves Leo and Froggo from a giant puddle.",
    "HOLLOW PUMPKIN CAR CHASE: Carving hollow farm pumpkins into roll-carts, racing downhill until they pop harmlessly into a soft vegetable barrier."
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

    dna_and_rules = (
        "VISUAL CONTINUITY RULES (STRICT):\n"
        "- Attached Reference Image: Used STRICTLY for character likeness (Leo: leopard cub, Froggo: chubby green frog, Shelly: tiny blue turtle).\n"
        "- Completely IGNORE the white studio background. Ground them in natural, sunlit organic farmland.\n"
        "- CAUSE AND EFFECT CONTINUITY: Scene 2 MUST begin exactly where Scene 1 physically ends. Scene 3 MUST begin where Scene 2 ends.\n"
        "- SINGLE ACTION RULE: Do NOT give multiple complex actions at once. Only ONE character drives the physical comedy; others react naturally.\n"
        "- VEO SAFE: No violent words (no hit, punch, bleed). Use 'cartoon slip', 'squishy bounce', 'fruit splash', 'motion blur'."
    )

    if is_long_mode:
        prompt = f"""
Act as Master Storyboard Director for 'FunzooKids' (8-10 Min Long-Form Video).
Theme: {theme}
Live Harvested Tags: {tags_text}
{dna_and_rules}

STEP 1: Write a structured 4-Act Storyline Script (Hook -> Escalation -> Chaos -> Climax & Lesson).
STEP 2: Write sequential 10s video prompts for each chapter in {aspect_ratio} format.

Use ONLY these exact markers:

[STORY_SCRIPT]
(Write the 4-part continuous narrative story script explaining the exact cause-and-effect chain. Zero dialogue.)

[THUMBNAIL_PROMPT]
(High-CTR Zero-Text 3D Pixar Image Prompt, {aspect_ratio}, extreme close-up of Leo with massive shocked eyes, zero text)

[CHAPTER_1]
(Chapter 1 Hook: 4 sequential 10s prompts with Camera, Start Coordinates, Action, SFX Cues. 16:9.)

[CHAPTER_2]
(Chapter 2 Escalation: 4 sequential 10s prompts maintaining exact continuity from Chapter 1. 16:9.)

[CHAPTER_3]
(Chapter 3 Chaos: 4 sequential 10s prompts with mud/fruit physics. 16:9.)

[CHAPTER_4]
(Chapter 4 Climax: 4 sequential 10s prompts with grand satisfying finish and loop back. 16:9.)

[TITLE]
(1 High-CTR Viral Title with emojis using keywords from {tags_text})

[DESCRIPTION]
(SEO description + Chapter Timestamps 0:00, 2:15, 4:30, 6:45 + Mid-Roll Ad slots + CTA)

[TAGS]
(20 comma-separated tags prioritizing {tags_text})

[HASHTAGS]
(8 viral hashtags)
"""
    else:
        prompt = f"""
Act as Master Storyboard Director for 'FunzooKids' (30-Sec Fast Viral Short).
Theme: {theme}
Live Harvested Tags: {tags_text}
{dna_and_rules}

STEP 1: Write a tight 3-Beat Slapstick Script (Beat 1: Setup/Mistake -> Beat 2: Direct Blunder Reaction -> Beat 3: Climax & Loop).
STEP 2: Convert that script into 3 seamless 10-second Veo prompts in {aspect_ratio} format.

Use ONLY these exact markers:

[STORY_SCRIPT]
(Write the 3-beat script: 
Beat 1 (0-10s): Who does what mistake?
Beat 2 (10-20s): What direct physical reaction happens?
Beat 3 (20-30s): How does it resolve into a satisfying loop?)

[THUMBNAIL_PROMPT]
(High-CTR Zero-Text 3D Pixar Image Prompt, {aspect_ratio}, extreme close-up of shocked Leo and Froggo, zero text)

[SCENE_1]
(0-10s: 3D Pixar CGI, {aspect_ratio}, hyper-fast action: Starts with setup. Leo executes Beat 1. Camera locked. Ends on exact pose. SFX cues.)

[SCENE_2]
(10-20s: 3D Pixar CGI, {aspect_ratio}, hyper-fast action: Starts directly from Scene 1's end pose. Beat 2 execution. Fast tracking. Comical blunder. SFX cues.)

[SCENE_3]
(20-30s: 3D Pixar CGI, {aspect_ratio}, hyper-fast action: Starts from Scene 2's end. Beat 3 execution. Satisfying fruit/mud splash, Shelly sliding past safely, seamless reset to Scene 1. SFX cues.)

[TITLE]
(1 High-CTR Viral Title with emojis using keywords from {tags_text})

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
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, ["⚠️ Gemini API Generation Error."])
        return

    script = html.escape(extract_block(raw_text, "[STORY_SCRIPT]", "[THUMBNAIL_PROMPT]"))
    thumb = html.escape(extract_block(raw_text, "[THUMBNAIL_PROMPT]", "[CHAPTER_1]" if is_long_mode else "[SCENE_1]"))
    title = html.escape(extract_block(raw_text, "[TITLE]", "[DESCRIPTION]"))
    desc = html.escape(extract_block(raw_text, "[DESCRIPTION]", "[TAGS]"))
    tags = html.escape(extract_block(raw_text, "[TAGS]", "[HASHTAGS]"))
    hashtags = html.escape(extract_block(raw_text, "[HASHTAGS]"))

    header = (
        f"⚡ <b>FUNZOOKIDS SCRIPT-FIRST ENGINE</b>\n"
        f"🕒 <b>Alert Time:</b> {time_str}\n"
        f"⏰ <b>Target Upload Time:</b> <b>{upload_str}</b> (1 Hour Window)\n"
        f"🎯 <b>Format:</b> <b>{html.escape(aspect_ratio)}</b>\n"
        f"🌾 <b>Theme:</b> {html.escape(theme)}\n\n"
        f"📈 <b>FAST BREAKOUT US TRENDS:</b>\n{html.escape(trends_text)}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📜 <b>CORE STORY SCRIPT (Cause & Effect)</b>\n"
        f"<i>{script}</i>\n\n"
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
        
        part1 = header + f"🎬 <b>CHAPTER 1: HOOK & DISCOVERY</b>\n<code>{ch1}</code>\n\n\n"
        part2 = f"🎬 <b>CHAPTER 2: ESCALATION</b>\n<code>{ch2}</code>\n\n\n🎬 <b>CHAPTER 3: CHAOS & TRAP</b>\n<code>{ch3}</code>\n\n\n"
        part3 = f"🎬 <b>CHAPTER 4: CLIMAX & RESOLUTION</b>\n<code>{ch4}</code>\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 <b>TITLE</b>\n<code>{title}</code>\n\n📝 <b>DESCRIPTION</b>\n<code>{desc}</code>\n\n🏷️ <b>TAGS</b>\n<code>{tags}</code>\n\n#️⃣ <b>HASHTAGS</b>\n<code>{hashtags}</code>"
        
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, [part1, part2, part3])
    else:
        s1 = html.escape(extract_block(raw_text, "[SCENE_1]", "[SCENE_2]"))
        s2 = html.escape(extract_block(raw_text, "[SCENE_2]", "[SCENE_3]"))
        s3 = html.escape(extract_block(raw_text, "[SCENE_3]", "[TITLE]"))
        
        part1 = header + f"🎬 <b>SCENE 1 (0-10s Hook Setup)</b>\n<code>{s1}</code>\n\n\n🎬 <b>SCENE 2 (10-20s Reaction Blunder)</b>\n<code>{s2}</code>\n\n\n"
        part2 = f"🎬 <b>SCENE 3 (20-30s Climax & Loop)</b>\n<code>{s3}</code>\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 <b>TITLE</b>\n<code>{title}</code>\n\n📝 <b>DESCRIPTION</b>\n<code>{desc}</code>\n\n🏷️ <b>TAGS</b>\n<code>{tags}</code>\n\n#️⃣ <b>HASHTAGS</b>\n<code>{hashtags}</code>"
        
        send_telegram_in_chunks(TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, [part1, part2])

if __name__ == "__main__":
    weekday = datetime.now(timezone.utc).weekday()
    # सोमवार (0) और गुरुवार (3) को 10-मिनट लॉन्ग वीडियो मोड, बाकी दिन शॉर्ट्स
    is_long_mode = (weekday in [0, 3])

    trends, tags = scan_realtime_breakout_trends()
    theme, aspect_ratio, content = generate_production_package(is_long_mode, trends, tags)
    send_telegram_package(is_long_mode, trends, theme, aspect_ratio, content)
