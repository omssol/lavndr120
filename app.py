from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
import os, json, secrets, time
import requests as req

app = Flask(__name__)
CORS(app, origins=["https://omssol.github.io"])

CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
REDIRECT_URI  = "https://lavndr120.onrender.com/auth/callback"
GITHUB_APP    = "https://omssol.github.io/lavndr120-dashboard"
GAS_URL       = "https://script.google.com/macros/s/AKfycbzpggTIClMR6rjlIDhUIbM6fBA1AjZwcvtFXbykQYSkkEDJz1NxhRbm1CZczc1WgcE08g/exec"
GAS_KEY       = "LAVNDR_SECRET_KEY_2026"
RENDER_SECRET = os.environ.get("RENDER_SECRET", "LAVNDR_RENDER_SECRET_2026")
TOKEN_TTL     = 900

sessions = {}
participant_tokens = {}

def clean_sessions():
    now = time.time()
    for t in [k for k,v in sessions.items() if v["expires"] < now]:
        del sessions[t]

def verify_token(token):
    if not token: return None
    s = sessions.get(token)
    if not s or s["expires"] < time.time(): return None
    s["expires"] = time.time() + TOKEN_TTL
    return s["email"]

try:
    import firebase_admin
    from firebase_admin import credentials, messaging
    cred_json = os.environ.get("FIREBASE_CREDENTIALS")
    if cred_json:
        cred = credentials.Certificate(json.loads(cred_json))
        firebase_admin.initialize_app(cred)
    FIREBASE_OK = True
except:
    FIREBASE_OK = False

@app.route("/auth/login")
def auth_login():
    url = (
        "https://accounts.google.com/o/oauth2/v2/auth"
        "?client_id=" + CLIENT_ID +
        "&redirect_uri=" + REDIRECT_URI +
        "&response_type=code"
        "&scope=openid%20email"
        "&prompt=select_account"
    )
    return redirect(url)

@app.route("/auth/callback")
def auth_callback():
    code = request.args.get("code")
    if not code:
        return redirect(GITHUB_APP + "?denied=1")
    token_res = req.post("https://oauth2.googleapis.com/token", data={
        "code": code,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code"
    })
    if token_res.status_code != 200:
        return redirect(GITHUB_APP + "?denied=1")
    id_token = token_res.json().get("id_token", "")
    user_res = req.get("https://www.googleapis.com/oauth2/v3/tokeninfo",
                       params={"id_token": id_token})
    if user_res.status_code != 200:
        return redirect(GITHUB_APP + "?denied=1")
    email = user_res.json().get("email", "").lower()
    if not email:
        return redirect(GITHUB_APP + "?denied=1")
    try:
        gas_res = req.get(GAS_URL, params={"key": GAS_KEY, "action": "checkauth", "email": email}, timeout=30)
        print(f"GAS checkauth status: {gas_res.status_code}")
        print(f"GAS checkauth response: {gas_res.text[:200]}")
        gas_text = gas_res.text.strip()
        if not gas_text or gas_text.startswith("<"):
            print("GAS returned HTML — retrying")
            return redirect(GITHUB_APP + "?denied=1")
        gas_data = gas_res.json()
        print(f"GAS authorized: {gas_data.get('authorized')}")
        if not gas_data.get("authorized"):
            return redirect(GITHUB_APP + "?denied=1")
    except Exception as ex:
        print(f"GAS checkauth error: {ex}")
        return redirect(GITHUB_APP + "?denied=1")
    clean_sessions()
    token = secrets.token_urlsafe(32)
    sessions[token] = {"email": email, "expires": time.time() + TOKEN_TTL}
    return redirect(GITHUB_APP + "?token=" + token + "&email=" + email)

@app.route("/data")
def data():
    token = request.headers.get("X-Auth-Token") or request.args.get("token")
    email = verify_token(token)
    if not email:
        return jsonify({"error": "Unauthorized", "code": 401}), 401
    return jsonify({"status": "authorized", "email": email})

@app.route("/notify", methods=["POST"])
def notify():
    data = request.json or {}
    if data.get("secret") != RENDER_SECRET:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"status": "done"})

@app.route("/register", methods=["POST"])
def register():
    data = request.json or {}
    token = request.headers.get("X-Auth-Token") or data.get("token")
    if not verify_token(token):
        return jsonify({"error": "Unauthorized"}), 401
    email = data.get("email")
    fcm   = data.get("fcm_token")
    if fcm and email:
        participant_tokens[email] = fcm
    return jsonify({"status": "registered"})


@app.route("/debug/checkauth")
def debug_checkauth():
    email = request.args.get("email", "imspractice69@gmail.com")
    try:
        gas_res = req.get(GAS_URL, params={"key": GAS_KEY, "action": "checkauth", "email": email}, timeout=15)
        return jsonify({
            "gas_url": GAS_URL,
            "gas_status": gas_res.status_code,
            "gas_response": gas_res.json()
        })
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/ping")
def ping():
    return jsonify({"pong": True, "sessions": len(sessions)})

@app.route("/")
def index():
    return jsonify({"status": "LAVNDR120", "sessions": len(sessions)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
