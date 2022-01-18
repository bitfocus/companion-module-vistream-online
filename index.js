try {
	var io = require('./node_modules/socket.io-client');
} catch (e) {
	console.error('ViStream: Socket.io should be installed via `npm install` before using this module');
}
try {
	var rawinflate = require('./node_modules/zlibjs/bin/rawinflate.min.js');
} catch (e) {
	console.error('ViStream: zlibjs should be installed via `npm install` before using this module');
}
var instance_skel = require('../../instance_skel');

// REQUIRED: constructor
function instance(system, id, config) {
	instance_skel.apply(this, arguments);
	return this;
}

// REQUIRED: Return config fields for web config
instance.prototype.config_fields = function () {
	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: "This is a ViStream integration, <br>Click 'Save' before setting up buttons"
		},
		{
			type: 'textinput',
			id: 'token',
			label: 'Token (Copy from cuelist module on ViStream platform)',
			default: '',
			required: true
		},
	];
};

// Set up actions, needs data from modules to be availabe
instance.prototype.init_actions = function (actions) {
	this.config.actions = actions;
	this.setActions(actions);
};

// call an action from user interactions
instance.prototype.action = function (action) {
	var self = this;
	if (self.config.actions[action.action]) {
		var b = new Buffer(action.action.substring(2), 'base64');
		if (!self.actions) self.actions = [];
		self.actions.push([b.toString(), action.options]);
		if (self.run_timer) clearTimeout(self.run_timer);
		self.run_timer = setTimeout(function () {
			var params = new URLSearchParams(self.config.searchParams.toString());
			params.append('cp', 'run');
			params.append('actions', JSON.stringify(self.actions));
			self.system.emit(
				'rest',
				self.config.endPoint,
				params.toString(),
				function (err, result) {
					if (err !== null) {
						self.log('error', 'HTTP POST Request failed (' + result.error.code + ')');
						self.status(self.STATUS_ERROR, result.error.code);
					} else {
						self.log('info', 'Action sent');
						self.status(self.STATUS_OK);
					}
				}, {
					'Content-Type': 'application/x-www-form-urlencoded',
				}
			);
			self.actions = [];
			delete self.run_timer;
		}, 1);
	}
};

// define presets, could be retrieved from xhr request
instance.prototype.init_presets = function (presets) {
	this.config.presets = presets;
	this.setPresetDefinitions(presets);
};

// register feedback handler
instance.prototype.init_feedbacks = function (feedbacks) {
	this.config.feedbacks = feedbacks;
	this.setFeedbackDefinitions(feedbacks);
};

// receive and use feedback events here
instance.prototype.feedback = function (feedback) {
	this.log('debug', 'Feedback triggered: ', feedback);
	if (feedback.type === 'module_state') {
		var e = this.config.feedbacks.module_state.options[0].choices.find((x) => x.id == feedback.options.idmod);
		return {
			color: this.rgb(255, 255, 255),
			bgcolor: e.online === '1' ? this.rgb(0, 123, 255) : this.rgb(0, 0, 0),
		};
	}
};

// helper to create the required config fields from the token
function parse_token(self, config) {
	if (config.token === '') {
		self.status(self.STATUS_WARNING, 'Missing token');
		return config;
	}
	var b = new Buffer(config.token.substring(2), 'base64');
	var url = new URL(b.toString());
	var path = url.pathname.split('/');
	if (path.length !== 5) return config;
	config.baseUrl = url.protocol + '//' + url.host;
	config.eventToken = path[3];
	config.endPoint = config.baseUrl + '/' + path[1] + '/mod/cuelist/companion/' + path[3] + '/' + path[4];
	config.searchParams = url.searchParams;
	config.searchParams.append('version', self.package_info.version);
	config.searchParams.append('api_version', self.package_info.api_version);
	config.id = new Date().getTime();
	return config;
}

// helper to retrieve modules list and(re-)initialize all state after config edit event
function set_config(self) {
	if (self.config.token === '') return;
	var params = new URLSearchParams(self.config.searchParams.toString());
	params.append('cp', 'init');
	var url = self.config.endPoint + '?' + params.toString();
	self.system.emit('rest_get', url, function (err, result) {
		if (err !== null) {
			self.log('error', 'HTTP POST Request failed (' + result.error.code + ')');
			self.status(self.STATUS_ERROR, result.error.code);
		} else if (result.response.statusCode === 200) {
			self.log('info', 'load config');
			self.init_actions(result.data.actions);
			self.init_presets(result.data.presets);
			self.init_feedbacks(result.data.feedbacks);
			self.checkFeedbacks('module_state');
		} else self.status(self.STATUS_ERROR);
	});
}

// helper to establish the socket connection
function socket_init(self) {
	if (self.io !== undefined) {
		self.io.close();
		delete self.io;
	}
	if (!self.config.baseUrl && self.config.token) self.config = parse_token(self, self.config);
	if (!self.config.baseUrl) {
		self.log('info', 'Websocket connection not yet possible, missing token in config');
		self.status(self.STATUS_WARNING, 'Missing target');
		return;
	}
	try {
		var params = new URLSearchParams(self.config.searchParams.toString());
		params.append('ids', self.config.id);
		var url = '/update/' + self.config.eventToken + '/cuelist?' + params.toString();
		self.io = io(self.config.baseUrl, {
			path: url,
		});
		self.io.off('connect').on('connect', () => {
			self.log('debug', 'Websocket connected');
			set_config(self);
			self.status(self.STATE_OK);
		});
		self.io.off('vs').on('vs', (data) => {
			self.log('debug', 'Websocket received data');
			var json =
				typeof data === 'object' ? JSON.parse(utf8ToString(new rawinflate.Zlib.RawInflate(new Uint8Array(data)).decompress())) : JSON.parse(data);
			switch (json.action) {
				case 'change_online':
					if (self.config.feedbacks.module_state) {
						var e = self.config.feedbacks.module_state.options[0].choices.find((x) => x.id == json.id);
						if (e) {
							e.online = json.online;
							self.checkFeedbacks('module_state');
						}
					}
					break;
				case 'change_content':
					set_config(self);
					break;
			}
			self.status(self.STATUS_OK);
		});
		self.io.off('disconnect').on('disconnect', () => {
			self.log('warning', 'Websocket disconnected');
			self.status(self.STATUS_WARNING, 'Connection lost');
		});
		self.io.off('connect_error').on('connect_error', (e) => {
			self.log('error', 'Websocket error: ' + e.message);
			self.status(self.STATUS_ERROR, 'Connection error');
		});
	} catch (e) {
		self.log('error', 'Error while conecting websocket: ' + e.message);
	}
}

// REQUIRED: whenever users click save in the modules config, this gets triggered with new config
instance.prototype.updateConfig = function (config) {
	this.config = parse_token(this, config);
	this.log('debug', 'Config updated');
	socket_init(this);
};

// REQUIRED: this is called when companion initialized the module, all set up should be triggered here
instance.prototype.init = function () {
	this.status(this.STATUS_ERROR);
	this.log('debug', 'init');
	socket_init(this);
};

// REQUIRED: drop all websockets and stuff here, before unloading
instance.prototype.destroy = function () {
	if (this.io !== undefined) {
		this.io.close();
		delete this.io;
	}
	this.log('debug', 'destroy');
};

// Encode Websocket
function utf8ToString(uintArray) {
	var encodedString = '';
	for (var i = 0; i < uintArray.length; i++) {
		encodedString += String.fromCharCode(uintArray[i]);
	}

	return decodeURIComponent(escape(encodedString));
}

instance_skel.extendedBy(instance);
exports = module.exports = instance;
