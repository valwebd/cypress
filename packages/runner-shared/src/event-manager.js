import _ from 'lodash'
import { EventEmitter } from 'events'
import Promise from 'bluebird'
import { action } from 'mobx'

import { client } from '@packages/socket'

import { studioRecorder } from './studio'
import { automation } from './automation'
import { logger } from './logger'
import { selectorPlaygroundModel } from './selector-playground'

import $Cypress from '@packages/driver'
import * as cors from '@packages/network/lib/cors'

const $ = $Cypress.$
const ws = client.connect({
  path: '/__socket.io',
  transports: ['websocket'],
})

ws.on('connect', () => {
  ws.emit('runner:connected')
})

const driverToReporterEvents = 'paused session:add'.split(' ')
const driverToLocalAndReporterEvents = 'run:start run:end'.split(' ')
const driverToSocketEvents = 'backend:request automation:request mocha recorder:frame'.split(' ')
const driverTestEvents = 'test:before:run:async test:after:run'.split(' ')
const driverToLocalEvents = 'viewport:changed config stop url:changed page:loading visit:failed visit:blank'.split(' ')
const socketRerunEvents = 'runner:restart watched:file:changed'.split(' ')
const socketToDriverEvents = 'net:stubbing:event request:event script:error'.split(' ')
const localToReporterEvents = 'reporter:log:add reporter:log:state:changed reporter:log:remove'.split(' ')

const localBus = new EventEmitter()
const reporterBus = new EventEmitter()

// NOTE: this is exposed for testing, ideally we should only expose this if a test flag is set
window.runnerWs = ws

// NOTE: this is for testing Cypress-in-Cypress, window.Cypress is undefined here
// unless Cypress has been loaded into the AUT frame
if (window.Cypress) {
  window.eventManager = { reporterBus, localBus }
}

/**
 * @type {Cypress.Cypress}
 */
let Cypress

