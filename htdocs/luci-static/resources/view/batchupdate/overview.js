'use strict';
'require view';
'require fs';
'require ui';
'require poll';
'require dom';
'require request';

var BACKEND = '/usr/bin/batchupdate';
var POLL_INTERVAL = 2;

function callBackend(action, args) {
	return fs.exec(BACKEND, [ action ].concat(args || [])).then(function(res) {
		var stdout = (res.stdout || '').trim();
		var stderr = (res.stderr || '').trim();

		if (res.code !== 0)
			throw new Error(stdout || stderr || _('Backend call failed'));

		try { return JSON.parse(stdout); }
		catch (e) { return stdout; }
	});
}

function confirmDialog(title, message, onConfirm) {
	ui.showModal(title, [
		E('p', message),
		E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn',
				'click': ui.hideModal
			}, [ _('Cancel') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button-action',
				'click': function(ev) {
					ui.hideModal();
					onConfirm();
				}
			}, [ _('OK') ])
		])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callBackend('status'), null),
			L.resolveDefault(callBackend('list'), null),
			L.resolveDefault(callBackend('blacklist', [ 'list' ]), null)
		]);
	},

	render: function(data) {
		this.activeTab = 'upgrades';
		this.activeTask = null;
		this.expectedTotal = 0;
		this.packageManager = data[1] && data[1].manager;
		this.statusEl = E('div', { 'style': 'margin:.5em 0' });
		this.pkgEl = E('div', { 'style': 'margin-top:1em' });
		this.blEl = E('div', { 'style': 'margin-top:1em' });
		this.logEl = E('pre', {
			'style': 'display:none; max-height:20em; overflow:auto; margin-top:1em; padding:.5em'
		});
		this.blInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('Package name'),
			'keydown': L.bind(function(ev) {
				if (ev.key === 'Enter')
					this.handleBlacklistAdd();
			}, this)
		});
		this.refreshBtn = E('button', {
			'class': 'btn cbi-button',
			'click': L.bind(this.handleRefresh, this)
		}, [ _('Refresh package list') ]);
		this.upgradeAllBtn = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'click': L.bind(this.handleUpgradeAll, this)
		}, [ _('Upgrade all packages') ]);
		this.manualInstallBtn = E('button', {
			'class': 'btn cbi-button cbi-button-positive',
			'disabled': !this.packageManager || this.packageManager === 'none' ? true : null,
			'click': L.bind(this.showManualInstall, this)
		}, [ _('Manual Install Package') ]);

		this.upgradesTab = E('div', { 'class': 'cbi-section' }, [
			this.statusEl,
			E('div', {}, [
				this.refreshBtn,
				' ',
				this.upgradeAllBtn,
				' ',
				this.manualInstallBtn
			]),
			this.pkgEl,
			this.logEl
		]);
		this.blacklistTab = E('div', {
			'class': 'cbi-section',
			'style': 'display:none'
		}, [
			E('div', { 'class': 'cbi-section-descr' },
				_('Packages on the blacklist are never upgraded, neither by one-click batch upgrades nor by single package upgrades.')),
			E('div', {}, [
				this.blInput,
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-add',
					'click': L.bind(this.handleBlacklistAdd, this)
				}, [ _('Add') ])
			]),
			this.blEl
		]);

		this.upgradesTabLink = this.makeTabLink('upgrades', _('Package upgrades'));
		this.blacklistTabLink = this.makeTabLink('blacklist', _('Blacklist'));

		var v = E('div', {}, [
			E('style', {}, [
				'@keyframes batchupdate-spin{to{transform:rotate(360deg)}}',
				'.batchupdate-spinner{display:inline-block;margin-right:.45em;animation:batchupdate-spin .8s linear infinite}',
				'.batchupdate-progress{width:100%;height:1.1em}',
				'.batchupdate-modal-log{max-height:16em;overflow:auto;margin-top:1em;padding:.5em;white-space:pre-wrap}'
			].join('')),
			E('h2', _('Batch Package Update')),
			E('div', { 'class': 'cbi-section-descr' },
				_('Upgrade all upgradable packages at once. Packages on the blacklist are always skipped.')),
			E('ul', { 'class': 'cbi-tabmenu' }, [
				this.upgradesTabLink,
				this.blacklistTabLink
			]),
			this.upgradesTab,
			this.blacklistTab
		]);

		var status = data[0] || { status: 'idle', ok: 0, failed: 0, skipped: 0 };

		this.updateStatus(status);
		this.renderPackages(data[1]);
		this.renderBlacklist(data[2] || []);

		if (this.isBusy(status)) {
			this.activeTask = status.operation ||
				(status.status === 'refreshing' ? 'refresh' : 'upgrade');
			this.logEl.style.display = '';
			if (this.activeTask === 'upgrade')
				this.showProgressModal(status);
			else
				this.setRefreshLoading(true);
			this.startPolling();
		}

		return v;
	},

	reportError: function(err) {
		ui.addNotification(null, E('p', err.message || String(err)), 'error');
	},

	makeTabLink: function(name, label) {
		return E('li', {
			'class': name === 'upgrades' ? 'cbi-tab' : 'cbi-tab-disabled'
		}, E('a', {
			'href': '#',
			'click': L.bind(function(ev) {
				ev.preventDefault();
				this.switchTab(name);
			}, this)
		}, label));
	},

	switchTab: function(name) {
		this.activeTab = name;
		this.upgradesTab.style.display = name === 'upgrades' ? '' : 'none';
		this.blacklistTab.style.display = name === 'blacklist' ? '' : 'none';
		this.upgradesTabLink.className = name === 'upgrades' ? 'cbi-tab' : 'cbi-tab-disabled';
		this.blacklistTabLink.className = name === 'blacklist' ? 'cbi-tab' : 'cbi-tab-disabled';
	},

	isBusy: function(st) {
		return st && (st.status === 'starting' ||
			st.status === 'running' || st.status === 'refreshing');
	},

	updateStatus: function(st) {
		var label = {
			'idle':       _('Idle'),
			'starting':   _('Starting'),
			'refreshing': _('Refreshing'),
			'running':    _('Upgrading'),
			'done':       _('Finished'),
			'failed':     _('Failed')
		}[st.status] || st.status;

		var text = _('Status') + ': ' + label;

		if (st.status === 'running' && st.current)
			text += ' — ' + _('Currently upgrading') + ': ' + st.current;

		if (st.status === 'done' || st.status === 'failed')
			text += ' (' + _('Upgraded: %d, failed: %d, skipped: %d')
				.format(st.ok || 0, st.failed || 0, st.skipped || 0) + ')';

		dom.content(this.statusEl, E('span', {
			'style': st.status === 'failed' ? 'color:#c00;font-weight:bold' : 'font-weight:bold'
		}, text));

		var busy = this.isBusy(st);
		this.busy = busy;
		this.refreshBtn.disabled = busy;
		this.upgradeAllBtn.disabled = busy;
		this.manualInstallBtn.disabled = busy || !this.packageManager ||
			this.packageManager === 'none';

		if (st.operation === 'refresh' || this.activeTask === 'refresh')
			this.setRefreshLoading(busy);

		if ((st.operation === 'upgrade' || this.activeTask === 'upgrade') &&
		    this.progressCurrentEl)
			this.updateProgressModal(st);
	},

	setRefreshLoading: function(loading) {
		dom.content(this.refreshBtn, loading ? [
			E('span', { 'class': 'batchupdate-spinner', 'aria-hidden': 'true' }, '↻'),
			_('Refreshing package list…')
		] : [ _('Refresh package list') ]);
	},

	showProgressModal: function(st) {
		this.progressCurrentEl = E('strong', {}, _('Preparing upgrade…'));
		this.progressCountEl = E('span', {}, '0 / ' + (this.expectedTotal || st.total || 0));
		this.progressBarEl = E('progress', {
			'class': 'batchupdate-progress',
			'max': Math.max(this.expectedTotal || st.total || 1, 1),
			'value': st.completed || 0
		});
		this.progressResultEl = E('div', { 'style': 'margin-top:.75em' });
		this.progressLogEl = E('pre', { 'class': 'batchupdate-modal-log' });
		this.progressCloseBtn = E('button', {
			'class': 'btn',
			'disabled': true,
			'click': ui.hideModal
		}, [ _('Close') ]);

		ui.showModal(_('Package upgrade progress'), [
			E('p', {}, [
				_('Currently upgrading') + ': ',
				this.progressCurrentEl
			]),
			E('div', { 'style': 'display:flex;justify-content:space-between;margin-bottom:.35em' }, [
				E('span', {}, _('Progress')),
				this.progressCountEl
			]),
			this.progressBarEl,
			this.progressResultEl,
			this.progressLogEl,
			E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				this.progressCloseBtn
			])
		]);

		this.updateProgressModal(st);
	},

	updateProgressModal: function(st) {
		var total = st.total || this.expectedTotal || 0;
		var completed = st.completed || 0;
		var current = st.current || (this.isBusy(st) ? _('Preparing upgrade…') : _('None'));

		if (total)
			completed = Math.min(completed, total);

		dom.content(this.progressCurrentEl, current);
		dom.content(this.progressCountEl, completed + ' / ' + total);
		this.progressBarEl.max = Math.max(total, 1);
		this.progressBarEl.value = completed;

		if (!this.isBusy(st)) {
			dom.content(this.progressResultEl, E('strong', {
				'style': st.status === 'failed' ? 'color:#c00' : ''
			}, _('Upgraded: %d, failed: %d, skipped: %d')
				.format(st.ok || 0, st.failed || 0, st.skipped || 0)));
			this.progressCloseBtn.disabled = false;
		}
	},

	renderPackages: function(list) {
		this.pkgList = list;
		this.packageManager = list && list.manager;
		if (this.manualInstallBtn)
			this.manualInstallBtn.disabled = this.busy || !this.packageManager ||
				this.packageManager === 'none';

		if (!list) {
			dom.content(this.pkgEl, E('div', { 'class': 'alert-message error' },
				_('The backend helper is unavailable. Please check that /usr/bin/batchupdate is installed and executable.')));
			return;
		}

		if (list.manager === 'none') {
			dom.content(this.pkgEl, E('div', { 'class': 'alert-message error' },
				_('No supported package manager (opkg or apk) was found on this system.')));
			return;
		}

		var pkgs = list.packages || [];

		if (!pkgs.length) {
			dom.content(this.pkgEl, E('p', {}, E('em', _('No upgradable packages found.'))));
			return;
		}

		var rows = pkgs.map(L.bind(function(p) {
			var nameCell = [ p.name ];

			if (p.blacklisted)
				nameCell.push(E('span', { 'style': 'margin-left:.5em; color:#c00' },
					'(' + _('blacklisted') + ')'));

			var upgradeBtn = E('button', {
				'class': 'btn cbi-button cbi-button-positive',
				'click': L.bind(this.handleUpgradeOne, this, p.name),
				'disabled': p.blacklisted ? true : null
			}, [ _('Upgrade') ]);

			var blBtn = p.blacklisted
				? E('button', {
					'class': 'btn cbi-button',
					'click': L.bind(this.handleBlacklistRemove, this, p.name)
				}, [ _('Remove from blacklist') ])
				: E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': L.bind(this.handleBlacklistAddRow, this, p.name)
				}, [ _('Add to blacklist') ]);

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, nameCell),
				E('td', { 'class': 'td' }, p.current),
				E('td', { 'class': 'td' }, p.new),
				E('td', { 'class': 'td cbi-section-actions' }, [ upgradeBtn, ' ', blBtn ])
			]);
		}, this));

		dom.content(this.pkgEl, E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Package')),
				E('th', { 'class': 'th' }, _('Installed version')),
				E('th', { 'class': 'th' }, _('Available version')),
				E('th', { 'class': 'th cbi-section-actions' }, _('Actions'))
			])
		].concat(rows)));
	},

	renderBlacklist: function(bl) {
		this.blacklist = bl || [];

		if (!this.blacklist.length) {
			dom.content(this.blEl, E('em', _('The blacklist is empty.')));
			return;
		}

		dom.content(this.blEl, E('ul', {
			'style': 'list-style:none; padding:0; margin:0'
		}, this.blacklist.map(L.bind(function(name) {
			return E('li', {
				'style': 'display:inline-block; margin:0 .5em .5em 0; padding:.2em .6em; border:1px solid #ccc; border-radius:3px'
			}, [
				name,
				' ',
				E('a', {
					'href': '#',
					'title': _('Remove from blacklist'),
					'click': L.bind(function(ev) {
						ev.preventDefault();
						this.handleBlacklistRemove(name);
					}, this)
				}, '✕')
			]);
		}, this))));
	},

	refreshPackages: function() {
		return callBackend('list').then(L.bind(this.renderPackages, this));
	},

	handleRefresh: function() {
		this.activeTask = 'refresh';
		this.refreshBtn.disabled = true;
		this.upgradeAllBtn.disabled = true;
		this.setRefreshLoading(true);
		this.updateStatus({ status: 'starting', operation: 'refresh' });
		this.logEl.style.display = '';
		this.logEl.textContent = '';

		return callBackend('refresh').then(L.bind(function() {
			this.startPolling();
		}, this)).catch(L.bind(function(err) {
			return this.recoverLaunch(err, 'refresh');
		}, this));
	},

	handleUpgradeAll: function() {
		var pkgs = (this.pkgList && this.pkgList.packages) || [];
		var todo = pkgs.filter(function(p) { return !p.blacklisted; });

		if (!todo.length) {
			ui.addNotification(null, E('p', _('There is nothing to upgrade.')), 'info');
			return;
		}

		confirmDialog(_('Confirm batch upgrade'),
			_('This will upgrade %d packages. Blacklisted packages are skipped. Continue?').format(todo.length),
			L.bind(function() { this.startUpgrade([], todo.length); }, this));
	},

	handleUpgradeOne: function(name) {
		confirmDialog(_('Confirm upgrade'),
			_('Upgrade package "%s"?').format(name),
			L.bind(function() { this.startUpgrade([ name ], 1); }, this));
	},

	showManualInstall: function() {
		var manager = this.packageManager;
		if (manager !== 'opkg' && manager !== 'apk') {
			this.reportError(new Error(_('No supported package manager (opkg or apk) was found on this system.')));
			return;
		}

		var extension = manager === 'opkg' ? 'ipk' : 'apk';
		var state = {
			extension: extension,
			path: '/tmp/batchupdate-upload.' + extension,
			uploaded: false
		};

		state.fileNameEl = E('div', { 'style': 'margin-top:.5em' }, [
			E('em', {}, _('No package file selected.'))
		]);
		state.progressEl = E('progress', {
			'class': 'batchupdate-progress',
			'max': 100,
			'value': 0,
			'style': 'display:none;margin-top:.65em'
		});
		state.resultEl = E('div', { 'style': 'margin-top:.75em' });
		state.fileInput = E('input', {
			'type': 'file',
			'accept': '.' + extension,
			'style': 'display:none',
			'change': L.bind(this.handleManualFileSelected, this, state)
		});
		state.uploadBtn = E('button', {
			'class': 'btn cbi-button',
			'click': function() { state.fileInput.click(); }
		}, [ _('Upload package…') ]);

		state.options = [
			'--force-reinstall',
			'--force-downgrade',
			'--force-space'
		].map(function(option) {
			var input = E('input', { 'type': 'checkbox', 'value': option });
			return {
				name: option,
				input: input,
				node: E('label', {
					'class': 'cbi-checkbox',
					'style': 'display:block;margin:.4em 0'
				}, [ input, ' ', option ])
			};
		});

		state.installBtn = E('button', {
			'class': 'btn cbi-button-action',
			'disabled': true,
			'click': L.bind(this.handleManualInstall, this, state)
		}, [ _('Install') ]);
		state.cancelBtn = E('button', {
			'class': 'btn',
			'click': L.bind(this.handleManualInstallCancel, this, state)
		}, [ _('Cancel') ]);

		/* Remove a stale upload left behind by an interrupted browser session. */
		fs.remove(state.path).catch(function() {});

		ui.showModal(_('Manual package installation'), [
			E('div', { 'class': 'alert-message warning' },
				_('Installing packages from untrusted sources can damage your system. Only install packages you trust.')),
			E('p', {}, _('Only .%s package files are accepted on this system.').format(extension)),
			E('div', {}, [ state.fileInput, state.uploadBtn ]),
			state.fileNameEl,
			state.progressEl,
			E('h4', { 'style': 'margin-bottom:.35em' }, _('Install options')),
			E('div', {}, state.options.map(function(option) { return option.node; })),
			state.resultEl,
			E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				state.cancelBtn,
				' ',
				state.installBtn
			])
		]);
	},

	handleManualFileSelected: function(state, ev) {
		var file = ev.target.files && ev.target.files[0];
		if (!file)
			return;

		var suffix = '.' + state.extension;
		if (file.name.toLowerCase().slice(-suffix.length) !== suffix) {
			ev.target.value = '';
			state.uploaded = false;
			state.installBtn.disabled = true;
			dom.content(state.resultEl, E('div', { 'class': 'alert-message error' },
				_('The selected file must have the .%s extension.').format(state.extension)));
			return;
		}

		state.uploaded = false;
		state.installBtn.disabled = true;
		state.uploadBtn.disabled = true;
		state.cancelBtn.disabled = true;
		state.progressEl.style.display = '';
		state.progressEl.value = 0;
		dom.content(state.uploadBtn, [ _('Uploading…') ]);
		dom.content(state.fileNameEl, [ file.name ]);
		dom.content(state.resultEl, '');

		var data = new FormData();
		data.append('sessionid', L.env.sessionid);
		data.append('filename', state.path);
		data.append('filedata', file);

		return request.post(L.env.cgi_base + '/cgi-upload', data, {
			timeout: 0,
			progress: function(pev) {
				if (pev.total)
					state.progressEl.value = (pev.loaded / pev.total) * 100;
			}
		}).then(L.bind(function(state, file, res) {
			var reply = res.json();
			if (reply && reply.failure)
				throw new Error(reply.message || reply.failure);

			state.uploaded = true;
			state.progressEl.value = 100;
			state.installBtn.disabled = false;
			dom.content(state.fileNameEl,
				_('Package uploaded: %s').format(file.name));
		}, this, state, file)).catch(L.bind(function(state, err) {
			state.fileInput.value = '';
			state.progressEl.style.display = 'none';
			dom.content(state.resultEl, E('div', { 'class': 'alert-message error' },
				_('Upload failed: %s').format(err.message || String(err))));
		}, this, state)).then(function() {
			state.uploadBtn.disabled = false;
			state.cancelBtn.disabled = false;
			dom.content(state.uploadBtn, [ _('Upload package…') ]);
		});
	},

	handleManualInstall: function(state) {
		if (!state.uploaded)
			return;

		var options = state.options.filter(function(option) {
			return option.input.checked;
		}).map(function(option) {
			return option.name;
		});

		state.fileInput.disabled = true;
		state.uploadBtn.disabled = true;
		state.installBtn.disabled = true;
		state.cancelBtn.disabled = true;
		state.options.forEach(function(option) { option.input.disabled = true; });
		dom.content(state.resultEl,
			E('p', { 'class': 'spinning' }, _('Installing package…')));

		return fs.exec(BACKEND, [ 'install' ].concat(options)).then(
			L.bind(function(state, res) {
				var output = [ res.stdout || '', res.stderr || '' ]
					.map(function(text) { return text.trim(); })
					.filter(function(text) { return text; })
					.join('\n');
				var succeeded = res.code === 0;
				var message = succeeded
					? _('Installation succeeded.')
					: _('Installation failed (exit code %d).').format(res.code);

				dom.content(state.resultEl, [
					E('div', { 'class': 'alert-message ' + (succeeded ? 'success' : 'error') }, message),
					E('pre', { 'class': 'batchupdate-modal-log' }, output || _('No output was returned.'))
				]);

				if (succeeded)
					this.refreshPackages();
			}, this, state),
			L.bind(function(state, err) {
				dom.content(state.resultEl, E('div', { 'class': 'alert-message error' },
					_('Installation failed: %s').format(err.message || String(err))));
			}, this, state)
		).then(L.bind(function(state) {
			state.uploaded = false;
			state.cancelBtn.disabled = false;
			dom.content(state.cancelBtn, [ _('Close') ]);
			fs.remove(state.path).catch(function() {});
		}, this, state));
	},

	handleManualInstallCancel: function(state) {
		ui.hideModal();
		fs.remove(state.path).catch(function() {});
	},

	startUpgrade: function(pkgs, expectedTotal) {
		this.activeTask = 'upgrade';
		this.expectedTotal = expectedTotal || 0;
		var starting = {
			status: 'starting',
			operation: 'upgrade',
			completed: 0,
			total: this.expectedTotal
		};

		this.updateStatus(starting);
		this.showProgressModal(starting);
		this.logEl.style.display = '';
		this.logEl.textContent = '';

		return callBackend('start', pkgs).then(L.bind(function() {
			this.startPolling();
		}, this)).catch(L.bind(function(err) {
			return this.recoverLaunch(err, 'upgrade');
		}, this));
	},

	recoverLaunch: function(err, operation) {
		return callBackend('status').then(L.bind(function(st) {
			if (this.isBusy(st) && (!st.operation || st.operation === operation)) {
				this.startPolling();
				return;
			}

			this.updateStatus(st);
			this.reportError(err);
		}, this)).catch(L.bind(function() {
			this.updateStatus({ status: 'failed', operation: operation });
			this.reportError(err);
		}, this));
	},

	startPolling: function() {
		this.stopPolling();
		this.pollFn = L.bind(function() {
			if (!this.logEl.isConnected) {
				this.stopPolling();
				return Promise.resolve();
			}

			return Promise.all([
				callBackend('status'),
				callBackend('log')
			]).then(L.bind(function(res) {
				var st = res[0];
				var operation = st.operation || this.activeTask;

				this.updateStatus(st);
				this.updateLog(res[1]);

				if (!this.isBusy(st)) {
					this.stopPolling();
					this.activeTask = null;

					if (operation === 'refresh' && st.status === 'idle') {
						this.updateLog('');
						this.logEl.style.display = 'none';
					}

					return this.refreshPackages();
				}
			}, this)).catch(L.bind(function(err) {
				if (this.progressResultEl)
					dom.content(this.progressResultEl,
						E('span', { 'style': 'color:#c00' },
							_('Connection interrupted; retrying…')));
				return Promise.resolve(err);
			}, this));
		}, this);

		poll.add(this.pollFn, POLL_INTERVAL);
		poll.start();
	},

	stopPolling: function() {
		if (this.pollFn) {
			poll.remove(this.pollFn);
			this.pollFn = null;
		}
	},

	updateLog: function(text) {
		this.logEl.textContent = text || '';
		this.logEl.scrollTop = this.logEl.scrollHeight;
		if (this.progressLogEl) {
			this.progressLogEl.textContent = text || '';
			this.progressLogEl.scrollTop = this.progressLogEl.scrollHeight;
		}
	},

	handleBlacklistAdd: function() {
		var name = (this.blInput.value || '').trim();

		if (!name)
			return;

		this.blInput.value = '';

		return callBackend('blacklist', [ 'add', name ])
			.then(L.bind(function(bl) {
				this.renderBlacklist(bl);
				return this.refreshPackages();
			}, this))
			.catch(L.bind(this.reportError, this));
	},

	handleBlacklistAddRow: function(name) {
		return callBackend('blacklist', [ 'add', name ])
			.then(L.bind(function(bl) {
				this.renderBlacklist(bl);
				return this.refreshPackages();
			}, this))
			.catch(L.bind(this.reportError, this));
	},

	handleBlacklistRemove: function(name) {
		return callBackend('blacklist', [ 'del', name ])
			.then(L.bind(function(bl) {
				this.renderBlacklist(bl);
				return this.refreshPackages();
			}, this))
			.catch(L.bind(this.reportError, this));
	}
});
