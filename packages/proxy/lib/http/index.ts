import _ from 'lodash'
import type EventEmitter from 'events'
import type CyServer from '@packages/server'
import type {
  CypressIncomingRequest,
  CypressOutgoingResponse,
  BrowserPreRequest,
} from '@packages/proxy'
import Debug from 'debug'
import ErrorMiddleware from './error-middleware'
import { HttpBuffers } from './util/buffers'
import { GetPreRequestCb, PreRequests } from './util/prerequests'
import type { IncomingMessage } from 'http'
import type { NetStubbingState } from '@packages/net-stubbing'
import Bluebird from 'bluebird'
import type { Readable } from 'stream'
import type { Request, Response } from 'express'
import RequestMiddleware from './request-middleware'
import ResponseMiddleware from './response-middleware'
import { DeferredSourceMapCache } from '@packages/rewriter'
import type { Browser } from '@packages/server/lib/browsers/types'
import type { RemoteStates } from '@packages/server/lib/remote_states'

export const debugVerbose = Debug('cypress-verbose:proxy:http')

export enum HttpStages {
  IncomingRequest,
  IncomingResponse,
  Error
}

export type HttpMiddleware<T> = (this: HttpMiddlewareThis<T>) => void

export type HttpMiddlewareStacks = {
  [stage in HttpStages]: {
    [name: string]: HttpMiddleware<any>
  }
}

type HttpMiddlewareCtx<T> = {
  req: CypressIncomingRequest
  res: CypressOutgoingResponse
  shouldCorrelatePreRequests: () => boolean
  stage: HttpStages
  debug: Debug.Debugger
  middleware: HttpMiddlewareStacks
  deferSourceMapRewrite: (opts: { js: string, url: string }) => string
  getCurrentBrowser: () => Browser | Partial<Browser> & Pick<Browser, 'family'> | null
  getPreRequest: (cb: GetPreRequestCb) => void
  getPreviousAUTRequestUrl: Http['getPreviousAUTRequestUrl']
  setPreviousAUTRequestUrl: Http['setPreviousAUTRequestUrl']
} & T

export const defaultMiddleware = {
  [HttpStages.IncomingRequest]: RequestMiddleware,
  [HttpStages.IncomingResponse]: ResponseMiddleware,
  [HttpStages.Error]: ErrorMiddleware,
}

export type ServerCtx = Readonly<{
  config: CyServer.Config & Cypress.Config
  shouldCorrelatePreRequests?: () => boolean
  getCurrentBrowser: () => Browser | Partial<Browser> & Pick<Browser, 'family'> | null
  getFileServerToken: () => string
  remoteStates: RemoteStates
  getRenderedHTMLOrigins: Http['getRenderedHTMLOrigins']
  netStubbingState: NetStubbingState
  middleware: HttpMiddlewareStacks
  socket: CyServer.Socket
  request: any
  serverBus: EventEmitter
}>

const READONLY_MIDDLEWARE_KEYS: (keyof HttpMiddlewareThis<{}>)[] = [
  'buffers',
  'config',
  'getFileServerToken',
  'netStubbingState',
  'next',
  'end',
  'onResponse',
  'onError',
  'skipMiddleware',
]

export type HttpMiddlewareThis<T> = HttpMiddlewareCtx<T> & ServerCtx & Readonly<{
  buffers: HttpBuffers

  next: () => void
  /**
   * Call to completely end the stage, bypassing any remaining middleware.
   */
  end: () => void
  onResponse: (incomingRes: IncomingMessage, resStream: Readable) => void
  onError: (error: Error) => void
  skipMiddleware: (name: string) => void
}>

export function _runStage (type: HttpStages, ctx: any, onError) {
  ctx.stage = HttpStages[type]

  const runMiddlewareStack = () => {
    const middlewares = ctx.middleware[type]

    // pop the first pair off the middleware
    const middlewareName = _.keys(middlewares)[0]

    if (!middlewareName) {
      return Bluebird.resolve()
    }

    const middleware = middlewares[middlewareName]

    ctx.middleware[type] = _.omit(middlewares, middlewareName)

    return new Bluebird((resolve) => {
      let ended = false

      function copyChangedCtx () {
        _.chain(fullCtx)
        .omit(READONLY_MIDDLEWARE_KEYS)
        .forEach((value, key) => {
          if (ctx[key] !== value) {
            ctx[key] = value
          }
        })
        .value()
      }

      function _end (retval?) {
        if (ended) {
          return
        }

        ended = true

        copyChangedCtx()

        resolve(retval)
      }

      if (!middleware) {
        return resolve()
      }

      const fullCtx = {
        next: () => {
          copyChangedCtx()

          _end(runMiddlewareStack())
        },
        end: () => _end(),
        onResponse: (incomingRes: Response, resStream: Readable) => {
          ctx.incomingRes = incomingRes
          ctx.incomingResStream = resStream

          _end()
        },
        onError: (error: Error) => {
          ctx.debug('Error in middleware %o', { middlewareName, error })

          if (type === HttpStages.Error) {
            return
          }

          ctx.error = error
          onError(error)
          _end(_runStage(HttpStages.Error, ctx, onError))
        },
        skipMiddleware: (name) => {
          ctx.middleware[type] = _.omit(ctx.middleware[type], name)
        },
        ...ctx,
      }

      try {
        middleware.call(fullCtx)
      } catch (err) {
        fullCtx.onError(err)
      }
    })
  }

  return runMiddlewareStack()
}

