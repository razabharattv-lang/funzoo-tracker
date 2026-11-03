from datetime import datetime, timedelta, timezone
import html
import json
import os
import random
import re
import google.generativeai as genai
import requests

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# हाई-रिटेंशन साइकोलॉजिकल ट्रिगर्स (US/UK ऑडियंस के लिए)
VIRAL_FORMULAS = [
    "GIANT VS TINY TRAP: Giant rolling rainbow jawbreaker candy chasing characters down a steep highway into a sticky marshmallow pit",
    "SATISFYING PHYSICS CHAOS: Overturned neon slime truck on a sunny road turning tires and characters into super-bouncy rubber balls",
    "IMPOSSIBLE BRIDGE OBSTACLE: Crossing a narrow highway bridge covered in banana peels and spring-loaded boxing gloves",
    "KARMA & GREED BACKFIRE: Fighting over a giant golden burger on a moving flatbed truck before hitting a low tunnel",
    "CHAIN REACTION PILEUP: Rocket-powered shopping cart hitting a fireworks stand on a desert highway",
    "FREEZE & MELT GIMMICK: Liquid nitrogen ice-cream tanker freezing the highway into a high-speed skating rink",
]

SEARCH_QUERIES = [
    "3D animation funny cartoon slapstick",
    "funny 3D animal cartoon shorts",
    "larva style funny 3D animation",
    "oddbods style 3D comedy cartoon",
    "non verbal funny cartoon 3D",
]


def scan_viral_velocity():
  """पिछले 7 दिनों में सबसे तेज़ रफ़्तार (Views Per Hour) पकड़ने वाले ट्रेंड्स निकालना"""
  now_utc = datetime.now(timezone.utc)
  seven_days_ago = (now_utc - timedelta(days=7)).isoformat("T").split(".")[0] + "Z"
  query = random.choice(SEARCH_QUERIES)

  search_url = (
      "https://www.googleapis.com/youtube/v3/search"
      f"?part=snippet&q={requests.utils.quote(query)}"
      f"&type=video&order=viewCount&publishedAfter={seven_days_ago}"
      f"&regionCode=US&maxResults=6&key={YOUTUBE_API_KEY}"
  )

  try:
    res = requests.get(search_url, timeout=15).json()
    items = res.get("items", [])
    if not items:
      return "• High-Speed 3D Slapstick Animal Trap (US Viral)", "3d animation, funny cartoon, slapstick, cute animals"

    v_ids = ",".join([i["id"]["videoId"] for i in items if "videoId" in i.get("id", {})])
    stats_url = f"https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id={v_ids}&key={YOUTUBE_API_KEY}"
    stats_res = requests.get(stats_url, timeout=15).json()

    ranked_videos, harvested_tags = [], []
    for v in stats_res.get("items", []):
      snip = v.get("snippet", {})
      stat = v.get("statistics", {})
      views = int(stat.get("viewCount", 0))
      pub = snip.get("publishedAt", "")

      hours = 24.0
      if pub:
        try:
          pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
          hours = max((now_utc - pub_dt).total_seconds() / 3600.0, 1.0)
        except Exception:
          pass

      vph = int(views / hours)
      ranked_videos.append((vph, views, snip.get("title", "")[:50]))

      for t in snip.get("tags", [])[:5]:
        if t.lower() not in [x.lower() for x in harvested_tags]:
          harvested_tags.append(t)

    ranked_videos.sort(key=lambda x: x[0], reverse=True)
    trend_lines = [f"🔥 {title}... ({views:,} views | ⚡ {vph:,}/hr)" for vph, views, title in ranked_videos[:3]]
    tags_str = ", ".join(harvested_tags[:14]) if harvested_tags else "3d animation, funny cartoon, slapstick comedy"
    return "\n".join(trend_lines), tags_str

  except Exception as e:
    print(f"Scan error: {e}")
    return "🔥 3D Animal Highway Trap (US Trending)", "3d animation, funny cartoon, slapstick"


