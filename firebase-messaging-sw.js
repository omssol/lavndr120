// firebase-messaging-sw.js
// يُوضع في نفس مجلد الداشبورد

importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "ضع-API-KEY-هنا",
  authDomain: "ضع-AUTH-DOMAIN-هنا",
  projectId: "ضع-PROJECT-ID-هنا",
  messagingSenderId: "ضع-SENDER-ID-هنا",
  appId: "ضع-APP-ID-هنا"
});

const messaging = firebase.messaging();

// إشعار في الخلفية
messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification.title;
  const body = payload.notification.body;
  self.registration.showNotification(title, {
    body: body,
    icon: '/icon.png',
    badge: '/badge.png',
    vibrate: [200, 100, 200],
    data: payload.data
  });
});