function getUniqueRequestId (requestId: string) {
  const match = /^(.*)-retry-([\d]+)$/.exec(requestId)

  if (match) {
    return `${match[1]}-retry-${Number(match[2]) + 1}`
  }

  return `${requestId}-retry-1`
}

export class Http {
  buffers: HttpBuffers
  config: CyServer.Config
  shouldCorrelatePreRequests: () => boolean
  deferredSourceMapCache: DeferredSourceMapCache
  getCurrentBrowser: () => Browser | Partial<Browser> & Pick<Browser, 'family'> | null
  getFileServerToken: () => string
  remoteStates: RemoteStates
  middleware: HttpMiddlewareStacks
  netStubbingState: NetStubbingState
  preRequests: PreRequests = new PreRequests()
  request: any
  socket: CyServer.Socket
  serverBus: EventEmitter
  renderedHTMLOrigins: {[key: string]: boolean} = {}
  previousAUTRequestUrl?: string

  constructor (opts: ServerCtx & { middleware?: HttpMiddlewareStacks }) {
    this.buffers = new HttpBuffers()
    this.deferredSourceMapCache = new DeferredSourceMapCache(opts.request)

    this.config = opts.config
    this.shouldCorrelatePreRequests = opts.shouldCorrelatePreRequests || (() => false)
    this.getCurrentBrowser = opts.getCurrentBrowser
    this.getFileServerToken = opts.getFileServerToken
    this.remoteStates = opts.remoteStates
    this.middleware = opts.middleware
    this.netStubbingState = opts.netStubbingState
    this.socket = opts.socket
    this.request = opts.request
    this.serverBus = opts.serverBus

    if (typeof opts.middleware === 'undefined') {
      this.middleware = defaultMiddleware
    }
  }

  handle (req: Request, res: Response) {
    const ctx: HttpMiddlewareCtx<any> = {
      req,
      res,
      buffers: this.buffers,
      config: this.config,
      shouldCorrelatePreRequests: this.shouldCorrelatePreRequests,
      getCurrentBrowser: this.getCurrentBrowser,
      getFileServerToken: this.getFileServerToken,
      remoteStates: this.remoteStates,
      request: this.request,
      middleware: _.cloneDeep(this.middleware),
      netStubbingState: this.netStubbingState,
      socket: this.socket,
      serverBus: this.serverBus,
      debug: (formatter, ...args) => {
        debugVerbose(`%s %s %s ${formatter}`, ctx.req.method, ctx.req.proxiedUrl, ctx.stage, ...args)
      },
      deferSourceMapRewrite: (opts) => {
        this.deferredSourceMapCache.defer({
          resHeaders: ctx.incomingRes.headers,
          ...opts,
        })
      },
      getRenderedHTMLOrigins: this.getRenderedHTMLOrigins,
      getPreviousAUTRequestUrl: this.getPreviousAUTRequestUrl,
      setPreviousAUTRequestUrl: this.setPreviousAUTRequestUrl,
      getPreRequest: (cb) => {
        this.preRequests.get(ctx.req, ctx.debug, cb)
      },
    }

    const onError = () => {
      if (ctx.req.browserPreRequest) {
        // browsers will retry requests in the event of network errors, but they will not send pre-requests,
        // so try to re-use the current browserPreRequest for the next retry after incrementing the ID.
        const preRequest = {
          ...ctx.req.browserPreRequest,
          requestId: getUniqueRequestId(ctx.req.browserPreRequest.requestId),
        }

        ctx.debug('Re-using pre-request data %o', preRequest)
        this.addPendingBrowserPreRequest(preRequest)
      }
    }

    return _runStage(HttpStages.IncomingRequest, ctx, onError)
    .then(() => {
      if (ctx.incomingRes) {
        return _runStage(HttpStages.IncomingResponse, ctx, onError)
      }

      return ctx.debug('Warning: Request was not fulfilled with a response.')
    })
  }

  getRenderedHTMLOrigins = () => {
    return this.renderedHTMLOrigins
  }

  getPreviousAUTRequestUrl = () => {
    return this.previousAUTRequestUrl
  }

  setPreviousAUTRequestUrl = (url) => {
    this.previousAUTRequestUrl = url
  }

  async handleSourceMapRequest (req: Request, res: Response) {
    try {
      const sm = await this.deferredSourceMapCache.resolve(req.params.id, req.headers)

      if (!sm) {
        throw new Error('no sourcemap found')
      }

      res.json(sm)
    } catch (err) {
      res.status(500).json({ err })
    }
  }

  reset () {
    this.buffers.reset()
    this.setPreviousAUTRequestUrl(undefined)
  }

  setBuffer (buffer) {
    return this.buffers.set(buffer)
  }

  addPendingBrowserPreRequest (browserPreRequest: BrowserPreRequest) {
    this.preRequests.addPending(browserPreRequest)
  }
}
