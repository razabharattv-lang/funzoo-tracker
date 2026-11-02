import os
import requests
import google.generativeai as genai

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")


def fetch_viral_youtube_trends():
  url = f"https://www.googleapis.com/youtube/v3/search?part=snippet&q=3D+CGI+animated+cartoon+funny+slapstick+animals&type=video&order=viewCount&regionCode=US&maxResults=5&key={YOUTUBE_API_KEY}"
  try:
    res = requests.get(url).json()
    titles = [item["snippet"]["title"] for item in res.get("items", [])]
    return (
        "\n".join(titles)
        if titles
        else "Funny 3D CGI Animals Slapstick Comedy"
    )
  except Exception as e:
    print(f"YouTube Error: {e}")
    return "Funny 3D CGI Animals Slapstick Comedy"


def generate_funzoo_package(viral_trends):
  genai.configure(api_key=GEMINI_API_KEY)

  prompt = f"""
    You are the head viral strategist and animator for 'FunzooKids'.
    Characters:
    1. Leo: Playful fluffy baby leopard cub, big mischievous eyes.
    2. Froggo: Chubby green frog, elastic tongue, funny reactions.
    3. Shelly: Cute baby turtle with sturdy shell, lucky survivor.

    Style:
    - 3D CGI Pixar style, 16:9 Landscape.
    - Non-verbal Slapstick Comedy (Tom & Jerry, Larva style).
    - Duration: 20-30 seconds (split into three 10-second scenes).

    Live YouTube US Trends:
    {viral_trends}

    Format for Telegram:
    ⏰ **UPLOAD STRATEGY & PEAK HOURS**
    - Target Markets: USA / Europe / UAE
    - Best Upload Time Window (IST / EST)
    - Recommended Daily Frequency

    🔥 **3 HIGH CTR TITLES**
    🎣 **3-SECOND ATTENTION HOOK**
    
    🎬 **AI VIDEO PROMPTS (10s Each - 16:9)**
    - Scene 1 (0-10s):
    - Scene 2 (10-20s):
    - Scene 3 (20-30s):

    🏷️ **VIRAL TAGS & HASHTAGS**
    """
  # Google Cloud द्वारा सुझाया गया मॉडल
  model = genai.GenerativeModel("gemini-3.0-flash")
  response = model.generate_content(prompt)
  return response.text


def send_to_telegram(text):
  url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
  for chunk in [text[i : i + 3500] for i in range(0, len(text), 3500)]:
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": chunk}
    res = requests.post(url, json=payload)
    print("Telegram Response:", res.status_code, res.text)


if __name__ == "__main__":
  trends = fetch_viral_youtube_trends()
  package = generate_funzoo_package(trends)
  send_to_telegram(package)
