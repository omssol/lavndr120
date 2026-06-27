from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
import urllib.request

app = Flask(__name__)
CORS(app)

# Configuration
GAS_DATA_URL = 'https://script.google.com/macros/s/AKfycbzEYTp5ZzQjCr_cRtnO1pn9kE16Lqgnfu26zY4XWQmLcvVLjYoVy1OWrKNGA9eZiM9jYw/exec?key=LAVNDR_SECRET_KEY_2026&action=data'

@app.route('/data')
def proxy_data():
    try:
        with urllib.request.urlopen(GAS_DATA_URL, timeout=30) as r:
            data = r.read().decode()
        response = app.response_class(response=data, mimetype='application/json')
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/dashboard')
def dashboard_route():
    return send_from_directory(app.root_path, 'dashboard.html')

@app.route('/firebase-messaging-sw.js')
def serve_sw():
    response = send_from_directory(app.root_path, 'firebase-messaging-sw.js')
    response.headers['Service-Worker-Allowed'] = '/'
    return response

@app.route('/debug-files')
def debug_files():
    files = [f for f in os.listdir('.') if os.path.isfile(f)]
    return jsonify({'files_in_root': files})

@app.route('/')
def index():
    return jsonify({'status': 'LAVNDR120 Server Active', 'endpoints': ['/data', '/dashboard']})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
