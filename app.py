from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os, urllib.request

app = Flask(__name__)
CORS(app)

GAS_DATA_URL = 'https://script.google.com/macros/s/AKfycbzEYTp5ZzQjCr_cRtnO1pn9kE16Lqgnfu26zY4XWQmLcvVLjYoVy1OWrKNGA9eZiM9jYw/exec?key=LAVNDR_SECRET_KEY_2026&action=data'

@app.route('/data')
def proxy_data():
    try:
        # إضافة إيميل المستخدم من الطلب القادم من الداشبورد
        email = request.args.get('email', '')
        url = f"{GAS_DATA_URL}&email={email}"
        with urllib.request.urlopen(url, timeout=30) as r:
            data = r.read().decode()
        resp = app.response_class(response=data, mimetype='application/json')
        resp.headers['Access-Control-Allow-Origin'] = '*'
        return resp
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/dashboard')
def dashboard_route():
    return send_from_directory(os.getcwd(), 'dashboard.html')

@app.route('/firebase-messaging-sw.js')
def serve_sw():
    resp = send_from_directory(os.getcwd(), 'firebase-messaging-sw.js')
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp

@app.route('/')
def index():
    return jsonify({'status': 'LAVNDR120 API Active', 'version': '3.5'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
