from datetime import datetime, timedelta, timezone
import os
import random
import google.generativeai as genai
import requests

# ==============================================================================
# 🔑 ENVIRONMENT CREDENTIALS
# ==============================================================================
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# ==============================================================================
# 🧬 CHARACTER VISUAL DNA (100% CONSISTENCY LOCK FOR AI GENERATORS)
# ==============================================================================
CHARACTER_DNA = """
1. LEO (The Instigator): Cute, fluffy baby leopard cub, oversized mischievous glowing amber eyes, soft golden-yellow fur with dark rosette spots, expressive twitching ears, hyperactive cartoon energy.
2. FROGGO (The Elastic Chaos): Chubby, glossy bright-green tree frog, giant bulging comical eyes, round plump belly, super-stretchy neon-pink tongue that acts like a grappling hook or slingshot.
3. SHELLY (The Unbothered Boss): Tiny adorable baby turtle with big calm eyes, tucked inside a polished metallic-blue ultra-sturdy shell that slides, drifts, and ricochets like a turbo bowling ball.
"""

# ==============================================================================
# 🛣️ DYNAMIC ROAD ADVENTURE MATRIX (INFINITE VIRAL COMBINATIONS)
# ==============================================================================
ROAD_LOCATIONS = [
    "Sun-drenched Route 66 Desert Highway with giant cactus mirages",
    "Steep San Francisco-style downhill city street with cable car tracks",
    "Winding Alpine mountain highway with wooden guardrails and snowy peaks",
    "Busy neon-lit coastal boardwalk highway next to a sunny beach",
    "Freshly paved wet-asphalt highway construction zone with orange cones",
    "Golden Gate style suspension bridge with strong cartoon wind gusts",
    "Countryside highway crossing an old runaway miniature train track",
]

SLAPSTICK_VEHICLES_AND_PROPS = [
    "a runaway pastel-pink Ice Cream Truck dropping giant melting scoops",
    "an overturned Banana Delivery Truck spilling 10,000 ultra-slippery peels",
    "a red DIY Rocket-Powered Skateboard strapped to fireworks",
    "a giant bouncing pink Bubblegum Tanker leaking sticky inflating goo",
    "a turbo-charged Supermarket Shopping Cart with wobbly wheels",
    "an industrial Magnet Truck pulling metallic road signs and tin cans",
    "a spring-loaded Hotdog Cart shooting mustard and ketchup slicks",
    "a giant rolling Donut sign detached from a roadside diner roof",
]

COMEDY_TWISTS = [
    "gravity-defying boomerang tongue backfire",
    "chain-reaction domino pileup of cartoon props",
    "inflating balloon body physics after swallowing a fizzy prop",
    "extreme slow-motion mid-air facial expressions before a comedic splat",
    "high-speed pinball ricochet between highway guardrails",
]

SEARCH_QUERIES = [
    "3D CGI animation funny slapstick cartoon",
    "funny 3D animal cartoon chase",
    "Pixar style funny animated short comedy",
    "non verbal slapstick cartoon 3D",
    "funny cartoon compilation 3D animation",
    "cute 3D animal funny animation",
]

TIER_1_REGIONS = ["US", "GB", "CA"]


