import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { io } from 'socket.io-client'
import { inflateRawSync } from 'node:zlib'

export const UpgradeScripts = []

// Version of the catalog format delivered by the server (4: module API 2)
const VERSION = 4
// query parameters used by socket.io itself
const RESERVED = ['EIO', 'transport', 'sid', 't']

export default class ViStreamInstance extends InstanceBase {
	catalog = { actions: {}, feedbacks: {}, states: {} }
	queue = []
	// feedback callbacks provided by scripts, and what the scripts opened (closed on reload and destroy)
	callbacks = {}
	cleanup = new Set()

	async init(config) {
		await this.configUpdated(config)
	}

	async configUpdated(config) {
		this.config = this.parseToken(config.token)
		this.connect()
	}

	async destroy() {
		this.stopScripts()
		this.disconnect()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'Copy the token from the cuelist module on the ViStream platform.',
			},
			{
				type: 'textinput',
				id: 'token',
				width: 12,
				label: 'Token',
				default: '',
				minLength: 1,
			},
		]
	}

	// token: 'VS' + base64 of the cuelist URL, its query parameters are sent with every request
	parseToken(token) {
		try {
			const url = new URL(Buffer.from((token ?? '').substring(2), 'base64').toString())
			const path = url.pathname.split('/')
			if (path.length !== 5) return null
			return {
				baseUrl: url.origin,
				eventToken: path[3],
				endPoint: url.origin + '/' + path[1] + '/mod/cuelist/companion/' + path[3] + '/' + path[4],
				params: url.searchParams,
				id: Date.now(),
			}
		} catch {
			return null
		}
	}

	// all parameters of the token, own values take precedence
	params(own) {
		const params = new URLSearchParams(this.config.params)
		for (const [key, value] of Object.entries(own)) params.set(key, value)
		return params
	}

	connect() {
		this.disconnect()
		if (!this.config) {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing or invalid token')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		const query = Object.fromEntries(
			[...this.params({ v: VERSION, ids: this.config.id })].filter(([key]) => !RESERVED.includes(key)),
		)
		this.io = io(this.config.baseUrl, {
			path: '/update/' + this.config.eventToken + '/cuelist',
			transports: ['websocket', 'polling'],
			query,
		})
		// after every (re)connect the whole catalog is loaded again
		this.io.on('connect', () => {
			this.updateStatus(InstanceStatus.Ok)
			this.load()
		})
		this.io.on('vs', (data) => {
			try {
				this.receive(JSON.parse(typeof data === 'string' ? data : inflateRawSync(Buffer.from(data)).toString()))
			} catch (e) {
				this.log('error', 'Invalid message from the server: ' + e.message)
			}
		})
		this.io.on('disconnect', () => {
			this.updateStatus(InstanceStatus.Disconnected, 'Connection lost')
			this.setVariableValues({ websocket: 'offline' })
		})
		this.io.on('connect_error', (e) => {
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
			this.setVariableValues({ websocket: 'offline' })
		})
	}

	disconnect() {
		clearTimeout(this.retry)
		this.io?.close()
		delete this.io
	}

	// an answer for an outdated token is dropped; on failure try again while the socket stays connected
	async load() {
		const config = this.config
		clearTimeout(this.retry)
		try {
			const response = await fetch(config.endPoint + '?' + this.params({ cp: 'init', v: VERSION }))
			if (!response.ok) throw new Error('HTTP ' + response.status)
			const catalog = await response.json()
			if (config === this.config) this.apply(catalog)
		} catch (e) {
			if (config !== this.config) return
			this.log('error', 'Loading the catalog failed: ' + e.message)
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
			this.retry = setTimeout(() => this.io?.connected && this.load(), 10000)
		}
	}

	// whole catalog in the format of module API 2
	apply(catalog) {
		this.catalog = catalog
		this.publish(['actions', 'feedbacks', 'presets', 'variableDefinitions', 'scripts'])
		this.setVariableValues({ ...catalog.variables, websocket: 'online' })
	}

	// changes [[path, value, reset], …] in the catalog, null removes; only the affected parts go to Companion again,
	// variables with reset are set back to '' right after, so the same value triggers again
	update(changes) {
		const parts = new Set(),
			values = {}
		for (const [path, value, reset] of changes) {
			let node = this.catalog
			for (const key of path.slice(0, -1)) node = node[key] ??= {}
			if (value === null) delete node[path.at(-1)]
			else node[path.at(-1)] = value
			parts.add(path[0] === 'structure' ? 'presets' : path[0])
			if (path[0] === 'variables') values[path[1]] = value ?? undefined
			if (reset) setTimeout(() => this.setVariableValues({ [path[1]]: '' }), 10)
		}
		this.publish(parts)
		if (Object.keys(values).length) this.setVariableValues(values)
	}

	// hand parts of the catalog to Companion, only the callbacks are added here;
	// a feedback uses the callback of a script if one is registered, otherwise the state sent by the server
	publish(parts) {
		const { catalog } = this
		parts = new Set(parts)
		if (parts.has('scripts')) this.stopScripts()
		if (parts.has('actions')) {
			for (const action of Object.values(catalog.actions)) action.callback = (event) => this.run(event)
			this.setActionDefinitions(catalog.actions)
		}
		if (parts.has('feedbacks')) {
			for (const [id, feedback] of Object.entries(catalog.feedbacks)) {
				feedback.callback = (event) =>
					this.callbacks[id]?.(event) ??
					(feedback.type === 'boolean'
						? (this.catalog.states[event.options['feedback_' + event.options.mod]] ?? 0) > 0
						: {})
			}
			this.setFeedbackDefinitions(catalog.feedbacks)
		}
		if (parts.has('presets')) this.setPresetDefinitions(catalog.structure, catalog.presets)
		if (parts.has('variableDefinitions')) this.setVariableDefinitions(catalog.variableDefinitions)
		if (parts.has('scripts')) this.startScripts(catalog.scripts ?? {})
		if (parts.has('feedbacks') || parts.has('states') || parts.has('scripts')) this.checkStates()
	}

	checkStates() {
		const ids = Object.keys(this.catalog.feedbacks)
		if (ids.length) this.checkFeedbacks(...ids)
	}

	// scripts from the server run inside this module with a small api; timers, sockets and requests
	// are tracked and closed when the catalog is reloaded or the connection is removed
	startScripts(scripts) {
		for (const [name, script] of Object.entries(scripts)) {
			const controller = new AbortController()
			let active = true
			// an error inside a script only ends that call, never the connection
			const safe =
				(fn) =>
				(...args) => {
					try {
						const result = fn(...args)
						result?.catch?.((e) => this.log('error', name + ': ' + e.message))
						return result
					} catch (e) {
						this.log('error', name + ': ' + e.message)
					}
				}
			// returns a function to drop the entry again once a timer or socket is done by itself
			const track = (stop) => {
				if (!active) {
					stop()
					return () => {}
				}
				this.cleanup.add(stop)
				return () => this.cleanup.delete(stop)
			}
			track(() => {
				active = false
				controller.abort()
			})
			const api = {
				args: script.args ?? {},
				log: (level, message) => this.log(level, name + ': ' + message),
				setVariables: (values) => active && this.setVariableValues(values),
				getVariable: (id) => this.getVariableValue(id),
				setState: (id, state) => {
					if (!active) return
					this.catalog.states[id] = state
					this.checkStates()
				},
				checkFeedbacks: (...ids) => active && ids.length && this.checkFeedbacks(...ids),
				feedback: (id, callback) => active && (this.callbacks[id] = safe(callback)),
				setTimeout: (fn, ms) => {
					const timer = setTimeout(() => {
						done()
						safe(fn)()
					}, ms)
					const done = track(() => clearTimeout(timer))
					return timer
				},
				setInterval: (fn, ms) => {
					const timer = setInterval(safe(fn), ms)
					track(() => clearInterval(timer))
					return timer
				},
				// handlers set by the script (onopen, onmessage, …) run guarded as well
				websocket: (url, protocols) => {
					const ws = new WebSocket(url, protocols)
					const done = track(() => ws.close())
					ws.addEventListener('close', () => done())
					for (const type of ['open', 'message', 'close', 'error']) {
						Object.defineProperty(ws, 'on' + type, { set: (fn) => ws.addEventListener(type, safe(fn)) })
					}
					return ws
				},
				fetch: (url, options = {}) =>
					fetch(url, {
						...options,
						signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
					}),
				onStop: (fn) => track(fn),
			}
			safe(() => new Function('api', script.code)(api))()
		}
	}

	stopScripts() {
		const stops = [...this.cleanup]
		this.cleanup.clear()
		for (const stop of stops) {
			try {
				stop()
			} catch (e) {
				this.log('debug', 'Stopping a script: ' + e.message)
			}
		}
		this.callbacks = {}
	}

	// actions triggered together (one button) go to the server in one request
	run(event) {
		this.queue.push([Buffer.from(event.actionId.substring(2), 'base64').toString(), event.options])
		if (this.queue.length > 1) return
		setTimeout(async () => {
			const actions = this.queue.splice(0)
			try {
				const response = await fetch(this.config.endPoint + '?' + this.params({ cp: 'run', v: VERSION }), {
					method: 'POST',
					body: new URLSearchParams({ actions: JSON.stringify(actions) }),
				})
				if (!response.ok) throw new Error('HTTP ' + response.status)
				this.updateStatus(InstanceStatus.Ok)
			} catch (e) {
				this.log('error', 'Running the action failed: ' + e.message)
				this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
			}
		}, 1)
	}

	receive(json) {
		switch (json.action) {
			case 'set':
				this.update(json.changes ?? [])
				break
			case 'reload':
				this.load()
				break
			default:
				this.log('warn', 'Unknown message from the server, maybe an update is missing: ' + json.action)
		}
	}
}
