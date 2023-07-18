/*jshint esversion: 11 */
/*globals URLSearchParams*/
/*globals Buffer*/
import { InstanceBase, runEntrypoint, InstanceStatus } from '@companion-module/base'
import io from 'socket.io-client';
import got from 'got'
import rawinflate from 'zlibjs/bin/rawinflate.min.js';
import SecureJSONLogic from 'secure-json-logic';

class ViStreamInstance extends InstanceBase {
	// REQUIRED: constructor
	constructor(system, id, config) {
		super(system, id, config);
		this.cache = {
			actions: {},
			presets: {},
			feedbacks: {},
			targetVersion: 3
		};
	}

	// REQUIRED: Return config fields for web config

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This is a ViStream integration, <br>Click \'Save\' before setting up buttons<br>(Feedbacks are broken)'
			},
			{
				type: 'textinput',
				id: 'token',
				width: 12,
				label: 'Token (Copy from cuelist module on ViStream platform)',
				default: '',
				required: true
			},
		];
	}

	// Set up actions, needs data from modules to be availabe
	init_actions(actions, callback) {
		if (!actions) {
			this.log('warn', 'setting config with empty actions!')
			return;
		}
		for (var i in actions) {
			actions[i].callback = callback;
			actions[i].instance = this;
			if (actions[i].options) {
				for (var j in actions[i].options) {
					if (typeof (actions[i].options[j].isVisible) === 'object' && actions[i].options[j].isVisible.logic && actions[i].options[j].isVisible.vars) {
						actions[i].options[j].isVisible = SecureJSONLogic(actions[i].options[j].isVisible.logic, actions[i].options[j].isVisible.vars);
					}
				}
			}
		}
		this.cache.actions = actions;
		this.setActionDefinitions(actions);
	}

	// call an action from user interactions
	action(action) {
		let self = this.instance
		if (self.cache.actions[action.actionId]) {
			var b = Buffer.from(action.actionId.substring(2), 'base64');
			if (!self.actions) {
				self.actions = [];
			}
			self.actions.push([b.toString(), action.options]);
			if (self.run_timer) {
				clearTimeout(self.run_timer);
			}
			self.run_timer = setTimeout(async () => {
				let params = {
					v: self.cache.targetVersion,
					cp: 'run',
					actions: JSON.stringify(self.actions)
				}
				got.post(self.cache.config.endPoint, {form: params}).then(response=>{
					self.updateStatus(InstanceStatus.Ok, response.statusCode);
					self.actions = [];
				}).catch(e=>{
					self.log('error', 'HTTP POST Request failed (' + e + ')');
					self.updateStatus(InstanceStatus.ConnectionFailure, e);
					self.actions = [];
				});
				delete self.run_timer;
			}, 1);
		} else {
			self.log('warn', 'You triggered an action, that has not been defined(' + action.actionId + ').')
		}
	}

	// register feedback handler
	init_feedbacks(feedbacks, callback) {
		if (!feedbacks) {
			this.log('warn', 'setting config with empty feedbacks!')
			return;
		}
		for (var i in feedbacks) {
			feedbacks[i].callback = callback;
			feedbacks[i].instance = this;
			if (feedbacks[i].options) {
				for (var j in feedbacks[i].options) {
					if (typeof (feedbacks[i].options[j].isVisible) === 'object' && feedbacks[i].options[j].isVisible.logic && feedbacks[i].options[j].isVisible.vars) {
						feedbacks[i].options[j].isVisible = SecureJSONLogic(feedbacks[i].options[j].isVisible.logic, feedbacks[i].options[j].isVisible.vars);
					}
				}
			}
		}
		this.cache.feedbacks = feedbacks;
		this.setFeedbackDefinitions(feedbacks);
	}

	// receive and use feedback events here
	feedback(feedback) {
		let self = this.instance;
		var e, state = false;
		switch (feedback.feedbackId) {
			case 'feedback_state':
				state = self.cache.feedbacks.feedback_state ?? false;
				let type = feedback.options.type.toString();
				let options = state.options.find((x) => x.id.toString() === type);
				if (state && state.options !== undefined && options !== undefined && options.choices !== undefined) {
					e = options.choices.find((x) => x.id.toString() === feedback.options[type].toString());
					return (e && e.state === 1)
				}
				break;
			default:
				self.log('warn', 'Unknown feedback: ' + feedback.feedbackId)
		}
	}

	// define presets, could be retrieved from xhr request
	init_presets(presets) {
		if (!presets) {
			this.log('warn', 'setting config with empty presets!')
			return;
		}
		this.cache.presets = presets;
		this.setPresetDefinitions(presets);
	}

	// define variables, could be retrieved from xhr request
	init_variables(variables, variableDefinitions) {
		if (typeof variables !== 'object') {
			this.log('warn', 'setting config with empty variables!')
			return;
		}
		if (typeof variableDefinitions === 'object') {
			this.setVariableDefinitions(variableDefinitions);
		}
		this.setVariableValues(variables);
	}

	// helper to create the required config fields from the token
	parse_token(config) {
		if (config.token === '') {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing token');
			return config;
		}
		var b = Buffer.from(config.token.substring(2), 'base64');
		var url = new URL(b.toString());
		var path = url.pathname.split('/');
		if (path.length !== 5) {
			return config;
		}
		config.baseUrl = url.protocol + '//' + url.host;
		config.eventToken = path[3];
		config.endPoint = config.baseUrl + '/' + path[1] + '/mod/cuelist/companion/' + path[3] + '/' + path[4];
		config.searchParams = url.searchParams.toString();
		config.id = new Date().getTime();
		return config;
	}

	// helper to retrieve modules list and(re-)initialize all state after config edit event
	set_config() {
		if (!this.cache.config) {
			return;
		}
		let params = new URLSearchParams(this.cache.config.searchParams);
		params.append('cp','init')
		params.append('v',this.cache.targetVersion)
		let url = this.cache.config.endPoint + '?' + params.toString()
		got.get(url, {}).then(response=>response.body).then(body=>{
			let json = {}
			try {
			  json = JSON.parse(body);
			} catch(e){
				this.log('error', 'JSON malformed')
				return;
			}
			if (!json) {
				this.log('error', 'received config reads: ' + JSON.stringify(json) )
				return;
			}
			try {
				this.log('info', 'setting config');
				this.init_actions(json.actions, this.action);
				this.init_presets(json.presets);
				this.init_variables(json.variables, json.variableDefinitions);
				this.init_feedbacks(json.feedbacks, this.feedback);
				this.log('info', 'setting config done');
				this.checkFeedbacks('feedback_state');
			} catch (e) {
				this.log('error', 'setting config failed')
				return;
			}

		}).catch(e=>{
			this.log('error', 'HTTP GET Request failed ' + url);
			this.updateStatus(InstanceStatus.ConnectionFailure, JSON.stringify(e));
		})
	}

	// helper to establish the socket connection
	socket_init() {
		this.log('debug', 'socket_init');
		this.setVariableValues({websocket: 'offline'});
		if (this.io !== undefined) {
			this.io.close();
			delete this.io;
		}
		if (!this.cache.config && this.config.token) {
			this.cache.config = this.parse_token(this.config);
		}
		if (!this.cache.config.baseUrl) {
			this.log('info', 'Websocket connection not yet possible, missing token in config');
			this.updateStatus(InstanceStatus.BadConfig, 'Missing target');
			return;
		}
		try {
			var params = new URLSearchParams();
			params.append('v', this.cache.targetVersion);
			params.append('ids', this.cache.config.id);
			var url = '/update/' + this.cache.config.eventToken + '/cuelist?' + params.toString();
			this.io = io(this.cache.config.baseUrl, {
				path: url
			});
			this.io.off('connect').on('connect', () => {
				this.setVariableValues({websocket: 'online'});
				this.log('debug', 'Websocket connected');
				this.set_config();
				this.updateStatus(InstanceStatus.Ok);
			});
			this.io.off('vs').on('vs', (data) => {
				this.log('debug', 'Websocket received data');
				var e, state = false, json =
					typeof data !== 'object' ? JSON.parse(data)
						: JSON.parse(new TextDecoder().decode(new rawinflate.Zlib.RawInflate(new Uint8Array(data)).decompress()));
				switch (json.action) {
					case 'change_feedback_state':
						let type = json.type.toString();
						state = this.cache.feedbacks['feedback_state'] ?? false;
						let options = state.options.find((x) => x.id.toString() === type);
						if (state && state.options !== undefined && options !== undefined && options.choices !== undefined) {
							e = options.choices.find((x) => x.id.toString() === json.id.toString());
							if (e) {
								e.state = json.state;
								this.checkFeedbacks('feedback_state');
							}
						}
						break;
					case 'change_content':
						this.set_config();
						break;
					case 'change_variable':
						if (!json.var || json.var.toString().length === 0) {
							return;
						}
						let vars = {};
						vars[json.var.toString()] = json.value;
						this.setVariableValues(vars);
						if (json.reset) {
							setTimeout(()=>{
								vars[json.var.toString()] = '';
								this.setVariableValues(vars);
							},10);
						}
						break;
					default:
						this.log('warning', 'Feedback for a feature that is not implemented. Maybe you are missing an update? ' + json.action);
				}
				this.updateStatus(InstanceStatus.Ok);
			});
			this.io.off('disconnect').on('disconnect', () => {
				this.log('warning', 'Websocket disconnected');
				this.updateStatus(InstanceStatus.Disconnected, 'Connection lost');
				this.setVariableValues({websocket: 'offline'});
			});
			this.io.off('connect_error').on('connect_error', (e) => {
				this.log('error', 'Websocket error: ' + e.message);
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Connection error');
				this.setVariableValues({websocket: 'offline'});
			});
		} catch (e) {
			this.log('error', 'Error while conecting websocket: ' + e.message);
		}
	}

	// REQUIRED: whenever users click save in the modules config, this gets triggered with new config
	configUpdated(config) {
		this.cache.config = this.parse_token(config);
		this.config = this.cache.config;
		this.log('debug', 'Config updated');
		this.updateStatus(InstanceStatus.Connecting);
		this.socket_init();
	}

	// REQUIRED: this is called when companion initialized the module, all set up should be triggered here
	init(conf, firstTime) {
		if (conf && conf.token) {
			this.cache.config = this.parse_token(conf);
		}
		this.updateStatus(InstanceStatus.Connecting);
		this.log('debug', 'init');
		this.socket_init();
	}

	// REQUIRED: drop all websockets and stuff here, before unloading
	destroy() {
		if (this.io !== undefined) {
			this.io.close();
			delete this.io;
		}
		this.log('debug', 'destroy');
	}
}

runEntrypoint(ViStreamInstance, [])
