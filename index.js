#!/usr/bin/env node
const argv = require('yargs').argv;
const rp = require('request-promise');
const notifier = require('node-notifier');
const Datastore = require('nedb-core');
const WebSocket = require('ws');
const Configstore = require('configstore');
const inquirer = require('inquirer');
const pkg = require('./package.json');

const conf = new Configstore(pkg.name);
const db = new Datastore({
	filename: require('path').join(require('os').homedir(), '.config', 'getpushover', 'pushover.db'),
	autoload: true
});
let client;

if (argv.reset) {
	inquirer.prompt([
		{
			type: 'confirm',
			message: 'Reset config? You will have to delete the current device from pushover.net dashboard.',
			name: 'reset'
		}
	]).then(answers => {
		if (answers.reset === true) {
			reset();
		}
	});
}

function reset() {
	conf.clear();
}

if (conf.has('pushDeviceId') && conf.has('pushSecret') && !argv.reset) {
	connectWS();
	whenWS();
}
if (!argv.reset) {
	console.log(`Using config: ${conf.path}`);
}

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
			});
	});
}

async function init() {
	return new Promise((resolve, reject) => {
		if (!conf.has('pushEmail') && !conf.has('pushPW') && !conf.has('pushName')) {
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
				},
				{
					type: 'text',
					message: 'Device name (for pushover registration)',
					name: 'pushName'
				}])
				.then(answers => {
					conf.set('pushEmail', answers.pushEmail);
					conf.set('pushName', answers.pushName);
					getSecret(answers.pushPW)
						.then(secret => {
							if (secret && secret.secret) {
								conf.set('pushSecret', secret.secret);
								registerDevice()
									.then(register => {
										console.log('Got device ID: ' + register.id);
										connectWS();
										whenWS();
										getMessages()
											.then(messages => {
												addMessagesToDB(messages);
											});
										resolve({success: true});
									}).catch(err => {
										reject(err);
									});
							}
						})
						.catch(err => {
							console.error(err);
						});
				});
		}
	});
}

async function registerDevice() {
	return new Promise(async (resolve, reject) => {
		rp({
			method: 'POST', uri: 'https://api.pushover.net/1/devices.json', json: true, form: {
				secret: conf.get('pushSecret'), name: conf.get('pushName'), os: 'O'
			}
		})
			.then(register => {
				conf.set('pushDeviceId', register.id);
				resolve(register);
			}).catch(err => {
				console.log(err);
				if (err.error.errors.name[0] === 'has already been taken') {
					console.log('already registered');
					resolve(err);
				} else {
					reject(err);
				}
			});
	});
}

function connectWS() {
	client = new WebSocket('wss://client.pushover.net/push', {
		perMessageDeflate: false
	});
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
			});
	});
}

function whenWS() {
	client.on('open', () => {
		console.log('Connected to pushover, sending login.');
		client.send(`login:${conf.get('pushDeviceId')}:${conf.get('pushSecret')}\n`, ack => {
			if (ack) {
				console.error(ack);
			} else {
				console.log('Logged in.');
			}
		});
	});
	client.on('message', data => {
		data = data.toString();
		if (data) {
			if (data !== '#') {
				console.log('Received message from pushover');
			}
			if (data === '!') {
				console.log('New notification');
			}
			if (data === 'R') {
				console.log('Resetting the connection.');
			}
			if (data === 'E') {
				console.log('We need you to log in again.');
			}
			if (data === '#') {
				console.log('Got keepalive message.');
			}
		}
		if (data === '!') {
			getMessages()
				.then(messages => {
					addMessagesToDB(messages);
				}).catch(err => {
					console.log(err);
				});
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
				});
		}
	});
}

function addMessagesToDB(messages) {
	for (const i in messages.messages) {
		if (Object.hasOwnProperty.call(messages.messages, i)) {
			db.find({
				message: messages.messages[i].message,
				date: messages.messages[i].date
			}, (err, docs) => {
				if (err) {
					console.log(err);
				}
				if (docs && docs.length > 0) {
					console.log('Already got that.');
				} else {
					db.insert(messages.messages[i], err => {
						if (err) {
							console.log(err);
						}
					});
					notifier.notify({
						message: messages.messages[i].message,
						title: `Pushover: ${messages.messages[i].title}` || 'Pushover Notification',
						icon: require('path').join(__dirname, 'notificationicon.png')
					});
					deleteMessage(messages.messages[i].id)
						.then(res => {
							console.log(res);
						}).catch(err => {
							console.log(err);
						});
				}
			});
		}
	}
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
			}
			return 'Not deleted';
		}).catch(err => {
			return err;
		});
}

init();
