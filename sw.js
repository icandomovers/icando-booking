/* Icando Manager — web push service worker.
   Shows manager notifications (payload: {type,title,body,url});
   tag 'icando-'+type so same-type notifications replace each other. */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var type = data.type || 'note';
  var title = data.title || 'Icando Manager';
  var options = {
    body: data.body || '',
    tag: 'icando-' + type,
    icon: 'icon.svg',
    data: { url: data.url || 'manager.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || 'manager.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.indexOf('manager.html') > -1 || clients[i].url.indexOf('staff.html') > -1) {
          // Navigate the existing window to the notification's deep link, then focus it.
          return clients[i].navigate(url).then(function(c){ return c.focus(); }).catch(function(){ return clients[i].focus(); });
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
