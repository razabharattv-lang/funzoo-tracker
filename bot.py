import os
import random
import requests
import html
from datetime import datetime, timezone, timedelta
import google.generativeai as genai

# ==============================================================================
# 🔑 CREDENTIALS & CHANNEL BRIDGE
# ==============================================================================
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MY_CHANNEL_ID = os.getenv("MY_CHANNEL_ID", "") # नया चैनल बनते ही यहाँ ID डालना

ORGANIC_TREND_THEMES = [
    "ORGANIC HARVEST SPRINT: Sneaking into a giant ripe watermelon farm, rolling a 100kg juicy melon downhill with comical bouncy slips.",
    "BEE TREE & HONEY SLIDE: Reaching a glowing wild honeycomb on a mango branch using bendy banana leaves as bouncy trampolines.",
    "GIANT CHILLI SNEEZE: Leo nibbles a farm-fresh mega chilli, triggering comical steam puffs while Froggo jumps into a cool mud pit.",
    "MUDDY PADDY OBSTACLE RACE: Summer rain turns farmlands into a natural waterslide where Shelly drifts like a pro surfboard.",
    "PUMPKIN HARVEST CARS: Carving hollow farm pumpkins into roll-carts on a grassy hillside with funny vegetable obstacles."
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
            
            # Extract real-time tags
            for t in v.get("snippet", {}).get("tags", [])[:6]:
                if t.lower() not in [x.lower() for x in tags]:
                    tags.append(t)

        ranked.sort(key=lambda x: x[0], reverse=True)
        if not ranked:
            return fallback_trends()

        trend_lines = [f"⚡ {t}... ({v:,} views | 🚀 {vph:,}/hr)" for vph, v, t in ranked[:3]]
        # Pass harvested tags string
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
    theme = random.choice(ORGANIC_TREND_THEMES)

    character_dna = (
        "Using the attached image STRICTLY for character visual likeness (Leo, Froggo, Shelly), completely IGNORE the white studio background. Seamlessly integrate the characters into [Organically Lit Environment].\n"
        "- Leo: Fluffy baby leopard cub, curious amber eyes, golden fur with black rosettes.\n"
        "- Froggo: Chubby emerald-green tree frog, bulging comical eyes, super-stretchy pink tongue.\n"
        "- Shelly: Tiny calm baby turtle, polished metallic-blue shell that drifts like a turbo skateboard."
    )

    safety_rules = (
        "VEO SAFE RULES: Absolutely NO violence, NO realistic danger words (no hit, attack, weapon, blood).\n"
        "Use ONLY soft cartoon physics: squishy fruit splash, cartoon slip, bouncy roll, dizzy wobble.\n"
        "Style: 3D Pixar Disney CGI animation, 16:9 widescreen, 8K Octane render, bright sunlight, zero dialogue."
    )

    seo_instructions = (
        "CRITICAL SEO RULE: Algorithms change frequently. You MUST integrate the exact words from 'Live Harvested Tags' into your generated Title, Description, Tags, and Hashtags to match current real-time trends."
    )

    if is_long_mode:
        prompt = f"""
You are the Creative Director of 'FunzooKids' building an 8-10 Minute Watch-Time Magnet Episode.
Theme: {theme}
Breakout US Trends: {trends_text}
Live Harvested Tags: {tags_text}
{character_dna}
{safety_rules}
{seo_instructions}

Structure the story into 4 connected Organic Chapters.
Write concrete, Veo-safe 10-second prompt instructions.

Use ONLY these exact markers:

[THUMBNAIL_PROMPT]
(Zero-Text 3D Pixar Image Prompt: Extreme close-up of Leo's massive shocked eyes and Froggo with puffed cheeks staring at a glowing giant cracked watermelon on farmland. 16:9, ultra-vivid colors, 8K Octane Render, no text.)

[CHAPTER_1]
(Chapter 1: The Farmland Discovery - 4 sequential 10s prompts with Camera, Start Positions (Left/Right/Center), 0-3s, 3-7s, 7-10s timeline action, SFX Cues. Harmless slapstick, 16:9.)

[CHAPTER_2]
(Chapter 2: The Slippery Vegetable Chaos - 4 sequential 10s prompts with Camera, Start Positions, Action, SFX Cues. Harmless slapstick, 16:9.)

[CHAPTER_3]
(Chapter 3: The Mud Slide Escalation - 4 sequential 10s prompts with Camera, Start Positions, Action, SFX Cues. Harmless slapstick, 16:9.)

[CHAPTER_4]
(Chapter 4: The Grand Climax & Resolution - 4 sequential 10s prompts with Camera, Start Positions, Action, SFX Cues. Seamless loop reset, 16:9.)

[TITLE]
(1 High-CTR Viral Title for 10-Min Video with emojis. MUST use keywords from Live Harvested Tags.)

[DESCRIPTION]
(SEO description + naturally weave in Live Harvested Tags + Chapter Timestamps 0:00, 2:15, 4:30, 6:45 + Mid-Roll Ad slots + Not Made for Kids notice + Subscribe CTA)

[TAGS]
(20 comma-separated tags. Prioritize the exact keywords from Live Harvested Tags, followed by high-CPM keywords.)

[HASHTAGS]
(8 viral hashtags strictly derived from today's Live Harvested Tags and Theme.)
"""
    else:
        prompt = f"""
You are the Creative Director of 'FunzooKids' writing a 30-Second Viral Organic Short.
Theme: {theme}
Breakout US Trends: {trends_text}
Live Harvested Tags: {tags_text}
{character_dna}
{safety_rules}
{seo_instructions}

Write 3 strict, choreographed 10-second scene prompts for YouTube Veo.

Use ONLY these exact markers:

[THUMBNAIL_PROMPT]
(Zero-Text 3D Pixar Image Prompt: Extreme close-up of shocked Leo and Froggo covered in ripe fruit juice, massive expressive eyes, bright organic farm background, 16:9, zero text.)

[SCENE_1]
(0-10s Prompt: 3D Pixar Disney CGI animation, 16:9. Starting positions, farm setup, 0-3s visual hook, 3-7s slapstick action, 7-10s reaction, SFX cues. Zero dialogue.)

[SCENE_2]
(10-20s Prompt: 3D Pixar Disney CGI animation, 16:9. Escalating organic obstacle, Froggo tongue gag, Leo funny tumble on mud, SFX cues. Zero dialogue.)

[SCENE_3]
(20-30s Prompt: 3D Pixar Disney CGI animation, 16:9. Climax, satisfying soft fruit splash, Shelly sliding past safely on shell, seamless loop reset, SFX cues. Zero dialogue.)

[TITLE]
(1 High-CTR Viral Title with emojis. MUST use keywords from Live Harvested Tags.)

[DESCRIPTION]
(2-line SEO description weaving in Live Harvested Tags + General audience notice + Subscribe CTA)

[TAGS]
(15 comma-separated tags. Prioritize the exact keywords from Live Harvested Tags to beat current algorithms.)

[HASHTAGS]
(6 viral hashtags strictly derived from today's Live Harvested Tags and Theme.)
"""

    models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]
    for m in models:
        try:
            model = genai.GenerativeModel(m)
            res = model.generate_content(prompt)
            if res and res.text:
                return theme, res.text
        except Exception:
            continue
    return theme, ""

