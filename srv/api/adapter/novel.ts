import needle from 'needle'
import { store } from '../../db'
import { logger } from '../../logger'
import { trimResponse } from '../chat/common'
import { badWordIds } from './novel-bad-words'
import { createPrompt } from './prompt'
import { ModelAdapter } from './type'

const novelUrl = `https://api.novelai.net/ai/generate`

const statuses: Record<number, string> = {
  400: 'Invalid payload',
  401: 'Invalid API key',
  402: 'You need an active subscription',
}

const base = {
  model: 'krake-v2',
  parameters: {
    generate_until_sentence: true,
    max_length: 60,
    min_length: 8,
    order: [0, 1, 2, 3],
    prefix: 'vanilla',
    repetition_penalty: 1.055,
    repetition_penalty_frequency: 0,
    repetition_penalty_presence: 0,
    repetition_penalty_slope: 3.33,
    repetition_penalty_range: 2048,
    stop_sequences: [[25], [27]],
    tail_free_sampling: 0.879,
    temperature: 0.63,
    top_k: 20,
    top_p: 1,
    use_cache: false,
    use_string: true,
    bad_word_ids: badWordIds,
  },
}

export const handleNovel: ModelAdapter = async function* ({ chat, char, history, message }) {
  const settings = await store.settings.get()
  if (!settings.novelApiKey) {
    yield { error: 'Novel API key not set' }
    return
  }

  const body = {
    ...base,
    input: createPrompt({ chat, char, history, message }),
  }

  const username = 'You'
  const endTokens = [
    `${username}:`,
    `${char.name}:`,
    `${username} :`,
    `${char.name} :`,
    'END_OF_DIALOG',
    '***',
  ]

  const response = await needle('post', novelUrl, body, {
    json: true,
    headers: { Authorization: `Bearer ${settings.novelApiKey}` },
  })

  logger.warn(response.body, 'Novel response')
  const status = response.statusCode || 0
  if (statuses[status]) {
    yield { error: statuses[status] }
    return
  }

  if (status >= 400) {
    yield { error: response.statusMessage! }
    return
  }

  const trimmed = trimResponse(response.body.output, endTokens)
  yield trimmed ? trimmed.response : response.body.output
}
