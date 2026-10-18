// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/story-answer-llm.js', () => ({ completeStoryAnswer: vi.fn() }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: vi.fn(), resolveModelParameterStyle: () => ({}) }));
vi.mock('../core/log.js', () => ({ log: { verbose: vi.fn() } }));
import { completeStoryAnswer } from '../core/story-answer-llm.js';
import { postChatCompletion } from '../core/llm-provider-call.js';
import { generationRateLimiter } from '../core/generation-rate-limiter.js';
import { openAskStoryPanel } from '../ui/ask-story.js';

let token, events, settings;
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const click = text => [...document.querySelectorAll('button')].find(button => button.textContent === text).click();
beforeEach(() => {
    vi.useFakeTimers();
    token = 'scope';
    settings = { chat_model: 'test-model', chat_provider: 'openrouter' };
    document.body.innerHTML = '<div><button id="VectFox_ask_story">Open</button></div>';
    events = [{ event_id: 'e', event_ref: 'ref:e', summary: '<img src=x onerror=alert(1)> Alex met Ranger.',
        characters: ['Alex', 'Ranger'], source_chat_id: 'chat', source_refs: [{ ref: 'source:e' }] }];
    window.VectFoxAPI = {
        getStatus: () => ({ ready: true, state: 'ready', scope_token: token, effective_collections: [{ collectionId: 'events' }] }),
        findEvents: vi.fn(async () => ({ ok: true, scope_token: token, events, coverage: { returned_count: events.length } })),
        resolveSources: vi.fn(async () => ({ ok: true, sources: [{ ref: 'source:e', status: 'verified', recovered_ils: true,
            message: { name: 'Ranger', mes: '<script>bad()</script> Original text' } }] })),
    };
    completeStoryAnswer.mockReset().mockResolvedValue(JSON.stringify({ status: 'answered', gap: '',
        claims: [{ sentence: 'Alex met Ranger.', event_refs: ['ref:e'] }] }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
    const close = [...document.querySelectorAll('button')].find(button => button.textContent === 'Close');
    close?.click();
    vi.useRealTimers();
    delete window.VectFoxAPI;
    document.body.replaceChildren();
});

describe('Ask panel', () => {
    it('selects archives explicitly and invalidates answers when selection changes', async () => {
        settings.ask_story_enabled = true;
        const getStatus = window.VectFoxAPI.getStatus;
        window.VectFoxAPI.getStatus = () => ({ ...getStatus(), available_collections: [
            { collectionId: 'events', registryKey: 'qdrant:events' },
            { collectionId: 'archive', registryKey: 'standard:archive' }] });
        events[0].source_chat_id = null;
        window.VectFoxAPI.resolveSources.mockResolvedValue({ ok: true, sources: [{ ref: 'source:e', status: 'unresolved', reason: 'unknown_source_chat', message: null }] });
        openAskStoryPanel(settings, vi.fn());
        const [scope, collections] = document.querySelectorAll('select');
        scope.value = 'selected_collections';
        scope.dispatchEvent(new Event('change'));
        expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Ask').disabled).toBe(true);
        collections.options[1].selected = true;
        collections.dispatchEvent(new Event('change'));
        document.querySelector('textarea').value = 'Alex';
        click('Ask');
        await settle();
        expect(window.VectFoxAPI.findEvents).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'selected_collections', collections: ['standard:archive'] } }));
        expect(document.body.textContent).toContain('Original unavailable: unresolved (unknown_source_chat)');
        expect(document.body.textContent).not.toContain('Inspect verified original');
        collections.options[1].selected = false;
        collections.dispatchEvent(new Event('change'));
        expect(document.body.textContent).not.toContain('Alex met Ranger.');
        expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Copy').disabled).toBe(true);
    });
    it('is off by default, displays scope/model, and saves explicit opt-in', () => {
        const save = vi.fn();
        openAskStoryPanel(settings, save);
        expect(document.body.textContent).toContain('test-model');
        expect(document.body.textContent).toContain('current chat; collections: events');
        expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Ask').disabled).toBe(true);
        const enabled = document.querySelector('input[type=checkbox]');
        enabled.click();
        expect(settings.ask_story_enabled).toBe(true);
        expect(save).toHaveBeenCalledTimes(1);
        expect(completeStoryAnswer).not.toHaveBeenCalled();
    });
    it('renders citations and recovered originals safely, and copies coverage', async () => {
        settings.ask_story_enabled = true;
        openAskStoryPanel(settings, vi.fn());
        document.querySelector('textarea').value = 'How did Alex meet Ranger?';
        click('Ask');
        await settle();
        expect(document.body.textContent).toContain('Research complete');
        expect(document.body.textContent).toContain('Inspect recovered ILS original');
        expect(document.body.textContent).toContain('<script>bad()</script>');
        expect(document.querySelector('img, script')).toBeNull();
        click('Copy');
        await settle();
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('ref:e'));
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Coverage:'));
        token = 'changed';
        vi.advanceTimersByTime(500);
        expect(document.body.textContent).not.toContain('Alex met Ranger.');
        expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Copy').disabled).toBe(true);
    });
    it('cancels an in-flight answer and never displays its result', async () => {
        settings.ask_story_enabled = true;
        let finish;
        completeStoryAnswer.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        openAskStoryPanel(settings, vi.fn());
        document.querySelector('textarea').value = 'Alex';
        click('Ask');
        await settle();
        const signal = completeStoryAnswer.mock.calls[0][2];
        click('Cancel');
        expect(signal.aborted).toBe(true);
        finish(JSON.stringify({ status: 'answered', gap: '', claims: [{ sentence: 'Must not display', event_refs: ['ref:e'] }] }));
        await settle();
        expect(document.body.textContent).toContain('Request cancelled');
        expect(document.body.textContent).not.toContain('Must not display');
    });
    it('shows both stored story dates in citation details as safe text', async () => {
        settings.ask_story_enabled = true;
        events[0].DateTime = '1577-08-17T22:30:00Z';
        events[0].scene_time = 'Day 3, dusk <img src=x onerror=alert(1)>';
        openAskStoryPanel(settings, vi.fn());
        document.querySelector('textarea').value = 'When did Alex meet Ranger?';
        click('Ask');
        await settle();
        const citation = document.querySelector('details');
        expect(citation.textContent).toContain('Stored story date (DateTime): 1577-08-17T22:30:00Z');
        expect(citation.textContent).toContain('Stored scene time: Day 3, dusk <img src=x onerror=alert(1)>');
        expect(citation.querySelector('img')).toBeNull();
    });
    it('cancels a real rate-limited answer promptly and re-enables Ask without dispatching', async () => {
        const actual = await vi.importActual('../core/story-answer-llm.js');
        completeStoryAnswer.mockImplementation(actual.completeStoryAnswer);
        postChatCompletion.mockClear();
        Object.assign(settings, { ask_story_enabled: true, generation_rate_limit_calls: 1, generation_rate_limit_interval: 60 });
        await generationRateLimiter.execute(() => 'seed', { rate_limit_calls: 1, rate_limit_interval: 60 });
        const timestamps = [...generationRateLimiter.timestamps];
        try {
            openAskStoryPanel(settings, vi.fn());
            document.querySelector('textarea').value = 'Alex';
            click('Ask');
            await settle();
            expect(generationRateLimiter.queue).toHaveLength(1);
            expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Ask').disabled).toBe(true);
            click('Cancel');
            await settle();
            expect(document.body.textContent).toContain('Request cancelled');
            expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Ask').disabled).toBe(false);
            expect(generationRateLimiter.queue).toEqual([]);
            expect(generationRateLimiter.timer).toBeNull();
            expect(generationRateLimiter.timestamps).toEqual(timestamps);
            await vi.advanceTimersByTimeAsync(61000);
            expect(postChatCompletion).not.toHaveBeenCalled();
        } finally {
            generationRateLimiter.timestamps = [];
        }
    });
});