def send_telegram_package(is_long_mode, trends_text, theme, raw_text):
    ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    time_str = ist_now.strftime("%d %b %Y | %I:%M %p IST")
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"

    if not raw_text:
        return

    thumb = html.escape(extract_block(raw_text, "[THUMBNAIL_PROMPT]", "[CHAPTER_1]" if is_long_mode else "[SCENE_1]"))
    title = html.escape(extract_block(raw_text, "[TITLE]", "[DESCRIPTION]"))
    desc = html.escape(extract_block(raw_text, "[DESCRIPTION]", "[TAGS]"))
    tags = html.escape(extract_block(raw_text, "[TAGS]", "[HASHTAGS]"))
    hashtags = html.escape(extract_block(raw_text, "[HASHTAGS]"))

    header = (
        f"⚡ <b>FUNZOOKIDS REAL-TIME TREND RADAR</b>\n"
        f"🕒 <b>Delivered At:</b> {time_str}\n"
        f"🎯 <b>Mode:</b> {'[LONG WATCH-TIME MODE - 10 MIN]' if is_long_mode else '[DAILY SHORTS SPRINT - 30S]'}\n"
        f"🌙 <b>Veo Slot:</b> रात 12 से सुबह 6 बजे तक जनरेट करें\n"
        f"🌾 <b>Theme:</b> {html.escape(theme)}\n\n"
        f"📈 <b>FASTEST BREAKING US TRENDS:</b>\n{html.escape(trends_text)}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🖼️ <b>ZERO-TEXT 3D THUMBNAIL PROMPT (Tap to Copy)</b>\n"
        f"<code>{thumb}</code>\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
    )

    if is_long_mode:
        ch1 = html.escape(extract_block(raw_text, "[CHAPTER_1]", "[CHAPTER_2]"))
        ch2 = html.escape(extract_block(raw_text, "[CHAPTER_2]", "[CHAPTER_3]"))
        ch3 = html.escape(extract_block(raw_text, "[CHAPTER_3]", "[CHAPTER_4]"))
        ch4 = html.escape(extract_block(raw_text, "[CHAPTER_4]", "[TITLE]"))
        body = (
            f"🎬 <b>CHAPTER 1: THE DISCOVERY</b>\n<code>{ch1}</code>\n\n\n"
            f"🎬 <b>CHAPTER 2: SLIPPERY CHAOS</b>\n<code>{ch2}</code>\n\n\n"
            f"🎬 <b>CHAPTER 3: MUD & WATER ESCALATION</b>\n<code>{ch3}</code>\n\n\n"
            f"🎬 <b>CHAPTER 4: CLIMAX & WIN</b>\n<code>{ch4}</code>\n\n"
        )
    else:
        s1 = html.escape(extract_block(raw_text, "[SCENE_1]", "[SCENE_2]"))
        s2 = html.escape(extract_block(raw_text, "[SCENE_2]", "[SCENE_3]"))
        s3 = html.escape(extract_block(raw_text, "[SCENE_3]", "[TITLE]"))
        body = (
            f"🎬 <b>SCENE 1 (0-10s | Setup)</b>\n<code>{s1}</code>\n\n\n"
            f"🎬 <b>SCENE 2 (10-20s | Farmland Action)</b>\n<code>{s2}</code>\n\n\n"
            f"🎬 <b>SCENE 3 (20-30s | Climax & Loop)</b>\n<code>{s3}</code>\n\n"
        )

    footer = (
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📌 <b>TITLE</b>\n<code>{title}</code>\n\n\n"
        f"📝 <b>DESCRIPTION</b>\n<code>{desc}</code>\n\n\n"
        f"🏷️ <b>TAGS</b>\n<code>{tags}</code>\n\n\n"
        f"#️⃣ <b>HASHTAGS</b>\n<code>{hashtags}</code>"
    )

    for part in [header + body, footer]:
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": part, "parse_mode": "HTML"}
        res = requests.post(url, json=payload, timeout=25)
        if res.status_code != 200:
            payload.pop("parse_mode", None)
            requests.post(url, json=payload, timeout=25)

if __name__ == "__main__":
    now_utc = datetime.now(timezone.utc)
    # अगर रन होने का समय UTC 14:00 (रात 7:30 IST) के बाद है, तो यह लॉन्ग वीडियो मोड चलाएगा।
    is_long_mode = (now_utc.hour >= 14)

    trends, tags = scan_realtime_breakout_trends()
    theme, content = generate_production_package(is_long_mode, trends, tags)
    send_telegram_package(is_long_mode, trends, theme, content)
