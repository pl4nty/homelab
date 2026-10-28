function Scoreboard(options) {
  if (!options) options= {};

  this._message = options.message || '';
  this._score = options.score || 0;

  if (options.onTimeExpired) {
    this._countdown = new __Countdown({
      duration: options.countDownFrom
    });
    this.onTimeExpired(
      options.onTimeExpired ? options.onTimeExpired : function(){}
    );
  }
}

/****
 * Message
 */
Scoreboard.prototype.showMessage = function() {
  this.ensureDom();
  this.message_el.style.display = 'block';
  return this;
};

Scoreboard.prototype.hideMessage = function() {
  this.message_el.style.display = 'none';
  return this;
};

Scoreboard.prototype.clearMessage = function() {
  this.setMessage();
  return this;
};

Scoreboard.prototype.setMessage = function(message) {
  if (!message) message = '';

  this.showMessage();
  this._message = message;
  this.message_el.innerHTML = this._message;

  this.message_el.scrollTop = this.message_el.scrollHeight;

  return this;
};

Scoreboard.prototype.appendMessage = function(message) {
  function div(s) { return '<div>' + s + '</div>'; }
  this.setMessage((this._message || '') + div(message));
  return this;
};

Scoreboard.prototype.addMessage = Scoreboard.prototype.appendMessage;
Scoreboard.prototype.message = Scoreboard.prototype.setMessage;

// Message

/*****
 * Help
 */
Scoreboard.prototype.showHelp = function() {
  this.ensureDom();
  this.help_el.style.display = 'block';
  return this;
};

Scoreboard.prototype.hideHelp = function() {
  this.help_el.style.display = 'none';
  return this;
};

Scoreboard.prototype.toggleHelp = function() {
  this.help_el.style.display = this.help_el.style.display == 'none' ?
    'block' : 'none';
  return this;
};

Scoreboard.prototype.showHelpFooter = function() {
  this.ensureDom();
  this.help_footer.style.display = 'block';
  return this;
};

Scoreboard.prototype.setHelp = function(help) {
  this.showHelpFooter();
  this._help = help;
  this.help_el.innerHTML = this._help;

  this.help_el.scrollTop = this.help_el.scrollHeight;

  return this;
};

Scoreboard.prototype.addHelp = Scoreboard.prototype.setHelp;
Scoreboard.prototype.help = Scoreboard.prototype.setHelp;

// Help

/****
 * Score
 */

Scoreboard.prototype.showScore = function() {
  this.ensureDom();
  this.score_el.style.display = 'block';
  return this;
};


Scoreboard.prototype.setScore = function(score) {
  this.showScore();
  this._score = score || 0;

  this.score_el.innerHTML = "Score: " + this._score;

  return this;
};

Scoreboard.prototype.getScore = function() {
  return this._score;
};

Scoreboard.prototype.score = Scoreboard.prototype.setScore;

Scoreboard.prototype.addPoints = function(points) {
  this.setScore(this._score + points);
};

Scoreboard.prototype.subtractPoints = function(points) {
  this.setScore(this._score - points);
};


// Timer

/*****
 * Timer
 */

Scoreboard.prototype.showTimer = function() {
  this.ensureDom();
  this._showTimer = true;
  this.timer_el.style.display = 'block';
  this.setTimer();
  return this;
};
Scoreboard.prototype.timer = Scoreboard.prototype.showTimer;

Scoreboard.prototype.hideTimer = function() {
  this.ensureDom();
  this._showTimer = false;
  this.timer_el.style.display = 'none';
  return this;
};

Scoreboard.prototype.setTimer = function() {
  var that = this;
  if (!this._timer) this._timer = new __Timer();
  this._timer.onUpdate(function(time) {
    that.timer_el.innerHTML = 'Time: ' + time;
  });
  this.timer_el.style.display = this._showTimer ? 'block' : 'none';
};

Scoreboard.prototype.stopTimer = function() {
  this._timer.stop();
};

Scoreboard.prototype.startTimer = function() {
  this._timer.start();
};

Scoreboard.prototype.resetTimer = function() {
  this._timer.reset();
};

Scoreboard.prototype.getTime = function() {
  return this._timer.diff() / 1000;
};

// Timer

/*****
 * Countdown
 */

Scoreboard.prototype.showCountdown = function(duration) {
  this.ensureDom();
  this._showCountdown = true;
  this.countdown_el.style.display = 'block';
  this.setCountdown(duration);
  return this;
};

Scoreboard.prototype.countdown = Scoreboard.prototype.showCountdown;

Scoreboard.prototype.hideCountdown = function() {
  this.ensureDom();
  this._showCountdown = false;
  this.countdown_el.style.display = 'none';
  return this;
};

Scoreboard.prototype.setCountdown = function(duration) {
  var that = this;

  if (!this._countdown) this._countdown = new __Countdown({
    duration: duration
  });

  if (duration) this._countdown.reset(duration);
  this._countdown.onUpdate(function(time) {
    that.countdown_el.innerHTML = 'Remaining: ' + time;
  });
  this.countdown_el.style.display = this._showCountdown ? 'block' : 'none';
};

Scoreboard.prototype.stopCountdown = function() {
  this._countdown.stop();
};

Scoreboard.prototype.startCountdown = function() {
  this._countdown.start();
};

Scoreboard.prototype.resetCountdown = function(time) {
  this._countdown.reset(time);
};