def build_career_package(trends_text, competitor_tags):
  genai.configure(api_key=GEMINI_API_KEY)
  formula = random.choice(VIRAL_FORMULAS)

  prompt = f"""
You are a top YouTube Showrunner building 'FunzooKids' to monetize in 5 months in USA/Europe.
Viral Trigger Formula Today: {formula}
Live Fast-Growing US Videos: {trends_text}
Harvested Tags: {competitor_tags}

Characters (Write full visual traits inside EVERY scene prompt):
- Leo: cute fluffy baby leopard cub with big mischievous amber eyes and golden spotted fur.
- Froggo: chubby glossy green frog with giant bulging eyes and a super-stretchy pink tongue.
- Shelly: tiny cute baby turtle inside a shiny metallic-blue sturdy shell that drifts like a turbo skateboard.

Return ONLY valid JSON with these exact keys (no markdown formatting):
{{
  "scene1": "All-in-one 3D CGI prompt for 0-10s (16:9, 8K Pixar Octane Render). Full visual traits of Leo, Froggo, Shelly + road setting + instant 2-second visual shock hook + slapstick trigger + exact Audio/SFX/BGM cues at the end. Zero dialogue.",
  "scene2": "All-in-one 3D CGI prompt for 10-20s (16:9, 8K Pixar Octane Render). Full visual traits of Leo, Froggo, Shelly + escalating highway chaos + Froggo stretchy tongue backfire + exaggerated cartoon physics + exact Audio/SFX/BGM cues at the end. Zero dialogue.",
  "scene3": "All-in-one 3D CGI prompt for 20-30s (16:9, 8K Pixar Octane Render). Full visual traits of Leo, Froggo, Shelly + hilarious karma climax where Leo and Froggo get stuck in a funny mess while Shelly glides past like a boss + seamless loop ending + exact Audio/SFX/BGM cues at the end. Zero dialogue.",
  "title": "1 high-CTR viral YouTube title (max 55 chars) with emojis for US/UK audience",
  "description": "Ready-to-paste SEO description (2-line hook, Not Made for Kids general audience slapstick notice, subscribe CTA)",
  "tags": "20 high-CPM comma-separated YouTube tags mixing harvested competitor tags and viral 3D animation keywords",
  "hashtags": "8 viral hashtags separated by spaces"
}}
"""

  models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]
  try:
    for m in genai.list_models():
      if "generateContent" in m.supported_generation_methods:
        name = m.name.replace("models/", "")
        if name not in models:
          models.append(name)
  except Exception:
    pass

  for m_name in models:
    try:
      model = genai.GenerativeModel(m_name)
      res = model.generate_content(prompt)
      if res and res.text:
        cleaned = re.sub(r"^```json\s*|\s*```$", "", res.text.strip())
        return formula, json.loads(cleaned)
    except Exception as e:
      print(f"Model {m_name} error: {e}")
      continue

  return formula, None


def send_to_telegram(trends_text, formula, data):
  ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
  time_str = ist_now.strftime("%d %b %Y | %I:%M %p IST")

  if not data:
    return

  s1 = html.escape(data.get("scene1", ""))
  s2 = html.escape(data.get("scene2", ""))
  s3 = html.escape(data.get("scene3", ""))
  title = html.escape(data.get("title", ""))
  desc = html.escape(data.get("description", ""))
  tags = html.escape(data.get("tags", ""))
  hashtags = html.escape(data.get("hashtags", ""))
  trends_safe = html.escape(trends_text)
  formula_safe = html.escape(formula)

  msg = (
      f"🚀 <b>FUNZOOKIDS MONETIZATION ENGINE ({time_str})</b>\n"
      f"🎯 <b>Viral Trigger:</b> {formula_safe}\n\n"
      f"📈 <b>FASTEST GROWING US TRENDS (7 DAYS):</b>\n{trends_safe}\n"
      f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
      f"🎬 <b>SCENE 1 (0 - 10 Seconds | Duration: 10s)</b>\n"
      f"<code>{s1}</code>\n\n\n"
      f"🎬 <b>SCENE 2 (10 - 20 Seconds | Duration: 10s)</b>\n"
      f"<code>{s2}</code>\n\n\n"
      f"🎬 <b>SCENE 3 (20 - 30 Seconds | Duration: 10s)</b>\n"
      f"<code>{s3}</code>\n\n"
      f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
      f"📌 <b>TITLE (Tap to Copy)</b>\n"
      f"<code>{title}</code>\n\n\n"
      f"📝 <b>DESCRIPTION (Tap to Copy)</b>\n"
      f"<code>{desc}</code>\n\n\n"
      f"🏷️ <b>TAGS (Tap to Copy)</b>\n"
      f"<code>{tags}</code>\n\n\n"
      f"#️⃣ <b>HASHTAGS (Tap to Copy)</b>\n"
      f"<code>{hashtags}</code>"
  )

  url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
  payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "HTML"}
  res = requests.post(url, json=payload, timeout=20)
  if res.status_code != 200:
    payload.pop("parse_mode", None)
    requests.post(url, json=payload, timeout=20)


if __name__ == "__main__":
  trends_text, live_tags = scan_viral_velocity()
  formula, pkg = build_career_package(trends_text, live_tags)
  send_to_telegram(trends_text, formula, pkg)
