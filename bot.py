from datetime import datetime, timedelta, timezone
import html
import os
import random
import google.generativeai as genai
import requests

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

VIRAL_FORMULAS = [
    (
        "GIANT VS TINY TRAP: Giant rolling rainbow jawbreaker candy chasing"
        " characters down a steep highway into a sticky marshmallow pit"
    ),
    (
        "SATISFYING PHYSICS CHAOS: Overturned neon slime truck on a sunny road"
        " turning tires and characters into super-bouncy rubber balls"
    ),
    (
        "IMPOSSIBLE BRIDGE OBSTACLE: Crossing a narrow highway bridge covered"
        " in banana peels and spring-loaded boxing gloves"
    ),
    (
        "KARMA & GREED BACKFIRE: Fighting over a giant golden burger on a"
        " moving flatbed truck before hitting a low tunnel"
    ),
    (
        "CHAIN REACTION PILEUP: Rocket-powered shopping cart hitting a"
        " fireworks stand on a desert highway"
    ),
]

SEARCH_QUERIES = [
    "3D animation funny cartoon slapstick",
    "funny 3D animal cartoon shorts",
    "larva style funny 3D animation",
    "oddbods style 3D comedy cartoon",
]


def scan_viral_velocity():
  now_utc = datetime.now(timezone.utc)
  seven_days_ago = (
      (now_utc - timedelta(days=7)).isoformat("T").split(".")[0] + "Z"
  )
  query = random.choice(SEARCH_QUERIES)

  search_url = (
      "https://www.googleapis.com/youtube/v3/search"
      f"?part=snippet&q={requests.utils.quote(query)}"
      f"&type=video&order=viewCount&publishedAfter={seven_days_ago}"
      f"&regionCode=US&maxResults=5&key={YOUTUBE_API_KEY}"
  )

  try:
    res = requests.get(search_url, timeout=15).json()
    items = res.get("items", [])
    if not items:
      return (
          "🔥 3D Slapstick Animal Trap (US Viral)",
          "3d animation, funny cartoon, slapstick, cute animals",
      )

    v_ids = ",".join(
        [i["id"]["videoId"] for i in items if "videoId" in i.get("id", {})]
    )
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
      ranked_videos.append((vph, views, snip.get("title", "")[:45]))

      for t in snip.get("tags", [])[:5]:
        if t.lower() not in [x.lower() for x in harvested_tags]:
          harvested_tags.append(t)

    ranked_videos.sort(key=lambda x: x[0], reverse=True)
    trend_lines = [
        f"🔥 {title}... ({views:,} views | ⚡ {vph:,}/hr)"
        for vph, views, title in ranked_videos[:3]
    ]
    tags_str = (
        ", ".join(harvested_tags[:12])
        if harvested_tags
        else "3d animation, funny cartoon, slapstick comedy"
    )
    return "\n".join(trend_lines), tags_str

  except Exception as e:
    print(f"YouTube Scan Error: {e}")
    return (
        "🔥 3D Animal Highway Chase (US Trending)",
        "3d animation, funny cartoon, slapstick",
    )


def extract_part(text, start_marker, end_marker=None):
  if start_marker not in text:
    return ""
  sub = text.split(start_marker, 1)[1]
  if end_marker and end_marker in sub:
    sub = sub.split(end_marker, 1)[0]
  return sub.strip()


def build_career_package(trends_text, competitor_tags):
  genai.configure(api_key=GEMINI_API_KEY)
  formula = random.choice(VIRAL_FORMULAS)

  prompt = f"""
You are the Showrunner for 'FunzooKids' (3D Pixar CGI Slapstick Cartoon).
Today's Viral Formula: {formula}
Live US Trends: {trends_text}
Competitor Tags: {competitor_tags}

Characters (Include full visual traits inside EVERY scene prompt):
- Leo: cute fluffy baby leopard cub with big mischievous amber eyes and golden spotted fur.
- Froggo: chubby glossy green frog with giant bulging eyes and a super-stretchy pink tongue.
- Shelly: tiny cute baby turtle inside a shiny metallic-blue sturdy shell that drifts like a turbo skateboard.

Write the response using ONLY these exact markers (no markdown code blocks, keep each scene around 70 words):

[SCENE_1]
3D Pixar Disney CGI animation, 16:9 widescreen, 8K Octane Render. (Write Scene 1 0-10s prompt here with full visual traits of Leo, Froggo, Shelly, highway setup, 2-second hook, slapstick action, and Audio/SFX/BGM cues at the end. Zero dialogue.)

[SCENE_2]
3D Pixar Disney CGI animation, 16:9 widescreen, 8K Octane Render. (Write Scene 2 10-20s prompt here with full visual traits of Leo, Froggo, Shelly, high-speed road chaos, stretchy tongue backfire, and Audio/SFX/BGM cues at the end. Zero dialogue.)

[SCENE_3]
3D Pixar Disney CGI animation, 16:9 widescreen, 8K Octane Render. (Write Scene 3 20-30s prompt here with full visual traits of Leo, Froggo, Shelly, funny karma ending where Shelly glides past unbothered, loop reset, and Audio/SFX/BGM cues at the end. Zero dialogue.)

[TITLE]
(Write 1 punchy high-CTR viral YouTube title with emojis)

[DESCRIPTION]
(Write a 3-line SEO YouTube description + Not Made for Kids general audience slapstick notice + Subscribe CTA)

[TAGS]
(Write 20 comma-separated high-CPM YouTube tags)

[HASHTAGS]
(Write 8 viral hashtags separated by spaces)
"""

  models = [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
  ]
  try:
    for m in genai.list_models():
      if "generateContent" in m.supported_generation_methods:
        name = m.name.replace("models/", "")
        if name not in models:
          models.append(name)
  except Exception as e:
    print(f"List models note: {e}")

  for m_name in models:
    try:
      print(f"Trying model: {m_name}")
      model = genai.GenerativeModel(m_name)
      res = model.generate_content(prompt)
      if res and res.text:
        print(f"Success with {m_name}")
        return formula, res.text
    except Exception as e:
      print(f"Model {m_name} error: {e}")
      continue

  return formula, ""


