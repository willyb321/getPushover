const rp = require('request-promise');
const notifier = require('node-notifier');
const Datastore = require('nedb-core');
const WebSocket = require('ws');
const Configstore = require('configstore');
const pkg = require('./package.json');
const inquirer = require('inquirer');

const conf = new Configstore(pkg.name);
const db = new Datastore({filename: require('path').join(require('os').homedir(), '.config', 'getpushover', 'pushover.db'), autoload: true});
let client;
if (conf.has('pushDeviceId') && conf.has('pushSecret')) {
	client = new WebSocket('wss://client.pushover.net/push');
	whenWS();
}
console.log(`Using config: ${conf.path}`);
async function getSecret(pw) {
	return new Promise(async (resolve, reject) => {
		rp({
			method: 'POST', uri: 'https://api.pushover.net/1/users/login.json', json: true, form: {
				email: conf.get('pushEmail'), password: pw
			}
		})
			.then(secret => {
				resolve(secret);
			}).catch(err => {
			reject(err);
		})
	})
}

async function init() {
	return new Promise((resolve, reject) => {
		if (!conf.has('pushEmail') && !conf.has('pushPW')) {
			inquirer.prompt([
				{
					type: 'email',
					message: 'Enter pushover email',
					name: 'pushEmail'
				},
				{
					type: 'password',
					message: 'Enter a masked password',
					name: 'pushPW',
					mask: '*'
				}])
				.then(answers => {
					conf.set('pushEmail', answers.pushEmail);
					getSecret(answers.pushPW)
						.then(secret => {
							if (secret && secret.secret) {
								conf.set('pushSecret', secret.secret);
								registerDevice()
									.then(register => {
										console.log('Got device ID: ' + register.id);
										client = new WebSocket('wss://client.pushover.net/push');
										whenWS();
										resolve({success: true});
									}).catch(err => {
										console.error(err);
										reject({success: false});
								})
							}
						})
						.catch(err => {
							console.error(err);
						})
				})
		}
	})
}

async function registerDevice() {
	return new Promise(async (resolve, reject) => {
		rp({
			method: 'POST', uri: 'https://api.pushover.net/1/devices.json', json: true, form: {
				secret: conf.get('pushSecret'), name: 'getPushover', os: 'O'
			}
		})
			.then(register => {
				console.log(register.id);
				conf.set('pushDeviceId', register.id);
				resolve(register);
			}).catch(register => {
			console.log(register);
			if (register.error.errors.name[0] === 'has already been taken') {
				console.log('already registered');
				resolve(register);
			} else {
				reject(register);
			}
		})
	})
}

function connectWS() {
	client = new WebSocket('wss://client.pushover.net/push');
	return client;
}

async function getMessages() {
	return new Promise(async (resolve, reject) => {
		rp({
			method: 'GET',
			uri: `https://api.pushover.net/1/messages.json?secret=${conf.get('pushSecret')}&device_id=${conf.get('pushDeviceId')}`,
			json: true
		})
			.then(messages => {
				resolve(messages);
			}).catch(err => {
			reject(err);
		})
	})
}
function whenWS() {
	client.on('open', function open() {
		console.log('Connected to pushover, sending login.');
		client.send(`login:${conf.get('pushDeviceId')}:${conf.get('pushSecret')}\n`, (ack) => {
			if (!ack) {
				console.log('Logged in.');
			} else {
				console.error(ack);
			}
		});
	});
	client.on('message', function incoming(data) {
		data = data.toString();
		if (data !== '#' && data !== '!') {
			console.log('Received message from pushover');
			console.log(data);
		} else {
			console.log('Got keepalive message.');
		}
		if (data === '!') {
			getMessages()
				.then(messages => {
					for (const i in messages.messages) {
						db.find({message: messages.messages[i].message, date: messages.messages[i].date}, (err, docs) => {
							if (err) {
								console.log(err);
							}
							if (docs && docs.length > 0) {
								console.log('Already got that.')
							} else {
								db.insert(messages.messages[i], err => {
									if (err) {
										console.log(err);
									}
								});
								notifier.notify({
									message: messages.messages[i].message,
									title: messages.messages[i].title || 'Pushover Notification'
								});
								deleteMessage(messages.messages[i].id)
									.then(res => {
										console.log(res);
									}).catch(err => {
									console.log(err);
								})
							}
						})
					}
				}).catch(err => {
				console.log(err);
			})
		} else if (data === 'R') {
			console.log('Need to reconnect');
			client.terminate();
			connectWS();
		} else if (data === 'E') {
			registerDevice()
				.then(res => {
					console.log(res);
				}).catch(err => {
				console.log(err);
			})
		}
	});
}


async function deleteMessage(id) {
	return rp({
		method: 'POST',
		uri: `https://api.pushover.net/1/devices/${conf.get('pushDeviceId')}/update_highest_message.json`,
		json: true,
		form: {
			secret: conf.get('pushSecret'), message: id
		}
	})
		.then(res => {
			if (res && res.status === 1) {
				return 'Deleted';
			} else {
				return 'Not deleted';
			}
		}).catch(err => {
			return err;
		})
}

init();