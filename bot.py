import os
import requests
from flask import Flask, request

app = Flask(__name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "").strip()
RENDER_URL = os.getenv("RENDER_EXTERNAL_URL", "").strip()

TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
REPO_DISPATCH_URL = "https://api.github.com/repos/razabharattv-lang/funzoo-tracker/actions/workflows/scheduler.yml/dispatches"
PROCESSED_UPDATES = set()

@app.route("/", methods=["GET"])
def home():
    if RENDER_URL and TELEGRAM_BOT_TOKEN:
        requests.get(f"{TG_API}/setWebhook", params={"url": f"{RENDER_URL}/webhook"}, timeout=10)
    return "FunzooKids Instant Relay is Live!", 200

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
        chat_id = str(msg.get("chat", {}).get("id") or TELEGRAM_CHAT_ID)
        file_id = video_obj["file_id"]
        hint = msg.get("caption", "")

        res = requests.post(
            f"{TG_API}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": "⚡ <b>FUNZOOKIDS 7GB CLOUD PRO</b>\n\n<code>[█░░░░░░░░░] 10%</code>\n🚀 Video received! Launching 7GB Cloud Server...",
                "parse_mode": "HTML"
            },
            timeout=15
        ).json()
        status_msg_id = str(res.get("result", {}).get("message_id", ""))

        disp = requests.post(
            REPO_DISPATCH_URL,
            headers={
                "Authorization": f"Bearer {GITHUB_TOKEN}",
                "Accept": "application/vnd.github+json"
            },
            json={
                "ref": "main",
                "inputs": {
                    "file_id": file_id,
                    "chat_id": chat_id,
                    "caption": hint,
                    "status_msg_id": status_msg_id
                }
            },
            timeout=15
        )
        if disp.status_code not in (200, 204):
            requests.post(
                f"{TG_API}/editMessageText",
                json={
                    "chat_id": chat_id,
                    "message_id": int(status_msg_id),
                    "text": f"❌ GitHub Trigger Error ({disp.status_code}): {disp.text[:200]}"
                },
                timeout=15
            )

    return "OK", 200

if RENDER_URL and TELEGRAM_BOT_TOKEN:
    try:
        requests.get(f"{TG_API}/setWebhook", params={"url": f"{RENDER_URL}/webhook"}, timeout=10)
    except Exception:
        pass

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
