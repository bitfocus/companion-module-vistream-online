const io = require('socket.io-client')
const rawinflate = require('zlibjs').RawInflate

var instance_skel = require('../../instance_skel')

class instance extends instance_skel {
	// REQUIRED: constructor
	constructor(system, id, config) {
		super(system, id, config)
	}

	// REQUIRED: Return config fields for web config
	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: "This is a ViStream integration, <br>Click 'Save' before setting up buttons",
			},
			{
				type: 'textinput',
				id: 'token',
				label: 'Token (Copy from cuelist module on ViStream platform)',
				default: '',
				required: true,
			},
		]
	}

	// Set up actions, needs data from modules to be availabe
	init_actions(actions) {
		this.config.actions = actions
		this.setActions(actions)
	}

	// call an action from user interactions
	action(action) {
		if (this.config.actions[action.action]) {
			var b = new Buffer(action.action.substring(2), 'base64')
			if (!this.actions) {
				this.actions = []
			}
			this.actions.push([b.toString(), action.options])
			if (this.run_timer) {
				clearTimeout(this.run_timer)
			}
			this.run_timer = setTimeout(() => {
				var params = new URLSearchParams(this.config.searchParams.toString())
				params.append('cp', 'run')
				params.append('actions', JSON.stringify(this.actions))
				this.system.emit(
					'rest',
					this.config.endPoint,
					params.toString(),
					(err, result) => {
						if (err !== null) {
							this.log('error', 'HTTP POST Request failed (' + result.error.code + ')')
							this.status(this.STATUS_ERROR, result.error.code)
						} else {
							this.log('info', 'Action sent')
							this.status(this.STATUS_OK)
						}
					},
					{
						'Content-Type': 'application/x-www-form-urlencoded',
					}
				)
				this.actions = []
				delete this.run_timer
			}, 1)
		}
	}

	// define presets, could be retrieved from xhr request
	init_presets(presets) {
		this.config.presets = presets
		this.setPresetDefinitions(presets)
	}

	// register feedback handler
	init_feedbacks(feedbacks) {
		this.config.feedbacks = feedbacks
		this.setFeedbackDefinitions(feedbacks)
	}

	// receive and use feedback events here
	feedback(feedback) {
		this.log('debug', 'Feedback triggered: ', feedback)
		if (feedback.type === 'module_state') {
			var e = this.config.feedbacks.module_state.options[0].choices.find((x) => x.id == feedback.options.idmod)
			return {
				color: this.rgb(255, 255, 255),
				bgcolor: e.online === '1' ? this.rgb(0, 123, 255) : this.rgb(0, 0, 0),
			}
		}
	}

	// helper to create the required config fields from the token
	parse_token(config) {
		if (config.token === '') {
			this.status(this.STATUS_WARNING, 'Missing token')
			return config
		}
		var b = new Buffer(config.token.substring(2), 'base64')
		var url = new URL(b.toString())
		var path = url.pathname.split('/')
		if (path.length !== 5) {
			return config
		}
		config.baseUrl = url.protocol + '//' + url.host
		config.eventToken = path[3]
		config.endPoint = config.baseUrl + '/' + path[1] + '/mod/cuelist/companion/' + path[3] + '/' + path[4]
		config.searchParams = url.searchParams
		config.searchParams.append('version', this.package_info.version)
		config.searchParams.append('api_version', this.package_info.api_version)
		config.id = new Date().getTime()
		return config
	}

	// helper to retrieve modules list and(re-)initialize all state after config edit event
	set_config() {
		if (this.config.token === '') {
			return
		}
		var params = new URLSearchParams(this.config.searchParams.toString())
		params.append('cp', 'init')
		var url = this.config.endPoint + '?' + params.toString()
		this.system.emit('rest_get', url, (err, result) => {
			if (err !== null) {
				this.log('error', 'HTTP POST Request failed (' + result.error.code + ')')
				this.status(this.STATUS_ERROR, result.error.code)
			} else if (result.response.statusCode === 200) {
				this.log('info', 'load config')
				this.init_actions(result.data.actions)
				this.init_presets(result.data.presets)
				this.init_feedbacks(result.data.feedbacks)
				this.checkFeedbacks('module_state')
			} else {
				this.status(this.STATUS_ERROR)
			}
		})
	}

	// helper to establish the socket connection
	socket_init() {
		if (this.io !== undefined) {
			this.io.close()
			delete this.io
		}
		if (!this.config.baseUrl && this.config.token) {
			this.config = parse_token(this.config)
		}
		if (!this.config.baseUrl) {
			this.log('info', 'Websocket connection not yet possible, missing token in config')
			this.status(this.STATUS_WARNING, 'Missing target')
			return
		}
		try {
			var params = new URLSearchParams(this.config.searchParams.toString())
			params.append('ids', this.config.id)
			var url = '/update/' + this.config.eventToken + '/cuelist?' + params.toString()
			this.io = io(this.config.baseUrl, {
				path: url,
			})
			this.io.off('connect').on('connect', () => {
				this.log('debug', 'Websocket connected')
				this.set_config()
				this.status(this.STATE_OK)
			})
			this.io.off('vs').on('vs', (data) => {
				this.log('debug', 'Websocket received data')
				var json =
					typeof data === 'object'
						? JSON.parse(utf8ToString(new rawinflate.Zlib.RawInflate(new Uint8Array(data)).decompress()))
						: JSON.parse(data)
				switch (json.action) {
					case 'change_online':
						if (this.config.feedbacks.module_state) {
							var e = this.config.feedbacks.module_state.options[0].choices.find((x) => x.id == json.id)
							if (e) {
								e.online = json.online
								this.checkFeedbacks('module_state')
							}
						}
						break
					case 'change_content':
						this.set_config()
						break
				}
				this.status(this.STATUS_OK)
			})
			this.io.off('disconnect').on('disconnect', () => {
				this.log('warning', 'Websocket disconnected')
				this.status(this.STATUS_WARNING, 'Connection lost')
			})
			this.io.off('connect_error').on('connect_error', (e) => {
				this.log('error', 'Websocket error: ' + e.message)
				this.status(this.STATUS_ERROR, 'Connection error')
			})
		} catch (e) {
			this.log('error', 'Error while conecting websocket: ' + e.message)
		}
	}

	// REQUIRED: whenever users click save in the modules config, this gets triggered with new config
	updateConfig(config) {
		this.config = parse_token(config)
		this.log('debug', 'Config updated')
		this.socket_init()
	}

	// REQUIRED: this is called when companion initialized the module, all set up should be triggered here
	init() {
		this.status(this.STATUS_ERROR)
		this.log('debug', 'init')
		this.socket_init()
	}

	// REQUIRED: drop all websockets and stuff here, before unloading
	destroy() {
		if (this.io !== undefined) {
			this.io.close()
			delete this.io
		}
		this.log('debug', 'destroy')
	}
}

// Encode Websocket
function utf8ToString(uintArray) {
	var encodedString = ''
	for (var i = 0; i < uintArray.length; i++) {
		encodedString += String.fromCharCode(uintArray[i])
	}

	return decodeURIComponent(escape(encodedString))
}

exports = module.exports = instance