# ==============================================================================
# 📡 MODULE 1: DEEP YOUTUBE ALGORITHM & VPH (VIEWS PER HOUR) RADAR
# ==============================================================================
def fetch_deep_youtube_intelligence():
  """YouTube Tier-1 मार्केट से ताज़ा वीडियो, उनकी प्रति घंटा रफ्तार (VPH) और उनके असली Tags निकालना"""
  now_utc = datetime.now(timezone.utc)
  days_ago = (
      (now_utc - timedelta(days=10)).isoformat("T").split(".")[0] + "Z"
  )
  chosen_query = random.choice(SEARCH_QUERIES)
  chosen_region = random.choice(TIER_1_REGIONS)

  search_url = (
      "https://www.googleapis.com/youtube/v3/search"
      "?part=snippet"
      f"&q={requests.utils.quote(chosen_query)}"
      "&type=video"
      "&order=viewCount"
      f"&publishedAfter={days_ago}"
      f"&regionCode={chosen_region}"
      "&maxResults=8"
      f"&key={YOUTUBE_API_KEY}"
  )

  try:
    res = requests.get(search_url, timeout=15).json()
    items = res.get("items", [])
    if not items:
      return (
          "• High-Speed 3D Slapstick Animal Chase (US Trending)\n• Non-Verbal"
          " Pixar Style Road Comedy",
          "3d animation, funny cartoon, slapstick comedy, cute animals, pixar"
          " style, cartoon chase, non verbal comedy",
          chosen_region,
      )

    video_ids = ",".join(
        [
            item["id"]["videoId"]
            for item in items
            if "videoId" in item.get("id", {})
        ]
    )

    stats_url = (
        "https://www.googleapis.com/youtube/v3/videos"
        "?part=statistics,snippet"
        f"&id={video_ids}"
        f"&key={YOUTUBE_API_KEY}"
    )
    stats_res = requests.get(stats_url, timeout=15).json()

    video_metrics = []
    harvested_tags = []

    for v in stats_res.get("items", []):
      snippet = v.get("snippet", {})
      stats = v.get("statistics", {})

      title = snippet.get("title", "Untitled")
      views = int(stats.get("viewCount", 0))
      likes = int(stats.get("likeCount", 0))
      published_str = snippet.get("publishedAt", "")

      # असली Competitor Tags निकालना
      v_tags = snippet.get("tags", [])
      for t in v_tags[:6]:
        if t.lower() not in [ht.lower() for ht in harvested_tags]:
          harvested_tags.append(t)

      # Views Per Hour (VPH) की गणना
      hours_alive = 24.0
      if published_str:
        try:
          pub_dt = datetime.fromisoformat(
              published_str.replace("Z", "+00:00")
          )
          diff_hours = (now_utc - pub_dt).total_seconds() / 3600.0
          hours_alive = max(diff_hours, 1.0)
        except Exception:
          hours_alive = 24.0

      vph = int(views / hours_alive)
      video_metrics.append(
          {"title": title, "views": views, "likes": likes, "vph": vph}
      )

    # सबसे तेज़ वायरल होने वाली वीडियो (Highest VPH) को सबसे ऊपर रखना
    video_metrics.sort(key=lambda x: x["vph"], reverse=True)

    trends_lines = []
    for vm in video_metrics[:5]:
      trends_lines.append(
          f"🔥 {vm['title']}\n   ↳ 👁️ {vm['views']:,} views | ⚡ {vm['vph']:,}"
          f" Views/Hr | 👍 {vm['likes']:,}"
      )

    tags_str = (
        ", ".join(harvested_tags[:18])
        if harvested_tags
        else (
            "3d animation, funny cartoon, slapstick, animal chase, larva"
            " style, oddbods style, highway comedy"
        )
    )

    return "\n".join(trends_lines), tags_str, chosen_region

  except Exception as e:
    print(f"YouTube Intelligence Error: {e}")
    return (
        "🔥 3D CGI Animal Highway Chase (Viral US)\n🔥 Funny Non-Verbal"
        " Slapstick Compilation",
        "3d animation, funny cartoon, slapstick comedy, cute animals, road"
        " chase, family friendly animation",
        "US",
    )


