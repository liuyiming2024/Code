var x = 1;
function f(){ return import('./js/langs.js').then(function(){ return 'ok'; }); }
self.onmessage = function(){ f().then(function(r){ self.postMessage(r); }); };
