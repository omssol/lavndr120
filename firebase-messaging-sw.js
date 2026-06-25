// firebase-messaging-sw.js
// يُوضع في نفس مجلد الداشبورد

importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDR538OyW6eSoc8Dq3A50VQmOCEkNLzRIw",
  authDomain: "lavndr120.firebaseapp.com",
  projectId: "lavndr120",
  messagingSenderId: "938319363791",
  appId: "1:938319363791:web:ab581bd34b161e843201ba"
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