def send_single_msg(text, use_html=True):
  url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
  payload = {"chat_id": TELEGRAM_CHAT_ID, "text": text}
  if use_html:
    payload["parse_mode"] = "HTML"
  res = requests.post(url, json=payload, timeout=20)
  print("Telegram Status:", res.status_code, res.text[:150])
  if res.status_code != 200 and use_html:
    payload.pop("parse_mode", None)
    requests.post(url, json=payload, timeout=20)


def send_to_telegram(trends_text, formula, raw_text):
  ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
  time_str = ist_now.strftime("%d %b %Y | %I:%M %p IST")

  if not raw_text:
    send_single_msg("⚠️ Gemini API Quota/Model Error.", use_html=False)
    return

  s1 = html.escape(extract_part(raw_text, "[SCENE_1]", "[SCENE_2]"))
  s2 = html.escape(extract_part(raw_text, "[SCENE_2]", "[SCENE_3]"))
  s3 = html.escape(extract_part(raw_text, "[SCENE_3]", "[TITLE]"))
  title = html.escape(extract_part(raw_text, "[TITLE]", "[DESCRIPTION]"))
  desc = html.escape(extract_part(raw_text, "[DESCRIPTION]", "[TAGS]"))
  tags = html.escape(extract_part(raw_text, "[TAGS]", "[HASHTAGS]"))
  hashtags = html.escape(extract_part(raw_text, "[HASHTAGS]"))

  # अगर किसी वजह से मार्कर न मिलें तो पूरा कच्चा टेक्स्ट सुरक्षित भेज दें
  if not s1:
    send_single_msg(raw_text[:3900], use_html=False)
    return

  trends_safe = html.escape(trends_text)
  formula_safe = html.escape(formula)

  msg = (
      f"🚀 <b>FUNZOOKIDS MONETIZATION ENGINE ({time_str})</b>\n"
      f"🎯 <b>Trigger:</b> {formula_safe}\n\n"
      f"📈 <b>LIVE US TRENDS (7 DAYS):</b>\n{trends_safe}\n"
      "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
      "🎬 <b>SCENE 1 (0 - 10s | Duration: 10s)</b>\n"
      f"<code>{s1}</code>\n\n\n"
      "🎬 <b>SCENE 2 (10 - 20s | Duration: 10s)</b>\n"
      f"<code>{s2}</code>\n\n\n"
      "🎬 <b>SCENE 3 (20 - 30s | Duration: 10s)</b>\n"
      f"<code>{s3}</code>\n\n"
      "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
      "📌 <b>TITLE (Tap to Copy)</b>\n"
      f"<code>{title}</code>\n\n\n"
      "📝 <b>DESCRIPTION (Tap to Copy)</b>\n"
      f"<code>{desc}</code>\n\n\n"
      "🏷️ <b>TAGS (Tap to Copy)</b>\n"
      f"<code>{tags}</code>\n\n\n"
      "#️⃣ <b>HASHTAGS (Tap to Copy)</b>\n"
      f"<code>{hashtags}</code>"
  )

  # अगर मैसेज 4000 अक्षरों से छोटा है तो एक साथ भेजें, वरना 2 साफ हिस्सों में भेजें
  if len(msg) <= 4000:
    send_single_msg(msg, use_html=True)
  else:
    part1 = msg.split("━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌")[0]
    part2 = (
        "📌" + msg.split("━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌")[1]
    )
    send_single_msg(part1, use_html=True)
    send_single_msg(part2, use_html=True)


if __name__ == "__main__":
  trends_text, live_tags = scan_viral_velocity()
  formula, raw_output = build_career_package(trends_text, live_tags)
  send_to_telegram(trends_text, formula, raw_output)