export const eventManager = {
  reporterBus,

  getCypress () {
    return Cypress
  },

  addGlobalListeners (state, connectionInfo) {
    const rerun = () => {
      if (!this) {
        // if the tests have been reloaded
        // then nothing to rerun
        return
      }

      return this._reRun(state)
    }

    ws.emit('is:automation:client:connected', connectionInfo, action('automationEnsured', (isConnected) => {
      state.automation = isConnected ? automation.CONNECTED : automation.MISSING
      ws.on('automation:disconnected', action('automationDisconnected', () => {
        state.automation = automation.DISCONNECTED
      }))
    }))

    ws.on('change:to:url', (url) => {
      window.location.href = url
    })

    ws.on('automation:push:message', (msg, data = {}) => {
      if (!Cypress) return

      switch (msg) {
        case 'change:cookie':
          Cypress.Cookies.log(data.message, data.cookie, data.removed)
          break
        case 'create:download':
          Cypress.downloads.start(data)
          break
        case 'complete:download':
          Cypress.downloads.end(data)
          break
        default:
          break
      }
    })

    ws.on('watched:file:changed', () => {
      studioRecorder.cancel()
      rerun()
    })

    ws.on('specs:changed', ({ specs, testingType }) => {
      // do not emit the event if e2e runner is not displaying an inline spec list.
      if (testingType === 'e2e' && state.useInlineSpecList === false) {
        return
      }

      state.setSpecs(specs)
    })

    ws.on('dev-server:hmr:error', (error) => {
      Cypress.stop()
      localBus.emit('script:error', error)
    })

    ws.on('dev-server:compile:success', ({ specFile }) => {
      if (!specFile || specFile === state.spec.absolute) {
        rerun()
      }
    })

    _.each(socketRerunEvents, (event) => {
      ws.on(event, rerun)
    })

    _.each(socketToDriverEvents, (event) => {
      ws.on(event, (...args) => {
        Cypress.emit(event, ...args)
      })
    })

    ws.on('cross:origin:delaying:html', (request) => {
      Cypress.primaryOriginCommunicator.emit('delaying:html', request)
    })

    _.each(localToReporterEvents, (event) => {
      localBus.on(event, (...args) => {
        reporterBus.emit(event, ...args)
      })
    })

    const logCommand = (logId) => {
      const consoleProps = Cypress.runner.getConsolePropsForLogById(logId)

      logger.logFormatted(consoleProps)
    }

    reporterBus.on('runner:console:error', ({ err, commandId }) => {
      if (!Cypress) return

      if (commandId || err) logger.clearLog()

      if (commandId) logCommand(commandId)

      if (err) logger.logError(err.stack)
    })

    reporterBus.on('runner:console:log', (logId) => {
      if (!Cypress) return

      logger.clearLog()
      logCommand(logId)
    })

    reporterBus.on('focus:tests', this.focusTests)

    reporterBus.on('get:user:editor', (cb) => {
      ws.emit('get:user:editor', cb)
    })

    reporterBus.on('set:user:editor', (editor) => {
      ws.emit('set:user:editor', editor)
    })

    reporterBus.on('runner:restart', rerun)

    function sendEventIfSnapshotProps (logId, event) {
      if (!Cypress) return

      const snapshotProps = Cypress.runner.getSnapshotPropsForLogById(logId)

      if (snapshotProps) {
        localBus.emit(event, snapshotProps)
      }
    }

    reporterBus.on('runner:show:snapshot', (logId) => {
      sendEventIfSnapshotProps(logId, 'show:snapshot')
    })

    reporterBus.on('runner:hide:snapshot', this._hideSnapshot.bind(this))

    reporterBus.on('runner:pin:snapshot', (logId) => {
      sendEventIfSnapshotProps(logId, 'pin:snapshot')
    })

    reporterBus.on('runner:unpin:snapshot', this._unpinSnapshot.bind(this))

    reporterBus.on('runner:resume', () => {
      if (!Cypress) return

      Cypress.emit('resume:all')
    })

    reporterBus.on('runner:next', () => {
      if (!Cypress) return

      Cypress.emit('resume:next')
    })

    reporterBus.on('runner:stop', () => {
      if (!Cypress) return

      Cypress.stop()
    })

    reporterBus.on('save:state', (state) => {
      this.saveState(state)
    })

    reporterBus.on('clear:session', () => {
      Cypress.backend('clear:session').then(() => {
        rerun()
      })
    })

    reporterBus.on('external:open', (url) => {
      ws.emit('external:open', url)
    })

    reporterBus.on('open:file', (url) => {
      ws.emit('open:file', url)
    })

    const studioInit = () => {
      ws.emit('studio:init', (showedStudioModal) => {
        if (!showedStudioModal) {
          studioRecorder.showInitModal()
        } else {
          rerun()
        }
      })
    }

    reporterBus.on('studio:init:test', (testId) => {
      studioRecorder.setTestId(testId)

      studioInit()
    })

    reporterBus.on('studio:init:suite', (suiteId) => {
      studioRecorder.setSuiteId(suiteId)

      studioInit()
    })

    reporterBus.on('studio:cancel', () => {
      studioRecorder.cancel()
      rerun()
    })

    reporterBus.on('studio:remove:command', (commandId) => {
      studioRecorder.removeLog(commandId)
    })

    reporterBus.on('studio:save', () => {
      studioRecorder.startSave()
    })

    reporterBus.on('studio:copy:to:clipboard', (cb) => {
      this._studioCopyToClipboard(cb)
    })

    localBus.on('studio:start', () => {
      studioRecorder.closeInitModal()
      rerun()
    })

    localBus.on('studio:copy:to:clipboard', (cb) => {
      this._studioCopyToClipboard(cb)
    })

    localBus.on('studio:save', (saveInfo) => {
      ws.emit('studio:save', saveInfo, (err) => {
        if (err) {
          reporterBus.emit('test:set:state', studioRecorder.saveError(err), _.noop)
        }
      })
    })

    localBus.on('studio:cancel', () => {
      studioRecorder.cancel()
      rerun()
    })

    const $window = $(window)

    $window.on('hashchange', rerun)

    // when we actually unload then
    // nuke all of the cookies again
    // so we clear out unload
    $window.on('unload', () => {
      this._clearAllCookies()
    })

    // when our window triggers beforeunload
    // we know we've change the URL and we need
    // to clear our cookies
    // additionally we set unload to true so
    // that Cypress knows not to set any more
    // cookies
    $window.on('beforeunload', () => {
      reporterBus.emit('reporter:restart:test:run')

      this._clearAllCookies()
      this._setUnload()
    })

    // The window.top should not change between test reloads, and we only need to bind the message event once
    // Forward all message events to the current instance of the multi-origin communicator
    if (!window.top) throw new Error('missing window.top in event-manager')

    window.top.addEventListener('message', ({ data, source }) => {
      Cypress.primaryOriginCommunicator.onMessage({ data, source })
    }, false)
  },

  start (config) {
    if (config.socketId) {
      ws.emit('app:connect', config.socketId)
    }
  },

  setup (config) {
    Cypress = this.Cypress = $Cypress.create(config)

    // expose Cypress globally
    // since CT AUT shares the window with the spec, we don't want to overwrite
    // our spec Cypress instance with the component's Cypress instance
    if (window.top === window) {
      window.Cypress = Cypress
    }

    this._addListeners(Cypress)

    ws.emit('watch:test:file', config.spec)
  },

  isBrowser (browserName) {
    if (!this.Cypress) return false

    return this.Cypress.isBrowser(browserName)
  },

  initialize ($autIframe, config) {
    performance.mark('initialize-start')

    return Cypress.initialize({
      $autIframe,
      onSpecReady: () => {
        // get the current runnable in case we reran mid-test due to a visit
        // to a new domain
        ws.emit('get:existing:run:state', (state = {}) => {
          if (!Cypress.runner) {
            // the tests have been reloaded
            return
          }

          studioRecorder.initialize(config, state)

          const runnables = Cypress.runner.normalizeAll(state.tests)

          const run = () => {
            performance.mark('initialize-end')
            performance.measure('initialize', 'initialize-start', 'initialize-end')

            this._runDriver(state)
          }

          reporterBus.emit('runnables:ready', runnables)

          if (state.numLogs) {
            Cypress.runner.setNumLogs(state.numLogs)
          }

          if (state.startTime) {
            Cypress.runner.setStartTime(state.startTime)
          }

          if (config.isTextTerminal && !state.currentId) {
            // we are in run mode and it's the first load
            // store runnables in backend and maybe send to dashboard
            return ws.emit('set:runnables:and:maybe:record:tests', runnables, run)
          }

          if (state.currentId) {
            // if we have a currentId it means
            // we need to tell the Cypress to skip
            // ahead to that test
            Cypress.runner.resumeAtTest(state.currentId, state.emissions)
          }

          run()
        })
      },
    })
  },

  _addListeners () {
    Cypress.on('message', (msg, data, cb) => {
      ws.emit('client:request', msg, data, cb)
    })

    _.each(driverToSocketEvents, (event) => {
      Cypress.on(event, (...args) => {
        return ws.emit(event, ...args)
      })
    })

    Cypress.on('collect:run:state', () => {
      if (Cypress.env('NO_COMMAND_LOG')) {
        return Promise.resolve()
      }

      return new Promise((resolve) => {
        reporterBus.emit('reporter:collect:run:state', (reporterState) => {
          resolve({
            ...reporterState,
            studio: studioRecorder.state,
          })
        })
      })
    })

    Cypress.on('log:added', (log) => {
      const displayProps = Cypress.runner.getDisplayPropsForLog(log)

      this._interceptStudio(displayProps)

      reporterBus.emit('reporter:log:add', displayProps)
    })

    Cypress.on('log:changed', (log) => {
      const displayProps = Cypress.runner.getDisplayPropsForLog(log)

      this._interceptStudio(displayProps)

      reporterBus.emit('reporter:log:state:changed', displayProps)
    })

    const handleBeforeScreenshot = (config, cb) => {
      const beforeThenCb = () => {
        localBus.emit('before:screenshot', config)
        cb()
      }

      if (Cypress.env('NO_COMMAND_LOG')) {
        return beforeThenCb()
      }

      const wait = !config.appOnly && config.waitForCommandSynchronization

      if (!config.appOnly) {
        reporterBus.emit('test:set:state', _.pick(config, 'id', 'isOpen'), wait ? beforeThenCb : undefined)
      }

      if (!wait) beforeThenCb()
    }

    Cypress.on('before:screenshot', handleBeforeScreenshot)

    const handleAfterScreenshot = (config) => {
      localBus.emit('after:screenshot', config)
    }

    Cypress.on('after:screenshot', handleAfterScreenshot)

    _.each(driverToReporterEvents, (event) => {
      Cypress.on(event, (...args) => {
        reporterBus.emit(event, ...args)
      })
    })

    _.each(driverTestEvents, (event) => {
      Cypress.on(event, (test, cb) => {
        reporterBus.emit(event, test, cb)
      })
    })

    _.each(driverToLocalAndReporterEvents, (event) => {
      Cypress.on(event, (...args) => {
        localBus.emit(event, ...args)
        reporterBus.emit(event, ...args)
      })
    })

    _.each(driverToLocalEvents, (event) => {
      Cypress.on(event, (...args) => {
        return localBus.emit(event, ...args)
      })
    })

    Cypress.on('script:error', (err) => {
      Cypress.stop()
      localBus.emit('script:error', err)
    })

    Cypress.on('test:before:run:async', (_attr, test) => {
      studioRecorder.interceptTest(test)
    })

    Cypress.on('test:after:run', (test) => {
      if (studioRecorder.isOpen && test.state !== 'passed') {
        studioRecorder.testFailed()
      }
    })

    Cypress.on('test:before:run', (...args) => {
      Cypress.primaryOriginCommunicator.toAllSpecBridges('test:before:run', ...args)
    })

    Cypress.on('test:before:run:async', (...args) => {
      Cypress.primaryOriginCommunicator.toAllSpecBridges('test:before:run:async', ...args)
    })

    // Inform all spec bridges that the primary origin has begun to unload.
    Cypress.on('window:before:unload', () => {
      Cypress.primaryOriginCommunicator.toAllSpecBridges('before:unload')
    })

    Cypress.primaryOriginCommunicator.on('window:load', ({ url }, originPolicy) => {
      // Sync stable if the expected origin has loaded.
      // Only listen to window load events from the most recent secondary origin, This prevents nondeterminism in the case where we redirect to an already
      // established spec bridge, but one that is not the current or next cy.origin command.
      if (cy.state('latestActiveOriginPolicy') === originPolicy) {
        // We remain in an anticipating state until either a load even happens or a timeout.
        cy.state('autOrigin', cy.state('autOrigin', cors.getOriginPolicy(url)))
        cy.isAnticipatingCrossOriginResponseFor(undefined)
        cy.isStable(true, 'load')
        // Prints out the newly loaded URL
        Cypress.emit('internal:window:load', { type: 'cross:origin', url })
        // Re-broadcast to any other specBridges.
        Cypress.primaryOriginCommunicator.toAllSpecBridges('window:load', { url })
      }
    })

    Cypress.primaryOriginCommunicator.on('before:unload', () => {
      // We specifically don't call 'cy.isStable' here because we don't want to inject another load event.
      // Unstable is unstable regardless of where it initiated from.
      cy.state('isStable', false)
      // Re-broadcast to any other specBridges.
      Cypress.primaryOriginCommunicator.toAllSpecBridges('before:unload')
    })

    Cypress.primaryOriginCommunicator.on('expect:origin', (originPolicy) => {
      localBus.emit('expect:origin', originPolicy)
    })

    Cypress.primaryOriginCommunicator.on('viewport:changed', (viewport, originPolicy) => {
      const callback = () => {
        Cypress.primaryOriginCommunicator.toSpecBridge(originPolicy, 'viewport:changed:end')
      }

      Cypress.primaryOriginCommunicator.emit('sync:viewport', viewport)
      localBus.emit('viewport:changed', viewport, callback)
    })

    Cypress.primaryOriginCommunicator.on('before:screenshot', (config, originPolicy) => {
      const callback = () => {
        Cypress.primaryOriginCommunicator.toSpecBridge(originPolicy, 'before:screenshot:end')
      }

      handleBeforeScreenshot(config, callback)
    })

    Cypress.primaryOriginCommunicator.on('url:changed', ({ url }) => {
      localBus.emit('url:changed', url)
    })

    Cypress.primaryOriginCommunicator.on('after:screenshot', handleAfterScreenshot)

    const crossOriginLogs = {}

    Cypress.primaryOriginCommunicator.on('log:added', (attrs) => {
      // If the test is over and the user enters interactive snapshot mode, do not add cross origin logs to the test runner.
      if (Cypress.state('test')?.final) return

      // Create a new local log representation of the cross origin log.
      // It will be attached to the current command.
      // We also keep a reference to it to update it in the future.
      crossOriginLogs[attrs.id] = Cypress.log(attrs)
    })

    Cypress.primaryOriginCommunicator.on('log:changed', (attrs) => {
      // Retrieve the referenced log and update it.
      const log = crossOriginLogs[attrs.id]

      // this will trigger a log changed event for the log itself.
      log?.set(attrs)
    })
  },

  _runDriver (state) {
    performance.mark('run-s')
    Cypress.run(() => {
      performance.mark('run-e')
      performance.measure('run', 'run-s', 'run-e')
    })

    reporterBus.emit('reporter:start', {
      startTime: Cypress.runner.getStartTime(),
      numPassed: state.passed,
      numFailed: state.failed,
      numPending: state.pending,
      autoScrollingEnabled: state.autoScrollingEnabled,
      scrollTop: state.scrollTop,
      studioActive: studioRecorder.hasRunnableId,
    })
  },

  stop () {
    localBus.removeAllListeners()
    ws.off()
  },

  _reRun (state) {
    if (!Cypress) return

    state.setIsLoading(true)

    // when we are re-running we first
    // need to stop cypress always
    Cypress.stop()

    studioRecorder.setInactive()
    selectorPlaygroundModel.setOpen(false)

    return this._restart()
    .then(() => {
      // this probably isn't 100% necessary
      // since Cypress will fall out of scope
      // but we want to be aggressive here
      // and force GC early and often
      Cypress.removeAllListeners()
      Cypress.primaryOriginCommunicator.removeAllListeners()

      localBus.emit('restart')
    })
  },

  _restart () {
    return new Promise((resolve) => {
      reporterBus.once('reporter:restarted', resolve)
      reporterBus.emit('reporter:restart:test:run')
    })
  },

  _interceptStudio (displayProps) {
    if (studioRecorder.isActive) {
      displayProps.hookId = studioRecorder.hookId

      if (displayProps.name === 'visit' && displayProps.state === 'failed') {
        studioRecorder.testFailed()
        reporterBus.emit('test:set:state', studioRecorder.testError, _.noop)
      }
    }

    return displayProps
  },

  _studioCopyToClipboard (cb) {
    ws.emit('studio:get:commands:text', studioRecorder.logs, (commandsText) => {
      studioRecorder.copyToClipboard(commandsText)
      .then(cb)
    })
  },

  emit (event, ...args) {
    localBus.emit(event, ...args)
  },

  on (event, ...args) {
    localBus.on(event, ...args)
  },

  off (event, ...args) {
    localBus.off(event, ...args)
  },

  notifyRunningSpec (specFile) {
    ws.emit('spec:changed', specFile)
  },

  notifyCrossOriginBridgeReady (originPolicy) {
    // Any multi-origin event appends the origin as the third parameter and we do the same here for this short circuit
    Cypress.primaryOriginCommunicator.emit('bridge:ready', undefined, originPolicy)
  },

  focusTests () {
    ws.emit('focus:tests')
  },

  snapshotUnpinned () {
    this._unpinSnapshot()
    this._hideSnapshot()
    reporterBus.emit('reporter:snapshot:unpinned')
  },

  _unpinSnapshot () {
    localBus.emit('unpin:snapshot')
  },

  _hideSnapshot () {
    localBus.emit('hide:snapshot')
  },

  launchBrowser (browser) {
    ws.emit('reload:browser', window.location.toString(), browser && browser.name)
  },

  // clear all the cypress specific cookies
  // whenever our app starts
  // and additional when we stop running our tests
  _clearAllCookies () {
    if (!Cypress) return

    Cypress.Cookies.clearCypressCookies()
  },

  _setUnload () {
    if (!Cypress) return

    Cypress.Cookies.setCy('unload', true)
  },

  saveState (state) {
    ws.emit('save:app:state', state)
  },
}
