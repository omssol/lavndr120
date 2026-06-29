from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
import os, json, secrets, time
import requests as req

app = Flask(__name__)
CORS(app, origins=["https://omssol.github.io"])

CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
REDIRECT_URI  = "https://lavndr120.onrender.com/auth/callback"
GITHUB_APP    = "https://omssol.github.io/lavndr120-dashboard/"
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

used_codes = set()

@app.route("/auth/callback")
def auth_callback():
    code = request.args.get("code")
    if not code:
        return redirect(GITHUB_APP + "/#denied=1")
    if code in used_codes:
        return redirect(GITHUB_APP + "/#denied=1")
    used_codes.add(code)
    token_res = req.post("https://oauth2.googleapis.com/token", data={
        "code": code,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code"
    })
    if token_res.status_code != 200:
        return redirect(GITHUB_APP + "/#denied=1")
    id_token = token_res.json().get("id_token", "")
    user_res = req.get("https://www.googleapis.com/oauth2/v3/tokeninfo",
                       params={"id_token": id_token})
    if user_res.status_code != 200:
        return redirect(GITHUB_APP + "/#denied=1")
    email = user_res.json().get("email", "").lower()
    if not email:
        return redirect(GITHUB_APP + "/#denied=1")
    # التحقق من الإيميل محلياً في Render
    ALLOWED = os.environ.get("ALLOWED_EMAILS", "imspractice69@gmail.com")
    allowed_list = [e.strip().lower() for e in ALLOWED.split(",")]
    print(f"Checking email: {email} against {allowed_list}")
    if email not in allowed_list:
        print(f"Email {email} not authorized")
        return redirect(GITHUB_APP + "/#denied=1")
    print(f"Email {email} authorized")
    clean_sessions()
    token = secrets.token_urlsafe(32)
    sessions[token] = {"email": email, "expires": time.time() + TOKEN_TTL}
    return redirect(GITHUB_APP + "/#token=" + token + "&email=" + email)

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


@app.route("/auth/firebase", methods=["POST"])
def auth_firebase():
    """التحقق من Google Identity Services JWT وإصدار session token"""
    data = request.json or {}
    id_token = data.get("id_token")
    if not id_token:
        return jsonify({"error": "id_token required"}), 400
    try:
        # فك تشفير JWT من Google Identity Services
        import base64 as b64
        parts = id_token.split('.')
        if len(parts) < 2:
            return jsonify({"error": "Invalid token"}), 401
        payload_str = parts[1]
        # إضافة padding
        payload_str += '=' * (4 - len(payload_str) % 4)
        payload = json.loads(b64.b64decode(payload_str).decode('utf-8'))
        email = payload.get("email", "").lower()
        if not email:
            return jsonify({"error": "No email"}), 401
        # تحقق من القائمة المصرح بها
        ALLOWED = os.environ.get("ALLOWED_EMAILS", "imspractice69@gmail.com")
        allowed_list = [e.strip().lower() for e in ALLOWED.split(",")]
        print(f"Checking: {email} in {allowed_list}")
        if email not in allowed_list:
            return jsonify({"error": "Unauthorized", "code": 401}), 401
        # إصدار session token
        clean_sessions()
        token = secrets.token_urlsafe(32)
        sessions[token] = {"email": email, "expires": time.time() + TOKEN_TTL}
        print(f"Token issued for {email}")
        return jsonify({"token": token, "email": email})
    except Exception as e:
        print(f"Auth error: {e}")
        return jsonify({"error": str(e)}), 401


@app.route("/api/data")
def api_data():
    token = request.headers.get("X-Auth-Token") or request.args.get("token")
    email = request.headers.get("X-User-Email", "").lower()
    # تحقق من Google JWT مباشرة
    if token and email:
        try:
            import base64 as b64
            parts = token.split('.')
            if len(parts) >= 2:
                payload_str = parts[1] + '=' * (4 - len(parts[1]) % 4)
                payload = json.loads(b64.b64decode(payload_str).decode())
                token_email = payload.get("email", "").lower()
                ALLOWED = os.environ.get("ALLOWED_EMAILS", "imspractice69@gmail.com")
                allowed_list = [e.strip().lower() for e in ALLOWED.split(",")]
                if token_email in allowed_list and token_email == email:
                    email = token_email
                else:
                    return jsonify({"error": "Unauthorized", "code": 401}), 401
            else:
                return jsonify({"error": "Unauthorized", "code": 401}), 401
        except:
            return jsonify({"error": "Unauthorized", "code": 401}), 401
    else:
        session_email = verify_token(token)
        if not session_email:
            return jsonify({"error": "Unauthorized", "code": 401}), 401
        email = session_email
    try:
        gas_res = req.get(GAS_URL, params={
            "key": GAS_KEY, "action": "data"
        }, timeout=30)
        return jsonify(gas_res.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/participant")
def api_participant():
    token = request.headers.get("X-Auth-Token") or request.args.get("token")
    email = verify_token(token)
    if not email:
        return jsonify({"error": "Unauthorized", "code": 401}), 401
    try:
        gas_res = req.get(GAS_URL, params={
            "key": GAS_KEY, "action": "participant", "email": email
        }, timeout=30)
        return jsonify(gas_res.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/proxy/data")
def proxy_data():
    """Proxy لـ GAS مع retry"""
    for attempt in range(3):
        try:
            gas_res = req.get(GAS_URL, params={
                "key": GAS_KEY, "action": "data"
            }, timeout=30, allow_redirects=True)
            text = gas_res.text.strip()
            if text.startswith('<'):
                print(f"GAS returned HTML on attempt {attempt+1}")
                time.sleep(2)
                continue
            data = gas_res.json()
            response = jsonify(data)
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        except Exception as e:
            print(f"Attempt {attempt+1} failed: {e}")
            time.sleep(2)
    return jsonify({"error": "GAS unavailable"}), 503

@app.route("/ping")
def ping():
    return jsonify({"pong": True, "sessions": len(sessions)})

@app.route("/")
def index():
    return jsonify({"status": "LAVNDR120", "sessions": len(sessions)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
