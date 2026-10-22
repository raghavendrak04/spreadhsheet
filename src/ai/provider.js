// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — YOURS. Call any LLM API you like (Anthropic, OpenAI,
//              Gemini, Ollama, …) with plain fetch(). Read the endpoint,
//              key and model from the VITE_AI_* env vars (.env.example).
//
//  Do not hard-code a vendor anywhere else: everything outside this
//  file must behave identically with either provider.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL
    const timeoutMs = config.timeoutMs ?? 30000
    const maxRetries = config.maxRetries ?? 2

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint || !apiKey || !model) {
                throw new Error('AI provider is not configured. Set VITE_AI_ENDPOINT, VITE_AI_API_KEY, and VITE_AI_MODEL in .env.local.')
            }
            if (apiKey === 'YOUR_API_KEY_HERE') {
                throw new Error('Replace YOUR_API_KEY_HERE in .env.local with your real Gemini API key.')
            }
            const messages = [
                { role: 'system', content: request.system },
                ...(request.history ?? []),
                { role: 'user', content: request.user },
            ]
            let response
            for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), timeoutMs)
            try {
                // Gemini's OpenAI-compat endpoint accepts Bearer tokens.
                // Include x-goog-api-key as well for AQ. auth-key format.
                const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
                if (apiKey.startsWith('AQ.')) headers['x-goog-api-key'] = apiKey
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature: 0,
                    }),
                    signal: controller.signal,
                })
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)} seconds. Check the Gemini model name (${model}), API key, and network connection.`)
                }
                throw new Error(`AI network error: ${error.message}`)
            } finally {
                clearTimeout(timeout)
            }
                if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === maxRetries) break
                const retryAfter = Number(response.headers.get('Retry-After'))
                const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : 1000 * (2 ** attempt)
                await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 8000)))
            }
            if (!response.ok) {
                const detail = await response.text().catch(() => '')
                const suffix = [429, 500, 502, 503, 504].includes(response.status)
                    ? ' Gemini may be temporarily unavailable; please try again shortly.'
                    : ''
                throw new Error(`AI provider error (${response.status}): ${detail.slice(0, 300) || response.statusText}${suffix}`)
            }
            const payload = await response.json().catch(() => { throw new Error('AI provider returned invalid JSON.') })
            // Support OpenAI-compatible format AND native Gemini REST format
            const text = payload?.choices?.[0]?.message?.content
                ?? payload?.candidates?.[0]?.content?.parts?.[0]?.text
                ?? payload?.output_text
                ?? payload?.text
            if (typeof text !== 'string') throw new Error(`AI provider response did not contain text. Model: ${model}. Keys: ${Object.keys(payload ?? {}).join(', ')}`)
            return { text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