# ==============================================================================
# 🧠 MODULE 2: MASTER SHOWRUNNER & 30-DAY GROWTH ENGINE (GEMINI AI)
# ==============================================================================
def generate_funzoo_master_package(trends_report, competitor_tags, region):
  genai.configure(api_key=GEMINI_API_KEY)

  location = random.choice(ROAD_LOCATIONS)
  prop = random.choice(SLAPSTICK_VEHICLES_AND_PROPS)
  twist = random.choice(COMEDY_TWISTS)
  episode_concept = f"Location: {location} | Chaos Prop: {prop} | Slapstick Twist: {twist}"

  prompt = f"""
You are the Chief YouTube Growth Strategist & Lead 3D Pixar Prompt Director for 'FunzooKids'.
Your goal is to rank this channel in Tier-1 countries (USA, UK, Europe, UAE) within 30 days with high-RPM 'Not Made for Kids' general-audience slapstick animation (like Larva, Oddbods, Grizzy & the Lemmings, Tom & Jerry).

==================================================
📊 LIVE YOUTUBE {region} COMPETITOR DATA SCANNED RIGHT NOW:
{trends_report}

🕵️ REAL COMPETITOR TAGS HARVESTED FROM YOUTUBE API:
{competitor_tags}

🎬 TODAY'S GENERATED ROAD ADVENTURE CONCEPT:
{episode_concept}

🧬 MANDATORY CHARACTER DNA (NEVER CHANGE THESE VISUALS):
{CHARACTER_DNA}
==================================================

CRITICAL PROMPT ENGINEERING RULE:
AI Video Generators (Kling AI, Hailuo MiniMax, Luma Dream Machine, Runway Gen-3, Google Veo) have ZERO memory between scenes.
Therefore, inside EVERY SINGLE IMAGE & VIDEO PROMPT below, you MUST explicitly write out the full physical appearance of Leo, Froggo, and Shelly. Never just write "Leo", always write "Leo, a cute fluffy baby leopard cub with big mischievous amber eyes and golden spotted fur".

Produce the complete production package in this EXACT format for easy mobile copy-pasting:

====================================
🎯 1. 5 VIRAL TITLES (A/B TEST MATRIX FOR HIGH CTR)
====================================
- [Curiosity Hook Title]: (Make viewers wonder what happens next + emojis)
- [High-Speed Chaos Title]: (Action-packed road blunder + emojis)
- [Character Versus Title]: (Leo vs Froggo vs Shelly dynamic + emojis)
- [Short Punchy Title]: (3-4 words maximum for Shorts/Reels feed + emojis)
- [8-Min Mega Compilation Title]: (For stitching this into the weekly long-form video)

====================================
🖼️ 2. A/B THUMBNAIL BLUEPRINT (2 HIGH-CTR OPTIONS)
====================================
🔹 THUMBNAIL OPTION A (Extreme Emotion Close-Up):
- Visual Psychology: (Why this makes US/UK viewers click in 0.5 seconds)
- 3D Image Generator Prompt (16:9): (Write a detailed 60-word 3D Pixar Octane Render prompt with extreme close-up facial expressions, highway background, vibrant contrast, zero text)

🔹 THUMBNAIL OPTION B (Mid-Air Highway Impact Gag):
- Visual Psychology: (Why this triggers curiosity gap)
- 3D Image Generator Prompt (16:9): (Write a detailed 60-word 3D Pixar Octane Render prompt showing the exact moment of road chaos with Leo, Froggo, and Shelly)

====================================
📝 3. SEO-BOOSTED YOUTUBE DESCRIPTION (COPY-PASTE READY)
====================================
(Write a high-retention description including:
- 3-line exciting story hook
- Episode & Compilation Timestamps (0:00 Hook, 0:10 Road Chaos, etc.)
- Clear notice: "FunzooKids is a 3D CGI non-verbal slapstick comedy series for general audiences and animation lovers worldwide."
- Subscribe CTA & SEO keyword block)

====================================
🏷️ 4. HIGH-CPM TAGS & HASHTAGS (COPY-PASTE BLOCK)
====================================
🔹 25 YouTube Tags (Comma-separated, blending harvested competitor tags + high-RPM US animation keywords):
[Write strictly comma-separated tags]

🔹 10 Viral Hashtags:
[Write 10 hashtags on one line]

====================================
🎬 5. 4-SCENE 3D PRODUCTION PIPELINE (30-40s + SEAMLESS LOOP)
====================================

▶️ SCENE 1 (0-8s): THE 3-SECOND SCROLL-STOPPER HOOK
- 🖼️ First-Frame 3D Image Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen, 8K Octane Render, [full visual description of Leo, Froggo, Shelly], [highway setting & prop setup], ultra-sharp focus, vibrant ray-traced lighting."
- 🎥 AI Video Motion Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen. [Full visual description of Leo, Froggo, Shelly]. [Exact camera movement + fast slapstick trigger action in the first 3 seconds]. Expressive cartoon physics, zero dialogue."
- 🚫 Negative Prompt: "text, watermark, blurry, deformed limbs, extra fingers, bad anatomy, 2D flat, dark lighting, talking mouth"

▶️ SCENE 2 (8-18s): HIGH-SPEED HIGHWAY ESCALATION
- 🖼️ First-Frame 3D Image Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen, 8K Octane Render, [full visual description of Leo, Froggo, Shelly], [mid-chase highway chaos], dynamic low-angle shot."
- 🎥 AI Video Motion Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen, high-speed tracking camera with motion blur. [Full visual description of Leo, Froggo, Shelly]. [Froggo's stretchy pink tongue gag + prop backfire + Leo's hilarious panic]. Zero dialogue."
- 🚫 Negative Prompt: "text, watermark, blurry, deformed limbs, slow motion, static camera, 2D cartoon"

▶️ SCENE 3 (18-28s): THE CLIMAX COLLISION & SHELLY'S BOSS MOVE
- 🖼️ First-Frame 3D Image Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen, 8K Octane Render, [full visual description of Leo, Froggo, Shelly], [hilarious cartoon splat/mess while Shelly's metallic-blue shell gleams]."
- 🎥 AI Video Motion Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen, dramatic wide-to-close-up camera pan. [Full visual description of Leo, Froggo, Shelly]. [Leo and Froggo caught in a funny cartoon mess while Shelly smoothly drifts past inside the shiny metallic-blue shell like a pro skateboarder]. Zero dialogue."
- 🚫 Negative Prompt: "text, watermark, realistic gore, dark shadows, deformed faces, morphing bodies"

▶️ SCENE 4 (28-35s): THE SEAMLESS LOOP & COMPILATION BRIDGE
- 🖼️ First-Frame 3D Image Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen, 8K Octane Render, [full visual description of Leo, Froggo, Shelly resetting on the highway as a new giant shadow/prop approaches]."
- 🎥 AI Video Motion Prompt (16:9): "3D Pixar Disney CGI animation style, 16:9 widescreen. [Full visual description of Leo, Froggo, Shelly]. [Visual gag that visually connects back to Scene 1 for an infinite Short loop, AND acts as a cliffhanger bridge for the 8-minute compilation]. Zero dialogue."

====================================
💰 6. SOUND DESIGN & 8-MINUTE HIGH-RPM COMPILATION BLUEPRINT
====================================
- 🔊 Scene-by-Scene SFX Cues: (Exact cartoon sound effects to add in CapCut/VN Editor for 0-8s, 8-18s, 18-28s, 28-35s)
- ⏱️ 8-Minute Mid-Roll Ad Placement Map: (Exact timestamps to place YouTube Mid-Roll Ads when combining 14 episodes into an 8:30 video for maximum US/UK AdSense revenue)
- 📈 Today's Best Upload Window: (Exact IST time corresponding to US EST & UK GMT peak viewing hours)
"""

  # प्रमाणित और चालू मॉडल्स की प्राथमिकता सूची
  candidate_models = [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
  ]

  try:
    available = [
        m.name.replace("models/", "")
        for m in genai.list_models()
        if "generateContent" in m.supported_generation_methods
    ]
    for m in available:
      if m not in candidate_models:
        candidate_models.append(m)
  except Exception as e:
    print(f"Model discovery note: {e}")

  for model_name in candidate_models:
    try:
      print(f"Generating master package with model: {model_name}")
      model = genai.GenerativeModel(model_name)
      res = model.generate_content(prompt)
      if res and res.text:
        return episode_concept, res.text
    except Exception as e:
      print(f"Model {model_name} failed: {e}")
      continue

  return (
      episode_concept,
      "⚠️ Gemini API generation failed. Please check API quota.",
  )