Scoreboard.prototype.getTimeRemaining = function() {
  return this._countdown.diff() / 1000;
};

Scoreboard.prototype.onTimeExpired = function(cb) {
  if (!cb) return;

  var that = this;
  this._on_time_expired = (typeof(cb) == 'string') ?
    function() { that.setMessage(cb); } : cb;

  this._countdown.onTimeExpired(function() {
    that.stopCountdown();
    that._on_time_expired();
  });
};

// Countdown

Scoreboard.prototype.ensureDom = function() {
  if (this.el) return;

  var el = this.el = document.createElement('div');
  el.id = 'scoreboard';
  el.style.position = 'absolute';
  el.style.backgroundColor = 'black';
  el.style.opacity = 0.7;
  el.style.borderRadius = "5px";
  el.style.padding = "5px 20px";
  el.style.right = "50px";
  el.style.top = "75px";
  el.style.width = (window.innerWidth * 0.2) + "px";
  el.style.minWidth = '200px';

  el.style.color = 'yellow';
  el.style.fontFamily = 'Arial, San Serif';
  el.style.fontWeight = 'bold';
  el.style.fontSize = (window.innerHeight * 0.033) + "px";

  var countdown_el = this.countdown_el = document.createElement('div');
  el.appendChild(countdown_el);

  var timer_el = this.timer_el = document.createElement('div');
  el.appendChild(timer_el);

  var score_el = this.score_el = document.createElement('div');
  el.appendChild(score_el);

  var message_el = this.message_el = document.createElement('div');
  message_el.style.fontWeight = 'normal';
  message_el.style.color = 'white';
  message_el.style.maxHeight = (window.innerHeight * 0.2) + "px";
  message_el.style.overflowY = 'auto';
  el.appendChild(message_el);

  var help_el = this.help_el = document.createElement('div');
  help_el.style.display = 'none';
  help_el.style.fontWeight = 'normal';
  help_el.style.color = 'white';
  help_el.style.fontSize = (window.innerHeight * 0.028) + "px";
  help_el.style.borderTop = "1px #676767 solid";
  help_el.style.marginTop = '5px';
  help_el.style.paddingTop = '3px';
  help_el.style.maxHeight = (window.innerHeight * 0.2) + "px";
  help_el.style.overflowY = 'auto';
  el.appendChild(help_el);

  var help_footer = this.help_footer = document.createElement('div');
  help_footer.style.display = 'none';
  help_footer.style.fontWeight = 'normal';
  help_footer.style.color = 'white';
  help_footer.style.maxHeight = (window.innerHeight * 0.2) + "px";
  help_footer.style.fontSize = (window.innerHeight * 0.02) + "px";
  help_footer.style.borderTop = "1px #676767 solid";
  help_footer.style.marginTop = '5px';
  help_footer.innerHTML = 'Press ? for help';
  el.appendChild(help_footer);

  var that = this;
  document.addEventListener('keypress', function(event) {
    if (event.keyCode == 63) that.toggleHelp();
    if (event.keyCode == 47) that.toggleHelp();
  });

  document.body.appendChild(el);
};

/****
 * Timer Class
 */
function __Timer() {
  this._start = (new Date).getTime();
}

__Timer.prototype.toString = function() {
  var minutes = "" + this._minutes(),
      seconds = "" + this._seconds();

  if (minutes.length == 1) minutes = "0" + minutes;
  if (seconds.length == 1) seconds = "0" + seconds;

  return minutes + ":" + seconds;
};

__Timer.prototype.diff = function() {
  var now = this.last();
  return now - this._start;
};

__Timer.prototype.last = function() {
  if (this._last) return this._last;
  return (new Date).getTime();
};

__Timer.prototype.stop = function() {
  if (this._last) return;
  this._last = (new Date).getTime();
};

__Timer.prototype.start = function() {
  this._last = undefined;
};

__Timer.prototype.reset = function() {
  this._start = (new Date).getTime();
  this.start();
};

__Timer.prototype._minutes = function() {
  return Math.floor(this.diff()/(60*1000));
};

__Timer.prototype._seconds = function() {
  var ms = this.diff() % (60*1000);
  return Math.floor(ms / 1000);
};

__Timer.prototype.seconds = function() {
  return this.diff() / (60*1000);
};

__Timer.prototype.onUpdate = function(cb) {
  var that = this;
  cb(that.toString());
  setInterval(function() {cb(that.toString());}, 500);
};

// Timer

/*****
 * Countdown
 */

function __Countdown(options) {
  this._start = (new Date).getTime();
  this.duration = options.duration || 60;
  this._onTimeExpired = function(){};
  this.waitForTimeExpired();
}

__Countdown.prototype = new __Timer();

__Countdown.prototype.diff = function() {
  var now = this.last(),
      diff = now - this._start;

  if (diff > this.duration * 1000) return 0;
  return this.duration * 1000 - diff;
};

__Countdown.prototype.reset = function(duration) {
  if (duration) this.duration = duration;
  this._start = (new Date).getTime();
  this.waitForTimeExpired();
  this.start();
};

__Countdown.prototype.waitForTimeExpired = function() {
  var that = this;

  function _wait() {
    if (that.diff() > 0) return setTimeout(_wait, 500);
    that.stop();
    return that._onTimeExpired(that.toString());
  }
  _wait();
};

__Countdown.prototype.onTimeExpired = function(cb) {
  this._onTimeExpired = cb;
};

// Countdown
