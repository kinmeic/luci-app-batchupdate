'use strict';
'require view';
'require fs';
'require ui';
'require poll';
'require dom';

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

		this.upgradesTab = E('div', { 'class': 'cbi-section' }, [
			this.statusEl,
			E('div', {}, [
				this.refreshBtn,
				' ',
				this.upgradeAllBtn
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
			E('div', { 'class': 'alert-message warning' },
				_('Warning: upgrading packages on a running system may cause instability or even soft-brick the device. Use with caution and make sure there is enough free flash space.')),
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
		this.refreshBtn.disabled = busy;
		this.upgradeAllBtn.disabled = busy;

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
		poll.stop();
		poll.add(L.bind(function() {
			if (!this.logEl.isConnected) {
				poll.stop();
				return Promise.resolve();
			}

			return Promise.all([
				callBackend('status'),
				callBackend('log')
			]).then(L.bind(function(res) {
				this.updateStatus(res[0]);
				this.updateLog(res[1]);

				if (!this.isBusy(res[0])) {
					poll.stop();
					this.activeTask = null;
					return this.refreshPackages();
				}
			}, this)).catch(L.bind(function(err) {
				if (this.progressResultEl)
					dom.content(this.progressResultEl,
						E('span', { 'style': 'color:#c00' },
							_('Connection interrupted; retrying…')));
				return Promise.resolve(err);
			}, this));
		}, this), POLL_INTERVAL);
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
