import { WebSocket } from 'ws'
import { EventGenerator, eventGenerator } from '/common/util'
import { ThirdPartyFormat } from '/common/adapters'

export type ServerSentEvent = {
  id?: string
  type?: string
  data?: any
  error?: string
  index?: number
}

// this is an edited and inverted ver of https://stackoverflow.com/a/70385497
function incompleteJson(data: string) {
  if (data.startsWith('{') && !data.endsWith('}')) return true
  try {
    const parsed = JSON.parse(data)
    if (parsed && typeof parsed === 'object') {
      return false
    }
  } catch {
    return true
  }
  return false
}

/**
 * Converts a Needle readable stream to an async generator which yields server-sent events.
 * Operates on Needle events, not NodeJS ReadableStream events.
 * https://github.com/tomas/needle#events
 **/
export function requestStream(stream: NodeJS.ReadableStream, format?: ThirdPartyFormat) {
  const emitter = eventGenerator<ServerSentEvent>()

  stream.on('header', (statusCode, headers) => {
    const contentType = headers['content-type'] || ''
    if (statusCode > 201) {
      emitter.push({ error: `SSE request failed with status code ${statusCode}` })
      emitter.done()
    } else if (format === 'ollama') {
      if (contentType.startsWith('application/x-ndjson')) return

      emitter.push({
        error: `SSE request received unexpected content-type ${headers['content-type']}`,
      })
      emitter.done()
    } else if (!contentType.startsWith('text/event-stream')) {
      emitter.push({
        error: `SSE request received unexpected content-type ${headers['content-type']}`,
      })
      emitter.done()
    }
  })

  stream.on('done', () => {
    emitter.done()
  })

  let incomplete = ''

  stream.on('data', (chunk: Buffer) => {
    const data = incomplete + chunk.toString()
    incomplete = ''

    const messages = data.split(/\r?\n\r?\n/).filter((l) => !!l)

    for (const msg of messages) {
      if (format === 'ollama') {
        const event = parseOllama(incomplete + msg, emitter)
        const token = event?.response
        if (!token) continue

        const data = JSON.stringify({ token })
        emitter.push({ data })
        continue
      }

      if (format === 'aphrodite') {
        const event = parseAphrodite(incomplete + msg, emitter)
        if (!event?.data) {
          incomplete += msg
          continue
        }

        const token = getAphroditeToken(event.data)
        if (!token) continue

        const data = JSON.stringify({ index: token.index, token: token.token })
        emitter.push({ data })
        continue
      }

      const event: any = parseEvent(msg)

      if (!event.data) {
        continue
      }

      const data: string = event.data
      if (typeof data === 'string' && incompleteJson(data)) {
        incomplete = msg
        continue
      }

      if (event.event) {
        event.type = event.event
      }
      emitter.push(event)
    }
  })

  return emitter.stream
}

function getAphroditeToken(data: any) {
  const choice = data.choices?.[0]
  if (!choice) return

  const token = choice.text

  return { token, index: choice.index }
}

function parseAphrodite(msg: string, emitter: EventGenerator<ServerSentEvent>) {
  const event: any = {}
  for (const line of msg.split(/\r?\n/)) {
    const pos = line.indexOf(':')
    if (pos === -1) {
      continue
    }

    const toParse = line.substring(line.indexOf('{'))

    if (incompleteJson(toParse)) {
      event['data'] = toParse
      return event
    }

    event['data'] = JSON.parse(toParse)
  }

  return event
}

function parseOllama(msg: string, emitter: EventGenerator<ServerSentEvent>) {
  const event: any = {}
  const data = tryParse(msg)
  if (!data) return event

  Object.assign(event, data)
  return event
}

function tryParse(value: any) {
  try {
    const obj = JSON.parse(value)
    return obj
  } catch (ex) {
    return {}
  }
}

function parseEvent(msg: string) {
  const event: any = {}
  for (const line of msg.split(/\r?\n/)) {
    const pos = line.indexOf(':')
    if (pos === -1) {
      continue
    }

    const prop = line.slice(0, pos)
    const value = line.slice(pos + 1).trim()
    event[prop] = prop === 'data' ? value.trimStart() : value.trim()
  }

  return event
}

export async function websocketStream(opts: { url: string; body: any }, timeoutMs?: number) {
  const socket = new WebSocket(opts.url.replace('https:', 'wss:').replace('http:', 'ws:'))

  const emitter = eventGenerator()
  let accum = ''

  // Terminate the request if the first token is not received without the timeout window
  const ttfbTimer = timeoutMs
    ? setTimeout(() => {
        emitter.push({ error: `request cancelled - timed out` })
        emitter.done()
      }, timeoutMs)
    : 0

  socket.on('error', (err) => {
    if ('syscall' in err && 'code' in err) {
      emitter.push({ error: `Service unreachable - ${err.code}` })
      emitter.done()
      return
    }

    emitter.push({ error: err.message })
    emitter.done()
  })

  socket.on('open', () => {
    socket.send(JSON.stringify(opts.body))
  })

  socket.on('close', () => {
    emitter.done()
  })

  socket.on('message', (data: any) => {
    const obj = JSON.parse(data)

    if (obj.response_type === 'chunk') {
      clearTimeout(ttfbTimer)
      emitter.push({ token: obj.chunk })
      accum += obj.chunk
    }

    if (obj.event === 'text_stream') {
      clearTimeout(ttfbTimer)
      emitter.push({ token: obj.text })
      accum += obj.text
    }

    if (obj.meta) {
      emitter.push({ meta: obj.meta })
    }

    if (obj.event === 'error') {
      emitter.push({ error: obj.error })
    }

    if (obj.event === 'stream_end' || obj.response_type === 'full') {
      const text = obj.text ? obj.text : accum
      emitter.push(text)
      emitter.done()
      socket.close()
    }
  })

  return emitter.stream
}