# ==============================================================================
# 📲 MODULE 3: SMART LINE-AWARE TELEGRAM SENDER (NO BROKEN PROMPTS)
# ==============================================================================
def split_message_smartly(text, max_length=3700):
  """मैसेज को कभी भी शब्द या लाइन के बीच से नहीं काटेगा, हमेशा पैराग्राफ/लाइन के अंत से बांटेगा"""
  lines = text.split("\n")
  chunks = []
  current_chunk = ""

  for line in lines:
    if len(current_chunk) + len(line) + 1 <= max_length:
      current_chunk += line + "\n"
    else:
      if current_chunk:
        chunks.append(current_chunk.strip())
      # अगर कोई एक लाइन ही 3700 से बड़ी हो
      if len(line) > max_length:
        for i in range(0, len(line), max_length):
          chunks.append(line[i : i + max_length])
        current_chunk = ""
      else:
        current_chunk = line + "\n"

  if current_chunk.strip():
    chunks.append(current_chunk.strip())

  return chunks


def send_to_telegram(trends_report, competitor_tags, region, concept, package):
  ist_now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
  time_str = ist_now.strftime("%d %b %Y | %I:%M %p IST")

  header = (
      "🚀 FUNZOOKIDS STUDIO ENGINE v3.0 (30-DAY RANKING MODE)\n"
      f"🕒 Live Scan Time: {time_str}\n"
      f"🌍 Target Market Scanned: Tier-1 ({region})\n"
      f"🎬 Episode Matrix: {concept}\n\n"
      "📈 LIVE VIRAL VELOCITY (VIEWS PER HOUR):\n"
      f"{trends_report}\n\n"
      "🕵️ HARVESTED COMPETITOR TAGS:\n"
      f"{competitor_tags}\n"
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
  )

  full_text = header + package
  url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"

  chunks = split_message_smartly(full_text, max_length=3700)
  total = len(chunks)

  for idx, chunk in enumerate(chunks, start=1):
    part_header = f"📦 [Part {idx}/{total}]\n\n" if total > 1 else ""
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": part_header + chunk,
    }
    res = requests.post(url, json=payload, timeout=20)
    print(f"Telegram Part {idx}/{total} Status:", res.status_code)


if __name__ == "__main__":
  trends_report, competitor_tags, region = fetch_deep_youtube_intelligence()
  concept, master_package = generate_funzoo_master_package(
      trends_report, competitor_tags, region
  )
  send_to_telegram(
      trends_report, competitor_tags, region, concept, master_package
  )
