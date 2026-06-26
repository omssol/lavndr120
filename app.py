from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, messaging
import os
import json

app = Flask(__name__)
CORS(app)

RENDER_SECRET = os.environ.get('RENDER_SECRET', 'LAVNDR_RENDER_SECRET_2026')
TOPIC = 'lavndr120'  # topic العام للـ120

# Firebase Admin SDK
cred_json = os.environ.get('FIREBASE_CREDENTIALS')
if cred_json:
    cred = credentials.Certificate(json.loads(cred_json))
    firebase_admin.initialize_app(cred)

# FCM tokens الشخصية: email → token
participant_tokens = {}

# ─────────────────────────────────────────────
# تسجيل FCM token — يُستدعى من Android WebView
# ─────────────────────────────────────────────
@app.route('/register', methods=['POST'])
def register():
    data = request.json
    email = data.get('email')
    token = data.get('fcm_token')
    if not email or not token:
        return jsonify({'error': 'email and fcm_token required'}), 400

    participant_tokens[email] = token

    # اشتراك تلقائي في الـ topic العام
    try:
        messaging.subscribe_to_topic([token], TOPIC)
    except Exception as e:
        print(f"Topic subscribe failed: {e}")

    return jsonify({'status': 'registered', 'topic': TOPIC})

# ─────────────────────────────────────────────
# إشعار عام → للـ120 جميعاً عبر topic
# ─────────────────────────────────────────────
def send_general(title, body, data={}):
    try:
        message = messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            data={k: str(v) for k, v in data.items()},
            android=messaging.AndroidConfig(priority='high'),
            topic=TOPIC
        )
        messaging.send(message)
        return True
    except Exception as e:
        print(f"General notification failed: {e}")
        return False

# ─────────────────────────────────────────────
# إشعار شخصي → لفرد واحد فقط عبر token
# ─────────────────────────────────────────────
def send_personal(email, title, body, data={}):
    token = participant_tokens.get(email)
    if not token:
        return False
    try:
        message = messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            data={k: str(v) for k, v in data.items()},
            android=messaging.AndroidConfig(priority='high'),
            token=token
        )
        messaging.send(message)
        return True
    except Exception as e:
        print(f"Personal notification to {email} failed: {e}")
        return False

# ─────────────────────────────────────────────
# استقبال من GAS وتوزيع الإشعارات
# ─────────────────────────────────────────────
@app.route('/notify', methods=['POST'])
def notify():
    data = request.json
    if data.get('secret') != RENDER_SECRET:
        return jsonify({'error': 'Unauthorized'}), 401

    notif_type = data.get('type')
    payload = data.get('payload', {})
    sent_general = False
    sent_personal = 0

    # ── إشعار ساعي عام ──
    if notif_type == 'hourly_update':
        change = float(payload.get('change', 0))
        arrow = '▲' if change >= 0 else '▼'
        color = '+' if change >= 0 else ''
        sent_general = send_general(
            title='LAVNDR120 — تحديث',
            body=f"NAV: ${payload.get('NAV')} | {arrow} {color}{payload.get('changePercent')}%",
            data={'type': 'hourly', 'NAV': str(payload.get('NAV', ''))}
        )

    # ── تقرير يوم 21 عام ──
    elif notif_type == 'monthly_snapshot':
        sent_general = send_general(
            title='LAVNDR120 — تقرير يوم 21 🎯',
            body=f"NAV: ${payload.get('NAV')} | Top5: {payload.get('top5')}",
            data={'type': 'monthly'}
        )
        # + إشعار شخصي لكل مشارك بقيمته
        personal_data = payload.get('participants_data', {})
        for email, info in personal_data.items():
            pnl = float(info.get('pnl', 0))
            pnl_text = f"+${pnl:.2f} ربح 🟢" if pnl >= 0 else f"-${abs(pnl):.2f} خسارة 🔴"
            if send_personal(
                email=email,
                title='حصتك في LAVNDR120',
                body=f"القيمة الحالية: ${info.get('currentValue')} | {pnl_text}",
                data={'type': 'personal_monthly', 'email': email}
            ):
                sent_personal += 1

    # ── حصة جديدة في السوق — عام ──
    elif notif_type == 'market_listing':
        sent_general = send_general(
            title='LAVNDR120 — حصة في السوق 🔔',
            body=f"حصة بقيمة ${payload.get('shareValue')} متاحة للشراء",
            data={'type': 'market'}
        )

    # ── إشعار شخصي: حصتك بيعت ──
    elif notif_type == 'share_sold':
        email = payload.get('seller_email')
        buyer = payload.get('buyer_email', 'مشارك جديد')
        if send_personal(
            email=email,
            title='LAVNDR120 — تمت عملية البيع ✓',
            body=f"بيعت حصتك بقيمة ${payload.get('shareValue')} لـ {buyer}",
            data={'type': 'share_sold'}
        ):
            sent_personal += 1

    # ── إشعار شخصي: تغير كبير في قيمة الحصة ──
    elif notif_type == 'value_change':
        email = payload.get('email')
        pnl = float(payload.get('pnl', 0))
        pnl_text = f"+${pnl:.2f} 🟢" if pnl >= 0 else f"-${abs(pnl):.2f} 🔴"
        if send_personal(
            email=email,
            title='LAVNDR120 — تغير في قيمة حصتك',
            body=f"القيمة الحالية: ${payload.get('currentValue')} | {pnl_text}",
            data={'type': 'value_change', 'email': email}
        ):
            sent_personal += 1

    return jsonify({
        'status': 'done',
        'general': sent_general,
        'personal': sent_personal
    })

# ─────────────────────────────────────────────
# ping من GAS لإبقاء Render مستيقظاً
# ─────────────────────────────────────────────

import urllib.request
from flask import jsonify

GAS_DATA_URL = 'https://script.google.com/macros/s/AKfycbxAl207zzVg1VaEE6sB4Kp2O3ZXuT8JDzgLSSalQFHVI8wjZ46xLb_p_mfMffOpmiVddA/exec?key=LAVNDR_SECRET_KEY_2026&action=data'

@app.route('/data')
def proxy_data():
    try:
        with urllib.request.urlopen(GAS_DATA_URL, timeout=30) as r:
            data = r.read().decode()
        response = app.response_class(
            response=data,
            mimetype='application/json'
        )
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/dashboard')
def dashboard_route():
    with open('dashboard.html', 'r') as f:
        return f.read()

@app.route('/firebase-messaging-sw.js')
def serve_sw():
    with open('firebase-messaging-sw.js', 'r') as f:
        content = f.read()
    response = app.response_class(response=content, mimetype='application/javascript')
    response.headers['Service-Worker-Allowed'] = '/'
    return response


@app.route('/')
def index():
    return jsonify({
        'status': 'LAVNDR120 Notification Server',
        'registered_participants': len(participant_tokens)
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
